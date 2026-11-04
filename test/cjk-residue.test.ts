// test/cjk-residue.test.ts —— 「中文残留」字符类自身的判据。
//
// 为什么单列一份用例：这条类被六处「en 文案不得残留中文」的断言共用，而那些断言只能证明
// 现有文案干净，证明不了字符类本身收得够宽——把类改窄回 `[一-龥]` 也不会让任何一条用例变红。
// 这里的期望值按 Unicode 区段独立写死（码点直接落笔），与实现里的写法无派生关系。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { CJK_RESIDUE } from "./cjk-residue.ts";

describe("中文残留字符类 CJK_RESIDUE", () => {
  it("四个区段各命中码点首尾", () => {
    // 中文标点区段（旧写法整段漏掉）
    assert.match("\u3002", CJK_RESIDUE, "。 U+3002  Ideographic Full Stop");
    assert.match("\u303F", CJK_RESIDUE, "U+303F 区段末");
    // 扩展 A（旧写法整段漏掉）
    assert.match("\u3400", CJK_RESIDUE, "U+3400 Extension A 首");
    assert.match("\u4DBF", CJK_RESIDUE, "U+4DBF Extension A 末");
    // 基本区：两枚旧写法的差别就在这一段末尾
    assert.match("\u4E00", CJK_RESIDUE, "一 U+4E00 基本区首");
    assert.match("\u9FA5", CJK_RESIDUE, "龥 U+9FA5 旧写式的末位");
    assert.match("\u9FA6", CJK_RESIDUE, "U+9FA6 旧写式放过的那一段");
    assert.match("\u9FFF", CJK_RESIDUE, "U+9FFF 基本区末");
    // 全角形式（旧写法整段漏掉）
    assert.match("\uFF0C", CJK_RESIDUE, "， U+FF0C 全角逗号");
    assert.match("\uFFEF", CJK_RESIDUE, "U+FFEF 区段末");
  });

  it("英文文案真要用的排版字符不误报", () => {
    // 这三枚在现有 en 文案里出现过（省略号、破折号、连字符），扩了范围也必须放过，
    // 否则那条「不得残留中文」的门禁会自己变成红。
    for (const text of ["a", "...", "\u2026", "\u2014", "-", "100%", "/tmp/x", "zg_search"]) {
      assert.doesNotMatch(text, CJK_RESIDUE, `${JSON.stringify(text)} 不是中文残留`);
    }
  });
});
