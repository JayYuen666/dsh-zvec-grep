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
  /** 策略拒绝导致的失败：`{exit}`、`{denied}`、`{detail}`。 */
  readonly deniedFailure: string;
  /** zg 未安装（exit 127）：`{detail}`。 */
  readonly notInstalledFailure: string;
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
  /** 命中摘要（官方 grep 惯例：总数/上限/截断事实显式化）：`{groups}`、`{hits}`、`{limit}`、`{capped}`、`{truncated}`。 */
  readonly hitSummary: string;
  /** 命中摘要的「已达上限」片段（可能还有未显示的命中）。 */
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

export const MESSAGES: MessagesCatalog<ZvecGrepMessages> = {
  zh: {
    searchToolDescription:
      "对已建索引的工作区做语义/混合检索（BM25+向量+RRF），用于精确查找无法回答的问题：架构、调用链、依赖、生命周期、数据流/控制流、设计意图、跨文件对比与综合。root 默认取当前会话工作区，也可显式指定其它已建索引的绝对路径。检索会自动同步既有索引的新鲜度（--refresh wait），因此改完代码无需先手动 zg_index 也能搜到新内容；但从未建索引的 root 仍会明确报错，不会静默建索引。每个命中都带**有界源码片段**（--preview short：锚点行 + 少量上下文），足够时视为已读证据，需要更多上下文再 read。精确字面/正则/文件名/报错串查找请用原生 grep/glob。大型工作区请用 globs/fileTypes 缩小范围，否则可能超时。至少提供 query/queries/fts/vector 之一。已建索引的工作区 grep/rg 受 search-first 门禁约束：每次成功的 zg_search 会为当前会话解锁 grepBudgetPerSearch 次 grep/rg（unlockWindowMin 分钟内有效），配额用尽或过期后需换一个更准确的 query/fts 重新检索。",
    indexToolDescription:
      "为工作区 root 创建/增量更新/重建/删除持久检索索引（建后 zg_search 才可用）。仅在用户明确要求建/重建/删索引时调用，且 confirm 必须为 true；绝不静默建索引。root 默认取当前会话工作区，也可显式指定其它绝对路径（需用户确认过的目标）。embedding 默认用设置里的 defaultEmbedding，也可显式指定；切换 embedding 需 rebuild=true 才重新生效。删除传 drop=true。",
    statusToolDescription:
      "查询工作区 root 的索引状态（是否已建、文件数、freshness、活动任务）。用于索引缺失/失败/取消后的诊断或显式进度监控；普通搜索前不要调用。",
    rootSearchDescription:
      "工作区绝对路径（可选：缺省=当前会话工作区；跨会话检索其它 root 时显式指定）",
    rootIndexDescription:
      "工作区绝对路径（可选：缺省=当前会话工作区；跨会话操作其它 root 时显式指定）",
    rootStatusDescription: "工作区绝对路径（可选：缺省=当前会话工作区）",
    queryDescription: "单个混合查询（语义+词法）",
    queriesDescription: "多个混合查询组",
    ftsDescription: "词法查询组（如标识符、报错串）",
    vectorDescription: "纯语义查询组",
    fuseDescription: "融合所有组为单一排名",
    limitDescription: "每组最大条数 1-50，默认 10",
    globsDescription: "路径 glob（如 src/**）",
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
    confirmDescription: "用户已明确要求本次建/重建/删索引，必须为 true",
    embeddingDescription: "本地 embedding 模型引用（默认取设置 defaultEmbedding）",
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
      "- 无索引工作区：精确查找（单个定义、字面量、文件名、配置键、报错信息、正则、穷举列表）→ 用原生 grep / glob / read。",
      "- 语义/关系/跨文件/多跳证据（架构、调用链、依赖、生命周期、数据流或控制流、设计意图、对比、跨文件综合）→ 必须先调用 zg_search。",
      "- zg_status 只用于索引缺失/失败/取消后的诊断或显式进度监控；普通搜索前不要调用。",
      "",
      "zg 规则：",
      "1. 有索引的工作区先用 zg_search 定向发现，不要先做宽泛的文件枚举或直接 grep。",
      "2. zg_search 结果已含有界源片段，视为已读证据；仅当所需细节在片段外时才用 read 打开对应文件/行段。",
      "3. 证据足够即停止搜索，不为重复确认而重复相似查询或扩大排查。",
      "4. zg_index 仅在用户明确要求建/重建/删索引时调用，且 confirm 必须为 true；绝不静默建索引。",
      "5. 新建索引用用户选定的 embedding，未选定时不得臆测；切换 embedding 需 rebuild 才生效。",
      "6. zg_* 的 root 可省略：缺省为当前会话工作区（绝对路径）；显式传入时必须是 daemon 可见的绝对路径。",
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
    deniedFailure:
      "zg 执行失败（exit={exit}）：{denied}——本次检索目标不在该会话可读写范围内，" +
      "请换工作区或让用户批准更宽的文件策略。{detail}",
    notInstalledFailure: "zg 未安装或不在 PATH：请先 `npm install -g @zvec/zvec-grep`。{detail}",
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
      "[zvec-grep] 命中摘要：{groups} 个查询组，共 {hits} 条命中；请求 --limit {limit}{capped}{truncated}",
    hitCapped: "（已达单组上限，可能还有未显示的命中）",
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
      "explicitly; switching embedding only takes effect with rebuild=true. Pass drop=true to delete.",
    statusToolDescription:
      "Query the index status of workspace root (indexed or not, file count, freshness, running " +
      "jobs). Use it to diagnose a missing/failed/cancelled index or to watch progress explicitly; " +
      "do not call it before a normal search.",
    rootSearchDescription:
      "Absolute workspace path (optional: default = current session workspace; name it explicitly " +
      "when searching another root)",
    rootIndexDescription:
      "Absolute workspace path (optional: default = current session workspace; name it explicitly " +
      "when operating on another root)",
    rootStatusDescription:
      "Absolute workspace path (optional: default = current session workspace)",
    queryDescription: "Single hybrid query (semantic + lexical)",
    queriesDescription: "Multiple hybrid query groups",
    ftsDescription: "Lexical query groups (identifiers, error strings)",
    vectorDescription: "Purely semantic query groups",
    fuseDescription: "Fuse all groups into a single ranking",
    limitDescription: "Max hits per group, 1-50, default 10",
    globsDescription: "Path globs (e.g. src/**)",
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
    confirmDescription: "The user explicitly asked for this index build/rebuild/drop; must be true",
    embeddingDescription: "Local embedding model reference (defaults to defaultEmbedding setting)",
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
      "- Workspaces without an index: exact lookups (a single definition, literals, file names, " +
        "config keys, error messages, regexes, exhaustive lists) → use the native grep / glob / read.",
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
        "path); when passed explicitly it must be an absolute path the daemon can see.",
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
    deniedFailure:
      "zg failed (exit={exit}): {denied} — this search target is outside what the session may read " +
      "and write; switch workspace or ask the user to approve a broader file policy. {detail}",
    notInstalledFailure:
      "zg is not installed or not on PATH: run `npm install -g @zvec/zvec-grep` first. {detail}",
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
      "[zvec-grep] hit summary: {groups} query group(s), {hits} hit(s) total; requested " +
      "--limit {limit}{capped}{truncated}",
    hitCapped: " (per-group cap reached; more hits may exist)",
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
