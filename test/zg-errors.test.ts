// lib/zg-errors.ts 的单元测试：从真实形状的 zg 失败输出里抽错误码与明细，
// 并区分「占锁方是一次重建」与「占锁方是别的进程」——等待策略只对前者排队。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  classifyConcurrentFailure,
  zgErrorCode,
  DAEMON_LEASE_CODE,
  LOCK_BUSY_CODE,
} from "../lib/zg-errors.ts";
import type { ConcurrentZgFailure, DaemonLeaseFailure, LockBusyFailure } from "../lib/zg-errors.ts";

const CODE_LINE = "Code: ZVEC_GREP.ENGINE.LOCK.BUSY";
const TITLE = "Error: Index unavailable";
const DETAILS = "Details:";

/** 实测形状：重建持锁时的检索失败。 */
const LOCK_BUSY_REBUILD = [
  TITLE,
  CODE_LINE,
  DETAILS,
  "  lock: /private/tmp/zgconc/.zvec-grep/locks/home.write",
  "  operation: info",
  "  ownerOperation: index.rebuild",
  "  ownerPid: 14962",
  "  ownerHost: box.local",
  "",
].join("\n");

/** 实测形状：占锁方是一次普通索引，不是重建。 */
const LOCK_BUSY_INDEX = [
  TITLE,
  CODE_LINE,
  DETAILS,
  "  lock: /ws/.zvec-grep/locks/home.write",
  "  operation: info",
  "  ownerOperation: index",
  "  ownerPid: 4242",
].join("\n");

/** 实测形状：守护进程持有索引写租约。 */
const DAEMON_LEASE = [
  "Error: A zvec-grep daemon owns index writes for this root",
  "Code: ZVEC_GREP.ENGINE.DAEMON_LEASE_ACTIVE",
  DETAILS,
  "  root: /tmp/zgsrv2",
  "  pid: 17135",
].join("\n");

describe("错误码抽取", () => {
  it("抽得出错误码", () => {
    assert.equal(zgErrorCode(LOCK_BUSY_REBUILD), LOCK_BUSY_CODE);
    assert.equal(zgErrorCode(DAEMON_LEASE), DAEMON_LEASE_CODE);
  });

  it("没有 Code 行就是非结构化失败", () => {
    assert.equal(zgErrorCode("bash: zg: command not found"), undefined);
    assert.equal(zgErrorCode(""), undefined);
  });
});

/** 收窄助手：把结果确认成锁忙失败后再断言，避免每条用例都写一遍判别式。 */
function isLockBusy(failure: ConcurrentZgFailure | null): failure is LockBusyFailure {
  return failure?.kind === "lock-busy";
}

function isDaemonLease(failure: ConcurrentZgFailure | null): failure is DaemonLeaseFailure {
  return failure?.kind === "daemon-lease";
}

function asDaemonLease(failure: ConcurrentZgFailure | null): DaemonLeaseFailure {
  assert.ok(isDaemonLease(failure), "期望守护进程租约失败");
  return failure;
}

function asLockBusy(failure: ConcurrentZgFailure | null): LockBusyFailure {
  assert.ok(isLockBusy(failure), "期望锁忙失败");
  return failure;
}

describe("并发类失败识别", () => {
  it("锁忙且占锁方是重建：可排队等待", () => {
    const failure = asLockBusy(classifyConcurrentFailure(LOCK_BUSY_REBUILD));
    assert.equal(failure.rebuild, true);
    assert.equal(failure.ownerPid, "14962");
    assert.equal(failure.lockPath, "/private/tmp/zgconc/.zvec-grep/locks/home.write");
  });

  it("锁忙但占锁方是普通索引：不排队", () => {
    const failure = classifyConcurrentFailure(LOCK_BUSY_INDEX);
    assert.equal(asLockBusy(failure).rebuild, false);
    assert.equal(asLockBusy(failure).ownerOperation, "index");
  });

  it("明细缺 ownerOperation 时不当作重建（宁可少等也不无界挂起）", () => {
    const noOwner = [TITLE, CODE_LINE, DETAILS, "  lock: /ws/.zvec-grep/locks/home.write"].join(
      "\n",
    );
    const failure = classifyConcurrentFailure(noOwner);
    assert.equal(asLockBusy(failure).rebuild, false);
    assert.equal(asLockBusy(failure).ownerOperation, undefined);
  });

  it("守护进程租约", () => {
    const failure = asDaemonLease(classifyConcurrentFailure(DAEMON_LEASE));
    assert.equal(failure.pid, "17135");
  });

  it("其它错误码一律不归并发类", () => {
    const other = [
      "Error: No zvec-grep index found for this workspace",
      "Code: ZVEC_GREP.ENGINE.SERVICE.WORKSPACE_INDEX_NOT_FOUND",
      DETAILS,
      "  root: /private/tmp/znoidx",
    ].join("\n");
    assert.equal(classifyConcurrentFailure(other), null);
  });

  it("没有明细块时错误码仍抽得出，并发类识别不误判", () => {
    const codeOnly = `Error: Index unavailable\n${CODE_LINE}`;
    assert.equal(zgErrorCode(codeOnly), LOCK_BUSY_CODE);
    const failure = asLockBusy(classifyConcurrentFailure(codeOnly));
    assert.equal(failure.rebuild, false);
    assert.equal(failure.lockPath, undefined);
  });

  it("无结构化失败返回 null", () => {
    assert.equal(classifyConcurrentFailure("Error: 普通错误"), null);
    assert.equal(classifyConcurrentFailure(""), null);
  });

  it("重复键取首次出现", () => {
    const duplicated = [CODE_LINE, DETAILS, "  ownerPid: 1", "  ownerPid: 2"].join("\n");
    const failure = classifyConcurrentFailure(duplicated);
    assert.equal(asLockBusy(failure).ownerPid, "1");
  });

  it("明细块之后的非键值行终止收集", () => {
    const truncated = [
      CODE_LINE,
      DETAILS,
      "  ownerOperation: index.rebuild",
      "这段是尾部截断的散文",
      "  ownerPid: 999",
    ].join("\n");
    const failure = asLockBusy(classifyConcurrentFailure(truncated));
    assert.equal(failure.rebuild, true);
    assert.equal(failure.ownerPid, undefined);
  });
});
