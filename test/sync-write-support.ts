// 生产源码「不写盘」判据的支撑面：源码文件的收集器与调用形状。
//
// 为什么单独成模块（而不是留在 *.test.ts 里）：这道门的判据本身要被探针直接驱动
// （造一枚软链目录、塞一个别名 import，看它认不认得出），留在测试文件里就只能靠
// vitest 的全局执行环境，探针没法复用同一份实现。
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { stripComments, stringSpans } from "./schema-coverage.ts";

/** 计入源码面的扩展名：只认 `.ts` 的话，`.mts` / `.cts` 入口会静默逃逸。 */
export const SOURCE_EXTENSIONS: readonly string[] = [".ts", ".mts", ".cts"];

/**
 * 递归收集目录下的源码文件。
 *
 * 软链要跟着看：`readdir(withFileTypes)` 交回的 dirent 对符号链接既不是 `isDirectory()`
 * 也未必带 `.ts` 后缀，静默跳过就等于「把 lib/ 换成一枚软链」能让整道门空转。
 * 断链在这里让 `stat` 抛出去——判据宁可红，也不要量出一份假的干净。
 */
export async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(full);
      }
      if (entry.isSymbolicLink()) {
        // 断链在这里抛出去：判据宁可红，也不要量出一份假的干净。
        const target = await stat(full);
        if (target.isDirectory()) {
          return sourceFiles(full);
        }
      }
      return SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) ? [full] : [];
    }),
  );
  return nested.flat();
}

/** 剥注释、保留字符串：`fs["writeFileSync"](…)` 这一档要靠字符串里的名字认出来。 */
export function codeKeepingStrings(source: string): string {
  return stripComments(source);
}

/** 剥注释并抹掉字符串内容：报错文案里贴一句 `writeFileSync(…)` 不该把门禁判红。 */
export function codeBlankingStrings(source: string): string {
  const stripped = stripComments(source);
  let out = "";
  let cursor = 0;
  for (const [start, end] of stringSpans(stripped)) {
    out += stripped.slice(cursor, start);
    out += " ".repeat(end - start);
    cursor = end;
  }
  return out + stripped.slice(cursor);
}

/** 写盘/改元数据的同步 API：期望值独立写死，不从 oxlint.config.ts 的 scope 表派生。 */
export const WRITE_APIS: readonly string[] = [
  "mkdirSync",
  "mkdtempSync",
  "rmSync",
  "writeFileSync",
  "chmodSync",
];

/**
 * 名单里每一条被**取用**的形状。命中即算一处。
 *
 * 为什么改名这一档也要判：本机实测 oxlint 的 `node/no-sync` 认不出两种改名
 * （`import { writeFileSync as w }` 与 `const { writeFileSync: w } = fs` 各跑一次真 lint，
 * 命中都是 0；它认得出直接调用、`?.(` 与 `fs["writeFileSync"](` 那三种），
 * 于是改名这条路只有这道门看着。这里判的是**改名这件事**本身，不追改名后的调用点。
 *
 * 与对象字面量的键同形（`{ writeFileSync: someFn }`）会被这一档一起判红：
 * 生产源码里出现「以写盘 API 的名字做键、值又是一个标识符」本来就该被看一眼，
 * 判据不为此让步（值写成字面量、布尔、引号串的都不命中）。
 */
export function writeCallHits(source: string): string[] {
  const kept = codeKeepingStrings(source);
  const blanked = codeBlankingStrings(source);
  return WRITE_APIS.filter((api) => {
    const called = new RegExp(`(?<![\\w$])${api}\\s*\\??\\.?\\s*\\(`, "u").test(blanked);
    // 属性式取用后再调：`writeFileSync.call(...)` / `.apply(...)`
    const invoked = new RegExp(`(?<![\\w$])${api}\\s*\\.\\s*(?:call|apply)\\s*\\(`, "u").test(
      blanked,
    );
    // 方括号取用：`fs["writeFileSync"](…)`（名字写在串里，所以这一档看保留字符串的那份文本）
    const bracketed = new RegExp(`\\[\\s*["'\`]${api}["'\`]\\s*\\]\\s*\\??\\.?\\s*\\(`, "u").test(
      kept,
    );
    const renamed = new RegExp(`(?<![\\w$])${api}\\s+as\\s+[\\w$]+`, "u").test(kept);
    // 解构改名：`const { writeFileSync: w } = fs`。值必须是标识符才算数，
    // 字面量/布尔/引号串那几类键值不命中，避免把配置对象判红。
    const destructured = new RegExp(
      `\\{[^}]*(?<![\\w$])${api}\\s*:\\s*[A-Za-z_$][\\w$]*\\s*[,}]`,
      "u",
    ).test(blanked);

    return called || invoked || bracketed || renamed || destructured;
  });
}
