// Client half of the zvec-grep settings card（TS 源码，build-client.mjs 打包）。
// React 由模块系统 require('react') 提供（rolldown external）；只用 createElement。
// 卡片注册进 keyed plugins.bundle.config 槽的 **bundle 包名**键（`@jayyuen66/dsh-zvec-grep`，
// 见 BUNDLE_PKG），读写走 ctx.configForms.get('zvec-grep')——0.1.7 起 settings 命名空间
// 就是 profile 条目 id（host.ts 只导出带 .volatile() 字段的 Config，不再 register），
// 两侧同一个 id 即同源；
// <select> 候选来自 lib/embedding-catalog.ts（单一数据源）。
// 「工作区重建」：先从 host 的 rebuild-roots 引导端点取 CSRF token + 可选工作区，
// 再 POST /_dsh/zvec-grep/rebuild（带 x-zvec-grep-csrf 头），轮询
// /_dsh/zvec-grep/rebuild-status 直到后台进程结束。
// 取值/判定逻辑全部在 lib/card-logic.ts（草稿、终态判据、应答体检），本文件只渲染。
//
// 界面文案双语：apply 里把 src/ui-messages.ts 的两语字典注册进官方
// @deepseek-ai/dsh-client-locale（ctx.locale.register + bind），translator 以 `t`
// 随 slots.register 的 inject payload 下发给卡片；切语言由宿主重渲染槽位，无需重载页面。
//
// 元素树用中间变量 + 抽 helper 逐层构造（避免 createElement 深层嵌套触发
// unicorn/max-nested-calls 与 max-statements/complexity）；网络回调统一
// async/await + try/catch，避免 then/catch 链回调（promise/prefer-await-to-callbacks）。

import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";
import type { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/client";
import { LOCAL_EMBEDDINGS } from "../lib/embedding-catalog.ts";
import type { LocalEmbeddingBackend } from "../lib/embedding-catalog.ts";
import {
  cardStore,
  draftFields,
  httpProblem,
  isOkBody,
  limitDraftOf,
  parseJsonRecord,
  parseRebuildPoll,
} from "../lib/card-logic.ts";
import type { CardFields, CardSnapshot, SettingScope } from "../lib/card-logic.ts";
import { UI_MESSAGES } from "./ui-messages.ts";
import type { LocaleNs, Translate, UiMessages } from "./ui-messages.ts";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";

export { cardStore, draftFields, parseRebuildPoll, resolveLimitInput } from "../lib/card-logic.ts";

const NS: LocaleNs = "zvec-grep";
/**
 * `plugins.bundle.config` 的 key = **bundle 的 npm 包名**（不是裸条目 id）。
 * 派发证据（installed dsh 0.1.7）：
 *   · dsh-client-ui-plugin-manager/lib/client.js:1821 `renderSlot("plugins.bundle.config",
 *     { view: "page" }, { entryKey: pkg.name })`——pkg.name 是 bundle 包名；
 *   · 同文件 :2698 `configured: ledger.bundles.has(openPkg.name)`，:306/:320 的
 *     `packageView()` 里 `name: bundle.name`（= bundle 包），所以没有第二条可匹配的 key；
 *   · 同包 lib/types/client/slot-contract.d.ts:96-100「A bundle's own configuration,
 *     **keyed by the bundle's package name**」，且 kind 为 `keyed` → `key` 必填；
 *   · dsh-client-ui-renderer/lib/client.js:1154 逐字相等匹配 `entry.options.key === entryKey`，
 *     错一个字符就是「整张卡不渲染」（不是回落、不是报错）；
 *   · 官方占位者 dsh-experimental-client-ui-voice-input/lib/client.js:5659-5661 同样把
 *     key 写成包名 `@deepseek-ai/dsh-experimental-voice-input-bundle`。
 * 行槽（本包未用）则是 `<pkg>#<rowId>`（plugin-manager/lib/client.js:27-28 `rowConfigKey`）。
 * 值 = 本包 package.json 的 name，且必须出现在 profile 的 `dsh.profile.bundles` 里；
 * test/build-client.test.ts 从 `~/.dsh/profiles/web/package.json` 解析校验，不在此处硬抄。
 * 设置命名空间**不跟着改**：`ctx.configForms.get(entryId)` 仍吃裸条目 id（见 apply）。
 */
const BUNDLE_PKG = "@jayyuen66/dsh-zvec-grep";
const REBUILD_ROOTS_URL = "/_dsh/zvec-grep/rebuild-roots";
const REBUILD_URL = "/_dsh/zvec-grep/rebuild";
const REBUILD_STATUS_URL = "/_dsh/zvec-grep/rebuild-status";
/** 与 host.ts REBUILD_CSRF_HEADER 一致：动作端点要求回填这个头。 */
const REBUILD_CSRF_HEADER = "x-zvec-grep-csrf";
/** 重建轮询间隔（宿主后台进程，2s 足够跟上 zg 的进度输出）。 */
const REBUILD_POLL_MS = 2000;
/** 解锁配额/时效的合法上限（与 host Config 的 schema 同范围，输入框与提示共用）。 */
const BUDGET_MAX = 20;
const WINDOW_MAX = 240;

const CARD_CSS = [
  ".zgc-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
  ".zgc-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
  ".zgc-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
  ".zgc-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
  ".zgc-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
  ".zgc-card-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
  ".zgc-card-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
  ".zgc-card-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
  ".zgc-card-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
  ".zgc-card-chevron-open{transform:rotate(180deg)}",
  ".zgc-card-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:8px 0 12px}",
  ".zgc-row{display:flex;flex-direction:column;gap:6px;padding:9px 0}",
  ".zgc-label{font-size:13px;color:var(--dsw-alias-label-primary,inherit)}",
  ".zgc-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99)}",
  ".zgc-select{width:100%;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-fill-primary,transparent);border:1px solid var(--dsw-alias-border-l3,#d8dbe2);border-radius:6px;padding:6px 8px;box-sizing:border-box}",
  ".zgc-input{width:100%;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-fill-primary,transparent);border:1px solid var(--dsw-alias-border-l3,#d8dbe2);border-radius:6px;padding:6px 8px;box-sizing:border-box}",
  ".zgc-button{appearance:none;border:1px solid var(--dsw-alias-brand-primary,#2f6fed);color:var(--dsw-alias-brand-primary,#2f6fed);background:transparent;border-radius:6px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}",
  ".zgc-button:hover:not(:disabled){background:var(--dsw-alias-fill-secondary,rgba(0,0,0,.05))}",
  ".zgc-button:disabled{opacity:.5;cursor:progress}",
  ".zgc-output{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit);white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto;background:var(--dsw-alias-fill-primary,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px}",
  ".zgc-error{font-size:12px;color:var(--dsw-alias-text-danger,#d33)}",
  // 保存条（改动先暂存，点「保存」才写入生效；「撤销」丢弃本地改动）
  ".zgc-savebar{display:flex;gap:8px;align-items:center;padding:10px 0 2px;border-top:1px dashed var(--dsw-alias-border-l2);margin-top:6px;flex-wrap:wrap}",
  ".zgc-btn-primary{appearance:none;border:1px solid var(--dsw-alias-brand-primary,#2f6fed);background:var(--dsw-alias-brand-primary,#2f6fed);color:var(--dsw-alias-label-primary-foreground,#fff);border-radius:6px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}",
  ".zgc-btn-plain{appearance:none;border:1px solid var(--dsw-alias-border-l2,#d8dbe2);background:transparent;color:var(--dsw-alias-label-primary,inherit);border-radius:6px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}",
  ".zgc-button:focus-visible,.zgc-btn-primary:focus-visible,.zgc-btn-plain:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6fed);outline-offset:1px}",
  ".zgc-btn-primary:hover:not(:disabled){filter:brightness(.96)}",
  ".zgc-btn-plain:hover:not(:disabled){background:var(--dsw-alias-fill-secondary,rgba(0,0,0,.05))}",
  ".zgc-btn-primary:disabled,.zgc-btn-plain:disabled{opacity:.5;cursor:not-allowed}",
  ".zgc-dirty{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99)}",
  ".zgc-saveerr{font-size:12px;color:var(--dsw-alias-text-danger,#d33)}",
].join("\n");

const BACKENDS: readonly LocalEmbeddingBackend[] = ["llama-cpp", "transformers-js", "model2vec"];

/** SVG path 的 data 属性键（id-length 豁免需经变量计算键表达，oxfmt 不解引号）。 */
const PATH_DATA_KEY = "d";

/** 重建 root 输入框的候选列表 id（与 <datalist> 配对）。 */
const ROOT_OPTIONS_ID = "zgc-rebuild-root-options";

/** 候选按后端分组，供 <optgroup> 使用（文案取自 UI 字典，这里只留键）。 */
const BACKEND_LABEL_KEY: Record<LocalEmbeddingBackend, keyof UiMessages> = {
  "llama-cpp": "backendLlamaCpp",
  "transformers-js": "backendTransformersJs",
  model2vec: "backendModel2Vec",
};

/** 取设置卡快照的配置值子对象（快照契约 {status, writable, value:{...}}）。
 *  独立函数保持字面量 `snap.value`（build-client.test 内容契约锁定该形态）。 */
function snapshotValue(snap: CardSnapshot): Record<string, unknown> {
  return snap.value;
}

interface PluginCardProps {
  title: string;
  description: string;
  children?: ReactNode;
}

function PluginCard(props: PluginCardProps): ReactNode {
  const { title, description, children } = props;
  const [open, setOpen] = useState(false);
  const headInner = createElement(
    "span",
    { className: "zgc-card-head" },
    createElement("span", { className: "zgc-card-name" }, title),
    createElement("span", { className: "zgc-card-desc" }, description),
  );
  const chevron = createElement(
    "svg",
    {
      width: 14,
      height: 14,
      viewBox: "0 0 14 14",
      "aria-hidden": true,
      className: open ? "zgc-card-chevron zgc-card-chevron-open" : "zgc-card-chevron",
    },
    createElement("path", {
      [PATH_DATA_KEY]: "M3 5l4 4 4-4",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.5,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    }),
  );
  const header = createElement(
    "button",
    {
      type: "button",
      className: "zgc-card-header",
      "aria-expanded": open,
      onClick: () => {
        setOpen(!open);
      },
    },
    headInner,
    chevron,
  );
  const body = open ? createElement("div", { className: "zgc-card-body" }, children) : null;
  return createElement(
    "li",
    { className: open ? "zgc-card zgc-card-open" : "zgc-card" },
    header,
    body,
  );
}

interface RebuildState {
  phase: "idle" | "running" | "done" | "error";
  output: string;
}

interface CardSlotProps {
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
  useCard: <Type>(selector: (snap: CardSnapshot) => Type) => Type;
  /**
   * 注入面由本文件自己构造（见 apply 的 writeField / unsetField）：0.1.7 的
   * `ConfigForm.set/unset` 回 Promise<boolean> 受理位（installed
   * config-form-types.d.ts:65 / :73；true=宿主受理，false=拒绝或写入被跳过，传输失败
   * 才 reject）——受理位**原样透传**给卡片，由 save() 消费（false → saveRejected 文案
   * 且不清 touched，fail-closed 不静默丢修改；reject → saveFailed）。unset 必带
   *（清空即回组合层 / schema 的 .default(...)）。
   */
  set: (field: string, value: unknown) => Promise<boolean>;
  unset: (field: string) => Promise<boolean>;
}

/** touched 层与快照的差异字段（值语义比较；undefined 与缺失等价）。 */
export function diffTouched(
  touched: Record<string, unknown>,
  value: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const key of Object.keys(touched)) {
    if (JSON.stringify(touched[key] ?? null) !== JSON.stringify(value[key] ?? null)) {
      out.push(key);
    }
  }
  return out;
}

/** 保存条（全自研插件统一）。 */
function SaveBar(props: {
  dirty: boolean;
  writable: boolean;
  busy: boolean;
  error: string | null;
  t: Translate;
  onSave: () => void;
  onDiscard: () => void;
}): ReactNode {
  const { t } = props;
  const disabled = !props.writable || props.busy;
  const saveBtn = createElement(
    "button",
    {
      type: "button",
      className: "zgc-btn-primary",
      "data-field": "save",
      disabled: disabled || !props.dirty,
      onClick: props.onSave,
    },
    props.busy ? t("saving") : t("save"),
  );
  const discardBtn = createElement(
    "button",
    {
      type: "button",
      className: "zgc-btn-plain",
      "data-field": "discard",
      disabled: disabled || !props.dirty,
      onClick: props.onDiscard,
    },
    t("revert"),
  );
  let statusNode: ReactNode;
  if (props.error !== null) {
    statusNode = createElement("span", { className: "zgc-saveerr" }, props.error);
  } else if (props.writable) {
    statusNode = createElement(
      "span",
      { className: "zgc-dirty" },
      props.dirty ? t("statusDirty") : t("statusClean"),
    );
  } else {
    statusNode = createElement("span", { className: "zgc-dirty" }, t("statusReadOnly"));
  }
  return createElement("div", { className: "zgc-savebar" }, saveBtn, discardBtn, statusNode);
}

/** ZgCard 主体所依赖的派生值 + 回调（供 buildCardBody 使用，规避过大函数体）。 */
interface CardDeps {
  /** 取文案（官方 ctx.locale.bind 的结果）。 */
  t: Translate;
  fields: CardFields;
  writable: boolean;
  /** 重建端点白名单候选（来自 rebuild-roots 引导端点）。 */
  roots: string[];
  root: string;
  rebuild: RebuildState;
  dirty: boolean;
  busy: boolean;
  saveError: string | null;
  setField: (field: string, draft: unknown) => void;
  setRoot: (root: string) => void;
  setSaveError: (err: string | null) => void;
  onSave: () => void;
  onDiscard: () => void;
  onRebuild: () => void;
}

/**
 * embedding 候选项文本（官方 locale 的 {name} 插值）。提成模块级函数是为了不把
 * t() 嵌进 createElement（unicorn/max-nested-calls 上限 3）。
 */
function modelOptionText(t: Translate, reference: string, dimension: number): string {
  return t("modelOption", { reference, dimension });
}

/** 重建行的整行提示（同上：把带插值的 t() 挪出 createElement）。 */
function rebuildHintText(t: Translate, embedding: string, hasRoots: boolean): string {
  return t("rebuildHint", {
    embedding,
    roots: t(hasRoots ? "rootsNoteWith" : "rootsNoteEmpty"),
  });
}

/** 数值输入的合法区间文案（同上：t() 不进 onChange 的三层嵌套）。 */
function rangeErrorText(t: Translate, key: "budgetInvalid" | "windowInvalid", max: number): string {
  return t(key, { min: 1, max });
}

/** embedding <select> 的分组候选（逐层构造，避免 createElement 深层嵌套）。 */
function buildOptionGroups(
  t: Translate,
  embeddingValue: string,
  writable: boolean,
  setField: (field: string, draft: unknown) => void,
): ReactNode[] {
  const groups: ReactNode[] = [];
  for (const backend of BACKENDS) {
    const options: ReactNode[] = [];
    for (const entry of LOCAL_EMBEDDINGS) {
      if (entry.backend === backend) {
        const { reference, dimension } = entry;
        options.push(
          createElement(
            "option",
            { key: reference, value: reference },
            modelOptionText(t, reference, dimension),
          ),
        );
      }
    }
    groups.push(
      createElement("optgroup", { key: backend, label: t(BACKEND_LABEL_KEY[backend]) }, options),
    );
  }
  return [
    createElement(
      "select",
      {
        className: "zgc-select",
        value: embeddingValue,
        disabled: !writable,
        onChange: (ev: { target: { value: string } }) => {
          setField("defaultEmbedding", ev.target.value);
        },
      },
      groups,
    ),
  ];
}

/** embedding 行：本地后端分组的 <select>（候选文本带维度插值）。 */
function buildEmbeddingRow(deps: CardDeps): ReactNode {
  const { fields, setField, t, writable } = deps;
  const embeddingLabel = createElement("div", { className: "zgc-label" }, t("embeddingLabel"));
  const embeddingHint = createElement("div", { className: "zgc-hint" }, t("embeddingHint"));
  const embeddingSelects = buildOptionGroups(t, fields.embedding, writable, setField);
  return createElement(
    "div",
    { className: "zgc-row" },
    embeddingLabel,
    embeddingHint,
    embeddingSelects[0],
  );
}

/** defaultLimit 行：数字输入，区间判定在 lib/card-logic.ts 的 limitDraftOf。 */
function buildLimitRow(deps: CardDeps): ReactNode {
  const { fields, setField, setSaveError, t, writable } = deps;
  const limitLabel = createElement("div", { className: "zgc-label" }, t("limitLabel"));
  const limitInput = createElement("input", {
    className: "zgc-input",
    type: "number",
    min: 1,
    max: 50,
    value: fields.limitDisplay,
    disabled: !writable,
    onChange: (ev: { target: { value: string } }) => {
      const draft = limitDraftOf(ev.target.value, t);
      setSaveError(draft.error);
      if (draft.error === null) {
        setField("defaultLimit", draft.draft);
      }
    },
  });
  return createElement("div", { className: "zgc-row" }, limitLabel, limitInput);
}

/** hfEndpoint 行：镜像基地址（占位符即 schema 默认的那枚镜像，留空走官方 HF）。 */
function buildEndpointRow(deps: CardDeps): ReactNode {
  const { fields, setField, t, writable } = deps;
  const endpointLabel = createElement("div", { className: "zgc-label" }, t("endpointLabel"));
  const endpointHint = createElement("div", { className: "zgc-hint" }, t("endpointHint"));
  const endpointInput = createElement("input", {
    className: "zgc-input",
    value: fields.hfEndpoint,
    placeholder: "https://modelscope.cn/models",
    disabled: !writable,
    onChange: (ev: { target: { value: string } }) => {
      setField("hfEndpoint", ev.target.value);
    },
  });
  return createElement("div", { className: "zgc-row" }, endpointLabel, endpointHint, endpointInput);
}

/** enforceSearchFirst 行：整行可点的勾选（只读时光标退回 default，与禁用态一致）。 */
function buildEnforceRow(deps: CardDeps): ReactNode {
  const { fields, setField, t, writable } = deps;
  const enforceCheckbox = createElement("input", {
    type: "checkbox",
    checked: fields.enforceSearchFirst,
    disabled: !writable,
    onChange: (ev: { target: { checked: boolean } }) => {
      setField("enforceSearchFirst", ev.target.checked);
    },
  });
  const enforceText = createElement("span", { className: "zgc-label" }, t("enforceLabel"));
  const enforceInner = createElement(
    "label",
    {
      style: {
        display: "flex",
        gap: "8px",
        alignItems: "center",
        cursor: writable ? "pointer" : "default",
      },
    },
    enforceCheckbox,
    enforceText,
  );
  const enforceHint = createElement("div", { className: "zgc-hint" }, t("enforceHint"));
  return createElement("div", { className: "zgc-row" }, enforceInner, enforceHint);
}

/**
 * 数值区间行的差异面：解锁配额与解锁时效两行只差文案键、写入字段与上限，
 * 判定与错误口径完全一致 ⇒ 共用一个构造器，不再各写一份。
 */
interface RangeRowSpec {
  labelKey: keyof UiMessages;
  hintKey: keyof UiMessages;
  /** 草稿字段名：与 host Config 的 volatile 字段同名。 */
  field: string;
  invalidKey: "budgetInvalid" | "windowInvalid";
  /** 合法上限（下限恒为 1，与 Config schema 的 min(1) 同一口径）。 */
  max: number;
  /** 输入的显示值：草稿优先（见 draftFields）。 */
  value: string;
}

/** 配额 / 时效行：区间内落草稿、清空即回「未填」、越界给区间文案并置保存条错误。 */
function buildRangeRow(deps: CardDeps, spec: RangeRowSpec): ReactNode {
  const { setField, setSaveError, t, writable } = deps;
  const label = createElement("div", { className: "zgc-label" }, t(spec.labelKey));
  const hint = createElement("div", { className: "zgc-hint" }, t(spec.hintKey));
  const input = createElement("input", {
    className: "zgc-input",
    type: "number",
    min: 1,
    max: spec.max,
    value: spec.value,
    disabled: !writable,
    onChange: (ev: { target: { value: string } }) => {
      const { value: raw } = ev.target;
      if (raw === "") {
        setSaveError(null);
        setField(spec.field, undefined);
        return;
      }
      const num = Number(raw);
      if (Number.isSafeInteger(num) && num >= 1 && num <= spec.max) {
        setSaveError(null);
        setField(spec.field, num);
      } else {
        setSaveError(rangeErrorText(t, spec.invalidKey, spec.max));
      }
    },
  });
  return createElement("div", { className: "zgc-row" }, label, hint, input);
}

/** 重建行：root 输入（白名单候选进 <datalist>）+ 触发按钮（在跑时禁用）。 */
function buildRebuildRow(deps: CardDeps): ReactNode {
  const { fields, rebuild, root, roots, setRoot, t } = deps;
  const rebuildLabel = createElement("div", { className: "zgc-label" }, t("rebuildLabel"));
  const rebuildHint = createElement(
    "div",
    { className: "zgc-hint" },
    rebuildHintText(t, fields.embedding, roots.length > 0),
  );
  const rootOptions = roots.map((entry) => createElement("option", { key: entry, value: entry }));
  const rootDatalist = createElement("datalist", { id: ROOT_OPTIONS_ID }, ...rootOptions);
  const rebuildInput = createElement("input", {
    className: "zgc-input",
    value: root,
    list: ROOT_OPTIONS_ID,
    placeholder: "/absolute/path/to/workspace",
    onChange: (ev: { target: { value: string } }) => {
      setRoot(ev.target.value);
    },
  });
  const rebuildButton = createElement(
    "button",
    {
      type: "button",
      className: "zgc-button",
      "data-field": "rebuild",
      disabled: rebuild.phase === "running",
      onClick: deps.onRebuild,
    },
    rebuild.phase === "running" ? t("rebuildRunning") : t("rebuildButton"),
  );
  return createElement(
    "div",
    { className: "zgc-row" },
    rebuildLabel,
    rebuildHint,
    rootDatalist,
    rebuildInput,
    rebuildButton,
  );
}

/** 重建状态节点：phase 非 idle 才出现；done 且无输出时给一句「已完成」。 */
function buildRebuildStatusRow(deps: CardDeps): ReactNode | null {
  const { rebuild, t } = deps;
  if (rebuild.phase === "idle") {
    return null;
  }
  const displayClass = rebuild.phase === "error" ? "zgc-error" : "zgc-output";
  let displayText: string;
  if (rebuild.output === "") {
    displayText = rebuild.phase === "done" ? t("rebuildDone") : "";
  } else {
    displayText = rebuild.output;
  }
  return createElement("div", { className: displayClass }, displayText);
}

/**
 * 卡片主体所有行（含重建 status 节点），返回子元素数组。
 * 每行自己的构造器在上方按职责拆好，这里只负责顺序与两行区间行的差异面。
 */
function buildCardBody(deps: CardDeps): ReactNode[] {
  const { fields, t } = deps;
  const rows: ReactNode[] = [
    buildEmbeddingRow(deps),
    buildLimitRow(deps),
    buildEndpointRow(deps),
    buildEnforceRow(deps),
    buildRangeRow(deps, {
      labelKey: "budgetLabel",
      hintKey: "budgetHint",
      field: "grepBudgetPerSearch",
      invalidKey: "budgetInvalid",
      max: BUDGET_MAX,
      value: fields.grepBudget,
    }),
    buildRangeRow(deps, {
      labelKey: "windowLabel",
      hintKey: "windowHint",
      field: "unlockWindowMin",
      invalidKey: "windowInvalid",
      max: WINDOW_MAX,
      value: fields.unlockWindow,
    }),
    createElement(SaveBar, {
      t,
      dirty: deps.dirty,
      writable: deps.writable,
      busy: deps.busy,
      error: deps.saveError,
      onSave: deps.onSave,
      onDiscard: deps.onDiscard,
    }),
    buildRebuildRow(deps),
  ];
  const status = buildRebuildStatusRow(deps);
  if (status !== null) {
    rows.push(status);
  }
  return rows;
}

/** 显式字段写入（schema-coverage 门禁按 set('字段名') 字面量识别绑定）。 */
function pushFieldWrite(
  ops: Promise<boolean>[],
  key: string,
  draft: unknown,
  set: (field: string, value: unknown) => Promise<boolean>,
): void {
  if (key === "defaultEmbedding") {
    ops.push(set("defaultEmbedding", draft));
  } else if (key === "defaultLimit") {
    ops.push(set("defaultLimit", draft));
  } else if (key === "hfEndpoint") {
    ops.push(set("hfEndpoint", draft));
  } else if (key === "enforceSearchFirst") {
    ops.push(set("enforceSearchFirst", draft));
  } else if (key === "grepBudgetPerSearch") {
    ops.push(set("grepBudgetPerSearch", draft));
  } else if (key === "unlockWindowMin") {
    ops.push(set("unlockWindowMin", draft));
  }
}

/** 服务端 `{ok:false,error}` 里的可行动文案（无 error 字段给通用兜底）。 */
function serverErrorOf(body: Record<string, unknown> | null, t: Translate): string | null {
  if (body === null) {
    return null;
  }
  const { error } = body;
  return typeof error === "string" && error.length > 0 ? error : t("requestRejected");
}

/**
 * 一次 JSON 往返：先按 content-type 决定能不能当 JSON 读（未注册的路径会被前端
 * SPA fallback 兜成 200 + text/html，直接 JSON.parse 只能给出
 * `SyntaxError: Unexpected token '<'`），再让服务端的 error 文案优先于 HTTP 层
 * 的笼统描述。
 */
async function requestJson(
  url: string,
  t: Translate,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, init);
  const contentType = res.headers.get("content-type") ?? "";
  const record = contentType.toLowerCase().includes("json")
    ? parseJsonRecord(await res.text())
    : null;
  const problem = serverErrorOf(record, t) ?? httpProblem(res.ok, res.status, contentType, t);
  if (problem !== null) {
    throw new Error(problem);
  }
  if (record === null) {
    throw new Error(t("notJsonBody", { url }));
  }
  return record;
}

interface RebuildAccess {
  csrf: string;
  roots: string[];
}

const NO_ACCESS: RebuildAccess = { csrf: "", roots: [] };

/** 引导端点应答 → { csrf, roots }（字段缺失/类型不对一律当作没拿到）。 */
function readAccess(body: Record<string, unknown>): RebuildAccess {
  const { csrf, roots } = body;
  return {
    csrf: typeof csrf === "string" ? csrf : "",
    roots: Array.isArray(roots)
      ? roots.filter((item): item is string => typeof item === "string")
      : [],
  };
}

/** 重建视图（ZgCard 渲染所需 + start 动作）。 */
interface RebuildView {
  root: string;
  roots: string[];
  state: RebuildState;
  setRoot: (value: string) => void;
  /** 点击「重建」：async 状态机，调用方 fire-and-forget（面板自己推进 phase）。 */
  start: () => Promise<void>;
}

/**
 * 「工作区重建」状态机：取 token/白名单 → POST 启动 → 2s 轮询到终态。
 * 从 ZgCard 拆出，保持组件体在一屏内可读。
 * @param t - 取文案（官方 locale 的 translator，随卡片一起下发）。
 */
function useRebuild(t: Translate): RebuildView {
  const [root, setRoot] = useState("");
  const [access, setAccess] = useState<RebuildAccess>(NO_ACCESS);
  const [rebuild, setRebuild] = useState<RebuildState>({ phase: "idle", output: "" });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling(): void {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  // 卸载时一定停轮询：卡片关闭后继续 setInterval 会一直打 rebuild-status。
  useEffect(
    () => () => {
      stopPolling();
    },
    [],
  );

  /** 拉 CSRF token + 白名单。失败**不**改重建面板：面板 idle 时冒一个红字只是噪音，
   *  用户真点「重建」时 start() 会把同一错误显示出来。 */
  // useCallback 稳定化：t 每次 apply 只有一个稳定实例（ctx.locale.bind 的返回），依赖只留 t；
  // 效果是 refreshAccess 跨渲染代同一引用，三个调用点（挂载拉取与重建流程内两处）拿到同一支。
  const refreshAccess = useCallback(async (): Promise<RebuildAccess> => {
    const next = readAccess(await requestJson(REBUILD_ROOTS_URL, t));
    setAccess(next);
    return next;
  }, [t]);

  useEffect(() => {
    // await 形态取代 .catch 链（promise/prefer-await-to-then）：useEffect 的回调按官方契约
    // 只能返回 cleanup 或 undefined，不能是 Promise，所以 await 装在这枚立即执行的 async
    // 箭头里；失败仍只做「面板不动」的静默复位，与旧的 .catch 同一条道。
    void (async () => {
      try {
        await refreshAccess();
      } catch {
        setAccess(NO_ACCESS);
      }
    })();
    // refreshAccess 经 useCallback 稳定（t 每次 apply 只有一个稳定实例，ctx.locale.bind 的
    // 返回），入依赖后行为不变：仍只在挂载时拉一次。
  }, [refreshAccess]);

  async function pollStatus(jobId: string): Promise<void> {
    try {
      const body = await requestJson(`${REBUILD_STATUS_URL}?jobId=${encodeURIComponent(jobId)}`, t);
      const poll = parseRebuildPoll(body, t);
      if (poll.phase !== "running") {
        stopPolling();
      }
      setRebuild({ phase: poll.phase, output: poll.output });
    } catch (error) {
      stopPolling();
      setRebuild({ phase: "error", output: errorText(error) });
    }
  }

  /** 发起一次重建（带 token）；成功后进入轮询。 */
  async function startOnce(token: string): Promise<void> {
    const body = await requestJson(`${REBUILD_URL}?root=${encodeURIComponent(root.trim())}`, t, {
      method: "POST",
      headers: { [REBUILD_CSRF_HEADER]: token },
    });
    const { jobId } = body;
    if (!isOkBody(body) || typeof jobId !== "string") {
      throw new Error(t("rebuildMissingJobId"));
    }
    pollRef.current = setInterval(() => {
      void pollStatus(jobId);
    }, REBUILD_POLL_MS);
  }

  async function start(): Promise<void> {
    const trimmedRoot = root.trim();
    if (!trimmedRoot.startsWith("/")) {
      setRebuild({ phase: "error", output: t("rebuildRootNotAbsolute") });
      return;
    }
    stopPolling();
    setRebuild({ phase: "running", output: t("rebuildStarting") });
    try {
      let token = access.csrf;
      if (token === "") {
        const fresh = await refreshAccess();
        token = fresh.csrf;
      }
      try {
        await startOnce(token);
      } catch (error) {
        // 宿主每次 apply 都会换 token（页面开着就会过期）：带旧 token 被拒 →
        // 重取一次 token 再试，避免卡片从此「点什么都没反应」。
        if (access.csrf === "") {
          throw error;
        }
        const renewed = await refreshAccess();
        await startOnce(renewed.csrf);
      }
    } catch (error) {
      stopPolling();
      setRebuild({ phase: "error", output: errorText(error) });
    }
  }

  return { root, roots: access.roots, state: rebuild, setRoot, start };
}

function ZgCard(props: CardSlotProps): ReactNode {
  const { t } = props;
  const snap = props.useCard((state) => state);
  // 快照契约 {status, writable, value:{...}}：配置值在 snap.value 内。
  // 旧实现 `value = snap` 取整个快照顶层，配置永远读不到（恒显示默认值）
  // ——对齐 ctx-observe/memory-tdai 的 snap.value 解构。
  const { status, writable: isSnapWritable } = snap;
  const writable = status === "ready" && isSnapWritable;
  const value = snapshotValue(snap);

  // 保存条状态：touched = 用户动过的字段（defaultLimit: undefined = 清空 → unset）
  const [touched, setTouched] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const rebuildView = useRebuild(t);

  // 六个字段一律走草稿层（lib/card-logic.draftFields）：任何字段绑回已提交快照，
  // 该字段的受控输入就会吞键击（select 弹回旧值、input 改不动），而旁边的字段却
  // 能改——同一张卡两种行为，用户只能理解为「这个设置改了没用」。
  const fields = draftFields(touched, value);
  const dirty = diffTouched(touched, value).length > 0;
  const setField = (field: string, draft: unknown): void => {
    setTouched((prev) => ({ ...prev, [field]: draft }));
  };

  const save = async (): Promise<void> => {
    const keys = diffTouched(touched, value);
    if (keys.length === 0) {
      return;
    }
    setBusy(true);
    setSaveError(null);
    const ops: Promise<boolean>[] = [];
    for (const key of keys) {
      const draft = touched[key];
      if (draft === undefined) {
        // unset 语义：defaultLimit 清空 → 回组合层（BUILTIN_BASE / 行 config）默认
        ops.push(props.unset(key));
      } else {
        pushFieldWrite(ops, key, draft, props.set);
      }
    }
    try {
      const results = await Promise.all(ops);
      // 受理位消费：任一字段 false（宿主拒绝/写入被跳过）→ saveRejected 且**整批保留
      // touched**（fail-closed：不区分"哪些成了"，宁可让用户重按一次保存，也不静默丢
      // 修改）；传输失败 rejection → saveFailed（带原因）。
      if (results.some((accepted) => !accepted)) {
        setBusy(false);
        setSaveError(t("saveRejected"));
        return;
      }
    } catch (error) {
      setBusy(false);
      setSaveError(t("saveFailed", { reason: errorText(error) }));
      return;
    }
    const savedKeys = new Set(keys);
    const next = Object.fromEntries(
      Object.entries(touched).filter(([entryKey]) => !savedKeys.has(entryKey)),
    );
    setBusy(false);
    setTouched(next);
  };
  const discard = (): void => {
    setTouched({});
    setSaveError(null);
  };

  const deps: CardDeps = {
    t,
    fields,
    writable,
    roots: rebuildView.roots,
    root: rebuildView.root,
    rebuild: rebuildView.state,
    dirty,
    busy,
    saveError,
    setField,
    setRoot: rebuildView.setRoot,
    setSaveError,
    onSave: () => {
      void save();
    },
    onDiscard: discard,
    onRebuild: () => {
      void rebuildView.start();
    },
  };
  const rows = buildCardBody(deps);
  const body = createElement("div", { style: { padding: "2px 0" } }, rows);
  return createElement(
    PluginCard,
    {
      title: t("cardTitle"),
      description: t("cardDescription"),
    },
    body,
  );
}

/**
 * 官方 `LocaleRuntime.register` **类型化**重载的字典参数，取在本包命名空间上：
 * `Record<BuiltInLocaleId, LocaleDictOf<'zvec-grep'>>`——两语（官方 `BuiltInLocaleId`
 * = `LOCALE_IDS` 的 `"zh" | "en"`）必须齐、每语的键集必须等于 `UiMessages`，都由官方
 * 表达式给出，本地不再抄字典形状。
 */
export type LocaleCatalog = Record<BuiltInLocaleId, LocaleDictOf<typeof NS>>;

export interface ClientCtx {
  /**
   * cordis 官方效应面（installed `@deepseek-ai/cordis/lib/types/fiber.d.ts:8-11` 的
   * `interface Context extends Pick<Fiber, 'effect'>`，同文件 :157/:159 两个重载）。
   * 原先这里抄的是 `(factory: () => (() => void) | undefined, label?: string) => void`：
   * 官方的工厂只收 `SyncEffect` / `Effect`（同文件 :49-51），两者都**不含** `undefined`
   * （:152 还明写 `execute` 返回非法形状时抛 `TypeError`），返回面更是可 await 的
   * disposer（`Disposable<Promise<void>>` / `AsyncDisposable<Promise<void>>`）而不是
   * `void`——那一份抄写把 cordis 的入参与返回都挡在了编译期之外。
   */
  effect: Context["effect"];
  /**
   * 官方 `SlotRegistry`（renderer 把它增强进 cordis `Context`，installed
   * `dsh-client-ui-renderer/lib/types/client/index.d.ts:27`）的**方法面投影**。取 `Pick`
   * 而不是 `Context["slots"]` 整类型：`SlotRegistry` 是带 private 字段的 cordis
   * `Service` 类（同目录 `registry.d.ts:46-47` 的 `private readonly _core` 等），TS 对它
   * 做名义比较，测试桩件无法满足。`register` 逐字复用 `SlotCore['register']`（同文件 :85
   * `readonly register: SlotCore['register']`，两个重载），`inject` 是「按槽位声明生命
   * 周期装 effect」那一位（disposer 随 collapse 重跑工厂的语义就写在它的 doc 里）。
   * 合并进 `SlotMap` 的槽位键在这里是**编译期受检**的：`inject` 的 key 参数域就是
   * `keyof SlotMap & string`，`KindOptions`（`@deepseek-ai/dsh-client-ui-slots` 的
   * index.d.ts:560-583）再按 `SlotMap[K]['kind']` 分发——`plugins.bundle.config` 是
   * keyed 槽 → 注册项的 `key` **必填**（原来手抄的 `{ name: string; key?: string }`
   * 允许漏 key，而漏 key 的注册在宿主里根本匹配不上）。
   * ⚠ 本包不 merge 任何槽位：`plugins.bundle.config` 这条 key 由**属主包**
   * plugin-manager 交出（installed `dsh-client-ui-plugin-manager/lib/types/client/
   * slot-contract.d.ts:96-104`，文件头明写「A registrant merges this contract with
   * `import type` and registers through `ctx.slots`; it never imports this package at
   * runtime」）。本包把它载入 program 的入口是 `lib/card-logic.ts` 顶部那条
   * `import type { ConfigPageForm }`（本卡的快照状态位就从那里取，见其 `CardSnapshot`）；
   * 没有它，官方 key 域里只剩 renderer 自己 merge 的 `'root'`，下面那一处
   * `slots.inject("plugins.bundle.config", …)` 与 register 项里的同名 `name` 都会当场红
   * （实测 TS2345：`Argument of type '"plugins.bundle.config"' is not assignable to
   * parameter of type '"root"'`）。
   */
  slots: Pick<SlotRegistry, "inject" | "register">;
  /**
   * 0.1.7 的配置表单服务（installed
   * `dsh-client-ui-settings/lib/types/client/config-form.d.ts:94-98` 交出
   * `Context.configForms`，`get:142` 按 profile 条目 id 取那张共享表单，实现见
   * installed `dsh-client-ui-settings/lib/client.js:1309-1315`——它把 entryId 原样当作
   * settings 命名空间，与本包 host 侧的隐式命名空间同源）：取代已被宿主移除的
   * `settingsScope`（installed 全树零命中）。注入只需 `configForms` 本身——写侧的
   * `remote.settings` 由 provider 自己的 fiber 承担（`config-form.d.ts:113-118` 明写
   * 「letting a shared form write through the caller's context would make every caller
   * declare `remote.settings`」，故此处不必声明）。
   *
   * ⚠ 只用 `get` 这一位，故按方法面投影——官方 `ConfigForms` 是带 private 字段的
   * Service 类，TS 对其做名义比较，测试桩件无法满足，**不得**写成 `ConfigForms`。
   * 返回类型 `SettingScope` 现在是官方 `ConfigForm<Record<string, unknown>>` 的别名
   * （见 lib/card-logic.ts），快照字段一名一改这里就会编译失败。
   */
  configForms: {
    get: (entryId: string) => SettingScope;
  };
  /**
   * 官方 `@deepseek-ai/dsh-client-locale` 的 client 面（installed
   * `dsh-client-locale/lib/types/client/index.d.ts`）在**类型化**那两条重载上的投影：
   * - `register`：`register<N extends Extract<keyof LocaleNamespaceMap, string>>(ns: N,
   *   dicts: Record<BuiltInLocaleId, LocaleDictOf<N>>): () => void`（:199，`class
   *   LocaleRuntime` 自 :97 起）。取在
   *   `typeof NS` 上：字典参数就是上面那个 `LocaleCatalog`，两语必须一次交齐、每语键集
   *   必须等于本包 `UiMessages`，都由官方表达式给出。返回的是**一个** disposer——官方实现
   *   对对象形式的入参 `Object.entries(dicts)` 逐语登记、并回一条撤掉本次全部语言的回收
   *   函数（installed `dsh-client-locale/lib/client.js` 的 `register(ns, localeOrDicts,
   *   dict)`：`const pairs = typeof localeOrDicts === "string" ? [[localeOrDicts, dict]] :
   *   Object.entries(localeOrDicts)`，然后 `return () => { … for (const [locale, entries]
   *   of pairs) … }`），与逐语两次注册 + 两个 disposer 的旧写法等价。
   *   ⚠ 不走官方那条**未类型化**的三参重载（`register(ns, locale, dict: LocaleDict)`，
   *   :209；`LocaleDict = Record<string, string>`，:29）：`UiMessages` 按本包 lint 的
   *   `consistent-type-definitions` 必须是 `interface`，而 interface 没有隐式索引签名，
   *   交不进那条扁平字典（实测 TS2345：`Argument of type 'UiMessages' is not assignable to
   *   parameter of type 'LocaleDict'. Index signature for type 'string' is missing in type
   *   'UiMessages'`）。走有限键映射那条既满足官方契约，又让「少一门语言」「多一个键」
   *   都在编译期红。
   * - `bind`：官方**类型化**那条（`bind<N …>(ns: N): TranslateNS<N>`，:219），取在
   *   `typeof NS` 上就是 `TranslateNS<'zvec-grep'>`（见 ui-messages.ts 的 `Translate`）。
   *   本包命名空间已 merge 进 `LocaleNamespaceMap`，所以这条重载可用；顺带白拿一根漂移
   *   针——`NS` 与那条 merge 的表键分叉时，两条重载都对不上（类型化的约束不满足；
   *   未类型化的回 `Translate<string>`，与窄键集不兼容）。
   */
  locale: {
    register: (ns: typeof NS, dicts: LocaleCatalog) => () => void;
    bind: (ns: typeof NS) => Translate;
  };
}

const inject = ["slots", "configForms", "locale"];

function apply(ctx: ClientCtx): void {
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.id = "zvec-grep-card-css";
    tag.textContent = CARD_CSS;
    document.head.append(tag);
    return () => {
      tag.remove();
    };
  }, "zvec-grep-card: styles");
  // 本条目的共享表单：条目 id == cordis.patch.yml 里的裸 id `zvec-grep`（0.1.7 起
  // settings 命名空间即条目 id，不再有独立的 register 命名空间），与 host 半隐式注册的
  // 命名空间同源，故直接复用 NS。表单生命周期归 provider（消费者面上没有 dispose）。
  const scope = ctx.configForms.get(NS);
  const store = cardStore(scope);
  // 卡片文案交给官方 locale：把本包两语字典**一次性**交给类型化那条 register 重载
  // （官方要求每个内置 locale 都在、键集等于本包字典，缺一门即编译期红；它回**一个**
  // disposer，撤掉这一次调用登记的全部语言，随本 effect 回收），再 bind 出稳定的取文案
  // 函数交给卡片。语言切换由宿主驱动 slot 重渲染，无需重载页面。
  ctx.effect(() => ctx.locale.register(NS, UI_MESSAGES), "zvec-grep-card: locale dictionaries");
  const t = ctx.locale.bind(NS);
  // 写通道受理位**原样透传**给卡片（消费在 save()：false → saveRejected 且整批保留
  // touched；这里只补字段级 console.error 供排查，rejection 照旧上抛给 save 的
  // Promise.all 收口成 saveFailed 文案）。
  const writeField = async (field: string, valueDraft: unknown): Promise<boolean> => {
    try {
      return await scope.set(field, valueDraft);
    } catch (error) {
      console.error(`[zvec-grep] set ${field} failed:`, error);
      throw error;
    }
  };
  const unsetField = async (field: string): Promise<boolean> => {
    try {
      return await scope.unset(field);
    } catch (error) {
      console.error(`[zvec-grep] unset ${field} failed:`, error);
      throw error;
    }
  };
  ctx.slots.inject("plugins.bundle.config", () => {
    const unregister = ctx.slots.register(
      {
        // 0.1.6：settings.plugin.item 已删除；plugins.bundle.config 按 bundle 包名 keyed。
        // 0.1.7 复核：槽位仍在（installed dsh-client-ui-plugin-manager/lib/types/client/
        // slot-contract.d.ts:100），故本段仍在——换掉的只是它读写的表单来源。
        // 键值已定案（此处曾留 `⚠ 键值待议`）：owner 派发的是
        // `entryKey: pkg.name`，pkg.name 就是 bundle 的 npm 包名（installed
        // dsh-client-ui-plugin-manager/lib/client.js:1821 与 :2698
        // `ledger.bundles.has(openPkg.name)`；slot-contract.d.ts:96-98「keyed by the
        // bundle's package name」；官方占位者
        // dsh-experimental-client-ui-voice-input/lib/client.js:5659-5661 也用了包名
        // `@deepseek-ai/dsh-experimental-voice-input-bundle`）。按裸条目 id 注册 =
        // renderer 匹配不到 entry（client-ui-renderer/lib/client.js:1154 逐字相等）=
        // bundle 页面上这张卡**完全不渲染**，所以这里必须是 BUNDLE_PKG。
        // 表单侧不变：上面 `ctx.configForms.get(NS)` 仍吃裸条目 id（installed
        // dsh-client-ui-settings/lib/client.js:1309-1315 把入参原样当 settings 命名空间）。
        name: "plugins.bundle.config",
        key: BUNDLE_PKG,
        inject: () => ({
          t,
          hooks: { card: store },
          set: writeField,
          unset: unsetField,
        }),
      },
      ZgCard,
    );
    // 只注销这一次声明：slots.inject 的回调在槽「折叠 → 再声明」时会再次运行（installed
    // dsh-client-ui-renderer/lib/types/client/registry.d.ts:100 "Collapse disposes the
    // effect and a later declaration runs it again"），而 scope/store 是每次 apply 只建
    // 一次的共享物。0.1.7 里也无从 dispose：`configForms.get()` 交回的是 provider 持有
    // 的共享表单（installed config-form.d.ts:138-142 "The entry's form, owned by this
    // provider"），`ConfigForm` 接口（config-form-types.d.ts:36-74）没有 dispose，销毁
    // 由 provider 在自己的 teardown 统一做（installed
    // dsh-client-ui-settings/lib/client.js:1290-1293）。表单共享且长活，所以工厂重跑后
    // 写入依然落盘；旧 `settingsScope` 那种「离开插件页一次之后 scope 永久 disposed、
    // 保存看起来成功却一条都没写进去」的坑（0.1.6 的 fiber 级 dispose + enqueue 对
    // disposed 直接 resolve）随该服务一起消失。
    return unregister;
  });
}

export { inject, apply };
