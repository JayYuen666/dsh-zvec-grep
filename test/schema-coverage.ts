// test/schema-coverage.ts —— 卡片字段覆盖门禁（多包共用，复制式分发，同 client-freshness.ts）。
//
// 背景：host.ts 导出的 Config 里标了 `.volatile()` 的字段会被宿主投影成设置表单
// （0.1.7 起隐式注册：命名空间 = profile 条目 id，旧的 `settings.register(ns, schema, base)`
// 三面已删），于是可能出现 N 个可配字段里 client 卡片只渲染 M 个（M < N）——那 N-M 个
// 字段用户无法从 UI 触及，只能改 settings 底层或读源码。曾踩过的坑：quality-gate 的
// `memoryFeedback`（功能性开关）在卡片漏项，反复审查后才被发现。
//
// 做法：解析 host.ts 的 Schema.object 字段名 + client 源码树（src/** + lib/**）实际绑定的
// 字段名，断言后者 ⊇ 前者。漏项必须显式列入 allowUnbound 并给理由——测试同时校验
// allowUnbound 里的每一项确实未被绑定、确实存在于 host schema（防止"挂名豁免"与拼错字段）。
//
// 用法（test/build-client.test.ts 顶层 await 一次；vitest/require-hook 把裸调用判成 setup，
// describe/beforeAll 都不行——helper 里的 it() 必须落在收集期）：
//   await declareSchemaCoverage(import.meta.url)
//   await declareSchemaCoverage(import.meta.url, {
//     allowUnbound: [{ field: 'x', reason: '仅 CLI 侧使用，UI 无入口' }],
//   })
//
// 解析口径：收**全部** `Schema.object(` 块的并集；实参是字面量就取顶层键，是标识符就回溯到
// 同名 `const` 字面量；字符串、模板串与注释里的括号不参与配对；解析不了的块报成问题项
// 而不是静默跳过——否则"解析器少认一种写法"和"这个包没有设置 schema"在结果上无法区分。
//
// 注意：绑定识别是"出现即算绑定"的宽松启发式（见 boundFieldsIn）。它会**漏拦**也会**假绿**：
//   · 多认（注释里的 set('x')、别的对象上的同名键）→ 门禁更宽松，那是已知代价；
//   · 少认（组件是 .tsx、字段名拼在模板串里）→ 功能性缺失被放过，那是真漏拦。
// 所以注释先剥一遍（字符串保留——字段名本身就写在字符串里）；扩展名白名单收 .tsx；
// 测试文件与 __tests__ 目录不进绑定面（那里大量出现 set('x')，会把未绑定判成已绑定）。

import { it } from "vitest";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AllowUnbound {
  field: string;
  reason: string;
}

/** 字符串或注释的跨度：`end` 是它之后的下标，`quote` 是跨过之后所处的引号状态。 */
interface LiteralSpan {
  readonly end: number;
  readonly quote: string;
  readonly kind: "comment" | "string";
}

/** 行注释/块注释的收尾下标（找不到收尾就吃到文末）。 */
function commentEndAfter(text: string, index: number): number {
  const isLine = text.charAt(index + 1) === "/";
  const stop = isLine ? text.indexOf("\n", index) : text.indexOf("*/", index + 2);
  if (stop === -1) {
    return text.length;
  }
  return isLine ? stop : stop + 2;
}

const isQuoteChar = (char: string): boolean => char === '"' || char === "'" || char === "`";

/**
 * `index` 处若是字符串/注释的开头（或正处在字符串内部），交回它的跨度；否则交回 `null`。
 *
 * 三处文本扫描（取字段名、配括号、剥注释）都要认同一套字面量边界，抄三份就会三处不同步，
 * 所以只在这里定义一次。转义只认反斜杠（模板串里的 `${}` 不需要特判：里面出现的括号属于
 * 表达式，本来该参与配对）。
 */
function literalAt(text: string, index: number, quote: string): LiteralSpan | null {
  const char = text.charAt(index);
  let span: LiteralSpan | null = null;
  if (quote !== "") {
    const end = index + (char === "\\" ? 2 : 1);
    const nextQuote = char === "\\" || char !== quote ? quote : "";
    span = { end, quote: nextQuote, kind: "string" };
  } else if (char === "/" && (text.charAt(index + 1) === "/" || text.charAt(index + 1) === "*")) {
    span = { end: commentEndAfter(text, index), quote: "", kind: "comment" };
  } else if (isQuoteChar(char)) {
    span = { end: index + 1, quote: char, kind: "string" };
  }
  return span;
}

/** `index` 处的「顶层键」：词首的标识符且其后紧跟冒号。 */
function keyAt(block: string, index: number): { name: string; end: number } | null {
  const char = block.charAt(index);
  const prev = index === 0 ? "" : block.charAt(index - 1);
  const startsWord = /[A-Za-z_$]/u.test(char) && (prev === "" || /[\s,{[(]/u.test(prev));
  const name = startsWord ? (/^[A-Za-z_$][\w$]*/u.exec(block.slice(index))?.[0] ?? "") : "";
  const isKey =
    name !== "" &&
    block
      .slice(index + name.length)
      .trimStart()
      .startsWith(":");
  return isKey ? { name, end: index + name.length } : null;
}

/**
 * 对象字面量的**顶层**键（逐字符扫描，不用行首缩进猜层级）。
 *
 * 按行首两个空格取键的旧写法有两个洞：① 单行写法一个键都取不到；② 缩进一旦不是两格
 * （一层嵌套对象恰好也缩两格、或被格式化到四格）就会把嵌套键当顶层键。改成按花括号/
 * 圆括号/方括号的深度扫：深度 0 处的 `标识符:` 才是这个对象的顶层键。键的**值**不看——
 * `rules: RulesFieldSchema` 这类标识符引用与 `Schema.string()` 同样算一个字段。
 */
function literalTopLevelKeys(block: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  for (let index = 0; index < block.length; index += 1) {
    const span = literalAt(block, index, quote);
    const char = block.charAt(index);
    const key = span === null && quote === "" && depth === 0 ? keyAt(block, index) : null;
    if (span !== null) {
      ({ quote } = span);
      index = span.end - 1;
    } else if (key !== null) {
      out.push(key.name);
      index = key.end - 1;
    } else if (char === "{" || char === "(" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === ")" || char === "]") {
      depth -= 1;
    }
  }
  return out;
}

/** 配括号的行走状态。 */
interface BracketWalk {
  started: boolean;
  depth: number;
  out: string;
}

/** 非字面量位置的一步。交回 `true` 表示刚收到配平的右括号（区段到此结束）。 */
function bracketStep(
  state: BracketWalk,
  char: string,
  openChar: string,
  closeChar: string,
): boolean {
  if (!state.started) {
    state.started = char === openChar;
    state.depth = state.started ? 1 : 0;
    return false;
  }
  if (char === openChar) {
    state.depth += 1;
    state.out += char;
    return false;
  }
  if (char !== closeChar) {
    state.out += char;
    return false;
  }
  state.depth -= 1;
  if (state.depth === 0) {
    return true;
  }
  state.out += char;
  return false;
}

/**
 * 从 `open` 处的括号起取配对括号内的文本；没配对上时返回空串。
 *
 * 字符串、模板串与注释里的括号不参与配对——按字符数深度的旧写法，块里只要出现 `")"`
 * 或一行 `// )` 就会提前收尾，块后半段的字段全被截掉，而部分截断不会报错。
 */
function sliceInside(text: string, open: number, openChar: string, closeChar: string): string {
  const state: BracketWalk = { started: false, depth: 0, out: "" };
  let quote = "";
  for (let index = open; index < text.length; index += 1) {
    const span = literalAt(text, index, quote);
    if (span !== null) {
      state.out += span.kind === "comment" ? "" : text.slice(index, span.end);
      ({ quote } = span);
      index = span.end - 1;
    } else if (bracketStep(state, text.charAt(index), openChar, closeChar)) {
      return state.out;
    }
  }
  return "";
}

/** 括号家族的两个便捷入口（花括号取对象字面量、圆括号取实参）。 */
const bracesAt = (text: string, open: number): string => sliceInside(text, open, "{", "}");
const parensAt = (text: string, open: number): string => sliceInside(text, open, "(", ")");

/** `Schema.object(` 的实参 → 字段名；字面量直取顶层键，标识符回溯到同名 const 字面量。 */
function fieldsOfSchemaArgument(hostTs: string, argument: string): string[] {
  const trimmed = argument.trim();
  if (trimmed.startsWith("{")) {
    return literalTopLevelKeys(trimmed.slice(1, -1));
  }
  const identifier = /^(?<name>[A-Za-z_$][\w$]*)$/u.exec(trimmed)?.groups?.["name"] ?? "";
  if (identifier === "") {
    return [];
  }
  const declaration = new RegExp(
    `(?:const|let|var)\\s+${identifier}\\s*(?::[^=]+)?=\\s*\\{`,
    "u",
  ).exec(hostTs);
  if (declaration === null) {
    return [];
  }
  return literalTopLevelKeys(bracesAt(hostTs, declaration.index + declaration[0].length - 1));
}

/**
 * 去掉注释（块注释整段抹掉、行注释抹到行尾），保留字符串原样。
 *
 * 块起点判定与绑定识别都要扫**这条之后**的文本：注释里写着的 `Schema.object({ legacy: 1 })`
 * 会被当成块起点、被注释掉的旧代码里的 `field: 'x'` 会算成"已绑定"，一个虚构漏项、一个假绿。
 * 字符串不剥：字段名本身就写在字符串里（`set("importAllowRoots")`），抹了等于一个都认不出。
 */
function stripComments(src: string): string {
  let out = "";
  let quote = "";
  for (let index = 0; index < src.length; index += 1) {
    const span = literalAt(src, index, quote);
    if (span === null) {
      out += src.charAt(index);
    } else {
      out += span.kind === "comment" ? "" : src.slice(index, span.end);
      ({ quote } = span);
      index = span.end - 1;
    }
  }
  return out;
}

/**
 * 从 host.ts 抽取**全部** `Schema.object(...)` 块内的字段名（并集）。
 * 解析不了的块不静默跳过，由调用方把块首原文报成问题项。
 */
function hostSchemaFields(source: string): { fields: string[]; unresolved: string[] } {
  const hostTs = stripComments(source);
  const marker = "Schema.object(";
  const fields = new Set<string>();
  const unresolved: string[] = [];
  let from = 0;
  for (;;) {
    const start = hostTs.indexOf(marker, from);
    if (start === -1) {
      break;
    }
    from = start + marker.length;
    const open = hostTs.indexOf("(", start);
    const argument = open === -1 ? "" : parensAt(hostTs, open);
    const parsed = argument === "" ? [] : fieldsOfSchemaArgument(hostTs, argument);
    if (parsed.length === 0) {
      unresolved.push(
        argument === "" ? `${marker}… 的括号没有配对` : `${marker}${argument.trim().slice(0, 40)})`,
      );
    }
    for (const field of parsed) {
      fields.add(field);
    }
  }
  return { fields: [...fields], unresolved };
}

/** 捕获组取值（严格模式下 matchAll 捕获为 `string | undefined`，这里收口为 string）。 */
function group(match: RegExpExecArray, index: number): string {
  return match[index] ?? "";
}

/** 扫描一个 client 源文件，收集作为「设置写入第一参」出现的字段名字面量。 */
function boundFieldsIn(source: string): Set<string> {
  const src = stripComments(source);
  const out = new Set<string>();
  // 输入行组件的 field prop：field: 'x'
  for (const match of src.matchAll(/\bfield\s*:\s*["'](?<name>[A-Za-z_$][\w$]*)["']/gu)) {
    out.add(group(match, 1));
  }
  // 各种写入惯用法：props.set('x' / set('x' / unset('x' / fireAndForget('x' / writeSet('x'
  //   刻意不要求限定 receiver——各包惯用法不同（props.set / fireAndForget / writer.set），
  //   收得太紧会假阴性。字段名是否算"绑定"由 declareSchemaCoverage 与 host 字段名交集判定。
  for (const match of src.matchAll(
    /\b(?:set|unset|fireAndForget|writeSet|commit)\s*\(\s*["'](?<name>[A-Za-z_$][\w$]*)["']/gu,
  )) {
    out.add(group(match, 1));
  }
  return out;
}

/** 卡片源码的扩展名白名单：组件可能是 .tsx，别只看 .ts。 */
const CLIENT_SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"] as const;

/** 测试文件的形状：里面的 set('x') / field: 'x' 是断言不是绑定。 */
const TEST_FILE_SHAPE = /(?:^|[/.])(?:test|spec)\.[jt]sx?$|__tests__/u;

/**
 * 递归收集目录下所有卡片源文件文本。跳过 node_modules、test 形状与软链（不跟随——
 * 目录自指的软链会让递归不收敛）；readdir 带 withFileTypes 一次拿到类型，不做会跟链的 stat。
 * 读不动的条目跳过：调用方的契约是「交回绑定集」，门禁自己不抛。
 */
async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const chunks = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.name !== "node_modules" &&
          entry.name !== "__tests__" &&
          !entry.isSymbolicLink() &&
          !TEST_FILE_SHAPE.test(entry.name),
      )
      .map(async (entry): Promise<string[]> => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          return walk(fullPath);
        }
        if (CLIENT_SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
          try {
            return [await readFile(fullPath, "utf8")];
          } catch {
            return [];
          }
        }
        return [];
      }),
  );
  return chunks.flat();
}

/** client 侧实际绑定的字段名集合（只扫 `src/` 与 `lib/` 两棵树）。 */
async function clientBoundFields(pkgDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const sources = [
    ...(await walk(path.join(pkgDir, "src"))),
    ...(await walk(path.join(pkgDir, "lib"))),
  ];
  for (const src of sources) {
    for (const field of boundFieldsIn(src)) {
      out.add(field);
    }
  }
  return out;
}

/**
 * 声明「卡片字段覆盖 host schema」门禁。读不到 package.json / host.ts、解析不出块、
 * 豁免表挂名/拼错/缺理由，都进同一张问题清单，在用例里一次断言——空清单即通过。
 */
export async function declareSchemaCoverage(
  testFileUrl: string,
  opts: { allowUnbound?: AllowUnbound[] } = {},
): Promise<void> {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const pkgDir = path.resolve(testDir, "..");
  const readOrProblem = async (name: string): Promise<string | null> => {
    try {
      return await readFile(path.resolve(pkgDir, name), "utf8");
    } catch {
      return null;
    }
  };
  const pkgJson = await readOrProblem("package.json");
  if (pkgJson === null) {
    throw new Error(
      `[schema-coverage] 读不到 ${pkgDir}/package.json：包目录推导错了，或测试文件不在包根的下一层`,
    );
  }
  const pkgName = /"name":\s*"(?<name>[^"]+)"/u.exec(pkgJson)?.groups?.["name"] ?? "unknown";
  const hostTs = await readOrProblem("host.ts");
  if (hostTs === null) {
    throw new Error(`[${pkgName}] 读不到 ${pkgDir}/host.ts：卡片字段覆盖门禁要求 host 与测试同仓`);
  }
  const { fields: hostFields, unresolved } = hostSchemaFields(hostTs);
  const bound = await clientBoundFields(pkgDir);
  const declared = opts.allowUnbound ?? [];
  const exemptions = new Map(declared.map((item) => [item.field, item.reason]));
  const problems: string[] = [];

  // 解析不了的 Schema.object 块单独报：否则"本包换了写法"与"本包没有设置 schema"结果相同，
  // 门禁会静默缩小到一个子集上照绿。
  if (unresolved.length > 0) {
    problems.push(
      [
        `[${pkgName}] 以下 Schema.object 块的字段名解析不出来（改了解析器认得的写法）：`,
        ...unresolved.map((snippet) => `  ${snippet}`),
        `→ 让 test/schema-coverage.ts 的 fieldsOfSchemaArgument 认这种写法，别再靠"解析失败就跳过"。`,
      ].join("\n"),
    );
  }
  if (hostFields.length === 0) {
    problems.push(`[${pkgName}] host.ts 未找到 Schema.object 字段（解析失败或该包无设置）`);
  }
  const missing = hostFields.filter((field) => !bound.has(field));
  const unexempted = missing.filter((field) => !exemptions.has(field));
  if (unexempted.length > 0) {
    problems.push(
      `[${pkgName}] 以下 host 设置字段卡片未暴露：${unexempted.join(", ")}\n` +
        `host 字段全集：${hostFields.join(", ")}\n` +
        `卡片已绑定：${[...bound].join(", ")}\n` +
        `→ 补卡片控件；若确实不该有 UI 入口，在 declareSchemaCoverage 的 allowUnbound 里\n` +
        `  显式声明 { field, reason }（测试会校验被豁免项确实未绑定，防止挂名豁免）。`,
    );
  }
  // 重复声明：Map 会让后者静默覆盖前者（两份理由只剩一份），这本身就是该报的账。
  const duplicated = [
    ...new Set(
      declared
        .map((item) => item.field)
        .filter((field, index, all) => all.indexOf(field) !== index),
    ),
  ];
  if (duplicated.length > 0) {
    problems.push(
      `[${pkgName}] allowUnbound 有重复条目（后一条会覆盖前一条的理由）：${duplicated.join(", ")}`,
    );
  }
  // 反向校验：豁免项若其实已绑定，说明豁免过时——删除即可，留着会让门禁失效。
  const stale = [...exemptions].filter(([field]) => bound.has(field));
  if (stale.length > 0) {
    problems.push(
      `[${pkgName}] allowUnbound 已过时——这些字段其实已绑定，请删除豁免声明：${stale.map(([field, reason]) => `${field}（${reason}）`).join(", ")}`,
    );
  }
  // 豁免项必须在 host 字段里真的存在：拼错字段名或 host 侧改名之后，这条豁免会静默失效。
  const unknownExemptions = [...exemptions.keys()].filter((field) => !hostFields.includes(field));
  if (unknownExemptions.length > 0) {
    problems.push(
      `[${pkgName}] allowUnbound 指向了 host schema 里不存在的字段（拼错或 host 侧已改名）：${unknownExemptions.join(", ")}`,
    );
  }
  // 豁免必须有理由，否则等于无门禁。
  const noReason = [...exemptions].filter(
    ([, reason]) => typeof reason !== "string" || reason.trim().length === 0,
  );
  if (noReason.length > 0) {
    problems.push(
      `[${pkgName}] allowUnbound 项缺少 reason：${noReason.map(([field]) => field).join(", ")}`,
    );
  }

  it(`${pkgName}: 卡片覆盖 host schema 全部字段（改 host 字段必须同步卡片或声明豁免）`, () => {
    assert.deepEqual(problems, []);
  });
}
