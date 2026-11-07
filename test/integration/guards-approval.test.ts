// guard 与用户确认的**真实宿主**集成测试。
//
// 与 test/host.test.ts 的分工：那边直接调本包的谓词函数（纯函数规则），这里把谓词挂回
// 官方的调用流水线上——`ctx.tools.execute()` 会依次跑 `tools/pre-execute` 瀑布（可问）与
// `tools.guard`（单调拒绝），问出来的 `ask` 由官方 dsh-tools 路由到 `ctx.approval`。
// 于是三件只有真栈能验的事在这里被钉住：
//   1. 本包 guard 的返回值确实被官方当成拒绝理由（而不是被忽略）；
//   2. pre-execute 的 `ask` 真的走了 approval，用户允许/拒绝各自的结局；
//   3. search-first 的放行/拦截与解锁额度在真实 guard 调用序下成立。

import { describe, it, expect, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  startHost,
  registerDummyTools,
  inOrder,
  zgAvailable,
  TEST_EMBEDDING,
  drainCleanups,
  makeTempDir,
} from "./host-stack.ts";
import type { Cleanups } from "./host-stack.ts";
import { embeddingCached } from "../embedding-cache.ts";

/** 门禁拦截时回给模型的动作（断言里多次出现，抽成常量）。 */
const GREP_COMMAND = "grep -rn authService .";
/** 本用例自己递给 `grepBudgetPerSearch` 的额度；轮次由它生成，不跟包里的默认值走。 */
const GREP_BUDGET = 3;
/** 被问的工具名（这组用例全部问它）。 */
const ASKED_TOOL = "zg_status";
/** 用户点了「允许一次」（每条都装一枚一自主实例）。 */
const ALLOW_ONCE = "allowed-once";

/** 建一个带源文件的临时工作区，登记进调用方那条 describe 名下。 */
function workspace(cleanups: Cleanups): string {
  const dir = makeTempDir(cleanups, "zg-guard-");
  writeFileSync(path.join(dir, "auth.ts"), "export function authService() { return 1; }\n");
  return dir;
}

/** 一棵树：root 与其子目录 pkg（会话开在子目录、模型要检索上层）。 */
function tree(cleanups: Cleanups): { root: string; pkg: string } {
  const root = workspace(cleanups);
  const pkg = path.join(root, "pkg");
  mkdirSync(pkg, { recursive: true });
  // pkg 不单独登记：root 那条清理是递归的，同一次删除里已经带上它。
  return { root, pkg };
}

describe.skipIf(!zgAvailable())("真实宿主：安全兜底 guard 被官方流水线当成拒绝", () => {
  const cleanups: Cleanups = [];

  afterAll(() => {
    drainCleanups(cleanups);
  });

  it("zg_index 少 confirm=true 被拒，理由是本包那一句（不是框架的通用错）", async () => {
    const host = await startHost();
    registerDummyTools(host, ["bash"]);
    const ws = workspace(cleanups);
    try {
      const outcome = await host.call("zg_index", {}, host.agentOf(ws));
      assert.ok(outcome.isError);
      expect(host.textOf(outcome)).toContain("confirm");
      // 被 guard 拒掉 ⇒ 一条 zg 都不该起来。
      expect(
        host.shellCalls.filter((row) => row.request.command.startsWith("zg --index")),
      ).toStrictEqual([]);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("root 非法（相对路径）同样在 guard 就被拒", async () => {
    const host = await startHost();
    registerDummyTools(host, ["bash"]);
    const ws = workspace(cleanups);
    try {
      const outcome = await host.call(ASKED_TOOL, { root: "relative/path" }, host.agentOf(ws));
      assert.ok(outcome.isError);
      assert.match(host.textOf(outcome), /绝对路径/u);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("别的工具一律放行（guard 只拦 zg_*）", async () => {
    const host = await startHost();
    registerDummyTools(host, ["bash"]);
    const ws = workspace(cleanups);
    try {
      const outcome = await host.call("bash", { command: "ls -la" }, host.agentOf(ws));
      assert.ok(!outcome.isError, host.textOf(outcome));
      expect(host.textOf(outcome)).toBe("bash ran");
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe.skipIf(!zgAvailable() || !embeddingCached(TEST_EMBEDDING))(
  "真实宿主：search-first 门禁在真实调用序下放行/拦截",
  () => {
    const cleanups: Cleanups = [];

    afterAll(() => {
      drainCleanups(cleanups);
    });

    it("索引在时 grep 先被拦 → 成功 zg_search 发配额 → 放行 → 配额耗尽再拦", async () => {
      const host = await startHost({
        config: { defaultEmbedding: TEST_EMBEDDING, grepBudgetPerSearch: GREP_BUDGET },
      });
      registerDummyTools(host, ["bash", "grep"]);
      const ws = workspace(cleanups);
      try {
        const agent = host.agentOf(ws);
        const built = await host.call("zg_index", { confirm: true }, agent);
        assert.ok(!built.isError, host.textOf(built));

        // 建过索引 ⇒ 门禁对 bash 里的 grep 发难（配额表此刻是空的）。
        const blocked = await host.call("bash", { command: GREP_COMMAND }, agent);
        assert.ok(blocked.isError);
        expect(host.textOf(blocked)).toContain("zg_search");

        // 一次成功的语义检索发一轮配额（本轮是 GREP_BUDGET）。
        const search = await host.call("zg_search", { query: "authService" }, agent);
        assert.ok(!search.isError, host.textOf(search));
        expect(host.textOf(search)).toContain("命中摘要");

        // 额度就是上面传进去的那一枚：一次花掉一额，每额都放行，多一轮少一轮都由它生成。
        const rounds = await inOrder(
          Array.from(
            { length: GREP_BUDGET },
            () => () => host.call("bash", { command: GREP_COMMAND }, agent),
          ),
        );
        for (const allowed of rounds) {
          assert.ok(!allowed.isError, host.textOf(allowed));
        }
        const exhausted = await host.call("bash", { command: GREP_COMMAND }, agent);
        assert.ok(exhausted.isError);
        expect(host.textOf(exhausted)).toContain("zg_search");

        // 原生 grep 工具同判据（它此刻也过了配额 ⇒ 被拦）。
        const native = await host.call("grep", { path: ws, pattern: "auth" }, agent);
        assert.ok(native.isError);
        expect(host.textOf(native)).toContain("zg_search");
      } finally {
        await host.dispose();
      }
    }, 300_000);

    it("行 config 关掉门禁后 grep 不再被拦", async () => {
      const host = await startHost({
        config: { enforceSearchFirst: false, defaultEmbedding: TEST_EMBEDDING },
      });
      registerDummyTools(host, ["bash"]);
      const ws = workspace(cleanups);
      try {
        const agent = host.agentOf(ws);
        const built = await host.call("zg_index", { confirm: true }, agent);
        assert.ok(!built.isError, host.textOf(built));
        const allowed = await host.call("bash", { command: GREP_COMMAND }, agent);
        assert.ok(!allowed.isError, host.textOf(allowed));
      } finally {
        await host.dispose();
      }
    }, 300_000);

    it("重建占着这棵树时 grep 被放行（否则检索与检索两条路同时堵死）", async () => {
      const host = await startHost({
        indexTimeoutMs: 30_000,
        config: { defaultEmbedding: TEST_EMBEDDING },
      });
      registerDummyTools(host, ["bash"]);
      const ws = workspace(cleanups);
      try {
        const agent = host.agentOf(ws);
        const built = await host.call("zg_index", { confirm: true }, agent);
        assert.ok(!built.isError, host.textOf(built));
        // 后台重建：占位即刻生效（jobsOf 现读、注册表在场）。
        const background = await host.call(
          "zg_index",
          { confirm: true, background: true, rebuild: true },
          agent,
        );
        assert.ok(!background.isError, host.textOf(background));
        expect(host.textOf(background)).toContain("zvec-grep-rebuild-");

        const bypassed = await host.call("bash", { command: GREP_COMMAND }, agent);
        assert.ok(!bypassed.isError, host.textOf(bypassed));
      } finally {
        await host.dispose();
      }
    }, 300_000);
  },
);

describe.skipIf(!zgAvailable())(
  "真实宿主：显式 root 的官方用户确认（pre-execute → approval）",
  () => {
    const cleanups: Cleanups = [];

    afterAll(() => {
      drainCleanups(cleanups);
    });

    it("开关打开时，祖先工作区要被问一次；用户允许一次即放行并照常执行", async () => {
      const { root, pkg } = tree(cleanups);
      const host = await startHost({ requireApprovalForExplicitRoot: true, approval: true });
      const asked = host.patchApproval(ALLOW_ONCE);
      try {
        const outcome = await host.call(ASKED_TOOL, { root }, host.agentOf(pkg));
        assert.ok(!outcome.isError, host.textOf(outcome));
        // 真的问过一次，问的是这个 root（不是别的调用）。
        expect(asked).toHaveLength(1);
        const [request] = asked;
        assert.ok(request !== undefined, "审批桩应记下那一次询问");
        expect(request.toolName).toBe(ASKED_TOOL);
        // 官方形状里 reason 是可选的一位（ApprovalRequestEvent），不先收窄就拿它做子串断言，
        // 红了只会得到一句 received must be a string。
        const { reason } = request;
        assert.equal(typeof reason, "string", `询问理由应是字符串，实际 ${String(reason)}`);
        expect(reason).toContain(root);
        // 执行期回显的是真 zg 的状态报告（说明放行后真的跑了命令）。
        expect(host.textOf(outcome)).toContain("index not configured");
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("同意一次之后同一个 root 不再被问（它已由那次成功执行登记进白名单）", async () => {
      const { root, pkg } = tree(cleanups);
      const host = await startHost({ requireApprovalForExplicitRoot: true, approval: true });
      const asked = host.patchApproval(ALLOW_ONCE);
      try {
        const first = await host.call(ASKED_TOOL, { root }, host.agentOf(pkg));
        assert.ok(!first.isError, host.textOf(first));
        const second = await host.call(ASKED_TOOL, { root }, host.agentOf(pkg));
        assert.ok(!second.isError, host.textOf(second));
        // 只问一次：rootOf 成功后 ledger 登记了这棵树，第二次不再打扰用户。
        // 这与「拒绝不登记」是同一枚硬币的两处（下一条用例钉的是拒绝那条分支）。
        expect(asked).toHaveLength(1);
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("用户拒绝时确定性失败，且拒绝不把那个 root 记进白名单", async () => {
      const { root, pkg } = tree(cleanups);
      const host = await startHost({ requireApprovalForExplicitRoot: true, approval: true });
      const asked = host.patchApproval("rejected");
      try {
        const outcome = await host.call(ASKED_TOOL, { root }, host.agentOf(pkg));
        assert.ok(outcome.isError);
        const second = await host.call(ASKED_TOOL, { root }, host.agentOf(pkg));
        assert.ok(second.isError);
        // 又被问一次 ⇒ 上一次的拒绝没有把 root 变成「已观测」。
        expect(asked).toHaveLength(2);
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("宿主没装 approval：ask 由官方 fail-closed 成拒绝，理由是本包那一句", async () => {
      const { root, pkg } = tree(cleanups);
      const host = await startHost({ requireApprovalForExplicitRoot: true });
      try {
        const outcome = await host.call(ASKED_TOOL, { root }, host.agentOf(pkg));
        assert.ok(outcome.isError);
        // dsh-tools 的 serviceAsk：审批服务缺席 ⇒ deny，reason 取 ask.reason。
        expect(host.textOf(outcome)).toContain("指定了一个既不是本会话工作区");
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("审批通道不可用（unavailable）同样是拒绝，不是放行", async () => {
      const { root, pkg } = tree(cleanups);
      const host = await startHost({ requireApprovalForExplicitRoot: true, approval: true });
      const asked = host.patchApproval("unavailable");
      try {
        const outcome = await host.call(ASKED_TOOL, { root }, host.agentOf(pkg));
        assert.ok(outcome.isError);
        expect(host.textOf(outcome)).toContain("no approval channel is available");
        expect(asked).toHaveLength(1);
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("开关关着（默认）时不问：授权判据照旧，该放行的放行、该拒的拒", async () => {
      const { root, pkg } = tree(cleanups);
      const stranger = workspace(cleanups);
      // 装服务才谈得上「一次都没问」：没有 approval 时那份名册根本无从记录。
      const host = await startHost({ approval: true });
      const asked = host.patchApproval(ALLOW_ONCE);
      try {
        // 相关 ⇒ 直接放行，且没有被问。
        const allowed = await host.call(ASKED_TOOL, { root }, host.agentOf(pkg));
        assert.ok(!allowed.isError, host.textOf(allowed));
        // 不相关 ⇒ rootOf 拒，且没有被问（这道闸默认关）。
        const denied = await host.call(ASKED_TOOL, { root: stranger }, host.agentOf(pkg));
        assert.ok(denied.isError);
        expect(host.textOf(denied)).toContain("未获授权");
        expect(asked).toStrictEqual([]);
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("自己的会话工作区不必问（首次调用就被问会是纯打扰）", async () => {
      const ws = workspace(cleanups);
      const host = await startHost({ requireApprovalForExplicitRoot: true, approval: true });
      const asked = host.patchApproval(ALLOW_ONCE);
      try {
        const outcome = await host.call(ASKED_TOOL, { root: ws }, host.agentOf(ws));
        assert.ok(!outcome.isError, host.textOf(outcome));
        expect(asked).toStrictEqual([]);
      } finally {
        await host.dispose();
      }
    }, 60_000);
  },
);
