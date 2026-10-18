// 重建读面的宿主侧直测：服务注册、三个方法的源模式契约，以及官方网关要读的 Remote 标记。
//
// 端到端（真作业注册表 + 真进程）在 test/integration/rebuild-endpoints.test.ts；这一份只钉
// 服务本身，不启任何进程，也不经 HTTP/网关。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";

import { installRebuildRemote, ZvecRebuildService } from "../lib/rebuild-remote.ts";
import type { ZvecRebuildDeps } from "../lib/rebuild-remote.ts";
import { REBUILD_REMOTE_NAMESPACE } from "../lib/rebuild-shape.ts";
import { REBUILD_DESCRIPTORS } from "../src/rebuild-reader.ts";
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
