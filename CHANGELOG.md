# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.5-rc

把 **Windows 的支持范围说清楚，并让 CI 按这个范围分工**。直接起因是 `b121e91`（0.1.4）推上去之后 `gate (windows-latest, 22)` 交了 184 条失败：唯一成因是 root 判据只认以 `/` 开头的绝对路径，而 win32 上 `os.tmpdir()` 交回盘符形态（`C:\Users\RUNNER~1\AppData\Local\Temp\…`），凡是要在盘上造真实工作区的用例都在 `rootOf` 先被拒、根本走不到被测行为。**这不是 0.1.4 改出来的**（184 条里 173 条的用例在 0.1.3 就存在，两版对 win32 也只保护了「造不出属主不可读文件」那一档），而是这一格的结果第一次被端上来。

### Changed

- **CI 两格分工**：ubuntu 格跑 `pnpm run check`（全部门禁，含四项 100% 覆盖率）；其余平台跑新增的 `pnpm run check:platform`——同一套 typecheck / lint / 两个 bundle / 全量用例 / `oxfmt`，只是不判覆盖率。理由写在 `ci.yml` 的注释里：需要盘上真根的用例在 win32 整块跳过之后，`host.ts` 的覆盖率本就到不了 100%，把阈值调低等于把 ubuntu 格的真约束改成装饰。
- **`test/host.test.ts` 按平台跳过 24 个 suite**（谓词收成一处 `realRootUnavailable = process.platform === "win32"`，各 suite 写 `describe.skipIf(realRootUnavailable)(…)`）。写成字面上的 `describe.skipIf` 而不是包一层别名：oxlint 的 vitest 规则按 `describe` 识别 suite，别名会让整文件被当成一个作用域，实测冒出 221 条 `consistent-test-it` 噪声。**没有**跳过在 win32 上原样通过的那 6 个 suite（信任闸门、白名单有效期、hitSummary、探测缓存、render 全性、隐式注册验收）——跳掉一条本来会绿的用例就是抹掉真实信号。
- 两份 README 新增「支持面 / Support surface」一节：本包是 POSIX-only，Windows 宿主下三个 zg 工具在 `rootOf` 当场拒并说明原因（fail-fast，不会拿错位路径去拼命令、也不会把错路结果当正常检索交回模型）；真要支持 Windows 得动 root 归一、第二套命令形态（pwsh/cmd 的引号与 `bash -c` 不同义）、门禁的 `/` 切词与 `manifest.json` 的 `rootPaths` 比对，属设计变更。

### Fixed

- 新增 `test:platform` / `check:platform` 两个脚本，让「不判覆盖率的那套门禁」在 package.json 里单源，CI 只挑命令——避免 workflow 里内联一串命令、日后与本地脚本各走各的。

## 0.1.4

把 **zg 守护进程（server 模式）这一档能力差从「使用限制」变成显式判据**：`--mode auto` 在 daemon 缺席时由上游静默落回 direct（模型逐次冷加载、增量刷新与 `refresh=background` 都不存在），而本包过去既没有一处说明，也没有拦住那个不可能兑现的参数。顺带修掉两处评审确认的缺陷：`requireApprovalForExplicitRoot` 会为**注定被拒**的 root 弹一次换不来放行的确认；两份 README 与 `host.ts` 头注释的配置面数字早已和 schema 脱节（14 vs 16、四个 vs 十枚）。

### Added

- **守护进程就绪门槛（`createZgServerGate`）**：按 TTL（60 秒）缓存 `zg server status --check-ready` 的**退出码**（上游契约：就绪 0、未就绪以「zvec-grep server is not ready」非零退出；读 stdout 那份状态表不行，它给人看、不在本包的依赖契约里）。探测失败一律折成「未就绪」，**绝不外抛**基础设施故障，也绝不影响 `wait` / `off` / 穷举检索这些照常能用的通道。本包**不代为 `zg server on`**：那会在用户机器上落下 detached 长驻进程与 token 文件，属该由用户点头的动作。
- **`refresh=background` 收口（`BackgroundSupport` 三档）**：不可用时在**命令构造期**就拒，并区分两种成因各给一句诚实文案——守护进程缺席（出路是 `zg server on`）与部署把 `clientMode` 钉死 `direct`（此时叫用户起 daemon 是指错方向，出路是回行 config 改模式）。旧行为是让命令照发、由 zg 把刷新整个关掉、只留一行 stderr warning：退出码照旧 0、命中照旧出，唯独「后台在刷新」这件事是假的。判据只有 `backgroundSupportFor` 一处，模式与探测两步都由宿主算（纯构造器只按它折成拒绝）；没人要这一档时不起探测，穷举通道也不起（它本就不接受 `refresh`）。
- **就绪态回显两处**：`zg_status` 的输出尾部各说一句（就绪讲能拿到什么，未就绪讲后果与出路），设置卡新增一行；重建期那条「合成投影」不补——它的契约本就是不启任何子进程。引导端点 `rebuild-roots` 的应答新增 `serverReady`，卡片判据收在可单测的 `daemonNoteKey`：应答里**没有这一位**（旧版 host）时不渲染，而不是把「不知道」显示成「未就绪」。
- **无 `Code:` 行的失败补一句 `--debug` 指引**：上游不带 `--debug` 时会把 `MODEL2VEC_DOWNLOAD_FAILED` 与 `INDEXING.FILES_FAILED` 塌成一句无码文案（首次下载 embedding 权重正落在这一档），而本包所有按码归因都读那一行 `Code:`。现在只有「非零退出、有输出、却没有 `Code:` 行」那一支补指引；空输出不补（谈不上「塌成一句」），带码的不补（归因本就够）。本包**不默认带** `--debug`：它明显拉长输出，而这三个工具的回显预算是给模型读的。
- **文档数字的门禁**：`test/readme-parity.test.ts` 新增一条，把中英两份声明的「字段总数 / 卡上 volatile 数 / 非 volatile 部署值数」与导出 `Config` 的实际形状逐一对齐（第三枚是可推导的：总数 - volatile）。原有的结构对等门只能抓到「一侧多了一节」，抓不到两侧一起写错——这次正是两侧一起错。

### Fixed

- **`requireApprovalForExplicitRoot` 不再为注定被拒的调用发问**。旧判据是「显式 root 既不是会话工作区、也不在 ledger」，于是对 `/etc`、相对路径、盘上不存在、没有会话工作区可作参照这些 `rootOf` **一律拒**的调用也弹一次确认；用户点「允许一次」之后照样被拒（那道闸刻意只加不减），确认成了让人为一个无法兑现的承诺点按钮。现在发问判据与 `rootOf` **同源**：两者共用同一个 `judgeRoot`，只有「靠与会话工作区互为祖先/后代这一条才放行」的调用才发问。同时删掉 `sameAsSessionRoot` 那第二条判据（它比 `judgeRoot` 宽，正是漏问/误问两侧漂移的来源）。
- **search-first 门禁不再误拦「管道下游、只过滤上游输出」的 grep**。`isGrepRgCommand` 原先把命令位上的 grep/rg 一律判成检索，于是 `ps aux | grep node`、`env | grep KEY`、`dscacheutil -q host | grep ip_address`（实测被拦）这类**根本不读文件系统**的调用也被要求「先 zg_search」——门禁要建立的「已用语义检索定向」那条证据链对它无从谈起。现在 token 多带一档「是否由 `|` 喂入」（只有管道算，`;` 与 `&&` 之后的命令不算），管道下游那一支还要**后随实参里出现路径形状的操作数**（`/x`、`a/b`、`.`、`..`；旗标不算）才判为检索，带路径的管道调用照旧算。副作用方向是漏拦：`cat a.txt | grep foo` 因上游确实读了工作区文件而被放行，与 `hasExternalTarget` 的既有取舍同侧，代价由 systemPrompt 路由文本兜底。
- **`startBackgroundIndex` 不再构造哑值依赖**。它不是 HTTP 请求，过去要凑出 `RebuildRoutes` 就得给 `csrf` 塞空串、给 `servingNonLoopback` 塞 `false`——两个「没被用到」只靠下游恰好不读它们来保证的占位值。现在把起一条 `zg index` 写操作所需的依赖收窄成 `IndexWriteRoutes`（`RebuildRoutes extends` 它），哑值在类型上不再可能被构造出来。
- **删掉 `startBackgroundIndex` 那份重复的 JSDoc**：同一段 17 行文档在文件里出现两次，第二份悬在 `registerIndexTool` 头上，指向的却不是它下面那个函数。

### Changed

- 引导端点 `/_dsh/zvec-grep/rebuild-roots` 的 handler 转为 async（就绪态要在**信任闸门与方法判定之后**才取，被拒的请求不起子进程）。官方 `WebRoute.handler` 本就允许 `void | Promise<void>`，另两条路由一直是 async 形态。
- `buildSearchCommand` 新增第五位 `backgroundSupport`（缺省 `daemon-down`：拿不到判据时保守拒绝，而不是把一句假话发给模型）；`lib/cli.ts` 导出 `requestsBackgroundRefresh` 供宿主判「要不要探」。
- 两份 README：`--mode direct` 的过时说法改成按实现的 `auto` 口径并新增「守护进程（server 模式）」一节；配置面数字改成 16 / 6 / 10；`refresh` 与 `requireApprovalForExplicitRoot` 两节跟着上面的行为重写；`host.ts` 头注释同样对齐。
- 集成层新增一条按环境自适应的用例：`clientMode=auto` 时断言跟着**这台机器上守护进程的真实就绪态**给期望值（无条件式断言，不分支），另有一条钉死 `clientMode=direct` 时「命令根本没发出去」。

## 0.1.3

修复一处**跟着真实宿主语义失效的作业身份判据**（它让重建轮询恒 404、卸载只杀进程不摘作业 ⇒ 官方环缓冲留在宿主内存），并给 `ignoreFiles` 补上起进程之前的**存在性 + 可读性**预检（一条读不成的忽略文件会永久弄坏整棵工作区索引）。测试面从「单测 + mock 宿主」扩到三层：新增真宿主半栈的集成层与直怼真 zg CLI 的点对点层。

### Fixed

- **作业身份改用投影值，不再比注册表实例引用**。旧 `sameJob` 的一半判据是 `state.owner === ctx.get("jobs")`，而真实 cordis 每读一次服务都新建一枚 traceable 代理 ⇒ 同一枚注册表的两次读也不 `===`，该判据在真实宿主上**恒为假**（mock 上下文里恒真，故单测全绿、线上全崩）。后果有三：轮询端点对每条活着的重建恒回 404；卸载 / 超时臂只 `killProc` 而从不 `jobs.remove` ⇒ 官方环缓冲留在宿主内存里（内存泄露）；「同根第二条启动复用在跑那条」的 follow 恒不生效。现改用官方 `JobView` 上三段**值稳定**的投影（`kind` / `label` / `startedAt`）做身份——`JobView` 虽每次新建对象，这三个原始值却跨读恒定。`startedAt` 未盖章时用占位 `0`（官方签的是 `Date.now()`，永不为 0），保证 `start` 同步跑第一拍时不会把同 id 的另一条作业误认成自己的。
- **`ignoreFiles` 预检补上「可读性」这半段，并与「是否存在」合成一次判定**。原判据只查 `statSync().isFile()`，而它对 mode 000 / 他人属主的文件照样返回 `true`（stat 只要父目录可搜索、不要文件本身可读）；真 zg 去 open 它会 `EACCES` ⇒ 整次索引失败并把这条坏路径**写进工作区索引状态**，此后这棵树上的 `zg index` / `zg status` 都报同一个错，`--reset-paths` 清不掉，只有 `zg_index drop` 能救——与「文件不存在」是同一种永久损坏，却漏过了预检。现以 `accessSync(R_OK)` 在前、`isFile()` 在后合成一次 try：`accessSync` 与 zg 的读权限同 uid 同源（root 下两者都放行、非 root 下两者都拒），只查权限位、不读内容，没有 `readFileSync` 那种把大文件整段读进内存的代价。**刻意不拆成「不存在」与「读不了」两条独立分支 / 两句文案**：可读性那一档在 windows（chmod 只翻只读位、属主仍读得了）与 root（绕过 DAC）下造不出文件来触发，拆成独立分支会让 CI 的 windows 那格在 100% 覆盖率门禁下无从而钉（本仓不用 coverage-ignore 逃生口）；合成一条 catch 后由跨平台的「不存在」这一档钉住，三种成因（ENOENT / EISDIR / EACCES）共用一句「不是一份存在且当前进程可读的文件」文案。
- **`drop` 那一臂不再被 `ignoreFiles` 预检误拒**。`--drop` 的命令只有 `zg index <root> --drop --yes`，`ignoreFiles` 被 `buildIndexCommand` 静默丢掉、根本不进 zg（也就无从损坏索引）；而预检原先无条件先跑，于是 `drop:true` + 一条坏 `ignoreFiles` 会被「请给一个真实存在的忽略文件」这句误导文案拦下一次合法的删索引。现 `drop` 为真时整段跳过预检，判 `drop` 用与构造器**同一个** `boolOf`，两处口径不漂。

### Added

- **`ignoreFiles` 可用性预检（`assertIgnoreFilesExist`）**：模型够得着 `ignoreFiles` 这个参数，而一条读不成的忽略文件会永久弄坏工作区索引，属于必须在起进程之前拦下的那一类。前台索引、模型侧后台索引、设置卡重建这三条起 `zg index` 的路径共用同一道预检（卡片那条不带 `ignoreFiles`，天然空转）；`drop` 为真时整段跳过（见上）。三种不可用成因合成一句「不是存在且可读的文件」文案，双语，并写明代价与出路。
- **测试分三层**。原来只有 `test/*.test.ts`（单测 + 一枚 mock 宿主上下文）。新增：
  - `test/integration/*`：真宿主半栈——官方 cordis `Context` + `dsh-tools` 的 `ToolRuntime`（含 pre-execute 瀑布与官方 JSON Schema 子集校验）+ `dsh-subprocess-local` / `dsh-bash-local` 的本地 bash 执行器（真 spawn / 真 deadline / 真 stdout 上限与 spill / 真凭据擦除）+ `dsh-jobs-local` 的 `LocalJobRegistry`（真环 / 真泵 / 真容量）+ 真 `node:http` 监听的 `dsh-host-webserver` + timer + approval，把插件挂进官方调用管线（`ctx.tools.execute()` / 真 `fetch`）驱动。宿主契约的缺陷都出在这一层：mock 上下文只会同意本包已经相信的事（`ctx.get("jobs") === ctx.get("jobs")` 在替身里恒真、真实 cordis 恒假，正是上面那条 Fixed 的成因）。
  - `test/e2e/zg-cli.test.ts`：既无插件也无替身，只把 `lib/cli.ts` 造出的命令行喂给**真 zg CLI**，钉它的旗标面、输出形状、错误码，以及「坏 `ignoreFiles` 会弄坏整棵树」这类上游事实（含 ENOENT 与 EACCES 两档）。
  - **两层按环境 gate，而非无条件跑**：真-zg 的 integration + e2e 整体 `describe.skipIf(!zgAvailable())`——CI 的干净 runner 没装真 zg，硬跑会以「command not found」变红而不是跳过；本机装了 zg 才跑。本包自己的判据另由 `test/host.test.ts` 的 mock 宿主独立钉到 100%（`assertIgnoreFilesExist`：drop 跳过 / 不存在 / 读不了 / 放行，绝对与相对两种写法都覆盖），所以这两层在 CI 跳过后覆盖率不塌；「读不了」那档再按 `canMakeUnreadableFile()`（root 或 windows 造不出属主读不了的文件）单独跳过，也不依赖它保覆盖率。
- 两份 README 各补一段「测试分三层」的说明。

### Changed

- `devDependencies` 补 `@deepseek-ai/dsh-bash-local` / `dsh-http-proxy` / `dsh-subprocess-local` / `dsh-timeout`（真宿主台架的传递依赖，均**不进** `dependencies`）。
- `pnpm-workspace.yaml` 的 `allowBuilds` 把 `@deepseek-ai/dsh-subprocess-local` / `koffi` / `node-pty` 显式记为 `false`。这三枚是集测台架经 `dsh-subprocess-local` 传递引入的原生模块（各带安装脚本），而 pnpm 12 默认拦截未声明的构建脚本 ⇒ CI 那步 `pnpm install --frozen-lockfile` 以 `ERR_PNPM_IGNORED_BUILDS` 退出 1（本机因 `.modules.yaml` 早记下 ignoredBuilds 决定反而不报）。但本包根本用不到它们的构建产物：`dsh-subprocess-local` 经 `dsh-lazy-require` 惰性加载 `node-pty` / `koffi`，集成用例走的是 bash 执行路径、从不 require（本机 `.modules.yaml` 记的正是 ignoredBuilds，600 用例照绿）。显式 `false` 让 pnpm 跳过构建且不计入 ignoredBuilds（源码实测：唯有 `allowBuild()` 返回 `undefined` 的未声明档才报错），CI 也因此不必为用不到的原生模块在 windows 那一格背上 node-gyp 编译。`esbuild: true` 那条不动（vite 传递引入，确实要它落平台二进制）。
- `oxlint.config.ts` 的 `syncWrites` 声明 `chmodSync`（用例造 mode 000 的不可读忽略文件）与 `accessSync`（只读权限探针；共享基线的只读豁免表恰好没收录它，故经本包这唯一的 sync 例外口子声明）。

## 0.1.2

宿主生态跟到 `0.2.1-alpha.2`，并把一处**跟着宿主变更而失效的安全判据**改回可用。这一版还补上了发布面与装载面的门禁，以及中英两份 README。

### Fixed

- **`servingNonLoopback` 不再比字面量**。`@deepseek-ai/dsh-host-webserver` 的 `Config.host` 从两值联合（`'127.0.0.1' | '0.0.0.0'`）变成「本机任一网卡的具体地址」，而通配绑定（`0.0.0.0`、`::` 及其映射形）现在**在加载期就被拒**。于是每条路由的第一道信任闸门里那句 `webServer.host === "0.0.0.0"` 恒为 `false`：非回环服务面换了形态，判据还在找那枚绑不上的字面量，结果把服务在真实网卡地址上这一面当成回环服务——同一网段一方拿着网卡权威，`Host` 那条腿就不再收紧。现在改取 shared 导出的 `isNonLoopbackBindHost(webServer.host)`（它是 0.1.4 为这件事专门加的出口，JSDoc 明写「不要再自己比字面量」），判据同时覆盖 IPv6 回环的多种拼法。用例按四档钉：未声明绑定、`127.0.0.1`、`0.0.0.0`、本机网卡具体 IPv4。
- **装载期缺包**。`@jayyuen66/dsh-plugin-shared@0.1.4` 的 `dist/text.js` 值导入 `@deepseek-ai/dsh-output-retention`，而本包只用它的 `truncateEnd` / `truncateStart`，从不直接引那枚宿主包——升级后 `test/host.test.ts` 立刻以 `Cannot find package` 倒下，而类型检查、构建与其余 282 条用例全部照绿。按本包对宿主包的一贯口径补上：非 optional `peerDependencies` + `devDependencies` 同枚精确版本，**不进 `dependencies`**。

### Changed

- `@deepseek-ai/dsh-*` 家族与 peer 的 `@deepseek-ai/dsh` 从 `0.2.1-alpha.1` 升到 `0.2.1-alpha.2`；`@deepseek-ai/cordis` `4.0.5-alpha.1`、`@deepseek-ai/schemastery` `3.18.5-alpha.1`、`@deepseek-ai/cordis-plugin-timer` `1.1.7-alpha.1` **不动**——那是 alpha.2 自己钉的那几枚，registry 上没有更新的 alpha。
- `pnpm-workspace.yaml` 整体换成与 `dsh-danger-guard` / `dsh-plugin-shared` 逐字节相同的那一份：`dsh-*` 86 枚 override 跟到 alpha.2，工具链跟到 registry 现行头（`@types/node` 26.6.3→26.6.5、`vitest` 与 `@vitest/coverage-v8` 5.0.2→5.0.3、`vite` 8.3.1→8.3.4、`rolldown` 1.2.11→1.2.13、`oxlint` 1.86.0→1.87.0、`oxfmt` 0.71.0→0.72.0、`oxlint-tsgolint` 7.0.2003→7.0.2004、`happy-dom` 20.14.5→20.14.6、`jsdom` 30.1.1→30.1.2）。`@jayyuen66/dsh-plugin-shared` `^0.1.3`→`^0.1.4`（实装的 0.1.2 比声明还旧，锁文件已过期）。
- `engines` 取严格口径：`dsh: >=0.2.1-alpha.2`（shared 0.1.4 自己的 `engines.dsh` 就是这个下限，声明得更宽等于撒谎）、`node: ^22.19.0 || >=24.0.0`（同取自 shared）。宿主按 **peer 声明**判兼容、不读 `engines.dsh`，且逐条比对每一枚 `@deepseek-ai/dsh*`——本包的精确钉因此意味着**高于 0.2.1-alpha.2 的宿主也需要 `dsh plugin allow-version … --accept-risk`**，两份 README 已按实测写明。
- README 拆成中英两份：`README.md` 为英文、`README.zh-CN.md` 为中文，两份顶部互链。原来是一份文件里的 `## 中文` / `## English` 两段，正文一字未改地按语言切开。
- 注释里「钉进依赖 `.d.ts` 的行号」全量换成文件 + 符号/原文锚点。抽查即见腐坏：`dsh-tools` 那组（`ToolDefinition` / `ToolGuard` / `ToolRuntime`）随 alpha.2 整体漂了 7–17 行，`tool.execute` 的调用点也是。测试夹具里的 `src/beta.ts:1-3` 那类是 **数据**（zg 的输出形态），不在射程内。
- `.github/workflows/publish.yml` 跟 `dsh-danger-guard` 同款加固：`concurrency` 防两次 dispatch 并行、action 钉 commit SHA、预检加「读本包」这一档（只查依赖就发现不了「版本号没进 main 就触发」）、发布用的 `NODE_AUTH_TOKEN` 走与预检同款清洗、加 `--provenance` 与 `--publish-wait-timeout 600000`，并且不再把凭据长度打进日志。

### Added

- 新增 `.github/workflows/ci.yml`：`push` / `pull_request` 门禁跑 ubuntu×windows × node 22/24 的 `pnpm run check` 四格；另有一道**装载探针**——两个发布器各打一次包，进干净目录用 `npm install`（不带任何 flag）与 `npm pack` 的产物、`pnpm add` 与 `pnpm pack` 的产物各装一次，然后真 `import` 入口并断言它交出 cordis 插件形状（`apply` / `Config` / `inject`）、`cordis.patch.yml` 随包且在。上一轮那两起「全绿但装出去炸」的故障，判据只能落在这里。
- `test/publish-manifest.test.ts` 的门禁集合补齐：
  - `ALWAYS_SHIPPED` 改成实测清单。旧集合把 `CHANGELOG.md` 也算成「npm 无条件附带」，于是门禁比 npm 的真实语义更宽松、自己先失效。实测办法：包根临时放一份 `CHANGELOG.md` 与一份 `THIRD_PARTY_NOTICES.md` 且不写进 `files`，`npm pack --dry-run` 只回 `package.json`、`README*`、`LICENSE`。
  - 注释禁面加**本机绝对路径**（`/Users/…`、`/home/…`）：注释里的举例路径会被打包器原样搬进随包发布的产物，那是把本机用户名发到公共 tarball 的路。
  - 「包根的每一份 `.md` 都必须在发布面里」——一次性封住「新增文档忘了写进 `files` ⇒ 静默不随包分发」这一类，而不是每加一份补一条断言。
  - 产物面内部指涉扫描（本机绝对路径、`node_modules/.pnpm/` 内容寻址布局）。注释门读不到产物，因为 rolldown 剥注释；而 `//#region` 标记里的路径恰恰会进产物。
  - `shapeOf` 精确文件名条目的回归防线：把 `host.js` 误读成「收所有 `.js`」会让 `files` 覆盖那道断言的集合虚高，而它对失效毫无反应。
  - 「shared 出货产物值导入的宿主包，本包一律在 peer ∪ dev 里提供」——判面取**产物**而非 shared 声明的 peer 全集（纯类型面的成员本包不引就不该钉）。
- `test/dist-size.test.ts`：产物体积预算闸（host 半 240,000 B、client 半 54,000 B，取实测值上浮约 25%）。体积不是行为，不会让任何现有用例变红，所以得单独有把尺子。刻意不开 minify：压缩后产物里的跨包说明符字符串会消失，而「依赖必须外部化」那几条断言正是靠检索这些字符串来判的。
- `test/readme-parity.test.ts`：中英两份 README 的骨架对等门（标题层级序列、首行包名、顶部互链三处）。一侧加了节而另一侧没跟，不会有任何用例变红。
- `build-client.mjs` 产出前把 `//#region` 标记里的 pnpm 内容寻址段折成普通的 `node_modules/` 一层。client 半必须把 shared 的 `record.js` / `errors.js` **内联**（浏览器解析不了裸说明符），于是标记里烙着依赖版本与本机 store 哈希：既外泄安装布局，又让同一份源码在不同机器上产出不同字节。
- `.gitattributes`（`* text=auto eol=lf`）：Windows runner 上 Git for Windows 的机器级 `core.autocrlf=true` 会把工作树换成 CRLF，而 oxfmt 的 `endOfLine` 默认 lf —— 没有这份文件，新加的 windows 那一格会把每个文件都判成未格式化。
- `scripts.fmt`（`oxfmt .`），与既有的 `fmt:check` 配对。
- npm 发布元数据补齐 `keywords` / `bugs` / `homepage`（对照 plugin-shared 实测缺这三项）。`sideEffects: false` **不**照抄：client.js 是往 `window.__ModuleLoader__` 注册，属于真实副作用，标 false 等于授权打包器把它摇掉。新增「发布元数据面」两道门：description/keywords/license/author 齐备，以及 repository / bugs / homepage 三处按 `<账号>/<仓库>` 归一后必须同源——抄兄弟包的这一段再只改一处是必然会犯的错，那样 npm 页面上的「报告问题」会跳到别人的仓库。
- 上游归属信息（本包是在第三方 `@zvec/zvec-grep` 之上做二次开发）：两份 README 的「外部依赖」一节写清上游包名、仓库、**Apache-2.0** 许可、`0.2.2` 版本契约，以及「本包不含上游代码、不替上游分发」这条边界；新增 `THIRD_PARTY_NOTICES.md` 并写进 `files`（实测 npm 不自动附带 NOTICE 类文件，漏写等于没随包分发）；新增「开发」与「许可」两节，与 dsh-ocr-review 的双语 README 骨架对齐。

## 0.1.1

评审收口：索引重建、宿主版本门与远程 embedding 的边界。

### Added

- 后台重建作业走官方注册表（`ctx.jobs`）：环、留存、容量与生命周期都在宿主侧，本包不再自带并发上限；模型侧 `job_list` / `job_output` / `job_kill` 因此看得见这次重建。
- 索引版本门（`lib/zg-version.ts`）与 zg 错误分类（`lib/zg-errors.ts`）、重建状态盒（`lib/rebuild-state.ts`）。
- 远程 embedding 的开关与端点/凭据来源边界，缺席即明确报错而不是静默降级。

## 0.1.0

`@jayyuen66` 作用域下的第一个发布版本。

### Changed

- 索引根判据改认 `manifest.json`，修掉「全局 home 被当成索引根」导致的门禁误判。
- 发布凭据改走 `NODE_AUTH_TOKEN`（`setup-node` 配了 `registry-url` 之后 npm 只读它自己生成的那份 `.npmrc`，`$HOME/.npmrc` 会被完全忽略）。

### Earlier

`0.1.0` 之前那段（`@jayyuen666` 作用域、`0.3.1`、作用域迁移那次误发的 `1.0.0`）压进了本仓的第一条提交记录，要旨逐条写在那条 message 里——早期那几枚提交号已随这次历史重写失效，别再按 SHA 去找。npm 上那几个已发布的版本号则永久留存，不随仓库历史回收。
