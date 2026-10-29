# Zvec 索引检索

用本地索引检索工作区，而不是裸 grep；也可以要求先走一次索引检索，才允许用普通 `grep` / `rg`。

## 设置卡上改的是什么

- **检索模型** — `defaultEmbedding`（默认 `local/qwen3-embedding-0.6b`，约 640 MB）只作用于**新建**的索引；已有索引沿用它自己的模型，要换得先重建。`defaultLimit`（1–50，默认 10）是每组结果返回多少条命中。
- **网络与索引** — `hfEndpoint` 默认指向 ModelScope 镜像（`https://modelscope.cn/models`）；留空就是 huggingface.co，而这个环境通常连不上，所以默认值应当保留。`enforceSearchFirst`（默认开）在已建索引的工作区里拦住 `grep` / `rg`。`grepBudgetPerSearch`（默认 3）是一次成功的 `zg_search` 解锁多少次直查，`unlockWindowMin`（默认 10）是这份解锁维持几分钟——解锁条目按自己的 TTL 与 LRU 过期，不等进程重启。本步骤的工具准入不含 `zg_search` 时，门禁让路，不强迫模型去调一个本步骤调不动的工具。

这些每次调用现读，改完不需要重启宿主。

## Rebuild 不是设置项

卡上的 Rebuild 是对守护进程已经观察到的工作区跑一次等价于 `zg index --rebuild` 的动作，带审批提示；它不是被存起来的偏好。

## 要重启的值

十项部署值刻意不进设置卡：`searchTimeoutMs`（300000）、`statusTimeoutMs`（60000）、`indexTimeoutMs`（600000）、`stdoutMaxBytes`（400000）、`rebuildWaitMs`、`clientMode`（`auto` / `direct` / `server`）、`allowRemoteEmbedding`（false）、`remoteEmbeddingEndpoint`、`remoteEmbeddingApiKeyFrom`、`requireApprovalForExplicitRoot`（false）。

「工作区内容能不能离开本机」被当成部署决定，而不是给模型选的开关，所以远程嵌入那三枚既不在卡上也不在工具参数里；即便开了，`zg` 自己仍要求 `--allow-remote` 或 `zg auth grant`。这些值都写在本插件注册行的 `config:` 块，改值随重启生效。

## 需要外部提供什么

外部 `zg` 命令行（`@zvec/zvec-grep`，装法是 `npm install -g @zvec/zvec-grep`）。本插件在拼出任何命令之前先校版本，地板是 **0.2.2**，装的版本低于它会直接说明；命令行不存在时按「未安装」报，而不是伪装成一次查不到。增量索引刷新、`refresh=background` 与常驻模型池都需要守护进程在跑（`zg server on`），离线时卡上会写出来。本地嵌入的后端可能还要各自的依赖（llama-cpp 需要 `node-llama-cpp`；model2vec 与 transformers-js 是纯 JavaScript）。`ZVEC_GREP_ENDPOINT` 与 `ZVEC_GREP_API_KEY` 按环境变量引用读取；密钥要显式转发，因为宿主的子进程层会抹掉形似密钥的变量。

## 更完整的说明

错误码表、参数守卫与后台作业面都写在随包 README（`README.md` / `README.zh-CN.md`）。
