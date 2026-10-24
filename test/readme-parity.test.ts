// test/readme-parity.test.ts —— 中英双份 README 的结构对等门。
//
// 为什么要有：README 拆成 README.md（英文）与 README.zh-CN.md（中文）两份之后，任何一侧
// 新增一节而另一侧漏了，都**不会**让现有用例变红——文档漂移不是行为差异。而这两份是同一个
// 插件对两类读者的同一份说明，骨架应当一一对应。
//
// 判面取结构而不是逐句对译：两份文档的句子本来就不是字面互译（中英术语与详略不同），按文本
// 比会天天误报；标题层级序列与头部骨架（logo 打头 + HTML h1 + 语言徽章互链）才是可机判的最小信号。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Config } from "../host.ts";

const pkgDir = path.join(import.meta.dirname, "..");

/** 英文主份与中文份。 */
const DOC_EN = "README.md";
const DOC_ZH = "README.zh-CN.md";

/** 视觉头的固定骨架：居中 logo 块打头；包名落在 HTML h1 上——头部没有 ATX 标题可判。 */
const HEAD_FIRST_LINE = '<p align="center">';
const HEAD_H1 = '<h1 align="center">dsh-zvec-grep</h1>';

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
  return text
    .split("\n")
    .filter((line) => /^#{1,6} /u.test(line))
    .map((line) => /^#+/u.exec(line)?.[0] ?? "");
}

describe("中英 README 结构对等", () => {
  it("骨架、头部与互链三处都对得上", async () => {
    const [english, chinese] = await Promise.all([
      readFile(path.join(pkgDir, DOC_EN), "utf8"),
      readFile(path.join(pkgDir, DOC_ZH), "utf8"),
    ]);
    const docs: readonly (readonly [string, string])[] = [
      [DOC_EN, english],
      [DOC_ZH, chinese],
    ];
    for (const [name, text] of docs) {
      const lines = text.split("\n");
      expect(lines[0], `${name} 的首行该是居中 logo 块，与兄弟仓的视觉头一致`).toBe(
        HEAD_FIRST_LINE,
      );
      const head = lines.slice(0, 40).join("\n");
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
function schemaShape(): { total: number; volatile: number } {
  const dict =
    (Config as unknown as { dict?: Record<string, { meta?: Record<string, unknown> }> }).dict ?? {};
  const fields = Object.values(dict);
  return {
    total: fields.length,
    volatile: fields.filter((field) => field.meta?.["volatile"] === true).length,
  };
}

/**
 * README 里那句配置面数字 = 导出 Config 的实际形状。
 *
 * 为什么单开一条：上面那门只比**结构**，两侧一起写错时它照绿。0.1.3 正是这个样子——中英两份
 * 都写着 14 个字段（英文 fourteen），而 schema 早已是 16 枚（远程 embedding 三件套与
 * requireApprovalForExplicitRoot 进来时没人回头改文档），对等门对此一声不响。
 *
 * 措辞被改掉时正则取不到数，本条即红：这条门要的是「文档里那句数字仍可机判」这件事本身，
 * 而不是某种具体句式。改文档请连正则一起改，别改一侧。
 */
describe("两份文档声明的配置面数字与实际 schema 对齐", () => {
  it("字段总数、卡上 volatile 数、非 volatile 部署值数三处都对得上", async () => {
    const [english, chinese] = await Promise.all([
      readFile(path.join(pkgDir, DOC_EN), "utf8"),
      readFile(path.join(pkgDir, DOC_ZH), "utf8"),
    ]);
    const shape = schemaShape();
    const claims: readonly {
      readonly label: string;
      readonly zh: RegExp;
      readonly en: RegExp;
      readonly actual: number;
    }[] = [
      {
        label: "字段总数",
        zh: /schema 共 (?<count>\d+) 个字段/u,
        en: /(?<count>\d+) fields with built-in defaults/u,
        actual: shape.total,
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
