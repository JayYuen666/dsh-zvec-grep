// lib/skill.ts 的单元测试：把完整检索规则注册成一枚虚拟 skill。
//
// 这个模块只有两条判据：① skill 服务在不在都**不许抛**——它是可选服务，精简 profile
// 里根本没有 `@deepseek-ai/dsh-skill`；② 在的时候必须用**本包的名字**与调用点传进来的
// 两份文本调 `register`，一个字段错就会变成「skill 目录里写着别的插件的话」或者
// 「模型按名加载拿到空正文」，而这两件事都不会让宿主报错。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { registerRoutingSkill, SKILL_NAME } from "../lib/skill.ts";

/** 一次 `register` 调用的实参快照（判据面：名字、说明、正文三样各自对得上）。 */
interface Recorded {
  readonly name: string;
  readonly description: string;
  readonly content: string;
}

/** skill 服务的替身：只实现本包用到的 `register`，把实参原样收进数组。 */
function fakeSkills(recorded: Recorded[]): { readonly get: (name: string) => unknown } {
  const service = {
    register: (skill: Recorded): (() => void) => {
      recorded.push(skill);
      return () => {
        /* 注册成功时宿主回一个撤销器；这里没有要撤销的状态 */
      };
    },
  };
  return { get: (name: string): unknown => (name === "skills" ? service : undefined) };
}

/** `get` 什么都不给（服务缺席）的上下文。 */
function emptyCtx(): { readonly get: (name: string) => unknown } {
  return { get: (): unknown => undefined };
}

describe("registerRoutingSkill（完整规则注册成虚拟 skill）", () => {
  it("skill 服务缺席时返回 false 且不抛（精简 profile 没有 dsh-skill）", () => {
    let threw: unknown;
    let registered = true;
    try {
      registered = registerRoutingSkill(emptyCtx(), "正文", "说明");
    } catch (error) {
      threw = error;
    }
    assert.equal(threw, undefined, "缺服务不该抛：它是可选依赖，不进 inject 表");
    assert.equal(registered, false);
  });

  it("服务在时用本包的名字与调用点给的说明、正文调一次 register", () => {
    const recorded: Recorded[] = [];
    const ok = registerRoutingSkill(fakeSkills(recorded), "规则全文", "目录那行说明");
    assert.equal(ok, true);
    assert.equal(recorded.length, 1, "每次装配只注册一次");
    assert.deepEqual(recorded[0], {
      name: SKILL_NAME,
      description: "目录那行说明",
      content: "规则全文",
    });
  });

  it("名字是 kebab-case 的 zvec-grep（与工具名前缀区别开）", () => {
    // 独立写死，不从 SKILL_NAME 自己推——写成 zg_search 这种工具名会让 skill 工具按名加载不到
    assert.equal(SKILL_NAME, "zvec-grep");
  });

  it("空对象不能冒充 skill 服务（没有 register）", () => {
    assert.equal(
      registerRoutingSkill({ get: (): unknown => ({}) }, "正文", "说明"),
      false,
      "只有 register 是函数才算数",
    );
  });

  it("register 存在但不是函数时也不认", () => {
    assert.equal(
      registerRoutingSkill(
        { get: (): unknown => ({ register: "not-a-function" }) },
        "正文",
        "说明",
      ),
      false,
    );
  });

  it("服务返回 null 时不抛（宿主退化态）", () => {
    assert.equal(registerRoutingSkill({ get: (): unknown => null }, "正文", "说明"), false);
  });
});
