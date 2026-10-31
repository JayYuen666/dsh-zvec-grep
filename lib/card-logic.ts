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
import { z } from "zod";
// 草稿优先的读判据（draftOf / numberText）住在 lib/card-draft.ts；本文件的 draftFields
// 只管「六个字段各显示什么」。
import { draftOf, hasDraft, numberText } from "./card-draft.ts";
import { DEFAULT_EMBEDDING } from "./embedding-catalog.ts";
// 数值区间单源：显示文案与钳制区间引同一份常量（host schema 与输入区间同源，见该文件头）。
import {
  BUDGET_MAX,
  DEFAULT_GREP_BUDGET,
  DEFAULT_LIMIT,
  DEFAULT_UNLOCK_WINDOW_MIN,
  LIMIT_MAX,
  LIMIT_MIN,
  WINDOW_MAX,
} from "./limits.ts";

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
  | "rebuildExitUnknown";

/**
 * 引导端点交回的守护进程就绪态该显示哪一行。
 *
 * `undefined` 是**必要**的一臂，不是兜底：旧版 host 的应答里没有 `serverReady` 这个字段，
 * 而「应答里没写」与「写了未就绪」是两件事——把前者显示成后者，卡片就在用户眼前谎称了一次
 * 「没有守护进程」。判据收在可单测的这一层，client 只负责渲染它选出来的那一行。
 */
export function daemonNoteKey(
  ready: boolean | undefined,
): "daemonReadyNote" | "daemonOfflineNote" | undefined {
  let key: "daemonReadyNote" | "daemonOfflineNote" | undefined;
  if (ready === true) {
    key = "daemonReadyNote";
  } else if (ready === false) {
    key = "daemonOfflineNote";
  }
  // 单一出口：`ready` 既不是 true 也不是 false（= undefined，应答里没这一位）时留空，
  // 调用方据此**不渲染**，而不是把「不知道」显示成「未就绪」。
  return key;
}

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
 * `.../client/config-form.d.ts`），见 src/client-entry.ts。
 * ⚠ `set`/`unset`/`mutate` 的受理位（true = 宿主受理，false = 拒绝或被跳过，只有
 * 传输失败才 reject）本包刻意思不消费，见 src/client-entry.ts 的 `writeField`。
 * ⚠ 消费者面上没有 dispose：`configForms.get(entryId)` 交回的是 provider 自己持有的
 * 那张共享表单（installed `.../client/config-form.d.ts` "The entry's form,
 * owned by this provider"；provider 在自己的 teardown 里统一销毁全部表单，installed
 * `Promise.all([...this.forms.values()].map((form) => form.dispose()))`），`ConfigForm` 面上根本没有
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
 * slot-contract.d.ts`，其类型本身就是官方
 * `ConfigFormSnapshot<Record<string, unknown>>` 的再投影）。宿主把 status 的取值域或
 * writable 的必选性一改，这一位当场红（原来抄的是 `status: "loading" | "ready" |
 * "unavailable"` + `writable: boolean`，改了就悄悄漂移）。
 * 两者都满足才允许写，故保持**必选**，不用可选位假装它们会缺；`value` 是本卡的兜底
 * 收窄（官方 `value: T | undefined` → 首个快照受理前落成空对象供渲染）。
 * ⚠ 顶部那条 `import type { ConfigPageForm }` 同时是把 plugin-manager 的
 * `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap }` 载入本 program
 * 的入口：src/client-entry.ts 的 `ctx.slots.inject("plugins.bundle.config", …)` 编译得过，
 * 靠的就是这里（属主契约原文：installed slot-contract.d.ts「A bundle's own
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

/**
 * 三个数值字段的显示值都是「草稿优先 + 默认文案」，且共享同一条清空语义：
 * touched 里显式写了 undefined（用户清空输入）= 待 unset，显示空串；「从没动过、
 * 快照里也没有」不是清空，显示默认文案。判据统一收在这里，与卡片数值控件
 * （numberDisplay / NumberField）的「清空即回『未填』」对齐。
 */
function numericFieldDisplay(
  touched: Record<string, unknown>,
  value: Record<string, unknown>,
  field: string,
  fallback: string,
): string {
  const draft = draftOf(touched, value, field);
  if (draft === undefined) {
    return hasDraft(touched, field) ? "" : fallback;
  }
  return numberText(draft, fallback);
}

/** 已提交端点值只收 HTTP(S)；坏文本显示成空（输入框里键入的草稿不走这条过滤）。 */
const HTTP_URL_SCHEMA = z.url({ protocol: /^https?$/u });

/**
 * 端点字段的显示值：**草稿优先**，与三个数值字段同一条清空语义。
 *
 * 用户正在逐字键入时，草稿是「这一格此刻的文本」而不是待校验的值——半截 URL
 * 必须原样回显，否则输入第一个字符就被过滤成空串、删掉已提交 URL 的一个字符就整格清空。
 * 只有「这一格没动过、显示的是已提交快照」时才过 HTTP(S) 形态过滤：脏快照不该显示成
 * 一个看起来能保存的地址。
 */
function endpointFieldDisplay(
  touched: Record<string, unknown>,
  value: Record<string, unknown>,
): string {
  if (Object.hasOwn(touched, "hfEndpoint")) {
    const draft: unknown = touched["hfEndpoint"];
    return typeof draft === "string" ? draft : "";
  }
  const committed: unknown = value["hfEndpoint"];
  return typeof committed === "string" && HTTP_URL_SCHEMA.safeParse(committed).success
    ? committed
    : "";
}

/** 六个字段的草稿显示值（ZgCard 只渲染这里算出来的东西）。 */
export function draftFields(
  touched: Record<string, unknown>,
  value: Record<string, unknown>,
): CardFields {
  const embedding = draftOf(touched, value, "defaultEmbedding");
  const enforce = draftOf(touched, value, "enforceSearchFirst");
  return {
    embedding:
      typeof embedding === "string" && embedding.length > 0 ? embedding : DEFAULT_EMBEDDING,
    limitDisplay: numericFieldDisplay(touched, value, "defaultLimit", String(DEFAULT_LIMIT)),
    hfEndpoint: endpointFieldDisplay(touched, value),
    enforceSearchFirst: enforce !== false,
    grepBudget: numericFieldDisplay(
      touched,
      value,
      "grepBudgetPerSearch",
      String(DEFAULT_GREP_BUDGET),
    ),
    unlockWindow: numericFieldDisplay(
      touched,
      value,
      "unlockWindowMin",
      String(DEFAULT_UNLOCK_WINDOW_MIN),
    ),
  };
}

// ── 数值字段的 zod 域 ──────────────────────────────────────────────────────
// 三个数值字段的区间与默认值同源在 lib/limits.ts；host schema 与卡片显示共用这三个域。

export const LIMIT_SCHEMA = z.int().min(LIMIT_MIN).max(LIMIT_MAX);
export const BUDGET_SCHEMA = z.int().min(LIMIT_MIN).max(BUDGET_MAX);
export const WINDOW_SCHEMA = z.int().min(LIMIT_MIN).max(WINDOW_MAX);

// ── 重建端点应答解析 ───────────────────────────────────────────────────────

export type RebuildPhase = "running" | "done" | "error";

export interface RebuildPoll {
  phase: RebuildPhase;
  output: string;
}

/** 轮询应答的宽容形状：未知状态、非数字退出码、非字符串输出都折成缺位，
 *  下游文案只按“缺位”兜底，不把坏类型带到渲染期。 */
const REBUILD_STATUSES = ["running", "stopping", "completed", "killed", "failed"] as const;
const REBUILD_POLL_SCHEMA = z.object({
  status: z.preprocess(
    (value) =>
      typeof value === "string" && REBUILD_STATUSES.some((status) => status === value)
        ? value
        : undefined,
    z.enum(REBUILD_STATUSES).optional(),
  ),
  exitCode: z.preprocess(
    (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined),
    z.number().optional(),
  ),
  output: z.preprocess(
    (value) => (typeof value === "string" ? value : undefined),
    z.string().optional(),
  ),
});

/**
 * 轮询应答 → 卡片状态。
 * 关键：harness 的 bash-local 对**任何自然退出**都置 `status:'completed'`
 * （packages/shell/bash-local/src/index.ts 给 `proc.status` 的那一分支：只在信号终止/调用方 abort 时给
 * 'killed'），exit 127「zg 没装」也是 completed。只看 status 会把失败显示成
 * 「重建完成」，故成功判据 = completed 且 exit 0。
 * 状态词现取自官方作业注册表（ctx.jobs），比原先的进程态多两枚：
 *  - `stopping`：取消已发出、进程还没收完 ⇒ 仍在跑，绝不能渲染成失败；
 *  - `failed`：注册表侧判定失败（生产者的 done 被拒、或收尾抛错），此时没有退出码可读。
 */
export function parseRebuildPoll(body: Record<string, unknown>, t: CardText): RebuildPoll {
  const parsed = REBUILD_POLL_SCHEMA.safeParse(body);
  const { status, exitCode, output } = parsed.success ? parsed.data : {};
  const outputText = output ?? "";
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
  } else if (typeof exitCode === "number" && Number.isFinite(exitCode)) {
    reason = t("rebuildExitCode", { exitCode });
  } else {
    // status 是旧 host/畸形应答里的未知词（或缺席）且没有可读的退出码：拼
    // 「退出码 undefined」这类文案只会误导排查，回落到通用失败文案。
    reason = t("rebuildExitUnknown");
  }
  return { phase: "error", output: outputText.length > 0 ? `${reason}\n${outputText}` : reason };
}
