# dsh-zvec-grep 的传输与客户端模式（transport × clientMode）

> 适用版本：0.1.20+。源码依据：[host.ts](../host.ts) 的 `Config.transport` 与 `Config.clientMode` 注释、文件头注释第 2 条。

## 一句话总览

`transport` 决定**插件进程怎么跟 zg 说话**（起 CLI 子进程，还是 HTTP 直调 daemon）；`clientMode` 决定**CLI 子进程拿到什么 `--mode` 旗标**（自己直连索引文件，还是作为客户端连 daemon）。两者正交（[host.ts:280-281](../host.ts)：「它决定的是『插件怎么跟 zg 说话』，与 clientMode（CLI spawn 的 --mode 旗标）正交」）。

## 三个参与方

- **插件进程**（DSH 宿主内常驻）：注册 `zg_search` / `zg_index` / `zg_status` 三个工具。
- **zg CLI 子进程**：`transport` 落到 CLI 通道时按命令 spawn 的一次性 `zg` 进程，经宿主 shell 沙箱（Landlock/bwrap）执行。
- **zg daemon**（`zg --server`）：用户侧或插件拉起的常驻守护进程，持有索引租约、提供 MCP/HTTP 端点。

## transport（三档，volatile——设置卡可选）

| 档位 | 行为 |
|---|---|
| `auto`（默认） | daemon 就绪时 `zg_search` 的索引通道走 MCP（插件 HTTP 直调 daemon，见 [lib/daemon-client.ts](../lib/daemon-client.ts)）；daemon 缺席落回 CLI spawn。其余操作（`zg_index`、`zg_status` 等）一律 CLI |
| `cli` | 恒 CLI spawn，完全不碰 daemon 端口 |
| `mcp` | 检索恒走 MCP；daemon 缺席时由**插件拉起**（`zg --server on` + 自生成 `ZVEC_GREP_SERVER_TOKEN`，仅存本插件内存；起不来明确报错，不静默回退） |

配套部署值 `daemonUrl`：`transport=mcp` 自启 daemon 的 `--listen` 端点（默认上游缺省监听地址），改端口只改这一处。

## clientMode（三档，非 volatile 部署值，仅作用于 CLI 子进程的 `--mode`）

| 档位 | 行为 | 取舍 |
|---|---|---|
| `auto`（默认） | 守护进程就绪走 server、缺席由 zg 静默落回 direct | 默认稳妥档：zg 自己兜底 |
| `direct` | 恒直连：子进程自己直接读写工作区 `.zvec-grep/` 索引目录，不经任何 daemon | 风险：daemon 持有该根索引租约时写侧直接失败——daemon 可能由用户自己的 zvec-grep MCP 引入，插件无法假定它不存在（[host.ts:268-272](../host.ts)） |
| `server` | 恒连 daemon，没起就报连接失败 | 不做兜底，仅作显式部署选择 |

插件另按 TTL（60s）缓存一次对 daemonUrl 的 MCP initialize 握手结果（`createZgServerGate`，HTTP 200 即就绪），把 auto 档的「daemon 是否就绪」显式化，并统一处理 `refresh=background`。

## 组合矩阵（transport × clientMode）

| | clientMode=`direct` | clientMode=`server` | clientMode=`auto`（默认） |
|---|---|---|---|
| **transport=`cli`** | 每次子进程直连 `.zvec-grep/` | 每次子进程连 daemon | 就绪走 server、缺席落 direct |
| **transport=`mcp`** | clientMode 不参与（无 CLI 子进程；daemon 缺席由插件拉起） | 同左 | 同左 |
| **transport=`auto`（默认）** | daemon 缺席落回 CLI 时直连 | 落回 CLI 时也连 daemon | 检索走 MCP，落回 CLI 时按 auto |

「transport=cli + clientMode=direct」才是「插件每次起一个直连索引文件的 zg 子进程」，它是九种组合之一，**`direct` 不等价于 transport 的 `cli` 档**。

## 与沙箱（0.1.20 会话沙箱策略）的关系

- **CLI 通道**（`transport=cli`，或 `auto` 档落回 CLI 时）：zg 子进程经宿主 shell 沙箱执行；0.1.20 起 `sandboxPolicyOf(exec)` 为每次工具执行下发会话沙箱策略，workspace-write 边界跟随发起会话的 cwd（此前不传策略导致子进程被部署默认策略圈成只读，写 `.zvec-grep/locks/write-intent` 报 `os error 30`）。
- **MCP 通道**：插件用裸 fetch 直调 daemon（不经 shell 沙箱），沙箱策略不参与。就绪探测（0.1.23 起）同走 HTTP——对 daemonUrl 发一次 initialize 握手，网络栈不受 bwrap `--unshare-pid` 影响，宿主 daemon 活着时沙箱内照常探到就绪（旧判据 `zg --server status --check-ready` 依赖 PID 可见性，在 PID-namespace 隔离下恒误报未就绪）。
- **daemon 由插件拉起**（`transport=mcp` 且 daemon 缺席）：拉起路径经 shell 沙箱且**刻意不带**会话策略——Landlock 约束进程级不可逆，常驻 daemon 一旦被锁定将跨会话只读；此路径等部署层提供无 confine 的启动通道后再修（已知限制，见 [CHANGELOG.md](../CHANGELOG.md) 0.1.20）。
- 设置卡的「工作区重建」remote 路径同样不带策略（无会话上下文），由部署层 `additionalWritableRoots` 缓解。

## 版本/就绪探测（与 transport 无关的小常量）

版本探测 `probeZgVersion`（`zg --version`）是 tmpdir 下的只读 CLI 探测，TTL 缓存跨会话共享，从不带沙箱策略（0.1.20 决策）。就绪探测 `probeServerReady` 自 0.1.23 起改为对 daemonUrl 的 HTTP initialize 握手（有内存 token 时带 Bearer；超时/网络错/非 200 一律未就绪），不再 spawn CLI——对 `daemonUrl` 端点直探，也不受沙箱 PID 隔离影响（见上文沙箱段）。
