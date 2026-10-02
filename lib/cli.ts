// lib/cli.ts —— 纯函数：把 zg_* 工具的入参安全地构造成 zg CLI 命令。
// 无 ctx、无副作用，可独立单测。所有用户可控字符串一律经 shq() 单引号转义，
// root 只走 workdir 字段（query）或转义后的位置参数（index/status）。
//
// 报错文案双语：本文件的校验文本都会原样回显给模型（工具失败信息），故消息表
// （lib/messages.ts 的一份）由调用点作入参注入——纯函数不读设置，宿主传
// `messagesFor(MESSAGES, …)` 的结果，单测直接喂字典。
//
// 入参校验为什么全在这里：harness 的 tools 注册面对 `parameters` JSON Schema
// 只做「输出」校验，`ToolRegistry` 直接把 `exec.arguments` 原样交给
// `execute`（packages/core/tools/src/index.ts:1580 `tool.execute(exec.arguments, exec)`），
// 模型给的类型错误不会在框架层报错。宽松取值（`x === true`）会让 `{rebuild:1}` 静默走增量、
// `{hidden:"true"}` 静默失效——用户以为重建/含隐藏了，实际没有。故本文件的
// 每个取值器都是「非法定类型即抛错」。

import { fill } from "./messages.ts";
import type { ZvecGrepMessages } from "./messages.ts";
import {
  MAX_COMMAND_BYTES,
  MAX_FILTER_CHARS,
  MAX_QUERY_CHARS,
  MAX_QUERY_ROUTES,
  SECRET_EXCLUDE_GLOBS,
  optionalText,
  shq,
  singleOrList,
  stringList,
} from "./argv-guard.ts";
// 本地 embedding 候选清单：构造期 allowlist 的唯一来源，与设置卡的 <select> 共用同一份。
import { LOCAL_EMBEDDINGS, isLocalEmbedding } from "./embedding-catalog.ts";

const LIMIT_MIN = 1;
const LIMIT_MAX = 50;
export const DEFAULT_LIMIT = 10;

/**
 * zg 客户端传输模式，三档与 zg 命令行 `--mode` 的字面量同域。取值域由下表的键推导，
 * 声明与名单同源，改名单不会留下一个推导不出来的类型。
 *
 * 缺省取 `auto` 而不是 `direct`：`direct` 在 zg 守护进程持有该根的索引租约时会直接失败
 * （报「守护进程拥有索引写权限」），而守护进程可能由用户自己的 zvec-grep MCP 或一次
 * `zg server on` 引入，插件无法假定它不存在。`auto` 在守护进程在跑时走守护进程、不在跑
 * 时回落直连，两种状态实测检索与索引均正常。
 *
 * `server` 不做兜底：守护进程没起时它直接报连接探测失败而**不会**回落，故只作为部署显式
 * 选择，取值时必须让用户知道需要自己先起守护进程。
 */
const CLIENT_MODE_TABLE = { auto: "auto", direct: "direct", server: "server" } as const;

export type ClientMode = keyof typeof CLIENT_MODE_TABLE;

const CLIENT_MODE_NAMES: readonly string[] = Object.keys(CLIENT_MODE_TABLE);

/** 缺省传输模式：有守护进程就用守护进程，没有就直连。 */
export const DEFAULT_CLIENT_MODE: ClientMode = "auto";

/** 类型谓词（不是类型断言）：把 string 收窄到模式域，供取值器零断言收窄。 */
function isClientMode(value: string): value is ClientMode {
  return CLIENT_MODE_NAMES.includes(value);
}

/**
 * 传输模式取值器：缺省回缺省域，其余非本域取值一律报错。
 * 宿主侧配置已由 schema 校验过，这道取值器是命令行构造边界的最后一道闸，与同文件其余
 * 取值器同一口径——绝不把一个守护进程并不认识的模式串静默拼进命令。
 */
export function clientModeOf(value: unknown, messages: ZvecGrepMessages): ClientMode {
  if (value === undefined || value === null) {
    return DEFAULT_CLIENT_MODE;
  }
  if (typeof value !== "string" || !isClientMode(value)) {
    throw new TypeError(
      fill(messages.clientModeInvalid, {
        received: typeof value === "string" ? value : typeof value,
        allowed: CLIENT_MODE_NAMES.join(" | "),
      }),
    );
  }
  return value;
}

/**
 * 传输模式旗标。取值来自闭集且已由取值器校验过，不含用户可控字符，故不加引号——与设备
 * 旗标不同，那一枚的值由用户直接给出，必须转义。
 */
function modeFlag(mode: ClientMode): string {
  return `--mode ${mode}`;
}

/**
 * 预览档位。原先硬编码 `short` 是有意为之（每命中带一段有界源码，模型少读几次文件就能
 * 判断相关性），但它是本包替模型做的选择：当模型要找的就是**完整**函数体时，`short`
 * 的窗口反而挡路。故开放成参数，缺省仍是 `short`，行为不回退。
 */
const PREVIEW_TABLE = { none: "none", short: "short", full: "full" } as const;

export type PreviewMode = keyof typeof PREVIEW_TABLE;

/** 合法预览档位名单，外供工具参数面的 JSON Schema `enum`，与取值器同一份来源。 */
export const PREVIEW_NAMES: readonly string[] = Object.keys(PREVIEW_TABLE);

/** 缺省预览档位：有界源码窗口，既不空手而归也不撑爆上下文。 */
export const DEFAULT_PREVIEW: PreviewMode = "short";

function isPreviewMode(value: string): value is PreviewMode {
  return PREVIEW_NAMES.includes(value);
}

export function previewOf(value: unknown, messages: ZvecGrepMessages): PreviewMode {
  if (value === undefined || value === null) {
    return DEFAULT_PREVIEW;
  }
  if (typeof value !== "string" || !isPreviewMode(value)) {
    throw new TypeError(
      fill(messages.previewInvalid, {
        received: typeof value === "string" ? value : typeof value,
        allowed: PREVIEW_NAMES.join(" | "),
      }),
    );
  }
  return value;
}

/**
 * 刷新策略。原先硬编码 `wait`：检索前把索引刷到最新，代价是慢。
 *
 * `background` 要单独说明：它**只在守护进程模式下成立**，直连模式下 zg 不报错，而是
 * 静默降级成 `off` 并往 stderr 打一行 warning（实测原文：`warning: --refresh background
 * requires Server mode; Direct mode uses --refresh off`）。本包把 stderr 原样回显，
 * 所以那一行会自己到模型眼前，不必在这里再造一条假解释；此处只把这条已知降级写进
 * 参数说明，避免模型选了 `background` 却以为索引在后台真的被刷新了。
 */
const REFRESH_TABLE = { background: "background", wait: "wait", off: "off" } as const;

export type RefreshPolicy = keyof typeof REFRESH_TABLE;

/** 合法刷新策略名单，外供工具参数面的 JSON Schema `enum`，与取值器同一份来源。 */
export const REFRESH_NAMES: readonly string[] = Object.keys(REFRESH_TABLE);

/** 缺省刷新策略：等索引刷到最新再检索（索引刚被本插件重建过时，这一条尤其重要）。 */
export const DEFAULT_REFRESH: RefreshPolicy = "wait";

function isRefreshPolicy(value: string): value is RefreshPolicy {
  return REFRESH_NAMES.includes(value);
}

export function refreshOf(value: unknown, messages: ZvecGrepMessages): RefreshPolicy {
  if (value === undefined || value === null) {
    return DEFAULT_REFRESH;
  }
  if (typeof value !== "string" || !isRefreshPolicy(value)) {
    throw new TypeError(
      fill(messages.refreshInvalid, {
        received: typeof value === "string" ? value : typeof value,
        allowed: REFRESH_NAMES.join(" | "),
      }),
    );
  }
  return value;
}

/**
 * 符号类型闭集，六个取值逐字抄自 zg 命令行 `--symbol-type` 的帮助文本
 * （`module, class, interface, function, value, alias`）——这是 zg 唯一认的形状。
 *
 * 绑定闭集而不是原样透传：zg 端自己会拒（实测 `--symbol-type Class` 退出码非零，原文
 * `Error: Unsupported symbol type: Class`），但那是一次完整子进程的失败；在构造阶段拦下
 * 并把合法取值一并说清，模型一次就能改对。取值**只认小写**：`Class` 与 `class` 在 zg
 * 侧是两回事（大写被拒），插件不做大小写折叠——悄悄改成小写等于替模型改了一处它没写的
 * 约束。
 */
const SYMBOL_TYPE_TABLE = {
  module: "module",
  class: "class",
  interface: "interface",
  function: "function",
  value: "value",
  alias: "alias",
} as const;

export type SymbolType = keyof typeof SYMBOL_TYPE_TABLE;

/** 合法符号类型名单，外供工具参数面的 JSON Schema `enum`，与取值器同一份来源。 */
export const SYMBOL_TYPE_NAMES: readonly string[] = Object.keys(SYMBOL_TYPE_TABLE);

function isSymbolType(value: string): value is SymbolType {
  return SYMBOL_TYPE_NAMES.includes(value);
}

/** 符号类型取值器：空缺省空数组，逐项校闭集（不是逐项静默丢弃）。 */
export function symbolTypesOf(value: unknown, messages: ZvecGrepMessages): SymbolType[] {
  const out: SymbolType[] = [];
  // 闭集大小**不是**条数上限：用 6 当 maxItems 会把 7 个各自合法的重复值（"class" × 7）
  // 判成「最多 6 项」——一条假拒绝，且提示指向完全错误的方向。条数用通用上限，取值的
  // 合法性只由下面这一处 isSymbolType 把关。
  for (const item of stringList(value, "symbolTypes", messages)) {
    if (!isSymbolType(item)) {
      throw new TypeError(
        fill(messages.symbolTypeInvalid, {
          received: item,
          allowed: SYMBOL_TYPE_NAMES.join(" | "),
        }),
      );
    }
    out.push(item);
  }
  return out;
}

/**
 * 归一化 zg 的设备参数：显式传入用显式值，否则默认 auto（让 llama.cpp 自探测
 * Metal GPU，失败自动回退 CPU）。auto/cpu/metal/vulkan/cuda 之外的非法值由
 * zg 端 parseDevice 拒绝；这里只负责类型、是否带 --device、如何转义。
 */
function deviceFlag(value: unknown, messages: ZvecGrepMessages): string {
  const raw = optionalText(value, "device", messages, MAX_FILTER_CHARS);
  const device = raw.length > 0 ? raw : "auto";
  return `--device ${shq(device)}`;
}

/**
 * 布尔旗标严格取值：缺省回 fallback，非布尔即报错（`1`/`"true"` 不算真）。
 *
 * 导出的原因：宿主侧有几处**要拿布尔值本身做分支决策**（这次调用是后台还是前台、
 * 这次是重建还是增量、这次查询带不带就绪判定），那些地方若写 `args["x"] === true`，
 * 一个 `1` 或 `"true"` 就会静默走成 false——而参数面下方恰好声明着 `type: "boolean"`。
 * 框架**不会**替我们兜这一层：宿主对 `parameters` 只在注册时做「输出」schema 检查，
 * 入参原样交给 execute（本文件 define 一处的注释与 lib/cli.ts 的头注释都记着这件事）。
 */
export function boolOf(
  value: unknown,
  name: string,
  messages: ZvecGrepMessages,
  fallback = false,
): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new TypeError(fill(messages.mustBeBoolean, { name, received: typeof value }));
  }
  return value;
}

/**
 * 词典化归一绝对路径（不触盘）：折叠空段与 `.`、解析 `..`。
 * `..` 越过文件系统根（如 `/../../etc`）即抛错——归一后落回 `/etc` 看似合法，
 * 实为借相对段逃逸调用方意图中的目录，绝不放行。
 */
export function normalizeAbsolutePath(path: string, messages: ZvecGrepMessages): string {
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "..") {
      if (parts.length === 0) {
        throw new Error(fill(messages.rootEscapesFs, { path }));
      }
      parts.pop();
    } else if (seg !== "" && seg !== ".") {
      parts.push(seg);
    }
  }
  return `/${parts.join("/")}`;
}

/** 绝对路径校验（macOS/Linux）：非空、以 / 开头、无 NUL、词典归一后仍在根内。 */
export function assertAbsoluteRoot(root: unknown, messages: ZvecGrepMessages): string {
  if (typeof root !== "string") {
    throw new TypeError(
      fill(messages.rootMustBeString, {
        received: root === null ? "null" : typeof root,
      }),
    );
  }
  if (root.trim().length === 0) {
    throw new Error(messages.rootRequired);
  }
  const trimmed = root.trim();
  if (trimmed.includes("\u0000")) {
    throw new Error(fill(messages.noNulBytes, { name: "root" }));
  }
  if (!trimmed.startsWith("/")) {
    throw new Error(fill(messages.rootMustBeAbsolute, { path: trimmed }));
  }
  const normalized = normalizeAbsolutePath(trimmed, messages);
  if (normalized === "/") {
    throw new Error(messages.rootIsFsRoot);
  }
  return normalized;
}

/**
 * root 解析：显式绝对路径优先；缺失/空串回退到 fallback（当前会话工作区，
 * 调用方从 exec.agent.session.header.cwd 取——官方 dsh-tool-fs-search 同模式）。
 * ROC 原则：fallback 也走 assertAbsoluteRoot 校验，绝不无条件接受。
 */
export function resolveRoot(
  value: unknown,
  fallback: string | undefined,
  messages: ZvecGrepMessages,
): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return assertAbsoluteRoot(value.trim(), messages);
  }
  if (typeof fallback === "string" && fallback.trim().length > 0) {
    return assertAbsoluteRoot(fallback.trim(), messages);
  }
  throw new Error(messages.rootRequiredWithFallback);
}

/** limit 钳制：非整数回默认，越界钳到 [LIMIT_MIN, LIMIT_MAX]。 */
export function clampLimit(value: unknown, fallback: number = DEFAULT_LIMIT): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(num)) {
    return fallback;
  }
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, num));
}

/** 检索类数组（queries/fts/vector）取值：条数与单条长度都放宽到 query 档。 */
function queryList(value: unknown, name: string, messages: ZvecGrepMessages): string[] {
  return stringList(value, name, messages, MAX_QUERY_ROUTES, MAX_QUERY_CHARS);
}

/** 构造产物：命令行 + 它的进程工作目录（zg query 用 cwd 定位工作区，不接受 --root）。 */
export interface BuiltCommand {
  readonly command: string;
  readonly workdir: string;
}

/** 整条命令的规模闸门：超 MAX_COMMAND_BYTES 即拒（防 E2BIG 与无界内存）。 */
function assembled(parts: string[], workdir: string, messages: ZvecGrepMessages): BuiltCommand {
  const command = parts.join(" ");
  const { length } = command;
  if (length > MAX_COMMAND_BYTES) {
    throw new Error(fill(messages.commandTooLong, { length, maxChars: MAX_COMMAND_BYTES }));
  }
  return { command, workdir };
}

export interface SearchArgs {
  root: unknown;
  query?: unknown;
  queries?: unknown;
  fts?: unknown;
  vector?: unknown;
  fuse?: unknown;
  limit?: unknown;
  preview?: unknown;
  refresh?: unknown;
  trace?: unknown;
  globs?: unknown;
  insensitiveGlobs?: unknown;
  fileTypes?: unknown;
  excludedFileTypes?: unknown;
  symbolTypes?: unknown;
  preferSymbol?: unknown;
  modifiedAfter?: unknown;
  modifiedBefore?: unknown;
  device?: unknown;
}

/**
 * 追加 query 路由主体参数（single/单查询 + 混合 lists），返回路由命中数
 * 与 dashGuard（query 以 '-' 开头需在命令末尾 `-- <query>` 分隔）供调用方使用。
 */
function pushQueryArgs(
  parts: string[],
  args: SearchArgs,
  messages: ZvecGrepMessages,
): { routeCount: number; dashGuard: boolean } {
  let routeCount = 0;
  const single = optionalText(args.query, "query", messages, MAX_QUERY_CHARS);
  // 低危修复：query 以 '-' 开头会被 zg 的 clap 当选项（如 '-foo' → unknown flag）。
  // 仅这种情况改为命令末尾 `-- <query>`（标准 clap 位置参数分隔）；正常 query 保持
  // 原头部位置不变（零回归——现有命令结构与测试完全不动）。
  const dashGuard = single.length > 0 && single.startsWith("-");
  if (single.length > 0) {
    if (!dashGuard) {
      parts.push(shq(single));
    }
    routeCount += 1;
  }
  for (const query of queryList(args.queries, "queries", messages)) {
    parts.push("--hybrid", shq(query));
    routeCount += 1;
  }
  for (const query of queryList(args.fts, "fts", messages)) {
    parts.push("--fts", shq(query));
    routeCount += 1;
  }
  for (const query of queryList(args.vector, "vector", messages)) {
    parts.push("--vector", shq(query));
    routeCount += 1;
  }
  if (routeCount > MAX_QUERY_ROUTES) {
    throw new Error(
      fill(messages.tooManyQueryRoutes, { count: routeCount, max: MAX_QUERY_ROUTES }),
    );
  }
  return { routeCount, dashGuard };
}

/**
 * 路径过滤（glob / iglob / type / type-not）。三条通道共用：实测索引检索、索引命令与
 * 穷举检索（`--rg`）下这四类旗标都被 zg 接受，故只在这里发一次。
 */
function pushPathFilters(parts: string[], args: SearchArgs, messages: ZvecGrepMessages): void {
  for (const glob of singleOrList(args.globs, "globs", messages)) {
    parts.push("--glob", shq(glob));
  }
  for (const glob of singleOrList(args.insensitiveGlobs, "insensitiveGlobs", messages)) {
    parts.push("--iglob", shq(glob));
  }
  for (const typeName of singleOrList(args.fileTypes, "fileTypes", messages)) {
    parts.push("--type", shq(typeName));
  }
  for (const typeName of singleOrList(args.excludedFileTypes, "excludedFileTypes", messages)) {
    parts.push("--type-not", shq(typeName));
  }
}

/** 时间过滤：两条检索通道共用（实测 `--modified-after` 在 `--rg` 下被接受）。 */
function pushTimeFilters(parts: string[], args: SearchArgs, messages: ZvecGrepMessages): void {
  const after = optionalText(args.modifiedAfter, "modifiedAfter", messages, MAX_FILTER_CHARS);
  if (after.length > 0) {
    parts.push("--modified-after", shq(after));
  }
  const before = optionalText(args.modifiedBefore, "modifiedBefore", messages, MAX_FILTER_CHARS);
  if (before.length > 0) {
    parts.push("--modified-before", shq(before));
  }
}

/** 追加检索过滤 globs（路径过滤 + 仅索引通道支持的符号类型）。 */
function pushSearchGlobs(parts: string[], args: SearchArgs, messages: ZvecGrepMessages): void {
  pushPathFilters(parts, args, messages);
  for (const symbolKind of symbolTypesOf(args.symbolTypes, messages)) {
    parts.push("--symbol-type", shq(symbolKind));
  }
}

/** 取单条 query 的原文（与 pushQueryArgs 同一取值器，保证 dashGuard 两侧一致）。 */
function singleText(args: SearchArgs, messages: ZvecGrepMessages): string {
  return optionalText(args.query, "query", messages, MAX_QUERY_CHARS);
}

function buildIndexedCommand(
  args: SearchArgs,
  root: string,
  messages: ZvecGrepMessages,
  mode: ClientMode,
): BuiltCommand {
  const parts: string[] = ["zg", "query"];
  const { routeCount, dashGuard } = pushQueryArgs(parts, args, messages);
  if (routeCount === 0) {
    throw new Error(messages.searchNeedsQuery);
  }
  if (boolOf(args.fuse, "fuse", messages)) {
    parts.push("--fuse");
  }
  // --preview 语义：none = 每命中仅 1 行锚点源码；short = 锚点 + 有界上下文窗口；
  // full = 整段源码。缺省 short，与官方 zvec_grep_search（MCP）一致——给模型 short 能少读
  // 几次文件、更准判断相关性，同时避免 full 撑爆上下文；模型要整段函数体时可显式改。
  parts.push(
    "--limit",
    String(clampLimit(args.limit)),
    "--preview",
    previewOf(args.preview, messages),
    "--refresh",
    refreshOf(args.refresh, messages),
  );
  pushSearchGlobs(parts, args, messages);
  if (boolOf(args.preferSymbol, "preferSymbol", messages)) {
    parts.push("--prefer-symbol");
  }
  // --trace：每条命中附一行检索轨迹，说明它是被哪几路召回、在各组里的名次如何。排障用，
  // 平时不用——它会让每条命中多出一行纯诊断文本。
  if (boolOf(args.trace, "trace", messages)) {
    parts.push("--trace");
  }
  pushTimeFilters(parts, args, messages);
  parts.push(deviceFlag(args.device, messages), modeFlag(mode));
  // '-' 开头的 positional query 放最后、以 `--` 分隔（clap：-- 后全是位置参数）。
  if (dashGuard) {
    parts.push("--", shq(singleText(args, messages)));
  }
  return assembled(parts, root, messages);
}

/**
 * 穷举模式下 zg 明确拒绝的索引侧旗标，逐个拦在构造阶段。实测报错原文：
 *   `--preview`  → "--preview is not supported with --rg; use -A/-B/-C for rg context"
 *   `--refresh`  → "--rg cannot be combined with indexed refresh options"
 *   `--symbol-type` / `--prefer-symbol` → "--rg cannot be combined with indexed symbol options"
 *   `--fuse`     → "--rg cannot be combined with --fuse"
 *   `--trace`    → "--rg cannot be combined with --trace"
 *   `--fts` / `--vector` → "--rg cannot be combined with --hybrid, --fts, or --vector"
 * 与其把模型交给一次子进程失败再原样回显 zg 的英文报错，不如在构造阶段就用本包的
 * 双语文案说清「这些是索引侧参数」——并且**不静默丢弃**用户给的那一项。
 */
function assertExhaustiveArgs(args: SearchArgs, messages: ZvecGrepMessages): void {
  const conflicts: string[] = [];
  if (boolOf(args.fuse, "fuse", messages)) {
    conflicts.push("fuse");
  }
  if (queryList(args.queries, "queries", messages).length > 0) {
    conflicts.push("queries");
  }
  if (queryList(args.fts, "fts", messages).length > 0) {
    conflicts.push("fts");
  }
  if (queryList(args.vector, "vector", messages).length > 0) {
    conflicts.push("vector");
  }
  if (optionalText(args.preview, "preview", messages, MAX_FILTER_CHARS).length > 0) {
    conflicts.push("preview");
  }
  if (optionalText(args.refresh, "refresh", messages, MAX_FILTER_CHARS).length > 0) {
    conflicts.push("refresh");
  }
  if (stringList(args.symbolTypes, "symbolTypes", messages).length > 0) {
    conflicts.push("symbolTypes");
  }
  if (boolOf(args.preferSymbol, "preferSymbol", messages)) {
    conflicts.push("preferSymbol");
  }
  if (boolOf(args.trace, "trace", messages)) {
    conflicts.push("trace");
  }
  if (conflicts.length > 0) {
    throw new Error(fill(messages.exhaustiveConflicts, { names: conflicts.join(" | ") }));
  }
}

/** 穷举词法通道（`zg query --rg`）。与索引通道的合法旗标集合不同，见 assertExhaustiveArgs。 */
function buildExhaustiveCommand(
  args: SearchArgs,
  root: string,
  messages: ZvecGrepMessages,
  mode: ClientMode,
): BuiltCommand {
  assertExhaustiveArgs(args, messages);
  const parts: string[] = ["zg", "query", "--rg"];
  // 穷举模式下 query 就是 rg 的 pattern，不再有「多路查询组」这回事。
  const pattern = optionalText(args.query, "query", messages, MAX_QUERY_CHARS);
  if (pattern.length === 0) {
    throw new Error(messages.exhaustiveNeedsPattern);
  }
  // 实测：pattern 以 '-' 开头必须走 -e，否则被当作选项；这是 --rg 自己的约定，
  // 与索引通道末尾 `--` 分隔那套不是同一件事。
  if (pattern.startsWith("-")) {
    parts.push("-e", shq(pattern));
  } else {
    parts.push(shq(pattern));
  }
  parts.push("--limit", String(clampLimit(args.limit)));
  pushPathFilters(parts, args, messages);
  pushTimeFilters(parts, args, messages);
  parts.push(deviceFlag(args.device, messages), modeFlag(mode));
  return assembled(parts, root, messages);
}

/**
 * 构造 zg query 命令。注意：zg query 没有 --root，root 来自进程 cwd，
 * 所以 root 只作为 workdir 返回，绝不进入命令行。
 *
 * `exhaustive` 走 zg 的穷举词法通道（`--rg`）：不需要索引，是「工作区尚无索引」时的
 * 首选路径。选哪条路由由**宿主**判（它才有索引探测能力），本纯函数只按判据构造——
 * 判据见 host.ts 的 pickExhaustive。
 */
export function buildSearchCommand(
  args: SearchArgs,
  messages: ZvecGrepMessages,
  mode: ClientMode = DEFAULT_CLIENT_MODE,
  exhaustive = false,
): BuiltCommand {
  const root = assertAbsoluteRoot(args.root, messages);
  return exhaustive
    ? buildExhaustiveCommand(args, root, messages, mode)
    : buildIndexedCommand(args, root, messages, mode);
}

export interface IndexArgs {
  root: unknown;
  embedding?: unknown;
  rebuild?: unknown;
  /** 后台执行：宿主据此决定起进程后立刻返回，而不是等它跑完。命令行上无对应旗标。 */
  background?: unknown;
  drop?: unknown;
  globs?: unknown;
  insensitiveGlobs?: unknown;
  fileTypes?: unknown;
  excludedFileTypes?: unknown;
  ignoreFiles?: unknown;
  hidden?: unknown;
  noIgnore?: unknown;
  excludeSecrets?: unknown;
  maxDepth?: unknown;
  maxFileSizeBytes?: unknown;
  follow?: unknown;
  embeddingConcurrency?: unknown;
  device?: unknown;
  /**
   * 清除继承的文件选择设置（透传 `--reset-paths`）。
   *
   * 与 globs/fileTypes **不互斥**：上游先 reset、再把本次请求的覆盖值盖上去
   * （zvec-grep v0.2.2 `resolveIndexRootPaths`：`resetRootPathFilters` 之后才走
   * `applyRootPathOverrides`），两者同传表达的是「清干净再按这次的规则选」这一合法语义。
   * 真正互斥的只有 drop（上游 args.ts 明确拒 `--drop --reset-paths`），构造期单独拒。
   */
  resetPaths?: unknown;
}

/** 非负/正整数字符串化；非数值类型或非整数报错（`true` 不算 1）。 */
function intFlag(value: unknown, name: string, messages: ZvecGrepMessages, min: number): string {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new TypeError(fill(messages.intWithReceived, { name, min, received: typeof value }));
  }
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(num) || num < min) {
    throw new Error(fill(messages.intRequired, { name, min }));
  }
  return String(num);
}

/** 索引布尔旗标（一次性严格取值，见 readIndexFlags）。 */
interface IndexFlags {
  rebuild: boolean;
  hidden: boolean;
  noIgnore: boolean;
  follow: boolean;
  excludeSecrets: boolean;
}

/**
 * 一次性读完全部布尔旗标：drop=true 的分支不拼 embedding/过滤段，若就地取值，
 * `{drop:true, hidden:"true"}` 里的非法类型会被静默忽略。先取值再分支，任何
 * 非法布尔都在命令构造前报错。
 */
function readIndexFlags(args: IndexArgs, messages: ZvecGrepMessages): IndexFlags {
  return {
    rebuild: boolOf(args.rebuild, "rebuild", messages),
    hidden: boolOf(args.hidden, "hidden", messages),
    noIgnore: boolOf(args.noIgnore, "noIgnore", messages),
    follow: boolOf(args.follow, "follow", messages),
    excludeSecrets: boolOf(args.excludeSecrets, "excludeSecrets", messages, true),
  };
}

/** 追加索引布尔旗标（rebuild 在 globs 前）。 */
function pushIndexBoolFlags(parts: string[], flags: IndexFlags): void {
  if (flags.rebuild) {
    parts.push("--rebuild");
  }
}

/**
 * 追加索引过滤 globs 与密钥排除（内部顺序固定：globs → iglob → type →
 * type-not → 密钥排除 → ignore-file）。
 *
 * 密钥排除走 --iglob 而非 --glob，两个原因都是实测得来的：
 *   - 扩展名大小写：真正会被索引的密钥库格式里，`.p12` / `.pfx` / `.keystore` 都存在
 *     混合大小写变体（`secret.P12`、`secret.PfX`、`secret.KEYSTORE` 皆实测入索引）。
 *     --glob 的 `!*.p12` 匹配不到 `secret.P12`，--iglob 走大小写不敏感匹配才能全部排除。
 *     （`.pem` 不在此列：它本就不在 zg 的可索引类型里，不下发任何规则也不会进索引。）
 *   - 规则次序：引擎把全部 --glob 规则排在全部 --iglob 规则之前有序求值。密钥规则若
 *     用 --glob，用户一条宽泛的正向 --iglob（如 `**`）会在其后求值并把无扩展名的
 *     `id_rsa*` 救回索引（实测「被索引」）；用 --iglob 且排在本函数最后（用户 iglob
 *     之后），任何用户正向规则都无法覆盖它。
 * 纯 `!` 取反已实测可独立工作。excludeSecrets=false 可整体关闭。
 */
function pushIndexGlobs(
  parts: string[],
  args: IndexArgs,
  flags: IndexFlags,
  messages: ZvecGrepMessages,
): void {
  for (const glob of singleOrList(args.globs, "globs", messages)) {
    parts.push("--glob", shq(glob));
  }
  for (const glob of singleOrList(args.insensitiveGlobs, "insensitiveGlobs", messages)) {
    parts.push("--iglob", shq(glob));
  }
  for (const typeName of singleOrList(args.fileTypes, "fileTypes", messages)) {
    parts.push("--type", shq(typeName));
  }
  for (const typeName of singleOrList(args.excludedFileTypes, "excludedFileTypes", messages)) {
    parts.push("--type-not", shq(typeName));
  }
  if (flags.excludeSecrets) {
    for (const glob of SECRET_EXCLUDE_GLOBS) {
      parts.push("--iglob", shq(glob));
    }
  }
  for (const filePath of singleOrList(args.ignoreFiles, "ignoreFiles", messages)) {
    parts.push("--ignore-file", shq(filePath));
  }
}

/** 追加索引数值旗标（内部顺序固定：maxDepth → maxFileSizeBytes）。 */
function pushIndexIntFlags(parts: string[], args: IndexArgs, messages: ZvecGrepMessages): void {
  if (args.maxDepth !== undefined && args.maxDepth !== null) {
    parts.push("--max-depth", intFlag(args.maxDepth, "maxDepth", messages, 0));
  }
  if (args.maxFileSizeBytes !== undefined && args.maxFileSizeBytes !== null) {
    parts.push("--max-filesize", intFlag(args.maxFileSizeBytes, "maxFileSizeBytes", messages, 0));
  }
}

/** 追加索引布尔旗标（hidden/no-ignore 紧随过滤 globs）。 */
function pushIndexHideFlags(parts: string[], flags: IndexFlags): void {
  if (flags.hidden) {
    parts.push("--hidden");
  }
  if (flags.noIgnore) {
    parts.push("--no-ignore");
  }
}

/** 追加索引布尔旗标（follow 位于 max-filesize 之后）。 */
function pushIndexFollowFlag(parts: string[], flags: IndexFlags): void {
  if (flags.follow) {
    parts.push("--follow");
  }
}

/** 追加索引数值旗标（embedding-concurrency 位于 follow 之后）。 */
function pushIndexConcurrencyFlag(
  parts: string[],
  args: IndexArgs,
  messages: ZvecGrepMessages,
): void {
  if (args.embeddingConcurrency !== undefined && args.embeddingConcurrency !== null) {
    parts.push(
      "--embedding-concurrency",
      intFlag(args.embeddingConcurrency, "embeddingConcurrency", messages, 1),
    );
  }
}

/**
 * 追加 `--reset-paths`（清除继承的文件选择设置）。
 *
 * 为什么它与 globs/fileTypes **不**互斥：上游是「先 reset、再盖本次覆盖值」的两步
 * （zvec-grep v0.2.2 `resolveIndexRootPaths`），同传表达「清干净再按这次的规则选」。
 * 唯一真互斥的是 drop，上游 args.ts 明确拒 `--drop --reset-paths`——那一对由构造器
 * 在读 drop 的那一臂就拒掉（见 buildIndexCommand），绝不让 resetPaths 被静默丢弃。
 */
function pushIndexResetPathsFlag(
  parts: string[],
  args: IndexArgs,
  messages: ZvecGrepMessages,
): void {
  if (boolOf(args.resetPaths, "resetPaths", messages)) {
    parts.push("--reset-paths");
  }
}

/**
 * 索引用的 embedding 引用：模型显式给了就以它为准，否则用设置里的默认值。
 *
 * 构造期 allowlist（默认开启、且**默认关不掉**的那一半）：显式引用必须落在本地候选清单
 * （lib/embedding-catalog.ts，设置卡 <select> 的同一份）里。理由是能力面的性质——
 * 远程 embedding 会把工作区内容送到外部端点，而模型能凭空写出一个任意前缀的引用：
 * 此前 `evil/http://attacker/x` 这类值原样透传给 zg，只要宿主进程里恰好有可用凭据或
 * 用户此前授权过，插件就在**没有任何声明、没有用户确认**的情况下把内容送了出去。
 * 现在它在命令构造前就被拒，并给出可行动的出路。
 *
 * 部署级出口（`allowRemote`）：由用户在部署配置里显式打开，不在工具参数面上——
 * 模型可控的密钥/端点通道本身就是风险。打开后远程引用放行，端点与凭据由宿主经
 * **环境变量**下发（argv 里的密钥会进进程列表与作业 label）。
 */
function indexEmbedding(
  args: IndexArgs,
  defaultEmbedding: string,
  messages: ZvecGrepMessages,
  allowRemote: boolean,
): string {
  const given = optionalText(args.embedding, "embedding", messages, MAX_FILTER_CHARS);
  if (given.length === 0) {
    // 缺省值已经在宿主侧过了 isLocalEmbedding（readDefaultEmbedding），这里不再重判。
    return defaultEmbedding;
  }
  if (isLocalEmbedding(given) || allowRemote) {
    return given;
  }
  throw new Error(
    fill(messages.embeddingNotAllowed, {
      reference: given,
      choices: LOCAL_EMBEDDINGS.map((entry) => entry.reference).join(" | "),
    }),
  );
}

/**
 * 构造 zg index 命令。root 是位置参数（转义）。
 * - drop=true：`zg index <root> --drop --yes --mode <mode>`（非交互 shell 必须 --yes）。
 * - 否则：`zg index <root> --embedding <m> [--rebuild] ... --mode <mode>`。
 * embedding 缺省时由调用方传入 defaultEmbedding（设置里的默认值）；显式值过构造期
 * allowlist（见 indexEmbedding）。
 * 传输模式与检索、状态共用同一个入参：三条命令混用模式会在守护进程持有索引租约时
 * 让写侧直接失败，故一致性由构造器的必填入参强制。
 * 旗标顺序与 filter globs 交错固定（rebuild → globs → hidden → no-ignore →
 * max-depth → max-filesize → follow → embedding-concurrency → reset-paths），
 * 不得重排（测试锁死）。
 */
export function buildIndexCommand(
  args: IndexArgs,
  defaultEmbedding: string,
  messages: ZvecGrepMessages,
  mode: ClientMode = DEFAULT_CLIENT_MODE,
  allowRemote = false,
): BuiltCommand {
  const root = assertAbsoluteRoot(args.root, messages);
  const parts: string[] = ["zg", "index", shq(root)];
  const flags = readIndexFlags(args, messages);

  if (boolOf(args.drop, "drop", messages)) {
    // drop 那一臂整条命令只有 `index <root> --drop --yes`，任何别的旗标都会在这一臂被
    // 静默丢掉。resetPaths 是唯一真与它互斥的（上游 args.ts 也拒这一对），故明确报错
    // 而不是当作没看见——用户以为清了继承设置，其实那条 zg 只会把索引删掉。
    if (boolOf(args.resetPaths, "resetPaths", messages)) {
      throw new Error(messages.dropWithResetPaths);
    }
    parts.push("--drop", "--yes", modeFlag(mode));
    return assembled(parts, root, messages);
  }

  parts.push("--embedding", shq(indexEmbedding(args, defaultEmbedding, messages, allowRemote)));
  pushIndexBoolFlags(parts, flags);
  pushIndexGlobs(parts, args, flags, messages);
  pushIndexHideFlags(parts, flags);
  pushIndexIntFlags(parts, args, messages);
  pushIndexFollowFlag(parts, flags);
  pushIndexConcurrencyFlag(parts, args, messages);
  pushIndexResetPathsFlag(parts, args, messages);
  parts.push(deviceFlag(args.device, messages), modeFlag(mode));
  return assembled(parts, root, messages);
}

export interface StatusArgs {
  root: unknown;
  checkReady?: unknown;
}

/**
 * 构造 zg status 命令（root 位置参数；传输模式与另两条命令同源）。
 *
 * `checkReady` 透传 `--check-ready`：zg 的帮助原文是「preserves the normal output and
 * exits non-zero unless the Workspace index is ready」——即**就绪报告照常打在 stdout，
 * 只用退出码表达就绪与否**。所以宿主侧必须成对处理这两半：报告要交回，退出码要翻译成
 * 结论，不能像普通失败那样只留 stderr 把 stdout 丢掉（实测未就绪时 stdout 正是那份
 * 「? Workspace index is not configured … Next: zg index or zg query --rg」报告）。
 */
export function buildStatusCommand(
  args: StatusArgs,
  messages: ZvecGrepMessages,
  mode: ClientMode = DEFAULT_CLIENT_MODE,
): BuiltCommand {
  const root = assertAbsoluteRoot(args.root, messages);
  const parts: string[] = ["zg", "status", shq(root)];
  if (boolOf(args.checkReady, "checkReady", messages)) {
    parts.push("--check-ready");
  }
  parts.push(modeFlag(mode));
  return assembled(parts, root, messages);
}
