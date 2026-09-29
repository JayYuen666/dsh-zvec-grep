// src/ui-messages.ts —— 设置卡 UI 文案字典（中英双语）。
//
// 键集一致由 tsc 保证：zh / en 两份都标注同一个 UiMessages 接口，少键多键在编译期红。
// 注册与取值走官方 @deepseek-ai/dsh-client-locale：本包命名空间 merge 进官方
// `LocaleNamespaceMap`（见下面那条 `declare module`）之后，`ctx.locale.register(ns, dicts)`
// 的类型化重载可用（两语一次交齐、每语键集必须等于本接口），`ctx.locale.bind(ns)` 回到的
// 就是官方 `TranslateNS<ns>`（见 `Translate`）。语言切换由宿主驱动 slot 重渲染、无需重载
// 页面（见 client-entry.ts 的 apply）。
// 带变量的整行写成 `{name}` 模板（官方 Translate 的插值），片段仍在本表内。
// lib/card-logic.ts 用到的那几个键在 CardTextKey 里收窄（lib 不反向 import src）。
import type { TranslateNS as OfficialTranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import type { MessagesCatalog } from "@jayyuen666/dsh-plugin-shared/lib/locale";

/** 本包设置卡产出的全部界面文案。 */
export interface UiMessages {
  /** 卡片标题（设置页插件列表里的那一行）。 */
  readonly cardTitle: string;
  /** 卡片副标题：一句话说明本包做什么。 */
  readonly cardDescription: string;
  /** 作用域只读时的状态条文本。 */
  readonly statusReadOnly: string;
  /** 有未保存改动时的状态条文本。 */
  readonly statusDirty: string;
  /** 无未保存改动时的状态条文本。 */
  readonly statusClean: string;
  /** 保存按钮（空闲态）。 */
  readonly save: string;
  /** 保存按钮（写入中）。 */
  readonly saving: string;
  /** 撤销按钮。 */
  readonly revert: string;
  /** 保存失败（后接错误摘要）：`{reason}`。 */
  readonly saveFailed: string;
  /** 保存被宿主拒绝（受理位 false：校验未通过或写入被跳过），修改未生效。 */
  readonly saveRejected: string;

  /** 「默认本地 embedding」行标题。 */
  readonly embeddingLabel: string;
  /** 「默认本地 embedding」行说明。 */
  readonly embeddingHint: string;
  /** 「默认每组结果数」行标题。 */
  readonly limitLabel: string;
  /** limit 输入非整数的提示：`{min}`、`{max}`。 */
  readonly limitInvalid: string;
  /** limit 输入越界被钳位的提示：`{min}`、`{max}`、`{value}`。 */
  readonly limitClamped: string;
  /** 「HuggingFace 镜像地址」行标题。 */
  readonly endpointLabel: string;
  /** 「HuggingFace 镜像地址」行说明。 */
  readonly endpointHint: string;
  /** search-first 开关文案。 */
  readonly enforceLabel: string;
  /** search-first 开关说明。 */
  readonly enforceHint: string;
  /** 解锁配额行标题。 */
  readonly budgetLabel: string;
  /** 解锁配额行说明。 */
  readonly budgetHint: string;
  /** 解锁配额输入非法：`{min}`、`{max}`。 */
  readonly budgetInvalid: string;
  /** 解锁时效行标题。 */
  readonly windowLabel: string;
  /** 解锁时效行说明。 */
  readonly windowHint: string;
  /** 解锁时效输入非法：`{min}`、`{max}`。 */
  readonly windowInvalid: string;

  /** 「工作区重建」行标题。 */
  readonly rebuildLabel: string;
  /** 重建行说明（整行模板）：`{embedding}`、`{roots}`。 */
  readonly rebuildHint: string;
  /** 有候选工作区时的尾注。 */
  readonly rootsNoteWith: string;
  /** 无候选工作区时的尾注。 */
  readonly rootsNoteEmpty: string;
  /** 重建按钮（空闲态）。 */
  readonly rebuildButton: string;
  /** 重建进行中文本（按钮与轮询应答共用）。 */
  readonly rebuildRunning: string;
  /** 重建成功且无输出时的提示。 */
  readonly rebuildDone: string;
  /** 点下重建后的首帧提示。 */
  readonly rebuildStarting: string;
  /** 重建进程被终止。 */
  readonly rebuildKilled: string;
  /** 官方作业注册表判定 failed（拿不到退出码）。 */
  readonly rebuildFailed: string;
  /** 重建进程非零退出：`{exitCode}`。 */
  readonly rebuildExitCode: string;
  /** 启动端点应答缺 jobId。 */
  readonly rebuildMissingJobId: string;
  /** 卡片侧 root 预检（绝对路径）。 */
  readonly rebuildRootNotAbsolute: string;

  /** embedding 候选项文本模板：`{reference}`、`{dimension}`。 */
  readonly modelOption: string;
  readonly backendLlamaCpp: string;
  readonly backendTransformersJs: string;
  readonly backendModel2Vec: string;

  /** 403（同源/CSRF 失效）的可行动描述。 */
  readonly httpForbidden: string;
  /** 其它非 2xx 的描述：`{status}`。 */
  readonly httpFailed: string;
  /** 200 但不是 JSON 的描述：`{contentType}`。 */
  readonly httpNotJson: string;
  /** content-type 缺失时的占位（填进 httpNotJson）。 */
  readonly contentTypeMissing: string;
  /** 应答体不是 JSON 对象：`{url}`。 */
  readonly notJsonBody: string;
  /** 服务端 `{ok:false}` 且没带 error 时的兜底描述。 */
  readonly requestRejected: string;
}

/**
 * 本包的文案命名空间 merge 进官方的 `LocaleNamespaceMap`（installed
 * `dsh-client-ui-slots/lib/types/index.d.ts:22-30`：「Dictionary owners extend via
 * declaration merging (exactly like {@link SlotMap} …)；the key is the namespace string,
 * the value is the union of its dictionary keys」）。这一步是**必需**而不是美化：不 merge
 * 时官方 `LocaleRuntime.register` / `bind` 只有那条**未类型化**重载可用
 * （`register(ns: string, locale: string, dict: LocaleDict)`、`bind(ns: string):
 * Translate<string>`），卡片要的窄键集 `t` 官方就给不出来，本地只好自己抄一个函数形状
 * （写过的就是下面被换掉的那行 `export type Translate = (key: keyof UiMessages, …)`）。
 * merge 之后键域由官方 `TranslateNS<NS>` 表达，`t("拼错的键")` 在编译期红，而
 * `ctx.locale.register(NS, UI_MESSAGES)` 能落到类型化重载上（两语必须一次交齐）。
 * ⚠ 表键必须是字面量（interface 键位不接受计算属性），故下面那条常量把它与
 * client-entry.ts 的 `NS` 钉在编译期：两边哪天分叉，`LocaleCatalog` 那条官方投影就先红。
 * 这个串的真源是本包 cordis.patch.yml 的裸 `- id: zvec-grep`（0.1.7 起 loader 条目 id
 * = settings 命名空间 = locale 命名空间同一个串）：test/build-client.test.ts 解析该文件、
 * 钉住「只声明这一行裸 id」，并断言注册进官方 locale 的 ns 与 `configForms.get()` 的入参
 * 都是它，故表键、`NS`、patch 文件三者任一分叉都会在测试里红，不需要在此处再抄一份。
 */
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** 本包设置卡的全部界面文案键。 */
    "zvec-grep": keyof UiMessages;
  }
}

/** 编译期契约：merge 里写死的命名空间键（`Translate` 用它取 `TranslateNS`）与卡片
 *  条目 id 必须是同一个串——改任何一处都要动这一行才会红。 */
const LOCALE_NS_KEY = "zvec-grep" as const;

/**
 * 本源只以**类型**形态对外流通：`client-entry.ts` 的 `const NS: LocaleNs = "zvec-grep"` 把条目
 * id 钉在本源上（分叉即编译期红），而产物漂移针仍要按字面量形状从 bundle 里抓 `NS`，所以那里
 * 保留字面量、只加类型标注——值导出不必存在（用例侧同理：要断言运行时那串就写字面量）。
 */
export type LocaleNs = typeof LOCALE_NS_KEY;

/**
 * 卡片取文案的函数形状：官方 `TranslateNS<N>`（installed `dsh-client-ui-slots/lib/types/
 * index.d.ts:67` `= Translate<LocaleKeysOf<N>>`，而 `Translate<K> = (key: K, params?) =>
 * string`）——键集就是上面 merge 的 `keyof UiMessages`（并上官方 `common` 命名空间的共享
 * 词表：`LocaleKeysOf` 就是这么定义的，官方查找链在自有命名空间 miss 后确实会去问
 * common，故这不是本包「多出来的键」），函数面完全归官方，本地不再抄签名。
 */
export type Translate = OfficialTranslateNS<typeof LOCALE_NS_KEY>;

export const UI_MESSAGES: MessagesCatalog<UiMessages> = {
  zh: {
    cardTitle: "zvec-grep（zg）",
    cardDescription:
      "工作区语义检索：zg_search / zg_index / zg_status；本地 embedding + BM25 + 向量 RRF",
    statusReadOnly: "当前作用域只读",
    statusDirty: "有未保存的修改，点「保存」生效",
    statusClean: "无未保存的修改",
    save: "保存",
    saving: "保存中…",
    revert: "撤销",
    saveFailed: "保存失败：{reason}",
    saveRejected: "保存被宿主拒绝（配置校验未通过或写入被跳过），修改未生效",
    embeddingLabel: "默认本地 embedding",
    embeddingHint: "只影响「新建」索引；切换并保存后，已有索引需点下方「重建」重新 embedding",
    limitLabel: "默认每组结果数（1-50）",
    limitInvalid: "请输入 {min}-{max} 的整数",
    limitClamped: "已钳到 {min}-{max} 范围：{value}",
    endpointLabel: "HuggingFace 镜像地址（可选）",
    endpointHint:
      "留空走 huggingface.co；国内网络可填 https://modelscope.cn/models 等兼容镜像（仅 llama-cpp 后端生效，如 qwen3）",
    enforceLabel: "强制 search-first（先 zg_search 再 grep/rg）",
    enforceHint:
      "开启后，已建索引工作区内的 grep/rg 受配额门禁约束：每次成功 zg_search 解锁下方次数的 grep/rg（时效见下），用尽或过期后再次拦截（提高检索覆盖与准确性）",
    budgetLabel: "每次 zg_search 解锁的 grep/rg 次数（1-20）",
    budgetHint: "配额越小语义检索越频繁、准确性约束越强；清空恢复默认 3",
    budgetInvalid: "解锁次数必须是 {min}-{max} 的整数",
    windowLabel: "解锁时效（分钟，1-240）",
    windowHint: "超过该时长未再次 zg_search，配额整体过期；清空恢复默认 10",
    windowInvalid: "解锁时效必须是 {min}-{max} 的整数",
    rebuildLabel: "工作区重建（切换 embedding 并保存后执行）",
    rebuildHint: "以当前默认模型重建：{embedding}；等价于 zg index --rebuild。{roots}",
    rootsNoteWith: "候选工作区来自本 daemon 已打开过的会话（服务端白名单）。",
    rootsNoteEmpty: "尚无可选工作区：先在该工作区里开一个会话（任一次工具调用即登记）。",
    rebuildButton: "重建索引（动作，点击即执行）",
    rebuildRunning: "重建中…",
    rebuildDone: "重建完成",
    rebuildStarting: "正在后台重建索引…（首次会下载 embedding 模型，可能较慢）",
    rebuildKilled: "重建进程被终止",
    rebuildFailed: "重建作业被宿主注册表判定失败（没拿到进程退出码）",
    rebuildExitCode: "重建进程退出码 {exitCode}（zg 未安装/权限不足/沙箱拒绝都会走到这里）",
    rebuildMissingJobId: "启动重建失败：应答缺 jobId",
    rebuildRootNotAbsolute: "root 必须是绝对路径（以 / 开头）",
    modelOption: "{reference}（{dimension}维）",
    backendLlamaCpp: "llama-cpp（原生，需 node-llama-cpp）",
    backendTransformersJs: "transformers-js（纯 JS ONNX）",
    backendModel2Vec: "model2vec（纯 JS worker，最轻）",
    httpForbidden: "403：请求被拒绝（同源校验或 CSRF token 失效）",
    httpFailed: "请求失败（HTTP {status}）",
    httpNotJson: "响应不是 JSON（content-type={contentType}）：重建端点未注册或路径被前端兜住了",
    contentTypeMissing: "缺省",
    notJsonBody: "响应不是 JSON 对象：{url}",
    requestRejected: "请求未被接受",
  },
  en: {
    cardTitle: "zvec-grep (zg)",
    cardDescription:
      "Workspace semantic search: zg_search / zg_index / zg_status; local embedding + BM25 + vector RRF",
    statusReadOnly: "This scope is read-only",
    statusDirty: "Unsaved changes — press Save to apply",
    statusClean: "No unsaved changes",
    save: "Save",
    saving: "Saving…",
    revert: "Revert",
    saveFailed: "save failed: {reason}",
    saveRejected:
      "save rejected by host (validation failed or write skipped) — changes not applied",
    embeddingLabel: "Default local embedding",
    embeddingHint:
      "Affects newly built indexes only; after switching and saving, press Rebuild below to re-embed existing indexes",
    limitLabel: "Default hits per group (1-50)",
    limitInvalid: "enter an integer between {min} and {max}",
    limitClamped: "clamped into the {min}-{max} range: {value}",
    endpointLabel: "HuggingFace mirror URL (optional)",
    endpointHint:
      "Leave empty for huggingface.co; on networks that cannot reach HF, fill a compatible mirror such as https://modelscope.cn/models (llama-cpp backends only, e.g. qwen3)",
    enforceLabel: "Enforce search-first (zg_search before grep/rg)",
    enforceHint:
      "When on, grep/rg inside indexed workspaces is quota-gated: each successful zg_search unlocks the number of grep/rg calls below (valid for the window below), and the gate blocks again once it is spent or expired (better coverage and relevance)",
    budgetLabel: "grep/rg calls unlocked per zg_search (1-20)",
    budgetHint:
      "A smaller quota means more semantic searches and a stronger relevance constraint; clear to restore the default 3",
    budgetInvalid: "the unlock quota must be an integer between {min} and {max}",
    windowLabel: "Unlock window (minutes, 1-240)",
    windowHint:
      "Without another zg_search inside this window the whole quota expires; clear to restore the default 10",
    windowInvalid: "the unlock window must be an integer between {min} and {max}",
    rebuildLabel: "Workspace rebuild (run after switching embedding and saving)",
    rebuildHint:
      "Rebuild with the current default model: {embedding}; same as zg index --rebuild. {roots}",
    rootsNoteWith:
      "Candidates come from sessions this daemon already opened (server-side whitelist).",
    rootsNoteEmpty:
      "No workspace to pick yet: open a session in that workspace first (any tool call registers it).",
    rebuildButton: "Rebuild index (action, runs on click)",
    rebuildRunning: "rebuilding…",
    rebuildDone: "rebuild finished",
    rebuildStarting:
      "Rebuilding in the background… (the first run downloads the embedding model and may be slow)",
    rebuildKilled: "the rebuild process was terminated",
    rebuildFailed: "the host job registry reported the rebuild as failed (no process exit code)",
    rebuildExitCode:
      "the rebuild process exited with code {exitCode} (missing zg, insufficient permissions and sandbox denials all land here)",
    rebuildMissingJobId: "failed to start the rebuild: the response has no jobId",
    rebuildRootNotAbsolute: "root must be an absolute path (starting with /)",
    modelOption: "{reference} ({dimension} dims)",
    backendLlamaCpp: "llama-cpp (native, requires node-llama-cpp)",
    backendTransformersJs: "transformers-js (pure JS ONNX)",
    backendModel2Vec: "model2vec (pure JS worker, lightest)",
    httpForbidden: "403: request rejected (same-origin check or expired CSRF token)",
    httpFailed: "request failed (HTTP {status})",
    httpNotJson:
      "response is not JSON (content-type={contentType}): the rebuild endpoint is not registered, or a front-end fallback caught the path",
    contentTypeMissing: "unset",
    notJsonBody: "response is not a JSON object: {url}",
    requestRejected: "the request was not accepted",
  },
};
