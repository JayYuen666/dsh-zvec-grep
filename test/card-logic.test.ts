// lib/card-logic.ts 单测（DOM-free，host typecheck 可直接 import）：
// cardStore 快照投影与 per-scope 缓存 / 草稿取值（touched 优先；读判据在
// lib/card-draft.ts，用例逐条照旧）/ limit 校验 /
// 重建轮询应答解析（completed 且 exit 0 才算成功）/ fetch 应答体检。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  cardStore,
  draftFields,
  httpProblem,
  isOkBody,
  limitDraftOf,
  parseJsonRecord,
  parseRebuildPoll,
  resolveLimitInput,
} from "../lib/card-logic.ts";
import type { CardText, SettingScope } from "../lib/card-logic.ts";
import { draftOf } from "../lib/card-draft.ts";
import { DEFAULT_EMBEDDING } from "../lib/embedding-catalog.ts";
import { fill } from "../lib/messages.ts";
import { UI_MESSAGES } from "../src/ui-messages.ts";
import type { ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";

/**
 * 本条目那张表单的官方快照面：别名在测试这边按官方类型**自己抄一份**（同
 * test/build-client.test.ts 的口径），不引 lib/card-logic.ts 里那个私有简写——
 * 引简写等于让简写自己给自己作证，抄官方那一侧则官方改形状时这里当场红。
 */
type FormSnapshot = ConfigFormSnapshot<Record<string, unknown>>;

/**
 * 中文 translator：card-logic 的提示文本按语言由调用点注入（纯函数不读设置，见
 * lib/card-logic.ts 头），本测试喂 UI 字典的中文那份——断言里的中文串因此与
 * i18n 迁移前完全一致。插值用 host 半的 fill（与官方 locale 的 {name} 同语义）。
 */
const tZh: CardText = (key, params) => fill(UI_MESSAGES.zh[key], params ?? {});

/** 英文 translator：同一渲染路径只换字典那份（模块级，不随 describe 重建）。 */
const tEn: CardText = (key, params) => fill(UI_MESSAGES.en[key], params ?? {});

/**
 * 中文「limit 非法」提示的期望整句：`tZh` 从 UI_MESSAGES 渲染出来就是这一串，断言里
 * 独立抄一份——引字典键/字典文本等于让字典自己给自己作证。三个用例共用（abc / 3.5 / 1e99）。
 */
const ZH_LIMIT_INVALID_HINT = "请输入 1-50 的整数";

// ── SettingScope（= 官方 ConfigForm<Record<string, unknown>>）替身 ──────────
// 契约形状本身即断言：五成员全必选（getSnapshot / subscribe / mutate / set / unset，
// 见 @deepseek-ai/dsh-client-ui-settings/client 的 ConfigForm），set/unset 回
// `Promise<boolean>`（受理位），**没有** dispose——`configForms.get(entryId)` 交回的是
// provider 持有的共享表单（同包 config-form.d.ts:138-142），卡片自 dispose 会连坐同
// provider 的其它消费者。

/** 官方 `ConfigFormSnapshot` 的合法形状（7 位全必选）；首个快照受理前 value/revision
 *  为 undefined，正是卡片要渲染「还没数据」的那一态。 */
function snap(over: Partial<FormSnapshot> = {}): FormSnapshot {
  return {
    status: "ready",
    value: { defaultLimit: 10 },
    base: {},
    user: {},
    revision: 3,
    writable: true,
    mode: "host",
    ...over,
  };
}

function fakeScope(initial: FormSnapshot): SettingScope & {
  setSnap: (value: FormSnapshot) => void;
  sets: [string, unknown][];
  unsets: string[];
  mutates: unknown[][];
  subscribes: number;
} {
  let snapValue = initial;
  const sets: [string, unknown][] = [];
  const unsets: string[] = [];
  const mutates: unknown[][] = [];
  const scope = {
    getSnapshot: () => snapValue,
    subscribe: (_listener: () => void) => {
      scope.subscribes += 1;
      return () => {
        void 0;
      };
    },
    // 路径级原子写入：本卡不走它，但官方类型面要求它在位（缺了就编译不过）。
    mutate: async (ops: readonly unknown[]): Promise<boolean> => {
      mutates.push([...ops]);
      return true;
    },
    set: (field: string, value: unknown) => {
      sets.push([field, value]);
      return Promise.resolve(true);
    },
    unset: (field: string) => {
      unsets.push(field);
      return Promise.resolve(true);
    },
    setSnap: (value: FormSnapshot) => {
      snapValue = value;
    },
    sets,
    unsets,
    mutates,
    subscribes: 0,
  };
  return scope;
}

describe("cardStore 快照投影", () => {
  it("首个快照受理前 value 缺席 → 视图落到空对象", () => {
    // 官方 `ConfigFormSnapshot.value` 是 `T | undefined`，undefined 是它唯一真会缺席的
    // 一态（未收到首份 describe），正是卡片要渲染的「还没数据」。
    const scope = fakeScope(snap({ value: undefined }));
    const store = cardStore(scope);
    assert.deepEqual(store.getSnapshot().value, {}, "value 缺席投影成 {}，不渲染 undefined");
  });

  it("官方快照直读：status/writable 透传，value 落到视图", () => {
    const scope = fakeScope(snap({ value: { defaultLimit: 10 } }));
    const store = cardStore(scope);
    const view = store.getSnapshot();
    assert.deepEqual(view, { status: "ready", writable: true, value: { defaultLimit: 10 } });
    // 三态各自可读：官方 status 恒为这三者之一（不再有「认不出的 status」这一态）。
    for (const status of ["loading", "ready", "unavailable"] as const) {
      const oneScope = fakeScope(snap({ status, writable: false }));
      assert.equal(cardStore(oneScope).getSnapshot().status, status);
    }
    // memory 模式：writable 是独立于 status 的只读位，官方契约下它永假。
    const memoryScope = fakeScope(snap({ status: "unavailable", writable: false, mode: "memory" }));
    assert.equal(cardStore(memoryScope).getSnapshot().writable, false);
  });

  it("首个快照受理前（value/revision 缺席）→ value 落空对象；空视图 memo 不抖动", () => {
    const scope = fakeScope(
      snap({ status: "loading", value: undefined, revision: undefined, writable: false }),
    );
    const store = cardStore(scope);
    assert.deepEqual(store.getSnapshot(), { status: "loading", writable: false, value: {} });
    assert.equal(store.getSnapshot(), store.getSnapshot(), "空视图必须 memo，否则无限重渲染");
  });

  it("两 scope 交错 getSnapshot：未变化的一方返回同一引用（无 cross-talk）", () => {
    const scopeA = fakeScope(snap({ value: { defaultLimit: 10 } }));
    const scopeB = fakeScope(snap({ value: { defaultLimit: 20 } }));
    const storeA = cardStore(scopeA);
    const storeB = cardStore(scopeB);
    const snap1 = storeA.getSnapshot();
    storeB.getSnapshot();
    const snap2 = storeA.getSnapshot();
    assert.equal(snap2, snap1, "scopeA 快照未变，storeA 必须返回同一 memo 对象");
    assert.equal(snap2.value["defaultLimit"], 10);
    assert.equal(storeB.getSnapshot().value["defaultLimit"], 20);
  });

  it("各自 scope 更新各自生效", () => {
    const scopeA = fakeScope(snap({ writable: true, value: { defaultLimit: 10 } }));
    const scopeB = fakeScope(
      snap({ writable: false, mode: "memory", value: { defaultLimit: 20 } }),
    );
    const storeA = cardStore(scopeA);
    const storeB = cardStore(scopeB);
    storeA.getSnapshot();
    storeB.getSnapshot();
    scopeA.setSnap(snap({ value: { defaultLimit: 30 } }));
    assert.equal(storeA.getSnapshot().value["defaultLimit"], 30);
    assert.equal(storeB.getSnapshot().value["defaultLimit"], 20);
    assert.equal(storeB.getSnapshot().writable, false);
  });

  it("subscribe 透传到 scope 并回传其退订函数", () => {
    const scope = fakeScope(snap({ value: {} }));
    const store = cardStore(scope);
    const unsubscribe = store.subscribe(() => {
      void 0;
    });
    assert.equal(scope.subscribes, 1);
    assert.equal(typeof unsubscribe, "function");
    unsubscribe();
  });
});

describe("draftOf / draftFields（草稿优先，受控输入的唯一真值来源）", () => {
  it("touched 有键即用草稿，连 undefined（待清空）也算改过", () => {
    assert.equal(draftOf({ a: 1 }, { a: 2 }, "a"), 1);
    assert.equal(draftOf({}, { a: 2 }, "a"), 2);
    assert.equal(draftOf({ a: undefined }, { a: 2 }, "a"), undefined);
    assert.equal(draftOf({}, {}, "missing"), undefined);
  });

  it("六个字段全部草稿优先（含 hfEndpoint 与 embedding）", () => {
    const committed = {
      defaultEmbedding: "local/committed",
      hfEndpoint: "https://committed.example",
      enforceSearchFirst: false,
      defaultLimit: 5,
      grepBudgetPerSearch: 2,
      unlockWindowMin: 30,
    };
    const touched = {
      defaultEmbedding: "local/draft",
      hfEndpoint: "https://draft.example",
      enforceSearchFirst: true,
      defaultLimit: 9,
      grepBudgetPerSearch: 4,
      unlockWindowMin: 45,
    };
    assert.deepEqual(draftFields(touched, committed), {
      embedding: "local/draft",
      limitDisplay: "9",
      hfEndpoint: "https://draft.example",
      enforceSearchFirst: true,
      grepBudget: "4",
      unlockWindow: "45",
    });
    // 未改动时全部显示已提交值
    assert.deepEqual(draftFields({}, committed), {
      embedding: "local/committed",
      limitDisplay: "5",
      hfEndpoint: "https://committed.example",
      enforceSearchFirst: false,
      grepBudget: "2",
      unlockWindow: "30",
    });
  });

  it("缺省与非法值回落内置默认", () => {
    assert.deepEqual(draftFields({}, {}), {
      embedding: DEFAULT_EMBEDDING,
      limitDisplay: "10",
      hfEndpoint: "",
      enforceSearchFirst: true,
      grepBudget: "3",
      unlockWindow: "10",
    });
    // 空串 embedding / 非字符串 endpoint / 非有限数都回默认
    assert.deepEqual(
      draftFields(
        {
          defaultEmbedding: "",
          hfEndpoint: 42,
          grepBudgetPerSearch: Number.NaN,
          unlockWindowMin: "30",
        },
        {},
      ),
      {
        embedding: DEFAULT_EMBEDDING,
        limitDisplay: "10",
        hfEndpoint: "",
        enforceSearchFirst: true,
        grepBudget: "3",
        unlockWindow: "10",
      },
    );
    // Infinity 不是可显示数值
    assert.equal(
      draftFields({ grepBudgetPerSearch: Number.POSITIVE_INFINITY }, {}).grepBudget,
      "3",
    );
  });

  it("defaultLimit 清空（草稿显式 undefined）显示空串，而非默认文案", () => {
    assert.equal(draftFields({ defaultLimit: undefined }, {}).limitDisplay, "");
    assert.equal(draftFields({}, { defaultLimit: undefined }).limitDisplay, "10");
  });
});

describe("resolveLimitInput / limitDraftOf（limit 输入校验）", () => {
  it("有效整数原样通过", () => {
    assert.deepEqual(resolveLimitInput("7", tZh), { kind: "valid", value: 7 });
    assert.deepEqual(resolveLimitInput("1", tZh), { kind: "valid", value: 1 });
    assert.deepEqual(resolveLimitInput("50", tZh), { kind: "valid", value: 50 });
  });

  it("空串 → empty（调用方 unset 回 base 默认）", () => {
    assert.deepEqual(resolveLimitInput("", tZh), { kind: "empty" });
    assert.deepEqual(resolveLimitInput("   ", tZh), { kind: "empty" });
  });

  it("越界 → clamped 到 1-50 并带 hint", () => {
    assert.deepEqual(resolveLimitInput("0", tZh), {
      kind: "clamped",
      value: 1,
      hint: "已钳到 1-50 范围：1",
    });
    assert.deepEqual(resolveLimitInput("99", tZh), {
      kind: "clamped",
      value: 50,
      hint: "已钳到 1-50 范围：50",
    });
  });

  it("非整数/非法 → invalid 并带 hint，保留上次有效值", () => {
    const result = resolveLimitInput("abc", tZh);
    // assert.equal 的 TS 断言签名（asserts actual is T）已经把 result 收窄成 invalid 那一支，
    // 原来跟在后面的 `if (result.kind !== "invalid") assert.fail(...)` 是同一件事的第二遍：
    // 类型面上恒假 ⇒ typescript/no-unnecessary-condition。断言本身留在上面那条，不弱化。
    assert.equal(result.kind, "invalid");
    assert.ok(result.hint.includes("1-50"));
    assert.deepEqual(resolveLimitInput("3.5", tZh), {
      kind: "invalid",
      hint: ZH_LIMIT_INVALID_HINT,
    });
    assert.deepEqual(resolveLimitInput("1e99", tZh), {
      kind: "invalid",
      hint: ZH_LIMIT_INVALID_HINT,
    });
  });

  it("limitDraftOf：invalid 只回提示，empty 写 undefined，valid/clamped 写数值", () => {
    assert.deepEqual(limitDraftOf("abc", tZh), { draft: undefined, error: ZH_LIMIT_INVALID_HINT });
    assert.deepEqual(limitDraftOf("", tZh), { draft: undefined, error: null });
    assert.deepEqual(limitDraftOf("7", tZh), { draft: 7, error: null });
    assert.deepEqual(limitDraftOf("99", tZh), { draft: 50, error: null });
  });
});

describe("parseRebuildPoll（completed 且 exit 0 才算成功）", () => {
  it("running：有输出用输出，无输出给占位", () => {
    assert.deepEqual(parseRebuildPoll({ status: "running", output: "下载中 30%" }, tZh), {
      phase: "running",
      output: "下载中 30%",
    });
    assert.deepEqual(parseRebuildPoll({ status: "running" }, tZh), {
      phase: "running",
      output: "重建中…",
    });
  });

  it("completed + exit 0 → done", () => {
    assert.deepEqual(
      parseRebuildPoll({ status: "completed", exitCode: 0, output: "索引完成" }, tZh),
      {
        phase: "done",
        output: "索引完成",
      },
    );
  });

  it("completed + exit≠0 → error（bash-local 任何自然退出都是 completed）", () => {
    const poll = parseRebuildPoll(
      { status: "completed", exitCode: 127, output: "zg: not found" },
      tZh,
    );
    assert.equal(poll.phase, "error");
    assert.ok(poll.output.includes("退出码 127"));
    assert.ok(poll.output.includes("zg: not found"));
    // 无输出时只给原因，不带前导换行
    assert.equal(
      parseRebuildPoll({ status: "completed", exitCode: 1 }, tZh).output,
      "重建进程退出码 1（zg 未安装/权限不足/沙箱拒绝都会走到这里）",
    );
    // exitCode 缺失（null）同样不是成功
    assert.equal(parseRebuildPoll({ status: "completed", exitCode: null }, tZh).phase, "error");
  });

  it("killed → error 且文案区分于退出码", () => {
    assert.deepEqual(parseRebuildPoll({ status: "killed", exitCode: null }, tZh), {
      phase: "error",
      output: "重建进程被终止",
    });
  });

  // 换装后 status 取自官方作业注册表，比原先的进程态多两枚；这两条钉的是"新词不许
  // 掉进未知分支"——那会把一次正常收尾显示成失败，或把一次失败显示成"退出码 null"。
  it("stopping（取消已发出、进程还没收完）仍按「在跑」显示", () => {
    assert.deepEqual(parseRebuildPoll({ status: "stopping", output: "收尾中" }, tZh), {
      phase: "running",
      output: "收尾中",
    });
    assert.deepEqual(parseRebuildPoll({ status: "stopping" }, tZh), {
      phase: "running",
      output: "重建中…",
    });
  });

  it("failed（注册表侧判定失败）给专门文案，不许显示成「退出码 null」", () => {
    const poll = parseRebuildPoll(
      { status: "failed", exitCode: null, output: "provider blew up" },
      tZh,
    );
    assert.equal(poll.phase, "error");
    assert.ok(poll.output.includes("被宿主注册表判定失败"), poll.output);
    assert.ok(poll.output.includes("provider blew up"), poll.output);
    // 钉的是**另一条分支的整句前缀**（rebuildExitCode = "重建进程退出码 …"），不是"退出码"
    // 三个字——failed 的文案本身也在说退出码，断"字"会误伤。
    assert.equal(poll.output.includes("重建进程退出码"), false, "failed 没有退出码可读");
  });

  it("未知 status（含缺省）→ error", () => {
    assert.equal(parseRebuildPoll({ status: "pending" }, tZh).phase, "error");
    assert.equal(parseRebuildPoll({}, tZh).phase, "error");
    // output 非字符串按空串处理
    assert.equal(
      parseRebuildPoll({ status: "pending", output: 42 }, tZh).output.includes("42"),
      false,
    );
  });
});

describe("httpProblem / parseJsonRecord / isOkBody（应答体检）", () => {
  it("403 单列（CSRF 过期要能认出）", () => {
    assert.match(httpProblem(false, 403, "text/html", tZh) ?? "", /403/u);
  });

  it("非 2xx → 请求失败", () => {
    assert.match(httpProblem(false, 500, "application/json", tZh) ?? "", /HTTP 500/u);
  });

  it("200 但 content-type 不是 JSON → 指出端点未注册", () => {
    const html = httpProblem(true, 200, "text/html; charset=utf-8", tZh);
    // 可选链 + 与 true 显式比较（strict-boolean-expressions 不吃 `boolean | undefined`），
    // 判据与旧的 `html !== null && html.includes(...)` 逐字等价：html 为 null 时同样不成立。
    assert.equal(html?.includes("响应不是 JSON"), true);
    // content-type 缺省时文案里给「缺省」而非空
    assert.match(httpProblem(true, 200, "", tZh) ?? "", /content-type=缺省/u);
  });

  it("健康应答 → null（大小写不敏感）", () => {
    assert.equal(httpProblem(true, 200, "application/JSON", tZh), null);
  });

  it("parseJsonRecord：只认对象", () => {
    assert.deepEqual(parseJsonRecord('{"ok":true}'), { ok: true });
    assert.equal(parseJsonRecord("{oops"), null);
    assert.equal(parseJsonRecord("[1,2]"), null);
    assert.equal(parseJsonRecord("null"), null);
    assert.equal(parseJsonRecord("42"), null);
  });

  it("isOkBody：只认 ok===true", () => {
    assert.equal(isOkBody({ ok: true }), true);
    assert.equal(isOkBody({ ok: "true" }), false);
    assert.equal(isOkBody({}), false);
  });
});

describe("保存动作走 set/unset 两条路（草稿模型）", () => {
  it("清空字段用 unset，有值字段用 set", async () => {
    const scope = fakeScope(snap({ value: {} }));
    await scope.set("defaultLimit", 12);
    await scope.unset("defaultLimit");
    assert.deepEqual(scope.sets, [["defaultLimit", 12]]);
    assert.deepEqual(scope.unsets, ["defaultLimit"]);
  });

  it("官方面第五位 mutate 在位（批量原子写）：本卡不走它，但契约要求它存在", async () => {
    const scope = fakeScope(snap({ value: {} }));
    // 判别位是官方 `SettingsPathOpView` 的 `op`（'set' | 'unset'，installed
    // dsh-settings/lib/types/types.d.ts:47-54），不是 `kind`——旧夹具写 `kind` 一直没红，
    // 是因为 `dsh-api-remotes/client` 不在类型图里、那个类型解析成 error 被 skipLibCheck
    // 吞掉了。现在补上依赖，官方面当场把这一位挑了出来。
    const ops: Parameters<SettingScope["mutate"]>[0] = [
      { op: "set", path: ["defaultLimit"], value: 7 },
    ];
    assert.equal(await scope.mutate(ops), true);
    assert.deepEqual(scope.mutates, [ops]);
    assert.deepEqual(scope.sets, [], "mutate 不落到 set 的轨迹上");
  });
});

// ── i18n：卡片文本取自注入的 translator（切语言 = 换字典那份）───────────────
describe("卡片逻辑文案双语", () => {
  it("en translator 下 limit 提示、轮询终态与应答体检都是英文", () => {
    assert.deepEqual(resolveLimitInput("abc", tEn), {
      kind: "invalid",
      hint: "enter an integer between 1 and 50",
    });
    assert.deepEqual(resolveLimitInput("99", tEn), {
      kind: "clamped",
      value: 50,
      hint: "clamped into the 1-50 range: 50",
    });
    assert.equal(parseRebuildPoll({ status: "running" }, tEn).output, "rebuilding…");
    assert.equal(parseRebuildPoll({ status: "stopping" }, tEn).output, "rebuilding…");
    assert.match(
      parseRebuildPoll({ status: "failed", exitCode: null }, tEn).output,
      /reported the rebuild as failed/u,
    );
    assert.equal(
      parseRebuildPoll({ status: "killed" }, tEn).output,
      "the rebuild process was terminated",
    );
    assert.match(
      parseRebuildPoll({ status: "completed", exitCode: 127 }, tEn).output,
      /exited with code 127/u,
    );
    assert.match(httpProblem(false, 403, "text/html", tEn) ?? "", /CSRF token/u);
    assert.match(httpProblem(true, 200, "", tEn) ?? "", /content-type=unset/u);
  });

  it("英文那份整段不残留中文（同一渲染路径只换字典）", () => {
    const rendered = JSON.stringify([
      resolveLimitInput("abc", tEn),
      resolveLimitInput("0", tEn),
      limitDraftOf("abc", tEn),
      parseRebuildPoll({ status: "running" }, tEn),
      parseRebuildPoll({ status: "stopping" }, tEn),
      parseRebuildPoll({ status: "failed", exitCode: null }, tEn),
      parseRebuildPoll({ status: "completed", exitCode: 1 }, tEn),
      httpProblem(false, 500, "", tEn),
      httpProblem(true, 200, "text/html", tEn),
    ]);
    assert.doesNotMatch(rendered, /[\u4E00-\u9FFF]/u);
  });
});
