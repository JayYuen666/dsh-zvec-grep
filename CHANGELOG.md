# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
