// test/publish-manifest.test.ts —— 发布形态门禁：入口面必须**与发布器无关**地可解析。
//
// 为什么值得一条测试：构建与单测都在源码侧跑绿，而真实故障发生在装出去之后。两类坑都在
// 那一侧。其一是入口指向没随包发出去的文件；其二是入口覆盖写在 `publishConfig` 里——
// pnpm 发布时把它合并到顶层，npm 不合并（npm 会打印
// "Unknown publishConfig config main/exports" 并忽略），同一个仓库换个发布器就发出一个
// import 必失败的包。这里不模仿任何发布器的实现，而是把不变式钉成断言：**顶层入口自己就
// 完整可解析，且 publishConfig 不再承载入口字段**，于是两套发布器语义的差恒为空。
//
// 第二组门禁扫注释：日期与轮次编号写下时有用，读的人只会困惑，且没有任何读者能从中重建
// 当时的上下文。只扫注释行与文档；测试夹具里的日期（modifiedAfter 之类的边界值）是数据，
// 角色文档里的日期是内容，两者都不在禁面内。
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pkgDir = path.join(import.meta.dirname, "..");

/** manifest 文件名：三处引用共用同一份事实源（files 清单、readSurface、产物扫描的负例）。 */
const MANIFEST_FILE = "package.json";

/**
 * 只在注释与文档里禁的指涉：日期，以及**本机绝对路径**。
 *
 * 绝对路径这条是实测逼出来的：注释里一句「示例路径 `/Users/<账号>/x`」会被打包器原样搬进
 * 随包发布的 `host.js`，于是本机用户名出现在公共 tarball 里。正则要求路径段以字母数字开头，
 * 所以注释里 `<home>`、`<posix home>` 这类占位写法不命中。
 *
 * 「轮次编号」刻意不进门禁。本仓的 `本轮` / `第 N 轮` 绝大多数指的是**会话轮次**这个产品概念
 * （`第一轮消息不支持 fork`、gate 的「下一轮重新计数」），而不是写下这段注释时的工作轮次。
 * 两种含义在中文里同形，机器分不开；要禁只能靠逐条人工判断，那不是门禁能做到的事。
 */
const FORBIDDEN_IN_COMMENTS: readonly RegExp[] = [
  /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/u,
  /\/(?:Users|home)\/[\w.-]+/u,
];

/**
 * 随包产出的文件里禁的指涉。
 *
 * rolldown 会剥掉注释，所以注释门读不到产物——而「本机绝对路径、包管理器内部路径」这两类
 * 恰恰是会跟着字符串字面量与 `//#region` 注释头进产物的。构建机的 `.pnpm/` 内容寻址路径若
 * 落进声明或产物，消费方在自己机器上解析不到。
 */
const FORBIDDEN_IN_ARTIFACTS: readonly RegExp[] = [
  /\/(?:Users|home)\/[\w.-]+/u,
  // 这一条同时覆盖 node_modules/.pnpm/…：含后者的串必然也含 .pnpm/，所以不必再写一条
  // node_modules[\\/]\.pnpm 的死规则（它永不产生额外判定，只会让人误以为两条各管一类形态）。
  /\.pnpm[\\/]/u,
];

/**
 * 随包发布的产物文件后缀（声明文件与产物同等对待）。
 *
 * 只认 .js 会漏掉 .mjs/.cjs，尤其漏掉最重要的 .d.ts：本组门禁的意图明写「落进声明或产物
 * 都不允许」，而声明面正是消费方 tsc 直接读的那批文件，一旦入口补上 types 就落在扫描之外。
 */
const ARTIFACT_EXTENSIONS: readonly string[] = [".js", ".mjs", ".cjs", ".d.ts", ".mts", ".cts"];

/**
 * 该文件是否属于「随包发布的产物面」。
 *
 * @param file - 相对包根的路径
 * @returns 命中产物后缀时为 true
 */
function isArtifactFile(file: string): boolean {
  return ARTIFACT_EXTENSIONS.some((extension) => file.endsWith(extension));
}

/** `publishConfig` 里唯一允许出现的字段：可见性与源，都不是入口面。 */
const ALLOWED_PUBLISH_CONFIG = new Set(["access", "registry"]);

/** 遍历时跳过的目录：依赖、产物、以及本门禁刻意不管的面。 */
const SKIP_DIRS = new Set([
  "node_modules",
  "coverage",
  "_env",
  "dist",
  ".git",
  // 测试夹具里的日期与轮次编号是数据，不是注释噪音。
  "test",
  "tests",
  "__tests__",
  // 角色文档库：那里的日期是内容（例如下一份威胁报告的时间线）。
  "agents",
]);

/** package.json 里与入口面有关的形状；其余字段本门禁不关心。 */
interface Manifest {
  readonly name?: string;
  readonly main?: string;
  readonly types?: string;
  readonly exports?: Record<string, unknown>;
  readonly files?: readonly string[];
  readonly publishConfig?: Record<string, unknown>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly description?: string;
  readonly keywords?: readonly string[];
  readonly license?: string;
  /** npm 允许字符串或 `{name, url, email}` 对象：八仓现用对象形态，name 与 url 分开写。 */
  readonly author?: string | { readonly name?: string; readonly url?: string };
  readonly homepage?: string;
  readonly repository?: string | { readonly url?: string };
  readonly bugs?: { readonly url?: string };
}

/** 一条 `files` 模式的两种形态。 */
type PatternShape =
  /**
   * 目录或后缀模式：列该目录下以 `extension` 结尾的文件（空 = 不过滤后缀）。
   * `recursive` 由模式里有没有 `**` 决定：`dir` / `lib/**` 连子目录一起算，
   * `dist/*` 只算该层——递归判据若跟「dir 不是 .」挂钩，`dist/*` 会被整棵子树撑大。
   */
  | {
      readonly kind: "glob";
      readonly dir: string;
      readonly extension: string;
      readonly recursive: boolean;
    }
  /** 精确文件名：带点号又无通配的条目是**文件名**（`host.js`），不是后缀过滤。 */
  | { readonly kind: "exact"; readonly file: string };

/**
 * 把 `files` 的一条模式归类。本仓实际用到的只有三种写法：裸文件名、目录名、`dir/*.ext`。
 *
 * 「精确文件名」这一档不能和后缀过滤混为一谈：把 `host.js` 当成 `.js` 后缀过滤，于是
 * `files` 里列的每个构建产物都匹配不上任何条目——`files` 覆盖这道断言的集合会空掉，门禁
 * 自己先失效。实测报出来是「main 指向 host.js，但它不在 files 覆盖范围内」。
 *
 * @param entry - `files` 数组里的一项
 * @returns 该模式要列的目录与后缀过滤，或一个精确文件名
 */
function shapeOf(entry: string): PatternShape {
  const star = entry.indexOf("*");
  if (star !== -1) {
    // 扩展名只认 * 之后的点号：dist/*、lib/** 这类无后缀模式要的是「该目录下的全部文件」。
    // 按 entry 的最后一个点号取会把 * 本身当扩展名（* 处点号值为 -1，slice(-1) 得 "*"），
    // 于是 endsWith("*") 恒 false、整条模式静默展开成空集。
    const afterStar = entry.slice(star);
    const dot = afterStar.lastIndexOf(".");
    const dir = entry.slice(0, star).replace(/\/$/u, "");
    return {
      kind: "glob",
      dir: dir === "" ? "." : dir,
      extension: dot === -1 ? "" : afterStar.slice(dot),
      recursive: entry.includes("**"),
    };
  }
  if (!entry.includes(".")) {
    return { kind: "glob", dir: entry, extension: "", recursive: true };
  }
  return { kind: "exact", file: entry };
}

/**
 * 按 `files` 模式列出包内确实存在的文件（相对包根、`/` 分隔）。
 *
 * @param shape - 见 {@link shapeOf}
 * @returns 命中的文件清单
 */
async function expand(shape: PatternShape): Promise<string[]> {
  if (shape.kind === "exact") {
    const file = path.join(pkgDir, shape.file);
    if (!existsSync(file)) {
      throw new Error(
        `files 的精确条目 ${shape.file} 在包内不存在：先跑 node build-host.mjs（或该条目名写错）`,
      );
    }
    return [shape.file];
  }
  const dir = path.join(pkgDir, shape.dir);
  if (!existsSync(dir)) {
    throw new Error(
      `files 的目录条目 ${shape.dir} 在包内不存在：先跑 node build-host.mjs（或该目录名写错）`,
    );
  }
  const names = await readdir(dir, { recursive: shape.recursive });
  return (
    names
      .map((name) => name.split(path.sep).join("/"))
      .filter((name) => shape.extension === "" || name.endsWith(shape.extension))
      // dir/* 只取该层：readdir 非递归本就不会给嵌套项，这条过滤是防实现改回去。
      .filter((name) => shape.recursive || !name.includes("/"))
      .map((name) => path.posix.join(shape.dir, name))
  );
}

/**
 * 递归收集一条 `exports` 值里的具体目标文件。通配条目（值含 `*`）没有可验证的固定文件。
 *
 * @param value - `exports` 里某一键的值（字符串或条件对象）
 * @returns 该条目要求存在的包内路径
 */
function filesOf(value: unknown): string[] {
  if (typeof value === "string") {
    return value.includes("*") ? [] : [value];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap((nested) => filesOf(nested));
  }
  return [];
}

/** 入口目标的相对形态（去掉 `./` 前缀）。 */
function asRelative(target: string): string {
  return target.replace(/^\.\//u, "");
}

/**
 * manifest 里全部需要落地的入口文件：main、types 与每个 exports 具体目标。
 *
 * @param manifest - 解析后的 package.json
 * @returns 目标清单，每项带来源标签以便失败时点名
 */
function entryFiles(manifest: Manifest): readonly { label: string; file: string }[] {
  const flat = Object.entries(manifest.exports ?? {}).flatMap(([specifier, value]) =>
    filesOf(value).map((file) => ({ label: specifier, file })),
  );
  const scalars = [
    ...(typeof manifest.main === "string" ? [{ label: "main", file: manifest.main }] : []),
    ...(typeof manifest.types === "string" ? [{ label: "types", file: manifest.types }] : []),
  ];
  return [...scalars, ...flat];
}

/**
 * 发布器**无条件**附带的文件：不受 `files` 约束，且确实随 tarball 发布。
 *
 * 这份清单是实测出来的，不是按惯例推的：本包目录下临时放一份 `CHANGELOG.md` 与一份
 * `THIRD_PARTY_NOTICES.md`、两者都不写进 `files`，`npm pack --dry-run` 的实际结果只有
 * `package.json`、`README*`、`LICENSE`。两条推论：想让 `CHANGELOG.md` 随包发布必须自己写进
 * `files`，`NOTICE` 类文件同理。
 *
 * 把没被无条件附带的文件列进本清单，会让「入口都在 files 覆盖内」那道断言的集合**虚高**——
 * 门禁比 npm 的真实语义更宽松，于是门禁自己先失效。
 */
const ALWAYS_SHIPPED = [MANIFEST_FILE, "README.md", "README.zh-CN.md", "LICENSE"];

/**
 * 读 manifest 与它应当发出去的文件清单。
 *
 * @returns manifest 本体与 `files` 展开后的集合（含发布器无条件附带的件）
 */
async function readSurface(): Promise<{ manifest: Manifest; shipped: Set<string> }> {
  const manifest = JSON.parse(
    await readFile(path.join(pkgDir, MANIFEST_FILE), "utf8"),
  ) as unknown as Manifest;
  const groups = await Promise.all((manifest.files ?? []).map((entry) => expand(shapeOf(entry))));
  const attached = ALWAYS_SHIPPED.filter((name) => existsSync(path.join(pkgDir, name)));
  return { manifest, shipped: new Set([...groups.flat(), ...attached]) };
}

/**
 * 递归收集该纳入注释门禁的源文件与文档（相对包根、`/` 分隔）。
 *
 * @param dir - 当前目录的绝对路径
 * @param prefix - 相对包根的前缀
 * @returns 命中的文件清单
 */
async function collectSources(dir: string, prefix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  // 每个条目一个 promise 再一起等：顺序无关，而顺序相关的写法（循环里 await）在这里既
  // 慢又没有对应的正确性理由——收集的是文件名集合，先返回谁都一样。
  const groups = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          return [];
        }
        const nested = await collectSources(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        return nested;
      }
      if (/\.(?:ts|tsx|mjs|yml|md)$/u.test(entry.name)) {
        return [`${prefix}${entry.name}`];
      }
      return [];
    }),
  );
  return groups.flat();
}

/**
 * 取一段文本里属于注释或文档的行。文档（`.md`）整体算；代码只取注释行，免得把字符串
 * 字面量里的数据（日期夹具、示例路径）误判成注释噪音。
 *
 * @param file - 相对包根的文件名，用于决定判定口径
 * @param text - 文件全文
 * @returns 参与门禁的行
 */
function commentLines(file: string, text: string): string[] {
  if (file.endsWith(".md")) {
    return text.split("\n");
  }
  // YAML 没有行尾注释以外的形态，但它的注释符是 #，与代码两侧不同口径。
  if (/\.ya?ml$/u.test(file)) {
    return text.split("\n").filter((line) => /^\s*#/u.test(line));
  }
  // 代码侧只认注释区间，不用「行首是注释符」的行过滤：那样会漏掉行尾注释
  // （const x = 1; // 日期）、单行块注释（/* 日期 */）与 JSDoc 中间不以 * 开头的行。
  // 先把字符串/模板字面量抹成空串，避免把 "https://…" 这类内容当成注释起点。
  const withoutStrings = text.replaceAll(
    /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu,
    '""',
  );
  const lines: string[] = [];
  for (const match of withoutStrings.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//gu)) {
    lines.push(...match[0].split("\n"));
  }
  return lines;
}

/**
 * 入口目标是不是「源码」：只看 src 目录或非声明的 TS 后缀。
 * 声明文件 dist/host.d.ts 也以 .ts 结尾，补上 types 入口时会被错判成指源码。
 */
function isSourceEntry(file: string): boolean {
  return (
    file.startsWith("src/") || (/\.(?:[cm]?ts|tsx)$/u.test(file) && !/\.d\.[cm]?ts$/u.test(file))
  );
}

describe("发布形态", () => {
  it("files 覆盖全部入口目标（换个发布器也不会发出悬空入口）", async () => {
    const { manifest, shipped } = await readSurface();
    const targets = entryFiles(manifest);
    expect(targets.length, "入口面不该是空的").toBeGreaterThan(0);
    for (const target of targets) {
      expect(
        shipped.has(asRelative(target.file)),
        `${target.label} 指向 ${target.file}，但它不在 files 覆盖范围内`,
      ).toBe(true);
    }
  });

  it("入口一律指向构建产物，源码目录不参与发布", async () => {
    const { manifest } = await readSurface();
    // 收集式断言：失败时报告能直接指认「哪个入口指向了源码文件」。
    const offenders = entryFiles(manifest)
      .filter((target) => isSourceEntry(target.file))
      .map((target) => `${target.label}: ${target.file}`);
    expect(offenders).toStrictEqual([]);
  });

  it("publishConfig 只留可见性与源，不留入口覆盖", async () => {
    const { manifest } = await readSurface();
    for (const key of Object.keys(manifest.publishConfig ?? {})) {
      expect(ALLOWED_PUBLISH_CONFIG.has(key), `publishConfig.${key} 会被 npm 忽略`).toBe(true);
    }
  });

  it("通配条目的形状由模式本身决定（shapeOf/expand 的第二道回归防线）", async () => {
    // 期望独立写死，不从实现派生：扩展名与递归这两位错一位就当场红。
    // 坏形态的两条具体后果：`dist/*` 的扩展名被错认成 "*" → 展开成空集（发布面虚低）；
    // 「dir 是 . 才递归，否则只算一层」→ `lib/**` 漏掉整棵子树（发布面同样虚低）。
    expect(shapeOf("*")).toStrictEqual({ kind: "glob", dir: ".", extension: "", recursive: false });
    expect(shapeOf("dist/*")).toStrictEqual({
      kind: "glob",
      dir: "dist",
      extension: "",
      recursive: false,
    });
    expect(shapeOf("lib/**")).toStrictEqual({
      kind: "glob",
      dir: "lib",
      extension: "",
      recursive: true,
    });
    expect(shapeOf("locale/*.json")).toStrictEqual({
      kind: "glob",
      dir: "locale",
      extension: ".json",
      recursive: false,
    });
    expect(shapeOf("docs")).toStrictEqual({
      kind: "glob",
      dir: "docs",
      extension: "",
      recursive: true,
    });
    expect(shapeOf("host.js")).toStrictEqual({ kind: "exact", file: "host.js" });
    // 展开侧的负例：docs 是无后缀的目录条目，必须把目录里的 .md 一起算进来。
    await expect(
      expand({ kind: "glob", dir: "docs", extension: "", recursive: true }),
    ).resolves.toContain("docs/DETAIL.md");
  });

  it("files 里的精确文件名条目确实被算进发布集合（shapeOf/expand 的回归防线）", async () => {
    // 单独钉住这两件事，因为它们坏掉时上面那道「入口覆盖」断言**不会响**：
    //   · 精确条目没被算进来 → 集合虚低 → 入口一旦靠精确条目承载就误报；
    //   · 精确条目被当成后缀过滤 → 集合虚高 → 门禁对自己的约束放松。
    const { manifest, shipped } = await readSurface();
    const exact = (manifest.files ?? []).filter(
      (entry) => !entry.includes("*") && entry.includes("."),
    );
    expect(exact.length, "本包的 files 里应当有精确文件名条目可供验证").toBeGreaterThan(0);
    for (const entry of exact) {
      expect(shapeOf(entry), `${entry} 应归类为精确文件名并携带完整文件名`).toStrictEqual({
        kind: "exact",
        file: entry,
      });
      expect(shipped.has(entry), `${entry} 是精确条目，却没被算进发布集合`).toBe(true);
    }
  });

  it("包根的每一份 .md 都在发布面里（npm 只自动附带 README* 与 LICENSE）", async () => {
    // 一次性封住这一类陷阱，而不是每加一份文档就补一条断言：`CHANGELOG.md`、
    // `THIRD_PARTY_NOTICES.md` 都不在 npm 的无条件附带清单里（见 {@link ALWAYS_SHIPPED} 的实测），
    // 忘了写进 `files` 就静默不随包分发——npm 页面看不出任何异常，只有真去找那份文件的人
    // 才发现它不在。
    const { shipped } = await readSurface();
    const rootEntries = await readdir(pkgDir);
    const docs = rootEntries.filter((name) => name.endsWith(".md")).toSorted();
    expect(docs.length, "包根至少该有一份 .md").toBeGreaterThan(0);
    for (const doc of docs) {
      expect(shipped.has(doc), `${doc} 不在发布面：写进 files，或确认它本就不该随包发`).toBe(true);
    }
  });

  it("产物面扫描覆盖 .js/.mjs/.cjs 与声明文件（只认 .js 会漏掉 tsc 读的那批）", () => {
    // 期望独立写死：入口一旦补上 types，声明文件就是消费方 tsc 直接读的面。
    const artifacts = ["host.js", "dist/x.mjs", "dist/x.cjs", "dist/host.d.ts", "dist/x.d.mts"];
    const notArtifacts = ["host.ts", "dist/host.d.ts.map", MANIFEST_FILE, "README.md"];
    // 收集式断言：失败时报告的是「哪几个文件判错」，而不是一句没有对象的 toBe(false)。
    expect(artifacts.filter((file) => !isArtifactFile(file))).toStrictEqual([]);
    expect(notArtifacts.filter((file) => isArtifactFile(file))).toStrictEqual([]);
  });

  it("产物面没有本机指涉（绝对路径、pnpm store 布局）", async () => {
    // 注释门读不到产物：rolldown 构建时剥掉源码注释，而 `//#region` 标记里的路径、字符串字面量
    // 里的本机路径会原样进 tarball。client 半必须把 shared 的产物**内联**（浏览器解析不了裸
    // 说明符），所以它的标记里一度烙着 `node_modules/.pnpm/<名>@<版>_<哈希>/`——那既是安装布局
    // 外泄，也让同一份源码在不同机器上产出不同字节。
    const { shipped } = await readSurface();
    const artifacts = [...shipped].filter((file) => isArtifactFile(file)).toSorted();
    expect(artifacts.length, "至少要扫到一枚产物，否则这道门是空转的").toBeGreaterThan(0);
    const texts = await Promise.all(
      artifacts.map(async (file) => ({
        file,
        text: await readFile(path.join(pkgDir, file), "utf8"),
      })),
    );
    for (const artifact of texts) {
      for (const pattern of FORBIDDEN_IN_ARTIFACTS) {
        expect(
          pattern.test(artifact.text),
          `${artifact.file} 命中 ${pattern}：产物里带了只在本机成立的指涉`,
        ).toBe(false);
      }
    }
  });
});

/**
 * 该范围串是否就是「整串一个版本号」（精确钉），不含任何范围算子。
 *
 * 刻意不要求预发布后缀：`0.3.0` 与 `0.2.2-alpha.2` 同样是精确钉，判据是「没有算子」。
 *
 * @param range - package.json 里的版本串
 * @returns 整串是一个版本号时为 true
 */
function isExactVersion(range: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(range);
}

/**
 * 宿主包在 peer 与 dev 两张表里的并集。`dependencies` 是禁区（见下面那条门禁）：peer 记录
 * 「运行期由宿主提供」，dev 记录「本包编译与测试要用它」，两者都不会被消费方的 profile 安装。
 * 同名键以 peer 表为准，那才是消费方环境里真正提供的那一枚。
 * @param manifest - 解析后的 package.json
 * @returns 宿主包名到版本区间
 */
function hostRanges(manifest: Manifest): Record<string, string> {
  return { ...manifest.devDependencies, ...manifest.peerDependencies };
}

/** 宿主 dsh 家族的包名前缀（本组三条判据都要按它筛，收常量）。 */
const DSH_PREFIX = "@deepseek-ai/dsh-";

describe("宿主依赖的版本形状（升级防线）", () => {
  it("@deepseek-ai/* 一律不进 dependencies：装出去会在宿主进程里物化第二份", async () => {
    // 钉的是「全绿但宿主瘫痪」这一类坑，别把它当风格偏好，更别把它「恢复」回去。本插件装进
    // 消费方 profile 的 pnpm 配置是 `nodeLinker: hoisted` 且 `autoInstallPeers: false`，所以
    // `dependencies` 里每一枚 @deepseek-ai/* 都会被落成**真实目录**，与宿主进程已经加载的那份
    // 并存在一起。而 `@deepseek-ai/dsh-tools` 的 TOOL_RUNTIME_SCHEDULER 是普通 Symbol（不是
    // Symbol.for），符号身份按模块实例计算：宿主的 dsh-agent-loop 用自己那份的 Symbol 去读由
    // profile 副本挂载出来的 ToolRuntime，得到 undefined，于是 `.prepare(...)` 在**每一次**原生
    // 工具调用上抛 "Cannot read properties of undefined (reading 'prepare')"，整个 profile 的
    // 工具一起失效。构建、类型检查与本包测试在此之前全部照绿，判据只能落在 manifest 面上。
    // 本包的运行期面只有一枚宿主包：产物 host.js 值导入 @deepseek-ai/schemastery（宿主 fork，
    // `.volatile()` 解析只有它有），client.js 与产物里的 dsh-* 全是类型面、编译期已擦除。它落
    // peer 就够了——裸说明符由宿主那一份解析，peer 与 dev 都不进 profile。
    const { manifest } = await readSurface();
    const leaked = Object.keys(manifest.dependencies ?? {}).filter((name) =>
      name.startsWith("@deepseek-ai/"),
    );
    expect(leaked, "这些宿主包会随本包装进 profile，物化出第二份实例").toStrictEqual([]);
  });

  it("devDependencies 里的 dsh-* 家族一律精确钉，不留任何范围算子", async () => {
    // registry 上的 dist-tag 是实测出来的陷阱：`latest` 可能指向远早于宿主 ABI 的版本。
    // 精确钉是让「不带版本地装成远古版本」这件事不发生的最小条件；一旦放宽成 `^`/`~`，
    // 宿主某天发新 minor 就会自动跟上去，而插件与宿主 ABI 耦合，那等于让本包在没有测试的
    // 情况下换掉编译用的宿主类型面。
    // 只判 dev 这一侧：它才是本包真正装下来的那一份。peer 记的是「运行期由宿主提供」，
    // 装什么版本由宿主决定，判据在下面那条。
    const { manifest } = await readSurface();
    // 过滤出违规项再一次性断言，而不是在循环里按条件 expect：失败时 diff 直接列出
    // 「哪个包钉成了什么」，比逐条抛错更好读。
    const ranged = Object.entries(manifest.devDependencies ?? {}).filter(
      ([name, range]) => name.startsWith(DSH_PREFIX) && !isExactVersion(range),
    );
    expect(ranged, "这些 dsh-* 开发依赖没有精确钉住版本").toStrictEqual([]);
  });

  it("精确钉的判据是「整串一个版本号」，与有没有预发布后缀无关", () => {
    // 期望独立写死。旧判据 /^\d+\.\d+\.\d+-/u 要求必须有 - 后缀：本包当前全都落在
    // 0.2.2-alpha.2 所以恰好通过，宿主一旦发稳定版（0.3.0）就会被判成「没有精确钉住」，
    // 诱使维护者去放宽版本或删掉门禁——门禁的语义是「不带范围算子」，不是「带 - 后缀」。
    for (const exact of ["0.3.0", "0.2.2-alpha.2", "0.2.1-rc.3", "1.0.0-beta.1+build.7"]) {
      expect(isExactVersion(exact), `${exact} 是精确钉`).toBe(true);
    }
    for (const ranged of [
      "^0.3.0",
      "~0.3.0",
      ">=0.3.0",
      "0.3.0 - 0.4.0",
      "0.3.x",
      "*",
      "",
      "latest",
    ]) {
      expect(isExactVersion(ranged), `${ranged} 不是精确钉`).toBe(false);
    }
  });

  it("devDependencies 里的 dsh-* 全部同版本（不许装出第二份宿主类型）", async () => {
    // 宿主类型面被这些包以 type-only 方式消费；同一次安装里出现两枚 dsh-session 的拷贝，
    // nominal 类型（品牌串、投影状态）会开始互相不认，而那不报编译错、只报运行期
    // 「认不出这个 callId」。同版本是让这件事不发生的最小条件。
    const { manifest } = await readSurface();
    const dshDev = Object.entries(manifest.devDependencies ?? {}).filter(([name]) =>
      name.startsWith(DSH_PREFIX),
    );
    expect(dshDev.length, "至少要钉住一枚 dsh-* 开发依赖，否则这条是空转").toBeGreaterThan(0);
    const baseline = dshDev[0]?.[1];
    const drifted = dshDev.filter(([, range]) => range !== baseline);
    expect(drifted, `这些 dsh-* 与 ${baseline} 不同版本`).toStrictEqual([]);
  });

  it("peerDependencies 里的 dsh 家族写支持窗口范围，与裸 dsh 逐条同一条", async () => {
    // peer 由宿主拿自己安装的那版去满足：钉成精确版本等于要求两者版本号完全相等，而滚动支持
    // 窗口本来就含三个版本。宿主侧只在 manifest 没有 engines.dsh 时才读 peer（app-boot 的
    // plugin-compatibility 里 engines.dsh 存在即独判），所以这一位是发布元数据的含义问题。
    const { manifest } = await readSurface();
    const bare = manifest.peerDependencies?.["@deepseek-ai/dsh"] ?? "";
    expect(bare, "裸 dsh 的 peer 缺失：支持窗口就失去基准了").toMatch(/^\^/u);
    const offPolicy = Object.entries(manifest.peerDependencies ?? {}).filter(
      ([name, range]) => name.startsWith(DSH_PREFIX) && range !== bare,
    );
    expect(offPolicy, "这些 dsh-* peer 与裸 dsh 不是同一条范围").toStrictEqual([]);
  });
});

describe("注释与文档没有内部指涉", () => {
  it("注释行的取法覆盖行尾注释、单行块注释与 JSDoc 中间行（形态本身是判据的一部分）", () => {
    // 期望独立写死：只认「行首是注释符」的行会漏掉这三类，而它们恰恰最容易藏日期与路径。
    expect(commentLines("a.ts", "const x = 1; // 2024-01-01\nconst y = 2;")).toStrictEqual([
      "// 2024-01-01",
    ]);
    expect(commentLines("a.ts", "const x = 1; /* 2024-01-01 */ const y = 2;")).toStrictEqual([
      "/* 2024-01-01 */",
    ]);
    expect(
      commentLines("a.ts", "/**\n * 说明\n 2024-01-01 这一行不以星号开头\n */\nconst x = 1;"),
    ).toContain(" 2024-01-01 这一行不以星号开头");
    // 负例：字符串字面量里的 // 与 /* 不是注释（否则把 URL、示例路径当成注释噪音）。
    expect(commentLines("a.ts", 'const url = "https://example.com/x";')).toStrictEqual([]);
    // YAML 的注释符是 #。
    expect(commentLines("a.yml", "key: 1 # 2024-01-01\n# 2024-01-02")).toStrictEqual([
      "# 2024-01-02",
    ]);
  });

  it("源码与文档的注释里没有日期", async () => {
    const collected = await collectSources(pkgDir, "");
    const sources = collected.toSorted();
    expect(sources.length, "至少要扫到源码文件").toBeGreaterThan(0);
    const texts = await Promise.all(
      sources.map(async (file) => ({
        file,
        text: await readFile(path.join(pkgDir, file), "utf8"),
      })),
    );
    for (const entry of texts) {
      for (const line of commentLines(entry.file, entry.text)) {
        for (const pattern of FORBIDDEN_IN_COMMENTS) {
          expect(
            pattern.test(line),
            `${entry.file} 的注释命中内部指涉 ${pattern}：${line.trim().slice(0, 80)}`,
          ).toBe(false);
        }
      }
    }
  });
});

/**
 * 说明符的包名段：`@scope/pkg/sub` → `@scope/pkg`，`pkg/sub` → `pkg`。
 *
 * @param specifier - `from "..."` 里那枚裸说明符
 * @returns 包名
 */
function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    return segments.slice(0, 2).join("/");
  }
  return segments[0] ?? specifier;
}

/**
 * 一段产物文本里**值导入**的宿主包名。
 *
 * 判面取出货产物而不是 shared 的源码：源码里的 type-only 导入在发布态已被擦除，产物里还剩下的
 * 说明符才是装出去之后真会被 resolve 的那批。两种写法都要认——压缩后的产物里 `from` 与引号之间
 * 可以没有空格。
 * @param text - shared 某个 dist 产物的全文
 * @returns 包名集合
 */
function valueImportedHostPackages(text: string): Set<string> {
  const names = new Set<string>();
  const patterns: readonly RegExp[] = [
    /from\s*["'](?<spec>@deepseek-ai\/[^"']+)["']/gu,
    // 纯副作用导入 import "@deepseek-ai/x"：没有 from / 括号，同样会在消费方解析失败。
    /(?:^|[;\s])import\s*["'](?<spec>@deepseek-ai\/[^"']+)["']/gu,
    /import\s*\(\s*["'](?<spec>@deepseek-ai\/[^"']+)["']\s*\)/gu,
    /require\s*\(\s*["'](?<spec>@deepseek-ai\/[^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const spec = match.groups?.["spec"];
      if (spec !== undefined) {
        names.add(packageNameOf(spec));
      }
    }
  }
  return names;
}

/**
 * shared 出货产物（`dist` 下的 `.js`）的绝对路径清单。
 *
 * 目录按已安装的 `package.json` 反查，不写死 store 布局：pnpm 的内容寻址目录名带版本与哈希，
 * 把它抄进本文件就等于把上一条门禁要禁的东西写进了门禁。
 * @returns 产物绝对路径
 */
async function sharedArtifacts(): Promise<string[]> {
  let sharedManifest: string;
  try {
    sharedManifest = createRequire(import.meta.url).resolve(
      "@jayyuen66/dsh-plugin-shared/package.json",
    );
  } catch (error) {
    // MODULE_NOT_FOUND / ERR_PACKAGE_PATH_NOT_EXPORTED 都是「环境未就绪」，不是被测代码的缺陷：
    // 裸堆栈会让人把它和「本包依赖面漏了一条」混在一起读。
    throw new Error(
      `解析 @jayyuen66/dsh-plugin-shared/package.json 失败：先在本仓安装依赖（pnpm install --ignore-scripts）。原因：${String(error)}`,
      { cause: error },
    );
  }
  const dist = path.join(path.dirname(sharedManifest), "dist");
  let listed: string[];
  try {
    listed = await readdir(dist, { recursive: true });
  } catch (error) {
    throw new Error(
      `读不到 shared 的产物目录 ${dist}：先构建 shared（node build-host.mjs 或该仓的 build 链）。原因：${String(error)}`,
      { cause: error },
    );
  }
  return listed
    .map((name) => name.split(path.sep).join("/"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(dist, name));
}

describe("发布态运行期依赖面（装出去之后才炸的那一类）", () => {
  it("值导入的识别覆盖四种写法（漏一种就是给这道门留盲区）", () => {
    const cases: readonly (readonly [string, readonly string[]])[] = [
      [
        'import { truncateEnd } from "@deepseek-ai/dsh-output-retention";',
        ["@deepseek-ai/dsh-output-retention"],
      ],
      ['import "@deepseek-ai/dsh-output-retention";', ["@deepseek-ai/dsh-output-retention"]],
      ['await import("@deepseek-ai/dsh-scope/lib/x.js");', ["@deepseek-ai/dsh-scope"]],
      [
        'const m = require("@deepseek-ai/dsh-typert-protocol");',
        ["@deepseek-ai/dsh-typert-protocol"],
      ],
    ];
    for (const [text, expected] of cases) {
      // 把「喂进去的那句」一并放进被比对象：失败时报告能直接指认是哪条写法错了。
      expect({ text, imports: [...valueImportedHostPackages(text)] }).toStrictEqual({
        text,
        imports: [...expected],
      });
    }
    // 负例：普通第三方与相对路径都不属于宿主包面。
    expect([...valueImportedHostPackages('import { z } from "zod";')]).toStrictEqual([]);
    expect([...valueImportedHostPackages('import x from "./local.js";')]).toStrictEqual([]);
  });

  it("shared 产物值导入的宿主包，本包一律在 peer ∪ dev 里提供", async () => {
    // 这一条是被真实故障逼出来的：shared 0.1.4 的 `dist/text.js` 值导入
    // `@deepseek-ai/dsh-output-retention`（本包用它的 `truncateEnd` / `truncateStart`，但从不
    // 直接引那枚宿主包）。缺席时本包的类型检查、构建与 528 条用例全部照绿，故障只在装出去之后
    // 以 ERR_MODULE_NOT_FOUND 出现——躺在 profile 里的是 shared 的产物而不是它的源码，peer
    // 没有任何编译期信号。
    // 判面取「shared 产物实际值导入」这一集合，而不是 shared 声明的 peer 全集：后者含纯类型面
    // 的成员，本包不引就不该钉，否则这道门会把人推向为用不到的包付一次导入。
    const artifacts = await sharedArtifacts();
    expect(artifacts.length, "至少要扫到 shared 的一枚产物，否则这道门是空转的").toBeGreaterThan(0);
    const needed = new Set<string>();
    for (const text of await Promise.all(artifacts.map((file) => readFile(file, "utf8")))) {
      for (const name of valueImportedHostPackages(text)) {
        needed.add(name);
      }
    }
    const { manifest } = await readSurface();
    const provided = new Set(Object.keys(hostRanges(manifest)));
    const missing = [...needed].filter((name) => !provided.has(name)).toSorted();
    expect(
      missing,
      `这些宿主包是 shared 产物的运行期值导入，本包没提供：装出去即 ERR_MODULE_NOT_FOUND`,
    ).toStrictEqual([]);
  });
});

/**
 * `repository` 的 URL：该字段按 npm 语义可以是裸字符串或对象。
 * @param manifest - 解析后的 package.json
 * @returns 仓库 URL，缺失时空串
 */
function repositoryUrlOf(manifest: Manifest): string {
  const { repository } = manifest;
  if (typeof repository === "string") {
    return repository;
  }
  return repository?.url ?? "";
}

/**
 * 从三处仓库指涉里取出 `<账号>/<仓库名>`。
 *
 * `git+https://github.com/<账号>/<仓>.git`、`https://github.com/<账号>/<仓>/issues` 与
 * `https://github.com/<账号>/<仓>#readme` 三种写法都归一到同一段，末尾的 `.git` 收掉。
 * 两枚段分开取：只写 `[^/?#]+` 会在第一个 `/` 处截断，于是三处都退化成 `<账号>`，
 * 「同源」这条断言就变成恒真。
 * @param url - 待归一的 URL
 * @returns `<账号>/<仓库名>`；认不出仓库时为空串
 */
function repoSlug(url: string): string {
  const matched = /github\.com[/:](?<owner>[^/?#]+)\/(?<repo>[^/?#]+)/u.exec(url);
  const owner = matched?.groups?.["owner"] ?? "";
  const repo = (matched?.groups?.["repo"] ?? "").replace(/\.git$/u, "");
  return owner === "" || repo === "" ? "" : `${owner}/${repo}`;
}

describe("发布元数据面（npm 页面与搜索读的是这些）", () => {
  it("描述、关键词、许可与作者齐备", async () => {
    const { manifest } = await readSurface();
    expect(
      manifest.description?.trim(),
      "description 不能是空的：那是 npm 搜索结果里的一行",
    ).not.toBe("");
    expect(manifest.license, "license 字段必须写着 MIT：LICENSE 本体是 MIT").toBe("MIT");
    // 两种合法形态都收：字符串，或 npm 的 `{name, url}` 对象（本仓现用后者）。
    const author =
      typeof manifest.author === "string" ? manifest.author : (manifest.author?.name ?? "");
    expect(author.trim(), "author 不能是空的：LICENSE 的版权行指着它").not.toBe("");
    const keywords = manifest.keywords ?? [];
    expect(keywords.length, "keywords 不能是空的：npm 的分类与检索按它索引").toBeGreaterThan(0);
    const blank = keywords.filter((word) => word.trim() === "");
    expect(blank, "有关键词是空串").toStrictEqual([]);
  });

  it("repository / bugs / homepage 三处指向同一个仓库", async () => {
    // 这一族的值是从兄弟包抄来的，抄完只改一处是必然会犯的错：`repository` 改了而 `bugs`
    // 与 `homepage` 还指着 dsh-plugin-shared，于是 npm 页面上的「报告问题」跳到别人的仓库。
    // 三条都归一到 `<账号>/<仓库名>` 再比，比的是**指涉对象**而不是拼写形态。
    const { manifest } = await readSurface();
    const slugs = {
      repository: repoSlug(repositoryUrlOf(manifest)),
      bugs: repoSlug(manifest.bugs?.url ?? ""),
      homepage: repoSlug(manifest.homepage ?? ""),
    };
    const missing = Object.entries(slugs).filter(([, slug]) => slug === "");
    expect(missing, "有指涉没写仓库地址").toStrictEqual([]);
    const distinct = [...new Set(Object.values(slugs))];
    expect(
      distinct,
      `三处指涉不同源：repository=${slugs.repository} bugs=${slugs.bugs} homepage=${slugs.homepage}`,
    ).toStrictEqual([distinct[0]]);
    const tail = (manifest.name ?? "").split("/").pop() ?? "";
    const repos = (distinct[0] ?? "").split("/").pop() ?? "";
    expect(repos, `三处指涉的仓库名该等于包名尾段 ${tail}`).toBe(tail);
  });
});
