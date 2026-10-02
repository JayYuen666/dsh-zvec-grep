// lib/argv-guard.ts —— 交给 `zg` 的 argv 的**唯一闸门层**：转义、规模上限、默认排除片段。
//
// 为什么从 lib/cli.ts 拆出来：这三族东西共同回答一个问题——「这串用户可控输入能不能
// 进最终命令」。它们被本包三个命令构造器（search/index/status）与两条工具的生产路径
// 逐条消费，判据本身与「命令长什么样」无关，故与 cli.ts 分家；此前 export 只因单测也按
// 这层边界取用，`fallow --production` 因此把它们判成「只被测试养着的导出」。
//
// 报错文案双语：与 lib/cli.ts 同一口径——消息表（lib/messages.ts 的一份）由调用点作入参
// 注入，纯函数不读设置；本模块的校验文本原样回显给模型（工具失败信息）。

import { fill } from "./messages.ts";
import type { ZvecGrepMessages } from "./messages.ts";

// ── 命令规模上限（防 E2BIG / 防单条超长 query 打爆 argv）────────────────────
// 三档上限与 zg 自己对外的契约取齐（[MCP_MAX_QUERY_GROUPS / MCP_MAX_QUERY_CHARS /
// MCP_MAX_PATH_FILTERS / MCP_MAX_PATH_CHARS]），不是本包自己拍的数：插件是 zg 的入口，
// 放得比上游宽只会让模型拿到一个「本插件允许、但 zg 侧本来就该拒」的参数形状，收窄到
// 闭集里则能在构造阶段就报出人话。`MAX_QUERY_ROUTES` 与 `LIMIT_MAX` 原本已取齐。
//
// MAX_COMMAND_BYTES 是本包自己的一档：整条命令经 `bash -c <command>` 作为**单个** argv 项
// 传给内核，Linux MAX_ARG_STRLEN≈128KB、macOS ARG_MAX 总量 1MB，取 64K 字符留一半余量。
export const MAX_COMMAND_BYTES = 64_000;
/** 检索路由（query/queries/fts/vector）合计组数上限。 */
export const MAX_QUERY_ROUTES = 32;
/** 单条 query 文本上限（再长属误用：zg 的语义检索按句切分）。 */
export const MAX_QUERY_CHARS = 4000;
/** 过滤类数组（globs/types/…）单项条数上限。只在本模块作 `stringList` 的缺省档，不外露。 */
const MAX_FILTER_ITEMS = 128;
/** 过滤类数组单项长度上限（glob 不该长成文章）。 */
export const MAX_FILTER_CHARS = 1024;

/** POSIX sh 单引号转义：' → '\''。把任意字符串安全放进单引号内，防注入。 */
export function shq(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** 长度上界校验（超限即抛，避免整条命令撑爆 argv）。 */
function assertTextLen(
  value: string,
  name: string,
  messages: ZvecGrepMessages,
  maxChars: number,
): string {
  if (value.length > maxChars) {
    throw new TypeError(fill(messages.textTooLong, { name, maxChars, actual: value.length }));
  }
  return value;
}

/**
 * 可选文本取值：未给 → 空串；非字符串 → 报错（绝不静默降级成默认值）；
 * 去首尾空白并校验 NUL 与长度。
 */
export function optionalText(
  value: unknown,
  name: string,
  messages: ZvecGrepMessages,
  maxChars: number,
): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new TypeError(fill(messages.mustBeString, { name, received: typeof value }));
  }
  if (value.includes("\u0000")) {
    throw new Error(fill(messages.noNulBytes, { name }));
  }
  return assertTextLen(value.trim(), name, messages, maxChars);
}

/**
 * 字符串数组规范化：非数组报错；**非字符串项报错**（旧实现静默丢弃，模型写
 * `globs:["src/**", 5]` 时用户以为 5 那条过滤生效了）；含 NUL 报错；超条数/
 * 超长度报错；trim 后空串丢弃。
 */
export function stringList(
  value: unknown,
  name: string,
  messages: ZvecGrepMessages,
  maxItems: number = MAX_FILTER_ITEMS,
  maxChars: number = MAX_FILTER_CHARS,
): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError(fill(messages.mustBeStringArray, { name }));
  }
  if (value.length > maxItems) {
    throw new TypeError(fill(messages.tooManyItems, { name, maxItems, actual: value.length }));
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new TypeError(fill(messages.nonStringItem, { name, received: typeof item }));
    }
    if (item.includes("\u0000")) {
      throw new Error(fill(messages.noNulBytes, { name }));
    }
    const trimmed = assertTextLen(item.trim(), name, messages, maxChars);
    if (trimmed.length > 0) {
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * 路径过滤类参数的取值：单值与数组两种形态都收，规范化成数组后交给 `stringList` 走同
 * 一套校验（trim / 去空串 / NUL / 条数 / 长度）。
 *
 * 兼容单值是因为上游就这么收：zg 自己的对外契约里 globs / insensitiveGlobs / fileTypes /
 * excludedFileTypes / ignoreFiles 都是「一个字符串或一个字符串数组」的并集，只收数组
 * 会让模型按上游习惯写单个 glob 时撞上「必须是字符串数组」——形状没错、形状太严。
 * 其余类型错误（非字符串、非数组的其它值）仍然照旧报错，不做任何静默降级。
 */
export function singleOrList(
  value: unknown,
  name: string,
  messages: ZvecGrepMessages,
  maxItems: number = MAX_FILTER_ITEMS,
  maxChars: number = MAX_FILTER_CHARS,
): string[] {
  return stringList(
    typeof value === "string" ? [value] : value,
    name,
    messages,
    maxItems,
    maxChars,
  );
}

/**
 * 默认密钥排除：只收无歧义的私钥/密钥库格式（实测这类文件常既不在
 * .gitignore、也不以 `.` 开头，会躲过 zg 默认规则被索引，把私钥带进向量库并
 * 可能回显到模型上下文）。刻意不含 `*secret*` / `*credential*` 这类宽泛词
 * 模式——它们会误伤正常源码与文档，造成"为什么搜不到"的隐性困惑。
 *
 * 这里只给**模式**，用哪个旗标发出由调用方决定：调用方必须以大小写不敏感形式
 * （--iglob）发出并排在用户规则之后。实测 `.p12` / `.pfx` / `.keystore` 都有混合
 * 大小写变体（`secret.P12` / `secret.PfX` / `secret.KEYSTORE` 皆会入索引），
 * 大小写敏感的 `--glob` 排除不掉；`id_rsa*` 这类无扩展名规则还额外依赖「排在
 * 用户正向 --iglob 之后」才能不被覆盖。详见 lib/cli.ts 的 pushIndexGlobs。
 *
 * 残留缺口：扩展名规则覆盖不到无扩展名的密钥文件（如 `myprivatekey`、
 * `rsa_private`），id_rsa* / id_ed25519* 只覆盖 OpenSSH 默认命名。这类文件需走
 * ignoreFiles（--ignore-file），由使用者显式声明，不在此处用宽泛词模式兜底。
 * excludeSecrets=false 可整体关闭。
 */
export const SECRET_EXCLUDE_GLOBS: readonly string[] = [
  "!*.pem",
  "!*.key",
  "!*.p12",
  "!*.pfx",
  "!*.keystore",
  "!id_rsa*",
  "!id_ed25519*",
];
