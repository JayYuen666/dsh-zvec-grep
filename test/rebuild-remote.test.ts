// 重建读面的宿主侧直测：服务注册、三个方法的源模式契约，以及官方网关要读的 Remote 标记。
//
// 端到端（真作业注册表 + 真进程）在 test/integration/rebuild-endpoints.test.ts；这一份只钉
// 服务本身，不启任何进程，也不经 HTTP/网关。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";

import {
  attachIndexWrite,
  installRebuildRemote,
  ZvecRebuildService,
} from "../lib/rebuild-remote.ts";
import type { RebuildRecord, ZvecRebuildDeps } from "../lib/rebuild-remote.ts";
import { REBUILD_REMOTE_NAMESPACE } from "../lib/rebuild-shape.ts";
import { REBUILD_DESCRIPTORS, createRebuildReader } from "../src/rebuild-reader.ts";
import type { RemoteHost } from "../src/rebuild-reader.ts";
import { MESSAGES } from "../lib/messages.ts";

/**
 * 要「盘上真工作区」的用例按平台跳过：本包 root 判据（`lib/cli.ts` 的 `assertAbsoluteRoot`）
 * 只认以 `/` 开头的绝对路径，而 win32 上 `os.tmpdir()` 交回的是盘符形态（CI 实测
 * `C:\Users\RUNNER~1\AppData\Local\Temp`）——`rebuild` 在 root 那一步就答「不是绝对路径」，
 * 被测的「注册表缺席」分支根本走不到。
 *
 * 与 `test/host.test.ts` 的 `realRootUnavailable` 同因同判据；那一处的长注释讲了为什么是跳过
 * 而不是放宽判据（Windows 宿主不在本包支持面内，见 README「支持面」一节）。
 */
const posixRootUnavailable = process.platform === "win32";

/** 最小依赖：方法在这些用例里只会走到「注册表缺席 / 空侧表 / 空白名单」三支。 */
function depsOf(): ZvecRebuildDeps {
  return {
    host: {
      shell: {
        resolve: () => {
          throw new Error("本次用例不该起进程");
        },
        execute: async () => {
          throw new Error("本次用例不该起进程");
        },
      },
      timer: {
        timeout: () => () => {
          void 0;
        },
      },
    } as never,
    config: {} as never,
    messages: () => MESSAGES.zh,
    jobsOf: () => {
      void 0;
    },
    records: new Map(),
    rebuilds: {
      claim: () => null,
      release: () => {
        void 0;
      },
    } as never,
    versionGate: {
      ensure: async () => {
        void 0;
      },
    },
    serverGate: { ready: async () => false },
    ledger: { list: () => [], has: () => true },
  };
}

describe("官方 Typert Remote 源模式：重建服务", () => {
  it("装进真 Context：服务键可取回，三个方法都带 @Remote 标记", () => {
    const ctx = new Context();
    assert.equal(installRebuildRemote(ctx, depsOf()), true);
    const service: unknown = ctx.get(REBUILD_REMOTE_NAMESPACE);
    assert.ok(service instanceof ZvecRebuildService);
    assert.deepEqual(
      remoteMethods(service)
        .map((marker) => marker.method)
        .toSorted(),
      ["rebuild", "roots", "status"],
    );
  });

  it("客户端 descriptor 与宿主 @Remote 标记逐项对质", () => {
    const ctx = new Context();
    installRebuildRemote(ctx, depsOf());
    const service = ctx.get(REBUILD_REMOTE_NAMESPACE) as ZvecRebuildService;
    const markers = remoteMethods(service)
      .map((marker) => marker.method)
      .toSorted();
    assert.deepEqual(
      REBUILD_DESCRIPTORS.map((descriptor) => descriptor.method).toSorted(),
      markers,
    );
    for (const descriptor of REBUILD_DESCRIPTORS) {
      assert.equal(descriptor.service, REBUILD_REMOTE_NAMESPACE);
      assert.equal(descriptor.namespace, REBUILD_REMOTE_NAMESPACE);
      assert.equal(descriptor.invocation.kind, "direct");
      assert.equal(descriptor.result.mode, "src-json");
      if (descriptor.method !== "roots") {
        assert.deepEqual(
          descriptor.parameters.map((parameter) => parameter.wire),
          ["request"],
          "宿主方法签名有一个 request 参数，线上字段名必须同源",
        );
      }
    }
  });

  it("注册口缺席时返回 false（可选读面，不让 apply 下线）", () => {
    assert.equal(installRebuildRemote({} as never, depsOf()), false);
  });

  it("roots 交回白名单与就绪态；status 在记录缺席时给可行动错误", async () => {
    const ctx = new Context();
    installRebuildRemote(ctx, depsOf());
    const service = ctx.get(REBUILD_REMOTE_NAMESPACE) as ZvecRebuildService;
    assert.deepEqual(await service.roots(), { roots: [], serverReady: false });

    // 请求不是记录（畸形线缆输入）：两个方法都该落到保守分支而不是抛。
    const badRebuild = await service.rebuild(null as never);
    assert.equal(badRebuild.ok, false);
    const badStatus = service.status(null as never);
    assert.equal(badStatus.ok, false);

    const status = service.status({ jobId: "not-ours" });
    assert.equal(status.ok, false);
    assert.match((status as { error: string }).error, /历史窗口/u);
  });

  it("历史裁剪抛错：先杀掉刚起的进程再交回启动失败，不把异常穿过本函数", () => {
    // 回归用例：`pruneRebuildHistory` 里 `list()` / `remove()` 抛错时若不在这里接住，
    // 异常会穿过 attachIndexWrite，调用方那两条 release 都轮不到执行 —— 刚 spawn 的 zg
    // 成了孤儿（继续写这棵树），占位也永远留在「重建中」。
    const killed: string[] = [];
    const proc = {
      kill: (): boolean => {
        killed.push("killed");
        return true;
      },
    } as never;
    const attached = attachIndexWrite(
      {
        jobsOf: () => ({
          list: () => {
            throw new Error("registry list blew up");
          },
        }),
        records: new Map(),
      } as never,
      "/repo",
      MESSAGES.zh,
      { proc, command: "zg index --rebuild" },
    );
    assert.equal("error" in attached, true);
    assert.equal((attached as { status: number }).status, 500);
    assert.match((attached as { error: string }).error, /registry list blew up/u);
    assert.deepEqual(killed, ["killed"], "起出来的那条进程必须被收掉");
  });

  it("卸载效应：每条独立收口，remove 抛错时只收自己那条进程，侧表仍旧清空", async () => {
    // 回归用例：`releaseRebuildRecords` 的逐条 try/catch。`jobs.remove` 在跑作业上会抛，
    // 若不接住，异常会穿过卸载效应、后面的记录一条都收不成，而侧表还钉着一批已死的记录。
    const killed: string[] = [];
    const removed: string[] = [];
    const identity = { kind: "zvec-grep-rebuild", label: "zg index --rebuild", startedAt: 1 };
    const recordId = "zvec-grep-rebuild-aaaaaaaaaaaaaaaa";
    const records = new Map<string, RebuildRecord>([
      [
        recordId,
        {
          proc: {
            kill: (): boolean => {
              killed.push("killed");
              return true;
            },
          } as never,
          root: "/repo",
          id: recordId as never,
          state: { identity, lost: false, timeoutNote: null },
        },
      ],
    ]);
    const jobs = {
      get: () => ({ ...identity, status: "completed", id: recordId }),
      remove: (id: string): void => {
        removed.push(id);
        throw new Error("cannot remove a running job");
      },
    };
    const ctx = new Context();
    const fiber = ctx.plugin({
      apply: (inner: Context) => {
        installRebuildRemote(inner, {
          ...depsOf(),
          jobsOf: () => jobs as never,
          records,
        });
      },
    });
    await delay(0);
    await fiber.dispose();
    assert.deepEqual(removed, ["zvec-grep-rebuild-aaaaaaaaaaaaaaaa"]);
    assert.deepEqual(killed, ["killed"], "收不走的作业必须由我们杀掉进程");
    assert.equal(records.size, 0, "一条收失败不能跳过 records.clear()");
  });

  it.skipIf(posixRootUnavailable)(
    "rebuild 在注册表缺席时给可行动错误（root 要过得了绝对路径那关，故只在 POSIX 上成立）",
    async () => {
      const ctx = new Context();
      installRebuildRemote(ctx, depsOf());
      const service = ctx.get(REBUILD_REMOTE_NAMESPACE) as ZvecRebuildService;
      const rebuilt = await service.rebuild({ root: tmpdir() });
      assert.equal(rebuilt.ok, false);
      assert.match((rebuilt as { error: string }).error, /jobs/u);
    },
  );
});

// ── 客户端读取器（卡片那半的直测：remote 现读 + 挂载缓存的成功后才留）───────────
// 端到端（真网关/真浏览器）在「已发布产物」那条回路；这里用替身钉两件事：
// remote 晚到不把读取器定死成 undefined、挂载 rejection 不留在缓存里。

/** 交回常量的异步方法替身。 */
const constant =
  (value: unknown): (() => Promise<unknown>) =>
  async () =>
    value;

/** 命名空间替身：三个方法各自交回可编程的 RemoteResult（缺省全成功）。 */
function namespaceStub(
  overrides: { roots?: unknown; rebuild?: unknown; status?: unknown } = {},
): Record<string, unknown> {
  const ok = constant;
  return {
    roots: ok(overrides.roots ?? { ok: true, value: { roots: ["/repo"], serverReady: true } }),
    rebuild: ok(overrides.rebuild ?? { ok: true, value: { ok: true, jobId: "job-1" } }),
    status: ok(overrides.status ?? { ok: true, value: { ok: true, status: "running" } }),
  };
}

const SERVICE_KEY = `remote.${REBUILD_REMOTE_NAMESPACE}`;

/** remote/服务表替身的可编程选项。 */
interface HostStubOptions {
  remote?: unknown;
  namespace?: unknown;
  mountResults?: unknown[];
}

/** remote/服务表替身：get 按名字查表；$mount 可编程（mountResults 逐次取，越界取末枚）。 */
function hostOf(opts: HostStubOptions = {}): { host: RemoteHost; mountCalls: number[] } {
  const mountCalls: number[] = [];
  let mountIndex = 0;
  const mounter = {
    $mount: (): Promise<unknown> => {
      mountCalls.push(1);
      const results = opts.mountResults;
      const outcome =
        results === undefined
          ? { mounted: true }
          : results.at(Math.min(mountIndex, results.length - 1));
      mountIndex += 1;
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
  const services = new Map<string, unknown>([
    ["remote", opts.remote ?? mounter],
    [SERVICE_KEY, opts.namespace ?? namespaceStub()],
  ]);
  return { mountCalls, host: { get: (name: string) => services.get(name) } };
}

const MOUNT_FAILURE = new Error("gateway restarted");

/** codec 的替身取法：descriptor.parameters 是官方泛型面，测试按 codec 形状取用。 */
interface CodecFace {
  create: () => { parse: (value: unknown) => unknown };
}
function codecAt(descriptorIndex: number): CodecFace {
  const parameters = REBUILD_DESCRIPTORS[descriptorIndex]?.parameters as readonly {
    codec: CodecFace;
  }[];
  const codec = parameters[0]?.codec;
  assert.ok(codec !== undefined, `descriptor ${descriptorIndex} 应带入参 codec`);
  return codec;
}

describe("客户端读取器：remote 现读与挂载缓存", () => {
  it("ctx 没有 get 面时返回 undefined；有 get 面就给读取器（remote 是否在场不在 apply 期判）", () => {
    assert.equal(createRebuildReader({}), undefined);
    const { host } = hostOf({ remote: 42 });
    assert.notEqual(createRebuildReader(host), undefined);
  });

  it("remote 晚到不把读取器定死：apply 时缺席、调用时在场的部署也能读", async () => {
    // 旧实现 apply 期读一次 remote，读到 undefined 就永远 undefined，重建面板永久不可用。
    // 用盒子而不是 let：remote 是被闭包捕获后再赋值的，盒子让「晚到」这件事在类型上直白。
    const remoteBox: { value: unknown } = { value: undefined };
    const services = new Map<string, unknown>([[SERVICE_KEY, namespaceStub()]]);
    const host: RemoteHost = {
      get: (name: string) => (name === "remote" ? remoteBox.value : services.get(name)),
    };
    const reader = createRebuildReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.roots(), /没有提供 remote 服务/u);
    remoteBox.value = { $mount: () => Promise.resolve({ mounted: true }) };
    const roots = await reader.roots();
    assert.deepEqual(roots, { roots: ["/repo"], serverReady: true });
  });

  it("挂载失败不留在缓存里：下一轮轮询重新挂，重试真的会发生", async () => {
    const { host, mountCalls } = hostOf({ mountResults: [MOUNT_FAILURE, MOUNT_FAILURE] });
    const reader = createRebuildReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.roots(), /gateway restarted/u);
    await assert.rejects(() => reader.roots(), /gateway restarted/u);
    assert.equal(mountCalls.length, 2, "每次失败后缓存被清空，第三次挂载才会发生");
  });

  it("挂载成功后缓存 promise：反复轮询只挂一次", async () => {
    const { host, mountCalls } = hostOf();
    const reader = createRebuildReader(host);
    assert.ok(reader !== undefined);
    await reader.roots();
    await reader.roots();
    assert.equal(mountCalls.length, 1);
  });

  it("rebuild 成功交回宿主的应答，重复发起仍只挂一次", async () => {
    const { host, mountCalls } = hostOf();
    const reader = createRebuildReader(host);
    assert.ok(reader !== undefined);
    assert.deepEqual(await reader.rebuild("/repo"), { ok: true, jobId: "job-1" });
    assert.deepEqual(await reader.rebuild("/other"), { ok: true, jobId: "job-1" });
    assert.equal(mountCalls.length, 1);
  });

  it("命名空间缺席（网关没认这枚贡献）点名抛错，不冒充成别的失败", async () => {
    const { host } = hostOf({ namespace: { roots: 1 } });
    const reader = createRebuildReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.roots(), /未提供：宿主网关没有挂上这枚命名空间/u);
  });

  it("三个方法透传应答：线上拒绝（result.ok=false）带 error 文本", async () => {
    const { host, mountCalls } = hostOf({
      namespace: namespaceStub({
        roots: { ok: false, error: { code: "E-ROOTS", message: "roots down" } },
        rebuild: { ok: false, error: { code: "E-REBUILD", message: "rebuild down" } },
        status: { ok: false, error: { code: "E-STATUS", message: "status down" } },
      }),
    });
    const reader = createRebuildReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.roots(), /E-ROOTS: roots down/u);
    await assert.rejects(() => reader.rebuild("/repo"), /E-REBUILD: rebuild down/u);
    await assert.rejects(() => reader.status("job-1"), /E-STATUS: status down/u);
    assert.equal(mountCalls.length, 1, "三次调用共用同一次成功挂载");
  });

  it("动作被宿主拒（value.ok=false）时交回宿主文案；status 成功摊平成普通对象", async () => {
    const { host } = hostOf({
      namespace: namespaceStub({
        rebuild: { ok: true, value: { ok: false, error: "该工作区已有一条重建" } },
        status: { ok: true, value: { ok: false, error: "unknown jobId" } },
      }),
    });
    const reader = createRebuildReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.rebuild("/repo"), /该工作区已有一条重建/u);
    await assert.rejects(() => reader.status("job-1"), /unknown jobId/u);
    // 成功那一侧：status 摊平成普通对象（卡片只认 status/exitCode/output 三个键）。
    const okHost = hostOf({
      namespace: namespaceStub({
        status: { ok: true, value: { ok: true, status: "completed", exitCode: 0, output: "done" } },
      }),
    });
    const okReader = createRebuildReader(okHost.host);
    assert.ok(okReader !== undefined);
    assert.deepEqual(await okReader.status("job-1"), {
      ok: true,
      status: "completed",
      exitCode: 0,
      output: "done",
    });
  });

  it("入参 codec 是 strict 的手写 parser：形状不合当场抛，从不跨网", () => {
    const startCodec = codecAt(1);
    const statusCodec = codecAt(2);
    assert.deepEqual(startCodec.create().parse({ root: "/repo" }), { root: "/repo" });
    assert.deepEqual(statusCodec.create().parse({ jobId: "job-1" }), { jobId: "job-1" });
    for (const bad of [null, 42, {}, { root: 7 }]) {
      assert.throws(() => startCodec.create().parse(bad), /string root/u);
    }
    for (const bad of [null, 42, {}, { jobId: 7 }]) {
      assert.throws(() => statusCodec.create().parse(bad), /string jobId/u);
    }
  });
});
