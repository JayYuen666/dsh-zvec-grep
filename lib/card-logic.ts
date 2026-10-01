// lib/card-logic.ts —— 设置卡片的 DOM-free 纯逻辑：cardStore 快照缓存 +
// 草稿取值（touched 覆盖已提交快照；两层怎么读的原语在 lib/card-draft.ts）+
// limit 输入校验 + 重建轮询应答解析 +
// fetch 应答体检。可被 host 侧单测直接 import（不经过含 document 的
// src/client-entry.ts，避免把 DOM 类型拖进 host typecheck）。client-entry
// 只做 React 渲染与 scope 绑定，取值/判定一律下沉到这里，卡片侧不留副本。
//
// 文案双语：本文件产出的提示文本走官方 locale 的 translator（ctx.locale.bind 的
// 结果），由调用点注入——纯函数不读设置、也不 import src/（键在此收窄成
// CardTextKey，字典本体与全部 UI 文案在 src/ui-messages.ts）。

import type { ConfigPageForm } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type { ConfigForm, ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
// 草稿优先的读判据（draftOf / numberText）住在 lib/card-draft.ts；本文件的 draftFields
// 只管「六个字段各显示什么」。
import { draftOf, numberText } from "./card-draft.ts";
import { DEFAULT_EMBEDDING } from "./embedding-catalog.ts";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/**
 * 本文件用到的 UI 文案键（字典在 src/ui-messages.ts：漏一个键或名字打错，
 * client-entry 里把 Translate 传给 CardText 的位置就会在编译期红）。
 */
export type CardTextKey =
  | "limitInvalid"
  | "limitClamped"
  | "rebuildRunning"
  | "rebuildKilled"
  | "rebuildFailed"
  | "rebuildExitCode"
  | "httpForbidden"
  | "httpFailed"
  | "httpNotJson"
  | "contentTypeMissing";

/**
 * 取文案函数：官方 `ctx.locale.bind(ns)` 返回的 Translate 的子集（结构声明，
 * 与 src/ui-messages.ts 同源；键更窄、参数更宽的一侧才接得进来）。params 收到
 * 的是本包自己填的标量，故比官方形状收紧一档。
 */
export type CardText = (
  key: CardTextKey,
  params?: Record<string, string | number | null>,
) => string;

/**
 * 卡片读写的配置面 = dsh 0.1.7 的客户端 **config form**，直接取官方声明
 * `@deepseek-ai/dsh-client-ui-settings/client` 的 `ConfigForm<T>`（`getSnapshot` /
 * `subscribe` / `mutate` / `set` / `unset` 五成员全必选），不再手抄一份投影。
 * 名字仍叫 SettingScope，只是历史沿革：client-entry 与 test/card-logic.ts 共用这一个
 * 类型源，改名不带来任何约束，只会多一处要同步的标识。
 * 原先这里抄的是 `getSnapshot: () => unknown` 外加缺 `mutate` 的四成员面——那份
 * `unknown` 才是 cardStore 里逐字段再解析（`isRecord(snap) ? snap["status"] : …`）
 * 存在的唯一理由；绑回官方后快照的 status/writable/value 由 provider 的 decode/derive
 * 把住，那个解析器就只剩把类型错误咽回去的作用，故一并删除。
 * 读面与旧的 `settingsScope` 同名，故卡片侧的降级逻辑原样可用。
 * ⚠ 旧 `ctx.settingsScope.bind({ namespace })` 连同 `settingsScope` 服务已被宿主移除
 * （installed 全树零命中），入口是 `ctx.configForms.get(entryId)`（installed
 * `.../client/config-form.d.ts:142`），见 src/client-entry.ts。
 * ⚠ `set`/`unset`/`mutate` 的受理位（true = 宿主受理，false = 拒绝或被跳过，只有
 * 传输失败才 reject）本包刻意思不消费，见 src/client-entry.ts 的 `writeField`。
 * ⚠ 消费者面上没有 dispose：`configForms.get(entryId)` 交回的是 provider 自己持有的
 * 那张共享表单（installed `.../client/config-form.d.ts:138-142` "The entry's form,
 * owned by this provider"；provider 在自己的 teardown 里统一销毁全部表单，installed
 * `dsh-client-ui-settings/lib/client.js:1290-1293`），`ConfigForm` 面上根本没有
 * dispose 可消费。slot「折叠 → 再声明」会重跑注册工厂并拿回同一张长活表单，所以
 * disposer 只需注销那次声明（见 src/client-entry.ts 的 disposer 注释）；卡片若试图销毁
 * 共享表单，受害的是同一 provider 名下所有消费者（含本卡重挂后的新 store）。
 */
export type SettingScope = ConfigForm<Record<string, unknown>>;

/**
 * 官方快照的简写（本条目那张表单的值面是任意 JSON 形状，由 host 的 Config 把关）。
 * 不外露：它只是 cardStore 缓存位上的记号，测试要同一个形状就在自己这边按官方类型抄一份
 * （见 test/build-client.test.ts 的同形做法）——共用这个别名等于让别名自己给自己作证。
 */
type FormSnapshot = ConfigFormSnapshot<Record<string, unknown>>;

/**
 * 本卡自己的渲染视模型（官方快照的有用子集 + 兜底值）。
 * `status` 与 `writable` 两位**不**再手写联合：它们取自属主包交给配置页的那份官方状态
 * （`ConfigPageForm['state']`，installed `dsh-client-ui-plugin-manager/lib/types/client/
 * slot-contract.d.ts:150-155`，其类型本身就是官方
 * `ConfigFormSnapshot<Record<string, unknown>>` 的再投影）。宿主把 status 的取值域或
 * writable 的必选性一改，这一位当场红（原来抄的是 `status: "loading" | "ready" |
 * "unavailable"` + `writable: boolean`，改了就悄悄漂移）。
 * 两者都满足才允许写，故保持**必选**，不用可选位假装它们会缺；`value` 是本卡的兜底
 * 收窄（官方 `value: T | undefined` → 首个快照受理前落成空对象供渲染）。
 * ⚠ 顶部那条 `import type { ConfigPageForm }` 同时是把 plugin-manager 的
 * `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap }` 载入本 program
 * 的入口：src/client-entry.ts 的 `ctx.slots.inject("plugins.bundle.config", …)` 编译得过，
 * 靠的就是这里（属主契约原文：installed slot-contract.d.ts:96-104「A bundle's own
 * configuration, **keyed by the bundle's package name**」→ `key` 必填）。
 */
export interface CardSnapshot extends Pick<ConfigPageForm["state"], "status" | "writable"> {
  value: Record<string, unknown>;
}

/**
 * 把 settings scope 桥成 { getSnapshot, subscribe } store。
 * 缓存必须 per-scope（闭包内）：模块全局会在多 scope 交错 getSnapshot 时互相
 * 冲 memo，导致 useSyncExternalStore 每次拿到新引用 → 无限重渲染。
 */
export function cardStore(scope: SettingScope): {
  getSnapshot: () => CardSnapshot;
  subscribe: (listener: () => void) => () => void;
} {
  const EMPTY_SNAPSHOT: CardSnapshot = { status: "loading", writable: false, value: {} };
  let cachedSnap: FormSnapshot | null = null;
  // 初值直接就是空快照：getSnapshot 首次调用必落进下面的重算分支，所以返回处再兜一次
  // `?? EMPTY_SNAPSHOT` 是不可达分支（100% 分支门禁下永远缺一口），改成初始化的写法。
  let cachedView: CardSnapshot = EMPTY_SNAPSHOT;
  return {
    getSnapshot() {
      const snap = scope.getSnapshot();
      if (snap !== cachedSnap) {
        cachedSnap = snap;
        // 直接读官方成员：status/writable 必选，只有 value 在首个快照受理前真的是
        // undefined（官方契约），那一态就是卡片要渲染的「还没数据」→ 落到空对象。
        cachedView = {
          status: snap.status,
          writable: snap.writable,
          value: snap.value ?? {},
        };
      }
      return cachedView;
    },
    subscribe(listener) {
      return scope.subscribe(listener);
    },
  };
}

// ── 草稿取值（受控输入的单一真值来源）──────────────────────────────────────
// 卡片是「先暂存、点保存才写入」的草稿模型：touched 是草稿层，快照 value 是
// 已提交层。任何控件若直接绑已提交快照，用户敲的键会被受控组件立刻吞掉
// （input 改不动、select 弹回旧值），而旁边几个字段却是草稿值——同一张卡两种
// 行为，用户只能以为「这个设置改了没用」。故六个字段一律走 draftFields()。

/** 卡片六个字段的显示值（全部草稿优先）。 */
export interface CardFields {
  embedding: string;
  limitDisplay: string;
  hfEndpoint: string;
  enforceSearchFirst: boolean;
  grepBudget: string;
  unlockWindow: string;
}

const DEFAULT_LIMIT_TEXT = "10";
const DEFAULT_BUDGET_TEXT = "3";
const DEFAULT_WINDOW_TEXT = "10";

/** 六个字段的草稿显示值（ZgCard 只渲染这里算出来的东西）。 */
export function draftFields(
  touched: Record<string, unknown>,
  value: Record<string, unknown>,
): CardFields {
  const embedding = draftOf(touched, value, "defaultEmbedding");
  const endpoint = draftOf(touched, value, "hfEndpoint");
  const enforce = draftOf(touched, value, "enforceSearchFirst");
  // defaultLimit 清空 = 草稿里显式 undefined（待 unset 回默认），显示空串；
  // 而「用户从没动过、快照里也没有」不是清空，显示默认文案。
  const limitDraft = draftOf(touched, value, "defaultLimit");
  let limitDisplay = numberText(limitDraft, DEFAULT_LIMIT_TEXT);
  if (limitDraft === undefined) {
    limitDisplay = "defaultLimit" in touched ? "" : DEFAULT_LIMIT_TEXT;
  }
  return {
    embedding:
      typeof embedding === "string" && embedding.length > 0 ? embedding : DEFAULT_EMBEDDING,
    limitDisplay,
    hfEndpoint: typeof endpoint === "string" ? endpoint : "",
    enforceSearchFirst: enforce !== false,
    grepBudget: numberText(draftOf(touched, value, "grepBudgetPerSearch"), DEFAULT_BUDGET_TEXT),
    unlockWindow: numberText(draftOf(touched, value, "unlockWindowMin"), DEFAULT_WINDOW_TEXT),
  };
}

// ── limit 输入校验 ─────────────────────────────────────────────────────────
// type=number 的受控 input：非法/清空的击键若静默丢弃，用户得不到任何反馈。
// 空 → empty（草稿写 undefined，保存时 unset 回 base 默认）；
// 越界整数 → clamped（钳到 1-50 并提示）；其它 → invalid（提示，不写草稿）。

const LIMIT_MIN = 1;
const LIMIT_MAX = 50;

export type LimitResolution =
  | { kind: "valid"; value: number }
  | { kind: "empty" }
  | { kind: "clamped"; value: number; hint: string }
  | { kind: "invalid"; hint: string };

export function resolveLimitInput(raw: string, t: CardText): LimitResolution {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: "empty" };
  }
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num)) {
    return { kind: "invalid", hint: t("limitInvalid", { min: LIMIT_MIN, max: LIMIT_MAX }) };
  }
  if (num < LIMIT_MIN) {
    return {
      kind: "clamped",
      value: LIMIT_MIN,
      hint: t("limitClamped", { min: LIMIT_MIN, max: LIMIT_MAX, value: LIMIT_MIN }),
    };
  }
  if (num > LIMIT_MAX) {
    return {
      kind: "clamped",
      value: LIMIT_MAX,
      hint: t("limitClamped", { min: LIMIT_MIN, max: LIMIT_MAX, value: LIMIT_MAX }),
    };
  }
  return { kind: "valid", value: num };
}

/**
 * limit 击键 → 草稿层该写什么（保存仍由保存条统一驱动）。
 * invalid 不改草稿、只回提示；empty 写 undefined（=待 unset）；valid/clamped 写数值。
 */
export interface LimitDraft {
  draft: unknown;
  error: string | null;
}

export function limitDraftOf(raw: string, t: CardText): LimitDraft {
  const resolution = resolveLimitInput(raw, t);
  if (resolution.kind === "invalid") {
    return { draft: undefined, error: resolution.hint };
  }
  if (resolution.kind === "empty") {
    return { draft: undefined, error: null };
  }
  return { draft: resolution.value, error: null };
}

// ── 重建端点应答解析 ───────────────────────────────────────────────────────

export type RebuildPhase = "running" | "done" | "error";

export interface RebuildPoll {
  phase: RebuildPhase;
  output: string;
}

/**
 * 轮询应答 → 卡片状态。
 * 关键：harness 的 bash-local 对**任何自然退出**都置 `status:'completed'`
 * （packages/shell/bash-local/src/index.ts:308 只在信号终止/调用方 abort 时给
 * 'killed'），exit 127「zg 没装」也是 completed。只看 status 会把失败显示成
 * 「重建完成」，故成功判据 = completed 且 exit 0。
 * 状态词现取自官方作业注册表（ctx.jobs），比原先的进程态多两枚：
 *  - `stopping`：取消已发出、进程还没收完 ⇒ 仍在跑，绝不能渲染成失败；
 *  - `failed`：注册表侧判定失败（生产者的 done 被拒、或收尾抛错），此时没有退出码可读。
 */
export function parseRebuildPoll(body: Record<string, unknown>, t: CardText): RebuildPoll {
  const { status, exitCode, output } = body;
  const outputText = typeof output === "string" ? output : "";
  if (status === "running" || status === "stopping") {
    return {
      phase: "running",
      output: outputText.length > 0 ? outputText : t("rebuildRunning"),
    };
  }
  if (status === "completed" && exitCode === 0) {
    return { phase: "done", output: outputText };
  }
  let reason: string;
  if (status === "killed") {
    reason = t("rebuildKilled");
  } else if (status === "failed") {
    reason = t("rebuildFailed");
  } else {
    reason = t("rebuildExitCode", { exitCode: String(exitCode) });
  }
  return { phase: "error", output: outputText.length > 0 ? `${reason}\n${outputText}` : reason };
}

// ── fetch 应答体检 ─────────────────────────────────────────────────────────
// 端点没注册上（webServer 未起、路径改动、被上游 SPA fallback 兜住）时，
// fetch 拿到的是 200 + text/html 的 index.html：直接 JSON.parse 只会给用户
// 一句 `SyntaxError: Unexpected token '<'`。这里先体检再解析。

/**
 * 响应不健康的可行动描述；健康返回 null。
 * @param ok - res.ok
 * @param status - res.status（403 单列：CSRF token 过期时卡片要「重取 token 重试」）
 * @param contentType - res.headers.get('content-type') ?? ''
 * @param t - 文案取值（官方 locale 的 translator）
 */
export function httpProblem(
  ok: boolean,
  status: number,
  contentType: string,
  t: CardText,
): string | null {
  if (status === 403) {
    return t("httpForbidden");
  }
  if (!ok) {
    return t("httpFailed", { status });
  }
  if (!contentType.toLowerCase().includes("application/json")) {
    return t("httpNotJson", {
      contentType: contentType.length > 0 ? contentType : t("contentTypeMissing"),
    });
  }
  return null;
}

/** JSON 文本 → 对象；非对象/解析失败返回 null（调用方给可读错误）。 */
export function parseJsonRecord(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

/** 端点统一应答形状：`{ ok: true, … }` 才算成功。 */
export function isOkBody(body: Record<string, unknown>): boolean {
  return body["ok"] === true;
}
