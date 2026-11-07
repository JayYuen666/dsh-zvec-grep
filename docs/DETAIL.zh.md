# Zvec 索引检索

用本地索引检索工作区，而不是裸 grep；也可以要求先走一次索引检索，才允许用普通 `grep` / `rg`。

## 设置卡上改的是什么

- **检索模型** — `defaultEmbedding`（默认 `local/qwen3-embedding-0.6b`，约 640 MB）只作用于**新建**的索引；已有索引沿用它自己的模型，要换得先重建。下拉分本地与远程两组：远程 qwen 模型（0.3.0 新增三枚）需在部署配置里打开 `allowRemoteEmbedding` 才可选——远程会把工作区内容送到外部端点，且首次索引要用户执行一次 `zg --auth grant` 授权。`defaultLimit`（1–50，默认 10）是每组结果返回多少条命中。
- **网络与索引** — 「检索传输方式」（`transport`，0.3.0 起）三档：自动 = 守护进程在跑时检索走 MCP（常驻模型池、队列调度），否则走 CLI；仅 CLI = 永不碰守护进程；仅 MCP = 检索恒走守护进程，缺席时由插件自动拉起（会开 `127.0.0.1:7999` 回环端口；拉起失败明确报错，不静默回退）。`hfEndpoint` 默认指向 ModelScope 镜像（`https://modelscope.cn/models`）；留空就是 huggingface.co，而这个环境通常连不上，所以默认值应当保留。`enforceSearchFirst`（默认开）在已建索引的工作区里拦住 `grep` / `rg`。`grepBudgetPerSearch`（默认 3）是一次**走索引的** `zg_search` 解锁多少次直查（无索引时自动改走穷举词法的检索同样成功，但不发配额），`unlockWindowMin`（默认 10）是这份解锁维持几分钟。配额按「会话 × 索引根」记录（索引根是 root 或最近的含索引祖先，最多上溯 8 层），不是全局一份；「让路」只在宿主提供了步骤准入（`toolSet`）且该视图不含 `zg_search` 时成立——不提供准入信息的宿主仍按原判据拦截。有效期在每次取用配额时现判，窗口一过就不再放行直查、不需要重启；分片表按会话数封顶 256，超出时先淘汰最久未用的那一份。该索引根上有活跃重建时，检查临时放行且**不消耗配额**：重建持着写锁，这期间语义检索必然失败，检查不能再把直查一起堵死。本步骤的工具准入不含 `zg_search` 时，检查让路，不强迫模型去调一个本步骤调不动的工具。

这些每次调用现读，改完不需要重启宿主。

## 并发与平台

- **同一宿主**内的并发冷启动合并成一发 `zg --server on`。**多个宿主**共用 `ZVEC_GREP_HOME` 时共享同一个守护进程（上游 `instance.lock`；重复启动退 0 并回同一个 PID）。token 用 O_EXCL 原子认领，后来者读回同一枚，不会互相覆盖；只有创建者会在卸载时停掉自己拉起的 daemon。
- 同一条 zg MCP 会话一次只处理一个 `tools/call`（实测两发并发时第二条会挂到调用方超时），所以每个并发工具调用各用一条会话，空闲会话复用；不把并发请求塞进同一条会话。索引作业的并发上限（默认 2）与同根写作业复用由上游调度器负责。
- 检索只在同根索引重建持写锁时等待，上限 `rebuildWaitMs`；冷启动本身不排队。
- **平台**：POSIX 收 `/…` 根、bash 单引号转义；Windows 收盘符/UNC 根、pwsh 单引号转义（内嵌 `'` 写成 `''`）、命令名剥 `.exe`/`.cmd` 等扩展，并按 CreateProcess 余量把命令规模上限收到 24000 字节。Windows 的真盘行为由 CI 的 `windows-latest` 格验证；本地用平台注入的 win32 夹具覆盖同一套判据。

## Rebuild 不是设置项

卡上的 Rebuild 是对守护进程已经观察到的工作区跑一次等价于 `zg --index --rebuild` 的动作，不是被存起来的偏好。这条路上不会弹审批：pre-execute 审批只覆盖显式给了 root 的 `zg_*` 工具，Remote 方法不走工具准入；真正管住它的是守护进程那份已观测根白名单（以及它自己的单操作锁）。

## 要重启的值

十一项部署值刻意不进设置卡：`searchTimeoutMs`（300000）、`statusTimeoutMs`（60000）、`indexTimeoutMs`（600000）、`stdoutMaxBytes`（400000）、`rebuildWaitMs`（120000）、`clientMode`（`auto` / `direct` / `server`）、`daemonUrl`（`http://127.0.0.1:7999/mcp`，MCP 传输的守护进程端点）、`allowRemoteEmbedding`（false）、`remoteEmbeddingEndpoint`、`remoteEmbeddingApiKeyFrom`、`requireApprovalForExplicitRoot`（false）。这十一项在卡上没有入口，能生效的只有下一段那条注册行 `config:`；优先级是注册行 `config:` > 代码里的 `.default()`。

「工作区内容能不能离开本机」被当成部署决定，而不是给模型选的开关，所以远程嵌入那三枚既不在卡上也不在工具参数里；即便开了，`zg` 自己仍要求 `--allow-remote`（部署开放后本插件在远程引用的索引命令上自动补）或一次 `zg --auth grant` 持久授权。这些值都写在**自己 profile 的 `cordis.yml`** 里本插件注册行的 `config:` 块（随包那份 `cordis.patch.yml` 带本行的 `id` / `name`，另有一条**不写 id** 的 `@jayyuen66/dsh-plugin-shared` 条目供应卡片组件——删掉它设置卡会失去组件供应），改值随重启生效。

## 需要外部提供什么

外部 `zg` 命令行（`@zvec/zvec-grep`，装法是 `npm install -g @zvec/zvec-grep`）。本插件在拼出任何命令之前先校版本，下限是 **0.3.0**（上游 Rust 重写后的 CLI 形态与 0.2.x 不兼容，0.2.x 会在门槛处被拦下），装的版本低于它会直接说明；命令行不存在时按「未安装」报，而不是伪装成一次查不到。增量索引刷新、`refresh=background` 与常驻模型池都需要守护进程在跑（`zg --server on`），离线时卡上会写出来。本地嵌入的后端可能还要各自的依赖（llama-cpp 需要 `node-llama-cpp`；model2vec 与 transformers-js 是纯 JavaScript）。只有 `allowRemoteEmbedding` 开着时，插件才向 `zg` 转发这两个变量：`ZVEC_GREP_ENDPOINT` 放的是 `remoteEmbeddingEndpoint` 的字面值（部署端点，不是变量名），`ZVEC_GREP_API_KEY` 才是按 `remoteEmbeddingApiKeyFrom` 指的变量名去环境里查出来的密钥。密钥要显式转发，因为宿主的子进程层会抹掉形似密钥的变量。

## 更完整的说明

参数守卫、`root`判据与后台作业那一节都写在随包 README（`README.md` / `README.zh-CN.md`）。README 没有独立的错误码表：`zg` 不在 PATH 上按 `exit 127` 归到「未安装」（见「外部依赖」一节），其余失败按工具回执里的 `reason` 读。
