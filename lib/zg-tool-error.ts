// lib/zg-tool-error.ts —— 本包工具失败的**错误类与错误码**。
//
// 与 lib/zg-errors.ts 的分工：那个文件是**识别层**（把子进程输出里的码与成因抽成可判定的
// 事实，不构造错误）；本文件把「要抛给宿主的那一份」定型。分成两个文件不是洁癖：
// `eslint(max-classes-per-file)` 只允许一个类，而识别层已经有一个
// `DaemonCallFailureError`（传输层失败、不是工具失败，语义上不该合并）。
//
// 为什么错误类必须继承宿主的 `HarnessError`、以及为什么 `@deepseek-ai/dsh-error` 必须是
// peer 而不是 devDependency，见下面那个类的文档注释与 `test/publish-manifest.test.ts` 的
// 正相断言。

import { HarnessError } from "@deepseek-ai/dsh-error";

/**
 * 本包工具失败的错误码。
 *
 * 为什么要码而不只是人话：宿主 `packages/core/tools/src/pipeline.ts` 的 `errorInfo()` 用
 * `error instanceof HarnessError` 判断要不要把 `{ name, code }` 写进工具失败的
 * `ToolFailure.info`。判不中时 `info` **整块消失且没有任何提示** —— 模型只看到一句
 * `Error: …`，无法据此区分「等一会重试」与「换条路」。码是给模型与下游消费方判读的，
 * 人话仍然是 `message`，两者不互相替代。
 *
 * 码值一经发布即持久化契约（宿主 error-codes 的注释原话：`The values are persisted
 * contract`）：会话日志里存的是这些串，改名等于让旧日志读不懂。要加码就新增，不要复用。
 */
export const ZG_TOOL_ERROR_CODES = {
  /** 装着的 zg 低于本包下限；出路是升级 zg（不是重试）。 */
  versionTooOld: "ZG_VERSION_TOO_OLD",
  /** 本插件正在重建该根：等它落定后重试一次即可，属于可重试。 */
  rebuildLockBusy: "ZG_REBUILD_LOCK_BUSY",
  /** 别的进程/操作占着锁：不归本插件管，重试也等不到。 */
  lockBusy: "ZG_LOCK_BUSY",
  /** 远程 embedding 授权被拒：出路在部署侧（开关或 grant）。 */
  permissionDenied: "ZG_PERMISSION_DENIED",
  /** 守护进程拉不起来或调用失败：模型该退回不起服务的那条路。 */
  daemonUnavailable: "ZG_DAEMON_UNAVAILABLE",
  /** 调用方给的根不存在或不被允许。 */
  rootRejected: "ZG_ROOT_REJECTED",
  /** 参数形态不合契约（非对象、必填缺失）。模型的输入错误，改参数即可。 */
  badArguments: "ZG_BAD_ARGUMENTS",
  /** zg 跑了但失败了，且不属于以上任何一类。 */
  commandFailed: "ZG_COMMAND_FAILED",
} as const;

/** {@link ZG_TOOL_ERROR_CODES} 的取值类型。 */
export type ZgToolErrorCode = (typeof ZG_TOOL_ERROR_CODES)[keyof typeof ZG_TOOL_ERROR_CODES];

/**
 * 本包工具失败的统一错误类。
 *
 * 继承宿主的 `HarnessError` 是**整件事的关键**：那个类必须来自宿主那一份模块实例
 * （`@deepseek-ai/dsh-error` 声明在 peerDependencies，构建期按包名外部化），
 * `instanceof` 才成立。若把它挪进 devDependencies，rolldown 会把整包内联进 host.js，
 * 于是本包继承的是产物里另一个类，宿主的判据恒为 false —— 码静默消失，
 * 而源码、单测、类型检查一路绿。`test/publish-manifest.test.ts` 有一条正相断言盯着这一位。
 */
export class ZgToolError extends HarnessError {
  public constructor(code: ZgToolErrorCode, message: string, options?: ErrorOptions) {
    super(message, code, options);
    this.name = "ZgToolError";
  }
}
