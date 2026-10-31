# Third-party notices

本包自身编写的代码以 MIT 发布，见 [`LICENSE`](./LICENSE)。本文件说清本包与第三方的**关系性质**：
按命令行为调用外部工具，而不是把第三方代码搬进来。

## 运行期调用的上游 CLI：`@zvec/zvec-grep`（提供 `zg`）

- 上游仓库：https://github.com/zvec-ai/zvec-grep
- 上游 npm 包：https://www.npmjs.com/package/@zvec/zvec-grep
- 上游许可：**Apache-2.0**（版权归上游仓库所有）
- 关系：本包是 dsh 侧的适配层——经宿主 shell 以 `--mode direct` 起 `zg` 子进程、构造其 argv、
  透传并按自己的口径解释其输出。本包**不**含上游源码、不内联上游产物、不重分发上游程序；
  上游由用户自行 `npm install -g @zvec/zvec-grep` 安装。正因如此，本包不随包附上游的许可文本：
  Apache-2.0 第 4 条的再分发条件挂在「被再分发的第三方代码」上，而本包里没有那段代码。若把两者
  打包在一起再分发，请按各自许可分别保留声明。
- 派生数据：`lib/embedding-catalog.ts` 的本地模型条目抄自上游 `0.2.2` 的 `EMBEDDING_MODEL_CATALOG`
  （只取「引用 / 后端 / 维度」三列），`lib/routing.ts` 的工作区清单文件名等常量与上游同名同值。这些
  是名称与数值一类的派生数据，不含上游实现代码；上游改了名称表时由 `verify:env` 与这一族用例发现。
  再分发时请连同上游的 Apache-2.0 声明一起保留。
- 版本契约：命令形态与旗标名按 `0.2.2` 书写；低于该版本本包在下发任何命令之前停住并点名实际版本
  （判据在 `lib/zg-version.ts`）。这是本包自负的责任边界——上游改了旗标语义却没升主版本时，只有
  这一族用例与那道版本门能发现。这道门是 **fail-open**：只认「整串就是一个三段数字」（`v` 前缀与
  首尾空白容忍），读不懂（多行、`0.2.2-rc.1`、`>=0.2.2`、探测失败）一律放行而不是拦死命令——把
  「探测不到」判成「太旧」，等于拿一个猜出来的版本拦住真实用户。
- 数据边界：索引与向量库（`.zvec-grep/`、`manifest.json`）由上游读写。本包只读 `manifest.json` 的
  `manifestVersion` 与 `rootPaths[].absolutePath`，用于「这份清单是不是本包认得的索引、覆不覆盖目标根」
  的判定；其余字段与索引本体不解析，也从不写入或改写。

## 编译期与运行期依赖

- `@jayyuen66/dsh-plugin-shared`（MIT）：同作者的共享工具库，随包从公共 npm 安装。
- `zod`（MIT）：设置卡 `src/rebuild-reader.ts` 的 strict codec 用它校验形状；版本走伞根 catalog，
  client 产物按宿主 `PLATFORM_MODULES` 保持 `require("zod")` 外部化。
- shared 自己的宿主包 peer（含 `@deepseek-ai/dsh-output-retention`）由 dsh 运行时提供——本包必须把
  这几枚也声明在 peer ∪ dev 上，否则装出去即 `ERR_MODULE_NOT_FOUND`（判据见
  `test/publish-manifest.test.ts`）。

## 宿主：dsh 与 `@deepseek-ai/*`

- 本包只按 dsh 公开的插件面（cordis 注册面与 `dsh-*` 的服务类型）编写，不复制宿主代码；宿主包
  一律走 peer，绝不进 `dependencies`（理由是消费侧安装布局会物化出第二份宿主类型面，同文件里那条
  门禁写着）。

## embedding 权重

- 权重由上游 `zg` 按其 `hfEndpoint` 自行下载。本包不经手、不缓存、不重分发任何模型文件。
