# @jayyuen66/dsh-zvec-grep

[English](./README.md) · [简体中文](./README.zh-CN.md)

### 它做什么

- 给 dsh 会话接上工作区语义检索：注册 zg_search / zg_index / zg_status 三个模型工具，底层经宿主 shell 以 `--mode direct` 调 zg CLI（BM25 + 向量 + RRF 混合检索）。
- 注入一段 systemPrompt 硬规则（`zvec-grep-routing`，order 1550）+ 两道 tools.guard：zg_* 安全兜底与 search-first 门禁（已建索引的工作区里，grep/rg 前必须先有一次成功的 zg_search）。
- 附带 web 端设置卡：默认 embedding、limit、search-first 配额/时效，以及「工作区重建」按钮。

### 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-zvec-grep
```

- 包在公共 npm 上，安装不需要凭据；发布态产物只有 host.js、client.js、cordis.patch.yml（package.json 的 files）。
- 运行期值 import `@jayyuen66/dsh-plugin-shared`（lib/http、lib/locale、lib/text）与 `@deepseek-ai/schemastery`（宿主 fork：0.1.7 的 `.volatile()` 解析只有它有实现，公共 schemastery 既没这个方法、解析出的也仍是普通值），装不上就是 ERR_MODULE_NOT_FOUND。
  - shared 的 `lib/text` 自己值导入 `@deepseek-ai/dsh-output-retention`，所以那枚宿主包也得在提供面上：本包按 `schemastery` 同一口径处理（非 optional `peerDependencies` + `devDependencies` 同枚精确版本，**不进 `dependencies`**）。这条只能靠门禁钉：漏它时本包的类型检查、构建与测试全绿，故障只在装出去之后以 ERR_MODULE_NOT_FOUND 出现。
  - 只有 shared 那枚在 `dependencies` 里。`@deepseek-ai/schemastery` 是宿主包：声明为**非 optional 的 `peerDependencies`**，并在 `devDependencies` 里以同一枚精确版本再写一份给本包的编译与测试用——它**不进 `dependencies`**。这条不是风格偏好：消费侧 profile 的安装布局是 `nodeLinker: hoisted` 且 `autoInstallPeers: false`，宿主包一旦进了 `dependencies` 就会被落成真实目录，与宿主进程已加载的那份并存；而 `@deepseek-ai/dsh-tools` 的 `TOOL_RUNTIME_SCHEDULER` 是普通 `Symbol`（不是 `Symbol.for`），符号身份按模块实例计算，宿主 `dsh-agent-loop` 于是读到 `undefined`，每一次原生工具调用都抛 `Cannot read properties of undefined (reading 'prepare')`，整个 profile 的工具一起失效——本包的构建、类型检查与测试在这之前全部照绿。判据钉在 `test/publish-manifest.test.ts`。

### 在 dsh 里启用

- add/remove 按包内 cordis.patch.yml 维护注册行 `- id: zvec-grep`（name 指向本包）；该文件由 `package.json` 的 `dsh.bundle.patch` 指向。
- 宿主兼容性按 **peer 声明**判，不按 `engines.dsh`：装配前逐条比对 `@deepseek-ai/dsh` 与每一枚 `@deepseek-ai/dsh-*` 的区间与当前 runtime 版本，prerelease 也参与匹配（官方口径见 dsh-app-boot README）。不符即该条目被拒；组合包（bundle）没有豁免时整枚跳过并列进 `skippedBundles`。
  - 本包把 `dsh-*` 一律**精确钉**（`test/publish-manifest.test.ts` 的要求，理由是「装出第二份宿主类型面」比版本冲突更坏），所以**高于 `0.2.1-alpha.2` 的宿主同样需要授权**，出路是宿主点名的那句：`dsh plugin --profile web allow-version @jayyuen66/dsh-zvec-grep@<版本> --dsh-version <确切版本> --accept-risk`。
  - `engines.dsh` 只是声明，无人读；`>= 0.2.1-alpha.2` 与 peer 同值仅为不留下互相矛盾的数。
- `dsh.client.platform` 为 web 且 immediately，设置卡的 client 半随宿主下发；bundle 安装走 pnpm（>= 12.3.0）。
- apply 需要 settings/shell/tools/systemPrompt/timer 五个服务面：它们都在 `inject` 里，缺任一 cordis 就不激活本条目（宿主启动诊断点名 `pending (waiting for service: …)`）；apply 里的守卫再兜一层，ctx 形状不对时抛 `required services … missing`。
  - 三条 `/_dsh/zvec-grep/*` 端点挂在 `inject(["webServer"])` 的子 fiber 上：宿主没有 webServer（如 TUI）时子 fiber 不激活，端点不存在而工具照常。真实宿主上 webServer 比本条目晚到位约 1 秒，所以这里必须是依赖、不能只在 apply 里 `ctx.get` 读一次。

### 提供给模型的工具

- zg_search：query / queries / fts / vector 至少其一（合计 <= 32 组，单条 <= 4000 字符）。
  - 可加 globs / insensitiveGlobs / fileTypes / excludedFileTypes / symbolTypes / preferSymbol / modifiedAfter / modifiedBefore / fuse / limit / preview / refresh / device。
  - `globs` / `insensitiveGlobs` / `fileTypes` / `excludedFileTypes` 既收**单个字符串**也收字符串数组（与上游 zg 对这几项的对外契约一致，最多 128 项、单项 <= 1024 字符）。
  - `symbolTypes` 绑定 zg 的真实闭集，取值**只认小写**：`module` / `class` / `interface` / `function` / `value` / `alias`。zg 侧 `--symbol-type Class` 会以非零码退出（`Unsupported symbol type: Class`），插件在构造命令前就拦下并列出合法取值；不做大小写折叠——悄悄改成小写等于替模型改了它没写的约束。
  - `preview` 三档：`none` 只给锚点行 / `short` 锚点加一段有界上下文 / `full` 整段源码，**默认 short**，每条命中自带有界源码片段。
  - `refresh` 三档：`wait` 等索引刷到最新（**默认**）/ `off` 不刷新 / `background` 交给守护进程后台刷新。`background` 只在守护进程模式下成立：直连模式下 zg 不报错，而是降级成 `off` 并往 stderr 打一行 `warning: --refresh background requires Server mode; Direct mode uses --refresh off`——本包把 stderr 原样回显，那一行会自己到模型眼前。
  - 输出尾部附一行**命中摘要**，两栏口径分开给：`分组计数合计`（各查询组 `hits:` 之和）与`去重后 N 个不同位置`（按「相对路径 + 行号范围」去重）。分栏是因为同一处代码会被多组各命中一次（名次与匹配来源逐组变化），直接求和会把同一处位置重复计入、冒充命中总数。
  - 某组命中数正好等于 `--limit` 时只作**观察陈述**并显式说明「zg 不提供截断信号，此处不作断言」——zg 的输出没有任何截断标记，不能把"可能还有未显示的命中"说成事实。输出被宿主按 stdout 上限截尾时另附「只含保留部分」。
- zg_index：confirm 必填且必须为 true（required 校验 + guard 双层拒绝）。
  - `background=true` 走**模型侧后台索引**：一次调用把「起 zg 进程 + 登记进官方作业注册表 + 挂超时回收」全做完，把可轮询的作业号交回后**立即返回**。建索引可能要下载 embedding 权重、等很久，后台执行免得工具调用一直挂着。
    - 不依赖宿主作业工具：宿主作业工具在 web 平面已停用，模型侧那条路根本不可走。插件复用与设置卡**完全相同**的 spawn/登记/占位三步（同一个函数，不是复制品），所以两条入口起的作业在名册、状态投影、轮询端点上完全同形——卡片能看见模型起的索引，反之亦然。
    - 占位与设置卡的重建互斥，且跨入口成立：同根已在跑索引写时，模型侧与卡片侧都只会跟随那一条，不会各起一条 zg 去啃同一份索引。
    - 官方作业注册表缺席时**根本不起进程**并直接报错：起一条没有环、没有容量、也没人能收的 zg 比不起更糟——它会一直占着同根的写锁，把这棵树的后续索引全堵死。
    - 落定前该根的语义检索会等它完成再自动重试，期间 grep/rg 不受门禁限制。
  - 另有 embedding / rebuild / drop / resetPaths / globs / insensitiveGlobs / fileTypes / excludedFileTypes / ignoreFiles / excludeSecrets / hidden / noIgnore / maxDepth / maxFileSizeBytes / follow / embeddingConcurrency / device；其中五个路径过滤项同样收单值或数组。
  - 切换 embedding 必须 rebuild=true 才生效。
  - **显式 embedding 走构造期 allowlist**：只接受本地候选清单（与设置卡下拉同一份）里的模型，其余引用在命令构造前就被拒并给出可行动文案。理由是能力面的性质——远程 embedding 会把工作区内容送到外部端点，而模型能凭空写出一个任意前缀的引用；这是「工作区内容会不会被送出本机」的闸门，只能由用户在部署配置里开（见部署值一节）。
  - `resetPaths=true` 透传 `--reset-paths`，清掉这个根**继承来的**文件选择设置（globs/fileTypes/hidden/…）。它与 globs/fileTypes **不互斥**（上游是先清、再按本次请求盖上去），与 `drop` 互斥（构造期直接拒，不静默丢弃）。
- zg_status：root + checkReady，用于索引缺失/失败/取消后的诊断或显式看进度。
  - `checkReady=true` 透传 `--check-ready`。注意它的真实契约：**就绪报告照常打在 stdout，只用退出码表达就绪与否**。所以未就绪不是执行失败，插件把报告原样交回，另附一行「索引未就绪……这不是执行失败，而是 checkReady=true 要的那个结论」并带上 zg 的原始判据。走普通失败路径只会留下 stderr 那一句，恰好把用户最需要的报告扔掉。
  - 报告为空时的非零退出仍按失败抛，不凭空造一份报告；未开 `checkReady` 时非零退出照旧抛错。
  - 与后台重建作业状态整合：同根正在重建时（作业已登记）直接给重建投影，**不启子进程**——此刻「索引是否就绪」的答案本就是否定的，报一个 `not ready` 反而不如直接告诉它「重建中，作业 X，落定后再问」。
- **无索引时的首选路径**：`zg_search` 带 `rg` 开关走 zg 的穷举词法通道（`zg query --rg`），不需要索引。
  - `rg` 留空（缺省）：工作区**及其向上各级**都没有索引时自动改走穷举检索，有索引则照常走索引检索。自动改道会在结果前加一条前置声明，说明「这是逐行字面匹配，不是语义相关度排序，需要语义检索请先 zg_index」——不声明就等于把与请求不符的答案当成语义结论递出去。
  - `rg=true` 强制穷举；`rg=false` 拒绝改道，只用索引检索（无索引时由 zg 报 `WORKSPACE_INDEX_NOT_FOUND` 并附建索引提示）。
  - 穷举检索**不发放** grep/rg 配额：它不读索引，不构成「先用过语义检索」的证据。有索引的工作区想用 grep/rg，仍要先走一次索引检索。
  - 穷举通道的合法旗标与索引通道不同。zg 会拒绝 `preview` / `refresh` / `symbol-type` / `prefer-symbol` / `fuse` / `fts` / `vector`（实测报错如 `--preview is not supported with --rg; use -A/-B/-C for rg context`），插件在构造阶段就拦下并列出冲突项，不静默丢弃。`limit` / `glob` / `iglob` / `type` / `type-not` / `modified-after` / `modified-before` / `device` / `mode` 照常生效。
  - 穷举输出没有 `hits:` 计数行，故命中摘要按「不数就不谎称」自动不出。
  - `trace` 透传 `--trace`（排障用）：每条命中附一行检索轨迹，说明它被哪几路召回、在各组里的名次，并给出分值。输出会明显变长；穷举模式不支持该参数（构造阶段即拒绝）。
  - 开 `trace` 时条目头行会多出 `score=` 与选择理由标记；命中摘要的**去重键会剥掉这两段**——实测同一处位置在两个组里分值可以不同（`src/beta.ts:1-2` 在 fts 组是 0.0164、在 vector 组是 0.0161），带分值入键会让每条命中都成「新位置」，去重直接失效、位置数虚高一倍。
- 三者的 root 都可省略（缺省=当前会话工作区）；输出为纯文本；超时分别为 5 分钟 / 10 分钟 / 60 秒，stdout 上限 400000 字节（超限截尾并提示）。

### 设置项与检索根

- 命名空间 `zvec-grep` 由宿主**隐式**注册（0.1.7 起 = profile 条目 id，插件侧不再有 `settings.register`）；schema 共十四个字段，其中卡上那六枚标 `.volatile()`，内置默认逐字段写在 `.default()` 上。
  - defaultEmbedding=local/qwen3-embedding-0.6b、defaultLimit=10（1-50）、hfEndpoint=国内可达的 HF 兼容镜像基址（可改成别的镜像或留空走官方 HF）。
  - enforceSearchFirst=true、grepBudgetPerSearch=3（1-20）、unlockWindowMin=10（1-240）。
- 另有**非 volatile 部署值**（不进设置卡，只在 cordis.yml 的行 config 里改值；上面工具一节的「5 分钟 / 10 分钟 / 60 秒 / 400000 字节」就是它们的默认）：searchTimeoutMs=300000、statusTimeoutMs=60000、indexTimeoutMs=600000（也是后台重建 kill 定时器的时长）、stdoutMaxBytes=400000、clientMode=auto、rebuildWaitMs=120000，超时/缓冲几项均最小 1。
  - 远程 embedding 三件套，默认**全关**：`allowRemoteEmbedding=false`、`remoteEmbeddingEndpoint=""`、`remoteEmbeddingApiKeyFrom=""`。
    - 关着的时候，显式 embedding 引用在**命令构造期**就必须落在本地候选清单里。
    - 打开后端点与凭据**只经环境变量**下发给 zg 子进程（`ZVEC_GREP_ENDPOINT` / `ZVEC_GREP_API_KEY`），**绝不进 argv**——本包把整条命令当作业 label 回显给卡片，argv 里的密钥会进界面、进日志、进 `ps` 的进程表。
    - 凭据那项填的是**宿主进程里那个装凭据的环境变量名**（如 `ZVEC_GREP_API_KEY`），不是密钥本身：宿主 subprocess 层会把名字含 KEY/SECRET/TOKEN 的继承变量剔掉，必须由本插件显式转发才到得了 zg；只记名字也让密钥不必落进插件配置文件。
    - 本插件**不自动传 `--allow-remote`**：zg 还要用户自己跑一次 `zg auth grant <root> --capability embedding --scope workspace` 才肯发请求，那道按 root 的授权本插件不代劳。
  - `requireApprovalForExplicitRoot=false`：打开后，三个 zg 工具里**显式给了 root**、且那个 root 既不是本会话工作区、也不在本会话已登记范围内时，会经官方 `tools/pre-execute → {kind:'ask'} → ctx.approval` 弹一次用户确认。默认关，且有三个已知边界：`danger-full-access` 预设把 `approval/policy` 写成 `never`（ask 会被确定性拒绝）、委派子代理被钉死 `approvalPolicy: 'never'`（**该开关对子代理无效**）、宿主没装 approval 服务时 fail-closed 成拒绝。这道确认**只加不减**：`rootOf` 的授权判据一字未改，越界的 root 即便「用户已批准」照旧被拒。
- 优先级：设置里的运行时值 > 组合包层/用户层行的 config > schema 的 `.default()`；行 config 中显式缺省的字段不覆盖默认。读侧是 `config.<field>.get()`（volatile 引用，卡上改完下一个事件即生效）；非 volatile 部署值是普通值形态，不经 `.get()`。
- root 校验：必须是以 `/` 开头的绝对路径，词典归一折叠空段与 `.`。
  - 拒绝空串、非字符串、含 NUL、相对路径、越出文件系统根的 `..`，归一后为 `/` 也拒。
  - 目录不存在时单报「root 目录不存在」，不冒成 spawn ENOENT。
- guard 与 execute 用同一套 root 判据，避免「guard 放行、execute 抛错」说两遍。
- 解锁按「会话 × 索引根」计：每次成功 zg_search 重置为 grepBudgetPerSearch 次、unlockWindowMin 分钟有效；索引根是 root 自身或含索引的最近祖先（最多上溯 8 层）。
  - 分片用的会话是**根会话**：沿 `header.parentSession` 一路上溯到最顶层那一跳。故同一棵委派树上的主代理与子代理**共享一份额度**——主代理搜过一次，子代理随即就能用那几次 grep/rg，不必各自再搜一次（它们搜的往往是同一棵树）。
  - 上溯的降级是三级的，都不抛错：自身即顶层就用自己；某一跳查不到它的父（会话已落定，或宿主没装会话存储）就停在**已知的最后一跳**；链成环就停在首次重复前。跳数有上限。
- 「含索引」的判据是 `<root>/.zvec-grep/manifest.json` 在盘上，**只判 `.zvec-grep` 目录名不够**：这个名字同时是 zg 自己的全局 home（`ZVEC_GREP_HOME ?? ~/.zvec-grep`，装的是 config.json / locks / models），只判目录名会让一个从未建索引、只是祖先目录撞名的普通工作区也被门禁拦下。
- enforceSearchFirst=false 只关掉门禁，zg_* 的安全兜底（confirm、root 判据）不受影响。

### 外部依赖（rg）

- 真正的二进制依赖是 zg（由 `npm install -g @zvec/zvec-grep` 提供）：不在 PATH 时 shell 回 exit 127，工具据此回「zg 未安装或不在 PATH」，与「沙箱 runner 没起来」分开归因。
- 上游即 `@zvec/zvec-grep`（它提供 `zg` 这枚 bin），仓库 https://github.com/zvec-ai/zvec-grep，许可 **Apache-2.0**。本包是它之上的 dsh 适配层：只经宿主 shell 调那枚 CLI，不含上游源码，也不替上游做任何形式的分发。
  - 版本下限 `0.2.2`（`lib/zg-version.ts` 的 `MINIMUM_ZG_VERSION`）。低于它就在**下发命令之前**停住并点名实际版本：命令形态与旗标名是按那个版本写的，更老的 zg 可能把同一串 argv 解成别的东西，给出「看着正常、其实什么都没查」的结果。
- 本地 embedding 由 zg 侧后端加载：qwen3/embeddinggemma 走 llama-cpp（device=auto 时试 Metal、失败回退 CPU），potion-* 走 model2vec，其余走 transformers-js 纯 JS。
  - 权重按 hfEndpoint 注入 HF_ENDPOINT 后下载。
- 本包不依赖也不调用 ripgrep：rg 只出现在门禁判据里。
  - bash/pwsh 命令串经引号/注释感知切词后，命令位上的 grep/egrep/fgrep/rg 与原生 grep 工具才算检索。
  - `--help`/`--version`/`-V`、`echo "grep x"`、`git commit -m "use rg"` 不算。
- 有沙箱执行器时会区分 runner 失败、策略拒绝与 zg 自身失败，并在结果里显式打「可能不完整」标记。

### 对外接口

- 三条路由的 handler 第一句都是 `guardTrust(req, res, { servingNonLoopback })`（`shared/lib/trust`），任一判据不过即 `403` + `{ ok:false, error: ... }`。
  - 判据次序：Host 权威 → `sec-fetch-site` 白名单 → `origin` 与 Host 逐字比对；两句错误文本是 `"untrusted host authority"` 与 `"cross-origin request rejected"`。
  - `servingNonLoopback` 由 `isNonLoopbackBindHost(webServer.host)` 按**绑定地址本身**算出（宿主只拒通配地址，绑本机网卡的具体 IPv4/IPv6 是合法配置，比字面量会漏判这一面）；非本方法的 `405` 带 `Allow` 与 `{ ok:false, error:"GET only" | "POST only" }`，不再是空回显。
- `GET /_dsh/zvec-grep/rebuild-roots`：只回本包自己的数据（每次 apply 重新生成的 CSRF token + 已观测工作区列表），允许 GET/HEAD，过不了上面那道闸门即 403。
- `POST /_dsh/zvec-grep/rebuild?root=...`：闸门 + 头 `x-zvec-grep-csrf` + body <= 4096 字节 + root 命中白名单 + 目录存在，成功回 `{ ok, jobId }`；否则 405/403/400/500。
- `/_dsh/zvec-grep/rebuild-status?jobId=...`：闸门后轮询（卡片每 2 秒一次），回 status/exitCode/root/output（有沙箱时带 sandbox），未知 jobId 回 404 并说明多半是出了本包那条 10 条落定窗口。
- 另有 systemPrompt 段 `zvec-grep-routing`（order 1550）与 settings 命名空间 `zvec-grep`。
  - 白名单只记本 daemon 真实观测到的会话工作区，容量 64（超出按插入序淘汰）。
  - 同时能跑几个重建由**宿主注册表**决定（实测默认未拥有桶 10），本包不再自带并发上限；
    满员时 `POST /rebuild` 直接回 500 并带上官方的点名文案，**不会**再杀掉已经在跑的重建。
  - `rebuild-status` 的 `jobId` 只在本包侧表里查得到：本包保留最近 10 条**已结束**的记录
    （超出即从注册表 remove ⇒ 404），进行中的记录永不被动。

### 后台作业面（官方 `ctx.jobs`）

本包不自带任务注册表了：一次「工作区重建」是宿主 `ctx.jobs` 里的一枚**未拥有**作业
（`kind: "zvec-grep-rebuild"` ⇒ id `zvec-grep-rebuild-N`）。这带来三件看得见的变化：

| 面                      | 事实                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模型侧能看见了          | 官方 `job_list` / `job_output` / `job_kill` 现在列得出这次重建，退出码与信号名走作业的 `detail`（口径与宿主的 bash 工具同形，实测 `plugins/docs/harness/f3-equiv/probe-jobs.mjs`）。输出走官方 **pull source**（`proc.observed[*].readFrom`）⇒ 环由注册表按它自己的节拍推进，**设置面板关着也照样前进**；官方那条观察者面与 `readOutput()` 互不偷字节（d.ts 原文 "without stealing bytes from `readOutput`"）。controller 只在 `start` 那一瞬挂、摘掉即恢复官方拒绝（见跨包纪律） |
| 未拥有 ⇒ 对全部会话可见 | 官方件按 owner 隔离，未拥有作业任何 caller 都能 `list`/`read`/`kill`。这是本波**已知并接受**的暴露面（卡片是会话外的 webServer 生产者，受有作业则要 `dsh-agent` 注册表，实测不可得）。要收回去只有一条路：回滚这次换装。注意 `/_dsh/zvec-grep/rebuild-status` 仍只认本包侧表里的 id，别人的作业（如宿主的 `bash-1`）经这个端点读不到                                                                                                                                              |
| 多了两个状态词          | `stopping`（取消已发出、进程还没收完 ⇒ 卡片按「仍在跑」显示）与 `failed`（注册表侧判定失败 ⇒ 给专门文案，不显示成「退出码 null」）                                                                                                                                                                                                                                                                                                                                                |

不留存的东西也写清楚：输出环按 **UTF-8 字节**留存（实测宿主默认 262144 字节），卡片的 4000 字符尾窗与 `shown/total` 按 **UTF-16 码元**计——两套单位各管各的。因此 `total` 说的是**留存窗内**的码元数（官方那个字节真值在 `view.output.total`，单位不同不混用），而中文输出下这只窗比换装前（按码元留 256 KiB）**小约 1/3**，这是采用官方件的代价。两条丢失标记各说一件事：`已截断` = 环按留存窗裁掉了头部（`view.output.earliest > 0`，看不见了）；`缓冲区溢出` = 执行器的读者报 lossy 或干脆抛了（真少了字节，可能有 spill 文件）。超时说明与沙箱事实**不进环**：环的写权归注册表的泵，而它在落定之后丢弃一切写入（实测），所以这两条由端点在投影时合成，永远不会因为"写晚了"而消失。注册表被重载或记录被别人收走时轮询答 **404**（官方 `get`/`readAt` 对未知 id 抛错，而宿主对 handler 抛出的兜法是记一条日志再写一枚没有 body、没有 content-type 的 **400**，只有头已发时才断掉 socket —— installed dsh-host-webserver `lib/index.js:246-256` ⇒ 卡片会进终止态并停轮询，那条还在跑的重建就再也看不见）。

### 数据与隐私

- 索引的唯一落盘形状是被检索 root 下的 `.zvec-grep/` 目录，由 zg 写入（read-only 沙箱下写不了它，会明确报索引可能不完整）。
- 重建有两条路：模型侧 `zg_index`（rebuild=true、confirm=true），或设置卡「工作区重建」走上面的 rebuild 路由；删除是 `zg_index` drop=true（拼成 `zg index <root> --drop --yes`）。
- 本包自身不写任何文件（唯一的 fs 调用是索引探测：existsSync + 读一次清单），也不向宿主数据目录 `$DSH_HOME`（`<dsh 数据目录>`）落数据。
  - 索引探测不只判「`.zvec-grep/manifest.json` 在不在」：还要**解析清单**并确认它的 `rootPaths` 真的覆盖这个目录。两种实况会被「只判存在」误判成有索引，而实际检索必然失败——文件在但不是一份清单（半截写入/同名占用），以及清单在但根路径指向别处。此时门禁若还按「已建索引」拦着 grep/rg，就等于把检索与门禁双向堵死。
  - 认的结构只有 `manifestVersion`（**严格等于 1**）与 `rootPaths`（非空数组、每项带非空 `absolutePath`）两处——版本不等时上游读它会直接抛 `MANIFEST.INVALID`，此时这个目录一次检索都做不了，宽松放行只会把用户卡在「门禁拦着、检索又必失败」的死角里。刻意不校验 embedding / policy 等字段——那些变了索引照样能用，判成「无索引」反而是错的。
  - 覆盖判据是归一后相等；macOS 上清单里写的是**未解析**路径（`/tmp/x`）而 `path` 字段才是解析过的（`/private/tmp/x`），故两边都再剥一次 `/private` 前缀再比，两种写法都能对上。
  - 白名单/解锁表都在内存、有界，且淘汰策略与语义相符：**命中即触摸**（挪到队尾），淘汰时先按**有效期**丢过期项、再按**最近使用**丢最冷的一条到上限之内——不是按插入序。纯插入序对一张「每次成功检索都重置同一批键」的表等于不淘汰：真正冷掉的项永远留着，而很久没被碰过的键一直占位。白名单条目另有一条有效期（一天），一个月前顺手开过的一个目录不该今天还占名额。容量上界（白名单 64 条 / 会话分片 256 个）保持不变，故常驻内存依旧有界。
  - 重建**作业本体**住在宿主注册表里（见上一节），插件卸载时本包侧表随 effect 回收、在跑的作业经注册表 kill 掉。
- 默认不进索引的：`*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.keystore` / `id_rsa*` / `id_ed25519*`（excludeSecrets=false 可关）。这些规则按**大小写不敏感**匹配，`Server.PEM` 同样被排除；且排在用户自己的路径规则之后生效，用户写一条宽泛的正向规则也覆盖不掉它们。
  - 残留缺口：**无扩展名**的密钥文件（如 `myprivatekey`、`rsa_private`）扩展名规则覆盖不到，`id_rsa*` / `id_ed25519*` 只覆盖 OpenSSH 默认命名；这类文件请走 ignoreFiles（`--ignore-file`）显式声明。
- 隐藏文件默认不收，ignore 文件默认生效（noIgnore 可关）。
- 本包只在本机拼 zg 命令并透传输出，不上传代码。
  - 唯一的外连是 embedding 权重按 hfEndpoint 下载。
  - 结果回显有界：stdout 超限截尾（有 spill 路径会给出）、stderr 尾部 400 字符一并回显，免得「退化成纯词法」被当成完整语义结果。

### 常见问题

- grep/rg 被拒且提示「尚未执行过 zg_search」：这是 search-first 门禁，先 zg_search；配额用尽或过期同理，换个更准的 query/fts 重搜即可续上，不必关插件。
- 检索超时：默认 `--refresh wait` 会同步刷新既有索引，大工作区请用 globs/fileTypes 缩小范围或调小 limit，也可先手写字面检索。
- 重建按钮回 403「root 不在本 daemon 观测到的工作区白名单内」：该目录从未在本 daemon 开过会话；先在该目录起会话，或让模型带 confirm=true 调 zg_index。
- 卡片显示重建失败而 zg 看着像跑完了：成功判据是 completed 且 exit 0——exit 127（zg 没装）也落在 completed，看输出尾部原因。
- 从未建索引的 root：zg_search 明确报错而不是静默建索引；建索引只在用户明确要求时由 zg_index 做。
- 换了 embedding 却搜不到语义结果：切换 embedding 必须 rebuild=true 重建后才生效。

### 开发

- 测试分三层。`test/*.test.ts`（单测 + mock 宿主上下文）钉本包自己的纯逻辑；`test/integration/*` 起**真**宿主服务（`dsh-tools` 的 ToolRuntime、`dsh-subprocess-local` + `dsh-bash-local`、`dsh-jobs-local`、真 HTTP 的 `dsh-host-webserver`、timer 与 approval），把插件挂进官方调用管线（`ctx.tools.execute()` / 真 `fetch`）驱动；`test/e2e/zg-cli.test.ts` 既没有插件也没有替身，只把 `lib/cli.ts` 造出的命令行喂给**真 zg CLI**，钉它的输出形状、错误码与旗标面。宿主契约的缺陷都出在中间那层：mock 上下文只会同意本包已经相信的事（例如 `ctx.get("jobs") === ctx.get("jobs")` 在替身里恒真，而真实 cordis 每次读服务都新建一枚 traceable 代理，该等式恒假）。
- `npm run check` 是发布前的一条门：typecheck（两侧 tsconfig）+ `oxlint` + 重建两个 bundle + `vitest run --coverage` + `oxfmt --check`。
- 覆盖率按**全局 100% 阈值**跑（stmts/branches/funcs/lines）：任何一行或分支没被用例钉住，套件当场红——这是本仓的既定质量门，不是巧合。
- `npm run build` / `npm run build:client` 产出 `host.js` / `client.js`，两者**都不入库**：`prepare` 与 `prepack` 现产，而 `test/build-host.test.ts` / `test/build-client.test.ts` 拿磁盘产物与内存构建逐字节比，产物过期即变红。发布物不手改——发布入口本就是构建产物，因为 Node 对躺在 `node_modules` 里的 `.ts` 直接拒绝类型剥离。
- 行为之外还有一族 manifest 门守着发布面（`test/publish-manifest.test.ts`）：每个入口目标都要被 `files` 覆盖、宿主包一律不进 `dependencies`、`dsh-*` 精确钉且与 peer 同版本、随包产物里不许出现本机路径与 store 布局、shared 出货产物值导入的宿主包必须由本包提供。`test/dist-size.test.ts` 给产物体积设预算，`test/readme-parity.test.ts` 钉中英两份的结构对等。

### 许可

MIT，见 [LICENSE](LICENSE)。本插件驱动的 `zg` CLI 属上游 `@zvec/zvec-grep`，许可为 **Apache-2.0**。本包不含上游源码，因此也不随包附其许可文本；若把两者放在一起再分发，请按各自许可分别保留完整声明。
