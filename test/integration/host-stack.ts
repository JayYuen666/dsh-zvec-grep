// 真实宿主半栈（集成测试的台架）：**官方** cordis Context + **官方**服务实现 + 本包插件。
//
// 为什么另起一套台架：test/host.test.ts 的 MockCtx 是本包对宿主契约的**复述**，它永远
// 只会同意本包已经相信的事情——`ctx.get("jobs") === ctx.get("jobs")` 那种替身语义就是典型：
// 真实 cordis 每读一次服务都新建一枚 traceable 代理，本包 sameJob 的实例身份比较因此在真实
// 宿主上恒为假，而 mock 里永远是同一个对象 ⇒ 单测全绿、卡片轮询 404。这里换成官方件：
//
//   - 注册与调度：@deepseek-ai/dsh-tools 的 ToolRuntime（含 pre-execute 瀑布 + 单调 guard
//     + 官方参数/输出 JSON Schema 子集校验）。工具经 `ctx.tools.execute()` 全管线跑，
//     不是直接调本包的 run。
//   - 执行：@deepseek-ai/dsh-subprocess-local + @deepseek-ai/dsh-bash-local 的本地 bash
//     执行器（真 spawn、真 deadline、真 stdout 上限与 spill、真凭据擦除）。
//   - 后台作业：@deepseek-ai/dsh-jobs-local 的 LocalJobRegistry（真环、真泵、真容量）。
//   - 路由：@deepseek-ai/dsh-host-webserver 的 WebServer（真 node:http 监听，端口由 OS 分配）。
//   - 计时：@deepseek-ai/cordis-plugin-timer。确认：@deepseek-ai/dsh-user-approval。
//
// 唯一不在册的官方件是 `settings`：真实 SettingsForms 要 configEditor + profileContext +
// cordis-plugin-loader 一整条 boot 链（dsh-config-editor → dsh-app-boot → dsh-home-paths …），
// 那不是本包契约的一环，故用一枚最小替身（只实现本包真正调的两个方法）。`settings: false`
// 把它关掉，用来验证「宿主没有 settings 时 apply 快速失败」。
//
// 本文件不是测试文件（无 .test.ts 后缀 ⇒ 不会被 vitest 收集），导出的一切由四个 *.test.ts 消费。

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Context as CordisContext } from "@deepseek-ai/cordis";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { ToolBatchInput } from "@deepseek-ai/dsh-tools";
import {
  apply as applyNativeExecutor,
  inject as nativeExecutorInject,
} from "@deepseek-ai/dsh-tool-executor-native";
import { ToolCallId as brandToolCallId } from "@deepseek-ai/dsh-llm/brand";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { TimerService } from "@deepseek-ai/cordis-plugin-timer";
import { WebServer } from "@deepseek-ai/dsh-host-webserver";
import type { ShellExecRequest, ShellExecSpec } from "@deepseek-ai/dsh-shell";
import plugin from "../../host.ts";

/** 官方工具体的一次执行结局（本包只读 isError/content/value）。
 *  `value` 可缺：官方失败形（ToolExecutionFailure）没有这个槐。 */
export interface ToolOutcome {
  isError: boolean;
  content: { type: string; text?: string }[];
  value?: unknown;
}

/** 官方 shell 请求/规格的配对（台架记录用：本包到底递了什么给官方执行器）。 */
export interface ShellCall {
  request: ShellExecRequest;
  spec: ShellExecSpec;
}

/** 空转的释放函数（settings 替身的 configure 要交回一枚）。 */
function noop(): void {
  // 无侠作。
}

/** 一枚最小 settings 替身：只实现本包 host 侧真正调的两个方法。 */
export class StubSettings {
  /** `describe()` 交回的行（插件只找 ns === "locale" 那条）。 */
  public rows: { ns: string; value: unknown }[] = [];
  /** `configure()` 的调用记录（页面策略声明）。 */
  public configureCalls: unknown[] = [];
  readonly #ctx: Context;
  public constructor(ctx: Context) {
    this.#ctx = ctx;
  }
  public describe(): { ns: string; value: unknown }[] {
    return this.rows;
  }
  public configure(presentation: unknown): () => void {
    this.configureCalls.push(presentation);
    return noop;
  }
  /** 插件 fiber 用的 fiber 引用占位（替身没有自己的 fiber）。 */
  public get fiber(): Context["fiber"] {
    return this.#ctx.fiber;
  }
}

/** 一枚会话替身：只带本包真正读的 `agent.session.header.cwd`（与 dsh-tool-fs-search 同模式）。 */
function agentOf(cwd: string, id = "sess-1"): BatchAgent {
  // 本包只读 session.header.cwd；给的是官方 Agent 的最小投影，不是完整实现。
  return { session: { id, header: { cwd } } } as unknown as BatchAgent;
}

/** 官方批次里可选的 Agent 位（本包只读它的 session.header.cwd，用最小投影即可）。 */
type BatchAgent = NonNullable<ToolBatchInput["agent"]>;

/** 工具交回的模型可见文本（render 之后的 content 文本块拼接）。 */
function textOf(outcome: ToolOutcome): string {
  return outcome.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n");
}

/** 起一台真实宿主。所有服务都是官方件；只有 settings 是上面的最小替身。 */
export async function startHost(
  options: {
    /** 递给 cordis 装载期的**行 config**（会被插件的 Config schema 校验并填默认值）。 */
    config?: Record<string, unknown>;
    /** 官方 locale 偏好（写进 settings.describe() 的那一行）。缺省 = 不投影 ⇒ 中文。 */
    locale?: string;
    /** 要不要 settings 服务（false = 故意缺席，验证 apply 的快速失败）。 */
    settings?: boolean;
    /** 后台 rebuild 的 kill 定时器时长（ms；用来测超时杀进程）。 */
    indexTimeoutMs?: number;
    /** 显式 root 是否走官方用户确认（部署开关）。 */
    requireApprovalForExplicitRoot?: boolean;
    /** 一并装一枚审批服务（不装 = 宿主没有 approval，ask 由 dsh-tools fail-closed 成拒绝）。 */
    approval?: boolean;
  } = {},
): Promise<Host> {
  const spillDir = mkdtempSync(path.join(tmpdir(), "zg-spill-"));
  const ctx = new CordisContext();
  const load = async (impl: unknown, config?: unknown): Promise<void> => {
    await (
      ctx as unknown as { plugin: (impl: unknown, config?: unknown) => Promise<unknown> }
    ).plugin(impl, config);
  };
  const settings = new StubSettings(ctx);
  // 装载期的任何一步失败都必须把已经付出的资源收回去（见下面 catch）：临时目录、已绑定的
  // 监听端口、已激活的官方服务 fiber。否则失败点会从「插件装不上」漂成下一条用例的端口冲突。
  let pluginFiber!: { dispose: () => Promise<unknown> };
  try {
    await load(SystemPrompt);
    await load(ToolRuntime);
    // alpha.2 起批次交给组合里显式提供的执行器；不装这一枚，`tools.execute` 直接以
    // TOOL_EXECUTOR_UNAVAILABLE 拒绝。用的是官方原生执行器，不在台架里复述它的实现。
    await load({ inject: nativeExecutorInject, apply: applyNativeExecutor });
    if (options.locale !== undefined) {
      // 官方 locale 偏好（host.ts 的 createLocaleMessages 跨命名空间读的那一行）。
      settings.rows.push({ ns: "locale", value: options.locale });
    }
    if (options.settings !== false) {
      ctx.provide("settings", settings);
    }
    // 官方 ApprovalService 的 `static inject = ["sessionProjections"]`：alpha.2 起它要把
    // 每次问/答写进会话日志，投影注册表不在位时整条 fiber 不激活，`ctx.get("approval")`
    // 读不到 ⇒ 管线的 ask 静默降级成拒绝。会话与投影都用官方件，不在台架里造替身。
    await load(SessionStore);
    await load(SessionProjectionRegistry);
    if (options.approval === true) {
      await load(ApprovalService, { policy: "never" });
    }
    await load(LocalJobRegistry);
    await load(LocalSubprocessRuntime);
    (ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir };
    await load(LocalBashExecutor, { timeoutMs: 20_000, graceMs: 300 });
    await load(TimerService);
    await load(WebServer, { host: "127.0.0.1", port: 0 });

    // 行 config：显式 config 覆盖台架选项推导出来的部署值，经真实 cordis 装载期
    // （schema 校验 + 填默认 + volatile 包引用）之后才递进 apply。
    // **顺序即语义**：台架推导值先落，显式 config 最后展开。反过来写会让调用方在 config
    // 里给的同名项被 options 静默覆盖——那正是注释承诺的反面。
    const rowConfig: Record<string, unknown> = {};
    if (options.indexTimeoutMs !== undefined) {
      rowConfig["indexTimeoutMs"] = options.indexTimeoutMs;
    }
    if (options.requireApprovalForExplicitRoot !== undefined) {
      rowConfig["requireApprovalForExplicitRoot"] = options.requireApprovalForExplicitRoot;
    }
    Object.assign(rowConfig, options.config);
    // 返回的是 Fiber 的 thenable 包装：await 等装载完成，同时拿到 dispose（卸载本插件）。
    const loader = ctx as unknown as {
      plugin: (
        impl: unknown,
        config?: unknown,
      ) => {
        then: PromiseLike<unknown>["then"];
        dispose: () => Promise<unknown>;
      };
    };
    pluginFiber = loader.plugin(plugin, rowConfig);
    // 返回的 thenable 包装：await 等装载完成（Promise.resolve 只为让「等待完成」这件事显式）。
    await Promise.resolve(pluginFiber);
  } catch (error) {
    // 装载失败不是「没有副作用」：临时目录已经建了，WebServer 可能已经绑上端口，先装好的
    // 官方服务 fiber 也已激活。全部收回再抛，否则真正的原因会被下一条用例的端口/残留作业盖掉。
    try {
      await (ctx as unknown as { fiber: { dispose: () => Promise<void> } }).fiber.dispose();
    } catch {
      // 装载半途失败时部分 fiber 可能根本没激活：dispose 再抛也不许盖住原始错误。
    }
    rmSync(spillDir, { recursive: true, force: true });
    throw error;
  }
  const { port } = ctx.webServer as unknown as { port: number };
  const fiber = pluginFiber;

  // shell 请求记录：monkey-patch 官方执行器的 resolve（转发给原实现），于是「本包递了什么
  // 命令/超时/stdout 上限给官方件」成为可观测事实，而不是又一次复述。
  const shellCalls: ShellCall[] = [];
  // 对官方件的每一处 monkey-patch 都登记撤回：unload/dispose 之后同一 ctx 上的官方件必须
  // 回到原实现。否则同进程内多次 startHost 会叠加补丁——同一次 shell 调用被历史补丁重复
  // 记录、审批被上一台台架的桩劫持，测试之间串味且症状看不出原因。
  const restorers: (() => void)[] = [];
  const restorePatches = (): void => {
    for (const restore of restorers.splice(0).toReversed()) {
      restore();
    }
  };
  const executor: { resolve: (request: ShellExecRequest) => ShellExecSpec } = ctx.shell;
  const ownResolve = executor.resolve;
  const originalResolve = ownResolve.bind(executor);
  executor.resolve = (request: ShellExecRequest): ShellExecSpec => {
    const spec = originalResolve(request);
    shellCalls.push({ request, spec });
    return spec;
  };
  restorers.push(() => {
    executor.resolve = ownResolve;
  });

  // 每次调用一个 controller：宿主真跑起来时 signal 是取消通道（卸载/tool 超时都会 abort）。
  // 只留**在飞**的那几个——调用一结束就从册上摘掉，否则已完成的 controller（连同 signal
  // 上的监听器）会一直累积，也分不出「仍在飞」与「早就跑完」。
  const callSignals = new Set<AbortController>();
  const call = async (name: string, args: unknown, agent?: BatchAgent): Promise<ToolOutcome> => {
    const controller = new AbortController();
    callSignals.add(controller);
    const { signal } = controller;
    try {
      // alpha.2 的 `tools.execute` 吃批次：单发也包成一条 `calls`，再把唯一那条结果拆回来。
      // `arguments` 是模型产出的原始 JSON 串，不是已解析对象。
      const batch = await ctx.tools.execute({
        calls: [
          {
            type: "tool-call",
            id: brandToolCallId(`call-${Math.random().toString(36).slice(2, 8)}`),
            name,
            arguments: JSON.stringify(args),
          },
        ],
        signal,
        ...(agent === undefined ? {} : { agent }),
      });
      const [only] = batch.results;
      if (only === undefined) {
        throw new Error(`tools.execute 对单发调用没有交回结果：${name}`);
      }
      return only.result;
    } finally {
      callSignals.delete(controller);
    }
  };
  const abortAll = (): void => {
    for (const controller of callSignals) {
      controller.abort();
    }
  };
  const patchApproval = (outcome: "allowed-once" | "rejected" | "unavailable"): unknown[] => {
    const asked: unknown[] = [];
    const service = (
      ctx as unknown as { approval?: { request: (request: unknown) => Promise<unknown> } }
    ).approval;
    if (service === undefined) {
      return asked;
    }
    const ownRequest = service.request;
    service.request = async (request: unknown) => {
      asked.push(request);
      return outcome;
    };
    restorers.push(() => {
      service.request = ownRequest;
    });
    return asked;
  };
  return {
    ctx,
    settings,
    shellCalls,
    port,
    spillDir,
    agentOf,
    call,
    textOf,
    patchApproval,
    unload: async () => {
      abortAll();
      restorePatches();
      await fiber.dispose();
    },
    dispose: async () => {
      abortAll();
      restorePatches();
      try {
        await (ctx as unknown as { fiber: { dispose: () => Promise<void> } }).fiber.dispose();
      } finally {
        // 临时目录必须在 finally 里清：dispose 抛错时它才是唯一会泄漏的那种资源
        // （spillDir 只有台架知道，宿主不会替你收）。
        rmSync(spillDir, { recursive: true, force: true });
      }
    },
  };
}

/** 一台真实宿主：服务实例、记录面与调用入口。 */
export interface Host {
  ctx: Context;
  settings: StubSettings;
  /** 本包递进官方 shell 执行器的请求/规格（按调用序）。 */
  shellCalls: ShellCall[];
  /** 真实 HTTP 监听端口（webServer 绑 127.0.0.1:0）。 */
  port: number;
  spillDir: string;
  agentOf: (cwd: string, id?: string) => BatchAgent;
  call: (name: string, args: unknown, agent?: BatchAgent) => Promise<ToolOutcome>;
  textOf: (outcome: ToolOutcome) => string;
  patchApproval: (outcome: "allowed-once" | "rejected" | "unavailable") => unknown[];
  /** 只卸载本插件（模拟宿主重载那一行）；在册的调用信号随之 abort，不等同于 dispose 整台宿主。 */
  unload: () => Promise<void>;
  dispose: () => Promise<void>;
}

/**
 * 测试用的本地 embedding（测试全套都用它）。
 *
 * 为什么不用设置卡里那个默认值（local/qwen3-embedding-0.6b，GGUF、百 MB 起）：并行跑全套用例时，
 * 多个 zg 子进程同时加载那个权重会把机器内存压空（实测会出现 zg 加载失败）。
 * potion-code-16m-v2 是几十 MB 的 model2vec，几个并发子进程也细尽。默认 embedding 本身另有一条
 * 不起进程的断言（只看命令行里的“--embedding <默认值>”），见 tools-real.test.ts。
 */
export const TEST_EMBEDDING = "local/potion-code-16m-v2";

/**
 * 本环境能不能造出「属主也读不了」的文件（mode 000）——「存在但读不了」那一档用例的前置。
 * 两种环境造不出，用到它的用例须跳过：root 绕过 DAC 权限（mode 000 对 root 仍可读，且真 zg 也
 * 读得了 ⇒ 本就不构成损坏）；windows 的 chmod 只翻只读位、并不挡属主读取。CI 的 ubuntu/macos
 * runner 非 root ⇒ 照跑。覆盖率不依赖这一档：host.ts 那句合并判据的 catch 由「不存在」跨平台钉住，
 * 可读性只是把同一条 catch 再走一遍，故 windows 那一格跳了它也不塌 100%。
 */
export function canMakeUnreadableFile(): boolean {
  if (process.platform === "win32") {
    return false;
  }
  return !(typeof process.getuid === "function" && process.getuid() === 0);
}

/**
 * 真 zg CLI 在不在 PATH 上。真宿主（integration）与端到端（e2e）两层要**真 spawn** zg（不是
 * 替身），而 CI 的干净 runner 没装它 ⇒ 那两层整体按这个谓词跳过（`describe.skipIf(!zgAvailable())`）；
 * 本机开发装了 zg 就照跑。只做「PATH 上找不找得到那个可执行名」这一档判定，不 spawn（省得为一次
 * 探测起进程），故用 existsSync 逐个 PATH 目录探；windows 上补 .cmd/.exe 两个后缀（那里 zg 多半也
 * 不是本仓 CI 的目标，但探得到就不误跳）。跳过后覆盖率不塌：本包判据由 mock 宿主那层
 * （test/host.test.ts）独立钉到 100%，这两层只负责钉「上游 zg 的事实」。
 */
export function zgAvailable(): boolean {
  const pathVar = process.env["PATH"] ?? "";
  const names = process.platform === "win32" ? ["zg.cmd", "zg.exe", "zg"] : ["zg"];
  return pathVar
    .split(path.delimiter)
    .some((dir) => dir.length > 0 && names.some((name) => existsSync(path.join(dir, name))));
}

/** 可控延迟：借道 Promise.withResolvers（运行时 Node≥22 可用，lib 类型面没有该静态成员）。 */
export async function sleep(ms: number): Promise<void> {
  const constructor = Promise as unknown as {
    withResolvers: () => { promise: Promise<void>; resolve: () => void };
  };
  const gate = constructor.withResolvers();
  setTimeout(gate.resolve, ms);
  return gate.promise;
}

/**
 * 按顺序跑一批步骤（返回每一步的结局）。
 *
 * 为什么不用循环 + Promise.all：门禁额度是**有序消费**的（三次 grep 并发去读
 * 额度表，结果随微任务排序抖动），并发会把「额度用尽后被拦」变成一句
 * 看不出结论的并发并账。
 */
export async function inOrder<TResult>(
  steps: readonly (() => Promise<TResult>)[],
): Promise<TResult[]> {
  // 迭代而不是「递归 + 数组展开」：后者每一步都复制一次累积数组（O(n²)），栈深还随步骤数
  // 线性增长；而语义就是「必须等上一步结束再起下一步」，循环是最直白的写法。
  const results: TResult[] = [];
  for (const step of steps) {
    // 顺序等待就是本函数的语义（额度按序消费，见上方注释），没有可并行的重复工作——
    // 规则在这里给的是错误的替代方案（Promise.all 会把结论变成并发并账）。
    // oxlint-disable-next-line eslint/no-await-in-loop -- 语义要求逐步等待：Promise.all 会把结论变成并发并账
    results.push(await step());
  }
  return results;
}

/**
 * 在真实 ToolRuntime 里登记几枚**空转工具**（bash / grep 之类），让 guard 管线有可执行的
 * 落脚点：guard 是在 `ctx.tools.execute()` 里被调起来的，没有已注册的名字就什么都测不到。
 * 入参面与输出面都按官方契约给全（parameters + output { schema, render } + execute）。
 */
export function registerDummyTools(host: Host, names: readonly string[]): void {
  const tools = host.ctx.tools as unknown as { register: (definition: unknown) => () => void };
  for (const name of names) {
    tools.register({
      name,
      description: `${name} (integration fixture)`,
      parameters: { type: "object", properties: { command: { type: "string" } } },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
        // 官方契约：render(args, value)——第一个参数是工具入参，第二个才是 execute 的返回值。
        render: (_args: unknown, value: unknown) => [
          { type: "text", text: (value as { text?: string }).text ?? String(value) },
        ],
      },
      execute: async () => ({ text: `${name} ran` }),
    });
  }
}

/**
 * 一枚**假 zg**（真进程、真 spawn、可真杀），用来把后台重建的生命周期钉成确定性事实：
 * 真 zg 的时长取决于模型加载与文件数，测不出「卸载时进程被收掉」与「超时杀进程」这两条。
 * 它按 zg 的命令面回应（`--version` / `index` / `status`），时长由 `ms` 调，pid 落地到
 * `pidFile` 供测试断言进程真的死了。
 */
/**
 * 把一段 node 脚本装成临时目录里的假 zg，并把该目录前置到 PATH；返回卸载函数。
 *
 * **PATH 必须用 path.delimiter 拼**：CI 矩阵含 windows-latest（.github/workflows/ci.yml 的
 * gate job），`:` 在 win32 上不是分隔符，拼出来的整条 PATH 是一条不存在的路径，假 zg 根本
 * 找不到。win32 也没有 shebang 执行面：同一份脚本另存成 .js，再放一枚 .cmd 垫片，让命令行
 * 按 PATHEXT 解析得到（zgAvailable() 的 win32 名单正是 zg.cmd/.exe/zg）。
 */
function installFakeBin(script: string): { cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "zg-fake-bin-"));
  writeFileSync(path.join(dir, "zg"), script, { mode: 0o755 });
  if (process.platform === "win32") {
    writeFileSync(path.join(dir, "zg.js"), script, { mode: 0o755 });
    writeFileSync(path.join(dir, "zg.cmd"), `@echo off\r\nnode "%~dp0zg.js" %*\r\n`);
  }
  const previous = process.env["PATH"];
  process.env["PATH"] = previous === undefined ? dir : `${dir}${path.delimiter}${previous}`;
  return {
    cleanup: () => {
      if (previous === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = previous;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function installFakeZg(options: { ms?: number; pidFile: string }): () => void {
  const script = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("0.2.2\\n");
  process.exit(0);
}
writeFileSync(${JSON.stringify(options.pidFile)}, String(process.pid));
const ms = Number(process.env.ZG_FAKE_MS ?? ${String(options.ms ?? 400)});
const step = Math.max(20, Math.floor(ms / 4));
const started = Date.now();
if (argv[0] === "index") {
  process.stderr.write("Scanning files...\\n");
  process.stderr.write("Preparing local/potion-code-16m-v2\\n");
  const pump = setInterval(() => {
    if (Date.now() - started >= ms) {
      clearInterval(pump);
      process.stdout.write("files\\t2 scanned, 2 added\\n");
      process.stderr.write("Indexing complete\\n");
      process.exit(0);
    }
  }, step);
} else {
  process.stdout.write("? Workspace index is not configured\\n");
  process.exit(0);
}
`;
  const bin = installFakeBin(script);
  // 记旧值而不是无条件 delete：嵌套两层假 zg 时，内层卸载不能把外层设定的时长抹掉。
  const previousMs = process.env["ZG_FAKE_MS"];
  process.env["ZG_FAKE_MS"] = String(options.ms ?? 400);
  return () => {
    if (previousMs === undefined) {
      delete process.env["ZG_FAKE_MS"];
    } else {
      process.env["ZG_FAKE_MS"] = previousMs;
    }
    bin.cleanup();
  };
}

/**
 * 一枚只把子进程环境倒到文件的**假 zg**：验证本包经环境变量下发的那三项（HF 镜像 / 远程
 * 端点 / 凭据）真的到得了 zg 子进程。特别是凭据：官方 subprocess 层会把名字命中
 * /KEY|PASSWORD|SECRET|TOKEN/i 的继承变量刷掉（scrubbedParentEnv），所以密钥必须由插件
 * **显式转发**才到得了子进程。这一条只能在真执行器上验。
 */
export function installEnvDumpZg(dumpFile: string): () => void {
  const script = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify({
  HF_ENDPOINT: process.env.HF_ENDPOINT ?? null,
  ZVEC_GREP_ENDPOINT: process.env.ZVEC_GREP_ENDPOINT ?? null,
  ZVEC_GREP_API_KEY: process.env.ZVEC_GREP_API_KEY ?? null,
  SECRET_NAME: process.env.ZG_TEST_EMBED_KEY ?? null,
  TERM: process.env.TERM ?? null,
}));
process.stdout.write("0.2.2\\n");
`;
  return installFakeBin(script).cleanup;
}
