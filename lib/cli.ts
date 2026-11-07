// lib/cli.ts —— 纯函数：把 zg_* 工具的入参安全地构造成 zg CLI 命令。
// 无 ctx、无副作用，可独立单测。所有用户可控字符串一律经 shq() 按平台转义
// （POSIX 单引号 / pwsh 单引号），root 只走 workdir 字段（query）或转义后的位置参数
// （index/status）。平台档位由 args.platform 注入（宿主按 runtimePlatform() 决定）。
//
// 报错文案双语：本文件的校验文本都会原样回显给模型（工具失败信息），故消息表
// （lib/messages.ts 的一份）由调用点作入参注入——纯函数不读设置，宿主传
// `messagesFor(MESSAGES, …)` 的结果，单测直接喂字典。
//
// 入参校验为什么全在这里：harness 的 tools 注册入口对 `parameters` JSON Schema
// 只做「输出」校验，`ToolRegistry` 直接把 `exec.arguments` 原样交给
// `execute`（packages/core/tools/src/index.ts 里那句 `await tool.execute(exec.arguments, exec)`），
// 模型给的类型错误不会在框架层报错。宽松取值（`x === true`）会让 `{rebuild:1}` 静默走增量、
// `{hidden:"true"}` 静默失效——用户以为重建/含隐藏了，实际没有。故本文件的
// 每个取值器都是「非法定类型即抛错」。

import { fill } from "./messages.ts";
import type { ZvecGrepMessages } from "./messages.ts";
import { BACKSLASH } from "./platform.ts";
import type { PathPlatform } from "./platform.ts";
import nodePath from "node:path";

import {
  MAX_COMMAND_BYTES,
  MAX_FILTER_CHARS,
  MAX_QUERY_CHARS,
  MAX_QUERY_ROUTES,
  MAX_TIME_CHARS,
  SECRET_EXCLUDE_GLOBS,
  optionalText,
  shq,
  singleOrList,
  stringList,
} from "./argv-guard.ts";
// embedding 候选清单：构造期 allowlist 的唯一来源，与设置卡的 <select> 共用同一份。
// 远程组随 0.3.0 引入：`allowRemote` 放行的是远程**闭集**（REMOTE_EMBEDDING_CATALOG），
// 不是任意前缀的引用；见 indexEmbedding。
import {
  LOCAL_EMBEDDINGS,
  REMOTE_EMBEDDING_CATALOG,
  isLocalEmbedding,
  isRemoteEmbedding,
} from "./embedding-catalog.ts";
// 数值区间唯一来源：limit 的钳制区间与默认值从这里取（host schema 与设置卡同源，见该文件头）。
// DEFAULT_LIMIT 同时转出（host.ts 从这里取），两侧引同一份常量。
import { DEFAULT_LIMIT, LIMIT_MAX, LIMIT_MIN } from "./limits.ts";

export { DEFAULT_LIMIT } from "./limits.ts";

/** 盘符根 `C:\`（path.win32.parse 的 root 形态；`C:` 是盘符相对，不算）。 */
const WIN32_DRIVE_ROOT = /^[A-Za-z]:\\$/u;

/**
 * zg 客户端传输模式，三档与 zg 命令行 `--mode` 的字面量同域。取值域由下表的键推导，
 * 声明与名单同源，改名单不会留下一个推导不出来的类型。
 *
 * 缺省取 `auto` 而不是 `direct`：`direct` 在 zg 守护进程持有该根的索引租约时会直接失败
 * （报「守护进程拥有索引写权限」），而守护进程可能由用户自己的 zvec-grep MCP 或一次
 * `zg --server on` 引入，插件无法假定它不存在。`auto` 在守护进程在跑时走守护进程、不在跑
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
 * 取值器同一种做法——绝不把一个守护进程并不认识的模式串静默拼进命令。
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
 *
 * `detail` 是 0.3.0 新增档（上游帮助原文："adds metadata, outlines, and file grouping"）：
 * 每命中附符号、签名、Range/Status 等结构化字段并按文件分组。注意它的条目头行不带
 * `路径:行号范围`（位置在后续的 `Range:` 行），hitSummary 的位置去重对这一档会把头行
 * 标题当身份键——去重仍然成立但身份变弱，见 host.ts 的注释。
 */
const PREVIEW_TABLE = { none: "none", short: "short", full: "full", detail: "detail" } as const;

export type PreviewMode = keyof typeof PREVIEW_TABLE;

/** 合法预览档位名单，外供工具参数的 JSON Schema `enum`，与取值器同一份来源。 */
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
 * `background` 要单独说明：它**只在守护进程（server 模式）下成立**。直连模式下 zg 不报错，
 * 而是静默降级成 `off` 并往 stderr 打一行 warning（实测原文：`Warning: --refresh background
 * is unavailable in direct mode; falling back to off`）——退出码照旧 0、结果照旧出，唯独
 * 「后台在刷新」这件事是假的。所以本包不再把它当成一条可以自己消化的降级：守护进程缺席时
 * `refresh=background` 在**命令构造期**就拒，并给出两条出路（改用缺省的 wait，或先
 * `zg --server on`）。能不能用由宿主算成 BackgroundSupport 再传进来，见 host.ts 里那道就绪门槛。
 */
const REFRESH_TABLE = { background: "background", wait: "wait", off: "off" } as const;

export type RefreshPolicy = keyof typeof REFRESH_TABLE;

/** 合法刷新策略名单，外供工具参数的 JSON Schema `enum`，与取值器同一份来源。 */
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
 * 这次调用**是不是显式要后台刷新**。宿主用它决定要不要探一发守护进程：缺省走 `wait`，
 * 为一档没人要的取值多起一次进程是白给的开销。
 *
 * 这里只做字面量比较、不校验取值：非法的 `refresh`（如 `"Background"`）由 `refreshOf`
 * 在构造期拒，两处判据不重复，也不会出现「先探了进程再报错」那种顺序依赖。
 */
export function requestsBackgroundRefresh(value: unknown): boolean {
  return value === "background";
}

/**
 * `refresh=background` 这一档到底能不能用。两个独立的开关，各有各的诚实文案：
 *  - `available`：传输模式没被钉死，且守护进程就绪。
 *  - `daemon-down`：模式可以走 server，但守护进程不在——出路是 `zg --server on`。
 *  - `mode-direct`：部署把 `clientMode` 钉死在 direct，守护进程在不在都到不了 server 模式
 *    ——只叫用户去 `zg --server on` 是一句指错方向的废话。
 * 判据由宿主算（它才同时握着模式与探测能力），本模块只按它折成构造期拒绝。
 */
export type BackgroundSupport = "available" | "daemon-down" | "mode-direct";

/**
 * 符号类型闭集，七个取值逐字抄自 zg 0.3.0 `--symbol-type` 的取值域
 * （`alias, class, enum, function, interface, module, value`；与上游 MCP 声明的
 * SymbolTypeInput 枚举同源，`enum` 是 0.3.0 新增的一档）。
 *
 * 绑定闭集而不是原样透传：zg 端自己会拒不在域内的值，但那是一次完整子进程的失败；
 * 在构造阶段拦下并把合法取值一并说清，模型一次就能改对。取值**只认小写**：`Class` 与
 * `class` 在 zg 侧是两回事（大写被拒），插件不自动把取值转成小写——悄悄转小写等于替
 * 模型改了一处它没写的约束。
 */
const SYMBOL_TYPE_TABLE = {
  alias: "alias",
  class: "class",
  enum: "enum",
  function: "function",
  interface: "interface",
  module: "module",
  value: "value",
} as const;

export type SymbolType = keyof typeof SYMBOL_TYPE_TABLE;

/** 合法符号类型名单，外供工具参数的 JSON Schema `enum`，与取值器同一份来源。 */
export const SYMBOL_TYPE_NAMES: readonly string[] = Object.keys(SYMBOL_TYPE_TABLE);

function isSymbolType(value: string): value is SymbolType {
  return SYMBOL_TYPE_NAMES.includes(value);
}

/** 符号类型取值器：空缺省空数组，逐项校闭集（不是逐项静默丢弃）。 */
export function symbolTypesOf(value: unknown, messages: ZvecGrepMessages): SymbolType[] {
  const out: SymbolType[] = [];
  // 条数上限取**上游 MCP schema 的 maxItems=7**，CLI 与 MCP 两条通道共用：7 个不同取值
  // 正好是闭集全集，第 8 项必是重复值，MCP 面会以 schema 拒。用闭集大小当上限不会误伤
  // 合法取值（`maxItems: 6` 才会把 7 个不同取值判成超限）；两通道共用也避免同一份入参在
  // CLI 收、MCP 拒。取值的合法性只由下面这一处 isSymbolType 把关，条数只由 stringList 管。
  for (const item of stringList(value, "symbolTypes", messages, SYMBOL_TYPE_NAMES.length)) {
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
/** 单引号转义器的窄化类型：调用方按平台绑定一次，后续只传这一枚函数。 */
type Quote = (value: string) => string;

/** 按平台绑定转义器：单测默认 POSIX；宿主按 runtimePlatform() 传入。 */
function quoteFor(platform: PathPlatform): Quote {
  return (value) => shq(value, platform);
}

function deviceFlag(value: unknown, messages: ZvecGrepMessages, quote: Quote): string {
  const raw = optionalText(value, "device", messages, MAX_FILTER_CHARS);
  const device = raw.length > 0 ? raw : "auto";
  return `--device ${quote(device)}`;
}

/**
 * 布尔旗标严格取值：缺省回 fallback，非布尔即报错（`1`/`"true"` 不算真）。
 *
 * 导出的原因：宿主侧有几处**要拿布尔值本身做分支决策**（这次调用是后台还是前台、
 * 这次是重建还是增量、这次查询带不带就绪判定），那些地方若写 `args["x"] === true`，
 * 一个 `1` 或 `"true"` 就会静默走成 false——而参数表下方恰好声明着 `type: "boolean"`。
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
 * 词典化归一绝对路径（不触盘）：去掉空段与 `.`、解析 `..`。
 * `..` 越过文件系统根（如 `/../../etc`）即抛错——归一后落回 `/etc` 看似合法，
 * 实为借相对段逃逸调用方意图中的目录，绝不放行。
 */
/**
 * 去掉 Windows 扩展长度/设备前缀：`\\?\C:\x` → `C:\x`、`\\?\UNC\srv\share\x` →
 * `\\srv\share\x`。这些前缀只改变内核解释方式，不改变目标路径；保留它们会让同一目录
 * 在清单覆盖与白名单里变成两个键。`\\.\` 设备前缀同理按普通盘符路径处理。
 */
function stripWin32Extended(input: string): string {
  if (input.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${input.slice("\\\\?\\UNC\\".length)}`;
  }
  if (input.startsWith("\\\\?\\") || input.startsWith("\\\\.\\")) {
    return input.slice(4);
  }
  return input;
}

/** 盘符绝对路径（`C:\` / `C:/`）或 UNC（`\\server\share`）的根前缀；不是完整限定路径时 undefined。 */
function win32RootOf(input: string): string | undefined {
  const separated = input.replaceAll("/", "\\");
  const parsed = nodePath.win32.parse(separated).root;
  return WIN32_DRIVE_ROOT.test(parsed) || parsed.startsWith(BACKSLASH + BACKSLASH)
    ? parsed
    : undefined;
}

/** win32 路径归一：统一 `\`、消 `.`/`..`、拒绝越出盘符/共享根；返回完整限定形式。 */
function normalizeWin32Absolute(input: string, messages: ZvecGrepMessages): string {
  const canonical = stripWin32Extended(input).replaceAll("/", "\\");
  const root = win32RootOf(canonical);
  if (root === undefined) {
    throw new Error(fill(messages.rootMustBeAbsolute, { path: input }));
  }
  const parts: string[] = [];
  for (const segment of canonical.slice(root.length).split("\\")) {
    if (segment === "..") {
      if (parts.length === 0) {
        throw new Error(fill(messages.rootEscapesFs, { path: input }));
      }
      parts.pop();
    } else if (segment !== "" && segment !== ".") {
      parts.push(segment);
    }
  }
  return `${root}${parts.join("\\")}`;
}

/**
 * 路径归一：POSIX 按 `/` 切段，win32 按 `\`（也接受 `/`）切段并保留盘符/UNC 根。
 * 两种方言都拒绝 `..` 越出文件系统根（不是静默钳到根）。
 * @param path 待归一的绝对路径
 * @param messages 文案表
 * @param platform 路径方言（缺省 posix，宿主按 runtimePlatform() 传入）
 * @returns 归一后的绝对路径（无尾分隔符，根自身除外）
 */
export function normalizeAbsolutePath(
  path: string,
  messages: ZvecGrepMessages,
  platform: PathPlatform = "posix",
): string {
  if (platform === "win32") {
    return normalizeWin32Absolute(path, messages);
  }
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

/**
 * 绝对路径校验。POSIX 只收 `/` 开头；win32 只收盘符绝对路径（`C:\…`）与 UNC
 * （`\\server\share\…`）——`C:repo`（盘符相对）与 `\repo`（当前盘根相对）不是完整
 * 限定路径，作为 workdir 会随进程当前盘漂移，故与相对路径同档拒绝。
 */
export function assertAbsoluteRoot(
  root: unknown,
  messages: ZvecGrepMessages,
  platform: PathPlatform = "posix",
): string {
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
  if (platform === "win32") {
    const normalized = normalizeAbsolutePath(trimmed, messages, "win32");
    if (normalized === nodePath.win32.parse(normalized).root) {
      throw new Error(messages.rootIsFsRoot);
    }
    return normalized;
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
 * 显式的**非字符串**值不进 fallback 分支：模型写 `{root: 123}` 时若静默滑到会话工作区，
 * 搜索就在模型没指定的目录上执行并交回一份「合法」结果——类型错必须当场报。
 */
export function resolveRoot(
  value: unknown,
  fallback: string | undefined,
  messages: ZvecGrepMessages,
  platform: PathPlatform = "posix",
): string {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new TypeError(fill(messages.rootMustBeString, { received: typeof value }));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return assertAbsoluteRoot(value.trim(), messages, platform);
  }
  if (typeof fallback === "string" && fallback.trim().length > 0) {
    return assertAbsoluteRoot(fallback.trim(), messages, platform);
  }
  throw new Error(messages.rootRequiredWithFallback);
}

/**
 * limit 取值：省略（undefined/null）回默认；不是非负整数即抛；越界拒绝并点名区间。
 *
 * 类型只认 number：`Number()` 会把 `true` 折成 1、把 `[]` 折成 0——模型给一个类型错的 limit
 * 就会静默只回一条结果，而它会把「只有一处命中」当成这次检索的事实。越界同样拒绝而不是
 * 钳制：静默钳过的 limit 让模型以为要回了 999 条、实际只看到 50 条，还把「少」当成了事实；
 * 拒绝并报区间，下一轮它自己改对。
 */
export function resolveLimit(
  value: unknown,
  messages: ZvecGrepMessages,
  fallback: number = DEFAULT_LIMIT,
): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number") {
    throw new TypeError(messages.limitInvalid);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(messages.limitInvalid);
  }
  if (value < LIMIT_MIN || value > LIMIT_MAX) {
    throw new Error(fill(messages.limitOutOfRange, { min: LIMIT_MIN, max: LIMIT_MAX }));
  }
  return value;
}

/** 检索类数组（queries/fts/vector）取值：条数与单条长度都放宽到 query 档。 */
function queryList(value: unknown, name: string, messages: ZvecGrepMessages): string[] {
  return stringList(value, name, messages, MAX_QUERY_ROUTES, MAX_QUERY_CHARS);
}

/** 构造产物：命令行 + 它的进程工作目录（三条检索通道都用 cwd 定位工作区，不接受 --root）。 */
export interface BuiltCommand {
  readonly command: string;
  readonly workdir: string;
}

/** Windows 的 CreateProcess 命令行上限约 32767 个 UTF-16 码元；留出 pwsh 前缀与编码
 *  预置的余量后取 24000 字节。POSIX 仍用 MAX_COMMAND_BYTES（64K）。 */
export const MAX_COMMAND_BYTES_WIN32 = 24_000;

/** 整条命令的规模上限：按 UTF-8 字节比平台上限（防 E2BIG 与无界内存）。
 *  多字节内容一个码元可占 3~4 字节，按 `String.length`（码元数）比会在中文/emoji 面上
 *  放过 Linux MAX_ARG_STRLEN 的单参数上限——判据必须落在内核真正收到的字节数上。
 *  win32 走 pwsh -Command，整条命令是一个 argv 项，受 CreateProcess 的 32767 码元限制。 */
function assembled(
  parts: string[],
  workdir: string,
  messages: ZvecGrepMessages,
  platform: PathPlatform = "posix",
): BuiltCommand {
  const command = parts.join(" ");
  const length = Buffer.byteLength(command, "utf8");
  const maxBytes = platform === "win32" ? MAX_COMMAND_BYTES_WIN32 : MAX_COMMAND_BYTES;
  if (length > maxBytes) {
    throw new Error(fill(messages.commandTooLong, { length, maxBytes }));
  }
  return { command, workdir };
}

export interface SearchArgs {
  root: unknown;
  /**
   * 路径与命令方言（宿主按 runtimePlatform() 注入；模型入参里的同名字段会被宿主覆盖）。
   * 放在 args 里而不是再加一位位置参数：本仓 max-params 上限是 5，而 mode/channel/
   * backgroundSupport 已经占满；单测不传时按 posix，与改动前的命令形态逐字节一致。
   */
  platform?: PathPlatform;
  query?: unknown;
  queries?: unknown;
  fts?: unknown;
  vector?: unknown;
  fuse?: unknown;
  /**
   * 检索通道选择（true = 穷举词法、false = 只走索引检索）。判据在宿主侧（`pickExhaustive`，
   * 它才握有索引探测能力），**本文件不读这一位**；列在这里是为了让入参形状与工具参数一致，
   * 免得下一个人以为「参数表里声明了、可这一位没有消费者」。
   */
  rg?: unknown;
  /**
   * 文件发现模式（0.3.0 的 `zg --rg --files`）：不搜索内容，列出按当前过滤规则筛过的文件
   * 清单（上游源码 `file_selection/policy.rs`：默认感知 .gitignore/.ignore/.rgignore 三件套、
   * `paths.sort()` 排序、无结果上限）。它与穷举内容检索互斥——上游明拒 `--limit` 与
   * `--rg --files` 组合，且 positional 参数全部按**路径**读，query 传进来会被当成路径。
   */
  files?: unknown;
  limit?: unknown;
  preview?: unknown;
  refresh?: unknown;
  trace?: unknown;
  globs?: unknown;
  insensitiveGlobs?: unknown;
  fileTypes?: unknown;
  excludedFileTypes?: unknown;
  /** 引擎分类过滤（0.3.0 新增 `--category`，如 code / document）。值域由上游校验。 */
  category?: unknown;
  /** 排除的引擎分类（`--category-not`）。 */
  categoryNot?: unknown;
  symbolTypes?: unknown;
  preferSymbol?: unknown;
  modifiedAfter?: unknown;
  modifiedBefore?: unknown;
  device?: unknown;
}

/**
 * 追加 query 路由主体参数（全部走显式路由旗标），返回路由命中数。
 *
 * 0.3.0 起没有 `zg query` 子命令：裸词**就是**搜索文本（上游帮助原文 "Bare words such as
 * query, index, and help are literal search text"）。主查询仍走 `--hybrid=` 显式路由而不是
 * 位置词，两个实测依据：路径形单词（`auth.ts`）作位置词会先被上游拿去匹配文件名并打
 * stderr 警告（帮助原文 "A complete miss returns No matches."——一次看似成功实为空查），
 * 而显式路由 bypass 这一行为；多个位置词含空格还有合并警告。`=` 连写（`--hybrid='…'`）
 * 是防「以 `-` 开头的查询串作为独立词被 clap 当成另一个选项」，与 0.2.2 时代的
 * `--hybrid=` 用法同一套转义纪律（shq 负责单引号）。
 */
function pushQueryArgs(
  parts: string[],
  args: SearchArgs,
  messages: ZvecGrepMessages,
  quote: Quote,
): number {
  let routeCount = 0;
  const single = optionalText(args.query, "query", messages, MAX_QUERY_CHARS);
  if (single.length > 0) {
    parts.push(`--hybrid=${quote(single)}`);
    routeCount += 1;
  }
  for (const query of queryList(args.queries, "queries", messages)) {
    parts.push(`--hybrid=${quote(query)}`);
    routeCount += 1;
  }
  for (const query of queryList(args.fts, "fts", messages)) {
    parts.push(`--fts=${quote(query)}`);
    routeCount += 1;
  }
  for (const query of queryList(args.vector, "vector", messages)) {
    parts.push(`--vector=${quote(query)}`);
    routeCount += 1;
  }
  if (routeCount > MAX_QUERY_ROUTES) {
    throw new Error(
      fill(messages.tooManyQueryRoutes, { count: routeCount, max: MAX_QUERY_ROUTES }),
    );
  }
  return routeCount;
}

/**
 * 路径过滤（glob / iglob / type / type-not）。三条通道共用：实测索引检索、索引命令与
 * 穷举检索（`--rg`）下这四类旗标都被 zg 接受，故只在这里发一次。
 */
function pushPathFilters(
  parts: string[],
  args: SearchArgs,
  messages: ZvecGrepMessages,
  quote: Quote,
): void {
  for (const glob of singleOrList(args.globs, "globs", messages)) {
    parts.push("--glob", quote(glob));
  }
  for (const glob of singleOrList(args.insensitiveGlobs, "insensitiveGlobs", messages)) {
    parts.push("--iglob", quote(glob));
  }
  for (const typeName of singleOrList(args.fileTypes, "fileTypes", messages)) {
    parts.push("--type", quote(typeName));
  }
  for (const typeName of singleOrList(args.excludedFileTypes, "excludedFileTypes", messages)) {
    parts.push("--type-not", quote(typeName));
  }
}

/** 时间过滤：两条检索通道共用（实测 `--modified-after` 在 `--rg` 下被接受）。 */
function pushTimeFilters(
  parts: string[],
  args: SearchArgs,
  messages: ZvecGrepMessages,
  quote: Quote,
): void {
  const after = optionalText(args.modifiedAfter, "modifiedAfter", messages, MAX_TIME_CHARS);
  if (after.length > 0) {
    parts.push("--modified-after", quote(after));
  }
  const before = optionalText(args.modifiedBefore, "modifiedBefore", messages, MAX_TIME_CHARS);
  if (before.length > 0) {
    parts.push("--modified-before", quote(before));
  }
}

/** 追加检索过滤 globs（路径过滤 + 仅索引通道支持的符号类型）。 */
function pushSearchGlobs(
  parts: string[],
  args: SearchArgs,
  messages: ZvecGrepMessages,
  quote: Quote,
): void {
  pushPathFilters(parts, args, messages, quote);
  for (const symbolKind of symbolTypesOf(args.symbolTypes, messages)) {
    parts.push("--symbol-type", quote(symbolKind));
  }
}

/** 取单条 query 的原文（与 pushQueryArgs 同一取值器）。 */
function singleText(args: SearchArgs, messages: ZvecGrepMessages): string {
  return optionalText(args.query, "query", messages, MAX_QUERY_CHARS);
}

/** 分类过滤（0.3.0 新增 `--category` / `--category-not`，可重复；值域由上游校验）。 */
function pushCategoryFilters(
  parts: string[],
  args: SearchArgs,
  messages: ZvecGrepMessages,
  quote: Quote,
): void {
  for (const name of singleOrList(args.category, "category", messages)) {
    parts.push("--category", quote(name));
  }
  for (const name of singleOrList(args.categoryNot, "categoryNot", messages)) {
    parts.push("--category-not", quote(name));
  }
}

function buildIndexedCommand(
  args: SearchArgs,
  root: string,
  messages: ZvecGrepMessages,
  mode: ClientMode,
  backgroundSupport: BackgroundSupport,
): BuiltCommand {
  // 0.3.0 起没有 `zg query` 子命令：管理动作全部旗标化，裸词是搜索文本（上游帮助原文
  // "Bare words such as query, index, and help are literal search text"）。命令因此以 `zg`
  // 开头，查询主体由 pushQueryArgs 的显式路由旗标给出。
  const parts: string[] = ["zg"];
  const quote = quoteFor(args.platform ?? "posix");
  const routeCount = pushQueryArgs(parts, args, messages, quote);
  if (routeCount === 0) {
    throw new Error(messages.searchNeedsQuery);
  }
  if (boolOf(args.fuse, "fuse", messages)) {
    parts.push("--fuse");
  }
  // --preview 语义：none = 每命中仅 1 行锚点源码；short = 锚点 + 有界上下文窗口；
  // full = 整段源码；detail = 0.3.0 新增，另附符号/签名/Range 等结构化字段并按文件分组。
  // 缺省 short——给模型 short 能少读几次文件、更准判断相关性，同时避免 full 撑爆上下文；
  // 模型要整段函数体时可显式改。
  const refresh = refreshOf(args.refresh, messages);
  // background 要有守护进程才成立（见 REFRESH_TABLE 与 BackgroundSupport 的注释）。判据由
  // 宿主算（它同时握着传输模式与探测能力），这里只把它折成一次构造期拒绝：命令照发的话 zg
  // 会把刷新关掉、只留一行 stderr warning，而模型读到的是「后台刷新已启用」这个假结论。
  // 两种不可用各有各的文案——叫用户去 `zg --server on` 对「部署钉死 direct」那档是指错方向。
  //
  // `mode` 先判：它就在本函数手上，`backgroundSupport` 是调用方另算的一位。宿主在 direct
  // 模式下返回的正是 `mode-direct`（先于探测结果），两者本来一致；以 `mode` 为准的好处是
  // 真传岔时落在「部署钉死 direct」这句真正的原因上，不会把用户引去起守护进程。因此
  // `backgroundSupport === "mode-direct"` 不必再单独判——它在 mode 非 direct 时不可达。
  if (refresh === "background" && mode === "direct") {
    throw new Error(fill(messages.refreshBackgroundPinnedDirect, { root }));
  }
  if (refresh === "background" && backgroundSupport === "daemon-down") {
    throw new Error(fill(messages.refreshBackgroundNeedsServer, { root }));
  }
  parts.push(
    "--limit",
    String(resolveLimit(args.limit, messages)),
    "--preview",
    previewOf(args.preview, messages),
    "--refresh",
    refresh,
  );
  pushSearchGlobs(parts, args, messages, quote);
  pushCategoryFilters(parts, args, messages, quote);
  if (boolOf(args.preferSymbol, "preferSymbol", messages)) {
    parts.push("--prefer-symbol");
  }
  // --trace：每条命中附检索轨迹（0.3.0 起轨迹是命中体后的独立 `score:` / `trace:` 行，
  // 不再进头行）。排障用，平时不用——它会让每条命中多出两行纯诊断文本。
  if (boolOf(args.trace, "trace", messages)) {
    parts.push("--trace");
  }
  pushTimeFilters(parts, args, messages, quote);
  parts.push(deviceFlag(args.device, messages, quote), modeFlag(mode));
  return assembled(parts, root, messages, args.platform ?? "posix");
}

/**
 * 穷举/文件发现两通道下 zg 明确拒绝的索引侧旗标，逐个拦在构造阶段。实测报错原文：
 *   `--preview`  → "--preview is not supported with --rg; use -A/-B/-C for rg context"
 *   `--refresh`  → "--rg cannot be combined with indexed refresh options"
 *   `--symbol-type` / `--prefer-symbol` → "--rg cannot be combined with indexed symbol options"
 *   `--fuse`     → "--rg cannot be combined with --fuse"
 *   `--trace`    → "--rg cannot be combined with --trace"
 *   `--fts` / `--vector` → "--rg cannot be combined with --hybrid, --fts, or --vector"
 *   `--category` → 引擎分类是索引侧维度，内容检索与文件发现都不消费它
 * 与其把模型交给一次子进程失败再原样回显 zg 的英文报错，不如在构造阶段就用本包的
 * 双语文案说清「这些是索引侧参数」——并且**不会静默丢掉**用户给的那一项。
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
  if (singleOrList(args.category, "category", messages).length > 0) {
    conflicts.push("category");
  }
  if (singleOrList(args.categoryNot, "categoryNot", messages).length > 0) {
    conflicts.push("categoryNot");
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

/**
 * 文件发现模式（`zg --rg --files`）在穷举内容检索的冲突集之外**再拒**的一批：
 *   - `--limit`：上游明拒，原文 "--limit cannot be combined with --rg --files; use glob or
 *     type filters to narrow the file list"（文件清单无上限是有意设计）；
 *   - query/queries：`--files` 下全部 positional 参数都按**路径**读（上游帮助原文 "With
 *     --files, every positional argument is an input file or directory; no pattern is
 *     required"），query 传进来会被当成一个不存在的目录名——要么整树漏扫要么报错；
 *   - `--device`：文件发现不跑 embedding（上游 FilesOptions 没有这一位），传了只会被
 *     静默忽略——本包不静默收下用不上的参数。
 */
function assertFilesArgs(args: SearchArgs, messages: ZvecGrepMessages): void {
  assertExhaustiveArgs(args, messages);
  const conflicts: string[] = [];
  if (singleText(args, messages).length > 0) {
    conflicts.push("query");
  }
  // limit 用**在场判断**而不是值判断：调用方（host）会把部署的默认 limit 注入进 args，
  // 值判断会把「模型没给 limit、部署默认又不是 10」误判成冲突；在场（模型显式给了）
  // 才是文件清单真正用不上的那一档。host 侧在 files 通道也不再注入默认 limit（见
  // runSearchTool），两侧判据因此一致。
  if (args.limit !== undefined && args.limit !== null) {
    conflicts.push("limit");
  }
  if (optionalText(args.device, "device", messages, MAX_FILTER_CHARS).length > 0) {
    conflicts.push("device");
  }
  if (conflicts.length > 0) {
    throw new Error(fill(messages.filesConflicts, { names: conflicts.join(" | ") }));
  }
}

/**
 * 穷举词法通道（`zg --rg <pattern>`）。与索引通道的合法旗标集合不同，见 assertExhaustiveArgs。
 * 0.3.0 起没有 `zg query` 子命令：`--rg` 直接挂在顶层 `zg` 之后，pattern 仍是第一个
 * positional、其余 positional 全是路径（上游 managed_rg 的解析契约不变）。
 */
function buildExhaustiveCommand(
  args: SearchArgs,
  root: string,
  messages: ZvecGrepMessages,
  mode: ClientMode,
): BuiltCommand {
  assertExhaustiveArgs(args, messages);
  const quote = quoteFor(args.platform ?? "posix");
  const parts: string[] = ["zg", "--rg"];
  // 穷举模式下 query 就是 rg 的 pattern，不再有「多路查询组」这回事。
  const pattern = optionalText(args.query, "query", messages, MAX_QUERY_CHARS);
  if (pattern.length === 0) {
    throw new Error(messages.exhaustiveNeedsPattern);
  }
  // 实测：pattern 以 '-' 开头必须走 -e，否则被当作选项；这是 --rg 自己的约定，
  // 与索引通道的显式路由不是同一件事。
  if (pattern.startsWith("-")) {
    parts.push("-e", quote(pattern));
  } else {
    parts.push(quote(pattern));
  }
  parts.push("--limit", String(resolveLimit(args.limit, messages)));
  pushPathFilters(parts, args, messages, quote);
  pushTimeFilters(parts, args, messages, quote);
  parts.push(deviceFlag(args.device, messages, quote), modeFlag(mode));
  return assembled(parts, root, messages, args.platform ?? "posix");
}

/**
 * 文件发现通道（0.3.0 的 `zg --rg --files`）：不做内容搜索，按当前过滤规则列出文件清单。
 * 上游 `file_selection/policy.rs` 实证三条价值：默认感知 .gitignore/.ignore/.rgignore 三件套、
 * `paths.sort()` 排序、无结果上限（`--limit` 被上游明拒）。过滤面只收路径/时间两族
 * （上游 files_options 的映射面：globs/iglob/type/type-not/modified-after/before），
 * 其余参数由 assertFilesArgs 点名拒绝。
 */
function buildFilesCommand(
  args: SearchArgs,
  root: string,
  messages: ZvecGrepMessages,
  mode: ClientMode,
): BuiltCommand {
  assertFilesArgs(args, messages);
  const quote = quoteFor(args.platform ?? "posix");
  const parts: string[] = ["zg", "--rg", "--files"];
  pushPathFilters(parts, args, messages, quote);
  pushTimeFilters(parts, args, messages, quote);
  parts.push(modeFlag(mode));
  return assembled(parts, root, messages, args.platform ?? "posix");
}

/**
 * 检索通道：索引检索 / 穷举词法 / 文件发现。判据在宿主侧（`pickExhaustive` 的推广，
 * 它才握有索引探测能力），本纯函数只按判据构造。
 */
export type SearchChannel = "indexed" | "exhaustive" | "files";

/**
 * 构造 zg 检索命令（索引通道 / `--rg` 穷举 / `--rg --files` 文件发现）。
 * 注意：zg 没有 --root，root 来自进程 cwd，所以 root 只作为 workdir 返回，绝不进入命令行。
 *
 * 0.3.0 起没有 `zg query` 子命令（见 buildIndexedCommand 的注释）；穷举与文件发现两通道
 * 走顶层 `zg --rg …`。
 *
 * `backgroundSupport` 是宿主算得的「后台刷新能不能用」，只有索引通道用得上（穷举与文件
 * 发现通道本就不接受 refresh）。缺省按**不可用**处理：拿不到判据时把 background 拒掉是
 * 安全的一侧，而把「没算出来」当成「可用」放行等于把一句假话发给模型。
 */
export function buildSearchCommand(
  args: SearchArgs,
  messages: ZvecGrepMessages,
  mode: ClientMode = DEFAULT_CLIENT_MODE,
  channel: SearchChannel = "indexed",
  backgroundSupport: BackgroundSupport = "daemon-down",
): BuiltCommand {
  const platform = args.platform ?? "posix";
  const root = assertAbsoluteRoot(args.root, messages, platform);
  if (channel === "files") {
    return buildFilesCommand(args, root, messages, mode);
  }
  return channel === "exhaustive"
    ? buildExhaustiveCommand(args, root, messages, mode)
    : buildIndexedCommand(args, root, messages, mode, backgroundSupport);
}

export interface IndexArgs {
  root: unknown;
  /** 路径与命令方言（宿主注入；缺省 posix，理由同 SearchArgs.platform）。 */
  platform?: PathPlatform;
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
  /** 扫描嵌套 Git 仓库与子模块（0.3.0 新增 `--nested-git`；默认不含）。 */
  nestedGit?: unknown;
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

/** 非负/正整数字符串化；非 number 或非整数报错（`true` 与数字字符串都不算数字）。 */
function intFlag(value: unknown, name: string, messages: ZvecGrepMessages, min: number): string {
  if (typeof value !== "number") {
    throw new TypeError(fill(messages.intWithReceived, { name, min, received: typeof value }));
  }
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(fill(messages.intRequired, { name, min }));
  }
  return String(value);
}

/** 索引布尔旗标（一次性严格取值，见 readIndexFlags）。 */
interface IndexFlags {
  rebuild: boolean;
  hidden: boolean;
  noIgnore: boolean;
  nestedGit: boolean;
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
    nestedGit: boolOf(args.nestedGit, "nestedGit", messages),
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
 *   - 扩展名大小写：`.pem` / `.p12` / `.pfx` / `.keystore` 都**确实会被索引**（真 zg 0.2.2 实测：
 *     一份只有 `secret.pem` / `secret.P12` / `a.ts` 的工作区，0.2.2 的 `zg index` 回执就是
 *     `3 scanned, 3 added`，随后检索交回 `#1 matchedBy=fts+vector secret.pem:1-2`；0.3.0
 *     的扫描规则旗标（--glob/--iglob）与求值次序未变，这段实测记录仍适用于它的行为面），
 *     且都存在混合大小写变体（`secret.P12` / `secret.PfX` / `secret.KEYSTORE` 同样入索引）。
 *     --glob 的 `!*.p12` 匹配不到 `secret.P12`，--iglob 走大小写不敏感匹配才能全部排除。
 *     判据钉在 test/e2e/zg-cli.test.ts 的「密钥排除真的在挡东西」那一组。
 *   - 规则次序：CLI 通道按命令行的**混排顺序**求值、后规则覆盖前规则（上游 zg-cli 的
 *     ordered_glob_rules 保留 -g/--iglob 的出现次序，不是「全部 --glob 先于全部 --iglob」；
 *     只有 MCP 面才是 globs 之后追加 insensitiveGlobs）。密钥规则若用 --glob 且排在用户
 *     规则之前，用户一条宽泛的正向 --iglob（如 `**`）会在其后求值并把无扩展名的
 *     `id_rsa*` 救回索引（实测「被索引」）；用 --iglob 且排在本函数最后（用户 iglob
 *     之后），任何用户正向规则都无法覆盖它。
 * 纯 `!` 取反已实测可独立工作。excludeSecrets=false 可整体关闭。
 */
function pushIndexGlobs(
  parts: string[],
  args: IndexArgs,
  flags: IndexFlags,
  messages: ZvecGrepMessages,
  quote: Quote,
): void {
  for (const glob of singleOrList(args.globs, "globs", messages)) {
    parts.push("--glob", quote(glob));
  }
  for (const glob of singleOrList(args.insensitiveGlobs, "insensitiveGlobs", messages)) {
    parts.push("--iglob", quote(glob));
  }
  for (const typeName of singleOrList(args.fileTypes, "fileTypes", messages)) {
    parts.push("--type", quote(typeName));
  }
  for (const typeName of singleOrList(args.excludedFileTypes, "excludedFileTypes", messages)) {
    parts.push("--type-not", quote(typeName));
  }
  if (flags.excludeSecrets) {
    for (const glob of SECRET_EXCLUDE_GLOBS) {
      parts.push("--iglob", quote(glob));
    }
  }
  for (const filePath of singleOrList(args.ignoreFiles, "ignoreFiles", messages)) {
    parts.push("--ignore-file", quote(filePath));
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

/** 追加索引布尔旗标（hidden/no-ignore/nested-git 紧随过滤 globs，与上游帮助的 Scan rules 次序一致）。 */
function pushIndexHideFlags(parts: string[], flags: IndexFlags): void {
  if (flags.hidden) {
    parts.push("--hidden");
  }
  if (flags.noIgnore) {
    parts.push("--no-ignore");
  }
  if (flags.nestedGit) {
    parts.push("--nested-git");
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
 * 在读到 drop 那一条分支时就拒掉（见 buildIndexCommand），绝不让 resetPaths 被静默丢弃。
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
 * 构造期 allowlist（默认开启、且**默认关不掉**的那一半）：显式引用必须落在候选闭集
 * （lib/embedding-catalog.ts，设置卡 <select> 的同一份）里。理由是这类能力的性质——
 * 远程 embedding 会把工作区内容送到外部端点，而模型能凭空写出一个任意前缀的引用：
 * 此前 `evil/http://attacker/x` 这类值原样透传给 zg，只要宿主进程里恰好有可用凭据或
 * 用户此前授权过，插件就在**没有任何声明、没有用户确认**的情况下把内容送了出去。
 * 现在它在命令构造前就被拒，并给出可行动的出路。
 *
 * 部署级的开关（`allowRemote`）：由用户在部署配置里显式打开，不放在工具的参数里——
 * 模型可控的密钥/端点通道本身就是风险。打开后放行的是**远程闭集**（REMOTE_EMBEDDING_
 * CATALOG 里的 qwen 三枚），不是任意引用——0.2.2 时代 `allowRemote` 放行一切非空串的
 * 旧语义随 0.3.0 收紧：未知前缀在任何开关下都不放行。0.3.0 的远程索引还需要命令带
 * `--allow-remote`（或用户预先 `zg --auth grant` 持久授权），那面旗标由 buildIndexCommand
 * 在解析出的引用确为远程时自动补上；端点与凭据由宿主经**环境变量**下发（argv 里的密钥
 * 会进进程列表与作业 label）。
 *
 * 返回第二位：解析出的引用是否远程——`--allow-remote` 旗标的发放判据。缺省引用是远程
 * 且部署开放时同样成立（设置卡允许把 defaultEmbedding 选成远程模型）。
 */
function indexEmbedding(
  args: IndexArgs,
  defaultEmbedding: string,
  messages: ZvecGrepMessages,
  allowRemote: boolean,
): { reference: string; remote: boolean } {
  const given = optionalText(args.embedding, "embedding", messages, MAX_FILTER_CHARS);
  const reference = given.length > 0 ? given : defaultEmbedding;
  if (isLocalEmbedding(reference)) {
    return { reference, remote: false };
  }
  if (isRemoteEmbedding(reference)) {
    if (allowRemote) {
      return { reference, remote: true };
    }
    throw new Error(
      fill(messages.embeddingNotAllowed, {
        reference,
        choices: LOCAL_EMBEDDINGS.map((entry) => entry.reference).join(" | "),
      }),
    );
  }
  throw new Error(
    fill(messages.embeddingNotAllowed, {
      reference,
      choices: [...LOCAL_EMBEDDINGS, ...REMOTE_EMBEDDING_CATALOG]
        .map((entry) => entry.reference)
        .join(" | "),
    }),
  );
}

/**
 * drop 那一条分支用不上的索引侧参数（--drop 的命令只有 `--index <root> --drop`）。
 * 只在这里点名：出现任何一个，drop 那条分支整体拒绝，而不是静默丢掉——布尔旗标在那之前已按
 * 类型校验过、丢弃无声，其余参数连类型都没校验，两种待遇并存会让
 * `{drop:true, hidden:"yes"}` 报错而 `{drop:true, maxDepth:"3"}` 静默通过。
 */
const INDEX_ONLY_PARAMS: readonly (keyof IndexArgs)[] = [
  "rebuild",
  "embedding",
  "globs",
  "insensitiveGlobs",
  "fileTypes",
  "excludedFileTypes",
  "ignoreFiles",
  "hidden",
  "noIgnore",
  "nestedGit",
  "excludeSecrets",
  "maxDepth",
  "maxFileSizeBytes",
  "follow",
  "embeddingConcurrency",
  "device",
];

/**
 * 构造 zg index 命令（0.3.0：`zg --index <root> …`，root 是位置参数（转义））。
 * - drop=true：`zg --index <root> --drop --mode <mode>`；0.3.0 起没有 `--yes`
 *   （上游帮助原文 "Dropping an index runs immediately without a confirmation prompt."，
 *   实测 `--yes` 直接 exit 2），索引侧参数与 drop 互斥（resetPaths 另有单独互斥文案），
 *   出现即点名拒绝。
 * - 否则：`zg --index <root> --embedding <m> [--rebuild] ... --mode <mode>`。
 * embedding 缺省时由调用方传入 defaultEmbedding（设置里的默认值）；解析出的引用过构造期
 * 闭集 allowlist（见 indexEmbedding），且引用为远程时自动补 `--allow-remote`
 * （0.3.0 的非交互远程索引没有它就被 PERMISSION_DENIED 拒，上游报错文案原文）。
 * 传输模式与检索、状态共用同一个入参：三条命令混用模式会在守护进程持有索引租约时
 * 让写侧直接失败，故一致性由构造器的必填入参强制。
 * 旗标顺序与 filter globs 交错固定（embedding → allow-remote → rebuild → globs → hidden →
 * no-ignore → nested-git → max-depth → max-filesize → follow → embedding-concurrency →
 * reset-paths），不得重排（测试锁死）。
 */
export function buildIndexCommand(
  args: IndexArgs,
  defaultEmbedding: string,
  messages: ZvecGrepMessages,
  mode: ClientMode = DEFAULT_CLIENT_MODE,
  allowRemote = false,
): BuiltCommand {
  const platform = args.platform ?? "posix";
  const root = assertAbsoluteRoot(args.root, messages, platform);
  const quote = quoteFor(platform);
  const parts: string[] = ["zg", "--index", quote(root)];
  const flags = readIndexFlags(args, messages);

  if (boolOf(args.drop, "drop", messages)) {
    // drop 那一条分支整条命令只有 `--index <root> --drop`，任何别的旗标都不进命令。
    // resetPaths 是唯一真与它互斥的（上游也拒这一对），单独点名；其余索引侧
    // 参数一次列全后拒绝——用户以为清了继承设置/带了过滤，其实那条 zg 只会把索引删掉。
    if (boolOf(args.resetPaths, "resetPaths", messages)) {
      throw new Error(messages.dropWithResetPaths);
    }
    const ignored = INDEX_ONLY_PARAMS.filter(
      (name) => args[name] !== undefined && args[name] !== null,
    );
    if (ignored.length > 0) {
      throw new Error(fill(messages.dropWithIndexArgs, { names: ignored.join(" | ") }));
    }
    parts.push("--drop", modeFlag(mode));
    return assembled(parts, root, messages, args.platform ?? "posix");
  }

  const { reference, remote } = indexEmbedding(args, defaultEmbedding, messages, allowRemote);
  parts.push("--embedding", quote(reference));
  if (remote) {
    // 0.3.0 的非交互远程授权门槛（上游 authorization.rs）：没有 workspace grant 时，
    // 非交互索引必须带这一位；有 grant 时带上也无害（跳过的只是「已授权」检查）。
    parts.push("--allow-remote");
  }
  pushIndexBoolFlags(parts, flags);
  pushIndexGlobs(parts, args, flags, messages, quote);
  pushIndexHideFlags(parts, flags);
  pushIndexIntFlags(parts, args, messages);
  pushIndexFollowFlag(parts, flags);
  pushIndexConcurrencyFlag(parts, args, messages);
  pushIndexResetPathsFlag(parts, args, messages);
  parts.push(deviceFlag(args.device, messages, quote), modeFlag(mode));
  return assembled(parts, root, messages, args.platform ?? "posix");
}

export interface StatusArgs {
  root: unknown;
  /** 路径与命令方言（宿主注入；缺省 posix）。 */
  platform?: PathPlatform;
  checkReady?: unknown;
}

/**
 * 构造 zg status 命令（0.3.0：`zg --status <root>`；传输模式与另两条命令同源）。
 *
 * `checkReady` 透传 `--check-ready`：zg 的帮助原文是「preserves the normal output and
 * exits non-zero unless the Workspace index is ready」——即**就绪报告照常打在 stdout，
 * 只用退出码表达就绪与否**。所以宿主侧必须成对处理这两半：报告要交回，退出码要翻译成
 * 结论，不能像普通失败那样只留 stderr 把 stdout 丢掉（实测未就绪时 stdout 正是那份
 * 「Coverage Unavailable (index not configured) …」四字段报告）。
 */
export function buildStatusCommand(
  args: StatusArgs,
  messages: ZvecGrepMessages,
  mode: ClientMode = DEFAULT_CLIENT_MODE,
): BuiltCommand {
  const platform = args.platform ?? "posix";
  const root = assertAbsoluteRoot(args.root, messages, platform);
  const parts: string[] = ["zg", "--status", shq(root, platform)];
  if (boolOf(args.checkReady, "checkReady", messages)) {
    parts.push("--check-ready");
  }
  parts.push(modeFlag(mode));
  return assembled(parts, root, messages, args.platform ?? "posix");
}
