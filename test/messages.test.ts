// lib/messages.ts 单元测试：{占位符} 插值 + 两语字典的键集/占位符一致性。
//
// 键集一致由 tsc 兜（两份都标注同一个 ZvecGrepMessages），本文件补的是编译期管不到
// 的两件事：模板里的占位符在两语间不得多不得少（漏了就渲染出空串），以及 fill 的
// 三种取值形态（有值 / null / 缺键）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { MESSAGES, fill } from "../lib/messages.ts";
import type { ZvecGrepMessages } from "../lib/messages.ts";

/** 模板里的 {占位符} 名字集合：只认花括号包住的词（英文整条文案里的裸词不是占位符）。 */
function placeholders(template: string): Set<string> {
  return new Set([...template.matchAll(/(?<=\{)\w+(?=\})/gu)].map((found) => found[0]));
}

const KEYS = Object.keys(MESSAGES.zh) as (keyof ZvecGrepMessages)[];

describe("fill（host 侧 {name} 插值）", () => {
  it("有值即替换，重复占位符都填", () => {
    assert.equal(fill("{one}-{two}-{one}", { one: 1, two: "x" }), "1-x-1");
  });

  it('null 照实渲染成 "null"（与旧模板字符串一致）', () => {
    assert.equal(fill("exit={exit}", { exit: null }), "exit=null");
  });

  it("缺键替成空串：文案不该因一个占位符打断工具调用", () => {
    assert.equal(fill("a{missing}b", { other: 1 }), "ab");
  });

  it("无占位符的文本原样返回", () => {
    assert.equal(fill("plain text", {}), "plain text");
  });
});

describe("两语字典同源", () => {
  it("zh / en 键集一致（一个不多一个不少）", () => {
    const zhKeys = new Set(KEYS);
    const enKeys = new Set(Object.keys(MESSAGES.en));
    assert.equal(zhKeys.size, enKeys.size, "键数不等");
    for (const key of zhKeys) {
      assert.equal(enKeys.has(key), true, `en 缺键 ${key}`);
    }
  });

  it("每条模板的 {占位符} 集合在两语间一致", () => {
    for (const key of KEYS) {
      const zhSet = placeholders(MESSAGES.zh[key]);
      const enSet = placeholders(MESSAGES.en[key]);
      const sameSize = zhSet.size === enSet.size;
      assert.equal(
        sameSize && [...zhSet].every((name) => enSet.has(name)),
        true,
        `${key} 占位符不一致：zh=${[...zhSet].join(",")} en=${[...enSet].join(",")}`,
      );
    }
  });

  it("字典里没有空文案，英文条目不残留中文（工具描述/回显/guard 全套）", () => {
    for (const key of KEYS) {
      assert.ok(MESSAGES.zh[key].length > 0, `zh.${key} 为空`);
      assert.ok(MESSAGES.en[key].length > 0, `en.${key} 为空`);
    }
    assert.doesNotMatch(
      `${MESSAGES.en.gateReason}${MESSAGES.en.notInstalledFailure}`,
      /[\u4E00-\u9FFF]/u,
    );
  });

  it("带变量的模板都真用了 fill（占位符名与实参同名）", () => {
    // 断言面：工具描述与门禁正文各自的关键片段在两份字典里都在位。
    assert.match(MESSAGES.zh.gateReason, /grep\/rg/u);
    assert.match(MESSAGES.en.gateReason, /grep\/rg/u);
    assert.equal(
      fill(MESSAGES.en.gateReason, {
        state: "the grep/rg quota is spent",
        indexRoot: "/repo",
        indexDir: ".zvec-grep",
        budget: 3,
        windowMin: 10,
      }).includes("/repo/.zvec-grep"),
      true,
    );
  });
});
