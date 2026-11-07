// lib/daemon-client.ts —— zg 守护进程的 MCP 客户端（Streamable HTTP，零运行时依赖）。
//
// 为什么是裸 fetch 而不是 MCP SDK：本包对宿主包的运行时值导入面刻意收窄（见 host.ts
// 文件头），而 zg 的 MCP 面极小——本客户端只需要 initialize 握手 + tools/call 两个方法。
// 传输契约已对真 daemon 逐字实测（0.3.0）：
//   POST {url}  Content-Type: application/json
//               Accept: application/json, text/event-stream
//   → 应答为 SSE（`data: <json>` 行流），会话 id 在 **响应头** `mcp-session-id`；
//   → 通知（notifications/initialized）回 202 无正文；
//   → 未带会话或会话失效时请求被拒——重置会话重握手一次即可恢复。
// 鉴权：daemon 带 token 启动时（本插件自启的那一档）每个请求附
// `Authorization: Bearer <token>`（401/200 已实测）。token 由调用方经 tokenOf 现取——
// 它可能在本客户端存活期间才被生成（懒拉起那一拍），闭包值会过期。
//
// 本文件不含任何 zg 业务语义：参数映射在 lib/daemon-args.ts，失败识别复用
// lib/zg-errors.ts（MCP 错误文本与 CLI 同构，仅首行 `error[` 小写，码行定位已大小写不敏感）。
//
// 并发模型：同一条 MCP 会话一次只处理一个 tools/call（实测两发并发时第二发会挂到调用方
// 超时），因此 call() 从会话池里取一条**空闲**会话，并发调用各占一条；释放后留作空闲池
// 复用，超过 MAX_IDLE_SESSIONS 的旧会话被移出（daemon 侧 30 分钟空闲回收）。这样多个
// agent 同时检索时不会在客户端串行排队。

/** 上游缺省监听地址（`zg --server on` 的帮助原文：[–listen 127.0.0.1:7999]）。 */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:7999/mcp";

/** 一次工具调用的结果：text 为 MCP content 里全部 text 块的拼接，isError 原样透传。 */
export interface DaemonToolResult {
  readonly text: string;
  readonly isError: boolean;
}

export interface DaemonCallOptions {
  /** MCP 工具名（本包只调 `zvec_grep_search`，参数留 string 以免把上游面抄成本包类型）。 */
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** 整次调用的总预算（毫秒）：握手、通知、工具调用与重试都从同一枚 deadline 里扣。 */
  readonly timeoutMs: number;
  /** 外部取消信号（工具体收到的官方 signal）；超时与本信号任一触发即中止。 */
  readonly signal?: AbortSignal | undefined;
}

export interface DaemonClient {
  call: (options: DaemonCallOptions) => Promise<DaemonToolResult>;
}

/** MCP 协议版本（对 0.3.0 daemon 实测接受的版本串）。 */
const PROTOCOL_VERSION = "2025-06-18";
/** 会话在哪些 HTTP 状态下视为失效：404（未知会话）、405/400（方法/请求形状被拒）。 */
const SESSION_LOST_STATUS: ReadonlySet<number> = new Set([400, 404, 405]);
/** 握手与工具调用的 JSON-RPC 常量。 */
const JSONRPC = "2.0" as const;

/** 单次 POST 的应答：状态码、（应答头下发的）会话 id、从正文收出的 JSON-RPC 载荷。 */
interface PostOutcome {
  readonly status: number;
  readonly sessionId: string | undefined;
  readonly payloads: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 从 SSE 正文收集全部 `data:` 行的 JSON 载荷；解析不了的行（心跳/注释）跳过。 */
function ssePayloads(body: string): unknown[] {
  const payloads: unknown[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    const json = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : "";
    if (json.length > 0) {
      try {
        payloads.push(JSON.parse(json) as unknown);
      } catch {
        // SSE 的 retry 提示等非 JSON 行：不是应答，跳过。
      }
    }
  }
  return payloads;
}

/** 应答体的载荷收集：SSE 拆行，普通 JSON 整体一枚（解析失败按无载荷处理）。 */
function responsePayloads(contentType: string, body: string): unknown[] {
  if (contentType.includes("text/event-stream")) {
    return ssePayloads(body);
  }
  try {
    return [JSON.parse(body) as unknown];
  } catch {
    return [];
  }
}

/** tools/call 的 JSON-RPC 应答块：错误对象或结果对象二者之一。 */
function replyOf(payloads: unknown[], requestId: number): Record<string, unknown> | undefined {
  const found = payloads.find((payload) => isRecord(payload) && payload["id"] === requestId);
  return isRecord(found) ? found : undefined;
}

/** 把 MCP result 的 content 拼成文本（只收 text 块）。 */
function resultText(result: unknown): string {
  const content = isRecord(result) && Array.isArray(result["content"]) ? result["content"] : [];
  return content
    .map((block) => (isRecord(block) && block["type"] === "text" ? block["text"] : undefined))
    .filter((piece): piece is string => typeof piece === "string")
    .join("\n");
}

/**
 * 协议层失败：daemon **已经应答**（JSON-RPC error / 应答形状不符）。这类失败是确定性的，
 * 重握手再发一次只会得到同一个答案——call() 的「重握手重试一次」只针对传输/会话抖动。
 */
class DaemonProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DaemonProtocolError";
  }
}

/** 客户端闭包量的共享状态：fetch 实现、端点与可变的会话 id（重握手会改写它）。 */
/**
 * 一条 MCP 会话。**并发调用必须各用一条**：实测 zg 0.3.0 的同一会话一次只处理一个
 * tools/call，第二条并发请求会一直挂到调用方超时（两条独立会话则 101ms 内并行完成）。
 * 会话按「空闲即复用」维护：顺序调用不重复握手，并发尖峰按需新开，释放后留作池。
 */
interface ClientSession {
  /** initialize 应答头里下发的会话 id；尚未握手时为 undefined。 */
  id: string | undefined;
  /** 已被某次 call 占用；true 时不会被另一个并发调用复用。 */
  busy: boolean;
}

/** 客户端闭包量的共享状态：fetch 实现、端点、token 现取器与会话池。 */
interface ClientState {
  readonly url: string;
  readonly doFetch: typeof fetch;
  readonly clientName: string;
  readonly tokenOf: () => string | undefined;
  sessions: ClientSession[];
}

/**
 * 空闲会话池上限：超出部分从池里移除（daemon 侧由自己的 30 分钟空闲回收兜底）。
 * 上限只约束**空闲**会话，不限制并发数——多个 agent 同时检索时各拿自己那条。
 */
const MAX_IDLE_SESSIONS = 8;

function authHeaders(state: ClientState): Record<string, string> {
  const token = state.tokenOf();
  return token === undefined ? {} : { Authorization: `Bearer ${token}` };
}

function buildHeaders(state: ClientState, sessionId: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...authHeaders(state),
  };
  if (sessionId !== undefined) {
    headers["mcp-session-id"] = sessionId;
  }
  return headers;
}

/**
 * 取消/预算耗尽的失败形状与真实 fetch 的取消一致：调用方（host.ts 的
 * daemonTransportFailure）按 AbortError 区分「超时/取消」与传输层错误。
 */
function abortedError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

async function post(
  state: ClientState,
  body: Record<string, unknown>,
  deadline: number,
  signal: AbortSignal | undefined,
  sessionId: string | undefined,
): Promise<PostOutcome> {
  // 外部信号在本次请求发起前就中止了：addEventListener 不会补发已经发生的 abort 事件，
  // 必须自己判 `signal.aborted`，否则取消后的调用仍会真发出去。
  if (signal?.aborted === true) {
    throw abortedError("The operation was aborted");
  }
  // 剩余预算为 0 时不再发请求：发出去也只会被立刻中止，多这一发还会把「握手慢」记成
  // 「调用失败」。整次调用（含重试）共用同一枚 deadline。
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw abortedError("daemon call budget exhausted");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, remaining);
  const onExternalAbort = (): void => {
    controller.abort();
  };
  signal?.addEventListener("abort", onExternalAbort);
  try {
    const response = await state.doFetch(state.url, {
      method: "POST",
      headers: buildHeaders(state, sessionId),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const nextSession = response.headers.get("mcp-session-id") ?? undefined;
    return {
      status: response.status,
      sessionId: nextSession,
      payloads: responsePayloads(response.headers.get("content-type") ?? "", text),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** initialize 握手：给这一条会话记下 id，再补 notifications/initialized。 */
async function ensureSession(
  state: ClientState,
  session: ClientSession,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (session.id !== undefined) {
    return;
  }
  const handshake = await post(
    state,
    {
      jsonrpc: JSONRPC,
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: state.clientName, version: "0.0.0" },
      },
    },
    deadline,
    signal,
    undefined,
  );
  if (handshake.status !== 200) {
    throw new Error(`initialize failed with HTTP ${handshake.status}`);
  }
  session.id = handshake.sessionId;
  // 无会话 id 的应答说明对端不是预期的 MCP HTTP 面——不猜，直接失败。
  if (session.id === undefined) {
    throw new Error("daemon did not issue an mcp-session-id");
  }
  // initialized 通知不带 id、不期待应答（202 即可）。
  await post(
    state,
    { jsonrpc: JSONRPC, method: "notifications/initialized" },
    deadline,
    signal,
    session.id,
  );
}

/** 取一条空闲会话；都忙就新开一条。并发调用因此各用一条会话，互不排队。 */
function acquireSession(state: ClientState): ClientSession {
  const idle = state.sessions.find((session) => !session.busy);
  if (idle !== undefined) {
    idle.busy = true;
    return idle;
  }
  const created: ClientSession = { id: undefined, busy: true };
  state.sessions.push(created);
  return created;
}

/**
 * 归还会话。`keep=false` 时从池里移除：会话被拒、请求被取消、或伺服方约定已乱，
 * 复用它只会把上一次的失败带进下一次调用。移除不发送 DELETE——daemon 自己的
 * 30 分钟空闲回收会关掉它；池只保留少量空闲会话，不长期占着。
 */
function releaseSession(state: ClientState, session: ClientSession, keep: boolean): void {
  if (!keep) {
    state.sessions = state.sessions.filter((entry) => entry !== session);
    return;
  }
  session.busy = false;
  const idle = state.sessions.filter((entry) => !entry.busy);
  if (idle.length > MAX_IDLE_SESSIONS) {
    const excess = new Set(idle.slice(0, idle.length - MAX_IDLE_SESSIONS));
    state.sessions = state.sessions.filter((entry) => !excess.has(entry));
  }
}

/** 工具调用的一次尝试（不含重试语义）。 */
async function callOnce(
  state: ClientState,
  session: ClientSession,
  callOptions: DaemonCallOptions,
  requestId: number,
  deadline: number,
): Promise<DaemonToolResult> {
  await ensureSession(state, session, deadline, callOptions.signal);
  const outcome = await post(
    state,
    {
      jsonrpc: JSONRPC,
      id: requestId,
      method: "tools/call",
      params: { name: callOptions.tool, arguments: callOptions.args },
    },
    deadline,
    callOptions.signal,
    session.id,
  );
  const { status, payloads } = outcome;
  if (SESSION_LOST_STATUS.has(status)) {
    // 会话失效是传输/会话档的抖动：交给 call() 换一条会话重试一次。
    throw new Error(`daemon rejected the session (HTTP ${status})`);
  }
  if (status !== 200) {
    throw new DaemonProtocolError(`tools/call failed with HTTP ${status}`);
  }
  const reply = replyOf(payloads, requestId);
  if (reply === undefined) {
    throw new DaemonProtocolError("tools/call reply missing from response");
  }
  if (isRecord(reply["error"])) {
    throw new DaemonProtocolError(JSON.stringify(reply["error"]));
  }
  const { result } = reply;
  return { text: resultText(result), isError: isRecord(result) && result["isError"] === true };
}

export function createDaemonClient(options: {
  /** MCP 端点（默认 DEFAULT_DAEMON_URL；部署可用 daemonUrl 行 config 覆写）。 */
  readonly url: string;
  /** Bearer token 现取器；返回 undefined 即不带鉴权头（用户自启的默认 daemon 无鉴权）。 */
  readonly tokenOf: () => string | undefined;
  /** fetch 注入（测试桩）；缺省 globalThis.fetch。 */
  readonly fetchImpl?: typeof fetch;
  readonly clientName?: string;
}): DaemonClient {
  const state: ClientState = {
    url: options.url,
    doFetch: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
    clientName: options.clientName ?? "dsh-zvec-grep",
    tokenOf: options.tokenOf,
    sessions: [],
  };
  return {
    call: async (callOptions: DaemonCallOptions): Promise<DaemonToolResult> => {
      // 总预算：握手、通知、工具调用与重试共用这一枚 deadline，不再按请求各发一份。
      const deadline = Date.now() + callOptions.timeoutMs;
      const first = acquireSession(state);
      try {
        const result = await callOnce(state, first, callOptions, 1, deadline);
        releaseSession(state, first, true);
        return result;
      } catch (error) {
        // 外部取消/超时不是会话问题，重试只会把等待时间翻倍——直接上抛，并丢掉这条
        // 会话：取消时可能还有一条未消费的应答留在它身上。
        if (isRecord(error) && error["name"] === "AbortError") {
          releaseSession(state, first, false);
          throw error;
        }
        // 协议层失败（daemon 已应答）是确定性答案，重试只会复现同一个错——直接上抛；
        // 会话本身仍然健康，可以继续复用。
        if (error instanceof DaemonProtocolError) {
          releaseSession(state, first, true);
          throw error;
        }
        // 其余失败（网络层/会话失效）换一条会话重试一次：并发下另一条会话可能仍然
        // 可用，重试不会影响别的 agent；预算同样从上面那枚扣。
        releaseSession(state, first, false);
        const retry = acquireSession(state);
        try {
          const result = await callOnce(state, retry, callOptions, 3, deadline);
          releaseSession(state, retry, true);
          return result;
        } catch (retryError) {
          releaseSession(state, retry, retryError instanceof DaemonProtocolError);
          throw retryError;
        }
      }
    },
  };
}
