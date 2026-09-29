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
  stringList,
} from "./argv-guard.ts";

const LIMIT_MIN = 1;
const LIMIT_MAX = 50;
export const DEFAULT_LIMIT = 10;

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

/** 布尔旗标严格取值：缺省回 fallback，非布尔即报错（`1`/`"true"` 不算真）。 */
function boolOf(
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

/** 整条命令的规模闸门：超 MAX_COMMAND_BYTES 即拒（防 E2BIG 与无界内存）。 */
function assembled(
  parts: string[],
  workdir: string,
  messages: ZvecGrepMessages,
): { command: string; workdir: string } {
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

/** 追加检索过滤 globs（glob/iglob/type/type-not/symbol-type）。 */
function pushSearchGlobs(parts: string[], args: SearchArgs, messages: ZvecGrepMessages): void {
  for (const glob of stringList(args.globs, "globs", messages)) {
    parts.push("--glob", shq(glob));
  }
  for (const glob of stringList(args.insensitiveGlobs, "insensitiveGlobs", messages)) {
    parts.push("--iglob", shq(glob));
  }
  for (const typeName of stringList(args.fileTypes, "fileTypes", messages)) {
    parts.push("--type", shq(typeName));
  }
  for (const typeName of stringList(args.excludedFileTypes, "excludedFileTypes", messages)) {
    parts.push("--type-not", shq(typeName));
  }
  for (const symbolKind of stringList(args.symbolTypes, "symbolTypes", messages)) {
    parts.push("--symbol-type", shq(symbolKind));
  }
}

/** 取单条 query 的原文（与 pushQueryArgs 同一取值器，保证 dashGuard 两侧一致）。 */
function singleText(args: SearchArgs, messages: ZvecGrepMessages): string {
  return optionalText(args.query, "query", messages, MAX_QUERY_CHARS);
}

/**
 * 构造 zg query 命令。注意：zg query 没有 --root，root 来自进程 cwd，
 * 所以 root 只作为 workdir 返回，绝不进入命令行。
 */
export function buildSearchCommand(
  args: SearchArgs,
  messages: ZvecGrepMessages,
): { command: string; workdir: string } {
  const root = assertAbsoluteRoot(args.root, messages);
  const parts: string[] = ["zg", "query"];
  const { routeCount, dashGuard } = pushQueryArgs(parts, args, messages);
  if (routeCount === 0) {
    throw new Error(messages.searchNeedsQuery);
  }
  if (boolOf(args.fuse, "fuse", messages)) {
    parts.push("--fuse");
  }
  // --preview short：与官方 zvec_grep_search（MCP）保持一致。zg 的 preview 语义：
  //   none  = 每命中仅 1 行锚点源码；short = 锚点 + 有界上下文窗口；full = 整段源码。
  // 给模型 short 能少读几次文件、更准判断相关性，同时避免 full 撑爆上下文。
  parts.push("--limit", String(clampLimit(args.limit)), "--preview", "short", "--refresh", "wait");
  pushSearchGlobs(parts, args, messages);
  if (boolOf(args.preferSymbol, "preferSymbol", messages)) {
    parts.push("--prefer-symbol");
  }
  const after = optionalText(args.modifiedAfter, "modifiedAfter", messages, MAX_FILTER_CHARS);
  if (after.length > 0) {
    parts.push("--modified-after", shq(after));
  }
  const before = optionalText(args.modifiedBefore, "modifiedBefore", messages, MAX_FILTER_CHARS);
  if (before.length > 0) {
    parts.push("--modified-before", shq(before));
  }
  parts.push(deviceFlag(args.device, messages), "--mode", "direct");
  // '-' 开头的 positional query 放最后、以 `--` 分隔（clap：-- 后全是位置参数）。
  if (dashGuard) {
    parts.push("--", shq(singleText(args, messages)));
  }
  return assembled(parts, root, messages);
}

export interface IndexArgs {
  root: unknown;
  embedding?: unknown;
  rebuild?: unknown;
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
 * 密钥排除：默认开，可 excludeSecrets=false 关；纯 `!` 取反已实测可独立工作。
 */
function pushIndexGlobs(
  parts: string[],
  args: IndexArgs,
  flags: IndexFlags,
  messages: ZvecGrepMessages,
): void {
  for (const glob of stringList(args.globs, "globs", messages)) {
    parts.push("--glob", shq(glob));
  }
  for (const glob of stringList(args.insensitiveGlobs, "insensitiveGlobs", messages)) {
    parts.push("--iglob", shq(glob));
  }
  for (const typeName of stringList(args.fileTypes, "fileTypes", messages)) {
    parts.push("--type", shq(typeName));
  }
  for (const typeName of stringList(args.excludedFileTypes, "excludedFileTypes", messages)) {
    parts.push("--type-not", shq(typeName));
  }
  if (flags.excludeSecrets) {
    for (const glob of SECRET_EXCLUDE_GLOBS) {
      parts.push("--glob", shq(glob));
    }
  }
  for (const filePath of stringList(args.ignoreFiles, "ignoreFiles", messages)) {
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
 * 构造 zg index 命令。root 是位置参数（转义）。
 * - drop=true：`zg index <root> --drop --yes --mode direct`（非交互 shell 必须 --yes）。
 * - 否则：`zg index <root> --embedding <m> [--rebuild] ... --mode direct`。
 * embedding 缺省时由调用方传入 defaultEmbedding（设置里的默认值）。
 * 旗标顺序与 filter globs 交错固定（rebuild → globs → hidden → no-ignore →
 * max-depth → max-filesize → follow → embedding-concurrency），不得重排（测试锁死）。
 */
export function buildIndexCommand(
  args: IndexArgs,
  defaultEmbedding: string,
  messages: ZvecGrepMessages,
): { command: string; workdir: string } {
  const root = assertAbsoluteRoot(args.root, messages);
  const parts: string[] = ["zg", "index", shq(root)];
  const flags = readIndexFlags(args, messages);

  if (boolOf(args.drop, "drop", messages)) {
    parts.push("--drop", "--yes", "--mode", "direct");
    return assembled(parts, root, messages);
  }

  const given = optionalText(args.embedding, "embedding", messages, MAX_FILTER_CHARS);
  const embedding = given.length > 0 ? given : defaultEmbedding;
  parts.push("--embedding", shq(embedding));
  pushIndexBoolFlags(parts, flags);
  pushIndexGlobs(parts, args, flags, messages);
  pushIndexHideFlags(parts, flags);
  pushIndexIntFlags(parts, args, messages);
  pushIndexFollowFlag(parts, flags);
  pushIndexConcurrencyFlag(parts, args, messages);
  parts.push(deviceFlag(args.device, messages), "--mode", "direct");
  return assembled(parts, root, messages);
}

export interface StatusArgs {
  root: unknown;
}

/** 构造 zg status 命令（root 位置参数）。 */
export function buildStatusCommand(
  args: StatusArgs,
  messages: ZvecGrepMessages,
): { command: string; workdir: string } {
  const root = assertAbsoluteRoot(args.root, messages);
  const parts: string[] = ["zg", "status", shq(root), "--mode", "direct"];
  return assembled(parts, root, messages);
}
