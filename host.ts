// zvec-grep（zg）dsh 插件 Host 半。
//
// 职责：
//   1. 带一份导出 Config schema（可编辑的 volatile 六项 defaultEmbedding / defaultLimit /
//      hfEndpoint / enforceSearchFirst / grepBudgetPerSearch / unlockWindowMin，加四个
//      非 volatile 部署值 searchTimeoutMs / statusTimeoutMs / indexTimeoutMs / stdoutMaxBytes）：
//      0.1.7 起设置命名空间
//      是**隐式**的——宿主按 profile 条目 id（`zvec-grep`，见 cordis.patch.yml）把标了
//      `.volatile()` 的字段投影成设置表单，插件侧不再注册。
//   2. 注册 3 个模型工具：zg_search / zg_index / zg_status（经 ctx.shell 调 zg CLI，--mode direct）。
//   3. 注册 systemPrompt 硬规则段（routing，order 1550）+ tools.guard 安全兜底
//      + search-first 门禁（工作区已建索引时 grep/rg 前必须先 zg_search，
//      每次成功 zg_search 发放配额：grepBudgetPerSearch 次 / unlockWindowMin 分钟）。
//   4. 为设置卡片的「工作区重建」按钮提供 webServer 端点（后台进程 + 轮询状态）。
//
// 安全要点：
//   - 所有用户可控字符串经 lib/cli.ts 的 shq() 单引号转义；root 走 workdir 字段
//     （query）或转义后的位置参数（index/status），绝不裸拼进命令。
//   - zg_index 被 guard 强制要求 confirm=true，防止模型静默建/删索引。
//   - 工具入参在 lib/cli.ts 里逐项严格取值（harness 不校验 parameters，见该文件头）。
//   - 「工作区重建」是**动作端点**：webServer 可被配成绑 0.0.0.0，故除 sec-fetch-site
//     同源校验外还要求每次 apply 生成的 CSRF 头，且 root 必须落在「本 daemon 实际观测到
//     的会话工作区」白名单内——否则任意绝对路径都能被拿去 `zg index --rebuild`。
//
// 运行方式：dsh 的 cordis Loader 直接 import 本 .ts（Node ≥22.18 类型剥离）。
// 运行时值导入只有 schemastery，且 0.1.7 起必须是**宿主 fork** @deepseek-ai/schemastery：
// 只有它的 resolve 会把标了 .volatile() 的字段包成 Volatile 引用（公共 schemastery@3.18.0
// 既没有 .volatile()，解析出来的也仍是普通值，设置卡写进去的值永远读不到）。
// @deepseek-ai/cordis 一律 type-only（运行时由 ctx 注入）。@deepseek-ai/dsh-tools 同样
// type-only，但**类型面全面绑定它**：注册与 guard 两位直接从官方服务类 `ToolRuntime` 上
// `Pick`（installed dsh-tools/lib/types/index.d.ts:619/:638），于是注册的工具字面量由官方
// `ToolDefinition` 检查、guard 谓词由官方 `ToolGuard` 检查——两者都随官方成员走，本文件不
// 重述它们的签名；工具体收到的执行面走官方 ToolRunContext（详见下面 ToolsService / ToolExec
// 与 lib/routing.ts 的读取面）。
// 五个宿主服务面（@deepseek-ai/dsh-shell / dsh-host-webserver / dsh-system-prompt /
// cordis-plugin-timer / dsh-jobs）同样 type-only + 全面绑定官方声明：Shell 的请求/规格/句柄/结果
// 与沙箱事实直接用它交出的类型名，WebServer / SystemPrompt / TimerService / JobRegistry 是带
// private 字段的 cordis Service 类（TS 名义比较，结构替身与测试桩都满足不了），故按 ToolsService
// 的既有口径只取**方法面投影** Pick<官方类, 用到的方法>——投影不重述任何签名，参数与返回
// 类型全部由官方成员交出（含 WebRoute.kind 的 WebRouteKind 字面量联合，见下面注释）。
// dsh-jobs 还带一条 declare module 增强（本包的作业 kind），见 import 处。
// 支持行级 config（导出 Config schema，cordis 经 Standard Schema 校验并填 `.default()`
// 后传入 apply，volatile 字段以引用形态交进来）；defineTool 不引入——运行时值
// 导入违反上述解耦原则，且文件形态插件无 bare-import 解析路径，required
// 校验已在 define() 内以零依赖方式等效实现。

import Schema from "@deepseek-ai/schemastery";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context, Fiber, Volatile } from "@deepseek-ai/cordis";
// 官方工具契约（@deepseek-ai/dsh-tools 根模块 = lib/types/index.d.ts）：注册的工具定义、
// guard 谓词、工具体收到的执行面、输出 schema 一律绑它，不再本地镜像。
// type-only：运行时由 ctx 注入，且本包对 @deepseek-ai/* 的值导入会破坏 host.js 的自包含
// （dsh-tools 是 devDependency，产物里不能出现对它的运行时引用）。
import type {
  JsonSchemaNode,
  ToolDefinition,
  ToolRunContext,
  ToolRuntime,
} from "@deepseek-ai/dsh-tools";
import type { SettingsForms } from "@deepseek-ai/dsh-settings";
// 宿主服务面的官方声明（全部 type-only：运行时由 ctx 注入，值导入会破坏 host.js 自包含）。
// dsh-shell 的执行词表直接用它交出的类型名；WebServer / SystemPrompt / TimerService 是
// cordis Service 类（private/protected 字段 → 名义比较），只能经 Pick<> 取方法面投影。
import type {
  ShellExecution,
  ShellExecutor,
  ShellRunResult,
  ShellSandboxInfo,
} from "@deepseek-ai/dsh-shell";
import type { WebServer } from "@deepseek-ai/dsh-host-webserver";
// 官方后台作业注册表（ctx.jobs）的类型面（全部 type-only：那枚注册表由宿主注入，
// dsh-base 默认装载 dsh-jobs-local；值导入会破坏 host.js 的自包含）。
// JobRegistry 是 abstract Service（protected ctx → 名义比较），只能按本包既有口径取
// 方法面投影；其余是它交出的类型名，本文件不重述任何签名。
import type {
  JobId,
  JobOutputRead,
  JobSourceRead,
  JobOutputSource,
  JobRegistry,
  JobSpec,
  JobStatus,
  JobView,
} from "@deepseek-ai/dsh-jobs";
import type { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { TimerService } from "@deepseek-ai/cordis-plugin-timer";
// 共享 webServer 样板：sendJson/queryParam/guardBody（自家 isCrossOrigin 支在信任闸门
// 落地后不可达，已随那道闸门收敛）
// 与 session-rescue/lesson-loop/ocr-review 原来各自复制，现统一由 shared 提供。
import { sendJson, queryParam, guardBody } from "@jayyuen66/dsh-plugin-shared/lib/http";
// 信任闸门：三条路由 handler 的第一条语句。
import { guardTrust } from "@jayyuen66/dsh-plugin-shared/lib/trust";
import { DEFAULT_EMBEDDING, isLocalEmbedding } from "./lib/embedding-catalog.ts";
import {
  assertAbsoluteRoot,
  buildSearchCommand,
  buildIndexCommand,
  buildStatusCommand,
  resolveRoot,
  clampLimit,
  DEFAULT_LIMIT,
} from "./lib/cli.ts";
import type { SearchArgs, IndexArgs } from "./lib/cli.ts";
import {
  ROUTING_NAME,
  ROUTING_ORDER,
  zgGuard,
  searchFirstGuard,
  findIndexRoot,
  sessionKeyOf,
  DEFAULT_GREP_BUDGET,
  DEFAULT_UNLOCK_WINDOW_MIN,
  INDEX_DIR_NAME,
  WORKSPACE_MANIFEST_FILE,
} from "./lib/routing.ts";
import type { GuardExecution } from "./lib/routing.ts";
// 判据层（解锁额度的形状与 root 归一化）住在 lib/search-predicates.ts：宿主既按索引根建
// 解锁表的键，也持有额度记录，取的都是判据侧而不是门禁编排侧。
import { normalizeRoot } from "./lib/search-predicates.ts";
import type { SearchUnlock } from "./lib/search-predicates.ts";
import { MESSAGES, fill } from "./lib/messages.ts";
import type { ZvecGrepMessages } from "./lib/messages.ts";
// host 侧文案语言跟官方 locale 插件的偏好同源：读它拥有的 settings 命名空间（未注册即中文）。
import {
  LOCALE_SETTINGS_NAMESPACE,
  messagesFor,
  resolveLocalePreference,
} from "@jayyuen66/dsh-plugin-shared/lib/locale";
// 代理对安全的定长截断（前切面已交官方 output-retention，后切面仍在本仓；
// 语义与官方件的实测差异见 shared/lib/text.ts 头注释）：本包的切点
// 吃的是**仓库文件内容**（CJK 密度最高的那道流），裸 slice 会在切点留下孤立高/低代理，
// 而这三处的产物都进会话日志（失败消息 / 成功结果里的 stderr 注）。
import { truncateEnd, truncateStart } from "@jayyuen66/dsh-plugin-shared/lib/text";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
// 落定进程 → 官方作业结局的映射与 ocr-review 逐字同构，收在 shared（口径本身
// 抄的是宿主 bash 工具的 processOutcome，见该文件头）。
import { jobOutcomeOf } from "@jayyuen66/dsh-plugin-shared/lib/job-outcome";

// 官方给生产者的 kind 扩展点（installed dsh-jobs/lib/types/view.d.ts:26 的 JobKindMap，
// dsh-tool-pwsh / dsh-tool-workflow 同款写法）：kind 既是 id 命名空间也是 id 前缀。
// 位置在 import 块之后：declare module 是一条语句，夹在 import 中间会让后面每条 import
// 都违反 import/first（ESM 下 import 本就被提升，先于模块体执行，挪动不改运行时行为）。
declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    "zvec-grep-rebuild": "zvec-grep-rebuild";
  }
}

// 设置命名空间不再由本包声明：0.1.7 隐式注册取 profile 条目 id（`zvec-grep`，
// 见 cordis.patch.yml 的 `- id:`），与本包卡片用的 namespace 同一个串。
// 检索默认带 --refresh wait（官方故障排查页对"改动搜不到"的推荐解法）。
// wait 会在检索前同步刷新既有索引，大工作区可能重跑 embedding，故超时须明显
// 高于纯查询：120s 是原直连值，实测不足以覆盖 wait，抬到 5 分钟。
// 超时不是静默失败：runForeground 会抛「zg 执行超时」给模型，并提示缩小范围。
// 这四个是**部署可调值**（官方 config.md:78-92——部署间可能想配不同值的
// 都必须是配置字段），已进 Config schema（非 volatile，见下面四字段的注释）；此处
// 常量降级为 schema `.default()` 的**单一来源**，运行期消费点一律现读 config。
const SEARCH_TIMEOUT_MS = 5 * 60_000;
const STATUS_TIMEOUT_MS = 60_000;
// 前台 zg_index 经 ctx.shell.resolve → clampTimeout(request, cfg, maxTimeoutMs)，
// 宿主 bash-local 默认 maxTimeoutMs=600_000（10 分钟）——旧的 30 分钟请求会被静默 cap 到 10 分钟，
// 与重建卡片 kill timer（走 host.timer，不被 clamp）不一致，工具失败还误导模型"缩小范围"。
// 对齐宿主实际上限 10 分钟；如需更长，请同时调高宿主 bash-local 的 maxTimeoutMs（部署配置）。
const INDEX_TIMEOUT_MS = 10 * 60_000;
const STDOUT_MAX_BYTES = 400_000;
const REBUILD_PATH = "/_dsh/zvec-grep/rebuild";
const REBUILD_STATUS_PATH = "/_dsh/zvec-grep/rebuild-status";
/** 卡片取「可选工作区 + CSRF token」的引导端点（GET，只回本插件自己的数据）。 */
const REBUILD_ROOTS_PATH = "/_dsh/zvec-grep/rebuild-roots";
/** 动作端点的 CSRF 头名（值是每次 apply 重新生成的随机 token）。 */
const REBUILD_CSRF_HEADER = "x-zvec-grep-csrf";
/** rebuild 端点没有业务请求体，但必须把它读完（keep-alive 残留字节的协议正确性）。 */
const REBUILD_BODY_MAX_BYTES = 4096;
/** 工作区白名单容量：超过按插入序淘汰最早记录（常驻进程内存有界）。 */
const MAX_LEDGER_ROOTS = 64;
/** 成功执行里回显 stderr 的尾部长度（降级提示常就在这一行）。 */
const STDERR_NOTE_CHARS = 400;

// ── 宿主服务面（类型全绑官方声明；运行时由 ctx 注入，绝不值导入 @deepseek-ai/*）──

/** apply 收到的行级配置（组合包层/用户层行的 config: 经 cordis 按 Config schema
 *  校验、填过 `.default()` 后交进来）。0.1.7 起 volatile 字段是**引用**而不是快照：
 *  读当前值一律 `.get()`，设置卡改完下一次读即生效，不必重载插件。
 *  优先级由宿主侧完成：设置卡运行时值 > 行 config > schema 的 `.default()`。
 *  另有四个**非 volatile** 部署值（searchTimeoutMs / statusTimeoutMs / indexTimeoutMs /
 *  stdoutMaxBytes，见各字段注释）：装载期被填成普通值，不经 `.get()`，也不占设置卡
 *  （宿主 describe() 只投影 volatile 字段）——cordis.yml 的行 config 是它们唯一的
 *  改值入口（参照 ctx-observe 的 fallbackWindow 同款形态）。 */
export interface Config {
  /** volatile 引用的**值**可以是 undefined：官方 Volatile 的 d.ts 原文写着 get() 的返回
   *  「including undefined for an absent value」，而条目没被 volatile 投影 / 宿主退化时
   *  交回来的就是空引用。schema 的 `.default()` 只保证正常装载下不空，故这里把声明写宽，
   *  下面每个读取点的 `typeof`/`??` 兜底据此是**必要**分支而不是冗余守卫。 */
  defaultEmbedding: Volatile<string | undefined>;
  defaultLimit: Volatile<number | undefined>;
  hfEndpoint: Volatile<string | undefined>;
  enforceSearchFirst: Volatile<boolean | undefined>;
  grepBudgetPerSearch: Volatile<number | undefined>;
  unlockWindowMin: Volatile<number | undefined>;
  /** 前台 zg_search 的执行超时（ms；默认 5 分钟，覆盖 --refresh wait 的同步刷新）。
   *  非 volatile 部署值：普通值形态，不经 `.get()`、不进设置卡，行 config 可改。 */
  searchTimeoutMs: number;
  /** 前台 zg_status 的执行超时（ms；默认 60s）。同上：非 volatile 部署值。 */
  statusTimeoutMs: number;
  /** 前台 zg_index 的执行超时（ms；默认 10 分钟 = 宿主 bash-local 的 maxTimeoutMs 上限）
   *  与后台重建 kill 定时器的时长。同上：非 volatile 部署值。 */
  indexTimeoutMs: number;
  /** 前后台 zg 进程 stdout 的执行器缓冲上限（字节；默认 400k，超限截尾可落 spill）。
   *  同上：非 volatile 部署值。 */
  stdoutMaxBytes: number;
}

/**
 * dsh-shell 的唯一执行入口面（官方 ShellExecutor = abstract Service，protected ctx
 * → 名义比较，结构替身与本包测试桩都满足不了），故按 ToolsService 口径只取方法面投影：
 *  - `resolve(request: ShellExecRequest): ShellExecSpec` —— 本插件传的 command/workdir/
 *    timeoutMs/stdoutMaxBytes/signal/env 与 deadline 策略 `onExpiry: ShellExpiryPolicy`
 *   （bash-local resolve 缺省 'kill'，后台重建传 'none' 取无界）全由官方字面量联合约束；
 *  - `execute(spec: ShellExecSpec): Promise<ShellExecution>` —— 0.1.7 唯一的执行入口，
 *    前台 await handle.result()，后台直接留句柄。
 *  句柄/结果/沙箱事实的类型名（ShellExecution / ShellRunResult / ShellSandboxInfo /
 *  ShellProcessStatus）直接沿用官方导出，不再本地镜像：官方 CollectedOutput 的
 *  `{ text, truncated, spillPath? }`、ShellRunResult 的必填 `timedOut`/`aborted`
 *  （超时与取消互斥归因）、ShellSandboxInfo 的 mode/enforcement/runnerFailed 与
 *  ShellProcessRead 的消费式增量 `delta` + `lossy`（缓冲溢出**已丢过**字节，丢掉的
 *  增量永远不会再出现）语义都在官方 d.ts 里有原文。
 */
type ShellService = Pick<ShellExecutor, "resolve" | "execute">;

/**
 * 官方 ToolRuntime（installed `@deepseek-ai/dsh-tools/lib/types/index.d.ts:512`，cordis
 * Service 类 + 一整套 private 字段 → TS 名义比较，结构替身与本包测试桩都无法满足它）的
 * **方法面投影**：只 `Pick` 本包调的两位，签名一个字都不再重述——原文在 installed 同文件
 * `:619` `register(definition: ToolDefinition): () => void` 与 `:638`
 * `guard(guard: ToolGuard): () => void`（`Context.tools: ToolRuntime` 的增强在 `:34`）。
 * 于是注册字面量由官方 `ToolDefinition` 检查、guard 谓词由官方 `ToolGuard` 检查，且这两位
 * 从此跟着官方成员走：官方添一枚必填参数或换掉载荷类型，本文件当场是编译错误，而不是镜像
 * 继续编译通过、调用点静默拿到错形状（同 ocr-review 的 `ToolsService` 口径）。
 */
type ToolsService = Pick<ToolRuntime, "register" | "guard">;

/**
 * 官方 SystemPrompt（dsh-system-prompt，Service 类 + private 字段 → 名义比较）的方法面
 * 投影：本包只 `section()` 注册硬规则段。入参即官方 `PromptSection`（readonly
 * name/order/text，text 允许 `string | (ctx) => string`），返回值是官方承诺的
 * Cordis effect disposer——本包注册在自身 fiber 上，随 fiber 回收，故不接这个 disposer。
 */
type SystemPromptService = Pick<SystemPrompt, "section">;

/**
 * 官方 WebServer（dsh-host-webserver，Service 类 + 一整套 private 路由表字段 → 名义
 * 比较）的方法面投影：本包只 `register()`。路由字面量直接交官方 `WebRoute`，
 * 于是 `kind` 受官方 `WebRouteKind = 'exact' | 'prefix'` 字面量联合约束——旧镜像把它
 * 写成了 `string`（一处静默加宽，写错 kind 只能在运行时被路由表默默拒掉）。
 * disposer 语义也来自官方签名（`() => void`，重复 (kind, path) 抛错）。
 */
type WebServerService = Pick<WebServer, "register" | "host">;

/**
 * 官方 JobRegistry（@deepseek-ai/dsh-jobs，abstract Service → 名义比较）的方法面投影：
 * 本包用这七位。三条不是可选的：
 *  - `attachController`：官方件在「没有 controller 服务这个 owner」时**直接拒绝 start**
 *   （离线台架实测，见 plugins/docs/harness/f3-equiv/probe-jobs.mjs）。本包的作业是**未拥有**的（受有作业要
 *   dsh-agent 注册表，第 2 条实测），而未拥有作业只被 global 层服务；落哪一层由**访问方
 *   ctx 的作用域**决定（复核后补测：同一枚注册表，从未绑作用域的插件 ctx attach
 *   ⇒ global 层非空、未拥有 start 放行；改从 createScope 出来的作用域 ctx attach ⇒ 只建
 *   scoped 层、未拥有 start 仍被拒）。官方注释里那句"global 层放的是一台宿主自己的控制面"
 *   正是本包这一枚的归属；web 面上宿主的 `tool-jobs` 被移进了各 preset realm
 *   （packages/bundle/web-app/cordis.patch.yml 明写 `tool-jobs disabled: true`），
 *   所以在这台宿主上"从插件自己 attach"不是冗余，而是未拥有作业起得来的唯一原因。
 *  - `get` / `readAt`：卡片投影的两个读数（状态与非消费的输出窗）。
 *  - `list`：历史窗口要按 kind 在**整个注册表**里找本包的已落定记录（卸载后的残留记录不在
 *   本包的侧表里，只清侧表等于把环留在宿主内存里）。
 */
type JobsService = Pick<
  JobRegistry,
  "start" | "list" | "get" | "readAt" | "kill" | "remove" | "attachController"
>;

/**
 * 官方 `SettingsForms`（installed `@deepseek-ai/dsh-settings/lib/types/index.d.ts:62`，
 * `Service` 子类 + private `ownerContext/revisions/closed/scheduled/presentations` → 名义
 * 比较）的方法面投影：本包只用 `configure`（经注入子上下文挂页面策略）与 `describe`
 * （跨命名空间读官方 locale 偏好）。此前这里写的是**整个类**，那是一条对本包需求的过度
 * 声明——它宣称「宿主必须给我一枚完整的 settings 服务」，而 `HostCtx` 其余每个服务面都只
 * 点名自己用到的成员；投影不重述签名，入参与返回仍全部由官方成员交出。
 */
type SettingsFormsService = Pick<SettingsForms, "configure" | "describe">;

/** `ctx.inject(deps, callback)` 回调收到的子上下文（本包只用到 settings + effect）。 */
interface InjectedCtx {
  settings: SettingsFormsService;
  /** 官方效应面（`interface Context extends Pick<Fiber, 'effect'>`，installed
   *  `@deepseek-ai/cordis/lib/types/fiber.d.ts`，两条重载）——本地不再重述工厂签名。 */
  effect: Context["effect"];
}

/**
 * 工具体收到的执行面：官方 `ToolDefinition.execute` 的第二参是 `ToolRunContext`
 * （= ToolExecution + deferContext/concludeTurn）。本包只读它的 signal 与会话工作区，
 * 故执行成员用 Pick 绑官方必填的 `signal`（漏传 = zg 跑满超时也无法被用户打断；契约必填），
 * 其余沿用 lib/routing.ts 的 GuardExecution 加宽投影（agent/session 名义类与运行时容错的
 * 理由写在那儿）。guard 谓词收到的 `Readonly<ToolExecution>` 同样落在这一型上。
 */
type ToolExec = GuardExecution & Pick<ToolRunContext, "signal">;

/**
 * 官方 TimerService（@deepseek-ai/cordis-plugin-timer，Service 类 + private _schedule
 * → 名义比较）的方法面投影：本包只用 `timeout()` 给后台重建挂 kill 定时器。官方
 * `timeout` 是重载（`timeout(callback, delay): () => void` / `timeout(delay): Promise<void>`），
 * Pick<> 保留两枚重载，故两参调用拿到的仍是**取消函数** `() => void`；回调随插件
 * fiber 回收（dsh-shell 契约明确后台进程不应用 timeoutMs，超时只能自己兜）。
 * 本地投影改名 TimerFace：官方导出名 TimerService 已被上面的 import 占用。
 */
type TimerFace = Pick<TimerService, "timeout">;

interface HostCtx {
  settings: SettingsFormsService;
  shell: ShellService;
  tools: ToolsService;
  systemPrompt: SystemPromptService;
  timer: TimerFace;
  /** 隐式注册后本包不再持有 scope，只经注入子上下文挂页面策略（宿主 dsh-client-locale 同款）。 */
  inject: (deps: readonly string[], callback: (child: InjectedCtx) => void) => unknown;
  /** 本插件 fiber：`configure` 的 owner 必须显式传它（缺省是 settings 服务自己的 fiber）；
   *  类型就是官方 `SettingsForms.configure(presentation, owner?: Fiber)` 的那位 `Fiber`。 */
  fiber: Fiber;
  /** 服务读取面取官方 `Context["get"]`（installed `@deepseek-ai/cordis/lib/types/reflect.d.ts:14`
   *  `get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]`），
   *  本地不再重述一枚 `get`。本包只读 `webServer`，而它**是**官方声明进 `Context` 的成员
   *  （installed `@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts:15-18`），故走泛型臂拿到
   *  `undefined | WebServer`，不走那条 `get(name: string): any` 兜底（reflect.d.ts:17）。
   *  旧镜像多出的 `(name: string): unknown` 是「还会读别的名字」的占位，实际没有；删它不减防御。
   *  `undefined` 是官方语义（"or `undefined` when not (yet) provided"）：非 web profile 的宿主确实
   *  交不出服务，`registerRebuildEndpoints` 里那道 `!webServer` 闸照旧。返回整类而非本包投影不是
   *  加宽——投影留在**使用点**上（见那里的显式标注）。 */
  get: Context["get"];
}

/** 具名方法在位（typeof 函数）——只看 `typeof x === "object"` 会放过 null、
 *  也会放过「是个对象但没注册方法」的错注入。 */
function hasMethod(value: Record<string, unknown>, name: string, keys: string[]): boolean {
  const member = value[name];
  return isRecord(member) && keys.every((key) => typeof member[key] === "function");
}

/**
 * host 是否为本插件所需服务面：五个注入面都必须是**带相应方法的对象**，
 * 且 `get` 可调用。守卫失败即 apply 抛错（fail-fast），比运行到某次工具调用
 * 才 `undefined is not a function` 更早、更可诊断。
 *
 * settings 只探 `describe`：0.1.7 起那是本包唯一**直接调**的 settings 方法
 * （跨命名空间读 locale）。`configure` 经 `ctx.inject` 的子上下文才拿到，
 * `mutate` 本包 host 侧根本不用（写是卡片经 settingsScope 走 client 面）——
 * 探它们等于断言一条没有测试撑着的能力。
 */
function isZvecGrepHost(value: unknown): value is Context & HostCtx {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasMethod(value, "settings", ["describe"]) &&
    hasMethod(value, "shell", ["resolve", "execute"]) &&
    hasMethod(value, "tools", ["register", "guard"]) &&
    hasMethod(value, "systemPrompt", ["section"]) &&
    hasMethod(value, "timer", ["timeout"]) &&
    typeof value["get"] === "function"
  );
}

/** 当前会话工作区（root 缺省回退源）；非字符串视为缺（读取面见 lib/routing.ts 的 SessionFace）。 */
function sessionHeaderCwd(exec: ToolExec): string | undefined {
  const raw: unknown = exec.agent?.session?.header?.cwd;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

// ── 工具输出：纯文本 ────────────────────────────────────────────────────────

/**
 * JSON.stringify 在本包**拥有的声明**上把返回宽成 `string | undefined`：lib 的签名恒为
 * `string`，但 ECMA-262 规定入参是 undefined / 函数 / 符号时它返回 undefined（下面
 * textBlock 的用例就直喂 undefined）。宽化只能落在这里——调用点里 `JSON.stringify(...) ?? x`
 * 会被 TS 的收窄按声明面判成冗余守卫，而删掉那道具象兜底会把 `{ text: undefined }` 交给官方。
 */
function stringifyJson(value: unknown): string | undefined {
  return JSON.stringify(value, null, 2);
}

function textBlock(value: unknown): { type: "text"; text: string }[] {
  // Record 解构读字面量键（绕开 dot-notation 与索引签名点访问的互斥）。
  const { text: textValue } = isRecord(value) ? value : {};
  if (typeof textValue === "string") {
    return [{ type: "text", text: textValue }];
  }
  // 官方要求 render 全性、must not throw（@deepseek-ai/dsh-tools 的 ToolOutputDefinition.render，
  // 返回 ContentBlock[]；这里的 { type: "text", text } 正是官方 TextBlock 形状，靠注册面交出
  // 的 ContentBlock[] 检查，不再本地镜像）。官方把入参记为 JsonValue，但那是类型面的承诺、
  // 不是对跨边界值的校验：JSON.stringify 会在循环引用/BigInt 上抛错（单测直接喂这两种），
  // 故降级为 String(value)，再不行给占位。
  let text: string;
  try {
    text = stringifyJson(value) ?? String(value);
  } catch {
    try {
      text = String(value);
    } catch {
      text = "[unrenderable value]";
    }
  }
  return [{ type: "text", text }];
}

// 官方 ToolOutputDefinition.schema 收的是 dsh-tools 的受支持 JSON Schema 子集
// （JsonSchemaNode：`type` 是字面量联合）。标注它才有收窄：不标注时 `type: "object"`
// 会被推成 string 而满足不了官方类型，漂移就只在运行时暴露。
const TEXT_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  properties: { text: { type: "string" } },
};

// ── shell 执行与错误映射 ────────────────────────────────────────────────────

/** 沙箱事实的公共后缀（把 mode/enforcement 一并交代清楚，避免只说「被拒」）。 */
function sandboxFacts(info: ShellSandboxInfo, messages: ZvecGrepMessages): string {
  const enforcement =
    info.enforcement === undefined
      ? ""
      : fill(messages.sandboxEnforcement, { value: info.enforcement });
  return fill(messages.sandboxFacts, { mode: info.mode, enforcement });
}

/**
 * 沙箱侧的**硬**失败：命令根本没跑起来。
 * runnerFailed 与 exitCode 无关——runner 在命令执行前就挂了，exit 码是 runner 的，
 * 拿来判「zg 未安装」是把沙箱故障误报成用户缺二进制。
 */
function sandboxFailure(result: ShellRunResult, messages: ZvecGrepMessages): string | null {
  const info = result.sandbox;
  // 可选链等价于旧的 `info === undefined || info.runnerFailed !== true`：info 缺席时
  // `info?.runnerFailed` 交出 undefined，同样 ≠ true ⇒ 走 null。false 与 undefined 两种
  // 「没硬失败」的来路在这里本就合并成同一条出口，合起来还顺带把 info 收窄成非空。
  if (info?.runnerFailed !== true) {
    return null;
  }
  return fill(messages.runnerFailed, { facts: sandboxFacts(info, messages) });
}

/** 沙箱策略拒绝的可读说明（拒绝 ≠ 崩溃：既用于失败消息，也用于成功但残缺的结果）。 */
function deniedNote(info: ShellSandboxInfo, messages: ZvecGrepMessages): string {
  return fill(messages.sandboxDenied, { facts: sandboxFacts(info, messages) });
}

/** 错误详情：首尾各留一段（zg/cargo 等错误的最终原因常在尾部）。
 *  两半各用一个函数，因为是两种缺陷：头切点会留下孤立**高**代理（`truncateEnd` 丢掉它），
 *  尾切点会留下孤立**低**代理（`truncateStart` 丢掉它）；对调两个函数同样不留孤立代理，
 *  只是头尾内容掉头 ⇒ 测试里另有一组哨兵断言钉住归属。 */
function failureDetail(result: ShellRunResult, messages: ZvecGrepMessages): string {
  // shell 契约保证 stdout/stderr 都是 { text } 对象；优选 stderr，空则回退 stdout。
  const raw = result.stderr.text.length > 0 ? result.stderr.text : result.stdout.text;
  if (raw.length <= 800) {
    return raw;
  }
  const half = 400;
  return fill(messages.detailMiddle, {
    head: truncateEnd(raw, half),
    tail: truncateStart(raw, half),
  });
}

/** 有详情才带前缀拼接（不同句式各有前缀），空详情绝不留孤儿标点。 */
function withDetail(detail: string, prefix: string): string {
  return detail.length > 0 ? fill(prefix, { detail }) : "";
}

function shellFailure(result: ShellRunResult, messages: ZvecGrepMessages): string | null {
  const runnerFailure = sandboxFailure(result, messages);
  if (runnerFailure !== null) {
    return runnerFailure;
  }
  if (result.timedOut) {
    return messages.timeoutFailure;
  }
  if (result.aborted) {
    return messages.abortedFailure;
  }
  if (result.exitCode === 0) {
    return null;
  }
  const detail = failureDetail(result, messages);
  const { sandbox } = result;
  // 可选链：sandbox 缺席时 `sandbox?.denied` 是 undefined，与旧写法
  // `sandbox !== undefined && sandbox.denied` 同一条出口；`=== true` 是
  // strict-boolean-expressions 要的显式比较，truthy 那一支里 TS 已把 sandbox 收窄成非空。
  if (sandbox?.denied === true) {
    // 策略拒绝的失败必须点名拒绝：否则模型只看到 exit=1，会去重装 zg / 换路径重试。
    return fill(messages.deniedFailure, {
      exit: result.exitCode,
      denied: deniedNote(sandbox, messages),
      detail: withDetail(detail, messages.detailPrefix),
    });
  }
  if (result.exitCode === 127) {
    return fill(messages.notInstalledFailure, {
      detail: withDetail(detail, messages.detailPrefix),
    });
  }
  return fill(messages.genericFailure, {
    exit: result.exitCode,
    detail: withDetail(detail, messages.detailColon),
  });
}

/**
 * 成功（exit 0）执行的结果体检：把「其实不完整」的三类事实显式打标，避免模型
 * 把残缺输出当完整证据用。
 *   1. stdout 超上限被截尾（可能已落 spill）；
 *   2. 沙箱在执行中拒绝过一次文件操作（zg 仍可 exit 0，但结果少了被拒的部分）；
 *   3. **stderr 非空**：zg 的降级提示（例如 embedding 模型拉不到 → 退化为纯词法
 *      兜底、跳过 --refresh）只写在 stderr，旧实现整个丢掉 → 用户把「只有词法
 *      结果」的检索当语义检索的完整结果。这里回显尾部一段。
 */
function successNotes(
  result: ShellRunResult,
  messages: ZvecGrepMessages,
  stdoutMaxBytes: number,
): string[] {
  const notes: string[] = [];
  if (result.stdout.truncated) {
    const spill =
      result.stdout.spillPath === undefined
        ? ""
        : fill(messages.spillNote, { path: result.stdout.spillPath });
    notes.push(fill(messages.outputTruncated, { maxBytes: stdoutMaxBytes, spill }));
  }
  const { sandbox } = result;
  if (sandbox?.denied === true) {
    notes.push(fill(messages.sandboxWarning, { denied: deniedNote(sandbox, messages) }));
  }
  const { stderr } = result;
  if (stderr.text.length > 0) {
    // 后切 ⇒ truncateStart：裸 slice(-400) 落在代理对中间时留下的是**低**代理。
    const tail = truncateStart(stderr.text, STDERR_NOTE_CHARS);
    const truncatedMark = stderr.truncated ? "[…]" : "";
    notes.push(fill(messages.stderrNote, { marked: truncatedMark, tail }));
  }
  return notes;
}

/** 各环境读一个 HF 镜像/代理基地址的优先级：显式入参 > 设置。
 *  `typeof` 判断是 host 侧兜底：值域正常时 schema 的 `.default()` 已保证是字符串，
 *  引用被交回 undefined（条目未投影/宿主退化）时宁可不带 env，也不发一个空 HF_ENDPOINT。 */
function hfEndpointEnv(config: Config): Record<string, string> | undefined {
  const endpoint = config.hfEndpoint.get();
  let env: Record<string, string> | undefined;
  if (typeof endpoint === "string" && endpoint.trim().length > 0) {
    // 规范化：去掉尾部斜杠，node-llama-cpp 的 resolveHuggingFaceEndpoint 自会补尾斜杠。
    const normalized = endpoint.trim().replace(/\/+$/u, "");
    env = { HF_ENDPOINT: normalized };
  }
  return env;
}

/**
 * zg query 输出的命中摘要（官方检索惯例：总数/上限/截断事实显式化，模型不再把
 * 触顶/截尾的结果当完整证据用——tool-fs-search 的 grep 卡同样携带 truncated/total）。
 * zg 每个查询组打一行裸 `hits: <n>`（源码行都带行号前缀，不会撞同一形状）；输出里
 * 一条计数行都没有（空结果/形状意外）时返回 null，不做摘要——不数就是不谎称。
 * 某组命中数 ≥ limit 视为触顶（zg 每组各取 top limit）。
 */
/** zg 每个查询组的计数行前缀（实测输出形状：`hits: 3`，源码行都带行号前缀）。 */
const HITS_LINE_PREFIX = "hits: ";

export function hitSummary(
  stdoutText: string,
  limit: number,
  truncated: boolean,
  messages: ZvecGrepMessages,
): string | null {
  // 逐行前缀解析而非正则捕获：裸 `hits: <数字>` 行才是组计数（preview 源码行都带
  // 行号前缀，撞不上同一形状）；`hits: ` 打头但不是纯数字的行不当计数（输出形状
  // 意外时不谎称）。
  const perGroup = stdoutText
    .split("\n")
    .filter((line) => line.startsWith(HITS_LINE_PREFIX))
    .map((line) => line.slice(HITS_LINE_PREFIX.length))
    .filter((digits) => /^\d+$/u.test(digits))
    .map((digits) => Math.trunc(Number(digits)));
  if (perGroup.length === 0) {
    return null;
  }
  const hits = perGroup.reduce((sum, count) => sum + count, 0);
  const capped = perGroup.some((count) => count >= limit);
  return fill(messages.hitSummary, {
    groups: perGroup.length,
    hits,
    limit,
    capped: capped ? messages.hitCapped : "",
    truncated: truncated ? messages.hitTruncated : "",
  });
}

async function runForeground(
  host: HostCtx,
  command: string,
  workdir: string,
  timeoutMs: number,
  opts: {
    signal: AbortSignal;
    env?: Record<string, string> | undefined;
    /** 执行器 stdout 缓冲上限（Config.stdoutMaxBytes，部署值）：截断说明按它报数。 */
    stdoutMaxBytes: number;
    messages: ZvecGrepMessages;
    /** 传入即追加命中摘要（仅 zg_search；值 = 本次请求的 --limit）。 */
    summaryLimit?: number | undefined;
  },
): Promise<string> {
  const spec = host.shell.resolve({
    command,
    workdir,
    timeoutMs,
    stdoutMaxBytes: opts.stdoutMaxBytes,
    signal: opts.signal,
    ...(opts.env ? { env: opts.env } : {}),
  });
  const exec = await host.shell.execute(spec);
  const result = await exec.result();
  const failure = shellFailure(result, opts.messages);
  if (failure !== null) {
    throw new Error(failure);
  }
  const notes = successNotes(result, opts.messages, opts.stdoutMaxBytes);
  const { text } = result.stdout;
  const summary =
    opts.summaryLimit === undefined
      ? null
      : hitSummary(text, opts.summaryLimit, result.stdout.truncated, opts.messages);
  const extras = summary === null ? notes : [...notes, summary];
  return extras.length > 0 ? `${text}\n${extras.join("\n")}` : text;
}

/**
 * root 的存在性预检（item：不验存在）。zg 的 cwd 不存在时，spawn 直接以
 * ENOENT 失败——那与「bash 没装」「zg 没装」在同一句 stderr 里无法区分，
 * 模型据此给出的建议会把用户带偏。提前一次 existsSync 换明确归因。
 */
function assertRootExists(root: string, messages: ZvecGrepMessages): string {
  if (!existsSync(root)) {
    throw new Error(fill(messages.rootMissing, { root }));
  }
  return root;
}

// ── 设置读取（带退化）──────────────────────────────────────────────────────
//
// 0.1.7 的读法：`config.<field>.get()` 现读引用当前值（旧 `scope.get()` 的等价物）。
// 每张卡的值都在 schema 里有 `.default()`，故正常情况下这些 getter 永不为 undefined；
// 保留 `typeof`/`??` 兜底只针对一个真实退化——条目没有 volatile 投影、宿主交回空引用。
// 值域（1-50 / 1-20 / 1-240）由 Config schema 保证，越界的最终兜底在 lib/cli.ts。

function readDefaultEmbedding(config: Config): string {
  const raw = config.defaultEmbedding.get();
  if (typeof raw === "string" && isLocalEmbedding(raw)) {
    return raw;
  }
  return DEFAULT_EMBEDDING;
}

/**
 * 默认每组结果数：值域 1-50 由 Config schema（隐式命名空间与行 config 共用）保证，
 * 这里只处理「字段缺省」。真正兜住越界的是 cli.clampLimit（命令构造边界）。
 */
function readDefaultLimit(config: Config): number {
  return config.defaultLimit.get() ?? DEFAULT_LIMIT;
}

/** search-first 解锁配额：每次成功 zg_search 发放的 grep/rg 次数（值域 1-20 由 schema 保证）。 */
function readGrepBudget(config: Config): number {
  return config.grepBudgetPerSearch.get() ?? DEFAULT_GREP_BUDGET;
}

/** search-first 解锁时效（分钟，值域 1-240 由 schema 保证）。 */
function readUnlockWindowMin(config: Config): number {
  return config.unlockWindowMin.get() ?? DEFAULT_UNLOCK_WINDOW_MIN;
}

/** search-first 门禁开关：**fail-closed**。schema 默认已是 true，引用仍交回 undefined
 *  （条目没被投影 / 宿主退化）时按「门禁开着」处理——宁可多拦一次 grep，也不能把
 *  「读不到设置」静默当成「用户关了门禁」。 */
function readEnforceSearchFirst(config: Config): boolean {
  return config.enforceSearchFirst.get() ?? true;
}

/** zg 索引库存在性探测（search-first 门禁与 zg_search 登记共用）。
 *  必须连 workspace manifest 一起看：`<dir>/.zvec-grep/` 这个名字被 zg 自己的**全局
 *  home** 征用（`ZVEC_GREP_HOME ?? ~/.zvec-grep`，装的是 config.json / locks / models），
 *  只判目录存在的话，一个从没建过索引的工作区会因祖先目录撞名而被当成「已建索引」——
 *  门禁随即在没有任何索引可搜的情况下拦下 grep/rg，而 zg_search 也答不出任何东西。
 *  manifest 是上游写索引时落的那一份（`writeWorkspaceManifest`），只有它在场，
 *  才说明这个工作区真的建过索引。 */
function indexProbeOf(dir: string): boolean {
  return (
    existsSync(`${dir}/${INDEX_DIR_NAME}`) &&
    existsSync(`${dir}/${INDEX_DIR_NAME}/${WORKSPACE_MANIFEST_FILE}`)
  );
}

// ── 工具注册辅助 ───────────────────────────────────────────────────────────

/** 工具入参的 root：显式值 > 会话工作区，再过存在性预检（一处三工具共用）。 */
function rootOf(args: Record<string, unknown>, exec: ToolExec, messages: ZvecGrepMessages): string {
  return assertRootExists(resolveRoot(args["root"], sessionHeaderCwd(exec), messages), messages);
}

/** 三工具共用的注册规格（对象化：文案要在每次 execute 现取，位置参数已近上限）。
 *  name/description/parameters 三位直接从官方 `ToolDefinition`（继承 ToolSchema）取：宿主
 *  改字段名或换类型时这里先编译失败。description 是**注册当时**的工具描述——语言在 apply
 *  定下，与 parameters 同生死。`run` 不是宿主契约，是本包的内部形状。 */
interface ToolSpec extends Pick<ToolDefinition, "name" | "description" | "parameters"> {
  /** 回显/校验文案的语言解析器：每次 execute 现取一份，切语言不必重载插件。 */
  messages: () => ZvecGrepMessages;
  run: (
    args: Record<string, unknown>,
    exec: ToolExec,
    messages: ZvecGrepMessages,
  ) => Promise<unknown>;
}

function define(host: HostCtx, spec: ToolSpec): void {
  const { parameters } = spec;
  // defineTool 等效校验（零依赖版）：execute 前强制 required 字段在位，把
  // "晚到的命令失败"变成"即时的明确报错"。完整 JSON Schema 校验不在此复制
  // ——值语义的逐项校验在 lib/cli.ts 的取值器里做（那里也是转义的发生地）；
  // @deepseek-ai/dsh-tools 在本文件是 type-only（见文件头），故 defineTool 的运行时值
  // 仍不引入，只把注册面绑到它交出的 `ToolDefinition` 类型上。
  const required = Array.isArray(parameters["required"])
    ? parameters["required"].filter((item): item is string => typeof item === "string")
    : [];
  host.tools.register({
    name: spec.name,
    description: spec.description,
    parameters,
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      // 官方 render 的入参类型由 ToolOutputDefinition 交出（args: unknown / value: JsonValue），
      // 不在此重复标注；textBlock 仍按 unknown 收——见下面「官方要求 render total」的注释。
      render: (_args, value) => textBlock(value),
    },
    // 官方契约：`execute(exec.arguments, exec)`——arguments 是 **unknown 原样**
    //（顶层 null / 数组 / 字符串都会进来），先 isRecord 收窄再读字段；直接
    // `args[field]` 断言成 Record 会在 null 上抛 TypeError（信息对模型无意义）。
    // exec 的官方类型是 ToolRunContext（第二参），这里不标注即由注册面交出。
    execute: async (rawArgs, exec) => {
      const messages = spec.messages();
      if (!isRecord(rawArgs)) {
        throw new Error(
          fill(messages.argsMustBeObject, {
            name: spec.name,
            received: rawArgs === null ? "null" : typeof rawArgs,
          }),
        );
      }
      const missing = required.filter((fieldName) => rawArgs[fieldName] === undefined);
      if (missing.length > 0) {
        throw new Error(
          fill(messages.missingRequiredArgs, {
            name: spec.name,
            fields: missing.join(", "),
          }),
        );
      }
      // 先 await 再 return：eslint/require-await 不许这枚 async 箭头没有 await，而
      // typescript/return-await 又禁止 `return await`（这里不在 try 里），两步写恰好同时满足
      // 两条，且与旧的 `return spec.run(...)` 同值——异常仍是 rejection，不改执行面语义。
      const outcome = await spec.run(rawArgs, exec, messages);
      return outcome;
    },
  });
}

// ── 插件体 ─────────────────────────────────────────────────────────────────

/** 隐式命名空间与 loader 行 config 共用同一 schema（单源，防漂移）。
 *  值名退避为 configSchema：避免与同名 interface Config 触发 no-redeclare；
 *  外部仍以 `Config` 名导入（export as），公开 API 不变。
 *
 *  0.1.7 迁移要点（两处都是静默失效，写错不报错）：
 *   - `.volatile()` 决定字段是否进设置表单。宿主 `describe()` 只投影 volatile 字段
 *     （packages/settings/settings/src/schema.ts 的 volatileForm），全漏标则整条被跳过
 *     （settings/src/index.ts:308-309）、写入抛 `has no volatile fields`（:386）。
 *   - `settings.register(ns, schema, { base })` 的「底座」层已被宿主移除：内置默认逐字段
 *     落成下面的 `.default()`（原 BUILTIN_BASE 原样搬来，单一来源），cordis 装载期按同一
 *     份 schema 校验行 config 并填默认，再把 volatile 字段包成引用交给 apply。
 *  六个 volatile 字段全是本卡的可编辑项，一个都不该漏；四个非 volatile 部署值
 *  （超时三项 + stdout 上限）只走行 config，标 volatile 反而会把它们变成设置卡项。 */
const configSchema = Schema.object({
  defaultEmbedding: Schema.string().default(DEFAULT_EMBEDDING).volatile(),
  defaultLimit: Schema.natural().min(1).max(50).default(DEFAULT_LIMIT).volatile(),
  // ⚠ 这个字面量是**政策**不是占位值：本环境 huggingface.co 不可达，默认必须走
  // ModelScope 镜像（已实测可下载 qwen3）。改成"更通用"的 HF 默认等于让每张新装
  // 的卡在首次 zg_index 上失败。卡片上可改为其它兼容镜像，或留空走官方 HF。
  hfEndpoint: Schema.string().default("https://modelscope.cn/models").volatile(),
  // search-first 门禁：已建索引的工作区，grep/rg 前必须先成功 zg_search。
  // grep 字面检索漏检是常态（同义词/别名/换名后 grep 不到），语义/混合检索覆盖更好。
  enforceSearchFirst: Schema.boolean().default(true).volatile(),
  // 配额+时效解锁：每次成功 zg_search 解锁 N 次 grep/rg、M 分钟内有效；
  // 用尽/过期再拦——保证语义检索频率与 grep 用量成正比，而非一次放行终身豁免。
  grepBudgetPerSearch: Schema.natural().min(1).max(20).default(DEFAULT_GREP_BUDGET).volatile(),
  unlockWindowMin: Schema.natural().min(1).max(240).default(DEFAULT_UNLOCK_WINDOW_MIN).volatile(),
  // ── 非 volatile 部署值（形态照 ctx-observe 的 fallbackWindow）──
  // 不标 .volatile() ⇒ 不进设置卡（宿主 describe() 只投影 volatile 字段），装载期被
  // cordis 填成普通值交进 apply；cordis.yml 的行 config 是改值入口。默认值与上方常量
  // 单源（常量只在 .default() 这里被引用，运行期消费点一律现读 config）。min(1) 挡掉
  // 「0 = 立即超时/立即截断」这类无意义的行 config，默认路径不受影响。
  // 前台检索超时：覆盖 --refresh wait 的同步刷新（大工作区可能重跑 embedding）。
  searchTimeoutMs: Schema.natural().min(1).default(SEARCH_TIMEOUT_MS),
  statusTimeoutMs: Schema.natural().min(1).default(STATUS_TIMEOUT_MS),
  // 前台建索引超时 + 后台重建 kill 定时器：默认对齐宿主 bash-local 的 maxTimeoutMs。
  indexTimeoutMs: Schema.natural().min(1).default(INDEX_TIMEOUT_MS),
  // 执行器 stdout 缓冲上限（字节）：超限截尾（可落 spill），成功结果里如实打标。
  stdoutMaxBytes: Schema.natural().min(1).default(STDOUT_MAX_BYTES),
});
export { configSchema as Config };

/** 官方注册表里本包作业的 kind；宿主据此发出的 id 形如 `zvec-grep-rebuild-N`。 */
const REBUILD_JOB_KIND = "zvec-grep-rebuild";

/**
 * 本 kind 在注册表里的**已落定**记录上限：每次 start 前先剪到 `MAX-1` 条，新那条落定后
 * 正好 `MAX` 条在册（文案与卡片 404 提示都按这个数说）。同时能跑几个不在这里——那是
 * 注册表的容量闸（实测未拥有桶 10，满员是**拒绝**新 start，不是淘汰旧的）。官方件**不会**
 * 自行回收落定记录（"A settled record stays listed until its owner's disposal, service
 * disposal, or an explicit remove"），而注册表又随宿主活着、不随本插件卸载而死 ⇒ 这条
 * 裁剪是本包的责任。注意它只管历史窗口：**同时能跑几个**由注册表的容量说了算
 * （实测默认 10，且超限是**拒绝**，不是替我们杀在跑的任务）。
 */
const REBUILD_HISTORY_MAX = 10;

/** 卡片视图的尾部长度（打标文案在 lib/messages.ts，随语言走）。 */
const JOB_OUT_VIEW_CHARS = 4000;

/**
 * 侧表记录：官方注册表管身份、生命周期与输出环，这里只存**注册表给不出**的本包事实。
 *  - `proc`：沙箱事实与 `exitCode` 的现读来源（卡片契约要这两件，官方 JobView 没有槽）；
 *  - `root`：卡片要回显重建的是哪棵树；
 *  - `id`：宿主签发的那枚 `JobId`（品牌类型）。回注册表只用它，绝不把请求带来的字符串递进去；
 *  - `state`：这条作业的**可变**部分，见 {@link RebuildState}。
 *
 * 这里**不存注册表引用**：jobs 每次用时现读（见 `registerRebuildEndpoints` 里的 `jobsOf`），
 * 于是服务被重载时侧表里的旧记录只会走 404 那一臂，而不是继续往一枚已销毁的实例里读。
 */
interface RebuildRecord {
  proc: ShellExecution;
  root: string;
  id: JobId;
  state: RebuildState;
}

/**
 * 名册里那条 id 是不是**我们**的那条作业。
 *
 * 只比 id 不够：计数器是注册表的实例字段（实测两枚实例对同一 kind 都从 1 开始），换一枚
 * 实例就重名。出生时刻由官方签（`Date.now()`），跨实例撞上同一毫秒的机会与"用户在服务重载后
 * 一毫秒内又起一次重建"同阶，而那已经是另一次用户意图，卡片 404 重来即可。
 * @param state 这条记录的状态盒
 * @param view 名册里同 id 的那条投影
 * @returns 同一条作业
 */
function sameJob(state: RebuildState, view: JobView, live: JobsService): boolean {
  // 身份证是两半：签发注册表的**实例身份**（"jobs 那一行被换成另一枚实例"的直接证据）
  // + 出生时刻。只比时间戳在同毫秒重签时会撞车（两枚实例各取 Date.now() 同值），
  // 实例引用不会——这正是"换过服务"这条语义本身。
  return state.owner === live && state.bornAt === view.startedAt;
}

/** 终止重建进程：kill 异常忽略（进程可能已自然退出/已被回收）。 */
function killProc(proc: ShellExecution): void {
  try {
    proc.kill();
  } catch {
    // 忽略
  }
}

/**
 * 一条重建的**可变**状态，与 {@link RebuildRecord} 分开是有原因的：记录要等 `start` 交回 id
 * 与出生时刻才建得出来（在那之前进侧表，`run()` 抛错时就留下一条"名册不认、却永远钉着一枚
 * proc"的幽灵），而 `run()` 里的超时臂与源的读数必须先有一个能写的地方。两边共用这只盒子。
 *
 * 丢失记账为什么归我们：注册表的环只知道自己裁了头部（`output.earliest`，那是**显示**口径），
 * 而执行器的读者抛错或报 lossy 是"zg 的输出确实少了一段"——两者必须分开标，否则会把
 * "看不见了"说成"没跑出来"。
 */
interface RebuildState {
  /** 出生时刻（官方 `JobView.startedAt`）＝身份证的另一半；0 = 还没盖（start 返回前的同步块内）。 */
  bornAt: number;
  /** 签发这条作业的注册表实例＝身份证的主体；null = 还没盖。换过实例即可判非同一条，
   *  不依赖时间戳（同毫秒重签会撞值）。 */
  owner: JobsService | null;
  /** 执行器的读者报 lossy 或抛错 ⇒ 真少了字节（与"环按留存窗裁过头部"分开标）。 */
  lost: boolean;
  /** 超时说明。不进环（环的写权归注册表的泵），由投影端点合成。 */
  timeoutNote: string | null;
}

/**
 * 本包作业的输出面：官方 pull source，stdout/stderr 各一只游标，外加一层"读失败不许
 * 拖垮泵"的兜。选 pull 而不是生产者 push（`JobHandle.append`）是复核
 * 后按实测定下的：
 *  - `proc.observed[*].readFrom` 是**非消费**的独立观察者面（installed dsh-shell
 *    types.d.ts:199-203："without stealing bytes from `readOutput`"），与本包前台用的
 *    消费式游标互不干扰——此前本仓写的"官方泵会与 readOutput 争同一份游标"是错的；
 *  - 泵按注册表自己的节拍跑（实测默认 150ms，落定前再排最后一次）⇒ **卡片关着环也前进**，
 *    模型侧 job_output 随时看得见进度；push 形态把可见性绑在了轮询上。
 * @param proc 后台进程句柄
 * @param state 这条重建的状态盒（见 {@link RebuildState}）
 * @returns 交给 JobSpec.output 的两条源
 */
function rebuildSources(proc: ShellExecution, state: RebuildState): JobOutputSource[] {
  return (["stdout", "stderr"] as const).map((channel) => {
    // 官方 `guardSource` 会把抛错的源读作"此后已尽"（实测：400ms 里第 3 抛之后不再敲第四下），
    // 但那道兜**只把抛错记进宿主日志，环里什么标记都不留** ⇒ 卡片看不出少了一段。本包因此
    // 自己兜一层：抛错转成"游标原地不动 + 空增量 + 记进 state.lost"。也正因为我们兜住了，
    // 官方的 exhausted 替身永远不会生效 ⇒ **闩得我们自己上**，否则每 150ms 敲一只已经坏掉的
    // 读者，一直敲到落定。
    let failed = false;
    return {
      channel,
      read: (fromByte: number): JobSourceRead => {
        if (failed) {
          return { text: "", nextOffset: fromByte, lossy: true };
        }
        try {
          const read = proc.observed[channel].readFrom(fromByte);
          if (read.lossy) {
            state.lost = true;
          }
          return read;
        } catch {
          state.lost = true;
          failed = true;
          return { text: "", nextOffset: fromByte, lossy: true };
        }
      },
    };
  });
}

/** 官方件对未知/已淘汰 id 抛错；本包的判据要的是"有没有"，不是异常（无 ⇒ null）。 */
function jobView(jobs: JobsService, id: JobId): JobView | null {
  try {
    return jobs.get(id);
  } catch {
    return null;
  }
}

/** 轮询端点的一次成对读数：状态投影 + 留存窗内容；注册表已无此 id ⇒ undefined。 */
function readRebuildOutput(
  jobs: JobsService,
  id: JobId,
): { view: JobView; retained: JobOutputRead } | null {
  // 侧表里有、注册表里没有是**合法事件**（宿主重载了 jobs 那一行 ⇒ 它清空名册，而我们
  // 手里的记录还在）。必须折成 null 让调用方回 404，绝不能让异常抛穿到 webServer：
  // 宿主对 handler 抛出的兜法是 `logger.warn` 一条 + **写一枚没有 body、也没有 content-type
  // 的 400**（只有头已发时才 `res.destroy()`；installed dsh-host-webserver lib/index.js:246-256
  // 实测原码）。卡片见到没有 json 类型的响应就判"取不到载荷"⇒ error 终止态 ⇒ 停止轮询 ⇒
  // 一条还在跑的重建从此在界面上消失，而它自己也再不可能被窗口裁剪回收。
  // （归因从旧注释的"不写响应 / socket hang up"改过来：后果一样糟，但照旧注释去查 socket
  // 的人会查错地方。）
  try {
    return { view: jobs.get(id), retained: jobs.readAt(id, 0) };
  } catch {
    return null;
  }
}

/** 官方 JobStatus 里"仍在跑"的两枚：`stopping` 是取消已发出、进程还没收完。 */
function isLiveStatus(status: JobStatus): boolean {
  return status === "running" || status === "stopping";
}

/**
 * 历史窗口有界：按注册表的**可见集合**淘汰本 kind 最老的已落定记录。
 *
 * 剪到**只剩 `MAX-1` 条**才是对的：这一剪发生在 start 之前，紧接着就有一条新作业进来，
 * 它落定之后名册里正好是最近 `MAX` 条已落定记录 ⇒ 与卡片文案「只保留最近 10 条已结束的重建」
 * 同一口径。剪到 `MAX` 条会让册子在任何时刻都有 `MAX+1` 条已结束记录（实测 11 条），
 * 最初把这条判反了（只看剪完那一刻的 9 条），后来回退。
 * 在跑的一条不动——官方件对超额的答法是拒绝 start（实测），不是替我们杀任务，
 * 这里跟着杀等于把"用户的重建被静默终止"重新发明一遍。
 * 侧表里没有的 id（上一次 apply 卸载后残留的记录）同样要能清掉，所以遍历的是
 * `list()` 而不是 `records`。
 * @param jobs 官方注册表
 * @param records 本包侧表（被淘汰记录同步删掉）
 * @returns {void}
 */
function pruneRebuildHistory(jobs: JobsService, records: Map<string, RebuildRecord>): void {
  const ours = jobs.list().filter((job) => job.kind === REBUILD_JOB_KIND);
  const settled = ours.filter((job) => !isLiveStatus(job.status));
  for (const job of settled.slice(0, Math.max(settled.length - (REBUILD_HISTORY_MAX - 1), 0))) {
    jobs.remove(job.id);
    records.delete(job.id);
  }
}

/**
 * 从官方容量闸的错误文本里取出上限（实测原文：`background job limit reached for this
 * owner (limit: 10)`）。认不出来 ⇒ undefined，调用方退回通用的启动失败文案。
 * 为什么单独认这一条：它是本包唯一会把宿主英文原话插进中文卡片的错误，又恰恰最该翻成
 * 人话的那一条——用户此时要做的是去 job_list 里收掉不需要的作业，而不是读一句英文。
 */
function capacityLimitOf(error: unknown): string | undefined {
  const matched = /\(limit: (?<limit>\d+)\)/u.exec(errorText(error));
  return matched?.groups?.["limit"];
}

/**
 * 「工作区重建」动作端点的四道前置校验：绝对路径 + 归一化、本 daemon 观测过的白名单、
 * 目录此刻仍存在。不过就把错误就地答完并返回 undefined（错误文本全走双语字典）。
 *
 * 这四道是**动作**端点的闸门：webServer 可被配成绑 0.0.0.0，没有白名单的话任何能连上
 * 服务面的一方都能拿任意绝对路径去 `zg index --rebuild`——读遍那棵树、写 `.zvec-grep/`，
 * 还可能把其中的非隐藏敏感文件灌进向量库并回显到上下文。
 * @param req 请求对象
 * @param res 响应对象（不过时由本函数就地应答）
 * @param ledger 观测到的工作区白名单
 * @param started 本次请求语言的文案表
 * @returns 归一化后可用的绝对路径；不合格时 null（那时本函数已经答过）
 */
function acceptableRebuildRoot(
  req: IncomingMessage,
  res: ServerResponse,
  ledger: RootLedger,
  started: ZvecGrepMessages,
): string | null {
  let root: string;
  try {
    root = assertAbsoluteRoot(queryParam(req, "root"), started);
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: fill(started.endpointRootInvalid, { reason: errorText(error) }),
    });
    return null;
  }
  if (!ledger.has(root)) {
    sendJson(res, 403, { ok: false, error: fill(started.endpointRootUntracked, { root }) });
    return null;
  }
  if (!existsSync(root)) {
    sendJson(res, 400, { ok: false, error: fill(started.endpointRootGone, { root }) });
    return null;
  }
  return root;
}

/**
 * 这个 root 上有没有**仍在跑**的本包重建？有 ⇒ 返回那枚作业 id 让新面板跟随。
 *
 * 判据是三条一起："侧表里有这条" + "名册里同 id 的那条确实是我们那条（比出生时刻）" +
 * "状态还在跑/正在收"。第二条不能省：jobs 被重载之后 id 会重名，只查侧表就把一张新面板
 * 领到别人的作业上。
 * 就地答完（200 + 复用旗标）并返回 true ⇒ 调用方直接 return；否则返回 false 继续起进程。
 * @param jobs 当前这枚注册表（缺席 ⇒ 无从判断）
 * @param records 本包侧表
 * @param res 响应对象
 * @param root 已归一化的工作区
 * @returns 是否已把这张面板领到在跑的那条上（领到了就地答完 200）
 */
function followRunningRebuild(
  jobs: JobsService | undefined,
  records: Map<string, RebuildRecord>,
  res: ServerResponse,
  root: string,
): boolean {
  const following =
    jobs === undefined
      ? undefined
      : [...records.values()].find((record) => {
          if (record.root !== root) {
            return false;
          }
          const view = jobView(jobs, record.id);
          return view !== null && sameJob(record.state, view, jobs) && isLiveStatus(view.status);
        });
  if (following === undefined) {
    return false;
  }
  sendJson(res, 200, { ok: true, jobId: following.id, reused: true });
  return true;
}

/**
 * 起一条重建失败时的收口：先杀掉那条已经起来的进程，再把原因翻成卡片文案。
 *
 * 官方件在 preflight（controller/容量/入参）拒掉作业时进程**已经**起来了（spawn 在注册之前）
 * ⇒ 不能留一条没登记、谁也停不掉的 zg。满员那一档单独翻文案：它是本包唯一会把宿主英文原话
 * 插进中文卡片的错误，又最该翻成人话（用户要做的是去 job_list 收作业，不是读一句英文）。
 * @param res 响应对象
 * @param error 官方件（或本包 starter）抛出的原因
 * @param proc 已经起来的 zg 进程
 * @param started 本次请求语言的文案表
 * @returns {void}
 */
function replyStartupFailure(
  res: ServerResponse,
  error: unknown,
  proc: ShellExecution,
  started: ZvecGrepMessages,
): void {
  killProc(proc);
  const capacity = capacityLimitOf(error);
  sendJson(res, 500, {
    ok: false,
    error:
      capacity === undefined
        ? fill(started.endpointStartFailed, { reason: errorText(error) })
        : fill(started.endpointJobsAtCapacity, { limit: capacity }),
  });
}

/**
 * 在 controller 闸门下起一条未拥有作业。
 *
 * 官方件在"没有 controller 服务这个 owner"时直接拒绝 `start`（实测台架第 1 条），而未拥有
 * 作业只被 global 层服务；web 面上宿主自己的 `tool-jobs` 被移进了各 preset realm
 * （packages/bundle/web-app/cordis.patch.yml 把 tool-jobs 在宿主平面 disabled），
 * 所以本包必须自带一枚从无作用域上下文 attach 的 controller。但**只在 start 这一瞬挂**：
 * 实测挂上即放行、摘掉即恢复拒绝、可反复，而 global 层的 controller 只被 `servesOwner`
 * 读（installed dsh-jobs-local 全文只有那一处消费），作业的后续（read/kill/落定）都不
 * 依赖它。留一枚常驻 token 等于在"宿主故意没装 job 工具"的组成里替全宿主开着那道闸门——
 * 官方契约写的是"生产者不能起一台 owner 收不掉、停不掉的作业"，常驻就是把它反过来做。
 */
function startUnderController(jobs: JobsService, spec: JobSpec): JobId {
  const detach = jobs.attachController("zvec-grep: rebuild");
  try {
    return jobs.start(spec);
  } finally {
    detach();
  }
}

/**
 * 后台进程的沙箱事实提示。runner 失败 / 策略拒绝都不许被显示成「完成」：
 * dsh-shell 只在有沙箱的执行器下填 proc.sandbox，读了它才能把「zg 自己失败」
 * 与「zg 根本没跑起来」分开。
 */
function procSandboxNote(proc: ShellExecution, messages: ZvecGrepMessages): string | null {
  const info = proc.sandbox;
  if (info === undefined) {
    return null;
  }
  if (info.runnerFailed === true) {
    return fill(messages.rebuildRunnerFailed, { facts: sandboxFacts(info, messages) });
  }
  if (info.denied) {
    return fill(messages.rebuildDenied, { denied: deniedNote(info, messages) });
  }
  return null;
}

/**
 * 工作区白名单：重建端点只接受**本 daemon 真实观测到过的会话工作区**
 * （guard 每次工具调用、execute 每次 root 解析都会登记）。
 * webServer 可被配成 0.0.0.0，端点又是一个会读遍整棵树、写 .zvec-grep/ 的
 * 动作，绝不能接受任意绝对路径；键经 assertAbsoluteRoot 归一，
 * `/repo/../repo` 与 `/repo/` 这类同物异写不再能绕过比较。
 */
interface RootLedger {
  add: (root: string) => void;
  has: (root: string) => boolean;
  list: () => string[];
}

/** 白名单键：归一化后的绝对路径；非法 root（相对/越界/NUL）归 undefined。 */
function ledgerKey(root: string, messages: ZvecGrepMessages): string | undefined {
  let key: string | undefined;
  try {
    key = assertAbsoluteRoot(root, messages);
  } catch {
    key = undefined;
  }
  return key;
}

/**
 * Map 有界化：超过上限按插入序淘汰最老的若干键（常驻进程内存有界）。
 * 先写后剪：新键总在末尾，故被淘汰的一定是最早的，语义与「满了再腾位」一致。
 */
function trimMapTo<Key, Value>(map: Map<Key, Value>, max: number): void {
  const overflow = map.size - max;
  if (overflow <= 0) {
    return;
  }
  for (const key of [...map.keys()].slice(0, overflow)) {
    map.delete(key);
  }
}

/** 索引探测缓存的条目：探测结果 + 探测时刻（epoch ms，TTL 与 LRU 触摸的判据）。 */
interface IndexProbeEntry {
  result: boolean;
  probedAt: number;
}

/** 探测缓存的 TTL（ms）：负向条目（当时无索引）的陈旧上界，选型论证见下。 */
export const INDEX_PROBE_TTL_MS = 60_000;
/** 探测缓存容量（条）：guard 一次调用至多探 9 层祖先，32 条覆盖多工作区来回切换。 */
export const INDEX_PROBE_CACHE_MAX = 32;

/**
 * zg 索引库存在性探测的**按目录缓存**（P2：guard 每次工具调用里 findIndexRoot 最多
 * 向上探 9 层 existsSync，同一工作区的连续调用命中的是同一串祖先目录；zg_search 的
 * 解锁路径也要再走一遍同样的上溯）。
 *
 * 失效策略选**进程内 TTL（60s）**而不是会话内不过期：正向条目（有索引）在「索引目录
 * 运行期不会消失」的假设下永不陈旧，TTL 对它只是内存有界的双保险；真正需要 TTL 的是
 * **负向**条目——zg_index 是运行期动作，新索引落地后若永不过期，门禁要到进程重启才
 * 看得见它。60s 的负向陈旧只是「索引出现前的既有行为」（grep 不被拦）的短暂延续，
 * 方向安全，且与「建索引后立刻去搜」的真实节奏相比可忽略。
 *
 * 缓存是**纯性能优化**：只替 existsSync 的答案，不改 findIndexRoot 的走法——root 不
 * 存在（probe 恒 false）、走满 maxDepth、上溯到 / 等失败路径在相同探测结果下与原实现
 * 逐分支一致。命中即触摸（delete+set 挪到队尾），配合 trimMapTo 的插入序淘汰 ⇒ LRU。
 *
 * @param probe 目录探测（生产注入 indexProbeOf；测试注入计数桩）
 * @param now 时钟注入（默认 Date.now；测试用它推进过 TTL）
 * @param ttlMs 条目存活时长（默认 {@link INDEX_PROBE_TTL_MS}）
 * @param max 容量上限（默认 {@link INDEX_PROBE_CACHE_MAX}）
 * @returns 与 probe 同签名的缓存化探测函数
 */
export function createIndexProbeCache(
  probe: (dir: string) => boolean,
  now: () => number = Date.now,
  ttlMs: number = INDEX_PROBE_TTL_MS,
  max: number = INDEX_PROBE_CACHE_MAX,
): (dir: string) => boolean {
  const cache = new Map<string, IndexProbeEntry>();
  return (dir: string): boolean => {
    const at = now();
    const hit = cache.get(dir);
    if (hit !== undefined && at - hit.probedAt < ttlMs) {
      // 命中：答案照旧，顺手触摸到队尾（LRU）。
      cache.delete(dir);
      cache.set(dir, hit);
      return hit.result;
    }
    // 未命中或已过期：真探测一回并记账（过期条目先删再插，同样摸到队尾）。
    const result = probe(dir);
    cache.delete(dir);
    cache.set(dir, { result, probedAt: at });
    trimMapTo(cache, max);
    return result;
  };
}

function createRootLedger(messages: ZvecGrepMessages, max: number = MAX_LEDGER_ROOTS): RootLedger {
  const seen = new Map<string, true>();
  return {
    add(root: string): void {
      const key = ledgerKey(root, messages);
      if (key === undefined) {
        return;
      }
      seen.set(key, true);
      trimMapTo(seen, max);
    },
    has(root: string): boolean {
      const key = ledgerKey(root, messages);
      return key !== undefined && seen.has(key);
    },
    list(): string[] {
      return [...seen.keys()];
    },
  };
}

/** 重建端点组的依赖（对象化以避开 max-params；文案按请求现取）。 */
interface RebuildEndpointDeps {
  /** 只用来挂释放器：给的是 `inject(["webServer"])` 子 fiber 的上下文，故收窄到效应面。 */
  ctx: Pick<Context, "effect">;
  host: HostCtx;
  /** apply 收到的那份 volatile 引用配置（端点每次现读，改完不必重载插件）。 */
  config: Config;
  csrf: string;
  ledger: RootLedger;
  /** 现取一份文案（语言随官方 locale 偏好，改语言不必重载插件）。 */
  messages: () => ZvecGrepMessages;
}

/**
 * 三条重建路由共享的运行时依赖：每次 `registerRebuildEndpoints` 一份，闭包量对象化
 * 是为了让拆出来的 handler 函数不越 over `max-params`（同一份状态，不是新的持有者）。
 */
interface RebuildRoutes {
  host: HostCtx;
  /** apply 收到的那份 volatile 引用配置（端点每次现读，改完不必重载插件）。 */
  config: Config;
  csrf: string;
  ledger: RootLedger;
  /** 现取一份文案（语言随官方 locale 偏好，改语言不必重载插件）。 */
  messages: () => ZvecGrepMessages;
  /** 官方注册表每次用时现读（理由见 registerRebuildEndpoints）。 */
  jobsOf: () => JobsService | undefined;
  /** 本包侧表（引用共享：三条路由与卸载效应都读写同一张表）。 */
  records: Map<string, RebuildRecord>;
  servingNonLoopback: boolean;
}

/** 引导端点：交回本次 apply 生成的 CSRF token 与白名单里观测到的工作区。 */
function handleRebuildRoots(
  routes: RebuildRoutes,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const { csrf, ledger, servingNonLoopback } = routes;
  // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句——先验权威再谈方法/参数。
  if (!guardTrust(req, res, { servingNonLoopback })) {
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET");
    sendJson(res, 405, { ok: false, error: "GET only" });
    return;
  }
  // 自家 isCrossOrigin 支在信任闸门之后不可达：trust 的 sec-fetch-site 白名单更严、错误文本同一句
  // （既有的「跨源 403」用例仍然绿，拒它的是闸门）。
  sendJson(res, 200, { ok: true, csrf, roots: ledger.list() });
}

/**
 * 交给注册表的作业规格：输出源 + `run` 的两枚钩子（cancel / done）与那枚 kill 定时器。
 * 单独成一段是因为它只在 `start` 的那一拍被同步调用一次，与「登记进侧表」是两件事。
 * @param routes 本次注册的共享依赖（config 现读超时、host 挂 timer、jobsOf 现读注册表）
 * @param proc 已经起来的 zg 进程
 * @param state 这条重建的状态盒（与侧表记录共用）
 * @param command 实际执行的命令行（作业 label，模型在 job_list 里看见的那句）
 * @returns 官方 JobSpec：kind / label / output / run
 */
function rebuildJobSpec(
  routes: RebuildRoutes,
  proc: ShellExecution,
  state: RebuildState,
  command: string,
): JobSpec {
  const { config, host, jobsOf, messages } = routes;
  return {
    kind: REBUILD_JOB_KIND,
    label: command,
    output: rebuildSources(proc, state),
    run: (handle) => {
      // 名册里那条还是不是我们这条：换过注册表就不是（id 会重名），那就谁也不许动它。
      const liveJob = (): { jobs: JobsService; status: JobStatus } | null => {
        const live = jobsOf();
        if (live === undefined) {
          return null;
        }
        const view = jobView(live, handle.id);
        if (view === null || !sameJob(state, view, live)) {
          return null;
        }
        return { jobs: live, status: view.status };
      };
      // 后台进程必须显式加超时：dsh-shell 契约明确 start 不应用 timeoutMs
      //（"no timeout applies to background processes"），否则 zg 挂住即 job
      // 永远 running、卡片每 2s 无限轮询。用宿主 timer 归属插件纤维，插件
      // 卸载时随 effect 自动回收；进程先结束则取消定时器。
      const cancelKillTimer = host.timer.timeout(() => {
        // 进程可能恰在超时点自然完成——注册表的落定排在 done 的微任务链上，此刻
        // 名册里仍是 running。以实时的 proc.status 为准，否则会给一条已成功的重建
        // 记下超时，并与随后落定的 completed 矛盾。
        if (proc.status !== "running") {
          return;
        }
        // 名册里已在收（stopping）或已收完 ⇒ 有人负责了，不再重复。
        const live = liveJob();
        if (live !== null && live.status !== "running") {
          return;
        }
        const minutes = Math.round(config.indexTimeoutMs / 60_000);
        state.timeoutNote = fill(messages().rebuildTimeout, { minutes });
        if (live === null) {
          // 注册表已经不认这条了（服务被重载）⇒ 只剩我们手里的进程可收，直接杀。
          killProc(proc);
          return;
        }
        // 超时也经注册表收，而不是绕过它直接杀进程：官方件据此把记录推到 stopping，
        // 并把 reason 追加进模型可见的 detail（实测），模型因此分得清"超时回收"与
        // "用户手工 job_kill"；进程本身由它回调上来的 cancel() 终止。
        live.jobs.kill(handle.id, undefined, fill(messages().jobReasonTimeout, { minutes }));
      }, config.indexTimeoutMs);
      return {
        cancel: () => {
          killProc(proc);
        },
        // pull source 形态下生产者不再往环里折任何东西（官方契约："a producer folds
        // nothing into its done"）——最后一次排水由注册表在落定前自己跑（实测）。
        // await 形态取代 .then 链：官方 JobSpec.run 必须**同步**交出 JobHooks
        // （dts 原文 "Start the work after preflight and synchronously return its
        // hooks"），所以 await 只能装在一枚立即执行的 async 箭头里当场产出
        // Promise<JobOutcome>，不能把 run 本身改成 async（那会让 run 返回 Promise）。
        done: (async () => {
          await proc.done;
          cancelKillTimer();
          return jobOutcomeOf(proc);
        })(),
      };
    },
  };
}

/**
 * 起那条 `zg index --rebuild`：命令构造 + resolve + execute 三步。
 * 任一步抛错即就地 500 并交回 null（调用方直接 return，不再登记）。
 * @param routes 本次注册的共享依赖（现读 config / host）
 * @param res 响应对象（失败时由本函数就地应答）
 * @param root 已过四道前置校验的工作区
 * @param started 本次请求语言的文案表
 * @returns 起来的进程与它跑的命令；失败为 null
 */
async function spawnRebuildProcess(
  routes: RebuildRoutes,
  res: ServerResponse,
  root: string,
  started: ZvecGrepMessages,
): Promise<{ proc: ShellExecution; command: string } | null> {
  const { config, host } = routes;
  const embedding = readDefaultEmbedding(config);
  let spawned: { proc: ShellExecution; command: string };
  try {
    const built = buildIndexCommand({ root, embedding, rebuild: true }, embedding, started);
    const env = hfEndpointEnv(config);
    // 注：后台路径显式带 onExpiry:'none' 取无界（0.1.7 起 bash-local resolve 缺省
    // 'kill'，不传就会被缺省 timeoutMs 杀掉），deadline 由下面宿主 timer 挂的 kill
    // 定时器兜底。stdoutMaxBytes 在 0.1.7 对每次 spawn 都生效（bash-local execute 把
    // spec.stdoutMaxBytes 传进 spawnSpec），它约束的是**执行器**那段缓冲；进了官方环
    // 之后的留存窗另算（retainBytes，实测 262144 UTF-8 字节）。两项都是部署值，现读
    // Config（行 config 改了这里立即跟着走，不留写死的常量分支）。
    const spec = host.shell.resolve({
      command: built.command,
      workdir: built.workdir,
      onExpiry: "none",
      stdoutMaxBytes: config.stdoutMaxBytes,
      ...(env ? { env } : {}),
    });
    spawned = { proc: await host.shell.execute(spec), command: built.command };
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: fill(started.endpointStartFailed, { reason: errorText(error) }),
    });
    return null;
  }
  return spawned;
}

/**
 * 把起来的那条进程登记进官方注册表与本包侧表，交回宿主签发的 id。
 * 三种失败（注册表换人 / 同名不同命 / start 抛错）都已就地应答，交回 null。
 * @param routes 本次注册的共享依赖（jobsOf 现读、侧表引用）
 * @param res 响应对象（失败时由本函数就地应答）
 * @param root 已过前置校验的工作区（写进侧表供卡片回显）
 * @param started 本次请求语言的文案表
 * @param spawned spawnRebuildProcess 交回的进程与命令
 * @returns 宿主签发的 JobId；失败为 null
 */
function attachRebuildJob(
  routes: RebuildRoutes,
  res: ServerResponse,
  root: string,
  started: ZvecGrepMessages,
  spawned: { proc: ShellExecution; command: string },
): JobId | null {
  const { jobsOf, records } = routes;
  const { proc, command } = spawned;
  // 上面 `await host.shell.execute()` 让出了一拍：那期间 `jobs` 可能被关掉或换成另一枚
  // 实例。用** spawn 之前**那枚引用去 prune/start 等于往一枚可能已死的注册表里登记
  // （现在只是恰好不炸：实测已 dispose 的 fiber 上 attachController 抛
  // `cannot create effect on inactive context`，被下面的 catch 收成 500）。现读现用。
  const starting = jobsOf();
  if (starting === undefined) {
    killProc(proc);
    sendJson(res, 503, { ok: false, error: started.endpointJobsUnavailable });
    return null;
  }
  pruneRebuildHistory(starting, records);
  // 丢失记账先于 start：源的 read 可能在 start 里同步跑第一拍。
  const state: RebuildState = { bornAt: 0, owner: null, lost: false, timeoutNote: null };
  let jobId: JobId;
  try {
    jobId = startUnderController(starting, rebuildJobSpec(routes, proc, state, command));
    // 登记进侧表与身份证都在 start **成功之后**：`run()` 里任何一步抛错（宿主 timer 面
    // 已拆就是这一档）都会被官方件按"不注册、序号作废"处理，那时侧表里不该留着这条。
    // 身份证与登记同一步完成：`run()` 若抛错，官方件按"不注册、序号作废"处理（实测），
    // 那时侧表里不该留着这条记录。
    state.bornAt = starting.get(jobId).startedAt;
    state.owner = starting;
    const clashed = records.get(jobId);
    // 同一实例的 id 计数器单调，不重签 ⇒ owner 异即"换过服务"，bornAt 无需再比
    // （比了也是永远为假第二次操作数，白亏分支覆盖）。
    if (clashed !== undefined && clashed.state.owner !== starting) {
      // 同名不同命：`jobs` 那一行被换成另一枚实例，它的计数器又从这个 id 开始分配。
      // 顶掉旧记录会让那张旧面板从此跟着**另一棵树**的重建走（root 当场换人），而旧的
      // zg 也没人再管——两边都是坏结果。所以这里反过来：把刚起的这条收掉、拒绝登记，
      // 并响亮地告诉调用方换过服务了要重载插件。旧那条的记录与超时臂都原样留着。
      killProc(proc);
      sendJson(res, 503, { ok: false, error: started.endpointRegistryReplaced });
      return null;
    }
    records.set(jobId, { proc, root, id: jobId, state });
  } catch (error) {
    replyStartupFailure(res, error, proc, started);
    return null;
  }
  return jobId;
}

/** 启动端点：四道前置校验（同源 / CSRF / 白名单 / 目录存在）后复用或起一条重建。 */
async function handleRebuildStart(
  routes: RebuildRoutes,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { csrf, jobsOf, ledger, messages, records, servingNonLoopback } = routes;
  // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句——先验权威再谈方法/参数。
  if (!guardTrust(req, res, { servingNonLoopback })) {
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { ok: false, error: "POST only" });
    return;
  }
  const guarded = await guardBody(req, res, {
    maxBytes: REBUILD_BODY_MAX_BYTES,
    csrf: { token: csrf, headerName: REBUILD_CSRF_HEADER },
  });
  if (guarded === null) {
    // guardBody 已就地响应（403 跨域 / 403 CSRF / 413 超限 / 400 坏流）。
    return;
  }
  const started = messages();
  const root = acceptableRebuildRoot(req, res, ledger, started);
  if (root === null) {
    return;
  }
  // 同一棵树上已经有重建在跑 ⇒ 把那条的 id 回给这张面板跟随，**不再起第二条进程**：
  // `zg index --rebuild` 是 drop + 重写，两条并发就是两个进程在同一份 `.zvec-grep/` 上互相
  // 啃，还白占共用容量桶的第二格。
  if (followRunningRebuild(jobsOf(), records, res, root)) {
    return;
  }
  const jobs = jobsOf();
  if (jobs === undefined) {
    // 官方注册表不在（宿主没装 dsh-jobs-local）：这条动作没有降级形态——没有环、
    // 没有容量、也没有人能在 job_list 里看到它，起一条没人管的 zg 比不起更糟。
    sendJson(res, 503, { ok: false, error: started.endpointJobsUnavailable });
    return;
  }
  const spawned = await spawnRebuildProcess(routes, res, root, started);
  if (spawned === null) {
    return;
  }
  const jobId = attachRebuildJob(routes, res, root, started, spawned);
  if (jobId === null) {
    return;
  }
  sendJson(res, 200, { ok: true, jobId });
}

/** 轮询端点：官方状态投影 + 退出码/沙箱事实 + 打标后的输出尾窗（卡片每 2s 敲一次）。 */
function handleRebuildStatus(
  routes: RebuildRoutes,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const { jobsOf, messages, records, servingNonLoopback } = routes;
  // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句——先验权威再谈方法/参数。
  if (!guardTrust(req, res, { servingNonLoopback })) {
    return;
  }
  // 自家 isCrossOrigin 支在信任闸门之后不可达：trust 的 sec-fetch-site 白名单更严、错误文本同一句
  // （既有的「跨源 403」用例仍然绿，拒它的是闸门）。
  const jobId = queryParam(req, "jobId");
  // 侧表就是这条投影的授权边界：官方 id 是可预测的 `<kind>-N`（宿主 bash 工具的
  // `bash-1` 同样猜得到），而它不在本包表里 ⇒ 一律 404，绝不代读别人的作业。
  const record = jobId === null || jobId === "" ? undefined : records.get(jobId);
  if (record === undefined) {
    // 历史窗口用尽后旧 jobId 会消失——给出可行动提示，而非裸 404 让卡片只显示"查询状态失败"。
    sendJson(res, 404, {
      ok: false,
      error: fill(messages().unknownJobId, { maxJobs: REBUILD_HISTORY_MAX }),
    });
    return;
  }
  const marks = messages();
  const jobs = jobsOf();
  if (jobs === undefined) {
    // 与启动端点同一口径：注册表不在就没有读数。这条分支在"服务起得来、后来被关掉"
    // 那一档才走到（侧表里还有记录），此时进程可能仍在跑，由卸载效应负责收。
    sendJson(res, 503, { ok: false, error: marks.endpointJobsUnavailable });
    return;
  }
  const output = readRebuildOutput(jobs, record.id);
  if (output === null) {
    // 名册里已经没有这条了（`jobs` 那一行被重载 ⇒ 它清空名册，或记录已被别人收走）。
    // 侧表条目留着——它还钉着 proc，卸载时那一臂要凭它杀进程——但这一轮只能答 404。
    sendJson(res, 404, {
      ok: false,
      error: fill(marks.unknownJobId, { maxJobs: REBUILD_HISTORY_MAX }),
    });
    return;
  }
  if (!sameJob(record.state, output.view, jobs)) {
    // 同名不同命：`jobs` 那一行被重载后新实例重新签发了这个 id。旧卡片读不到新作业，
    // 新作业也不许被旧卡片的轮询/超时/卸载臂碰到。
    sendJson(res, 404, {
      ok: false,
      error: fill(marks.unknownJobId, { maxJobs: REBUILD_HISTORY_MAX }),
    });
    return;
  }
  const { view, retained } = output;
  // 状态取官方投影（多出的 stopping/failed 由卡片按"仍在跑/出错"归位），退出码与沙箱
  // 事实仍从 proc 现读——JobView 没有这两个槽。这一对读都是**非消费**的：
  // 卡片每 2s 一次轮询，不许把模型的 job_output 游标推走（实测台架第 7 条）。
  const text = retained.chunks.map((chunk) => chunk.text).join("");
  // shown/total 一律按 **UTF-16 码元**计数（命名口径：`.length` 就是码元，
  // 文案说的"字符"也是它）；环的留存按 UTF-8 字节裁，两套单位各管各的，别混称。
  // 切点走 shared 的 truncateStart：官方环的裁切按 UTF-8 边界，但我们这道 4000 的
  // 尾切若用裸 slice 会在切点留下孤立低代理项。
  const shown = truncateStart(text, JOB_OUT_VIEW_CHARS);
  const viewMark =
    text.length > JOB_OUT_VIEW_CHARS
      ? fill(marks.jobOutputView, { shown: JOB_OUT_VIEW_CHARS, total: text.length })
      : "";
  sendJson(res, 200, {
    ok: true,
    status: view.status,
    exitCode: record.proc.exitCode,
    root: record.root,
    // 沙箱事实原样透传：runnerFailed 让卡片判「未执行」而非「完成」。
    ...(record.proc.sandbox === undefined ? {} : { sandbox: record.proc.sandbox }),
    // 打标顺序 = 环裁过头部 → 泵读不到过字节 → 超时 → 沙箱事实 → 尾窗说明 → 正文。
    // 后两条从前是**写进环尾**的，现在由投影层合成：注册表在落定之后丢弃一切写入
    // （实测），把"为什么这次重建没跑成"寄存在一条会被丢掉的写上，正是最不该丢的信息。
    output:
      // 两条丢失各自独立可观测：`earliest > 0` 是官方环按留存窗裁掉了头部（显示口径）；
      // `state.lost` 是执行器的读者报 lossy 或干脆抛了（真少了字节，可能有 spill 文件）。
      // 合用一条标就会把"看不见了"说成"没跑出来"。
      (view.output.earliest > 0 ? marks.jobOutputTruncated : "") +
      (record.state.lost ? marks.jobOutputLost : "") +
      (record.state.timeoutNote ?? "") +
      (procSandboxNote(record.proc, marks) ?? "") +
      viewMark +
      shown,
  });
}

/**
 * 卸载效应的收口：三条路由已由调用方摘掉，这里把侧表里的进程与在册作业收干净。
 * @param routes 本次注册的共享依赖（jobsOf 现读、侧表引用、文案现取）
 * @returns {void}
 */
function releaseRebuildRecords(routes: RebuildRoutes): void {
  const { jobsOf, messages, records } = routes;
  // 注册表随宿主活着，**不**随本插件卸载而死：在跑的作业必须我们杀（否则那条 zg 继续
  // 读整棵树，而且再没有人能在 job_list 里收它）；已落定的顺手 remove（环还占着宿主内存）。
  // 刚被 kill 的那几条此刻移不走（官方件不许删在跑作业），由下一次 apply 的
  // pruneRebuildHistory 按 kind 清掉——那正是它遍历 `list()` 而不是遍历侧表的原因。
  // reason 在这里就算好，不留到循环里现取：文案要走官方 locale 的翻译服务，而卸载效应
  // 跑到一半时本包 fiber 已经在拆。
  const unloadReason = messages().jobReasonUnload;
  const jobs = jobsOf();
  if (jobs === undefined) {
    // 注册表已经不在了（`jobs` 那一行被关掉/重载 ⇒ 它清空了名册）：没东西可标记，
    // 但进程还是我们的，只把它们收干净。
    for (const record of records.values()) {
      killProc(record.proc);
    }
  } else {
    for (const record of records.values()) {
      const view = jobView(jobs, record.id);
      if (view === null || !sameJob(record.state, view, jobs)) {
        // 名册里没有这条（已被别人收走），或者同名不同命（`jobs` 换过一枚实例）：
        // 两种都只剩我们手里的进程可收，绝不去 kill/remove 别人那条健康作业。
        killProc(record.proc);
      } else if (isLiveStatus(view.status)) {
        // 走注册表而不是直接杀进程：官方件据此把记录推到 stopping、把 reason 落进
        // detail，再经本包的 cancel() 收到 proc.kill()。绕过它会让模型名册里那条
        // 永远停在 running，环也一直不关（实测：本包测试就先被这条抓到过）。
        jobs.kill(record.id, undefined, unloadReason);
      } else {
        jobs.remove(record.id);
      }
    }
  }
  records.clear();
}

/** 设置卡片的「工作区重建」端点组（引导 / 启动 / 轮询）。按语义拆离 apply 主体。 */
function registerRebuildEndpoints(deps: RebuildEndpointDeps): void {
  const { ctx, host, config, csrf, ledger, messages } = deps;
  // 官方 `Context["get"]` 交出的是整个 `WebServer` 类；这里显式收回本包的方法面投影，
  // 于是「只用 register」仍是编译期约束（误用别的成员即报错），不必再镜像一次签名。
  const webServer: WebServerService | undefined = host.get("webServer");
  if (!webServer) {
    return;
  }

  // 非回环服务面唯一的可读信号（installed dsh-host-webserver d.ts `:50`/`:83`）。
  const servingNonLoopback = webServer.host === "0.0.0.0";
  // 后台重建交给官方注册表（ctx.jobs）：环、留存、容量、生命周期，以及"模型侧
  // job_list/job_output/job_kill 看不看得见这次重建"都在它那边。
  //
  // **每次用时现读**，不在闭包里钉住一枚实例。`ctx.get` 是无 inject 语义的存储读（官方
  // reflect.d.ts："or `undefined` when not (yet) provided"，实测读一次就只那一次）——
  // 在 apply 里读会把两种正常事件变成永久故障：服务比本插件晚到位 ⇒ 启动端点从此一直
  // 回答 503（还指着用户去装一个其实装好了的包）；服务被重载 ⇒ 从此往一枚已销毁的实例里
  // 起作业。本包也不把 `jobs` 列进 `inject` 名单：那会让缺席的**整张设置卡**三条路由都不
  // 注册（实测 inject 会一直等依赖），而缺席只该让"启动/轮询"这一档不可用。
  const jobsOf = (): JobsService | undefined => host.get("jobs");
  // 本包侧表。键是**普通字符串**（查询参数直接能对上），真正的 `JobId` 存在记录里
  // （`record.id`，宿主签发的高价值 id）——回环时只用记录里那一枚，绝不把请求带来
  // 的字符串塞给注册表，于是"表里没有即 404"这条边界不需要任何类型断言撑着。
  const records = new Map<string, RebuildRecord>();
  const routes: RebuildRoutes = {
    host,
    config,
    csrf,
    ledger,
    messages,
    jobsOf,
    records,
    servingNonLoopback,
  };

  // 引导端点：卡片先拿 CSRF token 与可选工作区列表（都是本插件自己的数据）。
  // 也带同源校验——token 泄露给跨源页面等于白名单 + CSRF 两道锁一起白给。
  const disposeRoots = webServer.register({
    kind: "exact",
    path: REBUILD_ROOTS_PATH,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      handleRebuildRoots(routes, req, res);
    },
  });
  // 启动端点：POST + 同源 + CSRF（guardBody 三道一次做完）+ 白名单 root + 目录存在。
  // 旧实现只查 `startsWith("/")`：任何能连到 webServer（可配 0.0.0.0）的一方都能
  // 拿任意绝对路径触发 `zg index --rebuild`——读遍那棵树、写 .zvec-grep/、
  // 还可能把其中的非隐藏敏感文件灌进向量库并回显到上下文。
  const disposeRebuild = webServer.register({
    kind: "exact",
    path: REBUILD_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      await handleRebuildStart(routes, req, res);
    },
  });
  // 轮询端点：卡片每 2s 一次的读数（状态 / 退出码 / 沙箱事实 / 输出尾窗）。
  const disposeStatus = webServer.register({
    kind: "exact",
    path: REBUILD_STATUS_PATH,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      handleRebuildStatus(routes, req, res);
    },
  });

  ctx.effect(
    () => () => {
      disposeRoots();
      disposeRebuild();
      disposeStatus();
      releaseRebuildRecords(routes);
    },
    "zvec-grep: rebuild endpoints",
  );
}

/**
 * 页面策略声明：本包自带设置卡片，别让宿主再生成一份自动表单页。
 *
 * 0.1.7 起命名空间是**隐式**的：宿主把本条目导出的 Config 里标了 `.volatile()` 的
 * 字段投影成设置表单，ns = profile 条目 id（`zvec-grep`，见 cordis.patch.yml）。
 * 插件侧不再注册、也不再交 base（内置默认已落成 schema 的 `.default()`，cordis 装载期
 * 按它校验行 config 后把引用交进 apply 的 config 参数），只剩这一条页面策略声明。
 * owner 必须显式传本插件 fiber（缺省是 settings 服务自己的 fiber），且经 child.effect
 * 挂载以便随注入子上下文回收——宿主 dsh-client-locale 同款写法。
 * @param host 已通过服务面守卫的宿主上下文
 * @returns {void}
 */
function configureSettingsPage(host: HostCtx): void {
  host.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, host.fiber));
  });
}

/**
 * 文案语言随官方 locale 偏好走的读取器：用户在「设置 → 常规」里改语言后，下一次工具回显、
 * guard 拒绝与端点应答就是新文案（不重启、不加本包自己的 locale 设置项）。
 * 跨命名空间读在 0.1.7 只有 describe() 一条路：挑出 ns === 'locale' 那条的 value
 * （未装 client-locale / 该条目未被投影 → undefined → 中文默认）。
 * @param host 已通过服务面守卫的宿主上下文
 * @returns 每次现取一份文案的 thunk
 */
function createLocaleMessages(host: HostCtx): () => ZvecGrepMessages {
  return () =>
    messagesFor(
      MESSAGES,
      resolveLocalePreference(
        host.settings.describe().find((row) => row.ns === LOCALE_SETTINGS_NAMESPACE)?.value,
      ),
    );
}

/** 观测到的工作区：既给重建端点当白名单，也让卡片能列出可重建的 root。 */
function trackObservedRoot(ledger: RootLedger, exec: ToolExec): void {
  const cwd = sessionHeaderCwd(exec);
  if (cwd !== undefined) {
    ledger.add(cwd);
  }
}

/** 会话分片的条数上限：常驻进程只增不减会随会话数无界增长，超上限按插入序淘汰最早的分片。 */
const MAX_UNLOCK_SESSIONS = 256;

/** search-first 门禁的会话解锁表（发放 / 查额度 / 消耗一次配额）。 */
interface UnlockLedger {
  grant: (sessionKey: string, indexRoot: string) => void;
  lookup: (sessionKey: string, indexRoot: string) => SearchUnlock | undefined;
  consume: (unlock: SearchUnlock) => void;
}

/**
 * search-first 门禁解锁表：会话 → (归一化索引根 → 解锁额度)。
 * 每次成功 zg_search 发放 grepBudgetPerSearch 次配额、unlockWindowMin 分钟有效；
 * 配额用尽/过期后 grep/rg 再被拦，促使模型换更准的 query 重新语义检索。
 * 配额与时效都在发放/校验时**现读** config（行 config 改了立即跟着走）。
 * @param config apply 收到的那份 volatile 引用配置
 * @returns 会话解锁表（随 apply 闭包里的 Map 一起生死）
 */
function createUnlockLedger(config: Config): UnlockLedger {
  const unlocksBySession = new Map<string, Map<string, SearchUnlock>>();
  return {
    grant(key: string, indexRoot: string): void {
      let byRoot = unlocksBySession.get(key);
      if (byRoot === undefined) {
        byRoot = new Map();
        unlocksBySession.set(key, byRoot);
        // 常驻进程按会话数有界：超上限淘汰最早的会话分片（含其全部索引根额度）。
        trimMapTo(unlocksBySession, MAX_UNLOCK_SESSIONS);
      }
      byRoot.set(normalizeRoot(indexRoot), {
        grepsLeft: readGrepBudget(config),
        expiresAt: Date.now() + readUnlockWindowMin(config) * 60_000,
      });
    },
    lookup(sessionKey: string, indexRoot: string): SearchUnlock | undefined {
      return unlocksBySession.get(sessionKey)?.get(normalizeRoot(indexRoot));
    },
    consume(unlock: SearchUnlock): void {
      unlock.grepsLeft -= 1;
    },
  };
}

/** apply 递给三位工具注册与 guard 的运行时依赖（闭包量对象化以避开 max-params）。 */
interface PluginRuntime {
  host: HostCtx;
  /** apply 收到的那份 volatile 引用配置：每个执行点现读。 */
  config: Config;
  /** 现取一份文案（语言随官方 locale 偏好）。 */
  messages: () => ZvecGrepMessages;
  ledger: RootLedger;
  unlocks: UnlockLedger;
  /** 索引探测的按目录缓存（同一 apply 内 guard 与 zg_search 共用一份，见 createIndexProbeCache）。 */
  indexProbe: (dir: string) => boolean;
}

/** 工具参数面的返回类型：从本包 ToolSpec 投影，不重述官方 JSON Schema 形状。 */
type ToolParameters = ToolSpec["parameters"];

/** zg_search 的参数面：逐字段描述都取注册期文案（与 parameters 同生死）。 */
function searchToolParameters(registered: ZvecGrepMessages): ToolParameters {
  return {
    type: "object",
    properties: {
      root: { type: "string", description: registered.rootSearchDescription },
      query: { type: "string", description: registered.queryDescription },
      queries: {
        type: "array",
        items: { type: "string" },
        description: registered.queriesDescription,
      },
      fts: { type: "array", items: { type: "string" }, description: registered.ftsDescription },
      vector: {
        type: "array",
        items: { type: "string" },
        description: registered.vectorDescription,
      },
      fuse: { type: "boolean", description: registered.fuseDescription },
      limit: { type: "integer", description: registered.limitDescription },
      globs: {
        type: "array",
        items: { type: "string" },
        description: registered.globsDescription,
      },
      insensitiveGlobs: {
        type: "array",
        items: { type: "string" },
        description: registered.insensitiveGlobsDescription,
      },
      fileTypes: {
        type: "array",
        items: { type: "string" },
        description: registered.fileTypesDescription,
      },
      excludedFileTypes: {
        type: "array",
        items: { type: "string" },
        description: registered.excludedFileTypesDescription,
      },
      symbolTypes: {
        type: "array",
        items: { type: "string" },
        description: registered.symbolTypesDescription,
      },
      preferSymbol: { type: "boolean", description: registered.preferSymbolDescription },
      modifiedAfter: { type: "string", description: registered.modifiedAfterDescription },
      modifiedBefore: { type: "string", description: registered.modifiedBeforeDescription },
      device: { type: "string", description: registered.deviceDescription },
    },
  };
}

/**
 * zg_search 的执行体：登记工作区 → 构造命令 → 前台执行 → 命中索引即给本会话发放该根的配额。
 * @param runtime apply 的运行时依赖（config 现读、解锁表与探测缓存共用）
 * @param args 官方 deep-frozen 后的工具入参
 * @param exec 执行面（signal / 会话工作区）
 * @param messages 本次 execute 现取的文案表
 * @returns 交给官方 output schema 的 `{ text }`
 */
async function runSearchTool(
  runtime: PluginRuntime,
  args: Record<string, unknown>,
  exec: ToolExec,
  messages: ZvecGrepMessages,
): Promise<{ text: string }> {
  const { config, host, indexProbe, ledger, unlocks } = runtime;
  // 官方 tool.execute 传的是 deep-frozen 参数（strict ESM 下写入直接抛
  // TypeError）：先克隆再补默认 limit，绝不写原 args。
  // SearchArgs 全字段 unknown，直接由 Record 以解构投影（不做 any 断言）。
  trackObservedRoot(ledger, exec);
  const resolvedRoot = rootOf(args, exec, messages);
  const searchArgs: SearchArgs = {
    ...args,
    // root 缺省=当前会话工作区（0.1.5 ToolExecution.agent 面，官方同模式）。
    root: resolvedRoot,
    limit: args["limit"] ?? readDefaultLimit(config),
  };
  const { command, workdir } = buildSearchCommand(searchArgs, messages);
  // 超时/stdout 上限是部署值：现读 Config（非 volatile 普通值，行 config 可改）。
  const text = await runForeground(host, command, workdir, config.searchTimeoutMs, {
    signal: exec.signal,
    env: hfEndpointEnv(config),
    stdoutMaxBytes: config.stdoutMaxBytes,
    messages,
    // 命中摘要（仅 search）：limit 用与命令同一 clamp，摘要口径与实际请求一致。
    summaryLimit: clampLimit(searchArgs.limit),
  });
  // search-first 门禁发放：仅成功（runForeground 失败即抛，不会走到这里）才给
  // 本会话发放「该索引根（root 或其含索引的最近祖先）」的 grep/rg 配额。
  // 探测走 apply 闭包里的按目录缓存（与 guard 同一份），命中即 0 次 existsSync。
  const indexRoot = findIndexRoot(resolvedRoot, indexProbe);
  if (indexRoot !== undefined) {
    unlocks.grant(sessionKeyOf(exec), indexRoot);
  }
  return { text };
}

/** 注册 zg_search：语义/混合检索。 */
function registerSearchTool(runtime: PluginRuntime, registered: ZvecGrepMessages): void {
  define(runtime.host, {
    name: "zg_search",
    description: registered.searchToolDescription,
    messages: runtime.messages,
    parameters: searchToolParameters(registered),
    run: (args, exec, messages) => runSearchTool(runtime, args, exec, messages),
  });
}

/** zg_index 的参数面：`confirm` 必填（guard 兜底见 registerToolGuards）。 */
function indexToolParameters(registered: ZvecGrepMessages): ToolParameters {
  return {
    type: "object",
    properties: {
      root: { type: "string", description: registered.rootIndexDescription },
      confirm: { type: "boolean", description: registered.confirmDescription },
      embedding: { type: "string", description: registered.embeddingDescription },
      rebuild: { type: "boolean", description: registered.rebuildDescription },
      drop: { type: "boolean", description: registered.dropDescription },
      globs: {
        type: "array",
        items: { type: "string" },
        description: registered.globsIndexDescription,
      },
      insensitiveGlobs: {
        type: "array",
        items: { type: "string" },
        description: registered.insensitiveGlobsDescription,
      },
      fileTypes: {
        type: "array",
        items: { type: "string" },
        description: registered.fileTypesIndexDescription,
      },
      excludedFileTypes: {
        type: "array",
        items: { type: "string" },
        description: registered.excludedFileTypesDescription,
      },
      ignoreFiles: {
        type: "array",
        items: { type: "string" },
        description: registered.ignoreFilesDescription,
      },
      excludeSecrets: { type: "boolean", description: registered.excludeSecretsDescription },
      hidden: { type: "boolean", description: registered.hiddenDescription },
      noIgnore: { type: "boolean", description: registered.noIgnoreDescription },
      maxDepth: { type: "integer", description: registered.maxDepthDescription },
      maxFileSizeBytes: { type: "integer", description: registered.maxFileSizeBytesDescription },
      follow: { type: "boolean", description: registered.followDescription },
      embeddingConcurrency: {
        type: "integer",
        description: registered.embeddingConcurrencyDescription,
      },
      device: { type: "string", description: registered.deviceDescription },
    },
    // zg_index 仍强制 confirm=true（guard 兜底），root 缺省=当前会话工作区。
    required: ["confirm"],
  };
}

/**
 * zg_index 的执行体：登记工作区 → 建/重建/删索引命令 → 前台执行（文本原样透传）。
 * @param runtime apply 的运行时依赖
 * @param args 官方 deep-frozen 后的工具入参
 * @param exec 执行面（signal / 会话工作区）
 * @param messages 本次 execute 现取的文案表
 * @returns 交给官方 output schema 的 `{ text }`
 */
async function runIndexTool(
  runtime: PluginRuntime,
  args: Record<string, unknown>,
  exec: ToolExec,
  messages: ZvecGrepMessages,
): Promise<{ text: string }> {
  const { config, host, ledger } = runtime;
  // IndexArgs 全字段 unknown：直接由 Record 构造，不做 any 断言。
  trackObservedRoot(ledger, exec);
  const indexArgs: IndexArgs = {
    ...args,
    root: rootOf(args, exec, messages),
  };
  const { command, workdir } = buildIndexCommand(indexArgs, readDefaultEmbedding(config), messages);
  const text = await runForeground(host, command, workdir, config.indexTimeoutMs, {
    signal: exec.signal,
    env: hfEndpointEnv(config),
    stdoutMaxBytes: config.stdoutMaxBytes,
    messages,
  });
  return { text };
}

/** 注册 zg_index：建/重建/删索引。 */
function registerIndexTool(runtime: PluginRuntime, registered: ZvecGrepMessages): void {
  define(runtime.host, {
    name: "zg_index",
    description: registered.indexToolDescription,
    messages: runtime.messages,
    parameters: indexToolParameters(registered),
    run: (args, exec, messages) => runIndexTool(runtime, args, exec, messages),
  });
}

/**
 * zg_status 的执行体：登记工作区 → `zg status` → 文本原样透传。
 * @param runtime apply 的运行时依赖
 * @param args 官方 deep-frozen 后的工具入参
 * @param exec 执行面（signal / 会话工作区）
 * @param messages 本次 execute 现取的文案表
 * @returns 交给官方 output schema 的 `{ text }`
 */
async function runStatusTool(
  runtime: PluginRuntime,
  args: Record<string, unknown>,
  exec: ToolExec,
  messages: ZvecGrepMessages,
): Promise<{ text: string }> {
  const { config, host, ledger } = runtime;
  trackObservedRoot(ledger, exec);
  const { command, workdir } = buildStatusCommand({ root: rootOf(args, exec, messages) }, messages);
  const text = await runForeground(host, command, workdir, config.statusTimeoutMs, {
    signal: exec.signal,
    env: hfEndpointEnv(config),
    stdoutMaxBytes: config.stdoutMaxBytes,
    messages,
  });
  return { text };
}

/** 注册 zg_status：索引状态。 */
function registerStatusTool(runtime: PluginRuntime, registered: ZvecGrepMessages): void {
  define(runtime.host, {
    name: "zg_status",
    description: registered.statusToolDescription,
    messages: runtime.messages,
    parameters: {
      type: "object",
      properties: {
        root: { type: "string", description: registered.rootStatusDescription },
      },
    },
    run: (args, exec, messages) => runStatusTool(runtime, args, exec, messages),
  });
}

/** 三位 zg_* 工具的注册入口：描述与参数面都取注册期文案，执行体共用同一份运行时依赖。 */
function registerZvecTools(runtime: PluginRuntime, registered: ZvecGrepMessages): void {
  registerSearchTool(runtime, registered);
  registerIndexTool(runtime, registered);
  registerStatusTool(runtime, registered);
}

/** 硬规则段（systemPrompt）：文本取注册期文案，随注册一次性交给宿主。 */
function registerRoutingSection(host: HostCtx, registered: ZvecGrepMessages): void {
  host.systemPrompt.section({
    name: ROUTING_NAME,
    order: ROUTING_ORDER,
    text: registered.routingText,
  });
}

/**
 * 安全兜底 guard（只拦 zg_*）+ search-first 门禁（拦 bash/pwsh 里的 grep/rg
 * 检索与原生 grep 工具）。前者拒绝安全风险，后者拒绝检索顺序违规：每次成功
 * zg_search 发放配额（次数/时效见设置），用尽/过期再拦。两谓词均纯函数，
 * 索引探测（缓存化，见 createIndexProbeCache）、时钟与会话解锁表由运行时依赖注入。
 * guard 是**每个**工具调用都会经过的观测点：顺手把该会话的工作区记进重建白名单
 * （agent.session.header.cwd 由 harness 写，模型改不了，故可作为可信来源）。
 * 这里不给 `execution` 标注类型：官方 ToolGuard 交出 `Readonly<ToolExecution>`，
 * 于是 name/arguments/signal/agent 的键名与值域都由宿主声明负责——两个谓词收到的
 * 是本包加宽后的读取投影（lib/routing.ts），加宽即容错，收窄校验留在谓词内部。
 * @param runtime apply 的运行时依赖
 * @returns {void}
 */
function registerToolGuards(runtime: PluginRuntime): void {
  const { config, host, indexProbe, ledger, messages: localeMessages, unlocks } = runtime;
  host.tools.guard((execution) => {
    trackObservedRoot(ledger, execution);
    const messages = localeMessages();
    const zg = zgGuard(execution, messages);
    if (zg !== undefined) {
      return zg;
    }
    return searchFirstGuard(
      execution,
      {
        enabled: readEnforceSearchFirst(config),
        // 探测走 apply 里的按目录缓存（P2）：同一工作区的连续 guard 调用命中
        // 同一串祖先目录，最多 9 次 existsSync 降为 0 次；失效策略见 createIndexProbeCache。
        indexProbe,
        now: () => Date.now(),
        grepBudget: readGrepBudget(config),
        windowMin: readUnlockWindowMin(config),
        lookupUnlock: (indexRoot) => unlocks.lookup(sessionKeyOf(execution), indexRoot),
        consumeGrep: (unlock) => {
          unlocks.consume(unlock);
        },
      },
      messages,
    );
  });
}

/**
 * 设置卡片的「工作区重建」端点组（引导 + 后台进程 + 轮询状态）。
 *
 * ⚠ 这三条路由的归属方必须对 webServer **建立依赖**，不能在 apply 里读一次就算完：
 * `ctx.get` 是无 inject 语义的存储读（官方 reflect.d.ts:10-14 明写 "or `undefined`
 * when not (yet) provided"），而真实宿主上 webServer 比本条目晚到位——隔离 DSH_HOME
 * 实测 apply 当场读到 undefined、+1.3s 才交得出实例。旧写法的结果是三条路由在任何
 * web profile 上都不注册，卡片的「工作区重建」永远 404。子 fiber 只在依赖到位时激活、
 * 依赖换实例时先卸后装（registry.d.ts:97），故效应挂在**子上下文**上即得「后到即注册、
 * 重启即重注册」。不写进插件级 inject：那会让没有 webServer 的宿主（TUI）连三个工具
 * 一并失活。
 * @param runtime apply 的运行时依赖（host / config / 白名单 / 文案读取器）
 * @param csrf 本次 apply 生成的 CSRF token
 * @returns {void}
 */
function registerRebuildRoutes(runtime: PluginRuntime, csrf: string): void {
  const { config, host, ledger, messages } = runtime;
  host.inject(["webServer"], (child) => {
    registerRebuildEndpoints({
      ctx: child,
      host,
      config,
      csrf,
      ledger,
      messages,
    });
  });
}

function apply(ctx: Context, config: Config): void {
  // inject 服务面运行期保证存在；守卫理论不失败，失败即硬错快速暴露。
  if (!isZvecGrepHost(ctx)) {
    throw new Error(
      "[zvec-grep] required services (settings/shell/tools/systemPrompt/timer/get) missing",
    );
  }
  const host = ctx;

  configureSettingsPage(host);
  const localeMessages = createLocaleMessages(host);

  // 重建端点的两道锁：每次 apply 重新生成的 CSRF token（webServer 可绑 0.0.0.0，
  // sec-fetch-site 只是浏览器侧的纵深防御，本地进程可伪造/直连）+ 工作区白名单
  // （只认本 daemon 真实观测到过的会话工作区，见 createRootLedger）。
  // token 形态与本仓其余五包统一为 `randomUUID()`（此前只有本包是 hex，
  // 而那条断言只验长度 ⇒ 形态分歧没人钉得住）。熵不减（122 bit 随机 vs 128 bit）。
  const csrf = randomUUID();
  const ledger = createRootLedger(localeMessages());

  // zg 索引探测的按目录缓存（P2）与 search-first 解锁表都随 apply 闭包生死（重载即清空），
  // guard 与三位工具的执行为此共用同一份实例——选型论证见 createIndexProbeCache。
  const runtime: PluginRuntime = {
    host,
    config,
    messages: localeMessages,
    ledger,
    unlocks: createUnlockLedger(config),
    indexProbe: createIndexProbeCache(indexProbeOf),
  };

  // 注册期文案（工具描述 + 参数说明）：语言取 apply 当时的官方偏好，与 parameters
  // 同生死（宿主按注册时的描述喂模型）；执行期回显则每次 execute 现取。
  const registered = localeMessages();
  registerZvecTools(runtime, registered);
  registerRoutingSection(host, registered);
  registerToolGuards(runtime);
  registerRebuildRoutes(runtime, csrf);
}

export default {
  inject: ["settings", "shell", "tools", "systemPrompt", "timer"],
  // 隐式注册靠的就是这个键：宿主按它校验行 config、投影 volatile 字段（ns = 条目 id）。
  Config: configSchema,
  apply,
};
