// lib/zg-config.ts —— 起一条 zg 命令要读的部署值（hf 镜像、传输模式、默认 embedding、
// 远程 embedding 的端点与凭据转发）。
//
// 为什么单列：工具面（search / index / status）与后台重建**必须**从同一处读出同一批值。
// 四条命令路径各读各的会在守护进程持有索引租约时把写侧和读侧配成不同传输模式；而
// 「默认 embedding 是哪一档」同时决定命令构造期的 allowlist 与设置卡的候选列表。
//
// 入参是结构子集而不是 host.ts 的 Config 整接口：本模块只读这几个字段，写成子集后
// 宿主侧改名/改型会在这里编译失败，而不是运行到某次 spawn 才发现读不到。

import { DEFAULT_EMBEDDING, isLocalEmbedding } from "./embedding-catalog.ts";
import { clientModeOf } from "./cli.ts";
import type { ClientMode } from "./cli.ts";
import type { ZvecGrepMessages } from "./messages.ts";

/** 本模块读的部署值面（宿主 Config 的结构子集）。 */
export interface ZgDeployConfig {
  readonly defaultEmbedding: { get: () => string | undefined };
  readonly clientMode: ClientMode;
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
function hfEndpointEnv(config: ZgDeployConfig): Record<string, string> | undefined {
  const endpoint = config.hfEndpoint.get();
  let env: Record<string, string> | undefined;
  if (typeof endpoint === "string") {
    const normalized = endpoint.trim().replace(/\/+$/u, "");
    if (normalized.length > 0 && isUsableBaseUrl(normalized)) {
      env = { HF_ENDPOINT: normalized };
    }
  }
  return env;
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
 * 再写一遍 `=== true` 只会多一条恒真判断（lint 会当场判它 unnecessary）。
 */
export function allowRemoteEmbedding(config: ZgDeployConfig): boolean {
  return config.allowRemoteEmbedding;
}

/**
 * 远程凭据走的环境变量名形状：常规标识符。名字不受约束等于允许行 config 把宿主进程里
 * 任意变量（含与 zg 无关的敏感值）转发给子进程；`__proto__` / `constructor` 这类键还会
 * 让 `process.env[name]` 读到对象而不是字符串。不匹配的名字按「没配」处理。
 */
const ENV_NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * zg 子进程的环境变量：HF 镜像 + （仅在部署开放远程 embedding 时的）远程端点与凭据。
 *
 * **密钥只走环境变量，绝不进 argv**。两道原因，都是实测/读源码得来的：
 *   - 本包把整条命令当官方作业的 `JobSpec.label` 回显给卡片，argv 里的密钥会进界面、
 *     进日志、进 `ps` 的进程列表；
 *   - 上游自己就优先读环境变量（zvec-grep v0.2.2 `src/engine/config.ts` 的
 *     `nonEmptyEnvironmentValue(environment.ZVEC_GREP_ENDPOINT)` / `environmentApiKey()`），
 *     走 env 既是它的正路，也省掉一条 argv 泄露面。
 *
 * **凭据为什么是「宿主进程里某个环境变量的名字」而不是值本身**：官方 subprocess 层会把
 * 名字命中 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量从子进程环境里**剔掉**
 * （packages/subprocess/subprocess/src/index.ts 的 `scrubbedParentEnv`），所以光靠在
 * 宿主进程里 export 一个 `ZVEC_GREP_API_KEY` 是到不了 zg 的——必须由本插件显式转发。
 * 于是配置里只记**名字**、值现读现转：密钥不必落进插件配置文件，也不进 argv、不进日志。
 * 两项都只在 allowRemoteEmbedding 打开时才读：默认部署下这段代码根本不执行。
 */
export function zgEnv(config: ZgDeployConfig): Record<string, string> | undefined {
  const env = { ...hfEndpointEnv(config) };
  if (allowRemoteEmbedding(config)) {
    const endpoint = trimmedConfigString(config.remoteEmbeddingEndpoint);
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
  if (typeof raw === "string" && isLocalEmbedding(raw)) {
    return raw;
  }
  return DEFAULT_EMBEDDING;
}

/**
 * zg 传输模式：域内取值由 schema 保证，这里只处理「字段缺省」与宿主退化时交回的非域值。
 * 读一次即传给检索、索引、状态与后台重建四条命令路径——混用模式会在守护进程持有索引
 * 租约时让写侧直接失败，故四条路径必须同源。
 */
export function readClientMode(config: ZgDeployConfig, messages: ZvecGrepMessages): ClientMode {
  return clientModeOf(config.clientMode, messages);
}
