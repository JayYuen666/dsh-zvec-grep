// lib/card-logic.ts 单测（DOM-free，host typecheck 可直接 import）：
// cardStore 快照投影与 per-scope 缓存 / 草稿取值（touched 优先；读判据在
// lib/card-draft.ts，用例逐条照旧）/ 重建轮询应答解析（completed 且 exit 0 才算成功）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { cardStore, daemonNoteKey, draftFields, parseRebuildPoll } from "../lib/card-logic.ts";
import type { CardText, SettingScope } from "../lib/card-logic.ts";
import { draftOf } from "../lib/card-draft.ts";
import { DEFAULT_EMBEDDING } from "../lib/embedding-catalog.ts";
import { fill } from "../lib/messages.ts";
import { UI_MESSAGES } from "../src/ui-messages.ts";
import { CJK_RESIDUE } from "./cjk-residue.ts";
import type { ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";

/** 已提交快照里的端点值：三个用例共用同一份事实源。 */
const COMMITTED_ENDPOINT = "https://committed.example";

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

/** 继承成员哨兵：一枚有身份的函数，用来证明 `Object.prototype` 上的成员不会被当成已提交值交出。 */
const PROTOTYPE_SENTINEL = (): void => undefined;

/**
 * 中文「无退出码」文案的期望整句：三个用例共用（exitCode null / 缺 status / NaN），
 * 引字典键等于让字典自己给自己作证，独立抄一份。
 */
const ZH_REBUILD_EXIT_UNKNOWN = "重建没有可判定的结果（应答的 status 无法识别，或缺少进程退出码）";

/**
 * 中文「limit 非法」提示的期望整句：`tZh` 从 UI_MESSAGES 渲染出来就是这一串，断言里
 * 独立抄一份——引字典键/字典文本等于让字典自己给自己作证。三个用例共用（abc / 3.5 / 1e99）。
 */

// ── SettingScope（= 官方 ConfigForm<Record<string, unknown>>）替身 ──────────
// 契约形状本身即断言：五成员全必选（getSnapshot / subscribe / mutate / set / unset，
// 见 @deepseek-ai/dsh-client-ui-settings/client 的 ConfigForm），set/unset 回
// `Promise<boolean>`（受理位），**没有** dispose——`configForms.get(entryId)` 交回的是
// provider 持有的共享表单（同包 config-form.d.ts），卡片自 dispose 会连坐同
// provider 的其它消费者。

/** 官方 `ConfigFormSnapshot` 的合法形状（6 位全必选）；首个快照受理前 value/revision
 *  为 undefined，正是卡片要渲染「还没数据」的那一态。 */
function snap(over: Partial<FormSnapshot> = {}): FormSnapshot {
  return {
    status: "ready",
    value: { defaultLimit: 10 },
    base: {},
    user: {},
    revision: 3,
    writable: true,
    ...over,
  };
}

/** 退订替身本体：一枚有身份的函数，`fakeScope` 每次订阅都交回它 —— 「卡片拿到的退订
 *  就是 scope 那一枚」这条身份断言靠的就是它不是就地新建的空函数。不捕获外层变量，
 *  所以住在模块层。 */
function fakeUnsubscribe(): void {
  void 0;
}

function fakeScope(initial: FormSnapshot): SettingScope & {
  setSnap: (value: FormSnapshot) => void;
  sets: [string, unknown][];
  unsets: string[];
  mutates: unknown[][];
  subscribes: number;
  /** 交进来的 listener 原样留着：`cardStore.subscribe` 必须转发同一枚，而不是自己造一枚。 */
  listeners: (() => void)[];
  /** 每次订阅自己造一枚有身份的退订函数，供「返回值就是 scope 那一枚」的身份断言。 */
  unsubscribes: (() => void)[];
} {
  let snapValue = initial;
  const sets: [string, unknown][] = [];
  const unsets: string[] = [];
  const mutates: unknown[][] = [];
  const listeners: (() => void)[] = [];
  const unsubscribes: (() => void)[] = [];
  const scope = {
    getSnapshot: () => snapValue,
    subscribe: (listener: () => void) => {
      scope.subscribes += 1;
      listeners.push(listener);
      unsubscribes.push(fakeUnsubscribe);
      return fakeUnsubscribe;
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
    listeners,
    unsubscribes,
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
    const memoryScope = fakeScope(snap({ status: "unavailable", writable: false }));
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
    const scopeB = fakeScope(snap({ writable: false, value: { defaultLimit: 20 } }));
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
    let heard = 0;
    const listener = (): void => {
      heard += 1;
    };
    const unsubscribe = store.subscribe(listener);
    assert.equal(scope.subscribes, 1);
    // 只数次数与 typeof 的话，「另造一枚空函数交给 scope」或「返回自己的空实现」都会绿 ——
    // 而卡片重挂靠的正是这两个身份：转过去的是同一枚 listener，退订的是 scope 交回的那一枚。
    assert.equal(scope.listeners[0], listener, "listener 原样转发，不另造");
    assert.equal(unsubscribe, scope.unsubscribes[0], "退订函数就是 scope 交回的那一枚");
    scope.listeners[0]();
    assert.equal(heard, 1, "转过去的那枚确实可达");
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

  it("只判自有属性：继承键（toString/constructor/hasOwnProperty）不算 touched/已提交值", () => {
    // `field in touched` 或裸下标会沿原型链命中 Object.prototype 的成员，把函数/对象当值交出去。
    // 哨兵用身份断言而非 typeof：typeof 对函数/对象只会给 "function"/"object"，区分不出被顶替的值。
    assert.equal(draftOf({}, { toString: 5 }, "toString"), 5);
    assert.equal(
      draftOf({}, { constructor: PROTOTYPE_SENTINEL }, "constructor"),
      PROTOTYPE_SENTINEL,
    );
    assert.equal(draftOf({}, { hasOwnProperty: 7 }, "hasOwnProperty"), 7);
    assert.equal(draftOf({}, {}, "toString"), undefined, "继承成员不得作为已提交值");
    assert.equal(draftOf({}, {}, "constructor"), undefined);
    assert.equal(draftOf({}, {}, "hasOwnProperty"), undefined);
  });

  it("六个字段全部草稿优先（含 hfEndpoint 与 embedding）", () => {
    const committed = {
      defaultEmbedding: "local/committed",
      hfEndpoint: COMMITTED_ENDPOINT,
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
      hfEndpoint: COMMITTED_ENDPOINT,
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
    // 已提交快照里的坏端点不是可显示 URL，回落空串（host 侧也不会拿它去拼命令）
    assert.equal(draftFields({}, { hfEndpoint: "modelscope.cn/models" }).hfEndpoint, "");
    assert.equal(draftFields({}, { hfEndpoint: "ftp://mirror.example" }).hfEndpoint, "");
  });

  it("端点草稿原样回显：逐字键入的中间态不被 URL 校验吞掉", () => {
    // 草稿是「这一格此刻的文本」，不是待校验的值：输到一半的 URL 必须原样显示，
    // 否则输入第一个字符就被过滤成空串，界面看起来像输入无效、实际是显示层在吞键。
    assert.equal(draftFields({ hfEndpoint: "h" }, {}).hfEndpoint, "h");
    assert.equal(draftFields({ hfEndpoint: "https://exa" }, {}).hfEndpoint, "https://exa");
    // 删字符：已提交 URL 改到少一位的草稿，显示刚删完的那串，不是空串。
    assert.equal(
      draftFields({ hfEndpoint: "https://committed.exampl" }, { hfEndpoint: COMMITTED_ENDPOINT })
        .hfEndpoint,
      "https://committed.exampl",
    );
    // 清空（显式 undefined）与类型不对的草稿显示空串：与三个数值字段同一条清空语义。
    assert.equal(draftFields({ hfEndpoint: undefined }, {}).hfEndpoint, "");
    assert.equal(draftFields({ hfEndpoint: 42 }, {}).hfEndpoint, "");
  });

  it("defaultLimit 清空（草稿显式 undefined）显示空串，而非默认文案", () => {
    assert.equal(draftFields({ defaultLimit: undefined }, {}).limitDisplay, "");
    assert.equal(draftFields({}, { defaultLimit: undefined }).limitDisplay, "10");
  });

  it("三个数值字段的清空语义一致：显式清空显示空串，没动过显示默认文案", () => {
    // grepBudget/unlockWindow 与 defaultLimit 走同一条判据：buildRangeRow 清空时写入
    // undefined（待 unset），显示若回落到默认文案，界面就像「已填默认值」，脏数据仍在。
    const displayKey = {
      defaultLimit: "limitDisplay",
      grepBudgetPerSearch: "grepBudget",
      unlockWindowMin: "unlockWindow",
    } as const;
    const cases: readonly [keyof typeof displayKey, string][] = [
      ["defaultLimit", "10"],
      ["grepBudgetPerSearch", "3"],
      ["unlockWindowMin", "10"],
    ];
    for (const [field, fallback] of cases) {
      const key = displayKey[field];
      assert.equal(draftFields({ [field]: undefined }, {})[key], "");
      assert.equal(
        draftFields({}, { [field]: undefined })[key],
        fallback,
        "快照里的 undefined（没动过）不是清空",
      );
    }
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

  it("非对象载荷 → 按未知态兜底（schema 拒收，走 safeParse 的失败支）", () => {
    // 运行时可能送来 null / 数组（HTTP 载荷被换过）；函数签名只约束编译期。
    // 整个结果一起钉：只断 phase 分不清 safeParse 失败支与「未知 status」支。
    for (const raw of [null, []]) {
      const poll = parseRebuildPoll(raw, tZh);
      assert.deepEqual(
        { phase: poll.phase, output: poll.output },
        { phase: "error", output: ZH_REBUILD_EXIT_UNKNOWN },
      );
    }
  });

  it("未知 status（含缺省）→ error", () => {
    assert.equal(parseRebuildPoll({ status: "pending" }, tZh).phase, "error");
    assert.equal(parseRebuildPoll({}, tZh).phase, "error");
    // output 非字符串按空串处理
    assert.equal(
      parseRebuildPoll({ status: "pending", output: 42 }, tZh).output.includes("42"),
      false,
    );
    // status 非字符串同样按未知态处理
    assert.equal(parseRebuildPoll({ status: 42 }, tZh).phase, "error");
  });

  it("退出码只在确是有限数字时展示；缺失/畸形回落到通用失败文案", () => {
    // 「重建进程退出码 undefined / null」这类文案只会误导排查（该函数收的就是
    // Record<string, unknown>，字段缺席本就该容忍）。
    assert.equal(
      parseRebuildPoll({ status: "completed", exitCode: null }, tZh).output,
      ZH_REBUILD_EXIT_UNKNOWN,
    );
    assert.equal(parseRebuildPoll({}, tZh).output, ZH_REBUILD_EXIT_UNKNOWN);
    assert.equal(
      parseRebuildPoll({ status: "completed", exitCode: Number.NaN }, tZh).output,
      ZH_REBUILD_EXIT_UNKNOWN,
    );
    // 确是有限数字 → 照旧展示退出码（bash-local 任何自然退出都是 completed）。
    assert.match(
      parseRebuildPoll({ status: "completed", exitCode: 127 }, tZh).output,
      /退出码 127/u,
    );
  });
});

describe("替身的写入轨迹分别记账（供上面几条依赖）", () => {
  // 这条不是产品覆盖：卡片"清空走 unset、有值走 set"的决策在 src/client-entry.ts 的 save() 里，
  // 那是浏览器入口（document/React），node 侧求值不到它。这里只证明 fakeScope 这两条轨迹
  // 各自记账、互不串台 —— 后面「mutate 不落到 set 轨迹」那类断言靠的就是它先成立。
  // 写通道**透传**的产品判据在 test/build-client.test.ts（对产物求值 payload.set/unset
  // 是否落进本条目那张表单）；save() 里那一支的分支选择没有 node 侧判据，按已知缺口登记。
  it("set 与 unset 各记各的轨迹", async () => {
    const scope = fakeScope(snap({ value: {} }));
    await scope.set("defaultLimit", 12);
    await scope.unset("defaultLimit");
    assert.deepEqual(scope.sets, [["defaultLimit", 12]]);
    assert.deepEqual(scope.unsets, ["defaultLimit"]);
  });

  it("官方面第五位 mutate 在位（批量原子写）：本卡不走它，但契约要求它存在", async () => {
    const scope = fakeScope(snap({ value: {} }));
    // 判别位是官方 `SettingsPathOpView` 的 `op`（'set' | 'unset'，installed
    // dsh-settings/lib/types/types.d.ts），不是 `kind`——旧夹具写 `kind` 一直没红，
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
  it("en translator 下轮询终态都是英文", () => {
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
  });

  it("英文那份整段不残留中文（同一渲染路径只换字典）", () => {
    const rendered = [
      parseRebuildPoll({ status: "running" }, tEn).output,
      parseRebuildPoll({ status: "stopping" }, tEn).output,
      parseRebuildPoll({ status: "failed", exitCode: null }, tEn).output,
      parseRebuildPoll({ status: "completed", exitCode: 1 }, tEn).output,
    ];
    // 先逐项钉非空字符串：JSON.stringify 会丢 undefined 值、空串也过 doesNotMatch，
    // 不先钉「有内容」时缺键/空文案的退化在这里是隐形的。
    for (const text of rendered) {
      assert.ok(typeof text === "string" && text.length > 0, "渲染结果必须是非空字符串");
    }
    assert.doesNotMatch(rendered.join("\n"), CJK_RESIDUE);
  });
});

describe("daemonNoteKey：守护进程就绪态该显示哪一行", () => {
  it("三档各归各处：未知不显示，而不是把未知说成未就绪", () => {
    assert.equal(daemonNoteKey(undefined), undefined, "应答里没有这一档 ⇒ 不显示");
    assert.equal(daemonNoteKey(false), "daemonOfflineNote");
    assert.equal(daemonNoteKey(true), "daemonReadyNote");
    // wire 上的 serverReady 未经运行时校验（lib/rebuild-shape.ts 只有类型声明）：
    // null/字符串这类畸形值不得被 falsy 判断误收——实现是 === true/false 严格判等，
    // 实现改宽时这些用例会红。
    assert.equal(daemonNoteKey(null), undefined, "null 不是合法三档之一");
    assert.equal(daemonNoteKey("false"), undefined, "字符串形态不命中 false 档");
    assert.equal(daemonNoteKey("true"), undefined, "字符串形态不命中 true 档");
    assert.equal(daemonNoteKey(0), undefined, "数字形态不命中");
  });

  it("选出来的两个键都在双语字典里（缺键会在运行时才 t() 出 undefined）", () => {
    for (const key of ["daemonReadyNote", "daemonOfflineNote"] as const) {
      assert.ok(UI_MESSAGES.zh[key].length > 0, `中文缺 ${key}`);
      assert.ok(UI_MESSAGES.en[key].length > 0, `英文缺 ${key}`);
    }
  });
});
