// lib/messages.ts —— host 半文案字典（中英双语）。
//
// 只管 host 半：设置卡的 UI 文案走官方 @deepseek-ai/dsh-client-locale
// （client 侧 `ctx.locale.register(ns, dicts)` + `bind`/`t`，见 src/client-entry.ts）。
// host 侧没有官方 i18n 面，工具描述、参数说明、工具回显与 guard 拒绝理由只能自带字典；
// 语言取官方 settings 的 `locale.preference`（shared 的 resolveLocalePreference），未注册即中文。
//
// 键集一致由 tsc 保证：zh / en 两份都标注同一个 ZvecGrepMessages 类型，少键多键在编译期红。
// 带变量的文案用 `{name}` 占位符 + fill() 填（与官方 locale 的插值语法同源，两侧一套写法），
// 字典本身是扁平字符串表。console.* 的日志、注释、索引路径/命令 argv/枚举值不在此列。
// 这张表就是 host 半的全部文案。曾经在这里另建过一张 EMBEDDING_MODEL_NOTES（11 个候选的
// 双语说明），但两侧都没有渲染点——卡片的 <select> 只显示「引用（维度）」，于是那行人读
// 口径回到 lib/embedding-catalog.ts 的注释里：没有消费者的文案不建表。

import type { MessagesCatalog } from "@jayyuen66/dsh-plugin-shared/lib/locale";

/** 本包 host 侧产出的全部人读文案（工具描述、工具回显、guard 理由、端点错误）。 */
export interface ZvecGrepMessages {
  // ── 工具描述（模型面）──────────────────────────────────────────────────────
  /** zg_search 的 description。 */
  readonly searchToolDescription: string;
  /** zg_index 的 description。 */
  readonly indexToolDescription: string;
  /** zg_status 的 description。 */
  readonly statusToolDescription: string;

  // ── 工具参数说明（模型面）──────────────────────────────────────────────────
  /** zg_search 的 root。 */
  readonly rootSearchDescription: string;
  /** zg_index 的 root。 */
  readonly rootIndexDescription: string;
  /** zg_status 的 root。 */
  readonly rootStatusDescription: string;
  readonly queryDescription: string;
  readonly queriesDescription: string;
  readonly ftsDescription: string;
  readonly vectorDescription: string;
  readonly fuseDescription: string;
  readonly limitDescription: string;
  /** zg_search 的 preview（含取值域与缺省）。 */
  readonly previewDescription: string;
  /** zg_search 的 refresh（含 background 的降级条件）。 */
  readonly refreshDescription: string;
  /** zg_search 的 globs（带示例）。 */
  readonly globsDescription: string;
  /** zg_index 的 globs。 */
  readonly globsIndexDescription: string;
  readonly insensitiveGlobsDescription: string;
  /** zg_search 的 fileTypes（带示例）。 */
  readonly fileTypesDescription: string;
  /** zg_index 的 fileTypes。 */
  readonly fileTypesIndexDescription: string;
  readonly excludedFileTypesDescription: string;
  readonly symbolTypesDescription: string;
  readonly preferSymbolDescription: string;
  readonly modifiedAfterDescription: string;
  readonly modifiedBeforeDescription: string;
  readonly deviceDescription: string;
  readonly resetPathsDescription: string;
  readonly confirmDescription: string;
  readonly embeddingDescription: string;
  readonly rebuildDescription: string;
  readonly dropDescription: string;
  readonly ignoreFilesDescription: string;
  readonly excludeSecretsDescription: string;
  readonly hiddenDescription: string;
  readonly noIgnoreDescription: string;
  readonly maxDepthDescription: string;
  readonly maxFileSizeBytesDescription: string;
  readonly followDescription: string;
  readonly embeddingConcurrencyDescription: string;

  // ── systemPrompt 注入段 ────────────────────────────────────────────────────
  /** 工作区检索硬规则段全文。 */
  readonly routingText: string;

  // ── 工具入参形状错误 ───────────────────────────────────────────────────────
  /** 入参不是 JSON 对象：`{name}` 工具名、`{received}` 收到的类型。 */
  readonly argsMustBeObject: string;
  /** 缺必填参数：`{name}` 工具名、`{fields}` 逗号连接的字段名。 */
  readonly missingRequiredArgs: string;

  // ── shell 执行回显 ─────────────────────────────────────────────────────────
  /** 沙箱事实后缀模板：`{mode}`、`{enforcement}`（已填好的 enforcement 片段）。 */
  readonly sandboxFacts: string;
  /** enforcement 片段：`{value}` 沙箱执行强度。 */
  readonly sandboxEnforcement: string;
  /** 沙箱 runner 启动失败（zg 未被执行）：`{facts}` 沙箱事实。 */
  readonly runnerFailed: string;
  /** 沙箱策略拒绝一次文件操作：`{facts}` 沙箱事实。 */
  readonly sandboxDenied: string;
  /** 超长错误首尾各留一段：`{head}`、`{tail}`。 */
  readonly detailMiddle: string;
  /** 执行超时（--refresh wait 的代价与出路）。 */
  readonly timeoutFailure: string;
  /** 执行被中止。 */
  readonly abortedFailure: string;
  /** 等待同根重建落定超时：`{root}`、`{seconds}`。*/
  readonly rebuildWaitTimeout: string;
  /** 等待同根重建落定期间被取消：`{root}`。*/
  readonly rebuildWaitAborted: string;
  /** 该根正在重建时的状态投影：`{root}`、`{jobId}`。*/
  readonly statusRebuilding: string;
  /** `--check-ready` 判出未就绪时的收尾注脚（报告已在上方）：`{root}`、`{detail}`。 */
  readonly statusNotReady: string;
  /** zg_status 的 checkReady 参数说明。 */
  readonly checkReadyDescription: string;
  /** zg_search 的 trace 参数说明。 */
  readonly traceDescription: string;
  /** 模型侧后台索引已启动：`{root}`、`{jobId}`、`{command}`。 */
  readonly indexBackgroundStarted: string;
  /** zg_index 的 background 参数说明。 */
  readonly backgroundDescription: string;
  /** 同根重建正在进行中、无法跟随其作业时的应答。 */
  readonly endpointRebuildInFlight: string;
  /** 前台重建撞上同根在飞重建时的工具回执：`{root}`。 */
  readonly indexRebuildInFlight: string;
  /** root 未获授权：`{root}`、`{cwd}`。 */
  readonly rootNotAuthorized: string;
  /** 无会话工作区时的 `{cwd}` 占位说法。 */
  readonly rootNoSession: string;
  /** 策略拒绝导致的失败：`{exit}`、`{denied}`、`{detail}`。 */
  readonly deniedFailure: string;
  /** zg 未安装（exit 127）：`{detail}`。 */
  readonly notInstalledFailure: string;
  /** zg 版本低于门槛：`{actual}`、`{minimum}`。 */
  readonly zgVersionTooOld: string;
  /** 显式 root 的用户确认理由（喂官方 approval）：`{root}`、`{cwd}`。 */
  readonly rootApprovalReason: string;
  /** 显式 root 的用户确认提示（两语各一份，随 displayReason 交给 UI）：`{root}`。 */
  readonly rootApprovalPrompt: string;
  /** 通用失败：`{exit}`、`{detail}`。 */
  readonly genericFailure: string;
  /** 详情尾巴（「 详情：…」句式）：`{detail}` 错误正文。 */
  readonly detailPrefix: string;
  /** 详情尾巴（「：…」紧贴句式，通用失败用）：`{detail}`。 */
  readonly detailColon: string;
  /** stdout 截尾：`{maxBytes}`、`{spill}` 落盘提示。 */
  readonly outputTruncated: string;
  /** 完整输出落盘位置：`{path}`。 */
  readonly spillNote: string;
  /** 成功但被拒过文件操作的警告：`{denied}`。 */
  readonly sandboxWarning: string;
  /** stderr 回显（降级提示常在这里）：`{marked}`、`{tail}`。 */
  readonly stderrNote: string;
  /** 命中摘要：`{groups}`、`{grouped}`、`{dedup}`、`{limit}`、`{capped}`、`{truncated}`。 */
  readonly hitSummary: string;
  /** 命中摘要的「去重后不同位置」片段：`{unique}`；一条位置都数不出时整段省略。 */
  readonly hitDedup: string;
  /** 命中摘要的「某组命中数正好等于上限」片段——只陈述观察，不断言发生了截断。 */
  readonly hitCapped: string;
  /** 命中摘要的「输出已截尾」片段（计数只含保留部分）。 */
  readonly hitTruncated: string;
  /** root 目录不存在：`{root}`。 */
  readonly rootMissing: string;

  // ── 后台重建任务的输出标记 ─────────────────────────────────────────────────
  /** 任务输出按内存上限截尾的标记。 */
  readonly jobOutputTruncated: string;
  /** 执行器缓冲区溢出丢过字节的标记。 */
  readonly jobOutputLost: string;
  /** 重建进程的 runner 失败：`{facts}`。 */
  readonly rebuildRunnerFailed: string;
  /** 重建过程中的策略拒绝：`{denied}`。 */
  readonly rebuildDenied: string;
  /** 超时强杀：`{minutes}` 分钟数。 */
  readonly rebuildTimeout: string;
  /**
   * 写进官方注册表 `detail` 的超时理由（**模型侧** job_list/job_output 读得到）：
   * `{minutes}` 分钟数。注册表把它追加在生产者结局之后（实测 `signal: SIGTERM; …`），
   * 不带它就与"用户手工 job_kill 掉了这次重建"完全同形。
   */
  readonly jobReasonTimeout: string;
  /** 写进官方注册表 `detail` 的卸载理由（无变量）。 */
  readonly jobReasonUnload: string;

  // ── /_dsh/zvec-grep/* 端点回显给人的错误 ───────────────────────────────────
  /** root 参数不合法：`{reason}`。 */
  readonly endpointRootInvalid: string;
  /** root 不在观测白名单内：`{root}`。 */
  readonly endpointRootUntracked: string;
  /** root 目录已消失：`{root}`。 */
  readonly endpointRootGone: string;
  /** 启动重建进程失败：`{reason}`。 */
  readonly endpointStartFailed: string;
  /** 宿主没提供 ctx.jobs（官方注册表未装载）⇒ 重建动作端点直接回答不可用，无降级形态。 */
  readonly endpointJobsUnavailable: string;
  /**
   * 名册里同 id 的那条作业诞生在**另一枚**注册表实例里（`jobs` 那一行被重载 ⇒ 计数器从头
   * 分配）。继续起就会把旧面板指向另一棵树，故拒绝并请用户重载插件。`{limit}` 无关。
   */
  readonly endpointRegistryReplaced: string;
  /**
   * 官方容量闸拒了这次启动（未拥有作业共用一只桶，实测满员是**拒绝**而不是淘汰在跑的）：
   * `{limit}` 是宿主给的上限。取的是错误里那个数字，不把宿主英文原话贴进卡片。
   */
  readonly endpointJobsAtCapacity: string;
  /** jobId 已移出历史窗口：`{maxJobs}`。 */
  readonly unknownJobId: string;
  /** 应答只回尾部若干字符：`{shown}`、`{total}`。 */
  readonly jobOutputView: string;

  // ── lib/cli.ts 的入参校验文本（纯函数用，字典由调用点注入）────────────────
  /** 文本超上限：`{name}`、`{maxChars}`、`{actual}`。 */
  readonly textTooLong: string;
  /** 非字符串：`{name}`、`{received}`。 */
  readonly mustBeString: string;
  /** 含 NUL 字节：`{name}`。 */
  readonly noNulBytes: string;
  /** 非布尔：`{name}`、`{received}`。 */
  readonly mustBeBoolean: string;
  /** 传输模式非法：`{received}`、`{allowed}`。 */
  readonly clientModeInvalid: string;
  /** 预览档位非法：`{received}`、`{allowed}`。 */
  readonly previewInvalid: string;
  /** 刷新策略非法：`{received}`、`{allowed}`。 */
  readonly refreshInvalid: string;
  /** 符号类型不在 zg 闭集内：`{received}`、`{allowed}`。 */
  readonly symbolTypeInvalid: string;
  /** `..` 越出文件系统根：`{path}`。 */
  readonly rootEscapesFs: string;
  /** root 非字符串：`{received}`。 */
  readonly rootMustBeString: string;
  /** root 缺失（内部调用面）。 */
  readonly rootRequired: string;
  /** root 非绝对路径：`{path}`。 */
  readonly rootMustBeAbsolute: string;
  /** root 是文件系统根目录。 */
  readonly rootIsFsRoot: string;
  /** root 缺失（可省略时的完整出路）。 */
  readonly rootRequiredWithFallback: string;
  /** 非字符串数组：`{name}`。 */
  readonly mustBeStringArray: string;
  /** 数组超条数：`{name}`、`{maxItems}`、`{actual}`。 */
  readonly tooManyItems: string;
  /** 数组含非字符串项：`{name}`、`{received}`。 */
  readonly nonStringItem: string;
  /** 整条命令超上限：`{length}`、`{maxChars}`。 */
  readonly commandTooLong: string;
  /** 检索路由超上限：`{count}`、`{max}`。 */
  readonly tooManyQueryRoutes: string;
  /** zg_search 一条路由都没有。 */
  readonly searchNeedsQuery: string;
  /** 穷举模式缺 pattern：`{name}`。 */
  readonly exhaustiveNeedsPattern: string;
  /** 穷举模式收到索引侧参数：`{names}`。 */
  readonly exhaustiveConflicts: string;
  /** 显式 embedding 不在本地清单、且部署未开放远程：`{reference}`、`{choices}`。 */
  readonly embeddingNotAllowed: string;
  /** drop 与 resetPaths 互斥。 */
  readonly dropWithResetPaths: string;
  /** 无索引时自动改走穷举检索的前置说明。 */
  readonly exhaustiveFallbackNote: string;
  /** 穷举检索不发放 grep/rg 配额。 */
  /** 穷举模式参数说明（模型侧）。 */
  readonly rgDescription: string;
  /** 整数旗标（收到值也交代）：`{name}`、`{min}`、`{received}`。 */
  readonly intWithReceived: string;
  /** 整数旗标：`{name}`、`{min}`。 */
  readonly intRequired: string;

  // ── lib/routing.ts 的 guard 拒绝理由 ──────────────────────────────────────
  /** root 判据与 execute 同源：`{name}`、`{reason}`。 */
  readonly guardRootRejected: string;
  /** zg_index 未确认。 */
  readonly guardIndexConfirmRequired: string;
  /** 既无 root 也无会话工作区：`{name}`。 */
  readonly guardAbsoluteRootRequired: string;
  /** 门禁状态：从未 zg_search。 */
  readonly gateNeverSearched: string;
  /** 门禁状态：配额用尽。 */
  readonly gateQuotaExhausted: string;
  /** 门禁状态：解锁过期。 */
  readonly gateUnlockExpired: string;
  /** 门禁拒绝正文：`{state}`、`{indexRoot}`、`{indexDir}`、`{budget}`、`{windowMin}`。 */
  readonly gateReason: string;
}

/** 中文侧「绝对路径 + 可操作范围」那句共用文案（三个 root 参数同义、同一份判据）。 */
const ABSOLUTE_ROOT_HINT_ZH =
  "工作区绝对路径（可选：缺省=当前会话工作区；显式传入时须在本会话可操作范围内——" +
  "会话工作区本身、其上级或下级、或本会话已登记过的工作区）";

/** 英文侧「绝对路径 + 可操作范围」那句共用文案（检索/索引两个 root 参数同义）。 */
const ABSOLUTE_ROOT_HINT =
  "Absolute workspace path (optional: default = current session workspace; when passed explicitly it " +
  "must stay inside this session's operable scope — the workspace itself, its parents or children, " +
  "or a workspace this session already registered)";

export const MESSAGES: MessagesCatalog<ZvecGrepMessages> = {
  zh: {
    searchToolDescription:
      "对已建索引的工作区做语义/混合检索（BM25+向量+RRF），用于精确查找无法回答的问题：架构、调用链、依赖、生命周期、数据流/控制流、设计意图、跨文件对比与综合。root 缺省为当前会话工作区；显式传入时必须落在本会话可操作范围内（会话工作区本身、它的上级或下级目录，或本会话已登记过的工作区）。检索会自动同步既有索引的新鲜度（--refresh wait），因此改完代码无需先手动 zg_index 也能搜到新内容；但从未建索引的 root 仍会明确报错，不会静默建索引。每个命中都带**有界源码片段**（--preview short：锚点行 + 少量上下文），足够时视为已读证据，需要更多上下文再 read。精确字面/正则/文件名/报错串查找请用原生 grep/glob。大型工作区请用 globs/fileTypes 缩小范围，否则可能超时。至少提供 query/queries/fts/vector 之一。已建索引的工作区 grep/rg 受 search-first 门禁约束：每次成功的 zg_search 会为当前会话解锁 grepBudgetPerSearch 次 grep/rg（unlockWindowMin 分钟内有效），配额用尽或过期后需换一个更准确的 query/fts 重新检索。",
    indexToolDescription:
      "为工作区 root 创建/增量更新/重建/删除持久检索索引（建后 zg_search 才可用）。仅在用户明确要求建/重建/删索引时调用，且 confirm 必须为 true；绝不静默建索引。root 缺省为当前会话工作区；显式传入时必须落在本会话可操作范围内——会话工作区本身、它的上级或下级目录，或本会话已登记过的工作区；其余绝对路径一律拒绝（一个合法绝对路径不构成授权）。embedding 默认用设置里的 defaultEmbedding，也可显式指定，但**只接受本地候选清单内的模型**（远程 embedding 会把工作区内容送到外部端点，须由用户在部署配置里显式开放，模型侧无法开启）；切换 embedding 需 rebuild=true 才重新生效。删除传 drop=true。要清掉这个根继承来的文件选择设置传 resetPaths=true。",
    statusToolDescription:
      "查询工作区 root 的索引状态（是否已建、文件数、freshness、活动任务）。用于索引缺失/失败/取消后的诊断或显式进度监控；普通搜索前不要调用。",
    // 三个 root 参数走同一个 rootOf()，放行路径是同三条，故**共用一条文案**而不是抄三份：
    // 少写一条，模型就会以为某条合法路径被拒而绕路（第二组要求的「文案与行为完全一致」）。
    rootSearchDescription: ABSOLUTE_ROOT_HINT_ZH,
    rootIndexDescription: ABSOLUTE_ROOT_HINT_ZH,
    rootStatusDescription: ABSOLUTE_ROOT_HINT_ZH,
    queryDescription: "单个混合查询（语义+词法）",
    queriesDescription: "多个混合查询组",
    ftsDescription: "词法查询组（如标识符、报错串）",
    vectorDescription: "纯语义查询组",
    fuseDescription: "融合所有组为单一排名",
    limitDescription: "每组最大条数 1-50，默认 10",
    previewDescription:
      "每条命中带的源码片段大小：none 只给锚点行、short 给锚点加一段有界上下文、full 给整段源码。默认 short",
    refreshDescription:
      "检索前如何刷新索引：wait 等刷新到最新（默认）、off 不刷新、background 交给守护进程后台刷新。注意 background 只在守护进程模式下成立，直连模式下 zg 会降级成 off 并在 stderr 提示",
    globsDescription: "路径 glob（如 src/**），单个字符串或数组",
    globsIndexDescription: "路径 glob",
    insensitiveGlobsDescription: "大小写不敏感 glob",
    fileTypesDescription: "文件类型（如 ts、py）",
    fileTypesIndexDescription: "文件类型",
    excludedFileTypesDescription: "排除的文件类型",
    symbolTypesDescription: "符号类型过滤",
    preferSymbolDescription: "优先精确符号",
    modifiedAfterDescription: "只搜该时间后修改的文件",
    modifiedBeforeDescription: "只搜该时间前修改的文件",
    deviceDescription: "auto/cpu/metal/vulkan/cuda；默认 auto（Metal 加速，失败自动回退 CPU）",
    resetPathsDescription:
      "清掉这个根继承来的文件选择设置（globs/fileTypes/hidden/… 全部回到未设置），只影响本次写入的索引配置；可与 globs/fileTypes 同传（先清干净再按这次的规则选），但与 drop 互斥",
    confirmDescription: "用户已明确要求本次建/重建/删索引，必须为 true",
    embeddingDescription:
      "本地 embedding 模型引用（默认取设置 defaultEmbedding）。只接受本地清单内的模型；远程 embedding 会把工作区内容送到外部端点，须由用户在部署配置里显式开放，本插件不接受模型侧开启",
    rebuildDescription: "重建已有索引（切换 embedding 时必须为 true）",
    dropDescription: "删除索引（与其它索引选项互斥）",
    ignoreFilesDescription:
      "额外的 ignore 文件路径（如 .gitignore 之外的排除清单），透传 zg --ignore-file",
    excludeSecretsDescription:
      "是否默认排除私钥/密钥库格式（*.pem/*.key/*.p12/*.pfx/*.keystore/id_rsa*），默认 true；仅在明确需要索引此类文件时置 false",
    hiddenDescription: "包含隐藏文件（默认不含，隐藏密钥文件因此已被排除）",
    noIgnoreDescription: "不读 ignore 文件",
    maxDepthDescription: "最大目录深度",
    maxFileSizeBytesDescription: "单文件大小上限（字节）",
    followDescription: "跟随符号链接",
    embeddingConcurrencyDescription: "embedding 并发数",
    routingText: [
      "# zvec-grep（zg）工作区检索规则",
      "",
      "本环境的工作区检索路由：",
      "- 工作区已建 zg 索引（存在 .zvec-grep/ 目录）时：所有检索必须先调用 zg_search（语义/混合，命中更全更准）；grep/rg 只作为 zg_search 之后的精确字面/正则补充。每次成功的 zg_search 解锁少量 grep/rg 配额（次数/时效见设置），配额用尽或过期后门禁会再次拦截，此时应换一个更准确的 query/fts 重新 zg_search。门禁同时覆盖 bash 里的 grep/rg 命令与原生 grep 工具。",
      "- 无索引工作区：zg_search 会自动改走**穷举词法检索**（逐行字面匹配，结果里会有一条前置声明）。" +
        "精确查找（单个定义、字面量、文件名、配置键、报错信息、正则、穷举列表）用 zg_search 就够，" +
        "不必先 zg_index（那要先下载 embedding 权重）。也可显式 rg=true 强制它，或 rg=false 拒绝改道。" +
        "穷举检索是纯字面匹配，回答不了「这个模块的职责是什么」这类语义问题——那类问题仍应先建索引。",
      "- 穷举检索**不发放** grep/rg 配额：它不读索引，不构成「先用过语义检索」的证据。" +
        "有索引的工作区想用 grep/rg，仍要先走一次索引检索。",
      "- 语义/关系/跨文件/多跳证据（架构、调用链、依赖、生命周期、数据流或控制流、设计意图、对比、跨文件综合）→ 必须先调用 zg_search。",
      "- zg_status 只用于索引缺失/失败/取消后的诊断或显式进度监控；普通搜索前不要调用。",
      "",
      "zg 规则：",
      "1. 有索引的工作区先用 zg_search 定向发现，不要先做宽泛的文件枚举或直接 grep。",
      "2. zg_search 结果已含有界源片段，视为已读证据；仅当所需细节在片段外时才用 read 打开对应文件/行段。",
      "3. 证据足够即停止搜索，不为重复确认而重复相似查询或扩大排查。",
      "4. zg_index 仅在用户明确要求建/重建/删索引时调用，且 confirm 必须为 true；绝不静默建索引。",
      "5. 新建索引用用户选定的 embedding，未选定时不得臆测；切换 embedding 需 rebuild 才生效。",
      "6. zg_* 的 root 可省略：缺省为当前会话工作区（绝对路径）。显式传入时必须落在本会话可操作范围内——" +
        "会话工作区本身、它的上级或下级目录，或本会话已登记过的工作区；其余绝对路径会被拒绝。",
    ].join("\n"),
    argsMustBeObject: "zg {name}: 参数必须是一个 JSON 对象（收到 {received}）",
    missingRequiredArgs: "zg {name}: 缺少必填参数 {fields}（缺失即拒绝，不产生副作用）",
    sandboxFacts: "（沙箱 mode={mode}{enforcement}）",
    sandboxEnforcement: "、enforcement={value}",
    runnerFailed:
      "zg 未执行：沙箱 runner 启动失败{facts}。请检查沙箱后端配置（这与 zg 是否安装无关）。",
    sandboxDenied: "沙箱策略拒绝了一次文件操作{facts}",
    detailMiddle: "{head} …[中间省略]… {tail}",
    timeoutFailure:
      "zg 执行超时：检索默认带 --refresh wait（同步刷新既有索引），大型工作区可能耗时过长。" +
      "请用 globs / fileTypes 缩小范围后重试，或先用手写 grep/glob。",
    abortedFailure: "zg 执行被中止",
    rebuildWaitTimeout:
      "等待 {root} 的重建完成超时（约 {seconds} 秒），重建可能仍在进行；请稍后重试。" +
      "本次不会发放 grep/rg 配额——重建期间索引不可读，先等它结束。",
    rebuildWaitAborted: "等待 {root} 的重建完成时被中止。",
    statusRebuilding:
      "{root} 正在重建中（作业 {jobId}）。重建期间索引不可读，检索会自动等待它完成后重试。" +
      "如需查看实时输出，请在设置卡的工作区重建面板里观察。此刻即使问「索引是否就绪」也是否定的答案——重建落定后再问。",
    statusNotReady:
      "[zvec-grep] {root} 的索引**未就绪**（上面是 zg 的完整就绪报告）。这不是执行失败，" +
      "而是 checkReady=true 要的那个结论：{detail}",
    checkReadyDescription:
      "就绪判定：就绪报告照常给出，另行判定索引是否 ready 并在结论里明说。未就绪不是执行失败，报告仍会返回",
    traceDescription:
      "排障用：每条命中附一行检索轨迹，说明它被哪几路召回、在各组里名次如何，并给出分值。输出会明显变长；穷举检索（rg）模式不支持该参数",
    indexBackgroundStarted:
      "已在后台为 {root} 启动索引（作业 {jobId}），命令：{command}。索引落定前该根的语义检索会等它完成再重试，grep/rg 在这段时间不受门禁限制。用 zg_status 查就绪与否；本次调用不发放 grep/rg 配额",
    backgroundDescription:
      "后台执行：起一条 zg 进程并把可轮询的作业号交回，本次调用立即返回。建索引可能要下载 embedding 权重、等很久，后台执行免得工具调用一直挂着。落定前该根的语义检索会自动等它完成再重试",
    endpointRebuildInFlight: "该工作区已有一条重建正在进行，请稍后再试。",
    indexRebuildInFlight:
      "{root} 已有一条重建在进行中，本次未执行——并发重建会互相顶掉并双双失败。" +
      "请等它结束后再试，或用 zg_status 查看那条重建的状态。",
    rootNotAuthorized:
      "root 未获授权：{root} 不在本会话可操作范围内（当前会话工作区：{cwd}）。" +
      "只能检索/建索引本会话工作区本身、它的上级或下级目录，以及本会话已登记过的工作区。" +
      "若确实需要另一个工作区，请让用户新开一个会话到那里。",
    rootNoSession: "（无会话工作区）",
    deniedFailure:
      "zg 执行失败（exit={exit}）：{denied}——本次检索目标不在该会话可读写范围内，" +
      "请换工作区或让用户批准更宽的文件策略。{detail}",
    notInstalledFailure: "zg 未安装或不在 PATH：请先 `npm install -g @zvec/zvec-grep`。{detail}",
    rootApprovalReason:
      "模型为 {root} 指定了一个既不是本会话工作区、也不是本会话登记过的工作区" +
      "（当前会话工作区：{cwd}）。该路径会把这个目录的内容读进上下文。",
    rootApprovalPrompt:
      "允许这一次对 {root} 建立/读取 zg 索引吗？该目录的内容会进入本次会话上下文，" +
      "且只对这一次调用生效。",
    zgVersionTooOld:
      "zg 版本过低：当前 {actual}，本插件要求 >= {minimum}。本插件下发的命令形态与旗标名按该版本书写，太老的 zg 可能把命令当成别的东西执行、给出看起来正常实则什么都没查的结果——所以在发命令前就停在这里。请先升级：`npm install -g @zvec/zvec-grep@latest`，然后重试。",
    genericFailure: "zg 执行失败（exit={exit}）{detail}",
    detailPrefix: " 详情：{detail}",
    detailColon: "：{detail}",
    outputTruncated:
      "[zvec-grep] 注意：输出超过 {maxBytes} 字节上限，已截断，仅保留尾部{spill}。" +
      "如需完整结果请缩小检索范围（更精确的 query / 更小的 limit / 更窄的 root）。",
    spillNote: "（完整输出已落盘：{path}）",
    sandboxWarning:
      "[zvec-grep] 警告：{denied}——下面的结果可能缺少被拒读写的文件，" +
      "别把它当成全工作区的完整检索结论。",
    stderrNote:
      "[zvec-grep] zg stderr（可能含降级提示，如退化为纯词法检索 / 跳过 --refresh）：{marked}{tail}",
    hitSummary:
      "[zvec-grep] 命中摘要：{groups} 个查询组，分组计数合计 {grouped} 条{dedup}；请求 --limit {limit}{capped}{truncated}",
    hitDedup: "，去重后 {unique} 个不同位置",
    hitCapped:
      "（有组的命中数正好等于 --limit；zg 不提供截断信号，此处只陈述计数，不推断是否还有更多）",
    hitTruncated: "；输出已截尾，计数只含保留部分",
    rootMissing: "root 目录不存在（zg 需要真实存在的工作区路径）：{root}",
    jobOutputTruncated: "\n[zvec-grep] 输出过长，已截断，只保留尾部",
    jobOutputLost:
      "\n[zvec-grep] 注意：执行器缓冲区溢出，zg 输出有**丢失**（下方不是完整日志）；" +
      "完整过程请看 zg 自身日志或缩小重建范围。",
    rebuildRunnerFailed: "\n[zvec-grep] 重建失败：沙箱 runner 启动失败{facts}（zg 未被执行）。",
    rebuildDenied:
      "\n[zvec-grep] 重建过程中{denied}，索引可能不完整——请检查该会话的文件策略" +
      "（read-only 下 zg 无法写 .zvec-grep/）。",
    rebuildTimeout: "\n[zvec-grep] 重建超时（超过 {minutes} 分钟）已被强制终止",
    jobReasonTimeout: "重建超过 {minutes} 分钟，由 zvec-grep 回收",
    jobReasonUnload: "zvec-grep 插件卸载",
    endpointRootInvalid: "root 无效：{reason}",
    endpointRootUntracked: "root 不在本 daemon 观测到的工作区白名单内：{root}（可从卡片候选里选）",
    endpointRootGone: "root 目录已不存在：{root}",
    endpointStartFailed: "启动重建失败：{reason}",
    endpointJobsUnavailable:
      "后台重建不可用：宿主未提供 ctx.jobs（@deepseek-ai/dsh-jobs-local 未装载），本插件不再自带任务注册表",
    endpointRegistryReplaced:
      "后台作业服务已被替换（新注册表重新从同一个 id 开始签发作业），本次重建已放弃并终止：" +
      "请重载 zvec-grep 插件后再发起，否则旧面板会跟着另一棵树的作业走",
    endpointJobsAtCapacity:
      "后台作业已满（宿主上限 {limit} 条，进行中与正在收尾的都计数），本次重建未启动：" +
      "请先在模型侧用 job_kill 收掉不再需要的作业，再重新发起重建",
    unknownJobId:
      "unknown jobId（这条重建记录已移出历史窗口：本插件只保留最近 {maxJobs} 条已结束的重建，" +
      "超限时最老的已结束记录先被移除；进行中的重建不会被顶掉，但并发满员时新的启动请求会被直接拒绝。" +
      "请重新发起重建）",
    jobOutputView: "\n[zvec-grep]（仅显示尾部 {shown} 字符，共 {total} 字符）",
    textTooLong: "{name} 超过 {maxChars} 字符上限（实际 {actual}）",
    mustBeString: "{name} 必须是字符串（收到 {received}）",
    noNulBytes: "{name} 不能包含 NUL 字节",
    mustBeBoolean: "{name} 必须是布尔值（收到 {received}）",
    clientModeInvalid: "zg 传输模式非法：{received}（合法取值：{allowed}）",
    previewInvalid: "预览档位非法：{received}（合法取值：{allowed}）",
    refreshInvalid: "刷新策略非法：{received}（合法取值：{allowed}）",
    symbolTypeInvalid: "符号类型非法：{received}（合法取值：{allowed}，只接受小写）",
    rootEscapesFs: "root 含越界的 .. 段：{path}",
    rootMustBeString: "root 必须是字符串（收到 {received}）",
    rootRequired: "root 必填，且为工作区绝对路径",
    rootMustBeAbsolute: "root 必须是绝对路径（以 / 开头）：{path}",
    rootIsFsRoot: "root 不能是文件系统根目录 /",
    rootRequiredWithFallback: "root 必填，且为工作区绝对路径（可省略：缺省为当前会话工作区）",
    mustBeStringArray: "{name} 必须是字符串数组",
    tooManyItems: "{name} 最多 {maxItems} 项（实际 {actual}）",
    nonStringItem: "{name} 含非字符串项（{received}）",
    commandTooLong: "zg 命令总长 {length} 超过 {maxChars} 字符上限，请缩小检索范围",
    tooManyQueryRoutes: "检索路由合计 {count} 组，超过 {max} 组上限",
    searchNeedsQuery: "zg_search 需要 query/queries/fts/vector 至少其一",
    exhaustiveNeedsPattern: "穷举检索（rg=true）需要一个 query 作为匹配模式",
    exhaustiveConflicts:
      "穷举检索（rg=true）与下列索引侧参数互斥：{names}。穷举是纯词法匹配，不支持这些参数；把它们去掉，或先建索引（zg_index）再用索引检索",
    embeddingNotAllowed:
      "embedding 引用 {reference} 不在本地候选清单内，而本部署未开放远程 embedding。远程 embedding 会把工作区内容送到外部端点，必须由用户在部署配置里显式开放（allowRemoteEmbedding），本插件不接受模型侧开启。可选本地模型：{choices}。若用户确已自行配好远程凭据（zg config provider set / zg auth grant <root> --capability embedding --scope workspace），请在插件部署配置里打开对应开关后重试。",
    dropWithResetPaths:
      "drop 与 resetPaths 互斥：--drop 整条命令只有删除索引一件事，resetPaths 无处安放（上游 zg 也拒这一对）。要清继承的文件选择设置，请不要传 drop。",
    exhaustiveFallbackNote:
      "[zvec-grep] 该工作区（含向上各级）尚无 zg 索引，已自动改用穷举词法检索（rg 模式）。结果是逐行字面匹配，不是语义相关度排序；需要语义检索请先 zg_index 建索引。",
    rgDescription:
      "穷举词法检索（对应 zg query --rg）：不需要索引，逐行字面匹配。留空则在工作区无索引时自动改用它、有索引时照常走索引检索。显式 false 可要求只用索引检索（无索引即报错）。它不支持 preview / refresh / fuse / symbolTypes / preferSymbol / fts / vector / queries，且不发放 grep/rg 配额",
    intWithReceived: "{name} 必须是 >= {min} 的整数（收到 {received}）",
    intRequired: "{name} 必须是 >= {min} 的整数",
    guardRootRejected: "{name} 的 root 不被接受：{reason}",
    guardIndexConfirmRequired:
      "zg_index 会创建/重建/删除持久索引，必须由用户明确要求且 confirm 为 true 才能调用",
    guardAbsoluteRootRequired: "{name} 需要绝对 root 路径（可省略：缺省为当前会话工作区）",
    gateNeverSearched: "尚未执行过 zg_search",
    gateQuotaExhausted: "grep/rg 配额已用尽",
    gateUnlockExpired: "上一次 zg_search 的解锁已过期",
    gateReason:
      "[zvec-grep] 工作区检索门禁（{state}）：当前工作区已建 zg 索引（{indexRoot}/{indexDir}），" +
      "直接 grep/rg 字面检索经常漏检。请先调用 zg_search（语义/混合检索，覆盖面与相关性更好；" +
      "把当前检索目标作为 query/fts），每次成功的 zg_search 解锁 {budget} 次 grep/rg" +
      "（{windowMin} 分钟内有效），用于精确字面/正则补充。",
  },
  en: {
    searchToolDescription:
      "Semantic/hybrid search (BM25 + vector + RRF) over an indexed workspace, for questions exact " +
      "lookup cannot answer: architecture, call chains, dependencies, lifecycles, data/control flow, " +
      "design intent, cross-file comparison and synthesis. root defaults to the current session " +
      "workspace; you may also name another already-indexed absolute path. Search refreshes the " +
      "existing index automatically (--refresh wait), so code edited moments ago is searchable " +
      "without re-running zg_index; a root that was never indexed still fails loudly rather than " +
      "silently building an index. Every hit carries a **bounded source snippet** (--preview short: " +
      "anchor line plus a little context) — treat it as read evidence when enough, otherwise read " +
      "for more context. Use the native grep/glob for exact literal/regex/filename/error-string " +
      "lookups. Narrow large workspaces with globs/fileTypes or the search may time out. Provide at " +
      "least one of query/queries/fts/vector. In indexed workspaces grep/rg is gated by " +
      "search-first: each successful zg_search unlocks grepBudgetPerSearch grep/rg calls for the " +
      "current session (valid for unlockWindowMin minutes); once the quota is spent or expired, " +
      "re-search with a more precise query/fts.",
    indexToolDescription:
      "Create / incrementally update / rebuild / delete the persistent search index for workspace " +
      "root (zg_search only works after that). Call it only when the user explicitly asks to " +
      "build/rebuild/drop the index, and confirm must be true; never index silently. root defaults " +
      "to the current session workspace; another absolute path may be named explicitly (a target the " +
      "user confirmed). embedding defaults to the configured defaultEmbedding and may be set " +
      "explicitly, but **only models in the local catalog are accepted** (remote embedding sends " +
      "workspace content to an external endpoint and must be enabled explicitly by the user in the " +
      "deployment config — the model side cannot turn it on); switching embedding only takes effect " +
      "with rebuild=true. Pass drop=true to delete. Pass resetPaths=true to clear the file-selection " +
      "settings this root inherited.",
    statusToolDescription:
      "Query the index status of workspace root (indexed or not, file count, freshness, running " +
      "jobs). Use it to diagnose a missing/failed/cancelled index or to watch progress explicitly; " +
      "do not call it before a normal search.",
    rootSearchDescription: ABSOLUTE_ROOT_HINT,
    rootIndexDescription: ABSOLUTE_ROOT_HINT,
    rootStatusDescription: ABSOLUTE_ROOT_HINT,
    queryDescription: "Single hybrid query (semantic + lexical)",
    queriesDescription: "Multiple hybrid query groups",
    ftsDescription: "Lexical query groups (identifiers, error strings)",
    vectorDescription: "Purely semantic query groups",
    fuseDescription: "Fuse all groups into a single ranking",
    limitDescription: "Max hits per group, 1-50, default 10",
    previewDescription:
      "How much source each hit carries: none anchor line only, short anchor plus a bounded context window, full the whole chunk. Default short",
    refreshDescription:
      "How the index is refreshed before searching: wait refresh to the latest (default), off does not refresh, background hands it to the daemon. Note that background only holds in daemon mode; in direct mode zg degrades it to off and says so on stderr",
    globsDescription: "Path globs (e.g. src/**), a single string or an array",
    globsIndexDescription: "Path globs",
    insensitiveGlobsDescription: "Case-insensitive globs",
    fileTypesDescription: "File types (e.g. ts, py)",
    fileTypesIndexDescription: "File types",
    excludedFileTypesDescription: "File types to exclude",
    symbolTypesDescription: "Symbol kind filter",
    preferSymbolDescription: "Prefer exact symbol matches",
    modifiedAfterDescription: "Only search files modified after this time",
    modifiedBeforeDescription: "Only search files modified before this time",
    deviceDescription:
      "auto/cpu/metal/vulkan/cuda; default auto (Metal acceleration, falls back to CPU on failure)",
    resetPathsDescription:
      "Clear the file-selection settings this root inherited (globs/fileTypes/hidden/… all go back " +
      "to unset), affecting only the index config written this time. May be combined with " +
      "globs/fileTypes (clear first, then apply this call's rules), but conflicts with drop",
    confirmDescription: "The user explicitly asked for this index build/rebuild/drop; must be true",
    embeddingDescription:
      "Local embedding model reference (defaults to defaultEmbedding setting). Only models in the " +
      "local catalog are accepted; remote embedding sends workspace content to an external endpoint " +
      "and must be enabled explicitly by the user in the deployment config — this plugin never lets " +
      "the model side enable it",
    rebuildDescription: "Rebuild the existing index (must be true when switching embedding)",
    dropDescription: "Delete the index (mutually exclusive with the other index options)",
    ignoreFilesDescription:
      "Extra ignore-file paths (exclusion lists beyond .gitignore), passed through as " +
      "zg --ignore-file",
    excludeSecretsDescription:
      "Whether to exclude private-key/keystore formats by default (*.pem/*.key/*.p12/*.pfx/" +
      "*.keystore/id_rsa*), default true; set false only when such files genuinely must be indexed",
    hiddenDescription:
      "Include hidden files (excluded by default, which also drops hidden key files)",
    noIgnoreDescription: "Do not read ignore files",
    maxDepthDescription: "Maximum directory depth",
    maxFileSizeBytesDescription: "Per-file size limit (bytes)",
    followDescription: "Follow symbolic links",
    embeddingConcurrencyDescription: "Embedding concurrency",
    routingText: [
      "# zvec-grep (zg) workspace search rules",
      "",
      "Search routing for this environment:",
      "- When the workspace has a zg index (a .zvec-grep/ directory exists): every search must call " +
        "zg_search first (semantic/hybrid, broader and more precise hits); grep/rg only as the exact " +
        "literal/regex follow-up after zg_search. Each successful zg_search unlocks a small grep/rg " +
        "quota (count/window in the settings); once it is spent or expired the gate blocks again and " +
        "you should re-run zg_search with a more precise query/fts. The gate covers both grep/rg " +
        "commands inside bash and the native grep tool.",
      "- Workspaces without an index: zg_search falls back to **exhaustive lexical search** " +
        "(literal line-by-line matching, with a note saying so in front of the results). For exact " +
        "lookups (a single definition, literals, file names, config keys, error messages, regexes, " +
        "exhaustive lists) zg_search is enough — there is no need to zg_index first, which would " +
        "mean downloading embedding weights. Pass rg=true to force it, or rg=false to refuse the " +
        'fallback. Exhaustive search is purely literal and cannot answer questions like "what is ' +
        'this module responsible for" — for those, build an index first.',
      "- Exhaustive search grants **no** grep/rg quota: it reads no index, so it is not evidence " +
        "that semantic search has been used. In an indexed workspace, still run one indexed search " +
        "before reaching for grep/rg.",
      "- Semantic / relational / cross-file / multi-hop evidence (architecture, call chains, " +
        "dependencies, lifecycles, data or control flow, design intent, comparisons, cross-file " +
        "synthesis) → always call zg_search first.",
      "- zg_status is only for diagnosing a missing/failed/cancelled index or explicit progress " +
        "watching; do not call it before a normal search.",
      "",
      "zg rules:",
      "1. In an indexed workspace start with zg_search to aim the discovery; do not enumerate files " +
        "broadly or grep first.",
      "2. zg_search results already carry bounded source snippets — treat them as read evidence; " +
        "only use read when the detail you need lies outside the snippet.",
      "3. Stop searching once the evidence is sufficient; do not repeat similar queries or widen the " +
        "hunt just to re-confirm.",
      "4. Call zg_index only when the user explicitly asks to build/rebuild/drop the index, and " +
        "confirm must be true; never index silently.",
      "5. Use the embedding the user picked for a new index; never guess when none was chosen. " +
        "Switching embedding requires rebuild to take effect.",
      "6. root may be omitted for zg_* tools: it defaults to the current session workspace (absolute " +
        "path). When passed explicitly it must stay inside this session's operable scope — the " +
        "workspace itself, its parents or children, or a workspace this session already registered; " +
        "any other absolute path is rejected.",
    ].join("\n"),
    argsMustBeObject: "zg {name}: arguments must be a JSON object (received {received})",
    missingRequiredArgs:
      "zg {name}: missing required arguments {fields} (refused outright, no side effects)",
    sandboxFacts: " (sandbox mode={mode}{enforcement})",
    sandboxEnforcement: ", enforcement={value}",
    runnerFailed:
      "zg never ran: the sandbox runner failed to start{facts}. Check the sandbox backend " +
      "configuration (this is unrelated to whether zg is installed).",
    sandboxDenied: "the sandbox policy denied a file operation{facts}",
    detailMiddle: "{head} …[middle omitted]… {tail}",
    timeoutFailure:
      "zg timed out: search defaults to --refresh wait (it refreshes the existing index " +
      "synchronously), which can take long on large workspaces. Retry with a narrower globs / " +
      "fileTypes range, or use hand-written grep/glob first.",
    abortedFailure: "zg execution was aborted",
    rebuildWaitTimeout:
      "timed out after about {seconds}s waiting for the rebuild of {root}; it may still be running. " +
      "Retry later. No grep/rg quota is granted: the index is unreadable while the rebuild runs.",
    rebuildWaitAborted: "aborted while waiting for the rebuild of {root} to finish",
    statusRebuilding:
      "{root} is being rebuilt (job {jobId}). The index is unreadable while the rebuild runs; " +
      "searches wait for it to finish and retry. Watch live output in the settings card rebuild panel. " +
      "Asking whether the index is ready right now would get a negative answer anyway — ask again " +
      "once the rebuild settles.",
    statusNotReady:
      "[zvec-grep] the index for {root} is **not ready** (the full zg readiness report is above). " +
      "This is not an execution failure, it is the conclusion checkReady=true asked for: {detail}",
    checkReadyDescription:
      "Readiness verdict: the readiness report is still returned, and the tool additionally states " +
      "whether the index is ready. Not-ready is not an execution failure — the report still comes back",
    traceDescription:
      "For troubleshooting: every hit carries a search trace saying which routes recalled it, its rank " +
      "in each group, and its score. Output gets noticeably longer; exhaustive (rg) search does not " +
      "support this parameter",
    indexBackgroundStarted:
      "Indexing for {root} started in the background (job {jobId}), command: {command}. Until it " +
      "settles, semantic search on that root waits for it and retries, and grep/rg are not subject to " +
      "the gate during that window. Use zg_status to check readiness; this call grants no grep/rg quota",
    backgroundDescription:
      "Run in the background: starts a zg process, hands back a pollable job id and returns " +
      "immediately. Building an index may download embedding weights and take a long time, so " +
      "background execution keeps the tool call from hanging. Semantic search on that root waits for " +
      "it to settle and retries",
    endpointRebuildInFlight: "a rebuild of this workspace is already running; retry shortly.",
    indexRebuildInFlight:
      "a rebuild of {root} is already running, so this call was not executed — concurrent rebuilds " +
      "cancel each other. Retry after it finishes, or check it with zg_status.",
    rootNotAuthorized:
      "root is not authorized: {root} is outside this session's operable scope (session workspace: {cwd}). " +
      "Only this session's workspace, its parents and children, and workspaces already registered by " +
      "this session may be searched or indexed. To work on another workspace, ask the user to start a " +
      "new session there.",
    rootNoSession: "(no session workspace)",
    deniedFailure:
      "zg failed (exit={exit}): {denied} — this search target is outside what the session may read " +
      "and write; switch workspace or ask the user to approve a broader file policy. {detail}",
    notInstalledFailure:
      "zg is not installed or not on PATH: run `npm install -g @zvec/zvec-grep` first. {detail}",
    rootApprovalReason:
      "the model named {root} for this call, which is neither the current session workspace " +
      "nor a workspace this session registered (current session workspace: {cwd}). That path reads " +
      "that directory's content into the conversation context.",
    rootApprovalPrompt:
      "Allow this one call to build/read the zg index for {root}? Its content enters this session's " +
      "context, and the permission covers this single call only.",
    zgVersionTooOld:
      "zg is too old: found {actual}, this plugin requires >= {minimum}. The command shape and flag " +
      "names this plugin sends are written against that version, and an older zg may execute them " +
      "as something else — returning results that look normal but searched nothing — so the call " +
      "stops here before any command is sent. Upgrade with " +
      "`npm install -g @zvec/zvec-grep@latest`, then retry.",
    genericFailure: "zg failed (exit={exit}){detail}",
    detailPrefix: " details: {detail}",
    detailColon: ": {detail}",
    outputTruncated:
      "[zvec-grep] note: output exceeded the {maxBytes} byte limit and was truncated, only the " +
      "tail is kept{spill}. Narrow the search for full results (sharper query / smaller limit / " +
      "narrower root).",
    spillNote: " (full output spilled to {path})",
    sandboxWarning:
      "[zvec-grep] warning: {denied} — the result below may be missing files that were denied; " +
      "do not treat it as a complete whole-workspace conclusion.",
    stderrNote:
      "[zvec-grep] zg stderr (may contain degradation notes, e.g. falling back to pure lexical " +
      "search / skipping --refresh): {marked}{tail}",
    hitSummary:
      "[zvec-grep] hit summary: {groups} query group(s), {grouped} hit(s) in grouped counts" +
      "{dedup}; requested --limit {limit}{capped}{truncated}",
    hitDedup: ", {unique} distinct location(s) after dedup",
    hitCapped:
      " (some group's hit count equals --limit; zg gives no truncation signal, so this states the " +
      "count only and infers nothing about further hits)",
    hitTruncated: "; output truncated, the count covers only the kept part",
    rootMissing: "root directory does not exist (zg needs a real workspace path): {root}",
    jobOutputTruncated: "\n[zvec-grep] output too long, truncated — only the tail is kept",
    jobOutputLost:
      "\n[zvec-grep] note: the executor's buffer overflowed, so zg output **lost** bytes (below is " +
      "not the full log); read zg's own log or narrow the rebuild.",
    rebuildRunnerFailed:
      "\n[zvec-grep] rebuild failed: the sandbox runner did not start{facts} (zg was never executed).",
    rebuildDenied:
      "\n[zvec-grep] during the rebuild {denied} — the index may be incomplete; check this " +
      "session's file policy (read-only cannot write .zvec-grep/).",
    rebuildTimeout: "\n[zvec-grep] rebuild killed after exceeding {minutes} minutes",
    jobReasonTimeout: "rebuild reclaimed by zvec-grep after {minutes} minutes",
    jobReasonUnload: "zvec-grep plugin unloaded",
    endpointRootInvalid: "invalid root: {reason}",
    endpointRootUntracked:
      "root is not in the workspace whitelist this daemon observed: {root} (pick one of the card's " +
      "candidates)",
    endpointRootGone: "root directory no longer exists: {root}",
    endpointStartFailed: "failed to start the rebuild: {reason}",
    endpointJobsUnavailable:
      "background rebuild unavailable: the host provides no ctx.jobs (dsh-jobs-local is not loaded); " +
      "this plugin no longer ships its own job registry",
    endpointRegistryReplaced:
      "the background job service was replaced (a fresh registry restarts id numbering), so this " +
      "rebuild was abandoned and its process terminated: reload the zvec-grep plugin before retrying, " +
      "otherwise a stale panel would follow a different workspace's job",
    endpointJobsAtCapacity:
      "background jobs are at the host's limit ({limit} slots; running and stopping both count), so this " +
      "rebuild never started: stop what you no longer need with job_kill, then start the rebuild again",
    unknownJobId:
      "unknown jobId (this rebuild record left the history window: the plugin keeps the most recent " +
      "{maxJobs} finished rebuilds and drops the oldest settled one first; running rebuilds are never " +
      "displaced, but a start request is refused outright once the concurrent limit is reached. " +
      "Start the rebuild again)",
    jobOutputView: "\n[zvec-grep] (showing only the last {shown} of {total} characters)",
    textTooLong: "{name} exceeds the {maxChars} character limit (actual {actual})",
    mustBeString: "{name} must be a string (received {received})",
    noNulBytes: "{name} must not contain NUL bytes",
    mustBeBoolean: "{name} must be a boolean (received {received})",
    clientModeInvalid: "invalid zg client mode: {received} (allowed: {allowed})",
    previewInvalid: "invalid preview mode: {received} (allowed: {allowed})",
    refreshInvalid: "invalid refresh policy: {received} (allowed: {allowed})",
    symbolTypeInvalid: "invalid symbol type: {received} (allowed: {allowed}; lowercase only)",
    rootEscapesFs: "root contains a .. segment that escapes the filesystem root: {path}",
    rootMustBeString: "root must be a string (received {received})",
    rootRequired: "root is required and must be an absolute workspace path",
    rootMustBeAbsolute: "root must be an absolute path (starting with /): {path}",
    rootIsFsRoot: "root must not be the filesystem root /",
    rootRequiredWithFallback:
      "root is required and must be an absolute workspace path (it may be omitted: defaults to the " +
      "current session workspace)",
    mustBeStringArray: "{name} must be an array of strings",
    tooManyItems: "{name} allows at most {maxItems} items (actual {actual})",
    nonStringItem: "{name} contains a non-string item ({received})",
    commandTooLong:
      "the zg command is {length} characters, over the {maxChars} character limit — narrow the search",
    tooManyQueryRoutes: "{count} query routes in total, over the limit of {max}",
    searchNeedsQuery: "zg_search needs at least one of query/queries/fts/vector",
    exhaustiveNeedsPattern: "exhaustive search (rg=true) needs a query to use as the pattern",
    exhaustiveConflicts:
      "exhaustive search (rg=true) conflicts with these indexed-search parameters: {names}. " +
      "Exhaustive search is pure lexical matching and does not support them; drop them, or build " +
      "an index first (zg_index) and search the index",
    embeddingNotAllowed:
      "embedding reference {reference} is not in the local catalog, and this deployment has not " +
      "enabled remote embedding. Remote embedding sends workspace content to an external endpoint " +
      "and must be turned on explicitly by the user in the deployment config (allowRemoteEmbedding); " +
      "this plugin never lets the model side enable it. Local choices: {choices}. If the user has " +
      "already set up remote credentials themselves (zg config provider set / zg auth grant <root> " +
      "--capability embedding --scope workspace), enable the matching deployment setting and retry.",
    dropWithResetPaths:
      "drop conflicts with resetPaths: --drop does nothing but delete the index, so resetPaths has " +
      "nowhere to go (upstream zg rejects the pair too). To clear inherited file-selection settings, " +
      "do not pass drop.",
    exhaustiveFallbackNote:
      "[zvec-grep] This workspace (and every directory above it) has no zg index, so the search fell " +
      "back to exhaustive lexical matching (rg mode). Results are literal line matches, not ranked by " +
      "semantic relevance; run zg_index first if you need semantic search.",
    rgDescription:
      "Exhaustive lexical search (zg query --rg): needs no index, matches literal text line by line. " +
      "Leave it unset to fall back to it automatically when the workspace has no index, and to use " +
      "the index when one exists. An explicit false demands indexed search only (an error when there " +
      "is no index). It does not support preview / refresh / fuse / symbolTypes / preferSymbol / fts " +
      "/ vector / queries, and it grants no grep/rg quota",
    intWithReceived: "{name} must be an integer >= {min} (received {received})",
    intRequired: "{name} must be an integer >= {min}",
    guardRootRejected: "the root given to {name} is not accepted: {reason}",
    guardIndexConfirmRequired:
      "zg_index creates/rebuilds/deletes a persistent index and requires an explicit user request " +
      "with confirm true",
    guardAbsoluteRootRequired:
      "{name} needs an absolute root path (it may be omitted: defaults to the current session workspace)",
    gateNeverSearched: "no zg_search has run yet",
    gateQuotaExhausted: "the grep/rg quota is spent",
    gateUnlockExpired: "the unlock from the last zg_search has expired",
    gateReason:
      "[zvec-grep] workspace search gate ({state}): this workspace already has a zg index " +
      "({indexRoot}/{indexDir}), and plain grep/rg frequently misses things. Call zg_search first " +
      "(semantic/hybrid, better coverage and relevance; pass the current target as query/fts). Each " +
      "successful zg_search unlocks {budget} grep/rg calls valid for {windowMin} minutes, to be used " +
      "for exact literal/regex follow-up.",
  },
};

/**
 * `{name}` 占位符插值（与官方 locale 的 Translate 参数语义同源）。
 *
 * host 侧没有官方 translator，字典里的模板要自己填；缺键（占位符没给值）一律替成
 * 空串——文案是给人看的，不该因为一个占位符打断工具调用。
 * @param template - 字典里的模板。
 * @param params - 占位符名 → 值（null 照实渲染成 "null"，与旧模板字符串一致）。
 * @returns 填好的文本。
 */
export function fill(template: string, params: Record<string, string | number | null>): string {
  return template.replaceAll(/\{(?<key>\w+)\}/gu, (_all: string, key: string) => {
    const value = params[key];
    return value === undefined ? "" : String(value);
  });
}
