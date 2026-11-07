// lib/daemon-args.ts —— SearchArgs（索引通道）到 zg 守护进程 `zvec_grep_search`
// MCP 参数的**纯映射**。CLI 通道不走这里：它由 lib/cli.ts 的 buildIndexedCommand
// 直接构造 argv；两条通道的取值纪律完全同源（同一批取值器、同样「非法类型即抛」），
// 差异只有传输形状本身。
//
// 与 CLI 面的三处已知差异（全部有上游源码依据，见各条注释）：
//   1. preview 档位：MCP 面只有 short|full（0.3.0 zvec_grep_search 的 inputSchema 现量），
//      none→short、detail→full 就近降级；
//   2. refresh 语义：CLI 的 wait/off/background 映射为 freshness（eventual|wait_for_fresh）
//      与 autoUpdate 的组合（上游 zg-transport-mcp 的 SearchInput 折算：auto_update ||=
//      wait_for_fresh；refresh = wait_for_fresh→Wait、auto_update→Background、否则 Off。
//      **autoUpdate 的 serde 缺省是 true**，所以 off 必须显式带 autoUpdate:false，否则
//      「不刷新」会静默变成后台刷新）；
//   3. device：MCP 检索面没有这一位（模型池在 daemon 侧），显式传入直接拒绝——本包不
//      静默丢参数。
// 文件类型位与 CLI 同名同义：SearchInput.file_types 的上游原文是「Ripgrep type names,
// such as ts, py, h or cpp」——与 CLI `--type` 同一维度；includedFormats 是另一个维度
// （文件名推断的格式，如 rust/markdown），与本包 fileTypes 参数无关。

import type { ZvecGrepMessages } from "./messages.ts";
import type { SearchArgs } from "./cli.ts";
import { boolOf, previewOf, refreshOf, resolveLimit, symbolTypesOf } from "./cli.ts";
import {
  MAX_QUERY_CHARS,
  MAX_FILTER_CHARS,
  MAX_TIME_CHARS,
  optionalText,
  singleOrList,
  stringList,
} from "./argv-guard.ts";

/** MCP 面接受的 preview 档位（0.3.0 inputSchema 枚举现量）。 */
const DAEMON_PREVIEW = { short: "short", full: "full" } as const;

/** preview 就近降级：none 只留锚点 → short 最接近；detail 要结构化全文 → full 是上限档。 */
function daemonPreviewOf(value: unknown, messages: ZvecGrepMessages): string {
  const preview = previewOf(value, messages);
  if (preview === "none" || preview === "short") {
    return DAEMON_PREVIEW.short;
  }
  return DAEMON_PREVIEW.full;
}

/** 查询路由主体（query/queries/fts/vector/fuse）。 */
function pushQueryRoutes(
  mapped: Record<string, unknown>,
  args: SearchArgs,
  messages: ZvecGrepMessages,
): void {
  const query = optionalText(args.query, "query", messages, MAX_QUERY_CHARS);
  if (query.length > 0) {
    mapped["query"] = query;
  }
  const queries = stringList(args.queries, "queries", messages, 32, MAX_QUERY_CHARS);
  if (queries.length > 0) {
    mapped["queries"] = queries;
  }
  const fts = stringList(args.fts, "fts", messages, 32, MAX_QUERY_CHARS);
  if (fts.length > 0) {
    mapped["fts"] = fts;
  }
  const vector = stringList(args.vector, "vector", messages, 32, MAX_QUERY_CHARS);
  if (vector.length > 0) {
    mapped["vector"] = vector;
  }
  if (boolOf(args.fuse, "fuse", messages)) {
    mapped["fuse"] = true;
  }
}

/** 路径/格式/分类/符号/时间过滤族的映射（与 CLI 通道同一批取值器）。 */
function pushFilters(
  mapped: Record<string, unknown>,
  args: SearchArgs,
  messages: ZvecGrepMessages,
): void {
  const globs = singleOrList(args.globs, "globs", messages);
  if (globs.length > 0) {
    mapped["globs"] = globs;
  }
  const insensitive = singleOrList(args.insensitiveGlobs, "insensitiveGlobs", messages);
  if (insensitive.length > 0) {
    mapped["insensitiveGlobs"] = insensitive;
  }
  const fileTypes = singleOrList(args.fileTypes, "fileTypes", messages);
  if (fileTypes.length > 0) {
    mapped["fileTypes"] = fileTypes;
  }
  const excludedFileTypes = singleOrList(args.excludedFileTypes, "excludedFileTypes", messages);
  if (excludedFileTypes.length > 0) {
    mapped["excludedFileTypes"] = excludedFileTypes;
  }
  const categories = singleOrList(args.category, "category", messages);
  if (categories.length > 0) {
    mapped["categories"] = categories;
  }
  const excludedCategories = singleOrList(args.categoryNot, "categoryNot", messages);
  if (excludedCategories.length > 0) {
    mapped["excludedCategories"] = excludedCategories;
  }
  const symbolTypes = symbolTypesOf(args.symbolTypes, messages);
  if (symbolTypes.length > 0) {
    mapped["symbolTypes"] = symbolTypes;
  }
  if (boolOf(args.preferSymbol, "preferSymbol", messages)) {
    mapped["preferSymbol"] = true;
  }
  if (boolOf(args.trace, "trace", messages)) {
    mapped["trace"] = true;
  }
  const modifiedAfter = optionalText(args.modifiedAfter, "modifiedAfter", messages, MAX_TIME_CHARS);
  if (modifiedAfter.length > 0) {
    mapped["modifiedAfter"] = modifiedAfter;
  }
  const modifiedBefore = optionalText(
    args.modifiedBefore,
    "modifiedBefore",
    messages,
    MAX_TIME_CHARS,
  );
  if (modifiedBefore.length > 0) {
    mapped["modifiedBefore"] = modifiedBefore;
  }
}

export function daemonSearchArgs(
  args: SearchArgs,
  messages: ZvecGrepMessages,
): Record<string, unknown> {
  if (optionalText(args.device, "device", messages, MAX_FILTER_CHARS).length > 0) {
    throw new Error(messages.deviceUnsupportedOnDaemon);
  }
  const mapped: Record<string, unknown> = {
    root: args.root,
    limit: resolveLimit(args.limit, messages),
    preview: daemonPreviewOf(args.preview, messages),
  };
  pushQueryRoutes(mapped, args, messages);
  // refresh → freshness/autoUpdate（上游 zg-transport-mcp 的 SearchInput 折算：
  // auto_update ||= wait_for_fresh；refresh = wait_for_fresh→Wait、auto_update→Background、
  // 否则 Off。**autoUpdate 的 serde 缺省是 true**——off 必须显式带 false，否则「不刷新」
  // 会被折成后台刷新）：
  //   wait → wait_for_fresh（Wait）
  //   background → eventual + autoUpdate:true（Background）
  //   off → eventual + autoUpdate:false（Off）
  const refresh = refreshOf(args.refresh, messages);
  if (refresh === "wait") {
    mapped["freshness"] = "wait_for_fresh";
  } else {
    mapped["freshness"] = "eventual";
    mapped["autoUpdate"] = refresh === "background";
  }
  pushFilters(mapped, args, messages);
  return mapped;
}
