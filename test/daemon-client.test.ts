// lib/daemon-client.ts 的单元测试：fetchImpl 桩下的握手/会话/错误映射/token 纪律。
// 期望值独立写明（按 0.3.0 daemon 的实测传输契约：SSE 应答、mcp-session-id 响应头、
// 202 通知、Bearer 401/200），不从被测函数派生。
import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createDaemonClient, DEFAULT_DAEMON_URL } from "../lib/daemon-client.ts";
import type { DaemonCallOptions, DaemonClient } from "../lib/daemon-client.ts";

/** JSON-RPC 初始化通知的方法名（多处桩共用，避免同一字面量重复）。 */
const INITIALIZED_METHOD = "notifications/initialized";

/** daemon-client 的请求头形状（测试只读这三位）。 */
type HeaderBag = Record<string, string>;

/** 会话 id 夹具（多段脚本共用同一份字面量）。 */
const SESSION = "sess-1";
/** 真 daemon 的应答媒体类型（桩必须与真面同形，多处引用）。 */
const SSE_TYPE = "text/event-stream";
/** 桩端点（DEFAULT_DAEMON_URL 的同值字面量，多处引用）。 */
const TEST_URL = "http://127.0.0.1:7999/mcp";

/** 让出若干轮微任务（递归链，不在循环里 await）。 */
async function microTicks(remaining: number): Promise<void> {
  if (remaining <= 0) {
    return;
  }
  await Promise.resolve();
  return microTicks(remaining - 1);
}

/** 「未配置 token」的现取器（AbortError 用例等共享；契约要求 undefined 而不是空串）。 */
function noToken(): undefined {
  return undefined;
}

/** 一次被记录的 fetch 调用。 */
interface LoggedCall {
  readonly url: string;
  readonly headers: HeaderBag;
}

/** 一次桩应答。 */
interface StubReply {
  readonly status: number;
  readonly sessionId?: string | undefined;
  readonly body?: string | undefined;
}

/** 一条 SSE 应答体（与真 daemon 的格式逐字同形：`data: <json>` 行）。 */
function sseBody(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function jsonRpcResult(id: number, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

/** 依调用序回放的 fetch 桩；超出脚本长度的调用复用最后一项。 */
function stubFetch(script: StubReply[]): {
  client: DaemonClient;
  log: LoggedCall[];
} {
  const log: LoggedCall[] = [];
  let index = 0;
  const impl = (async (url: unknown, init: unknown) => {
    const headers = (init as { headers?: HeaderBag }).headers ?? {};
    log.push({ url: String(url), headers });
    const reply = script[Math.min(index, script.length - 1)]!;
    index += 1;
    return new Response(reply.body ?? "", {
      status: reply.status,
      headers: {
        // 真 daemon 的应答都是 SSE；content-type 缺了本包会按普通 JSON 收（正确行为），
        // 桩必须与真面同形。
        "content-type": SSE_TYPE,
        ...(reply.sessionId === undefined ? {} : { "mcp-session-id": reply.sessionId }),
      },
    });
  }) as unknown as typeof fetch;
  const client = createDaemonClient({
    url: TEST_URL,
    tokenOf: (): undefined => undefined,
    fetchImpl: impl,
  });
  return { client, log };
}

/** 握手成功 + 通知受理 + 工具调用成功的标准五段脚本（两轮调用的量）。 */
function happyScript(firstText: string, secondText: string): StubReply[] {
  return [
    { status: 200, sessionId: SESSION, body: sseBody({ jsonrpc: "2.0", id: 0, result: {} }) },
    { status: 202 },
    {
      status: 200,
      sessionId: SESSION,
      body: sseBody(
        jsonRpcResult(1, { content: [{ type: "text", text: firstText }], isError: false }),
      ),
    },
    { status: 202 },
    {
      status: 200,
      sessionId: SESSION,
      body: sseBody(
        jsonRpcResult(3, { content: [{ type: "text", text: secondText }], isError: false }),
      ),
    },
  ];
}

/** 标准调用入参（多数用例共用；timeout 单位 ms）。 */
const CALL: DaemonCallOptions = { tool: "zvec_grep_search", args: {}, timeoutMs: 5000 };

describe("daemon-client 的握手与会话", () => {
  it("initialize → initialized → tools/call 三步；会话 id 取自响应头并随调用携带", async () => {
    const { client, log } = stubFetch(happyScript("ok", "unused"));
    const result = await client.call(CALL);
    assert.deepEqual(result, { text: "ok", isError: false });
    assert.equal(
      log.length,
      3,
      `initialize + initialized + tools/call，实际 ${String(log.length)} 发`,
    );
    assert.equal(log[0]!.headers["mcp-session-id"], undefined, "握手不带会话");
    assert.equal(log[1]!.headers["mcp-session-id"], "sess-1", "通知带会话");
    assert.equal(log[2]!.headers["mcp-session-id"], "sess-1", "调用带会话");
  });

  it("default daemon url 是上游缺省监听地址", () => {
    assert.equal(DEFAULT_DAEMON_URL, "http://127.0.0.1:7999/mcp");
  });
});

describe("daemon-client 的并发会话", () => {
  it("并发 call 各用一条会话（同会话并发会被上游串行化）；顺序 call 复用空闲会话", async () => {
    interface BodyCall extends LoggedCall {
      readonly body: string;
    }
    const log: BodyCall[] = [];
    let sessions = 0;
    const impl = (async (url: unknown, init: unknown) => {
      const headers = (init as { headers?: HeaderBag }).headers ?? {};
      const body: string = (init as { body?: string }).body ?? "";
      log.push({ url: String(url), headers, body });
      const request = JSON.parse(body) as {
        id?: number;
        method?: string;
        params?: { arguments?: { query?: string } };
      };
      if (request.method === "initialize") {
        sessions += 1;
        return new Response(sseBody({ jsonrpc: "2.0", id: 0, result: {} }), {
          status: 200,
          headers: { "content-type": SSE_TYPE, "mcp-session-id": `sess-${String(sessions)}` },
        });
      }
      if (request.method === INITIALIZED_METHOD) {
        return new Response("", { status: 202 });
      }
      // 两条并发调用都在 50ms 后才应答：若共用一个会话，第二发会挂到超时。
      await delay(50);
      return new Response(
        sseBody(
          jsonRpcResult(request.id ?? -1, {
            content: [{ type: "text", text: request.params?.arguments?.query ?? "" }],
            isError: false,
          }),
        ),
        { status: 200, headers: { "content-type": SSE_TYPE } },
      );
    }) as unknown as typeof fetch;
    const client = createDaemonClient({
      url: TEST_URL,
      tokenOf: noToken,
      fetchImpl: impl,
    });
    const [first, second] = await Promise.all([
      client.call({ ...CALL, args: { query: "a" }, timeoutMs: 1000 }),
      client.call({ ...CALL, args: { query: "b" }, timeoutMs: 1000 }),
    ]);
    assert.deepEqual(first, { text: "a", isError: false });
    assert.deepEqual(second, { text: "b", isError: false });
    const toolCalls = log.filter((call) => call.body.includes('"method":"tools/call"'));
    assert.equal(toolCalls.length, 2);
    assert.equal(
      new Set(toolCalls.map((call) => call.headers["mcp-session-id"])).size,
      2,
      "两个并发调用必须落在两条不同的 MCP 会话上",
    );
    // 第三条顺序调用：复用池里一条空闲会话，不再握手。
    const before = log.filter((call) => call.body.includes('"method":"initialize"')).length;
    await client.call({ ...CALL, args: { query: "c" }, timeoutMs: 1000 });
    assert.equal(
      log.filter((call) => call.body.includes('"method":"initialize"')).length,
      before,
      "顺序调用复用空闲会话",
    );
  });

  it("空闲会话池超过上限时丢弃多余会话；后续调用仍复用空闲会话", async () => {
    let sessions = 0;
    let initializes = 0;
    const impl = (async (_url: unknown, init: unknown) => {
      const body: string = (init as { body?: string }).body ?? "";
      const request = JSON.parse(body) as { id?: number; method?: string };
      if (request.method === "initialize") {
        sessions += 1;
        initializes += 1;
        return new Response(sseBody({ jsonrpc: "2.0", id: 0, result: {} }), {
          status: 200,
          headers: { "content-type": SSE_TYPE, "mcp-session-id": `sess-${String(sessions)}` },
        });
      }
      if (request.method === INITIALIZED_METHOD) {
        return new Response("", { status: 202 });
      }
      await delay(20);
      return new Response(
        sseBody(
          jsonRpcResult(request.id ?? -1, {
            content: [{ type: "text", text: "ok" }],
            isError: false,
          }),
        ),
        { status: 200, headers: { "content-type": SSE_TYPE } },
      );
    }) as unknown as typeof fetch;
    const client = createDaemonClient({
      url: TEST_URL,
      tokenOf: noToken,
      fetchImpl: impl,
    });
    // 9 个并发调用各自占一条会话；释放后空闲池上限是 8，多出的那条被移除。
    await Promise.all(Array.from({ length: 9 }, () => client.call({ ...CALL, timeoutMs: 1000 })));
    assert.equal(initializes, 9, "9 个并发调用各握手一次");
    const after = await client.call({ ...CALL, timeoutMs: 1000 });
    assert.deepEqual(after, { text: "ok", isError: false });
    assert.equal(initializes, 9, "第 10 次调用复用池里的空闲会话，不再新建");
  });
});

describe("daemon-client 的错误映射", () => {
  it("isError=true 原样透传（失败识别归 lib/zg-errors 与 host 层）", async () => {
    const { client } = stubFetch([
      { status: 200, sessionId: SESSION, body: sseBody({ jsonrpc: "2.0", id: 0, result: {} }) },
      { status: 202 },
      {
        status: 200,
        sessionId: "sess-1",
        body: sseBody(
          jsonRpcResult(1, {
            content: [{ type: "text", text: "error[ZG.ENGINE.NOT_FOUND]: no index" }],
            isError: true,
          }),
        ),
      },
    ]);
    const result = await client.call(CALL);
    assert.deepEqual(result, { text: "error[ZG.ENGINE.NOT_FOUND]: no index", isError: true });
  });

  it("JSON-RPC error 对象 → 抛错（协议层失败不是工具失败）", async () => {
    const { client } = stubFetch([
      { status: 200, sessionId: SESSION, body: sseBody({ jsonrpc: "2.0", id: 0, result: {} }) },
      { status: 202 },
      {
        status: 200,
        sessionId: "sess-1",
        body: sseBody({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32_602, message: "tool not found" },
        }),
      },
    ]);
    await assert.rejects(() => client.call(CALL), /tool not found/u);
  });

  it("会话失效（404）→ 重握手一次后成功；日志共五发（握手×2 + 通知×2 + 调用×1）", async () => {
    const { client, log } = stubFetch([
      { status: 200, sessionId: SESSION, body: sseBody({ jsonrpc: "2.0", id: 0, result: {} }) },
      { status: 202 },
      { status: 404 },
      { status: 200, sessionId: "sess-2", body: sseBody({ jsonrpc: "2.0", id: 0, result: {} }) },
      { status: 202 },
      {
        status: 200,
        sessionId: "sess-2",
        body: sseBody(
          jsonRpcResult(3, { content: [{ type: "text", text: "recovered" }], isError: false }),
        ),
      },
    ]);
    const result = await client.call(CALL);
    assert.deepEqual(result, { text: "recovered", isError: false });
    assert.equal(
      log.length,
      6,
      `握手×2 + 通知×2 + 调用×2（一次 404 一次成功），实际 ${String(log.length)}`,
    );
    assert.equal(log[4]!.headers["mcp-session-id"], "sess-2", "重握手后带新会话");
  });

  it("应答缺 mcp-session-id → 判为非预期面，握手即失败", async () => {
    const { client } = stubFetch([
      { status: 200, body: sseBody({ jsonrpc: "2.0", id: 0, result: {} }) },
    ]);
    await assert.rejects(() => client.call(CALL), /mcp-session-id/u);
  });
});

describe("daemon-client 的 result 形状容错", () => {
  it("result 缺 content / content 含非 text 块 → text 收空串或只收 text 块", async () => {
    // 第一发：result 无 content 字段 → text ""
    const { client } = stubFetch([
      { status: 200, sessionId: SESSION, body: sseBody({ jsonrpc: "2.0", id: 0, result: {} }) },
      { status: 202 },
      { status: 200, sessionId: SESSION, body: sseBody(jsonRpcResult(1, { isError: false })) },
    ]);
    const first = await client.call(CALL);
    assert.deepEqual(first, { text: "", isError: false });

    // 第二发：content 里混入非 text 块（如 image 占位）→ 只收 text 块
    const { client: client2 } = stubFetch([
      { status: 200, sessionId: SESSION, body: sseBody({ jsonrpc: "2.0", id: 0, result: {} }) },
      { status: 202 },
      {
        status: 200,
        sessionId: SESSION,
        body: sseBody(
          jsonRpcResult(1, {
            content: [
              { type: "image", data: "zzz" },
              { type: "text", text: "kept" },
            ],
            isError: false,
          }),
        ),
      },
    ]);
    const second = await client2.call(CALL);
    assert.deepEqual(second, { text: "kept", isError: false });
  });
});

describe("daemon-client 的协议层与中止路径", () => {
  it("tools/call 非 200 → DaemonProtocolError 上抛，不重试", async () => {
    const { client, log } = stubFetch([
      { status: 200, sessionId: SESSION, body: sseBody({ jsonrpc: "2.0", id: 0, result: {} }) },
      { status: 202 },
      { status: 500 },
    ]);
    await assert.rejects(
      () => client.call(CALL),
      (error: unknown) =>
        (error as { name?: string }).name === "DaemonProtocolError" &&
        /HTTP 500/u.test((error as Error).message),
    );
    assert.equal(log.length, 3, "协议层失败不重试");
  });

  it("应答 id 对不上 → reply missing 协议错误", async () => {
    const { client } = stubFetch([
      { status: 200, sessionId: SESSION, body: sseBody({ jsonrpc: "2.0", id: 0, result: {} }) },
      { status: 202 },
      {
        status: 200,
        sessionId: SESSION,
        body: sseBody(jsonRpcResult(999, { content: [{ type: "text", text: "x" }] })),
      },
    ]);
    await assert.rejects(() => client.call(CALL), /reply missing/u);
  });

  it("外部 signal 在途触发中止 → onExternalAbort 路径，AbortError 上抛", async () => {
    const controller = new AbortController();
    const log: LoggedCall[] = [];
    const impl = (async (_url: unknown, init: unknown) => {
      log.push({ url: String(_url), headers: (init as { headers?: HeaderBag }).headers ?? {} });
      // 等 abort 信号落到 listener 再拒绝：模拟「请求在途时被外部取消」。
      // once() 是 node:events 的现成 Promise 面（avoid-new 不许手搓 new Promise）。
      await once(controller.signal, "abort");
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }) as unknown as typeof fetch;
    const client = createDaemonClient({
      url: TEST_URL,
      tokenOf: noToken,
      fetchImpl: impl,
    });
    const pending = client.call({ ...CALL, signal: controller.signal });
    await microTicks(4);
    controller.abort();
    await assert.rejects(
      () => pending,
      (error: unknown) => (error as { name?: string }).name === "AbortError",
    );
    assert.equal(log.length, 1, "中止发生在握手期，只此一发");
  });
});

describe("daemon-client 的超时预算", () => {
  it("timeoutMs 到点：controller.abort() 触发，在途桩按 AbortError 收场", async () => {
    // 桩监听 init.signal：abort 落到 signal 才失败——与真实 fetch 的取消行为同形，
    // 于是 lib 里 post() 的 setTimeout abort 路径被真实走到。
    const impl = (async (_url: unknown, init: unknown) => {
      const { signal } = init as { signal?: AbortSignal };
      if (signal === undefined) {
        throw new Error("stub requires a signal");
      }
      await once(signal, "abort");
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }) as unknown as typeof fetch;
    const client = createDaemonClient({
      url: TEST_URL,
      tokenOf: noToken,
      fetchImpl: impl,
    });
    await assert.rejects(
      () => client.call({ ...CALL, timeoutMs: 50 }),
      (error: unknown) => (error as { name?: string }).name === "AbortError",
    );
  });

  it("总预算是整次调用的上限：握手 + 通知各耗 60ms 后，120ms 预算不再给 tools/call 另起一份", async () => {
    // 每个请求都耗时 60ms、预算 120ms：共享截止时间在第二发（通知）到点就中止；
    // 若按请求各发一份 timeoutMs，三发都会成功——这条用例钉的正是两者的差别。
    const log: LoggedCall[] = [];
    const impl = (async (url: unknown, init: unknown) => {
      const body: string = (init as { body?: string }).body ?? "";
      const request = JSON.parse(body) as { id?: number; method?: string };
      log.push({ url: String(url), headers: (init as { headers?: HeaderBag }).headers ?? {} });
      await delay(60);
      if (request.method === "initialize") {
        return new Response(sseBody({ jsonrpc: "2.0", id: 0, result: {} }), {
          status: 200,
          headers: { "content-type": SSE_TYPE, "mcp-session-id": SESSION },
        });
      }
      if (request.method === INITIALIZED_METHOD) {
        return new Response("", { status: 202 });
      }
      return new Response(
        sseBody(
          jsonRpcResult(request.id ?? -1, {
            content: [{ type: "text", text: "late" }],
            isError: false,
          }),
        ),
        { status: 200, headers: { "content-type": SSE_TYPE } },
      );
    }) as unknown as typeof fetch;
    const client = createDaemonClient({
      url: TEST_URL,
      tokenOf: noToken,
      fetchImpl: impl,
    });
    await assert.rejects(
      () => client.call({ ...CALL, timeoutMs: 120 }),
      (error: unknown) => (error as { name?: string }).name === "AbortError",
    );
    assert.equal(log.length, 2, "预算在 tools/call 之前耗尽：只发了握手与通知两发");
  });
});

describe("daemon-client 的资源释放", () => {
  it("每次请求的 abort 监听器与定时器都在 finally 里释放（成功路径）", async () => {
    vi.useFakeTimers();
    try {
      const { client } = stubFetch(happyScript("ok", "unused"));
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, "addEventListener");
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const result = await client.call({ ...CALL, signal: controller.signal });
      assert.equal(result.text, "ok");
      assert.equal(add.mock.calls.length, 3, "握手/通知/调用各注册一次");
      assert.equal(remove.mock.calls.length, 3, "三次都在 finally 里摘掉");
      assert.equal(vi.getTimerCount(), 0, "定时器全部清掉");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("daemon-client 的 token 与中止", () => {
  it("tokenOf 现取：每次调用都取当下值，undefined 即不带鉴权头", async () => {
    const log: LoggedCall[] = [];
    let token: string | undefined = "tok-1";
    const impl = (async (url: unknown, init: unknown) => {
      const headers = (init as { headers?: HeaderBag }).headers ?? {};
      log.push({ url: String(url), headers });
      // 应答 id 直接回显请求 id（与调用序号解耦；请求体第三个字段恒是 id）。
      const body: string = (init as { body?: string }).body ?? "";
      const request = JSON.parse(body) as { id?: number; method?: string };
      if (request.method === "initialize") {
        return new Response(sseBody({ jsonrpc: "2.0", id: 0, result: {} }), {
          status: 200,
          headers: { "content-type": SSE_TYPE, "mcp-session-id": "sess-1" },
        });
      }
      if (request.method === INITIALIZED_METHOD) {
        return new Response("", { status: 202 });
      }
      return new Response(
        sseBody(
          jsonRpcResult(request.id ?? -1, {
            content: [{ type: "text", text: "x" }],
            isError: false,
          }),
        ),
        { status: 200, headers: { "content-type": SSE_TYPE } },
      );
    }) as unknown as typeof fetch;
    const client = createDaemonClient({
      url: TEST_URL,
      tokenOf: () => token,
      fetchImpl: impl,
    });
    await client.call(CALL);
    // 首次调用三发（握手 + 通知 + 调用），其后会话已建、各只发一发 tools/call。
    assert.equal(log[0]!.headers["Authorization"], "Bearer tok-1");
    token = "tok-2";
    await client.call(CALL);
    assert.equal(log[3]!.headers["Authorization"], "Bearer tok-2", "现取器在下一次调用生效");
    token = undefined;
    await client.call(CALL);
    assert.equal(log[4]!.headers["Authorization"], undefined, "undefined 按未配置处理");
  });

  it("外部 signal 已中止 → 不发请求、AbortError 上抛、不重试", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as unknown as typeof fetch;
    const client = createDaemonClient({
      url: TEST_URL,
      tokenOf: noToken,
      fetchImpl: impl,
    });
    await assert.rejects(
      () => client.call({ ...CALL, signal: controller.signal }),
      (error: unknown) => (error as { name?: string }).name === "AbortError",
    );
    assert.equal(calls, 0, "已中止的信号既不发请求也不重试");
  });

  it("外部 signal 在调用开始前已中止：一次请求都不发，直接 AbortError", async () => {
    // addEventListener 不会把已经发生的 abort 补发给后来注册的监听器：不自己判
    // `signal.aborted`，取消后的调用仍会真的发出去（并把结果写进会话）。
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const client = createDaemonClient({
      url: TEST_URL,
      tokenOf: noToken,
      fetchImpl: impl,
    });
    await assert.rejects(
      () => client.call({ ...CALL, signal: controller.signal }),
      (error: unknown) => (error as { name?: string }).name === "AbortError",
    );
    assert.equal(calls, 0, "已中止的信号不该发出任何请求");
  });
});
