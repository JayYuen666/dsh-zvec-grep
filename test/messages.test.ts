// lib/messages.ts 单元测试：{占位符} 插值 + 两语字典的键集/占位符一致性。
//
// 键集一致由 tsc 兜（两份都标注同一个 ZvecGrepMessages），本文件补的是编译期管不到
// 的两件事：模板里的占位符在两语间不得多不得少（漏了就渲染出空串），以及 fill 的
// 三种取值形态（有值 / null / 缺键）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { MESSAGES, fill } from "../lib/messages.ts";
import type { ZvecGrepMessages } from "../lib/messages.ts";
import { CJK_RESIDUE } from "./cjk-residue.ts";

/** 模板里的 {占位符} 名字集合：只认花括号包住的词（英文整条文案里的裸词不是占位符）。 */
function placeholders(template: string): Set<string> {
  return new Set(Array.from(template.matchAll(/(?<=\{)\w+(?=\})/gu), (found) => found[0]));
}

const KEYS = Object.keys(MESSAGES.zh) as (keyof ZvecGrepMessages)[];

describe("fill（host 侧 {name} 插值）", () => {
  it("有值即替换，重复占位符都填", () => {
    assert.equal(fill("{one}-{two}-{one}", { one: 1, two: "x" }), "1-x-1");
  });

  it('null 照实渲染成 "null"（与旧模板字符串一致）', () => {
    assert.equal(fill("exit={exit}", { exit: null }), "exit=null");
  });

  it("原型链上的键不当作参数：constructor/toString 渲染成空串", () => {
    assert.equal(fill("{constructor}-{toString}", {}), "-");
    assert.equal(fill("{constructor}", { constructor: "own" }), "own");
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
    // 全量遍历而不是抽查两条：en 侧现量 138 条，混进中文（多半是从 zh 复制后没翻完）的
    // 那一条只有在这里被点名才会被拦住；抽查写法等于让其余条目无人看守。
    for (const key of KEYS) {
      assert.doesNotMatch(MESSAGES.en[key], CJK_RESIDUE, `en.${key} 残留中文`);
    }
  });

  it("每条模板按自己的占位符名喂 fill：替换都落到位，不留花括号", () => {
    // 全字典遍历而不是只盯 gateReason。这里**不按「有没有认出占位符」过滤条目**：
    // 写坏的占位符（`{stat e}` 这种带空格的）正是 placeholders() 认不出来的那些，
    // 一过滤就等于放过它 —— 所以对每条都断「填完之后文本里不该再有裸花括号」。
    // 这一条证的是**字典侧**的替换；调用方传的键名对不对，字典自己看不见 ——
    // 那一条由下面用字面实参钉住的 gateReason 用例覆盖（它是真调用点的那一组名字）。
    for (const key of KEYS) {
      for (const text of [MESSAGES.zh[key], MESSAGES.en[key]]) {
        const names = [...placeholders(text)];
        const args: Record<string, string> = {};
        for (const name of names) {
          args[name] = `«${name}»`;
        }
        const filled = fill(text, args);
        assert.doesNotMatch(filled, /[{}]/u, `填完仍有花括号：${key} 里有认不出或没被替换的占位符`);
        for (const name of names) {
          assert.ok(filled.includes(`«${name}»`), `${key} 的 {${name}} 没被替换成实参`);
        }
      }
    }
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

describe("root 参数描述与实际放行范围一致", () => {
  // 三个工具走同一个 rootOf()，放行路径是同三条：会话工作区本身、其上级/下级、
  // 本会话已登记过的工作区。描述少写一条，模型就会以为某条合法路径被拒而绕路。
  it("zh 三个 root 描述逐字相同", () => {
    assert.equal(MESSAGES.zh.rootStatusDescription, MESSAGES.zh.rootSearchDescription);
    assert.equal(MESSAGES.zh.rootIndexDescription, MESSAGES.zh.rootSearchDescription);
  });

  it("en 三个 root 描述逐字相同", () => {
    assert.equal(MESSAGES.en.rootStatusDescription, MESSAGES.en.rootSearchDescription);
    assert.equal(MESSAGES.en.rootIndexDescription, MESSAGES.en.rootSearchDescription);
  });

  it("三条放行路径在两语文案里都点名了", () => {
    // 按语言各判各的短语：交替正则（/本会话已登记|already registered/）会让 en 文案里混进
    // 中文短语也通过，与上面那条「en 不残留中文」的全量遍历口径不一致。
    // 三条路径都点：少断一条，模型就会以为某条合法路径被拒而绕路（用例名承诺的是三条）。
    const zh = MESSAGES.zh.rootSearchDescription;
    assert.match(zh, /会话工作区本身/u, "zh 缺「会话工作区本身」这条");
    assert.match(zh, /上级或下级/u, "zh 缺「上级或下级」这条");
    assert.match(zh, /本会话已登记/u, "zh 缺「本会话已登记」这条");
    const en = MESSAGES.en.rootSearchDescription;
    assert.match(en, /the workspace itself/iu, "en 缺 the workspace itself 这条");
    assert.match(en, /parents or children/iu, "en 缺 parents or children 这条");
    assert.match(en, /already registered/iu, "en 缺 already registered 这条");
  });
});

describe("hitCapped 只陈述计数，不推断是否还有更多", () => {
  // zg 的 indexed 通道不输出任何截断标记（agentContextLines 对命中列表不打标），
  // 「某组 count === limit」只说明这一组取满了，不能据此宣称还有未显示的命中。
  it("zh / en 都不出现「可能还有 / more may exist」这类推断措辞", () => {
    for (const name of ["zh", "en"] as const) {
      // 两个措辞对两种语言都查（zh 里混进英文推断句、en 里混进中文推断句都算回归），
      // 提示里的语言名跟着循环变量走 —— 硬编码成「zh 仍含…」会在 en 命中时指错方向。
      assert.doesNotMatch(MESSAGES[name].hitCapped, /可能还有/u, `${name} 仍含「可能还有」`);
      assert.doesNotMatch(
        MESSAGES[name].hitCapped,
        /more may exist/iu,
        `${name} 仍含 "more may exist"`,
      );
    }
  });

  it("两语都保留了「该组正好等于 --limit」这个纯观察", () => {
    for (const name of ["zh", "en"] as const) {
      assert.match(MESSAGES[name].hitCapped, /--limit/u, `${name} 没提 --limit`);
    }
  });
});
