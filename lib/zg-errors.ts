// lib/zg-errors.ts —— zg 结构化失败的**识别层**：把子进程输出里的错误码与成因抽成
// 可判定的事实，供错误文案与「要不要等锁」两条路径共用。
//
// 为什么要单独一层：失败文案只回一句人话，模型据此无法区分「本插件正在重建、等一会就好」
// 与「别的进程占着锁、我该另想办法」。等待策略必须拿到**结构化**结论，文案侧只需要人话，
// 两边同源于此，不得各自正则一遍。
//
// zg 0.3.0 的失败输出形状（上游 zg-cli/src/diagnostics.rs 的 format_error_report，非 TTY）：
//   Error[<CODE>]: <一句话成因>
//   Help: <出路>            （可选）
//   Error location: <file:line:col>
// 与 0.2.2 的 `Error: <标题>` + `Code: <码>` + `Details:` 缩进明细块不同：0.3.0 的码在
// 首行的方括号里、成因紧跟其后，明细不再单独成块（锁的占用方直接写进成因串：
// `lock is busy: lock=<路径> operation=<op>`）。MCP 传输的同一错误文本首行是小写
// `error[<CODE>]:`，故码行的定位大小写不敏感。
// 普通非引擎错误仍是单行 `Error: <message>`（无码）——「有码 / 无码」的判读分界见
// host.ts 的 noCodeHint。

/** zg 会给出的、与本插件策略相关的错误码（0.3.0 全部落在 `ZG.ENGINE.*` 一族）。 */
export const LOCK_BUSY_CODE = "ZG.ENGINE.RESOURCE_BUSY";
export const PERMISSION_DENIED_CODE = "ZG.ENGINE.PERMISSION_DENIED";

/** 索引重建与其它占用者分开：等与不等是两回事。0.3.0 的重建持锁方自报名仍为此串
 *  （上游 indexing/service.rs：`options.rebuild ? "index.rebuild" : …`）。 */
export const REBUILD_OPERATION = "index.rebuild";

/**
 * 码行的**定位与取值**形状：`Error[<码>]:`（行首，MCP 文本为小写 `error[`）。
 * 码字符集取 `[A-Za-z0-9_.]`：0.3.0 的码形如 `ZG.ENGINE.RESOURCE_BUSY`；定位与取值
 * 同一条正则完成——0.3.0 没有独立的 `Code:` 行，码只在首行出现一次。
 */
/** 码行的定位形状（行首零个以上空格 + error[码]:；`\]` 之后的成因在代码里切片取）。 */
const CODE_LINE_PREFIX = /^ *error\[[a-z][\w.]*\]:/iu;
/** 成因串分隔符（码行里 `]:` 之后的部分；indexOf 定位，不与正则量词相邻）。 */
const MESSAGE_DELIMITER = "]:";

export interface LockBusyFailure {
  kind: "lock-busy";
  /** 占锁方自报的操作名；成因串缺失或形状变化时为 undefined。 */
  ownerOperation: string | undefined;
  /** 占的是哪把锁（成因串里的 `lock=` / `storage_dir=`；缺失时为 undefined）。 */
  lockPath: string | undefined;
  /** 占锁方是否是一次重建（重建可等，其它占用者不归本插件管）。 */
  readonly rebuild: boolean;
}

/** 远程 embedding 授权被拒（`ZG.ENGINE.PERMISSION_DENIED`）：出路在宿主侧，见 host.ts。 */
export interface PermissionDeniedFailure {
  kind: "permission-denied";
}

export type ConcurrentZgFailure = LockBusyFailure | PermissionDeniedFailure;

/**
 * daemon 传输层失败（fetch 层）：非工具错误、非协议拒绝。auto 档据此在同一次调用里
 * 回退 CLI；`aborted` 为真表示超时/取消，不回退（等待已经花掉了）。
 */
export class DaemonCallFailureError extends Error {
  public readonly aborted: boolean;

  public constructor(message: string, aborted: boolean) {
    super(message);
    this.name = "DaemonCallFailureError";
    this.aborted = aborted;
  }
}

/** 成因串里占锁方操作名的取值形状（`operation=<token>`）。 */
const OPERATION_IN_MESSAGE = /\boperation=(?<op>\S+)/u;
/** 成因串里锁路径的两种写法（立即失败 `lock=` / 等待超时 `storage_dir=`）。 */
const LOCK_IN_MESSAGE = /\b(?:lock|storage_dir)=(?<lock>\S+)/u;

/**
 * 抽错误码。没有该行就不是 zg 的结构化失败（旁路返回 undefined，交给通用失败文案）。
 * 只认第一条码行：一次失败只应有一个码，首处之后的行不属于这次判读。
 */
export function zgErrorCode(stderr: string): string | undefined {
  const line = stderr.split("\n").find((candidate) => CODE_LINE_PREFIX.test(candidate));
  // 定位正则已保证两枚分隔符都在：这里只是把码从「[码]:」里切出来，切空按形状已变处理。
  const from = line === undefined ? -1 : line.indexOf("[") + 1;
  const to = line === undefined ? -1 : line.indexOf(MESSAGE_DELIMITER, from);
  const code = line !== undefined && from > 0 && to > from ? line.slice(from, to) : undefined;
  return code;
}

/**
 * 抽首条码行的成因串（`]:` 之后的文本）。0.3.0 没有独立明细块，占锁方信息全在这一段里。
 * 没有码行、或码行上没有分隔符时交回**空串**——调用方（classifyConcurrentFailure）只在
 * 码已命中的前提下读它，空串即「成因缺失」；要区分「没有码行」用 {@link zgErrorCode}。
 */
export function zgErrorMessage(stderr: string): string {
  const line = stderr.split("\n").find((candidate) => CODE_LINE_PREFIX.test(candidate)) ?? "";
  const at = line.indexOf(MESSAGE_DELIMITER);
  const message = at === -1 ? "" : line.slice(at + MESSAGE_DELIMITER.length).trim();
  return message;
}

/**
 * 识别本插件策略关心的失败；不关心的失败（或输出形状不认识）一律返回 null。
 *
 * `rebuild` 只在占锁方自报重建时为真：等待策略据此决定要不要排队。把「别人占锁」也
 * 当成重建去等，会在永远不会被本插件放开的锁上无界挂起。0.3.0 的成因串里没有占锁方
 * 进程号（0.2.2 Details 块的 ownerPid），故该字段不再存在。
 */
export function classifyConcurrentFailure(stderr: string): ConcurrentZgFailure | null {
  const code = zgErrorCode(stderr);
  if (code === LOCK_BUSY_CODE) {
    // 码已命中 ⇒ 码行必在 ⇒ 成因串非 undefined（契约见 zgErrorMessage），空串即成因缺失。
    const message = zgErrorMessage(stderr);
    const ownerOperation = OPERATION_IN_MESSAGE.exec(message)?.groups?.["op"];
    return {
      kind: "lock-busy",
      ownerOperation,
      lockPath: LOCK_IN_MESSAGE.exec(message)?.groups?.["lock"],
      rebuild: ownerOperation === REBUILD_OPERATION,
    };
  }
  if (code === PERMISSION_DENIED_CODE) {
    return { kind: "permission-denied" };
  }
  return null;
}
