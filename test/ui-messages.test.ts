// src/ui-messages.ts 单测：设置卡两语字典的键集/占位符同源（卡片没有 jsdom 渲染
// 用例，字典完整性就是这半边 i18n 的守门人；产物层面的断言在 build-client.test.ts）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { UI_MESSAGES } from "../src/ui-messages.ts";
import type { UiMessages } from "../src/ui-messages.ts";
import { CJK_RESIDUE } from "./cjk-residue.ts";

/**
 * 渲染这面字典的官方插值器是 `template.replace(/\{(\w+)\}/g, …)`
 * （实测 `@deepseek-ai/dsh-client-locale/lib/client.js`），两处都要照它来：
 *   · 名字语法取 `\w+`，比它宽就会去比渲染器根本不填的名字，比它窄就漏判；
 *   · 它是 `g` 档全替换 ⇒ 同一个占位符出现两次就该被填两次，所以这里交回**列表**
 *     （多重集），用 Set 会把重复抹平，两语的重复次数之差就看不见。
 * 填不掉的残留花括号（`{min`、`{count }`、`{exit-code}` 这一类写坏的模板）官方会原样留在
 * 界面上，所以由 assertBracesFilled 单独判掉，而不是指望名字比对去发现它。
 */
const PLACEHOLDER = /\{(?<name>\w+)\}/gu;

/** 捕获组对每一条匹配必然参与（整个模式就是它），这里的 `?? ""` 只给类型收窄一个落点。 */
function placeholders(template: string): string[] {
  return Array.from(template.matchAll(PLACEHOLDER), (found) => found.groups?.["name"] ?? "");
}

/** 剥掉所有会被填的占位符后，不该再有落单的花括号。 */
function assertBracesFilled(template: string, label: string): void {
  assert.doesNotMatch(
    template.replaceAll(PLACEHOLDER, ""),
    /[{}]/u,
    `${label} 有填不掉的花括号（渲染器只认 {\\w+}）：${template}`,
  );
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
      assertBracesFilled(UI_MESSAGES.zh[key], `zh.${key}`);
      assertBracesFilled(UI_MESSAGES.en[key], `en.${key}`);
      const zhNames = placeholders(UI_MESSAGES.zh[key]).toSorted();
      const enNames = placeholders(UI_MESSAGES.en[key]).toSorted();
      assert.deepEqual(
        enNames,
        zhNames,
        `${key} 占位符不一致（含重复次数）：zh=${zhNames.join(",")} en=${enNames.join(",")}`,
      );
    }
  });

  it("文案非空，且英文那份通篇不残留中文（卡片整面可切换）", () => {
    for (const key of KEYS) {
      // 纯空白一样渲染成空白标签，所以判 trim 之后的长度。
      assert.ok(UI_MESSAGES.zh[key].trim().length > 0, `zh.${key} 为空或纯空白`);
      assert.ok(UI_MESSAGES.en[key].trim().length > 0, `en.${key} 为空或纯空白`);
    }
    assert.doesNotMatch(JSON.stringify(UI_MESSAGES.en), CJK_RESIDUE);
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
          placeholders(UI_MESSAGES[locale][key]).toSorted(),
          [...expected].toSorted(),
          `${locale}.${key} 的占位符与登记不符`,
        );
      }
    }
    // 反向：字典里出现带花括号的模板却没登记，等于新增了一个没人守的插值面。
    for (const key of KEYS) {
      if (placeholders(UI_MESSAGES.zh[key]).length > 0) {
        assert.ok(key in EXPECTED, `${key} 带占位符，却没登记到期望表`);
      }
    }
  });
});
