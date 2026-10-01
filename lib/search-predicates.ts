// lib/search-predicates.ts —— search-first 门禁的**判据层**：一次检索算不算「本工作区里的
// grep/rg」，分三面回答——命令文本面（isGrepRgCommand）、目标路径面（normalizeRoot /
// pathInsideRoot / hasExternalTarget）、解锁额度面（SearchUnlock / unlockActive）。
//
// 为什么从 lib/routing.ts 拆出来：这里只有「是不是 / 在不在 / 还有效吗」，编排（向上找索引
// 根、扣额度、拼拦截文案）全留在 routing.ts。拆开后编排侧成了这些判据唯一的非测试消费者；
// 此前它们与编排同处一文件并 export，`fallow --production` 便把这层边界上的取用一律判成
// 「只被测试养着的导出」（同 lib/argv-guard.ts 之于 lib/cli.ts 的口径）。
//
// shell 切词层（tokenizeShell 与那几张字符集表）**不**导出：它是命令面的内部实现，引号/
// 注释/命令位的规则改一处会同时影响 isGrepRgCommand 与 hasExternalTarget，故与这两条判据
// 同处一文件。
//
// 纯函数三不动：不触盘、不看时钟、不读设置——索引探测与时钟由 routing.ts 的 SearchFirstDeps
// 向宿主取；文案双语同一口径：消息表（lib/messages.ts 的一份）由调用点作入参注入。

import { normalizeAbsolutePath } from "./cli.ts";
import type { ZvecGrepMessages } from "./messages.ts";

const GREP_COMMAND_NAMES = new Set(["grep", "egrep", "fgrep", "rg"]);
/** 含这些旗标的命令会立即打印并退出（--help/--version/-V），不产生检索。 */
const PROBE_FLAGS = new Set(["--help", "--version", "-V"]);
/**
 * 包装/前缀命令：其首个实参本身就是「被执行的命令」，同样算命令位
 * （`git grep`、`… | xargs grep TODO`、`env rg foo` 都是真检索）。
 */
const SEARCH_PREFIX_WORDS = new Set([
  "git",
  "xargs",
  "env",
  "nohup",
  "sudo",
  "time",
  "timeout",
  "nice",
  "parallel",
]);
/** 结束一个 token、但**不**开启新命令位的字符（空白、右括号、重定向）。 */
const TOKEN_BREAK_CHARS = new Set([" ", "\t", "\v", "\f", ")", "<", ">"]);
/** 结束一个 token 并让紧随其后的 token 处于命令位（控制符 / 换行 / 反引号 / 组）。 */
const COMMAND_BREAK_CHARS = new Set(["|", ";", "&", "(", "\n", "\r", "`", "{", "}"]);
/** 引号字符：词首开引号、词尾闭引号都只有这两个，用集合而不是逐字符比较。 */
const QUOTE_CHARS = new Set(["'", '"']);

/** 一个 shell token：文本（引号已剥除）+ 是否落在命令位。 */
interface ShellToken {
  text: string;
  atCommand: boolean;
}

/**
 * 当前引号状态下，这个字符是否只是要写进 buffer 的字面量（既不结束引号、也不参与分隔）。
 * 单引号内一切皆字面量，只有同种引号本身能收束；双引号还认 `\` 转义，故反斜杠也出列。
 */
function isQuotedLiteral(char: string, quote: string): boolean {
  return (quote === "'" && char !== "'") || (quote === '"' && char !== '"' && char !== "\\");
}

/**
 * 注释段读完后的续读下标：停在行尾换行**之前**（循环末尾还有一次 +1），换行才能照常
 * 充当命令分隔符——否则会连 `\n` 一起跳过，`# x\ngrep foo` 里的真检索就被漏掉。
 * 串内已无换行 = 注释一直到串尾。
 */
function indexAfterComment(command: string, from: number): number {
  const nextLine = command.indexOf("\n", from);
  return nextLine === -1 ? command.length : nextLine - 1;
}

/**
 * 手写 shell 切词（只为「找出命令位上的命令名」服务，不做完整求值）：
 *   - 单/双引号与反斜杠转义**内部**的字符不参与分隔 → `echo "grep x"`、
 *     `printf 'grep'`、`git commit -m "use rg"` 里的字面量不再被当成命令
 *     （旧实现把引号当分隔符，故这三种全被判为检索 → 过度拦截）；
 *   - 引号外、词首的 `#` 起为注释，整段跳到行尾；
 *   - 控制符（`|` `;` `&` `(` 换行 反引号 `{` `}`）之后的 token 记为命令位。
 * 双引号内保留字面内容（含空格），故 `"/usr/bin/rg foo"` 是一个非命令位 token。
 */
function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  const state = { buffer: "", atCommand: true, quote: "" };
  const flush = (): void => {
    if (state.buffer.length > 0) {
      tokens.push({ text: state.buffer, atCommand: state.atCommand });
      state.buffer = "";
      // 只有真吐出 token 才消费掉命令位：`cat a | grep x` 里 `|` 与 `grep` 之间的
      // 那个空格也必须让位（空 flush 若清位，控制符后的第一个词就丢了命令位）。
      state.atCommand = false;
    }
  };
  let index = 0;
  let escaped = false;
  while (index < command.length) {
    // slice 而非 command[index]：越界给空串而不是 undefined（省掉一个不可能的分支）
    const char = command.slice(index, index + 1);
    if (escaped) {
      state.buffer += char;
      escaped = false;
    } else if (isQuotedLiteral(char, state.quote)) {
      state.buffer += char;
    } else if (state.quote === "" && char === "#" && state.buffer.length === 0) {
      // 注释跳到行尾（见 indexAfterComment：必须停在换行前一步）
      index = indexAfterComment(command, index);
    } else if (char === "\\") {
      escaped = true;
    } else if (QUOTE_CHARS.has(char)) {
      // 词中开/闭引号（grep'rg'）合并进同一 token：混淆写法照拦。
      // 走到这里 quote 只可能是「空」或「与 char 同种」（异种引号在更上面的分支已被
      // 当作字面量吃进 buffer），故一个三元即覆盖开/闭两种情形。
      state.quote = state.quote === char ? "" : char;
    } else if (COMMAND_BREAK_CHARS.has(char)) {
      flush();
      state.atCommand = true;
    } else if (TOKEN_BREAK_CHARS.has(char)) {
      flush();
    } else {
      state.buffer += char;
    }
    index += 1;
  }
  flush();
  return tokens;
}

/** token 的命令名（basename，小写）；`-*` 选项一律不算命令名（返回空串）。 */
function baseName(text: string): string {
  if (text.startsWith("-")) {
    return "";
  }
  return text.slice(text.lastIndexOf("/") + 1).toLowerCase();
}

/**
 * 挑出处在「被执行位置」的 token：串首 / 控制符之后 / 包装命令（git、xargs、
 * env…）之后的第一个实参。
 */
function commandPositionTokens(tokens: ShellToken[]): ShellToken[] {
  const out: ShellToken[] = [];
  let afterPrefix = false;
  for (const token of tokens) {
    const isCommand: boolean = token.atCommand || afterPrefix;
    if (isCommand) {
      out.push(token);
    }
    afterPrefix = isCommand && SEARCH_PREFIX_WORDS.has(baseName(token.text));
  }
  return out;
}

/**
 * 识别 bash/pwsh 命令串里的 grep/rg 检索调用：引号/注释感知切词后，只认
 * **命令位**上的 token 名（basename）精确匹配 grep/egrep/fgrep/rg
 * （大小写不敏感）。管道 `… | grep foo`、绝对路径 `/usr/bin/rg foo`、
 * `git grep foo`、`find … | xargs grep TODO` 均算检索；`--grep=x` 选项、路径
 * 片段（grepbar）、引号内字面量与注释里的 grep 都不算。
 * 已知近似（均为漏拦方向，代价由 systemPrompt 路由文本兜底）：
 *   - --help/--version/-V 豁免按整条命令判断（`rg a --version && grep b c`
 *     复合命令会漏拦 grep）；
 *   - shell 关键字（`for … ; do grep`、`if … ; then rg`）不是控制符，其后的
 *     grep 不在命令位；`VAR=1 grep x` 同理。
 */
export function isGrepRgCommand(command: string): boolean {
  const tokens = tokenizeShell(command);
  if (tokens.some((token) => PROBE_FLAGS.has(token.text))) {
    return false;
  }
  return commandPositionTokens(tokens).some((token) =>
    GREP_COMMAND_NAMES.has(baseName(token.text)),
  );
}

/** 去掉尾部斜杠的 root 归一化（'/' 自身保持 '/'）。 */
export function normalizeRoot(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed.length > 0 ? trimmed : "/";
}

/**
 * 判断检索目标是否落在 root 之内（按路径段前缀，防 /fo 误吞 /foo）。
 * target 缺省/空串 = 缺省搜整个工作区（原生 grep 工具语义）→ true；
 * 相对路径按相对 root 解析（含 ../ 逃逸检测）。
 * 与 cli 的 assertAbsoluteRoot 同一归一化函数，但语义相反一侧不能抛错：
 * 归一化时 `..` 越出文件系统根，说明目标必然在 root 之外 → 直接 false
 * （这里是「判范围」，不是「判合法性」）。messages 只为把归一化异常喂给
 * normalizeAbsolutePath——那条文本在这里被丢弃，出界才是结论。
 */
export function pathInsideRoot(
  target: string | undefined,
  root: string,
  messages: ZvecGrepMessages,
): boolean {
  if (target === undefined || target.trim().length === 0) {
    return true;
  }
  const base = normalizeRoot(root);
  const targetText = target.trim();
  const joined = targetText.startsWith("/") ? targetText : `${base}/${targetText}`;
  let absolute: string;
  try {
    absolute = normalizeAbsolutePath(joined, messages);
  } catch {
    return false;
  }
  return absolute === base || absolute.startsWith(`${base}/`);
}

/**
 * bash/pwsh 命令串中是否存在「索引根之外」的路径证据。
 * 只认明确的路径形状：以 / 开头的绝对路径、含 / 的相对路径（含 ../ 逃逸）、
 * 以及裸 `..`（父目录）。flag 选项（-*）与无路径形状的 token（模式词、文件名）
 * 跳过。返回 true = 命令明确检索索引根之外的目标 → 门禁放行（与原生 grep 工具
 * 的 pathInsideRoot 出界放行语义一致）。
 * 切词同样引号/注释感知：注释里的路径不再是证据；引号内的整串是一个 token
 * （`grep x "注释 里的 /tmp/p"` 仍按含 / 的 token 判外部目标，属已知近似——
 * 方向是放行，宁可漏拦）。
 * 已知近似：bash 自由文本无法可靠区分「模式」与「相对路径」token，故 `../` 形态
 * 的模式词可能被误判为外部目标而放行（漏拦，安全方向）；混合目标（如
 * `rg foo /repo/src /tmp/x`）因存在外部绝对路径而整体放行。
 */
export function hasExternalTarget(
  root: string,
  command: string,
  messages: ZvecGrepMessages,
): boolean {
  const base = normalizeRoot(root);
  for (const token of tokenizeShell(command)) {
    const { text } = token;
    // flag 选项（-*）跳过；仅认明确的路径形状：绝对路径 / 含 / 的相对路径 / 裸 ..
    const isPathShape =
      !text.startsWith("-") && (text.startsWith("/") || text.includes("/") || text === "..");
    if (isPathShape && !pathInsideRoot(text, base, messages)) {
      return true;
    }
  }
  return false;
}

/** 一次成功的 zg_search 发放的 grep/rg 解锁额度：剩余次数 + 过期时刻（epoch ms）。 */
export interface SearchUnlock {
  grepsLeft: number;
  expiresAt: number;
}

/** 解锁是否可用：存在、有余量、未过期。 */
export function unlockActive(unlock: SearchUnlock | undefined, now: number): boolean {
  return unlock !== undefined && unlock.grepsLeft > 0 && now < unlock.expiresAt;
}
