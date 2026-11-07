// test/readme-parity.test.ts —— 中英双份 README 的结构对等门。
//
// 为什么要有：README 拆成 README.md（英文）与 README.zh-CN.md（中文）两份之后，任何一侧
// 新增一节而另一侧漏了，都**不会**让现有用例变红——文档漂移不是行为差异。而这两份是同一个
// 插件对两类读者的同一份说明，骨架应当一一对应。
//
// 比对取结构而不是逐句对译：两份文档的句子本来就不是字面互译（中英术语与详略不同），按文本
// 比会天天误报；标题层级序列与头部骨架（logo 打头 + HTML h1 + 语言徽章互链）才是可机判的最小信号。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Config } from "../host.ts";

const pkgDir = path.join(import.meta.dirname, "..");

/** 英文主份与中文份。 */
const DOC_EN = "README.md";
const DOC_ZH = "README.zh-CN.md";

/** 视觉头的固定骨架：居中 logo 块打头；包名落在 HTML h1 上——头部没有 ATX 标题可判。
 *  包名从 package.json 当场实测（去掉 `@scope/`）：写死一份就等于「重命名包时这一处不会红」。 */
const HEAD_FIRST_LINE = '<p align="center">';
const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8")) as {
  name?: unknown;
  version?: unknown;
  engines?: Record<string, unknown>;
};
const { name: pkgName } = manifest;
/** 宿主支持窗口的单一来源；README 的 badge 与两条策略句都必须从它派生。 */
const ENGINES_DSH = typeof manifest.engines?.["dsh"] === "string" ? manifest.engines["dsh"] : "";
const PKG_SHORT_NAME =
  typeof pkgName === "string" ? pkgName.replace(/^@(?<scope>[^/]+)\//u, "") : "";
const HEAD_H1 = `<h1 align="center">${PKG_SHORT_NAME}</h1>`;

/** 顶部互链：语言徽章各指向另一语言，读者在任何一侧都能跳过去。 */
const CROSS_LINKS: readonly (readonly [string, string])[] = [
  [DOC_EN, "./README.zh-CN.md"],
  [DOC_ZH, "./README.md"],
];

/**
 * 取一份 Markdown 的标题层级序列（只取 `#` 的个数，不取标题文本）。
 *
 * @param text - 文档全文
 * @returns 层级序列，如 `["#", "###", "###"]`
 */
function headingLevels(text: string): string[] {
  const levels: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(?<fence>`{3,}|~{3,})/u.exec(line)?.groups?.["fence"] ?? "";
    if (fence === null) {
      if (marker === "") {
        const hash = /^(?<hash>#{1,6}) /u.exec(line)?.groups?.["hash"];
        if (hash !== undefined) {
          levels.push(hash);
        }
      } else {
        fence = marker;
      }
    } else if (marker === fence) {
      // 围栏内的行一律不算标题：译文里的 bash 注释 `# 安装` 与代码块里的 `## 步骤`
      // 都会被旧写法当成标题计入层级序列，而两份文档本就允许代码块不同。
      fence = null;
    }
  }
  return levels;
}

/** 读一份发布文档：读不到时报的是文档检查那句话，而不是一句没有路径信息的 ENOENT（两份 README 与 CHANGELOG 共用）。 */
async function readDoc(file: string): Promise<string> {
  try {
    return await readFile(path.join(pkgDir, file), "utf8");
  } catch (error: unknown) {
    throw new Error(`发布文档检查读不到 ${file}（包根 ${pkgDir}）`, { cause: error });
  }
}

/** 两份文档各读一次（两条用例共用同一对文件，样板只写一处）。 */
async function readDocs(): Promise<readonly [string, string]> {
  return Promise.all([readDoc(DOC_EN), readDoc(DOC_ZH)]);
}

/** 头部界限按文档自身结构取：首个二级标题之前的那一段。
 *  旧写法用 `slice(0, 40)` 这个魔法数，头部再加几枚徽章就会让「缺语言徽章」莫名变红。 */
function headOf(text: string): string {
  const lines = text.split("\n");
  const end = lines.findIndex((line) => line.startsWith("## "));
  return lines.slice(0, end === -1 ? lines.length : end).join("\n");
}

/**
 * README 的宿主支持窗口与 package.json 的 engines.dsh 同源。
 *
 * 为什么单列：伞根的 bump-manifests 只改 package.json，两份 README 的 badge 与两条策略句
 * 不在它的改写入内——0.1.11 就这样出现过 manifest 已抬到 rc.5/alpha.3、文档还写着
 * rc.3/alpha.2 的窗口。这条门把「只改一半」拦在本地，而不是等宿主装载门在用户机器上拒装。
 */
describe("两份 README 的宿主支持窗口与 manifest 同源", () => {
  it("badge 与两份文档的两条窗口声明都取自 engines.dsh", async () => {
    expect(ENGINES_DSH, "package.json 缺 engines.dsh：README 窗口门失去基准").toMatch(/^\^/u);
    const arms = ENGINES_DSH.split("||").map((arm) => arm.trim());
    expect(arms.length, "engines.dsh 至少要有一条宿主线").toBeGreaterThan(0);
    // shields.io 静态 badge 的编码：`^` 是 %5E，字面连字符写成 `--`；badge 只放第一条线。
    const badgeRange = encodeURIComponent(arms[0] ?? "").replaceAll("-", "--");
    const [english, chinese] = await readDocs();
    const docs: readonly (readonly [string, string])[] = [
      [DOC_EN, english],
      [DOC_ZH, chinese],
    ];
    for (const [name, text] of docs) {
      expect(text, `${name} 的 dsh badge 没跟上 engines.dsh 的第一条线`).toContain(
        `badge/dsh-${badgeRange}-658EFF`,
      );
      // 两条策略句（宿主窗口与 peer 同一条范围）各出现一次；少一条就说明有一处停在旧值。
      expect(
        text.split(ENGINES_DSH).length - 1,
        `${name} 里 ${ENGINES_DSH} 应出现至少两次（宿主窗口与 peer 各一次）`,
      ).toBeGreaterThanOrEqual(2);
      // 全文的 caret 范围必须恰好是这两条：旧值即使与新值并存也会被这一条点出来。
      const ranges = Array.from(text.matchAll(/\^0\.2\.[0-9A-Za-z.-]+/gu), (hit) => hit[0]);
      expect(new Set(ranges), `${name} 里还留着 engines.dsh 之外的支持窗口`).toStrictEqual(
        new Set(arms),
      );
    }
  });
});

/**
 * 当前发布版本必须在 CHANGELOG 里有对应标题。
 *
 * 为什么单列：package.json 的 version 与 CHANGELOG 之间没有任何机制绑着——0.1.11 就是
 * version 已抬、顶部仍停在 `## 0.1.10`。CHANGELOG 随包发布，缺段落不是内部记录问题，
 * 而是消费方拿到的发布说明少了一版。
 */
describe("发布说明覆盖当前发布版本", () => {
  it("顶部有与 package.json version 对应的二级标题", async () => {
    const version = typeof manifest.version === "string" ? manifest.version : "";
    expect(version, "package.json 缺 version").toMatch(/^\d+\.\d+\.\d+/u);
    const changelog = await readDoc("CHANGELOG.md");
    expect(
      changelog.split(/\r?\n/u),
      `CHANGELOG.md 缺 ## ${version} 段落：发布物会带着上一版的说明出去`,
    ).toContain(`## ${version}`);
  });
});

describe("中英 README 结构对等", () => {
  it("骨架、头部与互链三处都对得上", async () => {
    const [english, chinese] = await readDocs();
    const docs: readonly (readonly [string, string])[] = [
      [DOC_EN, english],
      [DOC_ZH, chinese],
    ];
    for (const [name, text] of docs) {
      const lines = text.split("\n");
      expect(lines[0], `${name} 的首行该是居中 logo 块，与兄弟仓的视觉头一致`).toBe(
        HEAD_FIRST_LINE,
      );
      const head = headOf(text);
      expect(head, `${name} 头部缺包名 h1`).toContain(HEAD_H1);
      const cross = CROSS_LINKS.find(([doc]) => doc === name)?.[1];
      expect(cross, `${name} 该有一条互链判据`).toBeDefined();
      expect(head, `${name} 顶部缺指向 ${cross} 的语言徽章`).toContain(`href="${cross}"`);
    }
    expect(
      headingLevels(chinese),
      `中文份的标题骨架与英文份不一致：一侧加了节而另一侧没跟上`,
    ).toStrictEqual(headingLevels(english));
    expect(headingLevels(english).length, "两份文档至少各该有一节").toBeGreaterThan(1);
  });
});

/** 导出 Config 的字段总数与 volatile 数（宿主 describe() 投影的就是后者）。 */
function schemaShape(): { total: number; defaulted: number; volatile: number } {
  // 内省 API 改名/缺席时不能退化成「读不到字段」：那会把报错变成「声明 16，实际 0」，
  // 指向完全错误的方向。这里当场说清是哪一位没了。
  const { dict }: { dict?: unknown } = Config as unknown as { dict?: unknown };
  if (typeof dict !== "object" || dict === null) {
    throw new TypeError(
      "Config 上没有可读的 dict 内省面（宿主换了 API？）：README 的数字对等门读不到字段。",
    );
  }
  const fields = Object.values(dict as Record<string, { meta?: Record<string, unknown> }>);
  return {
    total: fields.length,
    // 文档那句说的是「带内置默认值的字段数」，就按 `meta.default` 在不在位来数，
    // 而不是拿字段总数顶替：将来加一枚没有 .default() 的字段时，两者一分叉这条门就得跟上。
    defaulted: fields.filter((field) => field.meta?.["default"] !== undefined).length,
    volatile: fields.filter((field) => field.meta?.["volatile"] === true).length,
  };
}

/**
 * README 里那句配置表数字 = 导出 Config 的实际形状。
 *
 * 为什么单开一条：上面那门只比**结构**，两侧一起写错时它照绿。0.1.3 正是这个样子——中英两份
 * 都写着 14 个字段（英文 fourteen），而 schema 早已是 16 枚（远程 embedding 三件套与
 * requireApprovalForExplicitRoot 进来时没人回头改文档），对等门对此一声不响。
 *
 * 措辞被改掉时正则取不到数，本条即红：这条门要的是「文档里那句数字仍可机判」这件事本身，
 * 而不是某种具体句式。改文档请连正则一起改，别改一侧。
 */
describe("两份文档声明的配置表数字与实际 schema 对齐", () => {
  it("字段总数、卡上 volatile 数、非 volatile 部署值数三处都对得上", async () => {
    const [english, chinese] = await readDocs();
    const shape = schemaShape();
    expect(shape.total - shape.defaulted, "文档那句说的是「带内置默认值的字段数」").toBe(0);
    const claims: readonly {
      readonly label: string;
      readonly zh: RegExp;
      readonly en: RegExp;
      readonly actual: number;
    }[] = [
      {
        // 名字仍叫「字段总数」，取值换成「带内置默认值的字段数」：README 那句英文原文就是
        // "<n> fields with built-in defaults"，之前拿 total 比是**近似**而不是那件事。
        label: "字段总数",
        zh: /schema 共 (?<count>\d+) 个字段/u,
        en: /(?<count>\d+) fields with built-in defaults/u,
        actual: shape.defaulted,
      },
      {
        label: "卡上 volatile 数",
        zh: /卡上那 (?<count>\d+) 枚/u,
        en: /(?<count>\d+) of them volatile/u,
        actual: shape.volatile,
      },
      {
        // 这一位是**可推导的**：非 volatile = 总数 - volatile。文档若写成别的数，
        // 要么这句错、要么那句错，两条一起红的概率远大于静默漂移。
        label: "非 volatile 部署值数",
        zh: /非 volatile 部署值\*\*，共 (?<count>\d+) 枚/u,
        en: /\*\*non-volatile deployment values\*\*, (?<count>\d+) of them/u,
        actual: shape.total - shape.volatile,
      },
    ];
    for (const claim of claims) {
      for (const [name, text, pattern] of [
        [DOC_ZH, chinese, claim.zh],
        [DOC_EN, english, claim.en],
      ] as const) {
        const declared = pattern.exec(text)?.groups?.["count"];
        expect(declared, `${name} 里读不到「${claim.label}」那句`).toBeDefined();
        expect(
          Number(declared),
          `${name} 声明的${claim.label}是 ${declared}，而 Config schema 实际是 ${claim.actual}`,
        ).toBe(claim.actual);
      }
    }
  });
});
