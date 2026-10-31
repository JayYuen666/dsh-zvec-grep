// rebuild-state 状态机的属性面：随机 claim/attach/release 交错下，同根互斥、代次校验、
// 幂等释放三条不变式必须对任意命令序列成立。期望值由测试内的模型表（root → 凭据 + 代数）
// 独立维护，不从被测实现派生。等待出口与监听器清理的确定性场景在 test/rebuild-state.test.ts，
// 这里只补「随机交错」那一面。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";
import { getEventListeners } from "node:events";
// 官方作业品牌串的**值**形式（JobId("x") 只是给同一个字符串贴牌，不做校验），同 test/rebuild-state.test.ts。
import { JobId as jobIdOf } from "@deepseek-ai/dsh-jobs";

import { MESSAGES } from "../../lib/messages.ts";
import { createRebuildRegistry } from "../../lib/rebuild-state.ts";
import type { ActiveRebuild, RebuildRegistry } from "../../lib/rebuild-state.ts";

const { zh } = MESSAGES;

/** 根池：三个根，前两个有祖先关系（covering 的祖先命中因此有随机交错可走）。 */
const ROOT_POOL = ["/repo", "/repo/pkg", "/other"] as const;
type RootName = (typeof ROOT_POOL)[number];
type CredentialKind = "current" | "stale" | "none";

/** 模型里一个 root 的记账：当前凭据、已发作业号数、历代替身（供陈旧凭据用例）。 */
interface RootModel {
  credential: ActiveRebuild | undefined;
  jobsIssued: number;
  staleCredentials: ActiveRebuild[];
}

type RootModels = Map<string, RootModel>;

function makeModel(): RootModels {
  return new Map(
    ROOT_POOL.map((root) => [root, { credential: undefined, jobsIssued: 0, staleCredentials: [] }]),
  );
}

/** 可控时钟：startedAt 单调递增，covering 的「最早优先」判据因此确定。 */
function counterClock(): () => number {
  let current = 0;
  return () => {
    current += 1;
    return current;
  };
}

const rootArb = fc.constantFrom(...ROOT_POOL);
const credentialKindArb = fc.constantFrom("current", "stale", "none");

const commandArb = fc.oneof(
  fc.record({ t: fc.constant("claim"), root: rootArb }),
  fc.record({ t: fc.constant("claimVariant"), root: rootArb }),
  fc.record({ t: fc.constant("attach"), root: rootArb, cred: credentialKindArb }),
  fc.record({ t: fc.constant("release"), root: rootArb, cred: credentialKindArb }),
);
type ModelCommand =
  | { t: "claim"; root: RootName }
  | { t: "claimVariant"; root: RootName }
  | { t: "attach"; root: RootName; cred: CredentialKind }
  | { t: "release"; root: RootName; cred: CredentialKind };

/** 段前缀契约：query 在 entryRoot 之内 ⇔ 同一处或 entryRoot 是 query 的祖先（段前缀比）。 */
function coversTree(entryRoot: string, query: string): boolean {
  return query === entryRoot || query.startsWith(`${entryRoot}/`);
}

/** 凭据取值：current = 当前条目；stale = 最近一代旧凭据（池可能为空 ⇒ undefined）；none = 不传。 */
function credentialOf(entry: RootModel, kind: CredentialKind): ActiveRebuild | undefined {
  const byKind: Record<CredentialKind, ActiveRebuild | undefined> = {
    current: entry.credential,
    stale: entry.staleCredentials.at(-1),
    none: undefined,
  };
  return byKind[kind];
}

/** claim（含尾斜杠变体）：同根互斥 ⇒ null；新占位 ⇒ 归一化根 + 占位态。 */
function applyClaim(
  registry: RebuildRegistry,
  model: RootModels,
  root: RootName,
  variantForm: boolean,
): void {
  const entry = model.get(root);
  if (entry === undefined) {
    return;
  }
  const claimed = registry.claim(variantForm ? `${root}/` : root, "tool");
  if (entry.credential !== undefined) {
    assert.equal(claimed, null, `claim(${root}) 应被同根互斥拒绝`);
    return;
  }
  assert.ok(claimed !== null);
  assert.equal(claimed.root, root, "注册表键应是归一化后的根");
  assert.equal(claimed.phase, "starting");
  assert.equal(claimed.jobId, undefined, "占位期作业号恒为 undefined");
  entry.credential = claimed;
}

/** attach：无凭据直接写；有凭据必须与当前条目同代；拒绝时条目保持占位态。 */
function applyAttach(
  registry: RebuildRegistry,
  model: RootModels,
  command: Extract<ModelCommand, { t: "attach" }>,
): void {
  const { root } = command;
  const entry = model.get(root);
  if (entry === undefined) {
    return;
  }
  const credential = credentialOf(entry, command.cred);
  const expected =
    entry.credential === undefined
      ? false
      : credential === undefined || credential === entry.credential;
  const accepted = registry.attach(root, jobIdOf(`job-${entry.jobsIssued}`), credential);
  assert.equal(accepted, expected, `attach(${root}, ${command.cred}) 的代次校验`);
  const current = entry.credential;
  if (current === undefined || !expected) {
    return;
  }
  entry.jobsIssued += 1;
  assert.equal(current.phase, "running");
  assert.equal(current.jobId, jobIdOf(`job-${entry.jobsIssued - 1}`));
}

/** release：凭据同代（或不传）才释放；释放后等待者的 settled 兑现。 */
function applyRelease(
  registry: RebuildRegistry,
  model: RootModels,
  releasedSettled: Promise<void>[],
  command: Extract<ModelCommand, { t: "release" }>,
): void {
  const { root } = command;
  const entry = model.get(root);
  if (entry === undefined) {
    return;
  }
  const credential = credentialOf(entry, command.cred);
  const expected =
    entry.credential !== undefined && (credential === undefined || credential === entry.credential);
  const released = registry.release(root, credential);
  assert.equal(released, expected, `release(${root}, ${command.cred}) 的代次校验`);
  const current = entry.credential;
  if (!expected || current === undefined) {
    return;
  }
  releasedSettled.push(current.settled);
  // 被释放的凭据进入旧代池：此后的同根新 claim 配上 stale 取值，代次校验才有真凭据可拒。
  entry.staleCredentials.push(current);
  entry.credential = undefined;
}

describe("rebuild-state 注册表对模型表的随机交错", () => {
  it("同根互斥、代次校验、幂等释放对任意命令序列成立", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(commandArb, { maxLength: 24 }), async (commands) => {
        const registry = createRebuildRegistry({ now: counterClock() });
        const model = makeModel();
        const releasedSettled: Promise<void>[] = [];

        for (const command of commands) {
          if (command.t === "claim") {
            applyClaim(registry, model, command.root, false);
          } else if (command.t === "claimVariant") {
            applyClaim(registry, model, command.root, true);
          } else if (command.t === "attach") {
            applyAttach(registry, model, command);
          } else {
            applyRelease(registry, model, releasedSettled, command);
          }
        }

        // 读面收口：active 是精确键；covering 是祖先关系读（登记根是查询根的祖先或同一处），
        // 按段前缀契约独立判定——池里的根有嵌套，/repo 的条目会覆盖 /repo/pkg 的查询。
        const coveredByModel = (query: string): boolean => {
          for (const [entryRoot, record] of model) {
            if (record.credential !== undefined && coversTree(entryRoot, query)) {
              return true;
            }
          }
          return false;
        };
        for (const root of ROOT_POOL) {
          const entry = model.get(root);
          assert.equal(registry.active(root) !== undefined, entry?.credential !== undefined, root);
          assert.equal(registry.covering(root, zh) !== undefined, coveredByModel(root), root);
        }
        // 释放必达：所有被 release 收掉的条目，等待者的 settled 必须全部兑现。
        await Promise.all(releasedSettled);
      }),
      { numRuns: 60 },
    );
  });
});

describe("covering 的祖先命中与最早优先", () => {
  it("重建根是查询根的祖先或同一处才命中；多条命中取 startedAt 最早", () => {
    const registry = createRebuildRegistry({ now: counterClock() });
    const first = registry.claim("/repo", "tool");
    const second = registry.claim("/repo/pkg", "tool");
    assert.ok(first !== null && second !== null);
    // /repo（startedAt=1）与 /repo/pkg（startedAt=2）都覆盖 /repo/pkg/deep，取最早那条。
    assert.equal(registry.covering("/repo/pkg/deep", zh), first);
    assert.equal(registry.covering("/other", zh), undefined);
    // 祖先查询也能命中后代重建的登记（精确键查不到的那一类）。
    assert.equal(registry.covering("/repo", zh), first);
  });
});

describe("wait 的出口与清理", () => {
  it("无覆盖立返 settled（signal 检查在覆盖检查之后）；有覆盖且 pre-aborted 返 aborted；退出后不留 abort 监听", async () => {
    const registry = createRebuildRegistry();
    assert.equal(await registry.wait("/repo", zh, 5000), "settled");
    const idleController = new AbortController();
    idleController.abort();
    assert.equal(await registry.wait("/repo", zh, 5000, idleController.signal), "settled");

    const preExisting = registry.claim("/repo", "tool");
    assert.ok(preExisting !== null);
    const controller = new AbortController();
    controller.abort();
    assert.equal(await registry.wait("/repo", zh, 5000, controller.signal), "aborted");
    assert.equal(registry.release("/repo", preExisting), true);

    const entry = registry.claim("/repo", "tool");
    assert.ok(entry !== null);
    const signal = new AbortController();
    const pending = registry.wait("/repo", zh, 60_000, signal.signal);
    const released = registry.release("/repo", entry);
    assert.equal(released, true);
    assert.equal(await pending, "settled");
    assert.equal(
      getEventListeners(signal.signal, "abort").length,
      0,
      "wait 收尾必须撤销 abort 监听",
    );
  });

  it("等待中条目被同根新 claim 顶替时继续等新条目（递归等待到真正落定）", async () => {
    const registry = createRebuildRegistry();
    const first = registry.claim("/repo", "tool");
    assert.ok(first !== null);
    const pending = registry.wait("/repo", zh, 30_000);
    assert.equal(registry.release("/repo", first), true);
    const second = registry.claim("/repo", "tool");
    assert.ok(second !== null);
    const released = registry.release("/repo", second);
    assert.equal(released, true);
    assert.equal(await pending, "settled", "第一代落定不结束等待：同根又有新重建时继续等");
  });
});
