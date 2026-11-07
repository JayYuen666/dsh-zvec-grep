// lib/zg-errors.ts 的单元测试：从真实形状的 zg 0.3.0 失败输出里抽错误码与成因，
// 并区分「占锁方是一次重建」与「占锁方是别的进程」——等待策略只对前者排队。
// 0.3.0 的形状（上游 zg-cli/src/diagnostics.rs 的 format_error_report）：
//   Error[<码>]: <成因一句话>
//   Help: <出路>            （可选）
//   Error location: <file:line:col>
// 占锁方信息在成因串里（`lock is busy: lock=<路径> operation=<op>`），不再有 Details: 块。
// MCP 传输的同一文本首行小写（`error[...]`），码行定位大小写不敏感。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  classifyConcurrentFailure,
  zgErrorCode,
  zgErrorMessage,
  LOCK_BUSY_CODE,
  PERMISSION_DENIED_CODE,
  REBUILD_OPERATION,
} from "../lib/zg-errors.ts";
import type { ConcurrentZgFailure, LockBusyFailure } from "../lib/zg-errors.ts";

/** 普通索引持锁那条实测形状里的锁路径（多组用例共用）。 */
const INDEX_LOCK_PATH = "/ws/.zvec-grep/locks/home.write";

/** 成因串与定位行：0.3.0 的完整错误块由这几段拼出来。 */
function errorBlock(code: string, message: string, extra: string[] = []): string {
  return [`Error[${code}]: ${message}`, ...extra, "Error location: crates/zg/src/main.rs:1:1"].join(
    "\n",
  );
}

/** 实测形状（0.3.0 的 workspace/lock.rs 锁等待错误）：重建持锁时的检索失败——立即失败那一支。 */
const LOCK_BUSY_REBUILD = errorBlock(
  LOCK_BUSY_CODE,
  "lock is busy: lock=/private/tmp/zgconc/.zvec-grep/locks/home.write operation=index.rebuild",
);

/** 实测形状：占锁方是一次普通索引，不是重建。 */
const LOCK_BUSY_INDEX = errorBlock(
  LOCK_BUSY_CODE,
  `lock is busy: lock=${INDEX_LOCK_PATH} operation=index`,
);

/** 实测形状（workspace/lock.rs 的等待超时分支）：锁路径写作 storage_dir=。 */
const LOCK_BUSY_TIMEOUT = errorBlock(
  LOCK_BUSY_CODE,
  `timed out waiting for workspace lock: storage_dir=${INDEX_LOCK_PATH} operation=index.rebuild`,
);

/** 远程授权被拒：上游报错自带可照抄的 grant 命令。 */
const PERMISSION_DENIED = errorBlock(
  PERMISSION_DENIED_CODE,
  'Remote embedding authorization required for qwen/text-embedding-v4 at https://example/v1/embeddings. Run zg --auth grant "/ws" --capability embedding --scope workspace --embedding qwen/text-embedding-v4 --endpoint "https://example/v1/embeddings", or pass --allow-remote for this command only.',
);

describe("错误码抽取", () => {
  it("从 Error[码]: 行抽得出错误码（CLI 大写 Error 与 MCP 小写 error 两种形态）", () => {
    assert.equal(zgErrorCode(LOCK_BUSY_REBUILD), LOCK_BUSY_CODE);
    assert.equal(
      zgErrorCode(LOCK_BUSY_REBUILD.replace("Error[", "error[")),
      LOCK_BUSY_CODE,
      "MCP 文本首行小写",
    );
    assert.equal(zgErrorCode(PERMISSION_DENIED), PERMISSION_DENIED_CODE);
  });

  it("没有码行就是非结构化失败（普通 Error: 单行无码）", () => {
    assert.equal(zgErrorCode("bash: zg: command not found"), undefined);
    assert.equal(zgErrorCode("Error: Index unavailable"), undefined);
    assert.equal(zgErrorCode(""), undefined);
  });

  it("首处码行之后的码不参与判读：一次失败只归因一个码", () => {
    const shifted = [
      "Error[SOMETHING.ELSE]: first failure",
      "",
      `Error[${LOCK_BUSY_CODE}]: lock is busy: lock=/x operation=index.rebuild`,
    ].join("\n");
    assert.equal(zgErrorCode(shifted), "SOMETHING.ELSE");
  });

  it("成因串抽取：码行冒号之后的整段；无码行交回空串（契约变更：不再交 undefined）", () => {
    const message = zgErrorMessage(LOCK_BUSY_REBUILD);
    assert.equal(
      message,
      "lock is busy: lock=/private/tmp/zgconc/.zvec-grep/locks/home.write operation=index.rebuild",
    );
    assert.equal(zgErrorMessage("Error: 无码行"), "");
  });
});

/** 收窄助手：把结果确认成锁忙失败后再断言，避免每条用例都写一遍判别式。 */
function asLockBusy(failure: ConcurrentZgFailure | null): LockBusyFailure {
  assert.ok(failure?.kind === "lock-busy", "期望锁忙失败");
  return failure;
}

describe("并发类失败识别", () => {
  it(`锁忙且占锁方是重建（${REBUILD_OPERATION}）：可排队等待`, () => {
    const failure = asLockBusy(classifyConcurrentFailure(LOCK_BUSY_REBUILD));
    assert.equal(failure.ownerOperation, "index.rebuild", "成因串里确实读到了这一枚操作名");
    assert.equal(failure.rebuild, true);
    assert.equal(failure.lockPath, "/private/tmp/zgconc/.zvec-grep/locks/home.write");
  });

  it("锁忙但占锁方是普通索引：不排队", () => {
    const failure = classifyConcurrentFailure(LOCK_BUSY_INDEX);
    assert.equal(asLockBusy(failure).rebuild, false);
    assert.equal(asLockBusy(failure).ownerOperation, "index");
  });

  it("等待超时形态：锁路径从 storage_dir= 读出，重建判定不变", () => {
    const failure = asLockBusy(classifyConcurrentFailure(LOCK_BUSY_TIMEOUT));
    assert.equal(failure.rebuild, true);
    assert.equal(failure.lockPath, INDEX_LOCK_PATH);
  });

  it("成因缺失 operation= 时不当作重建（宁可少等也不无界挂起）", () => {
    const noOwner = errorBlock(LOCK_BUSY_CODE, `lock is busy: lock=${INDEX_LOCK_PATH}`);
    const failure = classifyConcurrentFailure(noOwner);
    assert.equal(asLockBusy(failure).rebuild, false);
    assert.equal(asLockBusy(failure).ownerOperation, undefined);
  });

  it("成因串整体缺失：仍判成锁忙，占锁方与锁路径交回 undefined", () => {
    const codeOnly = `Error[${LOCK_BUSY_CODE}]:`;
    const failure = classifyConcurrentFailure(codeOnly);
    assert.equal(asLockBusy(failure).rebuild, false);
    assert.equal(asLockBusy(failure).ownerOperation, undefined);
    assert.equal(asLockBusy(failure).lockPath, undefined);
  });

  it("远程授权被拒归类 permission-denied", () => {
    const failure = classifyConcurrentFailure(PERMISSION_DENIED);
    assert.equal(failure?.kind, "permission-denied");
  });

  it("其它错误码一律不归本插件策略类", () => {
    const other = errorBlock(
      "ZG.ENGINE.NOT_FOUND",
      "No index found in /private/tmp/znoidx. Run `zg --index --embedding <model>` to build it, then retry the query.",
    );
    assert.equal(classifyConcurrentFailure(other), null);
  });

  it("无结构化失败返回 null", () => {
    assert.equal(classifyConcurrentFailure("Error: 普通错误"), null);
    assert.equal(classifyConcurrentFailure(""), null);
  });

  it("help 与 error location 行不干扰识别：码取第一处、成因取同一行", () => {
    const withHelp = [
      `Error[${LOCK_BUSY_CODE}]: lock is busy: lock=/x operation=context.refresh`,
      "Help: wait for the operation to finish and retry",
      "Error location: crates/zg-engine/src/workspace/lock.rs:50:11",
    ].join("\n");
    const failure = asLockBusy(classifyConcurrentFailure(withHelp));
    assert.equal(failure.ownerOperation, "context.refresh");
    assert.equal(failure.rebuild, false);
    // 成因串只在码行内找：Help 行里的 operation=（若有）不会被捞走。
    assert.equal(zgErrorMessage(withHelp), "lock is busy: lock=/x operation=context.refresh");
  });
});
