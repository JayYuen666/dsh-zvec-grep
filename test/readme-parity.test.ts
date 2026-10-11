// test/readme-parity.test.ts —— 中英双份 README 的结构对等门。
//
// 为什么要有：README 拆成 README.md（英文）与 README.zh-CN.md（中文）两份之后，任何一侧
// 新增一节而另一侧漏了，都**不会**让现有用例变红——文档漂移不是行为差异。而这两份是同一个
// 插件对两类读者的同一份说明，骨架应当一一对应。
//
// 判面取结构而不是逐句对译：两份文档的句子本来就不是字面互译（中英术语与详略不同），按文本
// 比会天天误报；标题层级序列、首行包名与顶部互链这三件事才是可机判的最小信号。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pkgDir = path.join(import.meta.dirname, "..");

/** 英文主份与中文份。 */
const DOC_EN = "README.md";
const DOC_ZH = "README.zh-CN.md";

/** 顶部互链：两份都要同时指向中英，读者在任何一侧都能跳过去。 */
const LINKS: readonly string[] = ["[English](./README.md)", "[简体中文](./README.zh-CN.md)"];

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
  it("骨架、开场标题与互链三处都对得上", async () => {
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
      expect(lines[0], `${name} 的首行该是包名一级标题`).toBe("# @jayyuen66/dsh-zvec-grep");
      const head = lines.slice(0, 6).join("\n");
      for (const link of LINKS) {
        expect(head, `${name} 顶部缺互链 ${link}`).toContain(link);
      }
    }
    expect(
      headingLevels(chinese),
      `中文份的标题骨架与英文份不一致：一侧加了节而另一侧没跟上`,
    ).toStrictEqual(headingLevels(english));
    expect(headingLevels(english).length, "两份文档至少各该有一节").toBeGreaterThan(1);
  });
});
