// lib/zg-config.ts —— 起一条 zg 命令要读的部署值（hf 镜像、传输模式、默认 embedding、
// 远程 embedding 的端点与凭据转发）。
//
// 为什么单列：工具这一层（search / index / status）与后台重建**必须**从同一处读出同一批值。
// 四条命令路径各读各的会在守护进程持有索引租约时把写侧和读侧配成不同传输模式；而
// 「默认 embedding 是哪一档」同时决定命令构造期的 allowlist 与设置卡的候选列表。
//
// 入参是结构子集而不是 host.ts 的 Config 整接口：本模块只读这几个字段，写成子集后
// 宿主侧改名/改型会在这里编译失败，而不是运行到某次 spawn 才发现读不到。

import { DEFAULT_EMBEDDING, isKnownEmbedding } from "./embedding-catalog.ts";
import { clientModeOf } from "./cli.ts";
import type { ClientMode } from "./cli.ts";
import { fill } from "./messages.ts";
import type { ZvecGrepMessages } from "./messages.ts";

/** 端点末尾斜杠。 */
const TRAILING_SLASHES = /\/+$/u;

/** 本模块读的部署值（宿主 Config 的结构子集）。 */
export interface ZgDeployConfig {
  readonly defaultEmbedding: { get: () => string | undefined };
  /** 宿主退化时可能交回非域值；收窄由 clientModeOf 负责，故这里声明 unknown。 */
  readonly clientMode: unknown;
  /** 命令构造与重建超时也用同一份部署值；本模块不读，但类型上共用一个结构子集。 */
  readonly stdoutMaxBytes: number;
  readonly indexTimeoutMs: number;
  readonly hfEndpoint: { get: () => string | undefined };
  readonly allowRemoteEmbedding: boolean;
  readonly remoteEmbeddingEndpoint: string;
  readonly remoteEmbeddingApiKeyFrom: string;
}

/** http(s) 且带 host 的基地址才算端点：`http://`、`/` 这类值不是可用的镜像基地址。 */
function isUsableBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname !== "";
  } catch {
    return false;
  }
}

/** 各环境读一个 HF 镜像/代理基地址的优先级：显式入参 > 设置。
 *  `typeof` 判断是 host 侧兜底：值域正常时 schema 的 `.default()` 已保证是字符串，
 *  引用被交回 undefined（条目未投影/宿主退化）时宁可不带 env，也不发一个空 HF_ENDPOINT。
 *  规范化（剥尾斜杠）之后还要再验一次：`/`、`///` 会被剥成空串，`http://` 这类没有
 *  host 的值也不是基地址——发一个空的或畸形的 HF_ENDPOINT 只会把失败推迟到
 *  node-llama-cpp 的下载期，定位成本远高于这里的一次静默省略。 */
function normalizedEndpoint(value: string | undefined): string | undefined {
  const normalized = typeof value === "string" ? value.trim().replace(TRAILING_SLASHES, "") : "";
  return normalized.length > 0 && isUsableBaseUrl(normalized) ? normalized : undefined;
}

function hfEndpointEnv(config: ZgDeployConfig): Record<string, string> | undefined {
  const endpoint = normalizedEndpoint(config.hfEndpoint.get());
  return endpoint === undefined ? undefined : { HF_ENDPOINT: endpoint };
}

/**
 * 部署值里的可选字符串：空串/空白/非字符串一律归一成 undefined（=「没配」）。
 * 收 `string | undefined` 而不是 `string`：这两个字段是**非 volatile** 部署值，正常装载
 * 下必有值（schema 的 `.default("")`），但行 config 若被绕过 schema 直接塞进来，
 * 这里仍要能判成「没配」而不是 `undefined.trim()` 抛在命令构造的中途。
 */
function trimmedConfigString(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 远程 embedding 是否被本部署显式开放。默认 false ⇒ 命令构造期就拒掉一切非本地引用。
 * 取值直接用字段本身：schema 声明的是 boolean，cordis 装载期已按它校验过行 config，
 * 再写一遍 `=== true` 只会多一条永远成立判断（lint 会当场判它 unnecessary）。
 */
export function allowRemoteEmbedding(config: ZgDeployConfig): boolean {
  return config.allowRemoteEmbedding;
}

/**
 * 远程凭据走的环境变量名形状：常规标识符。名字不受约束等于允许行 config 把宿主进程里
 * 任意变量（含与 zg 无关的敏感值）转发给子进程；`__proto__` / `constructor` 这类键还会
 * 让 `process.env[name]` 读到对象而不是字符串。不匹配的名字按「没配」处理。
 */
const ENV_NAME_SHAPE = /^[A-Za-z_]\w*$/u;

/**
 * zg 子进程的环境变量：HF 镜像 + （仅在部署开放远程 embedding 时的）远程端点与凭据，
 * 外加调用方要求追加的变量（transport=mcp 自启 daemon 时是 ZVEC_GREP_SERVER_TOKEN——
 * 该名含 TOKEN 会被官方 subprocess 层从继承环境剔掉，必须显式注入才到得了 zg 与它的
 * 子进程；同一名也作为 MCP 调用的 Bearer，见 host.ts 的 daemon 句柄）。
 *
 * **密钥只走环境变量，绝不进 argv**。两道原因，都是实测/读源码得来的：
 *   - 本包把整条命令当官方作业的 `JobSpec.label` 回显给卡片，argv 里的密钥会进界面、
 *     进日志、进 `ps` 的进程列表；
 *   - 上游自己就优先读环境变量（0.3.0 authorization.rs 的 remote_endpoint 读
 *     `ZVEC_GREP_ENDPOINT`，凭据同理），走 env 既是它的正路，也省掉一处 argv 泄露。
 *
 * **凭据为什么是「宿主进程里某个环境变量的名字」而不是值本身**：官方 subprocess 层会把
 * 名字命中 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量从子进程环境里**剔掉**
 * （packages/subprocess/subprocess/src/index.ts 的 `scrubbedParentEnv`），所以光靠在
 * 宿主进程里 export 一个 `ZVEC_GREP_API_KEY` 是到不了 zg 的——必须由本插件显式转发。
 * 于是配置里只记**名字**、值现读现转：密钥不必落进插件配置文件，也不进 argv、不进日志。
 * 两项都只在 allowRemoteEmbedding 打开时才读：默认部署下这段代码根本不执行。
 */
export function zgEnv(
  config: ZgDeployConfig,
  extra?: Record<string, string>,
): Record<string, string> | undefined {
  const env = { ...hfEndpointEnv(config), ...extra };
  if (allowRemoteEmbedding(config)) {
    // 与 HF 镜像同一套规范化与校验：畸形的远程端点宁可不带，也不再原样递给 zg
    // 把失败推迟到真正发请求时才暴露。
    const endpoint = normalizedEndpoint(config.remoteEmbeddingEndpoint);
    if (endpoint !== undefined) {
      env["ZVEC_GREP_ENDPOINT"] = endpoint;
    }
    const keyName = trimmedConfigString(config.remoteEmbeddingApiKeyFrom);
    // 只读那一个被点名的变量名，不把整份 process.env 倒出去；名字先过形状再取值，
    // 取到的也按 string 收窄（`process.env` 的索引访问在特殊键上不保证交回字符串）。
    const key =
      keyName !== undefined && ENV_NAME_SHAPE.test(keyName) ? process.env[keyName] : undefined;
    const secret = typeof key === "string" ? key.trim() : undefined;
    if (secret !== undefined && secret.length > 0) {
      env["ZVEC_GREP_API_KEY"] = secret;
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export function readDefaultEmbedding(config: ZgDeployConfig): string {
  const raw = config.defaultEmbedding.get();
  // 设置卡 0.3.0 起允许把默认模型选成远程 qwen 组（部署开放 allowRemoteEmbedding 的前提
  // 由命令构造期的闭集 allowlist 兜），所以这里的域是全集；未知引用仍回落默认。
  if (typeof raw === "string" && isKnownEmbedding(raw)) {
    return raw.trim();
  }
  return DEFAULT_EMBEDDING;
}

/**
 * 传输方式（插件级，与 CLI 的 `--mode` 是两层）：auto = daemon 就绪时检索走 MCP、否则 CLI；
 * cli = 恒 CLI spawn；mcp = 检索恒走 MCP，daemon 缺席时由插件拉起（起不来明确报错，
 * 不静默回退——用户显式选 mcp 就是显式承担了 daemon 的存在）。
 * 值域由 host schema 保证，这里只处理「字段缺省」与宿主退化：退回 auto（最保守的一档，
 * 不主动起进程也不主动绕开 daemon）。
 */
const TRANSPORT_TABLE = { auto: "auto", cli: "cli", mcp: "mcp" } as const;

export type ZgTransportMode = keyof typeof TRANSPORT_TABLE;

function isTransportMode(value: string): value is ZgTransportMode {
  return value === "auto" || value === "cli" || value === "mcp";
}

export function readTransport(value: unknown): ZgTransportMode {
  return typeof value === "string" && isTransportMode(value) ? value : "auto";
}

/**
 * 校验部署里的 `daemonUrl`：MCP 传输只认 `http(s)://host[:port]/mcp`。畸形值若放到
 * 调用期才炸，表现是「每次检索都失败一次」，这里在装载期就点名配置项与允许形状。
 * @param value 行 config 里的 daemonUrl（schema 只保证是字符串）
 * @param messages 文案表
 * @returns 原值（已 trim）
 */
export function readDaemonUrl(value: string, messages: ZvecGrepMessages): string {
  const trimmed = value.trim();
  let parsed: URL | undefined;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = undefined;
  }
  if (
    parsed === undefined ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname.length === 0 ||
    parsed.pathname !== "/mcp"
  ) {
    throw new Error(fill(messages.daemonUrlInvalid, { received: value }));
  }
  return trimmed;
}

/**
 * zg 传输模式：域内取值由 schema 保证，这里只处理「字段缺省」与宿主退化时交回的非域值。
 * 读一次即传给检索、索引、状态与后台重建四条命令路径——混用模式会在守护进程持有索引
 * 租约时让写侧直接失败，故四条路径必须同源。
 */
export function readClientMode(config: ZgDeployConfig, messages: ZvecGrepMessages): ClientMode {
  return clientModeOf(config.clientMode, messages);
}
