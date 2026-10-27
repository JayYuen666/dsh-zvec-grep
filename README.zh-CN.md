<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-zvec-grep@main/icon.svg" width="96" height="96" alt="dsh-zvec-grep logo" />
</p>

<h1 align="center">dsh-zvec-grep</h1>

<p align="center"><em>给 dsh 会话接上工作区语义检索：本地 zg 索引上的 BM25 + 向量 + RRF 混合检索，并给 grep/rg 加一道 search-first 门禁。</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-zvec-grep"><img src="https://img.shields.io/npm/v/@jayyuen66/dsh-zvec-grep?style=flat-square&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-zvec-grep"><img src="https://img.shields.io/npm/d18m/@jayyuen66/dsh-zvec-grep?style=flat-square" alt="npm downloads (total)" /></a>
  <a href="https://github.com/JayYuen666/dsh-zvec-grep/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JayYuen666/dsh-zvec-grep/ci.yml?branch=main&style=flat-square&label=ci" alt="ci" /></a>
  <img src="https://img.shields.io/badge/license-MIT-4c1?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-4c1?style=flat-square&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dsh-%5E0.2.1--rc.3-658EFF?style=flat-square" alt="dsh" />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" alt="powered by dsh" /></a>
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=typescript,nodejs,react,vitest,githubactions" alt="tech stack" />
</p>

<p align="center">
  <a href="https://github.com/JayYuen666"><img src="https://img.shields.io/badge/GitHub-JayYuen666-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="mailto:cqwkkj@gmail.com"><img src="https://img.shields.io/badge/Email-cqwkkj@gmail.com-EA4335?style=flat-square&logo=gmail&logoColor=white" alt="Email" /></a>
  <a href="https://twitter.com/JayYuen666"><img src="https://img.shields.io/badge/Twitter-X%2FJayYuen666-000000?style=flat-square&logo=x&logoColor=white" alt="Twitter/X" /></a>
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-658EFF?style=flat-square" alt="English" /></a>
</p>

---

**一条用于 [dsh](https://github.com/deepseek-ai/deepseek-harness) 的插件：给模型接上工作区语义检索——zg_search / zg_index / zg_status 三枚工具驱动本地 zg CLI（BM25 + 向量 + RRF），search-first 门禁让 grep/rg 跟在一次真正的检索之后，附带带守护进程就绪行与「工作区重建」按钮的设置卡。zg 二进制与索引都留在你的机器上。**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 目录

- [它做什么](#它做什么)
- [安装](#安装)
  - [shared 的版本下限](#shared-的版本下限)
- [确认它真的在工作](#确认它真的在工作)
- [它不提供什么](#它不提供什么)
- [在 dsh 里启用](#在-dsh-里启用)
- [提供给模型的工具](#提供给模型的工具)
  - [zg_search](#zg_search)
  - [zg_index](#zg_index)
  - [zg_status](#zg_status)
  - [rg 开关](#rg-开关)
  - [root 判据](#root-判据)
- [search-first 门禁](#search-first-门禁)
- [设置项](#设置项)
  - [远程 embedding](#远程-embedding)
  - [显式 root 前的确认](#显式-root-前的确认)
- [支持面](#支持面)
- [外部依赖](#外部依赖)
- [守护进程](#守护进程)
- [对外接口](#对外接口)
- [后台作业面](#后台作业面)
- [数据与隐私](#数据与隐私)
- [已知边界](#已知边界)
- [常见问题](#常见问题)
- [开发](#开发)
- [许可](#许可)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它做什么

- **三枚模型工具，底下是一条 CLI。** zg_search / zg_index / zg_status 经宿主 shell 调 zg CLI。传输模式缺省 `--mode auto`：守护进程就绪走 server，缺席时静默落回 direct——没有任何一方替你拉起 daemon。
- **一道 search-first 门禁。** 已建索引的工作区里，grep/rg（shell 命令或原生工具）必须先有一次成功的 zg_search；每次检索重新武装一份有时效的配额。
- **一段 systemPrompt 硬规则**（`zvec-grep-routing`，order 1550）加一道 `tools.guard` 兜底：zg_index 强制显式 confirm，所有 root 在 guard 与 execute 两条路上过同一套判据。
- **一张 web 设置卡**（"zvec-grep（zg）"）：默认 embedding、limit、门禁参数、守护进程就绪行，以及「工作区重建」按钮——作业登记进官方宿主作业注册表。
- **没有索引也能起步。** zg_search 可改走 zg 的穷举词法通道（`rg` 开关）；从未建索引的 root 明确报错，而不是被静默索引。

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-zvec-grep
```

卸载用 `dsh plugin --profile web remove @jayyuen66/dsh-zvec-grep`。包在公共 npm registry 上，不需要凭据，也不需要 scoped-registry 配置行。

- **Node.js `>= 22.12`**（纯 ESM；正是这个下限让 `require()` 一枚 ESM 入口成为可能，`engines.node` 因此声明）。
- **宿主 `dsh` 在 `0.2.1-rc.3` 这条线上。** 宿主读 `engines.dsh`（`^0.2.1-rc.3`）且**单独决定**——该字段在场时兼容性先于 `peerDependencies` 判定，prerelease 参与比较。`0.2.x` 里不低于 `0.2.1-rc.3` 的都通过；`0.3.0` 及以上需要风险授权 `dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <确切版本> --accept-risk`。
- **按契约，`dependencies` 下不放任何 `@deepseek-ai/*`**（`test/publish-manifest.test.ts` 钉住）。profile 以 `nodeLinker: hoisted` 与 `autoInstallPeers: false` 安装，宿主包在那里会落成真实的第二份副本；`@deepseek-ai/dsh-tools` 用普通 `Symbol` 给调度器做键，那个 profile 里**每一次原生工具调用都抛错**，而构建、类型检查与覆盖率照绿。`dsh-*` peer 一律精确钉在 `@deepseek-ai/dsh` peer 的版本上——这是防「第二份宿主类型面」的编译期纪律，不是宿主会去读的声明。
- **值导入都是必需 peer。** `@deepseek-ai/schemastery` 是宿主 fork（只有它的 `resolve` 认 `.volatile()` 字段）；`@deepseek-ai/dsh-typert-protocol` 提供 `TypertRemoteService` 这个要 `extends` 的类；shared 的 `lib/text` 自己值导入 `@deepseek-ai/dsh-output-retention`。三者都落 peer 加同版精确钉的 devDependencies——缺一枚就是装载期 `ERR_MODULE_NOT_FOUND`，不是优雅降级。`dependencies` 里只有 `@jayyuen66/dsh-plugin-shared`。
- **随包发什么**：`host.js`、`client.js`、`cordis.patch.yml`、`icon.svg`、两份 README、`CHANGELOG.md`、`THIRD_PARTY_NOTICES.md`。产物由 `prepack` 现产，不入库。

### <img src="https://api.iconify.design/lucide/arrow-down-to-line.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> shared 的版本下限

如果你的 profile 用 pnpm `overrides` 把 `@jayyuen66/dsh-plugin-shared` 钉在某个版本，那个值必须不低于本包声明的版本。钉得更低就会装到一份缺少运行期所导入名字的产物，宿主起来时报 `N entries did not activate` 加 `does not provide an export named ...`——包装得上、永远不加载，单仓 CI 看不见。

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 确认它真的在工作

1. **层已经进栈。** `dsh --profile web --dump-config` 末尾出现 `# == @jayyuen66/dsh-zvec-grep` 加 `- id: zvec-grep`。这条命令是唯一被接受的判据，而且**不是只读命令**——层行从 stdout 读，**并且**单独检查 stderr；`# == <layer>` 与 `# == <layer>, patched by <path>` 两种形态都要认。
2. **工具答得上来。** 让模型对当前工作区跑一次 zg_status：工具会执行并把 zg 自己的输出透传回来。回「未知工具」说明 bundle 层没进栈。
3. **门禁会拦——前提是已建索引。** `enforceSearchFirst` 开着且 `<root>/.zvec-grep/` 下有清单时，一次成功的 zg_search 之前 grep/rg 被「尚未执行过 zg_search」那句拒绝。没有索引的工作区里门禁无事可拦。
4. **卡片渲染。** 设置页列出 "zvec-grep（zg）"：六个可编辑值、就绪行（探测答不出时保持空白）与重建按钮；改一个值点**保存**以 200 落地。
5. **profile 里没有宿主副本。** 临时 profile 的 `node_modules/` 里只有 `@jayyuen66/`，没有 `@deepseek-ai/` 目录。

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它不提供什么

- **没有自有 HTTP 路由。** 卡片的数据面是官方 Typert Remote 命名空间 `zvecGrepRebuild`，经宿主 `/api` 网关；认证、Host / DNS 重绑定 / Origin 判据与请求体上限都归网关。
- **没有 CLI 子命令。** `dsh zvec-grep …` 不存在。
- **不碰守护进程的生命周期。** `zg server on` 是用户的动作；本包只读就绪态。
- **不依赖 ripgrep。** rg 只出现在门禁判据里。
- **不向宿主数据目录写任何东西。** 唯一的落盘形状是被检索 root 下由 zg 写入的 `.zvec-grep/` 目录。
- 必需的服务面：settings / shell / tools / systemPrompt / timer（全在 `inject` 里）。宿主 `jobs` 服务可选——没有它时重建路径拒绝且不 spawn，三枚工具照常工作。

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 在 dsh 里启用

- `dsh.bundle.patch` 指向 `cordis.patch.yml`，其中唯一的注册行是 `- id: zvec-grep`、`name: "@jayyuen66/dsh-zvec-grep"`——让宿主扫描 client 半的是**裸包名**。bundle 安装走 pnpm（>= 12.3.0）。
- 缺任一注入服务面，cordis 就不激活本条目（启动诊断点名 `pending (waiting for service: …)`）；ctx 形状不对时 apply 抛 `required services … missing`。
- 卡片注册在 `plugins.bundle.config` 槽的 **bundle 包名**键下；设置命名空间与 `configForms` 的读仍走裸条目 id `zvec-grep`（按条目 id 隐式注册）。
- 重建读面注册在 apply fiber 上——不声明 `webServer`、没有子 fiber。TUI 宿主上服务照常注册，只是卡片没有地方渲染。
- 状态轮询是客户端自己的定时器（2000 ms），不是服务端推送；每次读都以结果对象回答，不抛错。
- 部署默认值写在注册行的 `config:` 上；优先级：卡运行时值 > 行 config > schema 的 `.default()`。

## <img src="https://api.iconify.design/lucide/search.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 提供给模型的工具

输出为纯文本；超时 5 分钟（search）/ 10 分钟（index）/ 60 秒（status）；stdout 上限 400000 字节，超限截尾并提示。沙箱 runner 失败、策略拒绝与 zg 自身失败分开归因；结果可能不完整时显式打标。`root` 必须是字符串，构造出的命令按 UTF-8 字节（不是码元）封顶：非字符串的 root 与超长命令直接拒绝，不会回落到会话工作区，也不会撞上内核参数上限。`limit` 越出 1-50 同样直接拒绝并点名区间，不静默钳制——钳过的少结果会被模型当成这次检索的事实；省略则用默认值。

### zg_search

- query / queries / fts / vector 至少其一（合计 <= 32 组、单条 <= 4000 字符）；四个过滤项（`globs` / `insensitiveGlobs` / `fileTypes` / `excludedFileTypes`）收单字符串或数组（128 项、单项 <= 1024 字符）。
- `symbolTypes` 绑定 zg 的闭集，**只认小写**（`module` / `class` / `interface` / `function` / `value` / `alias`）；非法取值在构造命令前就拦，不做大小写折叠。
- `preview`：`none` / `short`（默认）/ `full`。`refresh`：`wait`（默认）/ `off` / `background`——`background` 要有**就绪的守护进程**，没有就在构造命令前拒并给出路（`zg server on`，或把 `clientMode` 从 `direct` 改回来）。
- 输出尾部一行**命中摘要**分两栏：各查询组 `hits:` 之和，与去重后不同位置数（按相对路径 + 行号范围）——同一处被多组命中时不能拿求和冒充命中总数。某组正好等于 `--limit` 只作观察陈述；zg 不提供截断信号。
- `trace` 透传 `--trace`（每条命中的召回路径、名次、分值）；摘要去重键剥掉逐组不同的分值。

### zg_index

- confirm 必填且必须为 true（required 校验 + guard 双层拒绝）。建索引绝不隐式发生。
- `background=true` 起 zg 进程、登记进官方作业注册表、挂超时回收后**立即交回作业号**。它与设置卡复用**同一个** spawn/登记/占位函数，同根占位跨两条入口互斥；没有作业注册表时**根本不起进程**。落定前该根的检索等待自动重试，期间门禁暂停。
- 显式 embedding 走**构造期 allowlist**（本地候选清单，即卡片下拉那份），其余引用直接拒。切换 embedding 必须 `rebuild=true` 才生效。
- `resetPaths=true` 清掉继承来的文件选择设置、再叠加本次过滤项；与 `drop` 互斥（构造期直接拒）。
- `drop=true` 与所有索引侧参数（过滤、rebuild、embedding、深度等）互斥：出现就点名拒绝，不会静默忽略；这时命令里只剩删除一件事。
- `ignoreFiles` 的每一项都必须指向存在且当前进程可读的文件。不存在或读不了会在 zg 启动前拒绝；上游遇到这种路径会让整次索引失败，并把这棵树的索引状态弄坏。

### zg_status

- root + checkReady，用于索引缺失/失败/取消后的诊断或显式看进度。
- `checkReady=true`：报告照常打在 stdout、只用退出码表达就绪——未就绪是结论不是失败。报告原样交回并附一行说明；报告为空的非零退出仍按失败抛。
- 同根正在重建时直接给重建投影，不启子进程。

### rg 开关

- `rg` 留空：工作区**及其向上各级**都没有索引时自动改走穷举匹配，并在结果前声明「这是逐行字面匹配，不是语义排序」。`rg=true` 强制；`rg=false` 拒绝改道（zg 报 `WORKSPACE_INDEX_NOT_FOUND`）。
- 穷举检索**不发放** grep/rg 配额：它不读索引。冲突旗标（`preview` / `refresh` / `symbol-type` / `prefer-symbol` / `fuse` / `fts` / `vector`、`trace`）在构造期拒绝并列出；没有 `hits:` 计数行，命中摘要自动不出。

### root 判据

- 三者的 root 都可省略（缺省=当前会话工作区）。校验：以 `/` 开头的绝对路径、词典归一；空串/非字符串/NUL/相对路径/越界的 `..`、归一后为 `/` 都拒；目录不存在单报「root 目录不存在」，不冒成 spawn ENOENT。
- 会话工作区之外的 root 只有走共享判据（`judgeRoot`）的「祖先/后代」分支才放行，且每个过判据的 root 都登记进卡片重建吃的观测白名单。guard 与 execute 同一套判据——不会同一件事拒两遍、说法还不同。

## <img src="https://api.iconify.design/lucide/ban.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> search-first 门禁

- **什么算检索**：bash/pwsh 命令串经引号/注释感知切词后，命令位上的 grep/egrep/fgrep/rg 与原生 grep 工具。`--help` / `--version`、`echo "grep x"`、commit message 不算。
- **配额按「会话 × 索引根」**：每次成功 zg_search 重新武装 grepBudgetPerSearch 次、unlockWindowMin 分钟有效；索引根是 root 自身或含索引的最近祖先（最多上溯 8 层）。
- **分片用根会话**（沿 `header.parentSession` 上溯到顶）：主代理与子代理**共享一份额度**。上溯降级不抛错——查不到父就停在已知的最后一跳，成环就停在首次重复前。
- **「含索引」= `<root>/.zvec-grep/manifest.json` 在盘上，*并且*解析得开**：`manifestVersion` 严格等于 1、`rootPaths` 覆盖该目录（归一相等，macOS 两侧剥 `/private` 前缀）。只判目录名不够——它同时是 zg 的全局 home（`~/.zvec-grep`）；只判存在会把半截或外来的清单误判成有索引，把检索与门禁双向堵死。
- 白名单/解锁表在内存里有界（64 根 / 256 分片），命中即触摸、先过期后 LRU 淘汰；白名单条目带一天有效期。
- enforceSearchFirst=false 只关门禁；confirm 与 root 兜底照旧。

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 设置项

命名空间 `zvec-grep` 即设置条目 id；schema 共 16 个字段、逐字段带内置默认，其中卡上那 6 枚标 `.volatile()`。

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `defaultEmbedding` | string | `local/qwen3-embedding-0.6b` | **新建**索引用的 embedding；已有索引切换后需重建 |
| `defaultLimit` | natural，1-50 | `10` | zg_search 默认命中条数上限 |
| `hfEndpoint` | string | 国内可达的 HF 兼容镜像 | 可改别的镜像，留空走官方 HF |
| `enforceSearchFirst` | boolean | `true` | search-first 门禁 |
| `grepBudgetPerSearch` | natural，1-20 | `3` | 每次成功检索重新武装的 grep/rg 次数 |
| `unlockWindowMin` | natural，1-240 | `10` | 配额有效分钟数 |

另有**非 volatile 部署值**，共 10 枚不进卡片，cordis.yml 行 `config:` 是唯一改值入口：searchTimeoutMs=300000、statusTimeoutMs=60000、indexTimeoutMs=600000（也是重建 kill 定时器时长）、stdoutMaxBytes=400000、clientMode=auto、rebuildWaitMs=120000，加远程 embedding 三件套与 requireApprovalForExplicitRoot（见下两小节）。优先级：卡值 > 行 config > `.default()`；行里显式缺省的字段不覆盖默认。

### 远程 embedding

默认全关：`allowRemoteEmbedding=false`、`remoteEmbeddingEndpoint=""`、`remoteEmbeddingApiKeyFrom=""`。关着时，显式 embedding 必须落在本地候选清单里。打开后：

- 端点与凭据**只经环境变量**下发（`ZVEC_GREP_ENDPOINT` / `ZVEC_GREP_API_KEY`），绝不进 argv——整条命令会作为作业 label 回显在卡片上。
- 凭据那项填的是**宿主进程里装凭据的环境变量名**，不是密钥本身；宿主会剔掉名字含 KEY/SECRET/TOKEN 的继承变量，必须由本插件显式转发才到得了 zg。
- 本插件**不代传 `--allow-remote`**：zg 还要用户自己跑一次 `zg auth grant <root> --capability embedding --scope workspace`。

### 显式 root 前的确认

`requireApprovalForExplicitRoot` 默认 `false`。打开后，显式给了 root、且要靠「祖先/后代」分支放行的调用会经官方 `tools/pre-execute` → `{kind:'ask'}` → `ctx.approval` 弹一次用户确认。发问判据与 root 判据同源（`judgeRoot`），注定被拒或本就无需授权的调用不受打扰。三处死路已知：`never` 审批预设确定性拒绝、委派子代理被钉死 `never`（开关对其无效）、无 approval 服务时 fail-closed。这道确认**只加不减**：越界的 root 即便「已批准」照旧被拒。

## <img src="https://api.iconify.design/lucide/monitor.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 支持面

- **POSIX 宿主（Linux / macOS）。** root 判据只认 `/` 开头的绝对路径，命令行是 POSIX 形态（`shq()` 转义进 `bash -c`），清单比对按 `/` 分隔。
- **Windows 不在支持面内，fail-fast。** 会话工作区长成 `C:\Users\…` 时三个工具都在 root 判据处当场拒并说明原因——不会拿错位路径去拼 zg 命令。真要支持得改判据本身（盘符/UNC、第二套命令形态、按 `/` 的切词），本包不做也不假装能做。
- **CI 照此分工**：ubuntu 格是全部门禁（含四项 100% 覆盖率）；其它平台只跑不依赖盘上真工作区的检查、不判覆盖率。理由写在 `.github/workflows/ci.yml`。

## <img src="https://api.iconify.design/lucide/cpu.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 外部依赖

- 二进制依赖是 **zg**（`npm install -g @zvec/zvec-grep`）。不在 PATH 时 shell 回 exit 127，工具回「zg 未安装或不在 PATH」，与「沙箱 runner 没起来」分开归因。
- 上游即 `@zvec/zvec-grep`（提供 `zg` 这枚 bin），仓库 https://github.com/zvec-ai/zvec-grep，许可 **Apache-2.0**。本包只经宿主 shell 调那枚 CLI，不含也不分发上游源码。
- 版本下限 `0.2.2`（`lib/zg-version.ts` 的 `MINIMUM_ZG_VERSION`）：低于它就在下发命令前停住并点名实际版本——更老的 zg 可能把同一串 argv 解成别的东西。
- 本地 embedding 由 zg 侧后端加载（qwen3/embeddinggemma 走 llama-cpp，potion-* 走 model2vec，其余走 transformers-js）；权重按 hfEndpoint 注入 HF_ENDPOINT 后下载。

## <img src="https://api.iconify.design/lucide/server.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 守护进程

- direct 与 server 是**两种能力面**，不是快慢之分：direct 每次查询都冷加载 embedding 模型；增量刷新（watcher）、`refresh=background` 与常驻模型池只在 server 模式下存在。上游对 `auto` 只做就绪探测、不拉起 daemon。
- 本包也不拉——`zg server on` 会留下 detached 进程与 token 文件，那是用户的决定。本包做的是把差异**显式化**：按 60 秒 TTL 缓存 `zg server status --check-ready` 的退出码（探测失败按未就绪收口，绝不外抛基础设施故障），据此收口 `refresh=background`，并在 `zg_status` 输出尾与卡片各回显一行。探测只由 `roots()` 读面发出。
- 卡片的 `serverReady` 只可能是 `true` / `false`；探测答不出时该臂什么都不显示，而不是说成「未就绪」。想要红利就在终端里跑 `zg server on`。

## <img src="https://api.iconify.design/lucide/network.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 对外接口

一枚官方 Typert Remote 命名空间 `zvecGrepRebuild`，注册在 apply fiber 上。没有 `/_dsh/*` 路由、没有 CSRF token、也不自带 body 上限——都由宿主 `/api` 网关承担。

| 方法 | 入参 | 回执 |
| --- | --- | --- |
| `roots()` | - | `{ roots, serverReady }`——观测白名单加就绪行；探测答不出时 `serverReady` 为 `undefined` |
| `rebuild({ root })` | 一个绝对 root | `{ ok: true, jobId, reused? }` 或 `{ ok: false, error, status }` |
| `status({ jobId })` | 本包发的作业号 | `{ status, exitCode, root, output }`（有沙箱时带 `sandbox`）或 `{ ok: false, error, status: 404 \| 503 }` |

- `rebuild` 拒绝非 `/` 路径、白名单之外的 root、已消失的目录；无 `jobs` 服务时一条都不 spawn（503 臂）。同根占位在第一个 `await` 前取——第二次点击跟随在跑的那条（`reused: true`），不会在同一份索引上再起一条 zg；启动失败归还占位，没有树会被永久标成「重建中」。
- `status` 只认本包侧表里的 id（最近 10 条已落定记录，在跑的永不淘汰），别人的作业经它读不到。卡片每 2 秒轮询。拒绝里的 `status` 是**保留的语义码，不是 HTTP 状态**；三个方法都不把异常抛穿网关——一次被拒的调用对卡片只是一条笼统失败，会停掉还在跑的重建的轮询。
- 并发由**宿主注册表**决定（实测默认未拥有桶 10）；满员时 `rebuild` 交回官方点名文案的拒绝，绝不杀在跑的重建。

## <img src="https://api.iconify.design/lucide/boxes.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 后台作业面

一次「工作区重建」是宿主 `ctx.jobs` 里的一枚**未拥有**作业（`kind: "zvec-grep-rebuild"`，id 形如 `zvec-grep-rebuild-<hex>`）。三个后果：

- **模型侧能看见。** 官方 `job_list` / `job_output` / `job_kill` 列得出这次重建（退出码与信号走 `detail`，与宿主 bash 工具同形）；输出走官方 pull source，面板关着环也照常前进。
- **未拥有 ⇒ 对全部会话可见**——采用官方注册表的已知且被接受的暴露面，要收回只有回滚换装一条路。`status` 读面仍只认本包侧表。
- **多了两个状态词**：`stopping`（取消已发出、未落定——按仍在跑显示）与 `failed`（注册表侧判定，带专门文案）。
- 输出环按 **UTF-8 字节**留存（实测宿主默认 262144），卡片的尾窗按 **UTF-16 码元**计——中文输出的窗比换装前小约 1/3。「已截断」指环裁掉了头部；「缓冲区溢出」指字节真丢了。超时说明与沙箱事实在投影时合成、不进环；注册表被重载时轮询把 unknown job 折成拒绝结果，不抛穿。

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 数据与隐私

| 口径 | 内容 |
| --- | --- |
| 写盘 | 本包不写任何文件。唯一落盘形状是被检索 root 下由 zg 写入的 `.zvec-grep/` 索引目录；宿主数据目录里什么都不落 |
| 本包读什么 | 索引探测：一次存在性检查加读一次清单 |
| 网络 | 只有 zg 按 hfEndpoint 下载 embedding 权重。远程 embedding 默认关闭、属部署决定 |
| 密钥排除 | 默认排除、大小写不敏感、且排在你的路径规则之后：`*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.keystore` / `*.jks` / `*.ppk` / `id_rsa*` / `id_ed25519*`（excludeSecrets=false 可关）。**无扩展名**的密钥文件不覆盖——走 ignoreFiles 声明 |
| 隐藏文件 | 默认不收；ignore 文件默认生效（noIgnore 可关） |
| 回显 | 有界：stdout 超限截尾；stderr 尾部 400 字符一并回显。stderr 只丢弃认得的索引进度——退化提示、锁冲突与任何没认出来的警告一律保留；`Indexing complete` 按整行相等匹配，部分失败的那句变体不会被吞 |
| 重建路径 | 模型侧 `zg_index`（rebuild=true、confirm=true）或卡片按钮；删除是 `zg_index` drop=true。卸载时侧表回收、在跑的作业经注册表 kill |

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 已知边界

- **Windows 宿主不支持**——失败是明确的拒绝，不是错误的答案。
- **无扩展名的密钥文件**不在排除规则覆盖内；`id_rsa*` / `id_ed25519*` 只覆盖 OpenSSH 默认命名。
- **未拥有的重建作业对全部会话可见**——官方作业注册表的被接受暴露面。
- **中文输出窗缩小约三分之一**——官方环按 UTF-8 字节、卡片按 UTF-16 码元的代价。
- **没有 `Code:` 行的 zg 失败无法按码归因**；这种回显带「可加 `--debug` 复跑」的指引（不默认带 `--debug`，它会撑爆给模型读的有界回显）。
- **穷举检索不发放配额、也不产出语义结论**；每次自动改道都带前置声明。
- **确认开关有三处死路**（never 审批预设、委派子代理、无 approval 服务）——写在设置项一节，不藏着。

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 常见问题

| 问题 | 回答 |
| --- | --- |
| grep/rg 被拒且提示「尚未执行过 zg_search」 | 这是 search-first 门禁，先 zg_search；配额用尽或过期同理，换个更准的 query 重搜续上，不必关插件。 |
| 检索超时 | 默认 `--refresh wait` 同步刷新索引；用 globs/fileTypes 缩小范围、调小 limit，或起守护进程——直连模式每次冷加载 embedding 模型，那才是预算给到 5 分钟的原因。 |
| 报错「zg 索引锁正被其他操作占用（ownerOperation: …）」 | 占锁方不是重建（常见是增量刷新），这一条命令不为它等待——那类操作可能跑很久，排队等于无界挂起。稍后重试，或等它落定后再查；只有重建占锁走自动等待重试。zg 的原始失败文本随行，可核对是哪一把锁。 |
| 重建被拒「root 不在观测白名单内」 | 该目录从未在本 daemon 开过会话；先在那里起会话，或让模型带 confirm=true 调 zg_index。 |
| 卡片显示重建失败而 zg 看着像跑完了 | 成功判据是 completed 且 exit 0——exit 127（zg 没装）也落在 completed，看输出尾部。 |
| 从未建索引的 root | zg_search 明确报错；建索引只在明确请求时由 zg_index 做。 |
| 换了 embedding 却搜不到语义结果 | 切换 embedding 必须 rebuild=true 重建后才生效。 |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 开发

```sh
pnpm install
pnpm run check   # 类型检查（三个 tsconfig 程序）→ lint → 两个 bundle 构建 → 带覆盖率的测试 → 格式检查
```

- 测试分三层：`test/*.test.ts`（单测 + mock 宿主上下文）、`test/integration/*`（真宿主服务，经 `ctx.tools.execute()` / 真 `fetch` 驱动）、`test/e2e/zg-cli.test.ts`（无插件无替身——构造出的命令行直喂**真 zg CLI**）。宿主契约的缺陷出在中间层：mock 上下文只会同意本包已经相信的事。
- 覆盖率四项 **100%**，分母是选入的面（`host.ts` + `lib/**`）；客户端半（`src/**`）刻意在分母外，经 bundle 覆盖。
- `host.js` / `client.js` 不入库；`prepare` / `prepack` 现产，两条测试拿磁盘产物与内存构建逐字节比。发布物不手改。
- manifest 门（`test/publish-manifest.test.ts`）守发布面：入口目标被 `files` 覆盖、宿主包不进 `dependencies`、`dsh-*` 精确钉、产物无本机路径。`test/dist-size.test.ts` 设体积预算，`test/readme-parity.test.ts` 钉两份 README 的结构对等。

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 许可

MIT，见 [LICENSE](LICENSE)。源码在 [github.com/JayYuen666/dsh-zvec-grep](https://github.com/JayYuen666/dsh-zvec-grep)。问题请提到那个仓库的 issue tracker。

本插件驱动的 `zg` CLI 属上游 `@zvec/zvec-grep`，许可 **Apache-2.0**。本包不含上游源码、不随包附其许可文本；若把两者放在一起再分发，请按各自许可分别保留完整声明。这条边界记录在 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。
