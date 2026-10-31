// src/ui-messages.ts 单测：设置卡两语字典的键集/占位符同源（卡片没有 jsdom 渲染
// 用例，字典完整性就是这半边 i18n 的守门人；产物层面的断言在 build-client.test.ts）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { UI_MESSAGES } from "../src/ui-messages.ts";
import type { UiMessages } from "../src/ui-messages.ts";

/** 模板里的 {占位符} 名字集合：只认花括号包住的词（英文整条文案里的裸词，如 "Save"，不是占位符）。 */
function placeholders(template: string): Set<string> {
  return new Set(Array.from(template.matchAll(/(?<=\{)\w+(?=\})/gu), (found) => found[0]));
}

const KEYS = Object.keys(UI_MESSAGES.zh) as (keyof UiMessages)[];

describe("设置卡双语字典", () => {
  it("zh / en 键集一致（一个不多一个不少）", () => {
    const zhKeys = new Set(KEYS);
    const enKeys = new Set(Object.keys(UI_MESSAGES.en));
    assert.equal(zhKeys.size, enKeys.size, "键数不等");
    for (const key of zhKeys) {
      assert.equal(enKeys.has(key), true, `en 缺键 ${key}`);
    }
  });

  it("每条模板的 {占位符} 集合在两语间一致（翻译不许漏插值）", () => {
    for (const key of KEYS) {
      const zhSet = placeholders(UI_MESSAGES.zh[key]);
      const enSet = placeholders(UI_MESSAGES.en[key]);
      assert.equal(
        zhSet.size === enSet.size && [...zhSet].every((name) => enSet.has(name)),
        true,
        `${key} 占位符不一致：zh=${[...zhSet].join(",")} en=${[...enSet].join(",")}`,
      );
    }
  });

  it("文案非空，且英文那份通篇不残留中文（卡片整面可切换）", () => {
    for (const key of KEYS) {
      assert.ok(UI_MESSAGES.zh[key].length > 0, `zh.${key} 为空`);
      assert.ok(UI_MESSAGES.en[key].length > 0, `en.${key} 为空`);
    }
    assert.doesNotMatch(JSON.stringify(UI_MESSAGES.en), /[\u4E00-\u9FFF]/u);
  });

  it("带插值的条目是模板，且每个占位符都被独立登记（渲染点漏参数会红）", () => {
    // 期望逐个键写死，不从字典自身派生。原先只断言「这四个键含占位符」，于是：
    //   · 两语**同时**漏掉某个占位符时，上面那条「两语一致」照样绿（集合都是空/同小）；
    //   · 渲染点 params 少传一位，模板留下一段 `{reason}` 字面量也没人发现。
    const EXPECTED: Partial<Record<keyof UiMessages, readonly string[]>> = {
      dirtyCount: ["count"],
      saveFailed: ["reason"],
      limitInvalid: ["min", "max"],
      limitClamped: ["min", "max", "value"],
      budgetHint: ["default"],
      windowHint: ["default"],
      rebuildHint: ["embedding", "roots"],
      rebuildExitCode: ["exitCode"],
      modelOption: ["reference", "dimension"],
    };
    for (const [key, expected] of Object.entries(EXPECTED) as [
      keyof UiMessages,
      readonly string[],
    ][]) {
      for (const locale of ["zh", "en"] as const) {
        assert.deepEqual(
          [...placeholders(UI_MESSAGES[locale][key])].toSorted(),
          [...expected].toSorted(),
          `${locale}.${key} 的占位符与登记不符`,
        );
      }
    }
    // 反向：字典里出现带花括号的模板却没登记，等于新增了一个没人守的插值面。
    for (const key of KEYS) {
      if (placeholders(UI_MESSAGES.zh[key]).size > 0) {
        assert.ok(key in EXPECTED, `${key} 带占位符，却没登记到期望表`);
      }
    }
  });
});
