// build-client.mjs 测试：产物含 ModuleLoader 包装、react 外部化、入口半内容，
// 且 factory 可求值导出 inject/apply。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import vm from "node:vm";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildClient } from "../build-client.mjs";
import { declareClientFreshness } from "./client-freshness.ts";
import { declareSchemaCoverage } from "./schema-coverage.ts";
import { fill } from "../lib/messages.ts";
import { UI_MESSAGES } from "../src/ui-messages.ts";
import type { LocaleNs, Translate, UiMessages } from "../src/ui-messages.ts";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";
import type { ConfigForm, ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";

// 模块表 id 必须等于包名（dsh 的 client-modules 只扫裸包名条目并按包名建键）：
// 断言两侧同源，验的是「构建器取了 package.json 的 name」，改名不再需要改测试。
const PKG_NAME = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as unknown as {
    name: string;
  }
).name;

/** 本包目录（绝对路径），用于核对 profile 的 link: 目标。 */
const PKG_DIR = path.resolve(import.meta.dirname, "..");

/**
 * profile 的 bundle 清单（`~/.dsh/profiles/web/package.json` → `dsh.profile.bundles`）
 * 里本包那一条，即 `plugins.bundle.config` 唯一可命中的 key。
 *
 * 必须**解析**而不是在测试里抄一份字符串：上一版把 key 写成裸条目 id（`zvec-grep`），
 * 而宿主派发的是 bundle 包名（installed dsh-client-ui-plugin-manager/lib/client.js:1821
 * `renderSlot(..., { entryKey: pkg.name })`；slot-contract.d.ts:96-98「keyed by the
 * bundle's package name」），测试跟着硬抄同一个错值就一直绿，插件页面上却什么都没渲染。
 * 顺带钉住两件事：清单里确有这一条（否则改名的漂移没人拦）、profile 的 link 目标就是
 * 本目录（否则比的是另一份残留副本）。
 */
function profileBundleName(): string {
  // 宿主派发插件页时用的 entryKey 就是**被装的那个 bundle** 的包名（与本包 package.json
  // 一致，与装法无关：registry / link / 本机 profile 都是它），所以核心判据不需要 profile。
  // profile 只存在在这台开发机上；装了它才顺手钉两道机器侧漂移针（清单里恰有一条、
  // link 目标就是本目录，避免比到残留副本）。
  const override = process.env["DSH_PROFILE_PACKAGE_JSON"] ?? "";
  const profilePath =
    override === "" ? path.join(os.homedir(), ".dsh", "profiles", "web", "package.json") : override;
  if (!existsSync(profilePath)) {
    return PKG_NAME;
  }
  const profile = JSON.parse(readFileSync(profilePath, "utf8")) as {
    dependencies?: Record<string, unknown>;
    dsh?: { profile?: { bundles?: unknown } };
  };
  const bundles: unknown = profile.dsh?.profile?.bundles;
  assert.ok(Array.isArray(bundles), `${profilePath} 的 dsh.profile.bundles 应是数组`);
  // link 指向的是"哪一份检出"：本机 profile 装的就是这一份时，才顺手钉"清单里恰有一条、
  // 且只指向本目录"这两道机器侧针（改名/残留副本没人拦就是真缺陷）。指向别处时（单包仓的
  // 暂存副本、消费者自己的检出）这条针不适用 —— 拿别的机器的安装状态判红等于把开发机
  // 状态写进包测试，故跳过而不是失败。
  const installedHere: unknown = profile.dependencies?.[PKG_NAME];
  if (!(typeof installedHere === "string" && installedHere.includes(PKG_DIR))) {
    return PKG_NAME;
  }
  const listed = (bundles as unknown[]).filter((item) => item === PKG_NAME);
  assert.deepEqual(listed, [PKG_NAME], "本包在 profile 的 bundles 清单里，且只列一次");
  const link: unknown = profile.dependencies?.[PKG_NAME];
  assert.equal(typeof link, "string", "profile 的 dependencies 指向本包");
  assert.ok(
    typeof link === "string" && link.includes(PKG_DIR),
    `profile 的 link 目标应是本目录（实得 ${String(link)}）`,
  );
  return PKG_NAME;
}

/** 本包 cordis.patch.yml 声明的裸条目 id（= 0.1.7 的 settings 命名空间）。 */
function patchEntryIds(): string[] {
  const patch = readFileSync(path.join(PKG_DIR, "cordis.patch.yml"), "utf8");
  return [...patch.matchAll(/^\s*(?:-\s+)?id:\s*(?<id>\S+)\s*$/gmu)].map(
    (row) => row.groups?.["id"] ?? "",
  );
}

/** 本条目那张表单的官方快照面（别名要保持**已实例化**，否则每处使用都得再给类型参）。 */
type FormSnapshot = ConfigFormSnapshot<Record<string, unknown>>;

interface LoadedModuleDef {
  id?: string;
  factory?: (require: (name: string) => unknown) => unknown;
}

/** 表单落到轨迹上的写调用（set/unset 的第一参序列 + dispose / mutate 绊线的命中次数）。 */
interface FormTrace {
  setCalls: [string, unknown][];
  unsetCalls: string[];
  /** 0.1.7 的 `ConfigForm` 契约里**没有** dispose，故这里恒应为空——绊线。 */
  disposeCalls: number[];
  /** 官方第五位 `mutate`（批量原子写）：本卡逐字段走 set/unset，故恒应为空——绊线。 */
  mutateCalls: unknown[][];
}

/** 替身的公开面：官方 `ConfigForm` 五成员（getSnapshot / subscribe / mutate / set /
 *  unset）+ 一根 dispose 绊线。`extends ConfigForm<…>` 是**编译期**契约：官方面加一位
 *  （或改一位签名）这里立刻编译失败，而不是等真宿主来告诉你。 */
interface FakeForm extends ConfigForm<Record<string, unknown>> {
  dispose: () => Promise<void>;
}

/** 官方 `ConfigFormSnapshot` 的合法形状（7 位全必选）。 */
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

/**
 * 注入面下发给卡片的写入函数。卡片自己声明的是 Promise<void>（src/client-entry.ts 的
 * CardSlotProps），测试侧改标 Promise<unknown> 只为了能把「resolve 出来是 undefined
 * = 受理位没外泄给卡片」写成断言；两个 wrapper 的真实返回类型由 tsc 在 src 那侧钉住。
 */
interface CardPayload {
  set: (field: string, value: unknown) => Promise<unknown>;
  unset: (field: string) => Promise<unknown>;
}

/** makeHost 记下的宿主调用轨迹。 */
interface HostTrace {
  effects: { label?: string; factory: () => (() => void) | undefined }[];
  /** 注册进官方 locale 的入参（命名空间 + 一次交齐的两语字典），形状就是官方
   *  `LocaleRuntime.register` 类型化重载的两个参数。 */
  dicts: {
    ns: string;
    dicts: Record<BuiltInLocaleId, LocaleDictOf<LocaleNs>>;
  }[];
  /** configForms.get() 被要过哪些条目 id。 */
  entryIds: string[];
  slotNames: string[];
  /** slots.inject 登记的工厂：槽「折叠 → 再声明」时宿主会重跑它。 */
  slotFactories: (() => () => void)[];
  /** slots.register 交回的注销函数。 */
  cleanups: (() => void)[];
  desc: { name: string; key: string | undefined } | null;
  /** slots.register 的 inject payload（各用例按自己知道的形状取用）。 */
  payload: unknown;
}

/**
 * 本条目共享表单的替身。形状直接是官方 `ConfigForm<Record<string, unknown>>` 五成员
 * （getSnapshot / subscribe / mutate / set / unset）：set/unset 回**受理位**
 * （true = 宿主受理，false = 拒绝或写入被跳过），只有传输失败才 reject。
 * ⚠ `dispose` 不在消费者契约里，留在这里只作**绊线**：卡片一旦试图销毁 provider
 * 持有的共享表单（旧 settingsScope 时代的写法），disposeCalls 就非空 → 用例红。
 * ⚠ `mutate`（路径级原子写入）本卡不走，但官方面要求它在位；这里同样留一根绊线，
 * 卡片若改用批量写而绕过 set/unset 的轨迹，mutateCalls 会非空 → 用例红。
 * `fail: true` 时 set/unset 直接 reject，用来钉住「传输失败也不冒到卡片」。
 */
function fakeForm(trace: FormTrace, opts: { fail?: boolean } = {}): FakeForm {
  /** 快照身份稳定（官方契约：stable reference until the next change）——cardStore 的
   *  memo 正是靠引用相等判「未换代」，每次 new 一个对象会让用例测不到缓存。 */
  const snapshot = snap();
  /** 先记轨迹，再回受理位（或按 fail 模拟传输失败）。 */
  const write = (record: () => void): Promise<boolean> => {
    record();
    return opts.fail === true ? Promise.reject(new Error("transport down")) : Promise.resolve(true);
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {
      void 0;
    },
    mutate: (ops: readonly unknown[]): Promise<boolean> =>
      write(() => {
        trace.mutateCalls.push([...ops]);
      }),
    set: (field: string, value: unknown): Promise<boolean> =>
      write(() => {
        trace.setCalls.push([field, value]);
      }),
    unset: (field: string): Promise<boolean> =>
      write(() => {
        trace.unsetCalls.push(field);
      }),
    dispose: (): Promise<void> => {
      trace.disposeCalls.push(1);
      return Promise.resolve();
    },
  };
}

/** apply 一次所需的最小宿主替身（槽位与 locale 留痕，注册可回收）。 */
function makeHost(form: FakeForm): {
  ctx: unknown;
  trace: HostTrace;
  language: { active: "zh" | "en" };
} {
  const trace: HostTrace = {
    effects: [],
    dicts: [],
    entryIds: [],
    slotNames: [],
    slotFactories: [],
    cleanups: [],
    desc: null,
    payload: null,
  };
  // 语言放在可变对象里：同一个 bind 出的 t 换语言即换字典（钉住「不必重挂卡片」）。
  const language = { active: "zh" as "zh" | "en" };
  const ctx = {
    effect: (factory: () => (() => void) | undefined, label?: string): void => {
      trace.effects.push({ factory, ...(label === undefined ? {} : { label }) });
    },
    slots: {
      inject: (slot: string, factory: () => () => void): void => {
        trace.slotNames.push(slot);
        trace.slotFactories.push(factory);
        factory();
      },
      register: (desc: {
        name: string;
        key?: string;
        inject?: () => Record<string, unknown>;
      }): (() => void) => {
        trace.desc = { name: desc.name, key: desc.key };
        trace.payload = desc.inject?.() ?? null;
        const cleanup = (): void => {
          trace.payload = null;
        };
        trace.cleanups.push(cleanup);
        return cleanup;
      },
    },
    // 0.1.7：卡片拿的是 provider 按**条目 id** 交回的共享表单，不再是 bind 出的 scope。
    configForms: {
      get: (entryId: string): FakeForm => {
        trace.entryIds.push(entryId);
        return form;
      },
    },
    locale: {
      // 官方 `LocaleRuntime.register` 的**类型化**那条重载：一次调用收齐两语，返回一个
      // 撤掉这一次登记的全部语言的 disposer（installed dsh-client-locale/lib/client.js
      // 的 register(ns, localeOrDicts, dict) 对对象入参走 Object.entries(dicts)）。
      register: (
        ns: string,
        dicts: Record<BuiltInLocaleId, LocaleDictOf<LocaleNs>>,
      ): (() => void) => {
        const row = { ns, dicts };
        trace.dicts.push(row);
        return () => {
          const i = trace.dicts.indexOf(row);
          if (i !== -1) {
            trace.dicts.splice(i, 1);
          }
        };
      },
      bind:
        () =>
        (key: string, params?: Record<string, string | number | null>): string =>
          fill(
            (language.active === "en" ? UI_MESSAGES.en : UI_MESSAGES.zh)[key as keyof UiMessages],
            params ?? {},
          ),
    },
  };
  return { ctx, trace, language };
}

// 两道产物门禁（指纹 + 字段覆盖）在**用例求值时**登记自己的 it()，所以调用点必须是顶层
// await 而不是裸调用：vitest/require-hook 把裸调用判成「setup 没进 hook」，而挪进 describe
// 或 beforeAll 都不行——前者照样报，后者会让 helper 里的 it() 落在收集期之外（实测：那条
// 用例被静默丢掉，门禁从此不再跑）。async + 顶层 await 是本仓 danger-guard /
// wukil-dev-tools-card 已有的同一套解法，登记时机与用例名都不变。
await declareClientFreshness(import.meta.url);
await declareSchemaCoverage(import.meta.url, {
  allowUnbound: [
    {
      field: "searchTimeoutMs",
      reason:
        "非 volatile 部署值（cordis.yml config: 改）：前台检索超时随部署的索引规模/网络调整，不是用户可调项",
    },
    {
      field: "statusTimeoutMs",
      reason: "非 volatile 部署值（cordis.yml config: 改）：状态查询超时，无卡位",
    },
    {
      field: "indexTimeoutMs",
      reason:
        "非 volatile 部署值（cordis.yml config: 改）：建索引超时 + 后台重建 kill 定时器，受宿主 bash-local maxTimeoutMs 约束",
    },
    {
      field: "stdoutMaxBytes",
      reason: "非 volatile 部署值（cordis.yml config: 改）：执行器 stdout 缓冲上限，无卡位",
    },
    {
      field: "clientMode",
      reason:
        "非 volatile 部署值（cordis.yml config: 改）：zg 传输模式随部署是否启用守护进程而定，默认自动即最优，故不设卡位",
    },
    {
      field: "rebuildWaitMs",
      reason:
        "非 volatile 部署值（cordis.yml config: 改）：检索等待同根重建落定的上限，随部署的索引规模调整",
    },
    {
      field: "allowRemoteEmbedding",
      reason:
        "非 volatile 部署值（cordis.yml config: 改）：远程 embedding 授权闸。刻意不给卡位——它是" +
        "「允许把工作区内容送出本机」的安全开关，放到设置卡上等于让任何能开设置的人顺手打开。" +
        "要开就改部署配置，那条改动会留在 git 里",
    },
    {
      field: "remoteEmbeddingEndpoint",
      reason:
        "非 volatile 部署值（cordis.yml config: 改）：远程 embedding 端点，与 allowRemoteEmbedding 同批开放；无卡位",
    },
    {
      field: "requireApprovalForExplicitRoot",
      reason:
        "非 volatile 部署值（cordis.yml config: 改）：官方用户确认开关。刻意不给卡位——" +
        "打开后每次越界检索都会弹确认，而在 danger-full-access 预设与委派子代理下宿主会把它" +
        "确定性拒掉（approvalPolicy: never），放进设置卡只会让人以为开关生效了",
    },
    {
      field: "remoteEmbeddingApiKeyFrom",
      reason:
        "非 volatile 部署值（cordis.yml config: 改）：只记宿主进程里那个装凭据的环境变量**名字**，" +
        "不是密钥本身。绝不能落进设置卡（那会把密钥写进 profile 配置并同步到客户端）",
    },
  ],
});

describe("buildClient()", () => {
  it("产物包含 ModuleLoader 包装、react 外部化与入口半内容", async () => {
    const out = await buildClient();
    assert.ok(out.includes("window.__ModuleLoader__.load({"));
    assert.ok(out.includes(`id: '${PKG_NAME}'`));
    assert.ok(out.includes('require("react")') || out.includes("require('react')"));
    assert.ok(out.includes("exports.apply"));
  });

  it("产物不含 Node 专用残留", async () => {
    const out = await buildClient();
    assert.ok(!out.includes("node:test"));
    assert.ok(!out.includes("import.meta"));
  });

  it("两语 UI 字典都进产物（卡片侧双语不靠运行时拉取）", async () => {
    const out = await buildClient();
    assert.ok(out.includes(UI_MESSAGES.zh.cardDescription), "中文那份在产物里");
    assert.ok(out.includes(UI_MESSAGES.en.cardDescription), "英文那份在产物里");
    assert.ok(
      out.includes("locale.register") || out.includes(".register("),
      "官方 locale 注册面在产物里",
    );
  });

  it("ZgCard 快照契约防回归：配置值从 snap.value 解构（2026-09-18 修复）", async () => {
    const out = await buildClient();
    // 修复前 value = snap 整体（顶层含 status/writable，配置读不到）→ 恒显示默认值。
    // 修复后 value = snap.value ?? {}。断言产物含 .value 解构、不含把 snap 当 value。
    assert.ok(
      out.includes("snap.value") || out.includes(".value ?? {}") || out.includes("[snap.value"),
      "产物应含 snap.value 解构（快照契约 {status, writable, value:{...}}）",
    );
  });
});

async function loadClientExports(): Promise<{
  apply: (ctx: unknown) => void;
  inject: string[];
}> {
  const out = await buildClient();
  const sandbox: {
    loadedDef?: LoadedModuleDef;
    window: { __ModuleLoader__: { load: (def: unknown) => void } };
    console: Console;
  } = {
    window: {
      __ModuleLoader__: {
        load(def: unknown) {
          sandbox.loadedDef = def as LoadedModuleDef;
        },
      },
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(out, sandbox);
  const loaded = sandbox.loadedDef;
  assert.ok(
    loaded && typeof loaded === "object" && typeof loaded.factory === "function",
    "ModuleLoader.load was called",
  );
  assert.equal(loaded.id, PKG_NAME);

  const fakeReact = {
    createElement: () => ({}),
    useState: (init: unknown) => [
      typeof init === "function" ? (init as () => unknown)() : init,
      () => {
        void 0;
      },
    ],
    useEffect: () => {
      void 0;
    },
    useRef: (init: unknown) => ({ current: init }),
  };
  const mod = loaded.factory((name: string) => {
    if (name === "react") {
      return fakeReact;
    }
    throw new Error(`unexpected require in client factory: ${name}`);
  });
  const exports = mod as { apply?: unknown; inject?: unknown };
  assert.equal(typeof exports.apply, "function");
  return {
    apply: exports.apply as (ctx: unknown) => void,
    inject: [...(exports.inject as unknown[])] as string[],
  };
}

describe("client.js 冒烟（stub ModuleLoader + stub react）", () => {
  /** 求值产物、取出导出的 apply/inject（宿主替身由各用例自己给）。 */

  it("factory 可求值并导出 inject/apply（注入面按 0.1.7 交 configForms）", async () => {
    // configForms 取代 0.1.6 的 settingsScope：后者在 installed 0.1.7 全树零命中，继续
    // 注入它 = 必填服务缺失 = 整条 client 入口挂不上（卡片静默消失）。契约源 installed
    // dsh-client-ui-settings/lib/types/client/config-form.d.ts:94-98（Context 增强）与
    // :142（get<T>(entryId): ConfigForm<T>）。仍是**精确全等**清单，不放宽为包含判定。
    const { inject } = await loadClientExports();
    assert.deepEqual(inject, ["slots", "configForms", "locale"]);
  });

  it("表单按 profile 条目 id 取（zvec-grep）；payload 写入落回同一张共享表单；disposer 不 dispose", async () => {
    const formTrace: FormTrace = {
      setCalls: [],
      unsetCalls: [],
      disposeCalls: [],
      mutateCalls: [],
    };
    const form = fakeForm(formTrace);
    const { apply } = await loadClientExports();
    const { ctx, trace } = makeHost(form);
    apply(ctx);
    // 0.1.7 起 settings 命名空间 = 本包 cordis.patch.yml 的裸条目 id（不是
    // @jayyuen66/dsh-zvec-grep）：configForms.get() 把入参原样当命名空间用（installed
    // dsh-client-ui-settings/lib/client.js:1309-1315）。id 取自 patch 文件，不在测试里抄。
    const bareIds = patchEntryIds();
    assert.deepEqual(bareIds, ["zvec-grep"], "cordis.patch.yml 只声明一行裸条目 id");
    assert.deepEqual(trace.entryIds, bareIds, "只取本条目那张共享表单，且只取一次");
    assert.deepEqual(trace.slotNames, ["plugins.bundle.config"]);
    assert.equal(trace.desc?.name, "plugins.bundle.config");
    // 槽 key = profile bundles 清单里的 bundle 包名（解析而来，见 profileBundleName）。
    const bundleName = profileBundleName();
    assert.equal(trace.desc.key, bundleName);
    // 反向漂移钉：key 不得退回裸条目 id，也不得是「包名#行 id」那种行槽写法
    // （installed plugin-manager/lib/client.js:27-28 `rowConfigKey`，本包没有行槽）。
    assert.notEqual(trace.desc.key, bareIds[0], "key 不再是条目 id：那正是卡片不渲染的写法");
    assert.ok(
      typeof trace.desc.key === "string" && !trace.desc.key.includes("#"),
      "bundle 槽的 key 不含 #（行槽才用 <pkg>#<rowId>）",
    );
    assert.equal(
      trace.desc.key,
      PKG_NAME,
      "槽 key 与本包 package.json 的 name 同源（改名不再两边抄）",
    );
    const payload = trace.payload as CardPayload;
    // 写通道受理位 Promise<boolean> **原样透传**给卡片（消费在 save()：false →
    // saveRejected 文案且整批保留 touched；reject → saveFailed）——旧版在此 await 后
    // 刻意不消费（"消费=改行为"），一次合规修复即是那次行为变更。
    assert.equal(await payload.set("defaultLimit", 7), true, "payload.set 透传受理位");
    assert.equal(await payload.unset("hfEndpoint"), true, "payload.unset 透传受理位");
    assert.deepEqual(
      formTrace.setCalls,
      [["defaultLimit", 7]],
      "payload.set 必须写进本条目那张表单",
    );
    assert.deepEqual(formTrace.unsetCalls, ["hfEndpoint"], "payload.unset 必须清空本条目表单");
    // slot 清理：只注销这次声明，**绝不** dispose provider 持有的共享表单（绊线 =
    // disposeCalls）。旧 settingsScope 时代在这里 dispose 会让重挂后的卡片静默丢写入。
    assert.equal(trace.cleanups.length, 1);
    trace.cleanups[0]?.();
    assert.deepEqual(
      formTrace.disposeCalls,
      [],
      "disposer 不得销毁 provider 持有的共享表单（0.1.7 ConfigForm 契约无 dispose）",
    );
    // 「折叠 → 再声明」：工厂重跑，拿回的仍是同一张长活表单，写入照常落盘。
    const [redeploy] = trace.slotFactories;
    assert.ok(redeploy, "slots.inject 登记了可重跑的工厂");
    const cleanupAgain = redeploy();
    assert.equal(typeof cleanupAgain, "function", "重跑仍交回注销函数");
    const revived = trace.payload as CardPayload;
    await revived.set("defaultEmbedding", "local/revived");
    assert.deepEqual(
      formTrace.setCalls,
      [
        ["defaultLimit", 7],
        ["defaultEmbedding", "local/revived"],
      ],
      "重挂后的卡片必须仍能写入（表单没被 disposer 打死）",
    );
    assert.deepEqual(formTrace.disposeCalls, [], "重跑路径同样不 dispose 共享表单");
    // 官方第五位 mutate（批量原子写）在本卡的面包路上一次都不该出现：写入始终逐字段
    // 走 set/unset。这根绊线钉住「卡片没绕过自己的 set/unset 轨迹去批量写」。
    assert.deepEqual(formTrace.mutateCalls, [], "本卡不用批量写，mutate 只是官方面的一员");
  });

  it("传输失败（ConfigForm.set/unset 唯一会 reject 的一种）：字段级 console.error 后上抛，由卡片 save() 收口成 saveFailed", async () => {
    const formTrace: FormTrace = {
      setCalls: [],
      unsetCalls: [],
      disposeCalls: [],
      mutateCalls: [],
    };
    const form = fakeForm(formTrace, { fail: true });
    const { apply } = await loadClientExports();
    const { ctx, trace } = makeHost(form);
    apply(ctx);
    const payload = trace.payload as CardPayload;
    const { error: original } = console;
    const seen: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      seen.push(args);
    };
    let setThrew = false;
    let unsetThrew = false;
    try {
      // 上抛 = 卡片 save() 的 Promise.all 被拒 → saveFailed{reason}（用户看得到失败）；
      // 字段级 console.error 保留（排查要 field 名）。
      await payload.set("grepBudgetPerSearch", 5).catch(() => {
        setThrew = true;
      });
      await payload.unset("unlockWindowMin").catch(() => {
        unsetThrew = true;
      });
    } finally {
      console.error = original;
    }
    assert.equal(setThrew, true, "set 传输失败必须上抛给卡片（不得吞成假成功）");
    assert.equal(unsetThrew, true, "unset 传输失败必须上抛给卡片");
    assert.equal(seen.length, 2, "两次失败各打一条 console.error");
    assert.match(String(seen[0]?.[0]), /set grepBudgetPerSearch failed/u);
    assert.match(String(seen[1]?.[0]), /unset unlockWindowMin failed/u);
    assert.deepEqual(formTrace.disposeCalls, [], "失败路径也不许 dispose 共享表单");
  });

  it("apply 把两语字典注册进官方 locale，卡片 translator 随偏好切换", async () => {
    const { apply } = await loadClientExports();
    const formTrace: FormTrace = {
      setCalls: [],
      unsetCalls: [],
      disposeCalls: [],
      mutateCalls: [],
    };
    const { ctx, trace: host, language } = makeHost(fakeForm(formTrace));
    apply(ctx);
    const { effects, dicts } = host;
    // 样式 effect 只登记不执行（没有 document）；locale 字典 effect 必须可回收。
    const localeEffect = effects.find(
      (entry) => entry.label === "zvec-grep-card: locale dictionaries",
    );
    assert.ok(localeEffect, "locale 字典 effect 在位");
    const dispose = localeEffect.factory();
    assert.deepEqual(
      dicts.map((row) => [row.ns, Object.keys(row.dicts)]),
      [["zvec-grep", ["zh", "en"]]],
      "两语字典都注册到官方 locale（ns 即设置命名空间），且只注册一次——官方类型化重载" +
        "要求一次交齐全部内置 locale",
    );
    assert.equal(dicts[0]?.dicts.zh.cardTitle, UI_MESSAGES.zh.cardTitle);
    assert.equal(dicts[0].dicts.en.cardTitle, UI_MESSAGES.en.cardTitle);
    assert.equal(typeof dispose, "function", "注册可回收（随 effect 卸载）");
    dispose?.();
    assert.deepEqual(dicts, [], "一个 disposer 撤掉这一次调用登记的两语");
    // 卡片拿到的 t 来自 bind：语言变了，同一个 t 就换一份字典。
    // payload 只在 register 的回调里赋值，tsc 的控制流分析会把它锁在初始的 null，
    // 这里显式回广成声明类型再取 inject payload。
    const injected = host.payload as Record<string, unknown> | null;
    const t = injected?.["t"] as Translate;
    assert.equal(t("cardTitle"), UI_MESSAGES.zh.cardTitle, "中文那份");
    language.active = "en";
    assert.equal(t("cardTitle"), UI_MESSAGES.en.cardTitle, "切语言不必重挂卡片");
  });
});
