// lib/routing.ts —— systemPrompt 硬规则段 + tools.guard 安全兜底谓词 +
// search-first 门禁（工作区已建 zg 索引时，grep/rg 前必须先成功 zg_search；
// 每次 zg_search 只解锁 N 次 grep/rg 配额、M 分钟内有效，用尽/过期再拦）。
// 纯数据/纯函数，可独立单测。规则文本移植自 zg 官方 searchRoutingRules
// （src/mcp/tools.ts），并按 dsh 的原生工具名（grep/glob/read）改写。
// 门禁不直接触盘、不看时钟、不持状态：indexProbe / now / lookupUnlock /
// consumeGrep 由宿主注入（host.ts 用 existsSync + Date.now + 会话解锁表实现）。
// 拒绝理由与规则段的文案双语：消息表（lib/messages.ts 的一份）由调用点注入，
// 规则段本身即 messages.routingText（本文件不再有文案常量）。
// 判据不住在本文件：命令文本面 / 目标路径面 / 解锁额度面三件纯判定住在
// lib/search-predicates.ts，本文件只做门禁的编排（向上找索引根、扣额度、拼拦截文案）。
// 剩下的跨模块依赖只有 lib/cli.ts 的 assertAbsoluteRoot——guard 与 execute
// 必须用同一套 root 判据，否则「guard 放行、execute 抛错」会把同一件事说两遍。

import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { assertAbsoluteRoot } from "./cli.ts";
import { fill } from "./messages.ts";
import type { ZvecGrepMessages } from "./messages.ts";
import {
  normalizeRoot,
  isGrepRgCommand,
  pathInsideRoot,
  hasExternalTarget,
  unlockActive,
} from "./search-predicates.ts";
import type { SearchUnlock } from "./search-predicates.ts";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";

/** 紧跟 TOOL_GREP(1500) 之后、TOOL_JOBS(1600) 之前。 */
export const ROUTING_ORDER = 1550;
export const ROUTING_NAME = "zvec-grep-routing";

/**
 * 本包注册的 zg_* 工具名。不外露：集合只在本文件被消费（下面两位），真正的登记发生在
 * host.ts 的 registerTool，注册名由 test/host.test.ts 从 ctx 的注册轨迹上钉——把这份
 * 常量再 export 给测试，等于让 guard 侧的名单自己给自己作证。
 */
const ZG_TOOLS = ["zg_search", "zg_index", "zg_status"] as const;
type ZgToolName = (typeof ZG_TOOLS)[number];

/**
 * `ZG_TOOLS` 的集合视图 + 窄化判据。
 *
 * 为什么要它：`zgGuard` 原本写的是 `(ZG_TOOLS as readonly string[]).includes(name)`，
 * 判定通过后 `name` 仍是 `string` —— 于是下游 `name === "zg_index"` 这类比较与
 * `ZG_TOOLS` 之间**没有任何编译期绑定**。工具改名或这里少打一个字符，比较就静默
 * 永不相等，"zg_index 必须 confirm=true" 这道闸会无声失效（不报错、测试也照样绿）。
 * 窄化成 `ZgToolName` 之后，取值集合只由 `ZG_TOOLS` 一处决定，写错名字当场编译不过。
 *
 * 判据本身不收 `as`：集合按 `string` 建，`has` 的入参就是 `string`，无需说服编译器。
 */
const ZG_TOOL_NAMES: ReadonlySet<string> = new Set<string>(ZG_TOOLS);

/**
 * 运行时判定 + 类型窄化：`name` 是否是本包注册的 zg_* 工具。
 *
 * 也被 host.ts 的 pre-execute 确认闸用（只对 zg_* 发问，别家的工具不该被本插件拦）。
 * 判据仍只有 ZG_TOOLS 一处来源，故那边不再抄一份工具名单。
 */
export function isZgToolName(name: unknown): name is ZgToolName {
  return typeof name === "string" && ZG_TOOL_NAMES.has(name);
}

// ── 官方 ToolExecution 的本包读取面 ────────────────────────────────────────
//
// 键与值都经**索引访问**从官方声明链上取（agent → session → header → cwd，以及 name /
// arguments）：链上任一环改名或换形状，这里立即编译失败，而不是运行时静默读到 undefined。
// 不直接把参数类型写成官方 `ToolExecution`，有两个真实原因：
//   1. 官方 `agent?: Agent` 的 `Agent.session` 是 dsh-session 的 **Session 类**（`private log`
//      / `private surfaceManager` → TS 对带 private 成员的类按名义比较），结构替身造不出
//      真 Session；本包单测与宿主注入都只能按成员读，故这一位必须是结构投影。
//   2. 「必选 → 可选」这一层放宽是**运行时容错**，不是类型疏漏：`arguments` 官方本就是
//      `unknown`（模型产出的 JSON），`session.id` 的品牌串只是编译期标记
//      （`string & { [BRAND] }`，宿主从磁盘 header 复原的值不经校验），而无 agent 的执行体
//      （`agent?: Agent`）确实存在。放宽的部分由读点补偿：sessionHeaderCwd / sessionKeyOf
//      先 `const x: unknown = …` 再 typeof 收窄（与 shared/lib/tool-events.ts 的 usableCallId
//      同一口径），不用类型去说服运行时。

/** 官方 `ToolExecution.agent` 去掉可选后的 Agent（经 ToolExecution 取：本包未声明 dsh-agent 依赖）。 */
export type OfficialAgent = NonNullable<ToolExecution["agent"]>;

/** 官方 `Agent.session`（dsh-session 的 Session 类）——只取其成员类型，不做名义赋值。 */
export type OfficialSession = OfficialAgent["session"];

/** 会话面上本包真正读到的两位。值域比官方宽的地方都是**运行时容错**（见上），不是疏漏。 */
export type SessionFace = {
  /** 官方 `Session.id`（类型 `SessionId` = 编译期品牌串）。这里只借它的**键名**：品牌函数
   *  `SessionId(x)` 不改值，宿主从磁盘 header 复原出来的 id 不经任何校验，而本包的会话分片
   *  键对非字符串 id 有显式兜底（sessionKeyOf；test/routing.test.ts 钉着 `id: 42` 与 NaN）。
   *  官方把它改名/删掉时，下面那行 `Pick` 就是编译错误。 */
  readonly [Key in keyof Pick<OfficialSession, "id">]?: unknown;
} & {
  /** 官方 `Session.header: SessionHeader`（必选；无 store 底座时宿主也合成一份），其
   *  `cwd?: string` 是「会话创建工作目录」的唯一来源。整条 session → header → cwd 链由索引
   *  访问钉死；这里把 header 留可选，是因为 agent 无 session 的执行体真实存在。 */
  readonly header?: {
    readonly cwd?: OfficialSession["header"]["cwd"];
    /**
     * 官方 `SessionHeader.parentSession?`：「本会话从哪一个会话分叉而来」。子代理会话就是
     * 这样挂到主会话下面的，故它是「同一棵委派树」的权威依据。
     * 与 `cwd` 同一口径按 `unknown` 读：宿主从磁盘 header 复原的值不经任何校验，形状未必
     * 是那个品牌串；真要用时 `rootSessionKeyOf` 先 typeof 收窄，非字符串按「没有父」处理。
     */
    readonly parentSession?: unknown;
  };
};

/**
 * tools.guard 谓词（以及工具体，见 host.ts 的 ToolExec）读到的一次执行面。
 * 加宽理由与出处见文件头的「读取面」注释。
 */
export interface GuardExecution {
  /** 官方 `ToolExecution.name`（必选 string）；可缺 = 替身/未构造完整的执行体。 */
  readonly name?: ToolExecution["name"] | undefined;
  /** 官方 `unknown`：模型产出的已解析参数，逐字段取值仍要 isRecord 收窄。 */
  readonly arguments?: ToolExecution["arguments"];
  /** 官方 `agent?: Agent`；`| null` 保留既有容错（agent 交回 null 时按无会话工作区处理）。 */
  readonly agent?: { readonly session?: SessionFace } | null;
}

/** 会话工作区（官方 Agent.session.header.cwd；值按 unknown 读，理由见 SessionFace）。 */
function sessionHeaderCwd(execution: GuardExecution): string | undefined {
  const raw: unknown = execution.agent?.session?.header?.cwd;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * root 判据（与 execute 的 assertAbsoluteRoot 完全同源）：合法返回 undefined；
 * 非法时返回可直接给模型的原因。
 */
function rootProblem(
  name: ZgToolName,
  root: unknown,
  messages: ZvecGrepMessages,
): string | undefined {
  let problem: string | undefined;
  try {
    assertAbsoluteRoot(root, messages);
  } catch (error) {
    problem = fill(messages.guardRootRejected, { name, reason: errorText(error) });
  }
  return problem;
}

/** 单个 zg_* 调用的拒绝原因（confirm / root 两道，见 zgGuard 的注释）。 */
function zgToolProblem(
  name: ZgToolName,
  args: Record<string, unknown>,
  execution: GuardExecution,
  messages: ZvecGrepMessages,
): string | undefined {
  const { root } = args;
  let problem: string | undefined;
  if (name === "zg_index" && args["confirm"] !== true) {
    problem = messages.guardIndexConfirmRequired;
  } else if (root === undefined || root === null || root === "") {
    // root 缺失但 execution.agent 提供会话 cwd → 放行（execute 内 resolveRoot 兜底）。
    problem =
      sessionHeaderCwd(execution) === undefined
        ? fill(messages.guardAbsoluteRootRequired, { name })
        : undefined;
  } else {
    problem = rootProblem(name, root, messages);
  }
  return problem;
}

/**
 * 安全兜底 guard：只拦截 zg_* 工具，其它工具一律放行（返回 undefined）。
 * - zg_index 无 confirm=true → 拒绝（防静默建/删索引）。
 * - 所有 zg_* 无 root 且无会话工作区可回退 → 拒绝（快速失败，比 shell 报错更清晰）。
 * - root 非法（相对路径 / NUL / 越界 `..` / 文件系统根）→ 拒绝，判据与 execute 同源。
 * - root 缺失但 execution.agent 提供会话 cwd → 放行（execute 内 resolveRoot 兜底）。
 * @param execution - tools.guard 收到的执行体。
 * @param messages - 拒绝理由的文案表（宿主按语言注入）。
 * @returns 拒绝理由；undefined = 放行。
 */
export function zgGuard(execution: GuardExecution, messages: ZvecGrepMessages): string | undefined {
  const { name } = execution;
  const args = isRecord(execution.arguments) ? execution.arguments : {};
  let reason: string | undefined;
  if (isZgToolName(name)) {
    reason = zgToolProblem(name, args, execution, messages);
  }
  return reason;
}

// ── search-first 门禁：工作区已建 zg 索引时，grep/rg 前必须先成功 zg_search ──

/** zg 索引库目录名（zg index 的落盘位置：<root>/.zvec-grep/）。 */
export const INDEX_DIR_NAME = ".zvec-grep";

/**
 * 工作区索引的判别文件名（上游 `@zvec/zvec` 的 `WORKSPACE_MANIFEST_FILE`，同名同值）：
 * 写在 `<root>/.zvec-grep/manifest.json`。**只判目录名不足以认出索引**——
 * `.zvec-grep` 这个名字同时被 zg 自己的全局 home 征用
 * （`ZVEC_GREP_HOME ?? ~/.zvec-grep`，装的是 config.json / locks / models），
 * 于是一个从没建过索引、只是祖先目录撞名的普通工作区也会被当成「已建索引」。
 */
export const WORKSPACE_MANIFEST_FILE = "manifest.json";

/**
 * 从 startDir 向上找含 zg 索引库的最近祖先（含自身），返回该索引根。
 * 会话工作区可能是索引根的子目录（如索引在仓库根、会话开在子包）——不向上走
 * 会漏拦。probe 注入（宿主用 existsSync），本函数保持纯函数可单测。
 */
export function findIndexRoot(
  startDir: string,
  probe: (dir: string) => boolean,
  maxDepth = 8,
): string | undefined {
  let dir = normalizeRoot(startDir);
  let found: string | undefined;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (probe(dir)) {
      found = dir;
      break;
    }
    if (dir === "/") {
      break;
    }
    const cut = dir.lastIndexOf("/");
    dir = cut <= 0 ? "/" : dir.slice(0, cut);
  }
  return found;
}

/** 无会话身份时的共享桶名（沿用旧常量，不另起一个同义值）。 */
export const SHARED_SESSION_KEY = "__anonymous__";

/** 会话状态分片键：session.id（字符串/数字）→ 稳定键；无 id 归入共享桶。 */
export function sessionKeyOf(execution: GuardExecution | undefined): string {
  // 官方是 `Session.id: SessionId`（品牌串），值域按 unknown 读：品牌只是编译期标记，
  // 数字 / NaN 这些非品牌形状仍归共享桶而不是抛错（见 SessionFace 的容错说明）。
  const id: unknown = execution?.agent?.session?.id;
  if (typeof id === "string" && id.length > 0) {
    return id;
  }
  if (typeof id === "number" && Number.isSafeInteger(id)) {
    return String(id);
  }
  return SHARED_SESSION_KEY;
}

/**
 * 会话沿父链上溯时最多走多少跳。官方把「委派深度」持久化在 header 上，正是为了让递归预算
 * 跨重启存活；这里自己也要一道上限，因为链是运行时读回来的、可能不完整（中间某个会话已经
 * 落定不再 live）。到顶就停，退化成「当前这一跳」——宁可共享范围偏小，也不把配额并到一个
 * 说不清是谁的桶里。
 */
export const MAX_PARENT_WALK = 32;

/**
 * 会话的**根**标识：沿 `header.parentSession` 一路上溯到最顶层那一跳。
 *
 * 为什么不用自己的 id 分片：子代理各自持有独立会话，于是「主代理搜过 → 放行 3 次 grep/rg」
 * 变成「主代理那 3 次」，子代理一次都没有——门禁想建立的「语义检索优先」在多代理下直接失效。
 * 按根分片后，同一棵委派树共享同一份额度，语义检索的证据也随之共享。
 *
 * 降级是三级的，都不抛错：
 *   - 自身即顶层（没有 parentSession）→ 用自己的 id。
 *   - 上溯到某一跳时查不到它的父（会话已落定、或 `lookup` 根本不存在——宿主没装会话存储）
 *     → 停在**已知的最后一跳**，不猜。
 *   - 链上出现环 → 停在首次重复前的位置。
 */
export function rootSessionKeyOf(
  execution: GuardExecution | undefined,
  lookup?: (id: string) => { parentSession?: unknown } | undefined,
): string {
  const own = sessionKeyOf(execution);
  if (own === SHARED_SESSION_KEY) {
    // 连自己的 id 都没有：无从谈父链，直接落共享桶（与旧行为同）。
    return own;
  }
  const parent: unknown = execution?.agent?.session?.header?.parentSession;
  if (typeof parent !== "string" || parent.length === 0) {
    return own;
  }
  // 已见到过的 id：既防环，也天然给出跳数上限。
  const seen = new Set<string>([own, parent]);
  let cursor = parent;
  for (let hop = 0; hop < MAX_PARENT_WALK; hop += 1) {
    if (lookup === undefined) {
      // 宿主没有会话查询面：无从再往上，退回已知的最后一跳。
      return cursor;
    }
    const next: unknown = lookup(cursor)?.parentSession;
    if (typeof next !== "string" || next.length === 0 || seen.has(next)) {
      return cursor;
    }
    seen.add(next);
    cursor = next;
  }
  return cursor;
}

/** 内置默认阈值（可在设置里覆盖：grepBudgetPerSearch / unlockWindowMin）。 */
export const DEFAULT_GREP_BUDGET = 3;
export const DEFAULT_UNLOCK_WINDOW_MIN = 10;

export interface SearchFirstDeps {
  enabled: boolean;
  /** 目录是否存在 zg 索引库（宿主注入 existsSync(dir + '/.zvec-grep')）。 */
  indexProbe: (dir: string) => boolean;
  /** 时钟注入（Date.now），单测可控过期。 */
  now: () => number;
  /** 每次成功 zg_search 发放的 grep/rg 次数（仅用于拒绝消息文案）。 */
  grepBudget: number;
  /** 解锁时效（分钟，仅用于拒绝消息文案）。 */
  windowMin: number;
  /** 查本会话在某索引根上的当前解锁额度（宿主注入会话解锁表）。 */
  lookupUnlock: (indexRoot: string) => SearchUnlock | undefined;
  /**
   * 放行一条 grep/rg 时扣减额度（宿主注入，副作用：grepsLeft -= 1）。
   * 直接拿 lookupUnlock 已命中的对象：宿主侧不必按索引根二次查表，也就没有
   * 「两次查表结果不一致」这种伪分支要防。
   */
  consumeGrep: (unlock: SearchUnlock) => void;
  /**
   * 该索引根当前是否有一次活跃重建（宿主注入，读统一状态源）。
   * 为真时门禁放行根内检索：重建持有写锁期间语义检索必然失败，若门禁仍要求
   * 「先成功检索」，模型会被两个方向同时堵死——检索报错、grep/rg 也被拦。
   * 只放宽配额这一道，索引根范围与外部路径判定仍由本门禁自己把关。
   */
  rebuildBypass?: (indexRoot: string) => boolean;
}

/**
 * search-first 门禁（硬约束）：拦截对象为
 * - bash/pwsh：命令串里出现 grep/rg 检索调用（isGrepRgCommand），且目标未被
 *   hasExternalTarget 判定为索引根之外；
 * - 原生 grep 工具：检索目标位于会话工作区内（path 出界不属工作区检索，放行）。
 * 会话工作区（含祖先）存在 zg 索引且当前无可用解锁额度（从未 zg_search、配额
 * 用尽或已过期）→ 拒绝并给出可行动出路。解锁额度按「会话 × 索引根」计，
 * 每次成功的 zg_search 重置为 N 次、M 分钟有效——保证语义检索频率与 grep
 * 用量成正比，而不是一次放行终身豁免。
 * 已知近似：bash 自由文本无法可靠区分模式与相对路径 token，hasExternalTarget
 * 只认明确的路径形状，`../` 形态的模式词可能被误判为外部目标而放行（漏拦，
 * 安全方向）；混合目标（如 `rg foo /repo/src /tmp/x`）整体放行。
 */

/**
 * 索引根已定后的门禁裁决：无索引根 / 检索索引根之外 / 有可扣额度 → 放行
 * （undefined）；否则返回拦截文案。放行会触发 consumeGrep 副作用。
 */
function buildSearchFirstReason(
  cwd: string,
  command: string | undefined,
  deps: SearchFirstDeps,
  messages: ZvecGrepMessages,
): string | undefined {
  const indexRoot = findIndexRoot(cwd, deps.indexProbe);
  let reason: string | undefined;
  const inScope =
    indexRoot !== undefined &&
    (command === undefined || !hasExternalTarget(indexRoot, command, messages));
  if (inScope) {
    // 重建期放行先于配额判定：那条重建占着这棵树的写锁，此刻无论有没有配额都该放行，
    // 因为语义检索根本读不到索引。且这一放行**不消耗**既有配额——重建造成的等待不该
    // 记在用户的检索额度上。
    const rebuilding = deps.rebuildBypass?.(indexRoot) === true;
    const unlock = rebuilding ? undefined : deps.lookupUnlock(indexRoot);
    if (rebuilding) {
      // 这一支**必须是一个空 if**：把 unlock 置空并不会「不扣额度」，而是让它落进下面的
      // else —— 那里 `unlock === undefined` 会被译成「从未检索过」并**拒绝**。真正让这次调用
      // 放行的就是这个空分支本身。写成注释说明，是为了不让下一个人把它当冗余删掉。
    } else if (unlock !== undefined && unlockActive(unlock, deps.now())) {
      // 有解锁额度：放行并把这份记录扣减一次（同一对象，无需二次查表）。
      deps.consumeGrep(unlock);
    } else {
      let state: string;
      if (unlock === undefined) {
        state = messages.gateNeverSearched;
      } else if (unlock.grepsLeft <= 0) {
        state = messages.gateQuotaExhausted;
      } else {
        state = messages.gateUnlockExpired;
      }
      reason = fill(messages.gateReason, {
        state,
        indexRoot,
        indexDir: INDEX_DIR_NAME,
        budget: deps.grepBudget,
        windowMin: deps.windowMin,
      });
    }
  }
  return reason;
}

/**
 * shell 面（bash/pwsh）的一次检索裁决：命令串里真出现 grep/rg 才交给门禁，
 * 否则放行。`command` 非字符串（模型产出的是 unknown）按空串处理，与旧实现同形。
 */
function shellSearchProblem(
  args: Record<string, unknown>,
  cwd: string,
  deps: SearchFirstDeps,
  messages: ZvecGrepMessages,
): string | undefined {
  const commandRaw = args["command"];
  const command = typeof commandRaw === "string" ? commandRaw : "";
  return isGrepRgCommand(command)
    ? buildSearchFirstReason(cwd, command, deps, messages)
    : undefined;
}

/**
 * 原生 grep 工具面的一次检索裁决：`path` 出界 = 不是本工作区的检索 → 放行
 * （与 pathInsideRoot 的「判范围不判合法性」同侧）。无 path 参数按搜整个工作区。
 */
function nativeGrepProblem(
  args: Record<string, unknown>,
  cwd: string,
  deps: SearchFirstDeps,
  messages: ZvecGrepMessages,
): string | undefined {
  const target = typeof args["path"] === "string" ? args["path"] : undefined;
  return pathInsideRoot(target, cwd, messages)
    ? buildSearchFirstReason(cwd, undefined, deps, messages)
    : undefined;
}

/**
 * search-first 门禁入口。
 * @param execution - tools.guard 收到的执行体。
 * @param deps - 判据依赖（索引探测/时钟/额度表，全部宿主注入）。
 * @param messages - 拦截文案的字典（宿主按语言取一份传进来）。
 * @returns 拦截理由；undefined = 放行。
 */
export function searchFirstGuard(
  execution: GuardExecution,
  deps: SearchFirstDeps,
  messages: ZvecGrepMessages,
): string | undefined {
  const { name } = execution;
  const args = isRecord(execution.arguments) ? execution.arguments : {};
  const cwd = sessionHeaderCwd(execution);
  let reason: string | undefined;
  // 门禁关着、或执行体没有会话工作区（无从判「索引根之内」）→ 两个拦截面都无从谈起。
  if (deps.enabled && cwd !== undefined) {
    if (name === "bash" || name === "pwsh") {
      reason = shellSearchProblem(args, cwd, deps, messages);
    } else if (name === "grep") {
      reason = nativeGrepProblem(args, cwd, deps, messages);
    }
  }
  return reason;
}
