// lib/zg-errors.ts —— zg 结构化失败的**识别层**：把子进程输出里的错误码与明细抽成
// 可判定的事实，供错误文案与「要不要等锁」两条路径共用。
//
// 为什么要单独一层：失败文案只回一句人话，模型据此无法区分「本插件正在重建、等一会就好」
// 与「别的进程占着锁、我该另想办法」。等待策略必须拿到**结构化**结论，文案侧只需要人话，
// 两边同源于此，不得各自正则一遍。
//
// zg 的失败输出形状（实测）：
//   Error: <标题>
//   Code: <错误码>
//   Details:
//     <键>: <值>
//     ...
// 明细键随错误码而变，故这里只抽「认得出的那几个」，认不出的键不猜、不透传。

/** zg 会给出的、与并发相关的两类错误码。 */
export const LOCK_BUSY_CODE = "ZVEC_GREP.ENGINE.LOCK.BUSY";
export const DAEMON_LEASE_CODE = "ZVEC_GREP.ENGINE.DAEMON_LEASE_ACTIVE";

/** 索引重建与其它占用者分开：等与不等是两回事。 */
export const REBUILD_OPERATION = "index.rebuild";

/** 明细块的表头行（`Details:`）。 */
const DETAILS_HEADER = /^\s*Details:\s*$/u;

export interface LockBusyFailure {
  kind: "lock-busy";
  /** 占锁方自报的操作名；老版本或明细缺失时为 undefined。 */
  ownerOperation: string | undefined;
  /** 占锁方进程号；明细缺失时为 undefined。 */
  ownerPid: string | undefined;
  /** 占的是哪把锁。 */
  lockPath: string | undefined;
  /** 占锁方是否是一次重建（重建可等，其它占用者不归本插件管）。 */
  readonly rebuild: boolean;
}

export interface DaemonLeaseFailure {
  kind: "daemon-lease";
  /** 持有租约的守护进程号。 */
  pid: string | undefined;
}

export type ConcurrentZgFailure = LockBusyFailure | DaemonLeaseFailure;

/**
 * zg 明细块的键值行。三个细节都来自「明细行是缩进的」这一实测形状：
 *   - 缩进**必填**（`\s+`）：明细块之后任何含冒号的非空行（第二个错误块的 `Error:` /
 *     `Code:`、尾注 `Hint:`）都不该被当成明细键收进表，与已知键同名时会污染判断；
 *   - 键字符集放宽到字母开头 + `[\w-]`：上游若改用 `owner_operation` 这类拼写，行至少
 *     还能被认出来（值是否被消费由查表侧决定），不至于整块收集在此中断；
 *   - 值必须以非空白开头：把只含空白的行当成有效值没有意义。
 */
const DETAIL_LINE = /^\s+(?<key>[A-Za-z][\w-]*):\s*(?<value>\S.*)$/u;

/** 错误码行的**定位**形状（只认行首，不核内容）。 */
const CODE_LINE_PREFIX = /^\s*Code:/u;

/** 错误码行的**取值**形状：`Code:` 之后是单一 token。 */
const CODE_LINE = /^\s*Code:\s*(?<code>\S+)\s*$/u;

/**
 * 抽错误码。没有该行就不是 zg 的结构化失败（旁路返回 null，交给通用失败文案）。
 * 先定位第一条 `Code:` 行、再核它的内容是否为单一 token：一次失败只应有一个码，
 * 首处写成 `Code: XXX (detail)` 说明输出形状已变——宁可不判，也不许顺延到后文
 * 捞一个可能属于别的错误块的码回来。
 */
export function zgErrorCode(stderr: string): string | undefined {
  const firstCodeLine = stderr.split("\n").find((line) => CODE_LINE_PREFIX.test(line));
  return firstCodeLine === undefined ? undefined : CODE_LINE.exec(firstCodeLine)?.groups?.["code"];
}

/**
 * 明细块的键值表。`Details:` 之后的缩进行才是明细，标题与错误码行不参与。
 * 重复键取首次出现（zg 不会重复输出同一个键，重复即形状异常，不覆盖）。
 * 明细块遇到非键值行即终止：其后多半是尾部截断的散文，继续收只会捡到假键值。
 */
function zgErrorDetails(stderr: string): Map<string, string> {
  const details = new Map<string, string>();
  const lines = stderr.split("\n");
  const start = lines.findIndex((line) => DETAILS_HEADER.test(line));
  if (start === -1) {
    return details;
  }
  for (const line of lines.slice(start + 1)) {
    const matched = DETAIL_LINE.exec(line);
    const key = matched?.groups?.["key"];
    const value = matched?.groups?.["value"]?.trimEnd();
    if (key !== undefined && value !== undefined) {
      if (!details.has(key)) {
        details.set(key, value);
      }
    } else if (line.trim().length > 0) {
      break;
    }
  }
  return details;
}

/**
 * 识别并发类失败；不是并发失败（或输出形状不认识）一律返回 null。
 *
 * `rebuild` 只在占锁方自报重建时为真：等待策略据此决定要不要排队。把「别人占锁」也
 * 当成重建去等，会在永远不会被本插件放开的锁上无界挂起。
 */
export function classifyConcurrentFailure(stderr: string): ConcurrentZgFailure | null {
  const code = zgErrorCode(stderr);
  if (code === undefined) {
    return null;
  }
  const details = zgErrorDetails(stderr);
  const ownerOperation = details.get("ownerOperation");
  if (code === LOCK_BUSY_CODE) {
    return {
      kind: "lock-busy",
      ownerOperation,
      ownerPid: details.get("ownerPid"),
      lockPath: details.get("lock"),
      rebuild: ownerOperation === REBUILD_OPERATION,
    };
  }
  if (code === DAEMON_LEASE_CODE) {
    return { kind: "daemon-lease", pid: details.get("pid") };
  }
  return null;
}
