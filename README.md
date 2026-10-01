# @jayyuen66/dsh-zvec-grep

[中文](#中文) · [English](#english)

## 中文

### 它做什么

- 给 dsh 会话接上工作区语义检索：注册 zg_search / zg_index / zg_status 三个模型工具，底层经宿主 shell 以 `--mode direct` 调 zg CLI（BM25 + 向量 + RRF 混合检索）。
- 注入一段 systemPrompt 硬规则（`zvec-grep-routing`，order 1550）+ 两道 tools.guard：zg_* 安全兜底与 search-first 门禁（已建索引的工作区里，grep/rg 前必须先有一次成功的 zg_search）。
- 附带 web 端设置卡：默认 embedding、limit、search-first 配额/时效，以及「工作区重建」按钮。

### 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-zvec-grep
```

- 包在公共 npm 上，安装不需要凭据；发布态产物只有 host.js、client.js、cordis.patch.yml（package.json 的 files）。
- 运行期值 import `@jayyuen66/dsh-plugin-shared`（lib/http、lib/locale）与 `@deepseek-ai/schemastery`（宿主 fork：0.1.7 的 `.volatile()` 解析只有它有实现，公共 schemastery 既没这个方法、解析出的也仍是普通值），两者都在 dependencies 里，装不上就是 ERR_MODULE_NOT_FOUND。

### 在 dsh 里启用

- add/remove 按包内 cordis.patch.yml 维护注册行 `- id: zvec-grep`（name 指向本包）；该文件由 `package.json` 的 `dsh.bundle.patch` 指向。
- 宿主版本要求 `>=0.2.0-rc.2`：写在 `peerDependencies`（0.1.7-rc 起宿主装插件时校验它；alpha.1 还没有这道门）与 `engines.dsh`（同值、无人读）。
- `dsh.client.platform` 为 web 且 immediately，设置卡的 client 半随宿主下发；bundle 安装走 pnpm（>= 12.3.0）。
- apply 需要 settings/shell/tools/systemPrompt/timer 五个服务面：它们都在 `inject` 里，缺任一 cordis 就不激活本条目（宿主启动诊断点名 `pending (waiting for service: …)`）；apply 里的守卫再兜一层，ctx 形状不对时抛 `required services … missing`。
  - 三条 `/_dsh/zvec-grep/*` 端点挂在 `inject(["webServer"])` 的子 fiber 上：宿主没有 webServer（如 TUI）时子 fiber 不激活，端点不存在而工具照常。真实宿主上 webServer 比本条目晚到位约 1 秒，所以这里必须是依赖、不能只在 apply 里 `ctx.get` 读一次。

### 提供给模型的工具

- zg_search：query / queries / fts / vector 至少其一（合计 <= 32 组）。
  - 可加 globs / insensitiveGlobs / fileTypes / excludedFileTypes / symbolTypes / preferSymbol / modifiedAfter / modifiedBefore / fuse / limit / device。
  - 固定带 `--preview short --refresh wait`，每条命中自带有界源码片段。
- zg_index：confirm 必填且必须为 true（required 校验 + guard 双层拒绝）。
  - 另有 embedding / rebuild / drop / ignoreFiles / excludeSecrets / hidden / noIgnore / maxDepth / maxFileSizeBytes / follow / embeddingConcurrency / device。
  - 切换 embedding 必须 rebuild=true 才生效。
- zg_status：只有 root，用于索引缺失/失败/取消后的诊断或显式看进度。
- 三者的 root 都可省略（缺省=当前会话工作区）；输出为纯文本；超时分别为 5 分钟 / 10 分钟 / 60 秒，stdout 上限 400000 字节（超限截尾并提示）。

### 设置项与检索根

- 命名空间 `zvec-grep` 由宿主**隐式**注册（0.1.7 起 = profile 条目 id，插件侧不再有 `settings.register`）；schema 共十个字段，其中卡上那六枚标 `.volatile()`，内置默认逐字段写在 `.default()` 上。
  - defaultEmbedding=local/qwen3-embedding-0.6b、defaultLimit=10（1-50）、hfEndpoint=国内可达的 HF 兼容镜像基址（可改成别的镜像或留空走官方 HF）。
  - enforceSearchFirst=true、grepBudgetPerSearch=3（1-20）、unlockWindowMin=10（1-240）。
- 另有四个**非 volatile 部署值**（不进设置卡，只在 cordis.yml 的行 config 里改值；上面工具一节的「5 分钟 / 10 分钟 / 60 秒 / 400000 字节」就是它们的默认）：searchTimeoutMs=300000、statusTimeoutMs=60000、indexTimeoutMs=600000（也是后台重建 kill 定时器的时长）、stdoutMaxBytes=400000，均最小 1。
- 优先级：设置里的运行时值 > 组合包层/用户层行的 config > schema 的 `.default()`；行 config 中显式缺省的字段不覆盖默认。读侧是 `config.<field>.get()`（volatile 引用，卡上改完下一个事件即生效）；四个部署值是普通值形态，不经 `.get()`。
- root 校验：必须是以 `/` 开头的绝对路径，词典归一折叠空段与 `.`。
  - 拒绝空串、非字符串、含 NUL、相对路径、越出文件系统根的 `..`，归一后为 `/` 也拒。
  - 目录不存在时单报「root 目录不存在」，不冒成 spawn ENOENT。
- guard 与 execute 用同一套 root 判据，避免「guard 放行、execute 抛错」说两遍。
- 解锁按「会话 × 索引根」计：每次成功 zg_search 重置为 grepBudgetPerSearch 次、unlockWindowMin 分钟有效；索引根是 root 自身或含索引的最近祖先（最多上溯 8 层）。
- 「含索引」的判据是 `<root>/.zvec-grep/manifest.json` 在盘上，**只判 `.zvec-grep` 目录名不够**：这个名字同时是 zg 自己的全局 home（`ZVEC_GREP_HOME ?? ~/.zvec-grep`，装的是 config.json / locks / models），只判目录名会让一个从未建索引、只是祖先目录撞名的普通工作区也被门禁拦下。
- enforceSearchFirst=false 只关掉门禁，zg_* 的安全兜底（confirm、root 判据）不受影响。

### 外部依赖（rg）

- 真正的二进制依赖是 zg（由 `npm install -g @zvec/zvec-grep` 提供）：不在 PATH 时 shell 回 exit 127，工具据此回「zg 未安装或不在 PATH」，与「沙箱 runner 没起来」分开归因。
- 本地 embedding 由 zg 侧后端加载：qwen3/embeddinggemma 走 llama-cpp（device=auto 时试 Metal、失败回退 CPU），potion-* 走 model2vec，其余走 transformers-js 纯 JS。
  - 权重按 hfEndpoint 注入 HF_ENDPOINT 后下载。
- 本包不依赖也不调用 ripgrep：rg 只出现在门禁判据里。
  - bash/pwsh 命令串经引号/注释感知切词后，命令位上的 grep/egrep/fgrep/rg 与原生 grep 工具才算检索。
  - `--help`/`--version`/`-V`、`echo "grep x"`、`git commit -m "use rg"` 不算。
- 有沙箱执行器时会区分 runner 失败、策略拒绝与 zg 自身失败，并在结果里显式打「可能不完整」标记。

### 对外接口

- 三条路由的 handler 第一句都是 `guardTrust(req, res, { servingNonLoopback })`（`shared/lib/trust`），任一判据不过即 `403` + `{ ok:false, error: ... }`。
  - 判据次序：Host 权威 → `sec-fetch-site` 白名单 → `origin` 与 Host 逐字比对；两句错误文本是 `"untrusted host authority"` 与 `"cross-origin request rejected"`。
  - `servingNonLoopback` 只取 `webServer.host === "0.0.0.0"`；非本方法的 `405` 带 `Allow` 与 `{ ok:false, error:"GET only" | "POST only" }`，不再是空回显。
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
- 本包自身不写任何文件（唯一的 fs 调用是 existsSync 探测），也不向宿主数据目录 `$DSH_HOME`（`<dsh 数据目录>`）落数据。
  - 白名单/解锁表都在内存、有界；重建**作业本体**住在宿主注册表里（见上一节），插件卸载时本包侧表随 effect 回收、在跑的作业经注册表 kill 掉。
- 默认不进索引的：*.pem / *.key / *.p12 / _.pfx / *.keystore / id_rsa* / id_ed25519_（excludeSecrets=false 可关）；隐藏文件默认不收，ignore 文件默认生效（noIgnore 可关）。
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

## English

### What it does

- Adds semantic workspace search to dsh sessions: registers three model tools, zg_search / zg_index / zg_status, which drive the zg CLI (BM25 + vector + RRF hybrid) through the host shell with `--mode direct`.
- Injects one systemPrompt rule section (`zvec-grep-routing`, order 1550) plus two tools.guard layers: safety backstop for zg_* and the search-first gate (in an indexed workspace, grep/rg requires a prior successful zg_search).
- Ships a web settings card: default embedding, limit, search-first quota/window, and a "rebuild workspace" button.

### Installation

```sh
dsh plugin --profile web add @jayyuen66/dsh-zvec-grep
```

- The packages are on the public npm registry, so no credentials are needed; the published artifact only carries host.js, client.js and cordis.patch.yml (the files field in package.json).
- Runtime value imports are `@jayyuen66/dsh-plugin-shared` (lib/http, lib/locale) and `@deepseek-ai/schemastery` (the host's fork — the only one whose resolve wraps `.volatile()` fields into `Volatile` references); both sit in dependencies.
  - Missing either one is `ERR_MODULE_NOT_FOUND` at load, not a graceful downgrade — that is also why the fork cannot be swapped for public `schemastery`.

### Enabling it in dsh

- add/remove maintain the registration line `- id: zvec-grep` (name points at this package) from the in-package cordis.patch.yml, which `dsh.bundle.patch` in `package.json` points at.
- The host must be `>=0.2.0-rc.2`: declared in `peerDependencies` (the host checks it on plugin install from 0.1.7-rc; alpha.1 has no such gate yet) and in `engines.dsh` (same value, read by nothing).
- `dsh.client.platform` is web with immediately set, so the card's client half is delivered by the host; bundle installation goes through pnpm (>= 12.3.0).
- apply needs the settings/shell/tools/systemPrompt/timer surfaces: all five sit in `inject`, so a missing one keeps cordis from activating the entry (the startup diagnostic prints `pending (waiting for service: …)`).
  - The guard inside apply is the second layer: a malformed ctx throws `required services … missing`.
  - The three `/_dsh/zvec-grep/*` routes hang off an `inject(["webServer"])` child fiber: with no webServer (a TUI host) the child never activates, so those routes simply do not exist while the tools keep working.
  - On the real host webServer arrives about a second after this entry, which is why it must be a dependency and not a one-off `ctx.get`.

### Tools exposed to the model

- zg_search: at least one of query / queries / fts / vector (32 routes max).
  - Plus globs / insensitiveGlobs / fileTypes / excludedFileTypes / symbolTypes / preferSymbol / modifiedAfter / modifiedBefore / fuse / limit / device.
  - Always sends `--preview short --refresh wait`, so every hit carries a bounded source snippet.
- zg_index: confirm is required and must be true (rejected twice, by the required check and by the guard).
  - Also embedding / rebuild / drop / ignoreFiles / excludeSecrets / hidden / noIgnore / maxDepth / maxFileSizeBytes / follow / embeddingConcurrency / device.
  - Switching embedding only takes effect with rebuild=true.
- zg_status: root only, for diagnosing a missing/failed/cancelled index or watching progress explicitly.
- root may be omitted in all three (defaults to the current session workspace); output is plain text; timeouts are 5 minutes / 10 minutes / 60 seconds, stdout capped at 400000 bytes (truncated to the tail with a note).

### Settings and search roots

- Namespace `zvec-grep`, ten fields with built-in defaults, six of them volatile and on the card.
  - defaultEmbedding=local/qwen3-embedding-0.6b, defaultLimit=10 (1-50), hfEndpoint=a China-reachable HF-compatible mirror base (set another mirror or leave empty for the official HF).
  - enforceSearchFirst=true, grepBudgetPerSearch=3 (1-20), unlockWindowMin=10 (1-240).
- Four additional **non-volatile deployment values** are not on the settings card: change them only via the line config in cordis.yml. The "5 minutes / 10 minutes / 60 seconds / 400000 bytes" in the tools section are their defaults.
  - searchTimeoutMs=300000 and statusTimeoutMs=60000, each with a minimum of 1.
  - indexTimeoutMs=600000 (also the background rebuild kill-timer duration) and stdoutMaxBytes=400000, same minimum of 1.
- Precedence: runtime settings values > the line config of the bundle/user layer > built-in base; explicitly absent fields in the line config do not override the base.
  - Volatile fields are read via `config.<field>.get()`; the four deployment values are plain values and skip `.get()`.
- Root validation: must be an absolute path starting with `/`, lexically normalised (empty and `.` segments folded).
  - Rejects empty strings, non-strings, NUL bytes, relative paths and `..` segments escaping the filesystem root, and `/` itself after normalisation.
  - A missing directory is reported as "root does not exist" instead of a bare spawn ENOENT.
- The guard and execute share exactly this root predicate, so nothing is refused twice with different wording.
- Unlocks are counted per "session x index root": each successful zg_search resets to grepBudgetPerSearch calls valid for unlockWindowMin minutes; the index root is the root itself or its nearest indexed ancestor (up to 8 levels up).
- "Indexed" means `<root>/.zvec-grep/manifest.json` is on disk; **the directory name alone is not enough**: the same `.zvec-grep` name is also zg's own global home (`ZVEC_GREP_HOME ?? ~/.zvec-grep`, holding config.json / locks / models), so a plain workspace that never built an index but merely collides on an ancestor's name would get gated too.
- enforceSearchFirst=false disables only the gate; the zg_* backstop (confirm, root rules) is unaffected.

### External dependency (rg)

- The real binary dependency is zg (installed via `npm install -g @zvec/zvec-grep`): when it is not on PATH the shell reports exit 127 and the tool answers "zg is not installed or not on PATH", kept separate from "the sandbox runner never started".
- Local embeddings are loaded by zg's backends: qwen3/embeddinggemma need llama-cpp (device=auto tries Metal and falls back to CPU), potion-* use model2vec, the rest use transformers-js in plain JS.
  - Weights are downloaded with HF_ENDPOINT injected from hfEndpoint.
- This package neither depends on nor calls ripgrep: rg appears only in the gate predicate.
  - After quote/comment-aware tokenising of a bash/pwsh command string, grep/egrep/fgrep/rg at a command position and the native grep tool count as searching.
  - `--help`/`--version`/`-V`, `echo "grep x"` and `git commit -m "use rg"` do not.
- With a sandboxed executor, runner failure, policy denial and a genuine zg failure are told apart, and incomplete results are flagged explicitly.

### Public interface

- Every handler opens with `guardTrust(req, res, { servingNonLoopback })` (`shared/lib/trust`); failing any leg yields `403` with `{ ok:false, error: ... }`.
  - Order of legs: Host authority -> the `sec-fetch-site` allowlist -> a verbatim `origin` vs Host compare. The two rejection sentences are `"untrusted host authority"` and `"cross-origin request rejected"`.
  - `servingNonLoopback` comes only from `webServer.host === "0.0.0.0"`. A wrong method yields `405` carrying `Allow` plus `{ ok:false, error:"GET only" | "POST only" }` - no longer an empty reply.
- `GET /_dsh/zvec-grep/rebuild-roots`: returns only this plugin's own data (a CSRF token regenerated on every apply, plus the observed workspace list); GET/HEAD allowed, 403 when the gate above rejects it.
- `POST /_dsh/zvec-grep/rebuild?root=...`: gate + header `x-zvec-grep-csrf` + body <= 4096 bytes + root in the whitelist + directory exists; returns `{ ok, jobId }`, otherwise 405/403/400/500.
- `/_dsh/zvec-grep/rebuild-status?jobId=...`: polled behind the gate (the card polls every 2 seconds); returns status/exitCode/root/output (plus sandbox when present); an unknown jobId gets a 404 explaining it left the 10-record settled window.
- Also a systemPrompt section `zvec-grep-routing` (order 1550) and the settings namespace `zvec-grep`.
  - How many rebuilds run at once is decided by the **host registry** (measured default: the unowned bucket holds 10); this package no longer carries its own concurrency cap.
    When it is full, `POST /rebuild` answers 500 with the official message that names the limit - it no longer kills a rebuild that is already running.
  - `rebuild-status` only resolves jobIds present in this package's side table: the last 10 **settled** records are kept (older ones are removed from the registry => 404); running records are never displaced.

### The background job surface (official `ctx.jobs`)

This package no longer ships a job registry: a "rebuild workspace" run is one **unowned** job in the host's `ctx.jobs` (`kind: "zvec-grep-rebuild"`, so the id reads `zvec-grep-rebuild-N`). Three visible consequences:

| Aspect                                 | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The model can see it                   | The official `job_list` / `job_output` / `job_kill` tools now list the rebuild, with the exit code / signal name carried in the job's `detail` (same shape the host's own bash tool uses - measured in `plugins/docs/harness/f3-equiv/probe-jobs.mjs`). Output rides the official **pull source** (`proc.observed[*].readFrom`), so the ring advances on the registry's own cadence - **even with the settings panel closed** - and the observer never steals bytes from `readOutput()` (the d.ts says so verbatim). The controller is attached only for the instant of `start` and detached right after (see the cross-package rule) |
| Unowned means visible to every session | The registry isolates by owner, and an unowned job can be `list`ed / `read` / `kill`ed by any caller. This is a known, accepted exposure of this wave - the card is a webServer producer outside any session, and owned jobs would need the `dsh-agent` registry (measured unavailable). Rolling this adoption back is the only way to close it. Note `/_dsh/zvec-grep/rebuild-status` still only answers for ids in this package's side table, so somebody else's job (the host's `bash-1`, say) cannot be read through it                                                                                                           |
| Two more status words                  | `stopping` (cancellation issued, process not finished settling - the card shows it as still running) and `failed` (the registry's own verdict - it gets its own message instead of rendering as "exit code null")                                                                                                                                                                                                                                                                                                                                                                                                                     |

What is not retained, stated plainly: the output ring keeps **UTF-8 bytes** (measured host default 262144), while the card's 4000-character tail window and its `shown/total` count **UTF-16 code units** - two unit systems, each doing its own job. `total` therefore counts code units **inside the retention window** (the official byte total lives in `view.output.total`, different unit, never mixed), and for CJK output that window is about **1/3 smaller** than what this package kept before the adoption - the price of using the official ring. The two loss marks say different things: "truncated" = the ring evicted its head (`view.output.earliest > 0`, simply not visible any more), "buffer overflow" = the executor's reader reported lossy or threw outright (bytes really are gone; a spill file may exist). The timeout notice and the sandbox facts are deliberately **not** written into the ring: the ring belongs to the registry's pump, and the registry drops every write after settlement (measured), so the endpoint synthesises both at projection time and they can never be lost by arriving late. **Polling never throws through**: when the `jobs` service is reloaded (or somebody else reclaimed the record) the status endpoint answers **404** rather than letting the official `unknown job` error escape - the host's catch for a throwing handler logs one line and, while no header has gone out yet, writes a bare **400** with no body and no content-type (it only destroys the socket once headers were sent: installed dsh-host-webserver `lib/index.js:246-256`), which would put the card into its terminal `error` phase, stop the polling and hide a rebuild that is still running.

### Data and privacy

- The only on-disk shape of the index is the `.zvec-grep/` directory under the searched root, written by zg (a read-only sandbox cannot write it, and the result says the index may be incomplete).
- Two rebuild paths: the model-side `zg_index` (rebuild=true, confirm=true), or the card's "rebuild workspace" button through the rebuild route above; deleting is `zg_index` with drop=true (assembled as `zg index <root> --drop --yes`).
- The package itself writes no files (its only fs call is the existsSync probe) and puts nothing in the host data directory `$DSH_HOME` (`<dsh data dir>`).
  - The whitelist and unlock table live in bounded memory; the rebuild **jobs themselves** live in the host registry (section above) - on unload this package's side table is reclaimed with the effect and running jobs are killed through the registry.
- Excluded from indexing by default: *.pem / *.key / *.p12 / _.pfx / *.keystore / id_rsa* / id_ed25519_ (set excludeSecrets=false to allow); hidden files are skipped and ignore files honoured unless noIgnore is set.
- Nothing is uploaded: the package only assembles zg commands on the local machine and passes output through.
  - The only outbound traffic is the embedding weight download driven by hfEndpoint.
  - Echoes are bounded — stdout over the cap keeps the tail (with the spill path when present), and the last 400 characters of stderr are appended so a "degraded to pure lexical" notice is not mistaken for a full semantic result.

### FAQ

- grep/rg refused with "no zg_search has run yet": that is the search-first gate; run zg_search. The same applies once the quota is spent or expired — re-search with a sharper query/fts to refresh it, no need to disable the plugin.
- Search times out: the default `--refresh wait` refreshes the existing index synchronously; narrow the range with globs/fileTypes or lower the limit, or fall back to a hand-written literal search.
- The rebuild button answers 403 "root is not in the workspace whitelist this daemon observed": that directory never had a session in this daemon; start one there first, or let the model call zg_index with confirm=true.
- The card reports a failed rebuild although zg looks finished: success is "completed with exit 0" — exit 127 (zg not installed) also lands in completed, so read the tail of the output.
- A root that was never indexed: zg_search fails loudly instead of silently building the index; building happens only via zg_index on an explicit user request.
- Changed the embedding but semantic hits are missing: switching embedding only takes effect after a rebuild with rebuild=true.
