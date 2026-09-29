// host.ts 集成测试：注册面（0.1.7 隐式设置投影 + 页面策略 / 3 工具 / 规则段 / guard /
// webServer 端点）
// 与工具执行路径（经 mock shell 断言命令构造、文本透传、错误映射、沙箱事实、
// stderr 降级提示），重建端点的两道锁（同源 + CSRF + 工作区白名单 + 目录存在），
// 以及 search-first 门禁（真实 fs 临时索引目录 + 会话状态解锁）。
//
// 同步 fs（mkdtemp/mkdir/rm/exists）为门禁测试在真实临时目录建/清索引所必需
// （root 现在要过 existsSync 预检，桩路径 /ws 会被判「目录不存在」），
// 对应同步方法名已列入 oxlint.config.ts 的 node/no-sync ignores。可控延迟用
// Promise.withResolvers（运行时 Node≥22 可用；lib=ES2024 无该静态成员故类型借道 cast）。
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
// 命名导入：缓存工厂是导出面（单测直接钉命中/TTL/LRU 行为，不必经 fs 间接观测）。
import plugin, {
  createIndexProbeCache,
  INDEX_PROBE_CACHE_MAX,
  INDEX_PROBE_TTL_MS,
} from "../host.ts";
import { DEFAULT_EMBEDDING } from "../lib/embedding-catalog.ts";
import { MESSAGES, fill } from "../lib/messages.ts";
import { SECRET_EXCLUDE_GLOBS } from "../lib/argv-guard.ts";

// 默认密钥排除的命令行形态（由 lib/argv-guard.ts 单一来源派生，避免两处硬编码漂移）。
const SECRET_ARGS = SECRET_EXCLUDE_GLOBS.map((globStr) => `--glob '${globStr}'`).join(" ");

const REBUILD_PATH = "/_dsh/zvec-grep/rebuild";
const REBUILD_STATUS_PATH = "/_dsh/zvec-grep/rebuild-status";
const REBUILD_ROOTS_PATH = "/_dsh/zvec-grep/rebuild-roots";
const CSRF_HEADER = "x-zvec-grep-csrf";
/** host.ts 的 REBUILD_JOB_KIND（未导出，同值抄一份：改了名下面所有 id 字面量一起失效）。 */
const JOB_KIND = "zvec-grep-rebuild";
/**
 * 默认 HF 端点 = ModelScope 镜像（本环境 huggingface.co 不可达，是 load-bearing 的默认值）。
 * host.ts 的 schema 默认值（那条 `.default(...)`）在这里**独立**抄一份：prod 换端点，
 * 引用常量会跟着一起漂移成自证，抄一份才让下面每条断言先红。
 */
const MODELSCOPE_MIRROR = "https://modelscope.cn/models";
/** Sec-Fetch-Site 的跨站取值：CSRF / DNS 重绑定用例里「外站来的」那一条腿。 */
const SEC_FETCH_CROSS_SITE = "cross-site";
/** 沙箱模式：工作区可写（denied / runnerFailed 两类降级事实都挂在这一档上）。 */
const SANDBOX_WORKSPACE_WRITE = "workspace-write";
/** zg 未安装时 shell 的报错原文：那是**数据**，本包只透传/归类，不改写也不翻译它。 */
const ZG_NOT_INSTALLED = "zg: command not found";
/**
 * zg 索引库目录名（<root>/.zvec-grep/）。门禁用例要在真实临时目录里**造出**这个目录，
 * 故同值在本文件独立抄一份而不是引 lib/routing.ts 的 INDEX_DIR_NAME：prod 改名之后，
 * 引常量等于「造出来的目录名跟着一起改」→ 门禁照样命中，测试就永远不会红。
 */
const ZG_INDEX_DIR = ".zvec-grep";
/**
 * 官方输出环的**字节**留存上限（宿主默认值，离线台架实测见 plugins/docs/harness/f3-equiv/probe-jobs.mjs）。
 * 换装前这里是本包自己的 `JOB_OUT_MAX_BYTES`（名义字节、实按 UTF-16 码元）；换装后
 * 裁剪归注册表，本包只在 4000 字符的尾窗那一步按码元计数，两套单位不再混用。
 */
/** 注册表配置里本文件要用到的四件默认值。 */
interface RegistryDefaults {
  maxConcurrentJobsPerOwner: number;
  retainBytes: number;
  settledRetainBytes: number;
  pumpPollMs: number;
}

/**
 * 宿主装载期怎么解析 `LocalJobRegistry.Config`，这里就怎么取默认值：走官方件的
 * `~standard.validate`（实测 `validate({})` ⇒ `{10, 262144, 16384, 150}`，给部分覆盖会
 * 与默认合并）。为什么不在测试里手抄这些数：本文件钉的是**官方件的行为**，抄来的默认值
 * 只给我的理解作证——宿主哪天改容量或留存窗，测试仍绿而真宿主行为已经变了。
 * 这也是本仓那条门律（"不靠抄来的字面量成立"）在本包的落地。
 */
function registryDefaults(row: Partial<RegistryDefaults> = {}): RegistryDefaults {
  const parsed = (
    LocalJobRegistry.Config as unknown as {
      "~standard": {
        validate: (value: unknown) => { issues?: unknown; value: RegistryDefaults };
      };
    }
  )["~standard"].validate(row);
  assert.equal(parsed.issues, undefined, "官方默认值面应能被官方 schema 解析");
  return parsed.value;
}

const HOST_DEFAULTS = registryDefaults();
const RING_RETAIN_BYTES = HOST_DEFAULTS.retainBytes;
const VIEW_CHARS = 4000;
/** host.ts 的 REBUILD_HISTORY_MAX：已结束记录的历史窗口（本包政策，不是宿主默认）。 */
const HISTORY_MAX = 10;
/** 注册表容量（宿主默认，按 owner 计；本包作业一律未拥有 ⇒ 共用这一桶）。 */
const LIVE_CAP = HOST_DEFAULTS.maxConcurrentJobsPerOwner;
/**
 * 泵拍间隔：测试里压到 25ms（宿主默认 150ms，实测）。压小不是取巧——它让**每一条**输出
 * 用例都真的走一遍注册表的周期泵，而不是只看落定前那最后一次排水。复核抓到的
 * 变异（把偏移读错一位、或每拍重灌全文）正是只有周期拍才咬得住的那种。
 */
const PUMP_MS = 25;
/** host.ts 的 `STDERR_NOTE_CHARS`（未导出，这里同值抄一份）：上限哪天改动，下面那条
 *  注脚用例的 `assertBareCutBites` 会先红，不会静默假绿。 */
const STDERR_NOTE_CHARS = 400;

// ── 代理对夹具（C4：入会话日志的截断）───────────────────────────────────────
// 缺陷定义与 ocr-review 同源：宿主把工具结果持久化进会话日志，一枚孤立高/低代理会让
// 该会话之后的每次 Messages 请求整体失败。本包的输入是**仓库文件内容**（全系统 CJK 密度
// 最高的那道流），所以这不是理论路径。
//
// FAMILY = 👨‍👩‍👧‍👦，11 枚码元（4 枚代理对 + 3 枚裸 ZWJ）：周期不是 2 的幂，
// 于是"固定预算切在第几枚"是可算的，不必靠运气落在合法边界上。
const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
/** 用例的牙齿：先证明**裸切在这一处确实咬住了代理对**，否则整条用例断的是空气
 *  （本分支已被这种假绿夹具骗过一次，shared/test/text.test.ts 与 ocr-review 的代理
 *  用例都带同款自守）。`cut` 必须是与被测实现同一刀法的裸 slice 结果。 */
function assertBareCutBites(cut: string): void {
  assert.equal(
    cut.isWellFormed(),
    false,
    "裸 slice 没切开代理对 ⇒ 切点落在合法边界上，本用例对 no-op 实现也会绿",
  );
}

// ── 宿主替身 ──────────────────────────────────────────────────────────────

interface MockExec {
  signal?: AbortSignal;
  agent?: { session?: { id?: unknown; header?: { cwd?: unknown } } } | null;
}

interface GuardExec extends MockExec {
  name?: unknown;
  arguments?: unknown;
}

interface CapturedTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: unknown, exec?: MockExec) => Promise<unknown>;
}

/** 请求替身：guardBody 会 `for await` 读体，故必须可异步迭代。 */
interface MockReq {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  streamError?: boolean;
  [Symbol.asyncIterator]: () => AsyncIterator<string | Buffer>;
}

interface MockRes {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  setHeader: (key: string, value: string) => void;
  writeHead: (code: number, headers?: Record<string, string>) => void;
  end: (body: string) => void;
}

interface CapturedRoute {
  path: string;
  handler: (req: MockReq, res: MockRes) => void | Promise<void>;
}

interface StdoutShape {
  text: string;
  truncated?: boolean;
  spillPath?: string;
}

interface ShellRunResult {
  exitCode: number | null;
  timedOut?: boolean;
  aborted?: boolean;
  stdout: StdoutShape;
  stderr: { text: string; truncated?: boolean };
  sandbox?: {
    mode: "read-only" | "workspace-write" | "danger-full-access";
    denied: boolean;
    enforcement?: "full" | "partial";
    runnerFailed?: boolean;
  };
}

/** 官方 SubprocessOutputReader 的本用例形状（observed 那条非消费面）。 */
interface MockReader {
  readFrom: (fromByte: number) => {
    text: string;
    nextOffset: number;
    lossy: boolean;
    spillPath?: string;
  };
}

interface MockProc {
  status: "running" | "completed" | "killed";
  exitCode: number | null;
  /** 0.1.7 ShellProcess 的信号名（自然退出为 null）：官方作业的 detail 用它。 */
  signal: string | null;
  done: Promise<void>;
  resolveDone: () => void;
  /** 追加一段执行器已捕获的输出。observed 的读者按 **UTF-8 字节**偏移切，与官方件一致。 */
  emit: (channel: "stdout" | "stderr", text: string) => void;
  /**
   * 让某一通的读者出故障（复刻执行器侧的两种边角）：
   *  - `lossy`：请求的偏移已滑出在内存尾部 ⇒ 官方契约是交回留存尾并打 lossy；
   *  - `throw`：读者直接抛（进程已被回收一类）。官方泵对此**此后不再排这一路**（实测），
   *    所以本包的源必须自己兜住。
   */
  failRead: (channel: "stdout" | "stderr", mode: "lossy" | "throw") => void;
  /** 0.1.7 的非消费观察者面：本包的 pull source 从这里读，与 readOutput 互不偷字节。 */
  observed: { stdout: MockReader; stderr: MockReader };
  kill: () => boolean;
  killCount: number;
  sandbox?: {
    mode: "read-only" | "workspace-write" | "danger-full-access";
    denied: boolean;
    enforcement?: "full" | "partial";
    runnerFailed?: boolean;
  };
  /** 0.1.7 ShellExecution 的前台投影：后台 job 从不 await 它。 */
  result: () => Promise<ShellRunResult>;
}

/** resolve 请求的本用例视角镜像（含 0.1.7 的 deadline 策略字段与 stdout 上限）。 */
interface ResolveRequest {
  command: string;
  workdir?: string;
  timeoutMs?: number;
  stdoutMaxBytes?: number;
  onExpiry?: string;
  env?: Record<string, string>;
}

interface ShellMock {
  resolveCalls: ResolveRequest[];
  runResults: ShellRunResult[];
  startCalls: ResolveRequest[];
  startedProcs: MockProc[];
  startThrows: "none" | "error" | "alien";
  /**
   * N>0 ⇒ 从第 N 次后台 spawn 之后本包再也拿不到注册表（复刻"handler 在 await 里让出一拍，
   * 那期间 jobs 那一行被换掉"）。判据放在 `get` 里、按 `startCalls` 的条数算，不引新状态。
   */
  vanishJobsAfterExecute: number;
  resolve: (spec: ResolveRequest) => unknown;
  /** 0.1.7 唯一的执行入口（取代 run/start）：前台取 handle.result()，后台留 handle。 */
  execute: (spec: unknown) => Promise<MockProc>;
}

interface MockCtx {
  /** volatile 引用背后的活值：测试改它 = 设置卡改值（宿主写进同一枚引用，读侧立刻生效）。
   *  初值即导出 Config 的逐字段 `.default()`（复刻 cordis 装载期填默认的那一步）。 */
  settingsValue: Record<string, unknown>;
  /**
   * describe() 里 `ns === 'locale'` 那一行的 value（官方 dsh-client-locale 拥有的命名空间文档）。
   * 缺省 = 该行不存在（没装官方 locale 插件 / 条目没被投影）→ 宿主按中文默认出文案。
   */
  localeDocument?: Record<string, unknown>;
  /** settings.configure 的调用记录（页面策略 + owner fiber）。 */
  configureCalls: { presentation: { auto?: boolean }; owner: unknown }[];
  /** 本插件 fiber 的替身：configure 的 owner 必须原样带回它（断言用）。 */
  fiber: { id: string };
  toolsRegistered: CapturedTool[];
  guardFns: ((exec: GuardExec) => string | undefined)[];
  sections: { name: string; order: number; text: string }[];
  routes: CapturedRoute[];
  unregistered: string[];
  effectDisposers: (() => void)[];
  noWebServer: boolean;
  /** webServer 替身的 `host` 成员（官方唯一可读的非回环信号，installed dsh-host-webserver
   *  d.ts `:50`）。缺省 undefined = 没声明绑到哪张网卡 ⇒ `servingNonLoopback` 恒 false；
   *  不设这一位的话，那道锁在真实接线上从没被拨开过。 */
  webServerHost?: string;
  /** true ⇒ ctx.get("jobs") 交不出注册表（宿主没装 dsh-jobs-local 的那一档）。 */
  noJobs: boolean;
  /** 官方注册表的实现本身（见 makeJobRegistry）；重建作业的真身都在它里面。 */
  jobs: LocalJobRegistry;
  shell: ShellMock;
  settings: {
    /** 页面策略登记：宿主用它决定要不要自动生成表单页（0.1.7 起本包唯一的 settings 写侧动作）。 */
    configure: (presentation: { auto?: boolean }, owner?: unknown) => () => void;
    /** 跨命名空间读的官方入口：本包只用它取 locale.preference（文案语言）。 */
    describe: () => { ns: string; value: unknown }[];
  };
  tools: {
    register: (def: CapturedTool) => void;
    guard: (fn: (exec: GuardExec) => string | undefined) => void;
  };
  systemPrompt: { section: (sec: { name: string; order: number; text: string }) => void };
  timerCalls: { fn: () => void; ms: number }[];
  timer: { timeout: (fn: () => void, ms: number) => () => void };
  get: (name: string) => unknown;
  effect: (factory: () => (() => void) | undefined) => void;
  /** ctx.inject(deps, fn)：cordis 立即用带齐依赖的子上下文回调一次（这里就是 ctx 自己）。 */
  inject: (deps: readonly string[], attach: (child: unknown) => void) => void;
}

/** 可控延迟：借道 Promise.withResolvers（运行时 Node≥22 可用）。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  const constructor = Promise as unknown as {
    withResolvers: () => { promise: Promise<void>; resolve: () => void };
  };
  return constructor.withResolvers();
}

/**
 * 官方注册表的**实现本身**，不是假件。
 *
 * 为什么不用假件：本包这次换装删掉的是自己实现过的环/容量/淘汰，替身若按"我以为的官方
 * 语义"写，测试就是在给我的理解作证——换装类改动最典型的假绿。直接起官方件，卡片契约
 * （status 词表、shown/total、已截断/缓冲区溢出两条打标）就被钉在真行为上；官方改了语义，
 * 这里先红。逐条实测语义见 plugins/docs/harness/f3-equiv/probe-jobs.mjs。
 *
 * 默认值全部经官方 schema 现解（只把泵拍压小，理由见 PUMP_MS），构造器吃已解析 config。
 */
function makeJobRegistry(): LocalJobRegistry {
  return new LocalJobRegistry(new Context(), registryDefaults({ pumpPollMs: PUMP_MS }));
}

/**
 * 等过一拍注册表的周期泵。pull source 的增量是由泵搬进环的（实测：start 里同步跑第一拍，
 * 之后每 pumpPollMs 一拍），所以"起了进程 + 进程产出了输出"与"卡片读得到输出"之间隔着
 * 至少一拍——不等这一拍就等于在测最后一次排水，那正是复核点出的盲区。
 */
async function pumpTick(): Promise<void> {
  const gate = deferred();
  setTimeout(gate.resolve, PUMP_MS * 3);
  return gate.promise;
}

/**
 * 官方落定排在 `proc.done` 的微任务链上（producer done → 收尾排水 → settle），而本文件
 * 的 handler 是**同步**调用的：不给事件循环一次机会，投影读到的还是"在跑"。
 * setImmediate 是一次宏任务 ⇒ 之前的所有微任务（含注册表落定）都已跑完。
 */
async function settledTick(): Promise<void> {
  const gate = deferred();
  setImmediate(gate.resolve);
  return gate.promise;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    body: "",
    headers: {},
    setHeader(key, value) {
      res.headers[key] = value;
    },
    writeHead(code, headers) {
      res.statusCode = code;
      if (headers) {
        Object.assign(res.headers, headers);
      }
    },
    end(body) {
      res.body = body;
    },
  };
  return res;
}

function makeReq(init: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  chunks?: (string | Buffer)[];
  streamError?: boolean;
}): MockReq {
  const chunks = init.chunks ?? [];
  return {
    ...(init.method === undefined ? {} : { method: init.method }),
    ...(init.url === undefined ? {} : { url: init.url }),
    headers: init.headers ?? {},
    ...(init.streamError === undefined ? {} : { streamError: init.streamError }),
    [Symbol.asyncIterator]() {
      let cursor = 0;
      return {
        async next(): Promise<IteratorResult<string | Buffer>> {
          if (init.streamError === true) {
            throw new Error("stream broke");
          }
          const chunk = chunks[cursor];
          cursor += 1;
          return chunk === undefined
            ? { done: true, value: undefined }
            : { done: false, value: chunk };
        },
      };
    },
  };
}

/** 占位方法：只需要「存在且是函数」，不需要行为。 */
function noop(): void {
  void 0;
}

// ── 导出 Config schema 的内省工具（0.1.7 隐式注册的三条判据都从这里来）────────
//
// 为什么不手抄字段名：命名空间与可编辑字段在 0.1.7 都是宿主**从 schema 反推**的，
// 测试再手抄一份就成了第三份真相——漂移的是测试，不是代码。

/** Config schema 的字段节点（读 meta/type/dict 用，不复制 schema 结构）。 */
interface SchemaNode {
  type?: string;
  meta?: Record<string, unknown>;
  dict?: Record<string, SchemaNode>;
}

/** 导出 Config schema 的 dict（单源：字段名与元数据都从宿主实际读的那份来）。 */
function configDict(): Record<string, SchemaNode> {
  return (plugin.Config as unknown as SchemaNode).dict ?? {};
}

/** 导出 Config schema 的字段名清单（单源：不手写，漏字段就是测试的事）。 */
const CONFIG_KEYS: string[] = Object.keys(configDict());

/** 逐字段 schema 默认 —— 等价于 0.1.6 交给 `settings.register(ns, schema, { base })`
 *  的那份底座，0.1.7 把它搬到了 schema 的 `.default()` 上（少一层「底座」）。 */
function schemaDefaults(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(configDict()).map(([key, field]) => [key, field.meta?.["default"]]),
  );
}

/**
 * 复刻宿主 packages/settings/settings/src/schema.ts 的 volatileForm()：
 * 「自身标了 volatile」或「是 object 且子树里有可编辑字段」的字段才进表单。
 * @returns 顶层 object 时给表单字段名清单；叶子可编辑时给 []；
 *  null = 该子树没有任何可编辑字段 → 宿主 describe() 会整条跳过本条目
 *  （settings/src/index.ts:308-309），写入则抛 `has no volatile fields`（:386）。
 *  （用 null 而不是 undefined 表"没有"：本仓 lint 的 consistent-return 配了
 *  `treatUndefinedAsUnspecified`，`return undefined` 记作无值返回、与 `return []` 冲突。）
 */
function volatileFormOf(node: SchemaNode): string[] | null {
  if (node.meta?.["volatile"] === true) {
    return [];
  }
  if (node.type !== "object") {
    return null;
  }
  const kept = Object.entries(node.dict ?? {}).flatMap(([key, child]) =>
    volatileFormOf(child) === null ? [] : [key],
  );
  return kept.length === 0 ? null : kept;
}

/** cordis.patch.yml 里的裸条目 id —— 0.1.7 的 settings 命名空间就是它。
 *  读文件而不是抄常量：卡片 namespace / 端点 / 命名空间三处都按它对齐，
 *  写死会让测试与包体漂移。 */
function patchEntryId(): string {
  const yml = readFileSync(fileURLToPath(new URL("../cordis.patch.yml", import.meta.url)), "utf8");
  const match = /^\s*-\s+id:\s*(?<id>\S+)\s*$/mu.exec(yml);
  const id = match?.groups?.["id"];
  assert.ok(typeof id === "string" && id.length > 0, "cordis.patch.yml 里没有裸 `- id:` 条目");
  return id;
}

/**
 * isZvecGrepHost 的失败样本：非对象、空对象、有壳无方法、缺一个面——
 * 守卫必须逐一识破，apply 才可能在错注入时硬报错而不是运行到一半崩。
 */
function incompleteHosts(): unknown[] {
  const full = {
    settings: { describe: noop, configure: noop },
    shell: { resolve: noop, execute: noop },
    tools: { register: noop, guard: noop },
    systemPrompt: { section: noop },
    timer: { timeout: noop },
    get: noop,
  };
  return [
    null,
    5,
    "host",
    {},
    { ...full, get: 0 },
    { ...full, timer: {} },
    { ...full, shell: { ...full.shell, execute: undefined } },
    { ...full, tools: { ...full.tools, guard: 0 } },
    { ...full, systemPrompt: { ...full.systemPrompt, section: null } },
    { ...full, settings: [] },
    // describe 是 0.1.7 跨命名空间取 locale 偏好的唯一入口：缺了它文案语言无从可查，
    // 守卫必须在 apply 当场识破，而不是让第一次工具调用去撞 undefined。
    { ...full, settings: { configure: noop } },
  ];
}

function makeCtx(): MockCtx {
  const shell: ShellMock = {
    resolveCalls: [],
    runResults: [],
    startCalls: [],
    startedProcs: [],
    startThrows: "none",
    vanishJobsAfterExecute: 0,
    resolve(spec) {
      shell.resolveCalls.push(spec);
      return spec;
    },
    // 0.1.7：execute 是前后台唯一入口。判据沿用宿主自身的分工——runForeground 必带
    // timeoutMs（deadline），后台 rebuild 不带（shell 契约：后台不应用超时）。
    async execute(spec) {
      const isBackground = (spec as { timeoutMs?: number }).timeoutMs === undefined;
      if (isBackground) {
        if (shell.startThrows === "error") {
          throw new Error("no such executor");
        }
        if (shell.startThrows === "alien") {
          // 跨 realm 抛出的 Error：本域 `instanceof Error` 为 false，走 String() 兜底
          vm.runInNewContext("throw new Error('boom from another realm')");
        }
        shell.startCalls.push(spec as ResolveRequest);
      }
      const dfr = deferred();
      // 两条流各自的"已捕获全文"与故障开关：形状对齐官方 SubprocessOutputReader，
      // 于是本包那条 read(fromByte) 的偏移算得对不对，是真的能被测出来的。
      const captured: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
      const faults: Record<"stdout" | "stderr", { lossy: boolean; throws: boolean }> = {
        stdout: { lossy: false, throws: false },
        stderr: { lossy: false, throws: false },
      };
      const reader = (channel: "stdout" | "stderr"): MockReader => ({
        readFrom: (fromByte) => {
          if (faults[channel].throws) {
            throw new Error("already reaped");
          }
          const bytes = Buffer.from(captured[channel], "utf8");
          return {
            text: bytes.subarray(Math.min(fromByte, bytes.length)).toString("utf8"),
            nextOffset: bytes.length,
            lossy: faults[channel].lossy,
          };
        },
      });
      const proc: MockProc = {
        status: "running",
        exitCode: null,
        signal: null,
        done: dfr.promise,
        resolveDone: dfr.resolve,
        emit: (channel, text) => {
          captured[channel] += text;
        },
        failRead: (channel, mode) => {
          if (mode === "lossy") {
            faults[channel].lossy = true;
            return;
          }
          faults[channel].throws = true;
        },
        observed: { stdout: reader("stdout"), stderr: reader("stderr") },
        kill: () => {
          proc.killCount += 1;
          return true;
        },
        killCount: 0,
        // 前台投影：队列按序消费（保持旧 run() 「发起时 shift」的取值次序）。
        result: async () =>
          shell.runResults.shift() ?? {
            exitCode: 0,
            stdout: { text: "OK" },
            stderr: { text: "" },
          },
      };
      if (isBackground) {
        shell.startedProcs.push(proc);
      }
      return proc;
    },
  };
  const ctx: MockCtx = {
    // 复刻 cordis 装载期的结果：volatile 字段的活值 = Config schema 的逐字段默认。
    // 用例要改设置就改这张表（引用现读，等价于用户在设置卡上写了一次）。
    settingsValue: schemaDefaults(),
    configureCalls: [],
    fiber: { id: "zvec-grep-fiber" },
    toolsRegistered: [],
    guardFns: [],
    sections: [],
    routes: [],
    unregistered: [],
    effectDisposers: [],
    noWebServer: false,
    noJobs: false,
    jobs: makeJobRegistry(),
    shell,
    settings: {
      configure: (presentation: { auto?: boolean }, owner?: unknown) => {
        ctx.configureCalls.push({ presentation, owner });
        return (): void => {
          void 0;
        };
      },
      // 0.1.7 唯一的跨命名空间读：只投影本包用到的 ns/value 两列。
      // localeDocument 缺省 = 该行不存在（没装 client-locale）→ 中文默认。
      describe: () =>
        ctx.localeDocument === undefined ? [] : [{ ns: "locale", value: ctx.localeDocument }],
    },
    tools: {
      register(def) {
        ctx.toolsRegistered.push(def);
      },
      guard(fn) {
        ctx.guardFns.push(fn);
      },
    },
    systemPrompt: {
      section(sec) {
        ctx.sections.push(sec);
      },
    },
    timerCalls: [],
    timer: {
      timeout(fn: () => void, ms: number) {
        ctx.timerCalls.push({ fn, ms });
        return () => {
          void 0;
        };
      },
    },
    get(name: string): unknown {
      const webServer = {
        register: (route: CapturedRoute) => {
          ctx.routes.push(route);
          return () => {
            ctx.unregistered.push(route.path);
          };
        },
        // 官方那一位是 getter（`get host(): string | undefined`），替身给同形的普通成员。
        host: ctx.webServerHost,
      };
      if (name === "jobs") {
        // 官方注册表的实现本身（不是假件，理由见 makeJobRegistry）；noJobs 那一条
        // 复刻"宿主没装 dsh-jobs-local"的档，此时重建端点必须回答不可用而不是抛穿。
        // vanished = 第 N 次后台 spawn 之后服务被换掉那一档（判据按 startCalls 计数）。
        const vanished =
          shell.vanishJobsAfterExecute > 0 &&
          shell.startCalls.length >= shell.vanishJobsAfterExecute;
        return ctx.noJobs || vanished ? undefined : ctx.jobs;
      }
      return ctx.noWebServer || name !== "webServer" ? undefined : webServer;
    },
    effect(factory) {
      const dispose = factory();
      if (dispose !== undefined) {
        ctx.effectDisposers.push(dispose);
      }
    },
    // ctx.inject(deps, fn)：cordis 立即用带齐依赖的子上下文回调一次。本包用到的
    // settings + effect 两个面在真实宿主上同为 ctx 的成员，故直接把 ctx 交给回调。
    inject: (_deps: readonly string[], attach: (child: unknown) => void) => {
      attach(ctx);
    },
  };
  return ctx;
}

/**
 * 复刻 cordis 交进 apply 的那份 Config：每个 volatile 字段一枚**稳定引用**，
 * 其 get() 现读 ctx.settingsValue —— 与真实 Volatile 的「引用不变、值可变」同构
 * （cosmokit createVolatile 也只有一个 get()）。volatile 与否**从导出 schema 现读**
 * （字段 meta.volatile）：volatile 字段交引用（值缺 = 条目未投影的退化档）；非 volatile
 * 部署值（超时三项 + stdout 上限）按装载期行为交普通值，缺键也填 schema 默认
 * （cordis 按 schema 校验时 `.default()` 无条件兜底，不存在「空引用」形态）。字段名取自
 * 导出的 Config，故 schema 加/删字段时这里自动跟上，不会测一份代码一份。
 */
function liveConfigRefs(ctx: MockCtx): Record<string, unknown> {
  return Object.fromEntries(
    CONFIG_KEYS.map((key) => {
      const field = configDict()[key];
      if (field?.meta?.["volatile"] === true) {
        return [key, { get: (): unknown => ctx.settingsValue[key] }];
      }
      // 普通值形态：settingsValue 缺键（如「设置全缺」用例）时按装载期语义填 schema 默认。
      const plain = ctx.settingsValue[key] ?? field?.meta?.["default"];
      return [key, plain];
    }),
  );
}

// ── 真实临时工作区（root 存在性预检）──────────────────────────────────────

const createdDirs: string[] = [];

/** 一个真实存在的目录（zg 要求 root 落盘存在）。 */
function ws(name = "root"): string {
  const created = mkdtempSync(path.join(tmpdir(), `zvec-${name}-`));
  createdDirs.push(created);
  return created;
}

/** 名字里带空格的真实目录：验证 query 里 `+` 解码为空格。 */
function wsWithSpace(): string {
  const inner = path.join(ws("space"), "my ws");
  mkdirSync(inner, { recursive: true });
  return inner;
}

/**
 * 走真实 apply。第二参是**行 config**（组合包层/用户层行的 `config:`）：0.1.7 由
 * cordis 在装载期把它合进 schema 默认（显式 undefined 的字段不覆盖，等价于旧的
 * compact()），再交 volatile 引用——这里复刻的就是那一步合并。
 */
function applyTo(ctx: MockCtx, rowConfig?: Record<string, unknown>): void {
  const host = plugin as unknown as { apply: (hostArg: unknown, cfg: unknown) => void };
  if (rowConfig !== undefined) {
    const kept = Object.fromEntries(
      Object.entries(rowConfig).filter(([, value]) => value !== undefined),
    );
    Object.assign(ctx.settingsValue, kept);
  }
  host.apply(ctx, liveConfigRefs(ctx));
}

function toolOf(ctx: MockCtx, name: string): CapturedTool {
  const tool = ctx.toolsRegistered.find((entry) => entry.name === name);
  assert.ok(tool, `expected tool ${name}`);
  return tool;
}

function routeOf(ctx: MockCtx, url: string): CapturedRoute {
  const route = ctx.routes.find((entry) => entry.path === url);
  assert.ok(route, `expected route ${url}`);
  return route;
}

function guardOf(ctx: MockCtx): (exec: GuardExec) => string | undefined {
  const [guard] = ctx.guardFns;
  assert.ok(guard, "expected one guard");
  return guard;
}

/** 官方 ToolExecution 最小替身：signal 契约必填。 */
function execOf(cwd?: string, id: string | number = "sess-1"): MockExec {
  const { signal } = new AbortController();
  return cwd === undefined ? { signal } : { signal, agent: { session: { id, header: { cwd } } } };
}

/** 无参守卫执行（只用来登记会话工作区，不触发任何拦截分支）。 */
function trackRoot(ctx: MockCtx, cwd: string, id = "sess-1"): void {
  guardOf(ctx)({ name: "read", arguments: {}, agent: { session: { id, header: { cwd } } } });
}

/** 引导端点 → { csrf, roots }。 */
function fetchAccess(ctx: MockCtx): { csrf: string; roots: string[] } {
  const res = makeRes();
  const rootsRoute = routeOf(ctx, REBUILD_ROOTS_PATH);
  // 引导端点是同步 handler
  void rootsRoute.handler(makeReq({ method: "GET", url: REBUILD_ROOTS_PATH }), res);
  const body = JSON.parse(res.body) as { ok: boolean; csrf: string; roots: string[] };
  assert.equal(body.ok, true);
  return { csrf: body.csrf, roots: body.roots };
}

/** 发起一次重建（默认带同源 + CSRF 两道锁）。 */
async function postRebuild(
  ctx: MockCtx,
  root: string | null,
  opts?: { csrfToken?: string; extraHeaders?: Record<string, string>; streamError?: boolean },
): Promise<MockRes> {
  const token = opts?.csrfToken ?? fetchAccess(ctx).csrf;
  const query = root === null ? "" : new URLSearchParams({ root }).toString();
  const res = makeRes();
  await routeOf(ctx, REBUILD_PATH).handler(
    makeReq({
      method: "POST",
      url: `${REBUILD_PATH}?${query}`,
      headers: { [CSRF_HEADER]: token, ...opts?.extraHeaders },
      ...(opts?.streamError === undefined ? {} : { streamError: opts.streamError }),
    }),
    res,
  );
  return res;
}

async function fetchStatus(ctx: MockCtx, jobId: string | null): Promise<MockRes> {
  const query = jobId === null ? "" : new URLSearchParams({ jobId }).toString();
  const res = makeRes();
  await routeOf(ctx, REBUILD_STATUS_PATH).handler(
    makeReq({ method: "GET", url: `${REBUILD_STATUS_PATH}?${query}`, headers: {} }),
    res,
  );
  return res;
}

/** rebuild-status 的成功应答体（404 分支走 expectStatus + body 原文断言）。 */
interface StatusBody {
  ok: boolean;
  /** 现在是**官方 JobStatus**：比原先的进程态多了 stopping（取消已发出）与 failed。 */
  status: "running" | "stopping" | "completed" | "killed" | "failed";
  exitCode: number | null;
  root: string;
  output: string;
  sandbox?: { mode: string; denied: boolean; enforcement?: string; runnerFailed?: boolean };
}

async function pollBody(ctx: MockCtx, jobId: string): Promise<StatusBody> {
  const res = await fetchStatus(ctx, jobId);
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body) as StatusBody;
}

/** 宿主给本包第 N 条重建作业签发的 id（`<kind>-N`，实测台架第 3 条）。 */
function rebuildId(index: number): string {
  return `${JOB_KIND}-${String(index)}`;
}

async function expectStatus(
  ctx: MockCtx,
  jobId: string | null,
  code: number,
  message?: string,
): Promise<MockRes> {
  const res = await fetchStatus(ctx, jobId);
  assert.equal(res.statusCode, code, message ?? res.body);
  return res;
}

/** 起一个重建 job，返回 { jobId, proc, status }。 */
async function startJob(ctx: MockCtx, root: string): Promise<{ jobId: string; proc: MockProc }> {
  trackRoot(ctx, root);
  const res = await postRebuild(ctx, root);
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body) as { jobId: string };
  const [proc] = ctx.shell.startedProcs;
  assert.ok(proc, "expected a started process");
  return { jobId: body.jobId, proc };
}

/**
 * 并发起 count 条重建并逐条断言 200（并发安全，只要不越过注册表的容量闸）。
 *
 * 每条都用**各自的工作区**：同一棵树上的第二次启动现在会复用那条在跑的（`reused: true`），
 * 拿同一个 root 铺满 N 条就成了在测复用而不是测容量。循环体里不许 await
 * （oxlint no-await-in-loop），故先攒 Promise 再一次 all。
 * @param ctx 测试上下文
 * @param base 本用例工作区名的前缀
 * @param count 条数
 * @returns {Promise<void>}
 */
async function startRebuilds(ctx: MockCtx, base: string, count: number): Promise<void> {
  const starts: Promise<MockRes>[] = [];
  for (let index = 0; index < count; index += 1) {
    const root = ws(`${base}-${String(index)}`);
    trackRoot(ctx, root);
    starts.push(postRebuild(ctx, root));
  }
  const posted = await Promise.all(starts);
  for (const res of posted) {
    assert.equal(res.statusCode, 200, res.body);
  }
}

/**
 * 把 `startedProcs[from..]` 全部自然落定。`resolveDone()` 是同步的，注册表的落定链又全是
 * 微任务 ⇒ 整批只需一次宏任务（settledTick），不必一条条等。
 * @param ctx 测试上下文
 * @param from startedProcs 的下标起点
 * @returns {Promise<void>}
 */
async function settleRebuilds(ctx: MockCtx, from: number): Promise<void> {
  for (const proc of ctx.shell.startedProcs.slice(from)) {
    proc.status = "completed";
    proc.exitCode = 0;
    proc.resolveDone();
  }
  await settledTick();
}

function okRun(stdoutText = "OK"): ShellRunResult {
  return { exitCode: 0, stdout: { text: stdoutText, truncated: false }, stderr: { text: "" } };
}

// ── 注册面 ────────────────────────────────────────────────────────────────

describe("host.apply 注册面", () => {
  it("隐式注册：Config schema 逐字段默认 = 0.1.6 交给 register 的内置底座", () => {
    // 0.1.7 删了 settings.register(ns, schema, { base })：命名空间 = profile 条目 id，
    // 默认值改由 schema 自己带（cordis 装载期用同一份 schema 填默认后交引用进 apply）。
    // 所以"底座"这层断言原样搬到这里，逐字段对齐，少一个默认就会在真实宿主上变样。
    const ctx = makeCtx();
    applyTo(ctx);
    assert.deepEqual(schemaDefaults(), {
      defaultEmbedding: DEFAULT_EMBEDDING,
      defaultLimit: 10,
      // ⚠ load-bearing：本环境 huggingface.co 不可达，默认必须是 ModelScope 镜像。
      hfEndpoint: MODELSCOPE_MIRROR,
      enforceSearchFirst: true,
      // 后两项的字面值即 lib/routing.ts 的 DEFAULT_GREP_BUDGET / DEFAULT_UNLOCK_WINDOW_MIN
      // （3 / 10 分钟）；这里手写而不是引常量，引常量就成了自证。
      grepBudgetPerSearch: 3,
      unlockWindowMin: 10,
      // 字段化的四个部署值：默认与原常量同值（5min / 60s / 10min / 400k），行为冻结。
      // 同样手写字面值不自证：host.ts 的常量改了，这里先红。
      searchTimeoutMs: 5 * 60_000,
      statusTimeoutMs: 60_000,
      indexTimeoutMs: 10 * 60_000,
      stdoutMaxBytes: 400_000,
    });
  });

  it("页面策略：settings.configure({ auto: false }) 恰好一次且 owner 是本插件 fiber", () => {
    // 本包自带设置卡片，得让宿主别再自动生成一份自动表单页；owner 缺省是 settings
    // 服务自己的 fiber —— 传错就等于给别人的页面定了策略。
    const ctx = makeCtx();
    applyTo(ctx);
    assert.equal(ctx.configureCalls.length, 1, "本包应只登记一次页面策略");
    assert.deepEqual(ctx.configureCalls[0]?.presentation, { auto: false });
    assert.equal(ctx.configureCalls[0].owner, ctx.fiber);
  });

  it("注册 3 个工具且名称正确、root 可省略、confirm 必填", () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const names = ctx.toolsRegistered.map((tool) => tool.name).toSorted();
    assert.deepEqual(names, ["zg_index", "zg_search", "zg_status"]);
    const search = toolOf(ctx, "zg_search");
    const index = toolOf(ctx, "zg_index");
    assert.notDeepEqual(search.parameters["required"], ["root"]);
    const requiredList = Array.isArray(index.parameters["required"])
      ? index.parameters["required"].filter((entry): entry is string => typeof entry === "string")
      : [];
    assert.deepEqual(requiredList, ["confirm"]);
    assert.ok(index.description.includes("confirm"));
  });

  it("注册 systemPrompt 规则段（order 1550）", () => {
    const ctx = makeCtx();
    applyTo(ctx);
    assert.equal(ctx.sections.length, 1);
    assert.equal(ctx.sections[0]?.name, "zvec-grep-routing");
    assert.equal(ctx.sections[0].order, 1550);
    assert.ok(ctx.sections[0].text.includes("zg_search"));
    assert.ok(ctx.sections[0].text.includes("root 可省略"));
  });

  it("注册 guard（透传 zgGuard）", () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const guard = guardOf(ctx);
    assert.equal(ctx.guardFns.length, 1);
    assert.equal(guard({ name: "grep" }), undefined);
    assert.notEqual(guard({ name: "zg_index", arguments: { root: "/ws" } }), undefined);
    assert.equal(guard({ name: "zg_search", arguments: { root: "/ws" } }), undefined);
    assert.equal(
      guard({ name: "zg_search", arguments: {}, agent: { session: { header: { cwd: "/sess" } } } }),
      undefined,
    );
    assert.notEqual(guard({ name: "zg_status", arguments: {} }), undefined);
  });

  it("注册 rebuild / rebuild-roots / rebuild-status 三个端点", () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const paths = ctx.routes.map((route) => route.path).toSorted();
    assert.deepEqual(paths, [REBUILD_PATH, REBUILD_ROOTS_PATH, REBUILD_STATUS_PATH]);
  });

  it("webServer 缺席时不注册端点（插件其余面照常工作）", () => {
    const ctx = makeCtx();
    ctx.noWebServer = true;
    applyTo(ctx);
    assert.deepEqual(ctx.routes, []);
    assert.equal(ctx.toolsRegistered.length, 3);
  });

  it("宿主服务面不完整时 apply 直接抛错（fail-fast）", () => {
    const applyPlugin = (plugin as unknown as { apply: (arg: unknown) => void }).apply;
    for (const hostArg of incompleteHosts()) {
      assert.throws(() => {
        applyPlugin(hostArg);
      }, /required services/u);
    }
  });

  it("卸载 effect 注销三个端点并终止在跑的重建进程", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws();
    const { proc } = await startJob(ctx, root);
    for (const dispose of ctx.effectDisposers) {
      dispose();
    }
    assert.deepEqual(ctx.unregistered.toSorted(), [
      REBUILD_PATH,
      REBUILD_ROOTS_PATH,
      REBUILD_STATUS_PATH,
    ]);
    assert.equal(proc.killCount, 1);
    const status = await fetchStatus(ctx, "zvec-grep-rebuild-1");
    assert.equal(status.statusCode, 404, "jobs 应已清空");
  });
});

// ── 工具执行 ──────────────────────────────────────────────────────────────

describe("zg_search 执行", () => {
  let ctx: MockCtx;
  let root: string;
  beforeAll(() => {
    root = ws();
  });

  it("构造命令、workdir=root、透传 stdout", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("RESULT"));
    const out = await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf());
    assert.equal(ctx.shell.resolveCalls.length, 1);
    assert.equal(
      ctx.shell.resolveCalls[0]?.command,
      "zg query 'hi' --limit 10 --preview short --refresh wait --device 'auto' --mode direct",
    );
    assert.equal(ctx.shell.resolveCalls[0].workdir, root);
    assert.deepEqual(out, { text: "RESULT" });
  });

  it("stdout 带 hits 计数行 → 尾部追加命中摘要（多组求和；未触顶不提上限）", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(
      okRun("query groups (2):\nQ1: q\nhits: 3\n#1 a\nQ2: b\nhits: 2\n#1 c"),
    );
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf())) as {
      text: unknown;
    };
    assert.ok(
      typeof out.text === "string" &&
        out.text.endsWith(
          `\n${fill(MESSAGES.zh.hitSummary, {
            groups: 2,
            hits: 5,
            limit: 10,
            capped: "",
            truncated: "",
          })}`,
        ),
    );
  });

  it("命中数达 --limit → 摘要带「已达上限」片段；截尾 → 带「只含保留部分」片段", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    const cappedRun = okRun("Q1: q\nhits: 10\n#1 a");
    cappedRun.stdout.truncated = true;
    ctx.shell.runResults.push(cappedRun);
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf())) as {
      text: unknown;
    };
    assert.ok(
      typeof out.text === "string" &&
        out.text.includes(fill(MESSAGES.zh.hitCapped, {})) &&
        out.text.includes(fill(MESSAGES.zh.hitTruncated, {})),
      "触顶与截尾片段都要出现",
    );
  });

  it("stdout 无 hits 计数行 → 不加摘要（不数就不谎称）", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("nothing recognizable"));
    const out = await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf());
    assert.deepEqual(out, { text: "nothing recognizable" });
  });

  it("hits: 打头但非纯数字的行不当计数（形状意外也不谎称），有效组照常求和", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("hits: N/A\nQ1: q\nhits: 2\n#1 a"));
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf())) as {
      text: unknown;
    };
    assert.ok(
      typeof out.text === "string" &&
        out.text.includes(
          fill(MESSAGES.zh.hitSummary, {
            groups: 1,
            hits: 2,
            limit: 10,
            capped: "",
            truncated: "",
          }),
        ),
      "摘要只数有效组",
    );
  });

  it("root 缺省 → 取当前会话工作区（0.1.5 ToolExecution.agent 面）", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("OK"));
    const out = await toolOf(ctx, "zg_search").execute({ query: "hi" }, execOf(root));
    assert.equal(ctx.shell.resolveCalls[0]?.workdir, root, "workdir 必须是会话工作区");
    assert.deepEqual(out, { text: "OK" });
    assert.deepEqual(ctx.shell.resolveCalls[0].env, {
      HF_ENDPOINT: MODELSCOPE_MIRROR,
    });
  });

  it("会话 cwd 是非字符串/空串 → 视为缺，报 root 必填", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    const search = toolOf(ctx, "zg_search");
    // 空串/数字/undefined/null 一律「会话没提供工作区」
    const badCwds = ["", 42, undefined, null];
    await Promise.all(
      badCwds.map((cwd) =>
        assert.rejects(
          () => search.execute({ query: "hi" }, { agent: { session: { header: { cwd } } } }),
          /root 必填/u,
        ),
      ),
    );
    await assert.rejects(() => search.execute({ query: "hi" }, { agent: null }), /root 必填/u);
    assert.equal(ctx.shell.resolveCalls.length, 0, "未产生 shell 调用");
  });

  it("root 不存在 → 明确归因（不冒成 spawn ENOENT）", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    const ghost = path.join(ws(), "never-created");
    await assert.rejects(
      () => toolOf(ctx, "zg_search").execute({ root: ghost, query: "x" }, execOf()),
      /root 目录不存在/u,
    );
    assert.equal(ctx.shell.resolveCalls.length, 0);
  });

  it("非对象参数（null/数组/数字）→ 明确报错", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    const search = toolOf(ctx, "zg_search");
    await assert.rejects(() => search.execute(null, execOf()), /参数必须是一个 JSON 对象.*null/u);
    await assert.rejects(() => search.execute(5, execOf()), /参数必须是一个 JSON 对象.*number/u);
  });

  it("冻结的模型参数（官方 deepFreeze）不抛错且默认 limit 生效", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("RESULT"));
    const frozen = Object.freeze({ root, query: "hi" });
    const out = await toolOf(ctx, "zg_search").execute(frozen, execOf());
    assert.deepEqual(out, { text: "RESULT" });
    assert.match(String(ctx.shell.resolveCalls[0]?.command), /--limit 10/u);
    assert.ok(!("limit" in frozen));
  });

  it("设置全缺时回内置默认（limit=10 / 默认 embedding / 默认配额）", async () => {
    ctx = makeCtx();
    ctx.settingsValue = {};
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("RESULT"));
    await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf());
    assert.equal(
      ctx.shell.resolveCalls[0]?.command,
      "zg query 'hi' --limit 10 --preview short --refresh wait --device 'auto' --mode direct",
    );
    assert.equal(ctx.shell.resolveCalls[0].env, undefined);
  });

  it("冻结参数中的显式 limit 被尊重且不抛错", async () => {
    ctx = makeCtx();
    ctx.settingsValue["defaultLimit"] = 7;
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("RESULT"));
    await toolOf(ctx, "zg_search").execute(
      Object.freeze({ root, query: "hi", limit: 3 }),
      execOf(),
    );
    assert.match(String(ctx.shell.resolveCalls[0]?.command), /--limit 3/u);
  });

  it("非零退出抛错并带 stderr", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push({
      exitCode: 2,
      stdout: { text: "", truncated: false },
      stderr: { text: "boom", truncated: false },
    });
    await assert.rejects(
      () => toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf()),
      /exit=2.*boom/u,
    );
  });

  it("超长 stderr 首尾各留一段", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    // 中段被省略：真正的失败原因常在最尾部，必须留在回显里
    const long = `${"A".repeat(500)}（中间是噪音）${"B".repeat(500)}原因：磁盘满`;
    ctx.shell.runResults.push({
      exitCode: 1,
      stdout: { text: "", truncated: false },
      stderr: { text: long, truncated: false },
    });
    await assert.rejects(
      () => toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf()),
      /中间省略.*原因：磁盘满/u,
    );
  });

  it("exitCode 为 null（被信号终止）也要报错，不静默成功", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push({
      exitCode: null,
      stdout: { text: "", truncated: false },
      stderr: { text: "killed by signal", truncated: false },
    });
    await assert.rejects(
      () => toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf()),
      /exit=null/u,
    );
  });

  it("exit 127 给出安装指引", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push({
      exitCode: 127,
      stdout: { text: "", truncated: false },
      stderr: { text: ZG_NOT_INSTALLED, truncated: false },
    });
    await assert.rejects(
      () => toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf()),
      /zg 未安装/u,
    );
  });

  it("超时/中止各有专门文案（不被当成命令失败）", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push({
      exitCode: null,
      timedOut: true,
      stdout: { text: "", truncated: false },
      stderr: { text: "", truncated: false },
    });
    await assert.rejects(
      () => toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf()),
      /zg 执行超时/u,
    );
    ctx.shell.runResults.push({
      exitCode: null,
      aborted: true,
      stdout: { text: "", truncated: false },
      stderr: { text: "", truncated: false },
    });
    await assert.rejects(
      () => toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf()),
      /zg 执行被中止/u,
    );
  });

  it("详情为空时不拼空尾巴；stderr 空则回退 stdout", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    const blank = {
      stdout: { text: "", truncated: false },
      stderr: { text: "", truncated: false },
    };
    // 类型标注是必需的：不标的话 `mode` 从常量（联合类型）取来的属性会被拓宽成 string，
    // 塞进 ShellRunResult.sandbox 就红（旧写法靠的是字面量上的 `as const`）。
    const denied: NonNullable<ShellRunResult["sandbox"]> = {
      mode: SANDBOX_WORKSPACE_WRITE,
      denied: true,
    };
    // 尾部锚点即「detail 为空时不再拼 详情：/：」的断言
    const cases: [ShellRunResult, RegExp][] = [
      [{ exitCode: 3, ...blank }, /^zg 执行失败（exit=3）$/u],
      [
        { exitCode: 127, ...blank },
        /^zg 未安装或不在 PATH：请先 `npm install -g @zvec\/zvec-grep`。$/u,
      ],
      [{ exitCode: 1, ...blank, sandbox: denied }, /更宽的文件策略。$/u],
      [
        {
          exitCode: 4,
          stdout: { text: "OUT-BOOM", truncated: false },
          stderr: blank.stderr,
        },
        /^zg 执行失败（exit=4）：OUT-BOOM$/u,
      ],
    ];
    ctx.shell.runResults.push(...cases.map(([result]) => result));
    const search = toolOf(ctx, "zg_search");
    // 队列按序消费：四次调用的期望各对其结果（result() 在发起时同步 shift）
    await Promise.all(
      cases.map(([, pattern]) =>
        assert.rejects(
          () => search.execute({ root, query: "x" }, execOf()),
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            assert.match(message, pattern);
            assert.ok(!message.includes("详情："), "空 detail 不得拼出「详情：」尾巴");
            return true;
          },
        ),
      ),
    );
    assert.equal(ctx.shell.resolveCalls.length, 4, "四次都真的跑了 shell");
  });

  it("沙箱 runner 失败：不归因给 zg 未安装，并交代 mode/enforcement", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push({
      exitCode: 127,
      stdout: { text: "", truncated: false },
      stderr: { text: "", truncated: false },
      sandbox: { mode: SANDBOX_WORKSPACE_WRITE, denied: false, runnerFailed: true },
    });
    await assert.rejects(
      () => toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf()),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /runner 启动失败/u);
        assert.match(message, /mode=workspace-write/u);
        assert.ok(!message.includes("未安装"), "runner 故障不得让用户去装 zg");
        assert.ok(!message.includes("exit=127"), "runner 故障先于 exitCode 归因");
        return true;
      },
    );
    ctx.shell.runResults.push({
      exitCode: 1,
      stdout: { text: "", truncated: false },
      stderr: { text: "denied", truncated: false },
      sandbox: { mode: "read-only", denied: true, enforcement: "partial" },
    });
    await assert.rejects(
      () => toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf()),
      /策略拒绝.*enforcement=partial/u,
    );
  });

  it("沙箱拒绝但 exit 0：结果照常返回，但显式打「可能不完整」警告", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push({
      exitCode: 0,
      stdout: { text: "HITS", truncated: false },
      stderr: { text: "", truncated: false },
      sandbox: { mode: "read-only", denied: true },
    });
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf())) as {
      text: string;
    };
    assert.ok(out.text.includes("HITS"));
    assert.ok(out.text.includes("警告：沙箱策略拒绝"));
  });

  it("stdout 超限截断：带/不带 spill 路径都要说明", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push({
      exitCode: 0,
      stdout: { text: "PART", truncated: true },
      stderr: { text: "", truncated: false },
    });
    const plain = (await toolOf(ctx, "zg_search").execute({ root, query: "a" }, execOf())) as {
      text: string;
    };
    assert.ok(plain.text.includes("已截断") && !plain.text.includes("落盘"));
    ctx.shell.runResults.push({
      exitCode: 0,
      stdout: { text: "PART", truncated: true, spillPath: "/tmp/spill.log" },
      stderr: { text: "", truncated: false },
    });
    const spilled = (await toolOf(ctx, "zg_search").execute({ root, query: "b" }, execOf())) as {
      text: string;
    };
    assert.ok(spilled.text.includes("/tmp/spill.log"));
  });

  it("exit 0 但 stderr 有降级提示：必须回显（旧实现整个丢掉）", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push({
      exitCode: 0,
      stdout: { text: "HITS", truncated: false },
      stderr: { text: "embedding 拉取失败，退化为纯词法检索", truncated: false },
    });
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf())) as {
      text: string;
    };
    assert.ok(out.text.includes("zg stderr"));
    assert.ok(out.text.includes("退化为纯词法检索"));
    ctx.shell.runResults.push({
      exitCode: 0,
      stdout: { text: "HITS", truncated: false },
      stderr: { text: "跳过 --refresh", truncated: true },
    });
    const marked = (await toolOf(ctx, "zg_search").execute({ root, query: "y" }, execOf())) as {
      text: string;
    };
    assert.ok(marked.text.includes("：[…]跳过 --refresh"));
  });

  it("成功且无任何异常 → 文本原样，不加噪声", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("CLEAN"));
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf())) as {
      text: string;
    };
    assert.equal(out.text, "CLEAN");
  });

  it("hfEndpoint 为空/缺省时不传 env", async () => {
    ctx = makeCtx();
    ctx.settingsValue["hfEndpoint"] = "   ";
    applyTo(ctx);
    ctx.shell.runResults.push(okRun());
    await toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf());
    assert.equal(ctx.shell.resolveCalls[0]?.env, undefined);
  });

  // ── C4：failureDetail / successNotes 的两道切点都不许留孤立半代理 ──────────
  // 这两处的产物一条走 `throw new Error(...)`、一条并进**成功**的工具结果，两者都被宿主
  // 持久化进会话日志 ⇒ 与 ocr-review 的 failureDetail 是同一条缺陷、同一个 400 预算。
  it("失败详情的头尾两切各咬住一枚半代理：不留孤立代理、头尾归属不换", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    // 前缀 4+10=14、后段 4+4=8、FAMILY×80=880 ⇒ 全串 902（>800 才会走两切）。
    // 头切：下标 399 是第 35 枚 👨 的高代理 ⇒ 裸前切把它留在结尾；
    // 尾切：倒数第 400 枚（下标 502）是 👧 的低代理 ⇒ 裸后切把它留在开头。
    const detail = `头部哨兵${"·".repeat(10)}${FAMILY.repeat(80)}${"·".repeat(4)}尾部哨兵`;
    assert.equal(detail.length, 902);
    const bareHead = detail.slice(0, 400);
    const bareTail = detail.slice(-400);
    assertBareCutBites(bareHead);
    assertBareCutBites(bareTail);
    ctx.shell.runResults.push({
      exitCode: 1,
      stdout: { text: "", truncated: false },
      stderr: { text: detail, truncated: false },
    });
    const rejected = await toolOf(ctx, "zg_search")
      .execute({ root, query: "x" }, execOf())
      .catch((error: unknown) => error);
    assert.ok(rejected instanceof Error, "exit=1 必须失败");
    // 期望串由文案模板逐层填出来（不抄中文句子），两半各少一枚 ⇒ 399 + 399。
    // 这一条同时是"对调两个 helper"的捕手：对调后头尾内容掉头，整串不等。
    const guardedHead = bareHead.slice(0, -1);
    const guardedTail = bareTail.slice(1);
    assert.equal(guardedHead.length, 399);
    assert.equal(guardedTail.length, 399);
    const middle = fill(MESSAGES.zh.detailMiddle, { head: guardedHead, tail: guardedTail });
    const detailPart = fill(MESSAGES.zh.detailColon, { detail: middle });
    const expected = fill(MESSAGES.zh.genericFailure, { exit: 1, detail: detailPart });
    assert.equal(rejected.message, expected);
    assert.equal(rejected.message.isWellFormed(), true, "进会话日志的拒绝消息含孤立代理");
  });

  it("成功结果的 stderr 注脚：尾切咬住低代理也不留孤立代理，预算按 399 收", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    // 前缀 20 码元 + FAMILY×38 = 438；倒数第 400 枚落在 👧 的低代理上。
    const stderrText = `降级提示：embedding 拉取失败 ${FAMILY.repeat(38)}`;
    assert.equal(stderrText.length, 438);
    const bareTail = stderrText.slice(-STDERR_NOTE_CHARS);
    assertBareCutBites(bareTail);
    ctx.shell.runResults.push({
      exitCode: 0,
      stdout: { text: "HITS", truncated: false },
      stderr: { text: stderrText, truncated: false },
    });
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf())) as {
      text: string;
    };
    // 成功路径也要断全文：注脚是**拼在成功结果尾部**进会话日志的那一段。
    assert.equal(
      out.text,
      `HITS\n${fill(MESSAGES.zh.stderrNote, { marked: "", tail: bareTail.slice(1) })}`,
    );
    assert.equal(out.text.isWellFormed(), true, "成功结果含孤立代理 ⇒ 该会话后续请求全废");
  });
});

describe("zg_index / zg_status 执行", () => {
  let root: string;
  beforeAll(() => {
    root = ws("index");
  });

  it("zg_index 缺 confirm 在 required 层即拒绝，不产生副作用", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    await assert.rejects(
      () => toolOf(ctx, "zg_index").execute({ root }, execOf()),
      /缺少必填参数 confirm/u,
    );
    assert.equal(ctx.shell.resolveCalls.length, 0);
  });

  it("使用设置里的默认 embedding", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("INDEXED"));
    await toolOf(ctx, "zg_index").execute({ root, confirm: true }, execOf());
    assert.equal(
      ctx.shell.resolveCalls[0]?.command,
      `zg index '${root}' --embedding '${DEFAULT_EMBEDDING}' ${SECRET_ARGS} --device 'auto' --mode direct`,
    );
  });

  it("设置非法值回退默认，显式 embedding 优先", async () => {
    const ctx = makeCtx();
    ctx.settingsValue["defaultEmbedding"] = "not-a-model";
    applyTo(ctx);
    ctx.shell.runResults.push(okRun(), okRun());
    await toolOf(ctx, "zg_index").execute(
      { root, confirm: true, embedding: "local/potion-code-16m-v2" },
      execOf(),
    );
    assert.match(String(ctx.shell.resolveCalls[0]?.command), /--embedding 'local\/potion/u);
    await toolOf(ctx, "zg_index").execute({ root, confirm: true }, execOf());
    assert.equal(
      ctx.shell.resolveCalls[1]?.command,
      `zg index '${root}' --embedding '${DEFAULT_EMBEDDING}' ${SECRET_ARGS} --device 'auto' --mode direct`,
    );
  });

  it("布尔旗标非布尔即拒（harness 不校验工具入参）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun(), okRun());
    await assert.rejects(
      () => toolOf(ctx, "zg_index").execute({ root, confirm: true, rebuild: 1 }, execOf()),
      /rebuild 必须是布尔值/u,
    );
    // drop=true 短路：其它非法布尔也要在构造前报错
    await assert.rejects(
      () => toolOf(ctx, "zg_index").execute({ root, confirm: true, drop: "true" }, execOf()),
      /drop 必须是布尔值/u,
    );
  });

  it("hfEndpoint 传给三个工具与 rebuild", async () => {
    const ctx = makeCtx();
    ctx.settingsValue["hfEndpoint"] = "https://modelscope.cn/models/";
    applyTo(ctx);
    const wanted = { HF_ENDPOINT: MODELSCOPE_MIRROR };
    ctx.shell.runResults.push(okRun(), okRun(), okRun());
    await toolOf(ctx, "zg_index").execute({ root, confirm: true }, execOf());
    await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf());
    await toolOf(ctx, "zg_status").execute({ root }, execOf());
    assert.deepEqual(ctx.shell.resolveCalls[0]?.env, wanted);
    assert.deepEqual(ctx.shell.resolveCalls[1]?.env, wanted);
    assert.deepEqual(ctx.shell.resolveCalls[2]?.env, wanted);
    const started = await startJob(ctx, root);
    const spec = ctx.shell.startCalls[0] as { env?: Record<string, string> };
    assert.deepEqual(spec.env, wanted);
    assert.equal(started.proc.killCount, 0);
  });

  it("zg_status 构造 status 命令、root 缺省回会话工作区", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("STATUS"), okRun("STATUS2"));
    await toolOf(ctx, "zg_status").execute({ root }, execOf());
    assert.equal(ctx.shell.resolveCalls[0]?.command, `zg status '${root}' --mode direct`);
    // 回归护栏的另一侧：前台必须保留宿主 deadline 的缺省 kill 语义，不得被
    // onExpiry:'none' 变成无界（那是后台重建专用）。
    assert.equal(ctx.shell.resolveCalls[0].onExpiry, undefined);
    assert.ok(typeof ctx.shell.resolveCalls[0].timeoutMs === "number", "前台请求必须带 timeoutMs");
    await toolOf(ctx, "zg_status").execute({}, execOf(root));
    assert.equal(ctx.shell.resolveCalls[1]?.workdir, root);
  });
});

// ── 重建端点 ──────────────────────────────────────────────────────────────

describe("rebuild-roots 引导端点", () => {
  it("GET 回 CSRF token 与已观测工作区列表", () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("roots");
    trackRoot(ctx, root);
    const access = fetchAccess(ctx);
    assert.equal(typeof access.csrf, "string");
    // 加严：原来只验 `length >= 16`，那连形态都不钉（hex 与 uuid 都过）⇒ 现与
    // lesson-loop/test/host.test.ts:848、ocr-review/test/host.test.ts:1330 的针同形。
    assert.match(
      access.csrf,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
      "token 形态要与全仓统一（uuid）",
    );
    assert.deepEqual(access.roots, [root]);
  });

  it("HEAD 允许、POST 405、跨源 403", () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const route = routeOf(ctx, REBUILD_ROOTS_PATH);
    const head = makeRes();
    // 引导端点是同步 handler
    void route.handler(makeReq({ method: "HEAD", url: REBUILD_ROOTS_PATH }), head);
    assert.equal(head.statusCode, 200);
    const post = makeRes();
    void route.handler(makeReq({ method: "POST", url: REBUILD_ROOTS_PATH }), post);
    assert.equal(post.statusCode, 405);
    assert.equal(post.headers["Allow"], "GET");
    const cross = makeRes();
    void route.handler(
      makeReq({
        method: "GET",
        url: REBUILD_ROOTS_PATH,
        headers: { "sec-fetch-site": SEC_FETCH_CROSS_SITE },
      }),
      cross,
    );
    assert.equal(cross.statusCode, 403);
  });
});

describe("rebuild 启动端点", () => {
  it("POST 有效 root 返回 jobId 并启动带超时的后台进程", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("start");
    trackRoot(ctx, root);
    const res = await postRebuild(ctx, root);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    assert.equal(body["ok"], true);
    assert.equal(typeof body["jobId"], "string");
    assert.equal(ctx.shell.startCalls.length, 1);
    // 后台进程必须有超时兜底：resolve 显式带 onExpiry:'none'（宿主不挂 deadline），
    // 唯一 deadline 由插件自己的 host.timer 提供。
    assert.equal(ctx.timerCalls.length, 1);
    assert.equal(ctx.timerCalls[0]?.ms, 10 * 60_000);
    const [spec] = ctx.shell.startCalls;
    assert.match(String(spec?.command), /--rebuild/u);
    assert.equal(spec?.workdir, root);
    // 后台请求的 stdout 缓冲上限同样走 Config（默认 = 原 STDOUT_MAX_BYTES 400k）。
    assert.equal(spec.stdoutMaxBytes, 400_000);
    // 回归护栏：0.1.7 的 bash-local resolve 缺省 onExpiry='kill'，后台漏传就会被
    // 宿主缺省 timeoutMs（Config.timeoutMs 缺省 120s）杀掉长重建。
    assert.equal(spec.onExpiry, "none");
    assert.equal(spec.timeoutMs, undefined, "后台请求不得带宿主 timeoutMs");
  });

  it("非 POST → 405", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const res = makeRes();
    await routeOf(ctx, REBUILD_PATH).handler(
      makeReq({ method: "GET", url: `${REBUILD_PATH}?root=%2Fws` }),
      res,
    );
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers["Allow"], "POST");
  });

  it("缺 CSRF / token 不符 / 跨源 → 403（动作端点两道锁）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("csrf");
    trackRoot(ctx, root);
    const noToken = await postRebuild(ctx, root, { csrfToken: "" });
    assert.equal(noToken.statusCode, 403);
    const wrongToken = await postRebuild(ctx, root, { csrfToken: "deadbeef" });
    assert.equal(wrongToken.statusCode, 403);
    const cross = await postRebuild(ctx, root, {
      extraHeaders: { "sec-fetch-site": SEC_FETCH_CROSS_SITE },
    });
    assert.equal(cross.statusCode, 403);
    assert.equal(ctx.shell.startCalls.length, 0, "被拒的请求不得启动进程");
  });

  it("body 超限 → 413；坏流 → 400", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("body");
    trackRoot(ctx, root);
    const token = fetchAccess(ctx).csrf;
    const res = makeRes();
    await routeOf(ctx, REBUILD_PATH).handler(
      makeReq({
        method: "POST",
        url: `${REBUILD_PATH}?${new URLSearchParams({ root }).toString()}`,
        headers: { [CSRF_HEADER]: token, "content-length": "99999" },
      }),
      res,
    );
    assert.equal(res.statusCode, 413);
    const broken = await postRebuild(ctx, root, { streamError: true });
    assert.equal(broken.statusCode, 400);
  });

  it("依赖抛出跨 realm 的 Error → 500 仍给可读原因", async () => {
    const ctx = makeCtx();
    ctx.shell.startThrows = "alien";
    applyTo(ctx);
    const root = ws("alien");
    trackRoot(ctx, root);
    const res = await postRebuild(ctx, root);
    assert.equal(res.statusCode, 500);
    assert.match(res.body, /启动重建失败.*from another realm/u);
  });

  it("hfEndpoint 未设置时后台进程也不带 env", async () => {
    const ctx = makeCtx();
    ctx.settingsValue["hfEndpoint"] = "";
    applyTo(ctx);
    const root = ws("noenv");
    const { proc } = await startJob(ctx, root);
    assert.equal((ctx.shell.startCalls[0] as { env?: unknown }).env, undefined);
    assert.ok(proc.killCount === 0);
  });

  it("root 不在白名单 → 403（任意绝对路径不得被重建）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const res = await postRebuild(ctx, "/etc");
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /白名单/u);
    assert.equal(ctx.shell.startCalls.length, 0);
  });

  it("root 非法（相对/缺参/越界）→ 400", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const relative = await postRebuild(ctx, "relative/path");
    assert.equal(relative.statusCode, 400);
    const missing = await postRebuild(ctx, null);
    assert.equal(missing.statusCode, 400);
    const escape = await postRebuild(ctx, "/../../etc");
    assert.equal(escape.statusCode, 400);
  });

  it("白名单里的 root 已被删除 → 400（明确归因）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("gone");
    trackRoot(ctx, root);
    rmSync(root, { recursive: true, force: true });
    const res = await postRebuild(ctx, root);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /已不存在/u);
  });

  it("shell.execute 抛错 → 500 且带原因", async () => {
    const ctx = makeCtx();
    ctx.shell.startThrows = "error";
    applyTo(ctx);
    const root = ws("startfail");
    trackRoot(ctx, root);
    const res = await postRebuild(ctx, root);
    assert.equal(res.statusCode, 500);
    assert.match(res.body, /启动重建失败/u);
  });

  it("query 解析：+ 解码为空格（URLSearchParams 语义）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = wsWithSpace();
    trackRoot(ctx, root);
    // URLSearchParams 把空格编码成 `+`：卡片提交的正是这种形式
    const encoded = new URLSearchParams({ root }).toString();
    assert.ok(encoded.includes("+"), "替身须真的走到 + 编码");
    const token = fetchAccess(ctx).csrf;
    const res = makeRes();
    await routeOf(ctx, REBUILD_PATH).handler(
      makeReq({
        method: "POST",
        url: `${REBUILD_PATH}?${encoded}`,
        headers: { [CSRF_HEADER]: token },
      }),
      res,
    );
    assert.equal(res.statusCode, 200, res.body);
    const { jobId } = JSON.parse(res.body) as { jobId: string };
    const body = await pollBody(ctx, jobId);
    assert.equal(body.root, root);
    assert.ok(root.includes(" "), "替身目录名须含空格");
  });

  it("白名单按归一化键比较（尾斜杠/`.` 段同物异写不绕过）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("norm");
    trackRoot(ctx, `${root}/./`);
    const res = await postRebuild(ctx, root);
    assert.equal(res.statusCode, 200, res.body);
  });

  it("白名单容量有界（超过 64 个按插入序淘汰最老）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const roots: string[] = [];
    for (let index = 0; index <= 64; index += 1) {
      const root = `/ws-dir/case-${String(index)}`;
      roots.push(root);
      trackRoot(ctx, root);
    }
    const access = fetchAccess(ctx);
    assert.equal(access.roots.length, 64);
    assert.ok(!access.roots.includes(roots[0] ?? ""), "最老的应被淘汰");
    assert.ok(access.roots.includes(roots[64] ?? ""));
    trackRoot(ctx, "relative/not-a-root");
    assert.equal(fetchAccess(ctx).roots.length, 64, "非法 root 不入账");
  });
});

describe("rebuild 后台进程状态", () => {
  it("完成：status/exitCode 原样回给卡片（completed+exit≠0 不得显示成功）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("done");
    const { jobId, proc } = await startJob(ctx, root);
    proc.status = "completed";
    proc.exitCode = 127;
    proc.emit("stdout", ZG_NOT_INSTALLED);
    proc.resolveDone();
    await settledTick();
    const body = await pollBody(ctx, jobId);
    assert.equal(body.status, "completed");
    assert.equal(body.exitCode, 127);
    assert.ok(body.output.includes("command not found"));
    assert.equal(body.sandbox, undefined, "无沙箱执行器不得凭空造字段");
  });

  it("落定但没报退出码：官方名册按 exit code: 0 记，卡片仍原样拿 null", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("noexitcode");
    const { jobId, proc } = await startJob(ctx, root);
    // 执行器把进程报成"非 killed 的落定"却没有退出码（跨 runner 的边角形态）。
    // detail 走宿主 bash 工具同一句 `exit code: ${exitCode ?? 0}`（借来的口径），
    // 但**卡片契约不动**：exitCode 原样是 null，成功判据仍要求它 === 0。
    proc.status = "completed";
    proc.exitCode = null;
    proc.resolveDone();
    await settledTick();
    const body = await pollBody(ctx, jobId);
    assert.equal(body.status, "completed");
    assert.equal(body.exitCode, null, "不许把 null 粉饰成 0");
    const [record] = ctx.jobs.list();
    assert.ok(record);
    assert.equal(record.detail, "exit code: 0");
  });

  it("沙箱事实透传：runner 失败要写进输出，不能被当成完成", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("runner");
    const { jobId, proc } = await startJob(ctx, root);
    proc.sandbox = { mode: SANDBOX_WORKSPACE_WRITE, denied: false, runnerFailed: true };
    proc.status = "completed";
    proc.exitCode = 0;
    proc.resolveDone();
    await settledTick();
    const body = await pollBody(ctx, jobId);
    assert.ok(body.output.includes("runner 启动失败"));
    assert.equal(body.sandbox?.runnerFailed, true);
  });

  it("沙箱策略拒绝：输出里给不完整警告（read-only 下写不了 .zvec-grep）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("denied");
    const { jobId, proc } = await startJob(ctx, root);
    proc.sandbox = { mode: "read-only", denied: true, enforcement: "full" };
    proc.status = "killed";
    proc.exitCode = null;
    proc.resolveDone();
    await settledTick();
    const body = await pollBody(ctx, jobId);
    assert.equal(body.status, "killed");
    assert.ok(body.output.includes("策略拒绝"));
  });

  it("沙箱在位但未拒绝：不加任何噪声", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("clean");
    const { jobId, proc } = await startJob(ctx, root);
    proc.sandbox = { mode: "danger-full-access", denied: false };
    proc.status = "completed";
    proc.exitCode = 0;
    proc.resolveDone();
    await settledTick();
    const body = await pollBody(ctx, jobId);
    assert.equal(body.output, "");
  });

  it("超时定时器：终止运行中的进程并写明原因", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("timeout");
    const { jobId, proc } = await startJob(ctx, root);
    ctx.timerCalls[0]?.fn();
    assert.equal(proc.killCount, 1);
    const body = await pollBody(ctx, jobId);
    assert.ok(body.output.includes("重建超时"));
    assert.ok(body.output.includes("强制终止"));
  });

  it("超时定时器竞态：进程已自然退出 / job 已结束 → 不再 kill、不追加文案", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("race");
    const { jobId, proc } = await startJob(ctx, root);
    proc.status = "completed";
    ctx.timerCalls[0]?.fn();
    assert.equal(proc.killCount, 0, "proc 已退出，不得 kill");
    proc.exitCode = 0;
    proc.resolveDone();
    await settledTick();
    ctx.timerCalls[0]?.fn();
    assert.equal(proc.killCount, 0, "job 已收尾，定时器应为空操作");
    const body = await pollBody(ctx, jobId);
    assert.ok(!body.output.includes("强制终止"));
  });

  it("kill 抛错（进程已回收）要吞掉，不影响状态应答", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("killthrow");
    const { jobId, proc } = await startJob(ctx, root);
    proc.kill = () => {
      throw new Error("ESRCH");
    };
    ctx.timerCalls[0]?.fn();
    const body = await pollBody(ctx, jobId);
    assert.ok(body.output.includes("重建超时"));
  });

  it("输出有界：超 256KB 只留尾部并打标", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("bigout");
    const { jobId, proc } = await startJob(ctx, root);
    proc.emit("stdout", "x".repeat(RING_RETAIN_BYTES + 100));
    await pumpTick();
    const body = await pollBody(ctx, jobId);
    assert.ok(
      body.output.length <= RING_RETAIN_BYTES + 200,
      `输出应有界，实际 ${String(body.output.length)}`,
    );
    assert.ok(body.output.includes("已截断"));
    assert.ok(!body.output.includes("缓冲区溢出"), "截断是自己做的，不该报执行器丢失");
  });

  it("截断点切开代理对时丢弃孤立低代理项（不乱码）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("surrogate");
    const { jobId, proc } = await startJob(ctx, root);
    // 夹具：首枚 😀 的代理对**正好跨在 256KB 的界上**（全串 262145 码元 ⇒ 裸后切从
    // 低代理开头）。旧夹具（emoji 补到 4000 再补 a）在把实现换回裸 slice 后**整包全绿**
    // ——它咬不住任何东西，故本条重写；下面两条自守就是那条断言的牙齿。
    const delta = "\u{1F600}".concat("a".repeat(RING_RETAIN_BYTES - 1));
    assert.equal(delta.length, RING_RETAIN_BYTES + 1);
    assertBareCutBites(delta.slice(-RING_RETAIN_BYTES));
    proc.emit("stdout", delta);
    await pumpTick();
    const body = await pollBody(ctx, jobId);
    assert.ok(body.output.includes("已截断"));
    assert.equal(body.output.includes("\uDC00"), false, "不得留孤立代理项");
    // 缓冲区只经"尾部 4000 码元"的显示窗口露面，头部那枚被切掉的半代理看不见 ⇒
    // 牙齿落在**总长标注**上：丢掉一枚才可能是 262143，裸 slice 是 262144。
    assert.ok(
      body.output.includes(
        fill(MESSAGES.zh.jobOutputView, { shown: VIEW_CHARS, total: RING_RETAIN_BYTES - 1 }),
      ),
      `缓冲区总长应少一枚，实得 ${body.output.slice(0, 120)}`,
    );
    assert.equal(body.output.isWellFormed(), true);
  });

  it("显示窗口只截尾部但仍标注总长（未超 256KB 也要标）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("view");
    const { jobId, proc } = await startJob(ctx, root);
    const total = 8000;
    proc.emit("stdout", "log-".repeat(total / 4));
    await pumpTick();
    const body = await pollBody(ctx, jobId);
    assert.ok(body.output.includes(`仅显示尾部 ${VIEW_CHARS} 字符`));
    assert.ok(body.output.includes(`共 ${total} 字符`));
    assert.equal(body.output.includes("已截断"), false, "仍在内存上限内，不该报截断");
    assert.equal(body.output.endsWith("log-"), true);
  });

  it("执行器读者报 lossy（真丢过字节）→ 明确标注不是完整日志", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("lossy");
    const { jobId, proc } = await startJob(ctx, root);
    proc.emit("stdout", "partial");
    proc.failRead("stdout", "lossy");
    await pumpTick();
    const body = await pollBody(ctx, jobId);
    assert.ok(body.output.includes("缓冲区溢出"));
    assert.ok(body.output.includes("partial"));
  });

  it("执行器读者抛错 → 本包兜住并按「有丢失」处理（不裸 500、也不静默少一段）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("readthrow");
    const { jobId, proc } = await startJob(ctx, root);
    proc.emit("stdout", "before the reader broke");
    await pumpTick();
    proc.failRead("stdout", "throw");
    await pumpTick();
    proc.emit("stdout", "-after");
    await pumpTick();
    const res = await fetchStatus(ctx, jobId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { output: string; status: string };
    assert.match(body.output, /缓冲区溢出/u);
    // 抛错之前那一拍已经搬进环的内容不许被连带丢掉。
    assert.ok(body.output.includes("before the reader broke"));
    // 兜住抛错的另一 Half：官方泵一旦遇到抛错就**此后不再排这一路**（实测），所以抛错之后
    // 再产出的内容不会进环——卡片必须仍然答 200 并把"有丢失"说清楚，而不是假装完整。
    assert.equal(body.status, "running");
    assert.ok(!body.output.includes("-after"));
  });
});

describe("rebuild-status 端点", () => {
  it("跨源 → 403", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const res = makeRes();
    await routeOf(ctx, REBUILD_STATUS_PATH).handler(
      makeReq({
        method: "GET",
        url: `${REBUILD_STATUS_PATH}?jobId=zvec-grep-rebuild-1`,
        headers: { "sec-fetch-site": SEC_FETCH_CROSS_SITE },
      }),
      res,
    );
    assert.equal(res.statusCode, 403);
  });

  it("jobId 缺省/空串/未知 → 404 且给出可行动说明", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    await expectStatus(ctx, null, 404);
    await expectStatus(ctx, "", 404);
    const res = await fetchStatus(ctx, "nope");
    assert.equal(res.statusCode, 404);
    // 文案里的历史窗口数字必须真在句子出现（卡片只有这一行可看）。
    assert.match(res.body, /已移出历史窗口/u);
    assert.match(res.body, /10 条/u, "404 要把窗口大小告诉用户");
    assert.match(res.body, /请重新发起重建/u, "要给可行动下一步，不是裸 404");
  });

  it("已知 jobId → running + root + exitCode 尚未产生", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("running");
    const { jobId } = await startJob(ctx, root);
    const res = await fetchStatus(ctx, jobId);
    const body = JSON.parse(res.body) as { ok: boolean; status: string; root: string };
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status, "running");
    assert.equal(body.root, root);
  });

  it("并发满员：官方注册表**拒绝**新启动，本包杀掉刚起的进程并回 500", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    // 每条都用各自的工作区（同 root 会被复用，见下面那条复用例）：这里要测的是容量闸。
    const roots: string[] = [];
    for (let index = 0; index < LIVE_CAP; index += 1) {
      const root = ws(`full-${String(index)}`);
      trackRoot(ctx, root);
      roots.push(root);
    }
    // 铺满容量（同步按序发起，jobId 即按此序分配），再统一等应答
    const starts: Promise<MockRes>[] = [];
    for (const root of roots) {
      starts.push(postRebuild(ctx, root));
    }
    const posted = await Promise.all(starts);
    for (const res of posted) {
      assert.equal(res.statusCode, 200, res.body);
    }
    assert.equal(ctx.shell.startedProcs.length, LIVE_CAP);
    // 第 LIVE_CAP+1 次：换装前这里会「终止并淘汰最老的运行中任务」，官方件的答法是
    // 直接拒绝 —— 用户的重建不再被静默杀掉，超额请求拿到一条点名上限的失败。
    const extra = ws("full-overflow");
    trackRoot(ctx, extra);
    const refused = await postRebuild(ctx, extra);
    assert.equal(refused.statusCode, 500, refused.body);
    // 满员这句在本包**所有**启动失败里最特殊：宿主原话是英文，而它恰恰最该翻成中文
    // （用户要做的是去收作业，不是读一句 "background job limit reached"）。
    assert.match(refused.body, /后台作业已满/u);
    assert.match(refused.body, /job_kill/u, "要给出可行动的下一步，而不是只说「失败」");
    assert.match(refused.body, /10 条/u, "宿主给的上限数字要原样带出来");
    assert.ok(
      !refused.body.includes("background job limit reached"),
      "宿主英文原话不得整句混进中文卡片（双语口径）",
    );
    // 进程是先起后拒的（spawn 在注册之前）：拒绝时必须把它收掉，不能留一条没登记的 zg。
    assert.equal(ctx.shell.startedProcs[LIVE_CAP]?.killCount, 1, "被拒的那条必须立刻终止");
    assert.equal(
      ctx.shell.startedProcs.slice(0, LIVE_CAP).every((proc) => proc.killCount === 0),
      true,
      "在跑的十条一条都不许动",
    );
    // 被拒不留半条记录：官方 id 序列仍是 1..LIVE_CAP
    await expectStatus(ctx, rebuildId(LIVE_CAP), 200);
    await expectStatus(ctx, rebuildId(LIVE_CAP + 1), 404);
  });

  it("历史窗口：只淘汰最老的**已落定**记录，窗口内的仍查得到", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    // 起满历史窗口并逐条落定（落定的作业不占并发桶，所以能一路起满）
    await startRebuilds(ctx, "history", HISTORY_MAX);
    await settleRebuilds(ctx, 0);
    await expectStatus(ctx, rebuildId(1), 200);
    // 不变量：**本 kind 在册记录（含进行中的那条）不超过 HISTORY_MAX 条**。裁剪发生在 start
    // 之前，剪到只剩 HISTORY_MAX-1 条已落定 ⇒ 新起的这条落定后正好 HISTORY_MAX 条，与卡片
    // 文案「只保留最近 10 条已结束的重建」同一口径。（最初把这里判成"留 9 条差一格"是
    // 看错了时点——只看了剪完那一刻；后来两份报告都实测到册子里出现 11 条，故回退。）
    await startRebuilds(ctx, "history", 1);
    assert.equal(ctx.shell.startedProcs.length, HISTORY_MAX + 1);
    await expectStatus(ctx, rebuildId(1), 404, "第 11 次启动把最老的已落定记录移出");
    await expectStatus(ctx, rebuildId(2), 200);
    await expectStatus(ctx, rebuildId(HISTORY_MAX + 1), 200);
    // 侧表也必须跟着走：prune 里 `records.delete` 漏掉的话，这条幽灵会一直钉着 proc，
    // 并在卸载那一臂被当成在跑的作业再 kill 一次（下面那条断言就是这一行的牙齿）。
    const [evicted] = ctx.shell.startedProcs;
    assert.ok(evicted);
    for (const dispose of ctx.effectDisposers) {
      dispose();
    }
    assert.equal(evicted.killCount, 0, "已被移出历史的记录不该再被卸载臂动到");
    // 淘汰历史是"移出名册"，不是"杀掉进程"：那十条已落定的进程一条都不许被动过。
    assert.equal(
      ctx.shell.startedProcs.slice(0, HISTORY_MAX).every((proc) => proc.killCount === 0),
      true,
      "淘汰历史记录不需要、也不允许杀进程",
    );
  });

  it("spawn 让出的那一拍里 jobs 消失 ⇒ 503 并杀掉刚起的 zg，绝不登记进可能已死的实例", async () => {
    // handler 在 `await execute()` 之后还要回注册表 prune/start：现读现用。
    const ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.vanishJobsAfterExecute = 1;
    const root = ws("vanish-mid");
    trackRoot(ctx, root);
    const res = await postRebuild(ctx, root);
    assert.equal(res.statusCode, 503, res.body);
    assert.match(res.body, /ctx\.jobs/u);
    assert.equal(ctx.shell.startedProcs[0]?.killCount, 1, "进程起在注册之前，必须当场收掉");
    assert.equal(ctx.jobs.list().length, 0, "没有任何作业被登记");
  });

  it("同一棵树上的第二次启动复用那条在跑的重建，不再并发起第二条 zg", async () => {
    // `zg index --rebuild` 是 drop + 重写：两条并发就是两个进程在同一份 `.zvec-grep/` 上互啃。
    // 复用只对在跑的成立，所以这条也断"落定之后再点=新作业"。
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("dedup");
    const { jobId, proc } = await startJob(ctx, root);
    const again = await postRebuild(ctx, root);
    assert.equal(again.statusCode, 200, again.body);
    const second = JSON.parse(again.body) as { jobId: string; reused?: boolean };
    assert.equal(second.jobId, jobId, "第二张面板跟随同一条作业");
    assert.equal(second.reused, true, "回执要说清这是复用，不是新起的一条");
    assert.equal(ctx.shell.startedProcs.length, 1, "第二条 zg 根本不该起来");
    proc.status = "completed";
    proc.exitCode = 0;
    proc.resolveDone();
    await settledTick();
    const third = await postRebuild(ctx, root);
    assert.equal(third.statusCode, 200, third.body);
    assert.equal(ctx.shell.startedProcs.length, 2, "那条落定之后再点才是真的一条新作业");
    assert.equal((JSON.parse(third.body) as { reused?: boolean }).reused, undefined);
  });

  it("jobs 被换成另一枚实例：同名 id 拒绝登记、只收自己刚起的那条", async () => {
    // 实测两枚 LocalJobRegistry 对同一 kind 都签发 `zvec-grep-rebuild-1`（计数器是实例字段）。
    // 顶掉旧记录会让旧面板从此跟着另一棵树走，故这里反过来：拒绝这条新的、杀掉它的进程，
    // 旧那条的记录与超时臂原样留着。
    const ctx = makeCtx();
    applyTo(ctx);
    const rootA = ws("clash-a");
    const { jobId, proc: procA } = await startJob(ctx, rootA);
    ctx.jobs = makeJobRegistry();
    const rootB = ws("clash-b");
    trackRoot(ctx, rootB);
    const res = await postRebuild(ctx, rootB);
    assert.equal(res.statusCode, 503, res.body);
    assert.match(res.body, /服务已被替换/u, "要给出可行动的下一步（重载插件），别只说「失败」");
    const [, procB] = ctx.shell.startedProcs;
    assert.equal(procB?.killCount, 1, "新起的那条必须当场收掉");
    assert.equal(procA.killCount, 0, "旧那条的进程不许被动");
    // 旧卡片也读不到东西了：名册已换主，`bornAt` 对不上 ⇒ 宁 404 也不串台。
    await expectStatus(ctx, jobId, 404, "身份证对不上时不许把另一枚实例的读数端给旧面板");
  });

  it("两条通道都进环：卡片视图读得到 stdout 与 stderr（合并不许把哪一路丢掉）", async () => {
    // pull source 是两条带 channel 的源；投影把它们按 offset 序拼成一段文本。测试若从不
    // 往 stderr 上吐字，实现里加一句 `filter(chunk => chunk.channel !== "stderr")` 也能全绿。
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("channels");
    const { jobId, proc } = await startJob(ctx, root);
    proc.emit("stdout", "indexed 12 files");
    proc.emit("stderr", "warn: falling back to lexical search");
    await pumpTick();
    const body = await pollBody(ctx, jobId);
    assert.ok(body.output.includes("indexed 12 files"), body.output);
    assert.ok(body.output.includes("falling back to lexical search"), "stderr 那一路不许被丢掉");
  });

  it("宿主没装 ctx.jobs：启动端点回答不可用，且绝不起进程", async () => {
    const ctx = makeCtx();
    ctx.noJobs = true;
    applyTo(ctx);
    const root = ws("nojobs");
    trackRoot(ctx, root);
    const res = await postRebuild(ctx, root);
    assert.equal(res.statusCode, 503, res.body);
    assert.match(res.body, /ctx\.jobs/u, "要把缺的那件点名，别只回「失败」");
    assert.equal(ctx.shell.startCalls.length, 0, "没有注册表就不该先把 zg 起起来");
    // 引导端点不依赖注册表：卡片仍能取 token 与候选（坏在最小的那一面）。
    assert.ok(fetchAccess(ctx).csrf.length > 0);
    // 轮询端点在没有注册表时全 404（侧表是空的），不抛穿。
    await expectStatus(ctx, rebuildId(1), 404);
  });

  it("ctx.jobs 晚到：先 503，服务到位后同一条端点就起得来（不靠重载插件）", async () => {
    // 实测：`ctx.get` 是一次性的存储读，apply 时读一次就把"晚到"钉成永久故障。
    // 本包的判据因此每次现读——这条用例就是那枚防回归的钉子。
    const ctx = makeCtx();
    ctx.noJobs = true;
    applyTo(ctx);
    const root = ws("latejobs");
    trackRoot(ctx, root);
    const denied = await postRebuild(ctx, root);
    assert.equal(denied.statusCode, 503, denied.body);
    ctx.noJobs = false;
    const granted = await postRebuild(ctx, root);
    assert.equal(granted.statusCode, 200, granted.body);
    assert.equal(ctx.jobs.list().length, 1, "作业登记进了真正在服务的这枚注册表");
  });

  it("注册表被重载：轮询回答 404，绝不把异常抛穿（否则卡片就此失明）", async () => {
    // 官方 disposeAll 会清空名册，而侧表里的记录还在（它还钉着 proc）。这条路径上
    // 抛穿到 webServer 的实测后果是"记一条日志 + 写一枚没有 body、没有 content-type 的 400"
    // （installed dsh-host-webserver lib/index.js:246-256）⇒ 卡片判"取不到 JSON"⇒ error
    // 终止态 ⇒ 停止轮询 ⇒ 一条还在跑的重建从界面上消失。
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("reload");
    const { jobId, proc } = await startJob(ctx, root);
    ctx.jobs = makeJobRegistry();
    await expectStatus(ctx, jobId, 404, "换了注册表就是查无此条，必须答 404");
    const gone = await fetchStatus(ctx, jobId);
    assert.match(gone.body, /历史窗口/u, "404 要带可行动说明，而不是让卡片只显示「查询状态失败」");
    // 进程归卸载那一臂收：重载后的注册表不再认得它，但它是本包起的（不能留孤儿 zg）。
    ctx.noJobs = true;
    for (const dispose of ctx.effectDisposers) {
      dispose();
    }
    assert.equal(proc.killCount, 1, "名册不认得也要把进程收掉");
  });

  it("已起作业后 jobs 消失：轮询回答 503 并点名缺的那件", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("pollnojobs");
    const { jobId } = await startJob(ctx, root);
    ctx.noJobs = true;
    const res = await fetchStatus(ctx, jobId);
    assert.equal(res.statusCode, 503, res.body);
    assert.match(res.body, /ctx\.jobs/u);
  });

  it("超时那一拍注册表被关掉：进程照样收掉，超时说明仍给到卡片", async () => {
    // 超时兜底不许依赖名册还在：`jobs` 那一行被关掉时注册表侧已经没有这条可标记，
    // 但进程是本包起的，不杀它就是一条永远没人收的孤儿 zg。
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("timeout-absent");
    const { jobId, proc } = await startJob(ctx, root);
    ctx.noJobs = true;
    ctx.timerCalls[0]?.fn();
    assert.equal(proc.killCount, 1, "服务缺席那一档必须把进程收掉");
    ctx.noJobs = false;
    const body = await pollBody(ctx, jobId);
    assert.ok(body.output.includes("重建超时"), "超时说明由投影层合成，不依赖注册表活着");
  });

  it("超时那一拍注册表被换成另一枚：进程收掉，轮询如实 404", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("timeout-reloaded");
    const { jobId, proc } = await startJob(ctx, root);
    ctx.jobs = makeJobRegistry();
    ctx.timerCalls[0]?.fn();
    assert.equal(proc.killCount, 1, "换了注册表也要把进程收掉");
    await expectStatus(ctx, jobId, 404, "新注册表不认得这条 ⇒ 如实 404，不抛穿");
  });

  it("超时那一拍名册已在收尾（stopping）：不再重复动手", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("timeout-stopping");
    const { jobId, proc } = await startJob(ctx, root);
    const [job] = ctx.jobs.list();
    assert.ok(job);
    assert.equal(ctx.jobs.kill(job.id, undefined, "用户先收了"), "requested");
    ctx.timerCalls[0]?.fn();
    assert.equal(proc.killCount, 1, "已经在收的那条不该被再动一次");
    const body = await pollBody(ctx, jobId);
    assert.ok(!body.output.includes("重建超时"), "有人收的不是超时，别记这条理由");
  });

  it("starter 里抛错（宿主 timer 面已拆）→ 500 给通用原因，且不留半条记录", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("starterthrows");
    trackRoot(ctx, root);
    ctx.timer.timeout = () => {
      throw new Error("timer service is gone");
    };
    const res = await postRebuild(ctx, root);
    assert.equal(res.statusCode, 500, res.body);
    assert.match(res.body, /启动重建失败/u);
    assert.match(res.body, /timer service is gone/u);
    assert.ok(!res.body.includes("后台作业已满"), "不是容量问题就别报容量");
    assert.equal(ctx.shell.startedProcs[0]?.killCount, 1, "起都起不来的那条 zg 必须立杀");
    assert.equal(ctx.jobs.list().length, 0, "官方件对 starter 抛错的答法是不注册（序号作废）");
    // 侧表也不能留着它：那条记录钉着一枚 proc，卸载臂会把它当自己的作业再 kill 一次。
    for (const dispose of ctx.effectDisposers) {
      dispose();
    }
    assert.equal(
      ctx.shell.startedProcs[0].killCount,
      1,
      "只有拒绝那一臂杀过一次，卸载那一臂不该再动这条幽灵",
    );
  });

  it("超时经注册表收：模型侧 stopping + detail 带上超时理由（不与人工取消同形）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("timeout");
    const { jobId, proc } = await startJob(ctx, root);
    const [job] = ctx.jobs.list();
    assert.ok(job);
    ctx.timerCalls[0]?.fn();
    assert.equal(proc.killCount, 1, "超时经注册表回调 cancel() 杀进程");
    assert.equal(ctx.jobs.get(job.id).status, "stopping", "名册要知道这条正在收尾");
    proc.status = "killed";
    proc.signal = "SIGTERM";
    proc.resolveDone();
    await settledTick();
    // detail = 生产者结局 + 注册表追加的 reason（实测）。没有后半句，模型看到的就是
    // `[status: killed, signal: SIGTERM]`，与"用户手工 job_kill"完全同形。
    assert.equal(
      ctx.jobs.get(job.id).detail,
      `signal: SIGTERM; ${fill(MESSAGES.zh.jobReasonTimeout, { minutes: 10 })}`,
    );
    const body = await pollBody(ctx, jobId);
    assert.ok(body.output.includes("重建超时"), "卡片侧的超时说明仍要原样给到");
  });

  it("外来 jobId 不在本包侧表里 ⇒ 404，绝不代读别人的作业", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    // 宿主 bash 工具的 id 形如 `bash-1`，与本包同处一枚注册表 ⇒ 猜得到 id 不等于读得到
    // 内容。这里替宿主的 bash 生产者挂它自己那一枚 controller（实测：本包起完作业就摘，
    // 不再留常驻 token，所以别的 caller 必须自己 attach 才起得来）。
    const detachBash = ctx.jobs.attachController("test: host bash tool");
    ctx.jobs.start({
      kind: "bash",
      label: "echo hi",
      run: () => ({ cancel: noop, done: Promise.resolve({ status: "completed" as const }) }),
    });
    detachBash();
    assert.equal(
      ctx.jobs
        .list()
        .map((job) => job.id)
        .join(","),
      "bash-1",
    );
    await expectStatus(ctx, "bash-1", 404, "别人的作业不得经本包端点外泄");
  });

  it("模型侧 job_kill 收掉重建：stopping 按「仍在跑」应答，落定后是 killed", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("kill");
    const { jobId, proc } = await startJob(ctx, root);
    const [foreign] = ctx.jobs.list();
    assert.ok(foreign);
    assert.equal(ctx.jobs.kill(foreign.id, undefined, "用户取消"), "requested");
    assert.equal(proc.killCount, 1, "官方 kill 必须落到 proc.kill（cancel 那一臂）");
    const stopping = await pollBody(ctx, jobId);
    assert.equal(stopping.status, "stopping", "取消已发出、进程还没收完");
    proc.status = "killed";
    proc.signal = "SIGTERM";
    proc.resolveDone();
    await settledTick();
    const body = await pollBody(ctx, jobId);
    assert.equal(body.status, "killed");
    assert.equal(body.exitCode, null);
    // 官方 observers 那一侧的终态理由：信号名要写进 detail（与宿主 bash 工具 processOutcome
    // 同口径），而 kill 的 reason 由注册表**追加**——生产者不许自己再带一遍（否则同一句两遍）。
    assert.equal(ctx.jobs.get(foreign.id).detail, "signal: SIGTERM; 用户取消");
  });

  it("历史裁剪跳过 stopping：正在收的那条不许被 remove，最老的已落定记录先走", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("prunelive");
    const { proc } = await startJob(ctx, root);
    const [first] = ctx.jobs.list();
    assert.ok(first);
    assert.equal(ctx.jobs.kill(first.id, undefined, "取消但不落定"), "requested");
    // 进程已 kill、done 故意不落定 ⇒ 这条一直停在 stopping；官方 remove 对活作业会抛，
    // 裁剪若跟着删它，下一次轮询就是端点 500。
    // 铺场顺序受容量闸约束（stopping 也计入在跑）：起 9 条落定 → 再起 1 条落定（满 10 条
    // 已落定）→ 最后这一次启动才会触发裁剪。
    await startRebuilds(ctx, "prunelive", LIVE_CAP - 1);
    await settleRebuilds(ctx, 1);
    await startRebuilds(ctx, "prunelive", 1);
    await settleRebuilds(ctx, LIVE_CAP);
    // 窗口留满 10 条已落定（stopping 那条不计入）时，最老的已落定记录仍该查得到。
    await startRebuilds(ctx, "prunelive", 1);
    await settleRebuilds(ctx, LIVE_CAP + 1);
    // 到这一步才有第 11 条已落定记录：多出的最老那条先走，正在收尾的那条例外不动。
    await startRebuilds(ctx, "prunelive", 1);
    const ids = ctx.jobs.list().map((job) => `${String(job.id)}:${job.status}`);
    assert.ok(ids.includes(`${rebuildId(1)}:stopping`), `stopping 那条必须还在：${ids.join(" ")}`);
    assert.ok(!ids.includes(`${rebuildId(2)}:completed`), `已落定的最老那条先走：${ids.join(" ")}`);
    assert.equal(proc.killCount, 1, "取消只发过一次");
  });

  it("卸载 effect：已落定的记录顺手 remove，在跑的那条只 kill", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("unload");
    // startJob 的 proc 取的是 startedProcs[0]（单作业助手的形状），第二条要自己按序取
    const { proc: settledProc } = await startJob(ctx, root);
    settledProc.status = "completed";
    settledProc.exitCode = 0;
    settledProc.resolveDone();
    await settledTick();
    await startJob(ctx, root);
    // startJob 只回第一条的 proc，第二条按位取（解构而不是下标：oxlint prefer-destructuring）
    const [, runningProc] = ctx.shell.startedProcs;
    assert.ok(runningProc, "第二条重建应已起进程");
    assert.equal(ctx.jobs.list().length, 2);
    for (const dispose of ctx.effectDisposers) {
      dispose();
    }
    const left = ctx.jobs.list();
    assert.deepEqual(
      left.map((job) => job.status),
      ["stopping"],
      "落定的那条已被 remove；在跑的那条只能被 kill（此刻还在收，官方件不许删）",
    );
    assert.equal(String(left[0]?.id), rebuildId(2), "被 remove 的必须是最老的那条已落定记录");
    assert.equal(runningProc.killCount, 1, "在跑的进程必须经注册表 kill 收到（cancel 那一臂）");
    assert.equal(settledProc.killCount, 0, "已落定不必再 kill");
    // 卸载那条理由要模型看得见（否则它与"用户手工 job_kill"同形）。注意别再补一次 kill：
    // 实测 detail 里的 reason 是**后一发覆盖前一发**，补 kill 反而会把卸载理由擦掉。
    const [leftover] = ctx.jobs.list();
    assert.ok(leftover);
    assert.equal(leftover.status, "stopping", "卸载那一臂已经把它推到收尾");
    runningProc.status = "killed";
    runningProc.signal = "SIGTERM";
    runningProc.resolveDone();
    await settledTick();
    assert.equal(
      ctx.jobs.get(leftover.id).detail,
      `signal: SIGTERM; ${MESSAGES.zh.jobReasonUnload}`,
      "卸载 reason 要落在模型可见 detail 里",
    );
  });

  it("英文界面下卸载 reason 也是英文（模型可见文本不许硬编码中文）", async () => {
    const ctx = makeCtx();
    ctx.localeDocument = { preference: "en" };
    applyTo(ctx);
    const root = ws("unload-en");
    const { proc } = await startJob(ctx, root);
    for (const dispose of ctx.effectDisposers) {
      dispose();
    }
    const [job] = ctx.jobs.list();
    assert.ok(job);
    proc.status = "killed";
    proc.signal = "SIGTERM";
    proc.resolveDone();
    await settledTick();
    assert.equal(ctx.jobs.get(job.id).detail, `signal: SIGTERM; ${MESSAGES.en.jobReasonUnload}`);
  });

  it("卸载时记录已被别人收走：只杀进程，不抛错", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("unloadgone");
    const { proc } = await startJob(ctx, root);
    proc.status = "completed";
    proc.exitCode = 0;
    proc.resolveDone();
    await settledTick();
    const [record] = ctx.jobs.list();
    assert.ok(record);
    // 模拟另一个 apply 的历史裁剪先把它移走了（侧表里还留着，注册表里已经没了）
    ctx.jobs.remove(record.id);
    for (const dispose of ctx.effectDisposers) {
      dispose();
    }
    assert.equal(proc.killCount, 1, "记录没了也要把进程收掉");
  });

  it("controller 只挂在 start 那一瞬：本包起完就摘，不给别的 caller 留大门", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("gate");
    const spec = {
      kind: JOB_KIND as "zvec-grep-rebuild",
      label: "bare start",
      run: () => ({ cancel: noop, done: Promise.resolve({ status: "completed" as const }) }),
    };
    // 未经本包端点、也没有任何 controller 的裸 start 必须先被拒（这就是官方那道闸）。
    assert.throws(() => ctx.jobs.start(spec), /no job controller serves this agent/u);
    trackRoot(ctx, root);
    const res = await postRebuild(ctx, root);
    assert.equal(res.statusCode, 200, res.body);
    // 起完之后再裸 start 仍是拒：本包那枚 token 只在 start 期间挂着。
    // 留一枚常驻 token 的后果是"宿主故意没装 job 工具"的组成里，本包替全宿主把 gate
    // 开着——官方契约写的是"生产者不能起一台 owner 收不掉、停不掉的作业"。
    assert.throws(() => ctx.jobs.start(spec), /no job controller serves this agent/u);
  });
});

// ── 行级 config + required 校验 ───────────────────────────────────────────

describe("zvec-grep 行级 config 与 required 校验", () => {
  it("行 config 覆盖 schema 默认，未提供字段保持 schema 默认", async () => {
    // 旧断言盯的是「行 config 合进 BUILTIN_BASE 后交给 settings.register 的 base」。
    // 0.1.7 把这两件事都收走了（底座 = schema 的 .default()，合并 = cordis 装载期），
    // 故这里改盯合并的**效果**：行 config 的值真的走到命令构造那一步。
    const ctx = makeCtx();
    applyTo(ctx, { defaultLimit: 25 });
    ctx.shell.runResults.push(okRun("RESULT"));
    const root = ws("row-limit");
    await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root));
    assert.match(String(ctx.shell.resolveCalls[0]?.command), /--limit 25\b/u, "行 config 生效");
    // 没在行 config 里出现的字段仍取 schema 默认（原 base 那一层的等价迁移）
    assert.deepEqual(ctx.shell.resolveCalls[0]?.env, {
      HF_ENDPOINT: MODELSCOPE_MIRROR,
    });
    assert.equal(typeof ctx.settingsValue["defaultEmbedding"], "string");
  });

  it("行 config 显式 undefined 字段不得掩掉默认；开关按行值走", async () => {
    const ctx = makeCtx();
    const root = ws("row-off");
    // search-first 只在「该工作区已建索引」时才可能拦，故先造一个索引目录
    mkdirSync(path.join(root, ZG_INDEX_DIR));
    applyTo(ctx, { defaultLimit: undefined, enforceSearchFirst: false });
    ctx.shell.runResults.push(okRun("RESULT"));
    await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root));
    assert.match(
      String(ctx.shell.resolveCalls[0]?.command),
      /--limit 10\b/u,
      "显式 undefined 不覆盖默认",
    );
    assert.equal(
      guardOf(ctx)({
        name: "bash",
        arguments: { command: "grep -rn foo src" },
        agent: { session: { id: "sess-1", header: { cwd: root } } },
      }),
      undefined,
      "enforceSearchFirst=false 走行 config，门禁关掉",
    );
  });
});

// ── 部署值：超时三项 + stdout 上限走 Config（字段化，默认行为冻结）────────
//
// 官方 config.md:78-92：部署间可能想配不同值的都必须是配置字段。四个值此前是写死
// 的常量，现在进 Config schema（非 volatile：不占设置卡，行 config 是唯一改值入口）。
// 这里钉两条链：前台三工具的 resolve 请求（timeoutMs/stdoutMaxBytes）与后台重建
// （stdoutMaxBytes + kill 定时器时长），默认与行 config 覆盖两个方向都要走到。
describe("部署值：超时与 stdout 上限走 Config", () => {
  it("三工具前台 resolve 带各自的默认超时与 stdout 上限（默认 = 原常量同值）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("w4-default");
    ctx.shell.runResults.push(okRun("S"), okRun("I"), okRun("T"));
    await toolOf(ctx, "zg_search").execute({ root, query: "q" }, execOf(root));
    await toolOf(ctx, "zg_index").execute({ root, confirm: true }, execOf(root));
    await toolOf(ctx, "zg_status").execute({ root }, execOf(root));
    // 各工具的超时按身种分档：search 5min（--refresh wait）> index 10min > status 60s。
    assert.deepEqual(
      ctx.shell.resolveCalls.map((call) => call.timeoutMs),
      [5 * 60_000, 10 * 60_000, 60_000],
    );
    for (const call of ctx.shell.resolveCalls) {
      assert.equal(call.stdoutMaxBytes, 400_000, "前台 stdout 上限默认 400k");
    }
  });

  it("行 config 覆盖：前台请求与截断说明文案都按行值走", async () => {
    const ctx = makeCtx();
    applyTo(ctx, {
      searchTimeoutMs: 1234,
      statusTimeoutMs: 2345,
      indexTimeoutMs: 3456,
      stdoutMaxBytes: 4567,
    });
    const root = ws("w4-row");
    ctx.shell.runResults.push(
      { exitCode: 0, stdout: { text: "PART", truncated: true }, stderr: { text: "" } },
      okRun("I"),
      okRun("T"),
    );
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "q" }, execOf(root))) as {
      text: string;
    };
    await toolOf(ctx, "zg_index").execute({ root, confirm: true }, execOf(root));
    await toolOf(ctx, "zg_status").execute({ root }, execOf(root));
    assert.deepEqual(
      ctx.shell.resolveCalls.map((call) => call.timeoutMs),
      [1234, 3456, 2345],
      "search/index/status 各自读自己的部署字段",
    );
    for (const call of ctx.shell.resolveCalls) {
      assert.equal(call.stdoutMaxBytes, 4567);
    }
    // 截断说明报的是**配置值**而不是写死的 400k（报数失真 = 模型按错的余量规划检索）。
    assert.ok(out.text.includes("4567"), out.text);
  });

  it("行 config 覆盖：后台重建的 stdout 上限与 kill 定时器时长也按行值走", async () => {
    const ctx = makeCtx();
    applyTo(ctx, { indexTimeoutMs: 7 * 60_000, stdoutMaxBytes: 654_321 });
    const root = ws("w4-rebuild");
    const { jobId } = await startJob(ctx, root);
    const spec = ctx.shell.startCalls.at(-1);
    assert.equal(spec?.stdoutMaxBytes, 654_321, "后台执行器缓冲上限走同一字段");
    assert.equal(ctx.timerCalls.at(-1)?.ms, 7 * 60_000, "kill 定时器走同一字段");
    await settleRebuilds(ctx, 0);
    await expectStatus(ctx, jobId, 200);
  });
});

// ── 索引探测的按目录缓存（guard 每次调用至多 9 层 existsSync → 命中后 0 次）──
//
// 缓存实例在 apply 闭包里，工集成路径不可见 existsSync 次数；工厂是导出面，用注入的
// 计数桩 + 时钟把命中/TTL 过期/LRU 触摸与淘汰逐分支钉死。失效策略（TTL 60s）的选型
// 论证在 host.ts 的 createIndexProbeCache 注释里。
describe("索引探测缓存 createIndexProbeCache", () => {
  it("命中：同一目录反复探测只真探一次，结果原样透传", () => {
    const probed: string[] = [];
    const probe = (dir: string): boolean => {
      probed.push(dir);
      return dir === "/repo";
    };
    // 时钟冻结：排除 TTL 干扰，只看命中。
    const cached = createIndexProbeCache(probe, () => 1000);
    assert.equal(cached("/repo"), true);
    assert.equal(cached("/repo"), true);
    assert.equal(cached("/other"), false);
    assert.equal(cached("/repo"), true);
    assert.equal(cached("/other"), false);
    assert.deepEqual(probed, ["/repo", "/other"], "同目录第二次起全走缓存");
  });

  it("TTL 过期：推进时钟越过 INDEX_PROBE_TTL_MS 后重新真探（负向条目的陈旧上界）", () => {
    let indexed = false;
    let clock = 1000;
    const probed: string[] = [];
    const cached = createIndexProbeCache(
      (dir) => {
        probed.push(dir);
        return indexed;
      },
      () => clock,
    );
    assert.equal(cached("/repo"), false, "索引还没建：负向结果");
    indexed = true;
    clock += INDEX_PROBE_TTL_MS - 1;
    assert.equal(cached("/repo"), false, "TTL 内仍是旧答案（纯性能优化的代价上界）");
    clock += 1;
    assert.equal(cached("/repo"), true, "TTL 一过即见新索引（60s 内门禁恢复）");
    assert.deepEqual(probed, ["/repo", "/repo"]);
  });

  it("LRU：容量有界，超限淘汰最旧；命中即触摸，被用过的条目活得最久", () => {
    const probed: string[] = [];
    // 时钟冻结 ⇒ 无 TTL 干扰；容量压到 2 让淘汰这一臂真的走到。
    const cached = createIndexProbeCache(
      (dir) => {
        probed.push(dir);
        return true;
      },
      () => 1000,
      INDEX_PROBE_TTL_MS,
      2,
    );
    // 逐击 trace（册 = Map 的插入序）：
    //   /a → probe，册 [a]；/b → probe，册 [a,b]；/a → 命中触摸，册 [b,a]；
    //   /c → probe 满员淘汰 /b，册 [a,c]；/b → 已被淘汰 ⇒ 真探、淘汰 /a，册 [c,b]；
    //   /c → 命中触摸，册 [b,c]；/a → 早已被淘汰 ⇒ 真探。
    assert.equal(cached("/a"), true);
    assert.equal(cached("/b"), true);
    assert.equal(cached("/a"), true);
    assert.equal(cached("/c"), true);
    assert.equal(cached("/b"), true);
    assert.equal(cached("/c"), true);
    assert.equal(cached("/a"), true);
    assert.deepEqual(
      probed,
      ["/a", "/b", "/c", "/b", "/a"],
      "第 4 击淘汰的是最旧的 /b 而非刚被触摸的 /a（LRU 而非 FIFO）",
    );
  });

  it("默认参数臂：不传时钟/时长/容量时用 Date.now + 60s + 32 条（生产接线形态）", () => {
    const probed: string[] = [];
    const cached = createIndexProbeCache((dir) => {
      probed.push(dir);
      return false;
    });
    assert.equal(cached("/x"), false);
    assert.equal(cached("/x"), false);
    assert.deepEqual(probed, ["/x"], "默认时钟下同目录第二击命中缓存");
    assert.equal(INDEX_PROBE_TTL_MS, 60_000, "默认 TTL 冻结为 60s（负向陈旧上界）");
    assert.equal(INDEX_PROBE_CACHE_MAX, 32, "默认容量冻结为 32 条");
  });
});

// ── 工具 render 全性（官方要求 total、must not throw）─────────────────────

function renderOf(
  ctx: MockCtx,
  name: string,
): (_args: unknown, value: unknown) => { type: string; text: string }[] {
  const tool = toolOf(ctx, name);
  const withOutput = tool as unknown as {
    output: { render: (_args: unknown, value: unknown) => { type: string; text: string }[] };
  };
  return withOutput.output.render;
}

describe("工具 render 全性", () => {
  it("循环引用不抛错，降级为 String(value)", () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const circular: Record<string, unknown> = { text: undefined };
    circular["self"] = circular;
    for (const name of ["zg_search", "zg_index", "zg_status"]) {
      const blocks = renderOf(ctx, name)({}, circular);
      assert.equal(blocks.length, 1);
      assert.ok(typeof blocks[0]?.text === "string" && blocks[0].text.length > 0);
    }
  });

  it("BigInt / undefined / 非对象都能渲染", () => {
    const ctx = makeCtx();
    applyTo(ctx);
    for (const value of [{ num: 42n }, undefined, "plain", 7]) {
      const blocks = renderOf(ctx, "zg_search")({}, value);
      assert.equal(blocks.length, 1);
      assert.ok((blocks[0]?.text ?? "").length > 0);
    }
  });

  it("JSON.stringify 与 String() 都会抛的极端值 → 占位文本", () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const nasty = {
      toJSON(): string {
        throw new Error("no toJSON");
      },
      toString(): string {
        throw new Error("no toString");
      },
    };
    const blocks = renderOf(ctx, "zg_search")({}, nasty);
    assert.equal(blocks[0]?.text, "[unrenderable value]");
  });

  it("{ text } 透传保持不变", () => {
    const ctx = makeCtx();
    applyTo(ctx);
    assert.deepEqual(renderOf(ctx, "zg_search")({}, { text: "hi" }), [
      { type: "text", text: "hi" },
    ]);
  });
});

// ── search-first 门禁 ─────────────────────────────────────────────────────
// 工作区已建 zg 索引时，bash/pwsh 的 grep/rg 与原生 grep 工具在成功 zg_search
// 一次之前会被拒绝。索引目录用真实 fs 临时目录（existsSync 真实路径）。

describe("search-first 门禁", () => {
  let ctx: MockCtx;
  let tmp: string;

  function setup(settings?: Record<string, unknown>): (exec: GuardExec) => string | undefined {
    tmp = mkdtempSync(path.join(tmpdir(), "zvec-grep-gate-"));
    createdDirs.push(tmp);
    mkdirSync(path.join(tmp, ZG_INDEX_DIR));
    ctx = makeCtx();
    if (settings) {
      Object.assign(ctx.settingsValue, settings);
    }
    applyTo(ctx);
    return guardOf(ctx);
  }

  const agent = (
    id: string | number = "sess-1",
  ): {
    session: { id: string | number; header: { cwd: string } };
  } => ({ session: { id, header: { cwd: tmp } } });

  const searchTool = (): CapturedTool => toolOf(ctx, "zg_search");

  it("bash grep/rg 未 zg_search 前被拒，消息含索引根与出路", () => {
    const guard = setup();
    const reason = guard({
      name: "bash",
      arguments: { command: "grep -rn foo src" },
      agent: agent(),
    });
    if (reason === undefined) {
      assert.fail("expected search-first 拦截 reason");
    }
    assert.ok(reason.includes("zg_search"));
    assert.ok(reason.includes(tmp));
    assert.notEqual(
      guard({ name: "bash", arguments: { command: "cat a | rg pattern" }, agent: agent() }),
      undefined,
    );
  });

  it("bash 非 grep 命令放行；探测形态（which rg）放行", () => {
    const guard = setup();
    assert.equal(
      guard({ name: "bash", arguments: { command: "ls -la && npm test" }, agent: agent() }),
      undefined,
    );
    assert.equal(
      guard({ name: "bash", arguments: { command: "which rg" }, agent: agent() }),
      undefined,
    );
    assert.equal(
      guard({ name: "bash", arguments: { command: "rg --version" }, agent: agent() }),
      undefined,
    );
  });

  it("bash command 非字符串 → 不算检索（放行）", () => {
    const guard = setup();
    assert.equal(
      guard({ name: "bash", arguments: { command: { nested: true } }, agent: agent() }),
      undefined,
    );
  });

  it("原生 grep 工具同样拦截；path 指向工作区外放行", () => {
    const guard = setup();
    assert.notEqual(
      guard({ name: "grep", arguments: { pattern: "foo" }, agent: agent() }),
      undefined,
    );
    assert.equal(
      guard({
        name: "grep",
        arguments: { pattern: "foo", path: "/tmp/elsewhere" },
        agent: agent(),
      }),
      undefined,
    );
    // path 非字符串按「缺省=搜整个工作区」处理 → 仍拦
    assert.notEqual(
      guard({ name: "grep", arguments: { pattern: "foo", path: 42 }, agent: agent() }),
      undefined,
    );
  });

  it("bash grep 目标指向索引根之外（绝对路径）→ 放行（误拦回归）", () => {
    const guard = setup();
    assert.equal(
      guard({ name: "bash", arguments: { command: "grep foo /tmp/elsewhere" }, agent: agent() }),
      undefined,
    );
  });

  it("无会话工作区 / 非 bash 工具 → 放行", () => {
    const guard = setup();
    assert.equal(guard({ name: "bash", arguments: { command: "grep foo" } }), undefined);
    assert.equal(
      guard({ name: "read", arguments: {}, agent: { session: { header: { cwd: "" } } } }),
      undefined,
    );
  });

  it("zg_search 执行成功后解锁本会话，其它会话仍拦截", async () => {
    const guard = setup();
    ctx.shell.runResults.push(okRun("HITS"));
    await searchTool().execute({ root: tmp, query: "路由是怎么走的" }, execOf(tmp));
    assert.equal(
      guard({ name: "bash", arguments: { command: "grep foo" }, agent: agent() }),
      undefined,
    );
    assert.notEqual(
      guard({ name: "bash", arguments: { command: "grep foo" }, agent: agent("sess-2") }),
      undefined,
    );
  });

  it("无索引的 root：zg_search 成功也不发放解锁", async () => {
    const guard = setup();
    const plain = mkdtempSync(path.join(tmpdir(), "zvec-grep-plain-"));
    createdDirs.push(plain);
    ctx.shell.runResults.push(okRun("HITS"));
    await searchTool().execute({ root: plain, query: "x" }, execOf(plain));
    const reason = guard({
      name: "bash",
      arguments: { command: "grep foo" },
      agent: { session: { id: "sess-plain", header: { cwd: plain } } },
    });
    assert.equal(reason, undefined, "无索引工作区不受门禁约束");
    assert.equal(existsSync(path.join(plain, ZG_INDEX_DIR)), false);
  });

  it("配额+时效：解锁次数耗尽后再拦，重新 zg_search 重置配额", async () => {
    const guard = setup({ grepBudgetPerSearch: 1 });
    ctx.shell.runResults.push(okRun("HITS"));
    await searchTool().execute({ root: tmp, query: "主题 A" }, execOf(tmp));
    assert.equal(
      guard({ name: "bash", arguments: { command: "grep topicA" }, agent: agent() }),
      undefined,
    );
    const reason = guard({ name: "bash", arguments: { command: "grep topicB" }, agent: agent() });
    // 可选链 + 与 true 显式比较（strict-boolean-expressions 不吃 `boolean | undefined`）：
    // 判据与旧的 `reason !== undefined && reason.includes(...)` 逐字等价。
    assert.equal(reason?.includes("配额已用尽"), true);
    ctx.shell.runResults.push(okRun("HITS"));
    await searchTool().execute({ root: tmp, query: "主题 B" }, execOf(tmp));
    assert.equal(
      guard({ name: "bash", arguments: { command: "grep topicB" }, agent: agent() }),
      undefined,
    );
  });

  it("解锁过期 → 再拦，并说明是「过期」而非「未检索」", async () => {
    // unlockWindowMin 为负 = 发放即过期（真实路径由时钟推进，这里直接注入等价事实）
    const guard = setup({ unlockWindowMin: -5 });
    ctx.shell.runResults.push(okRun("HITS"));
    await searchTool().execute({ root: tmp, query: "x" }, execOf(tmp));
    const reason = guard({ name: "bash", arguments: { command: "grep foo" }, agent: agent() });
    if (reason === undefined) {
      assert.fail("expected 过期拦截");
    }
    assert.ok(reason.includes("已过期"), reason);
    assert.ok(reason.includes(tmp), "出路消息要点名索引根");
  });

  it("zg_search 失败不解锁（必须成功一次）", async () => {
    const guard = setup();
    ctx.shell.runResults.push({
      exitCode: 1,
      stdout: { text: "", truncated: false },
      stderr: { text: "boom", truncated: false },
    });
    await assert.rejects(() => searchTool().execute({ root: tmp, query: "x" }, execOf(tmp)));
    assert.notEqual(
      guard({ name: "bash", arguments: { command: "grep foo" }, agent: agent() }),
      undefined,
    );
  });

  it("无索引目录不拦（真实 existsSync）", () => {
    const guard = setup();
    const plain = mkdtempSync(path.join(tmpdir(), "zvec-grep-plain-"));
    createdDirs.push(plain);
    assert.equal(
      guard({
        name: "bash",
        arguments: { command: "grep foo" },
        agent: { session: { id: "sess-1", header: { cwd: plain } } },
      }),
      undefined,
    );
    assert.equal(existsSync(path.join(plain, ZG_INDEX_DIR)), false);
  });

  it("会话工作区是索引根子目录时命中祖先索引", () => {
    const guard = setup();
    const sub = path.join(tmp, "packages", "app");
    mkdirSync(sub, { recursive: true });
    assert.notEqual(
      guard({
        name: "bash",
        arguments: { command: "grep foo" },
        agent: { session: { id: "sess-1", header: { cwd: sub } } },
      }),
      undefined,
    );
  });

  it("数字 session id 与非安全数字都能分片", async () => {
    const guard = setup();
    ctx.shell.runResults.push(okRun("HITS"));
    await searchTool().execute({ root: tmp, query: "x" }, execOf(tmp, 7));
    assert.equal(
      guard({ name: "bash", arguments: { command: "grep foo" }, agent: agent(7) }),
      undefined,
    );
    assert.notEqual(
      guard({ name: "bash", arguments: { command: "grep foo" }, agent: agent(Number.NaN) }),
      undefined,
    );
    assert.notEqual(
      guard({ name: "bash", arguments: { command: "grep foo" }, agent: agent("") }),
      undefined,
    );
  });

  it("解锁会话数有界（256 个会话后淘汰最早的）", async () => {
    const guard = setup();
    const firstKey = "sess-first";
    ctx.shell.runResults.push(okRun("HITS"));
    await searchTool().execute({ root: tmp, query: "x" }, execOf(tmp, firstKey));
    assert.equal(
      guard({ name: "bash", arguments: { command: "grep foo" }, agent: agent(firstKey) }),
      undefined,
    );
    const bulk = Array.from({ length: 256 }, (_unused, index) =>
      searchTool().execute({ root: tmp, query: "x" }, execOf(tmp, `bulk-${String(index)}`)),
    );
    await Promise.all(bulk);
    assert.notEqual(
      guard({ name: "bash", arguments: { command: "grep foo" }, agent: agent(firstKey) }),
      undefined,
      "最早的会话应已被淘汰",
    );
  });

  it("enforceSearchFirst=false 关闭门禁", () => {
    const guard = setup({ enforceSearchFirst: false });
    assert.equal(
      guard({ name: "bash", arguments: { command: "grep foo" }, agent: agent() }),
      undefined,
    );
    assert.equal(guard({ name: "grep", arguments: { pattern: "foo" }, agent: agent() }), undefined);
  });

  it("宿主交回空引用（退化）时门禁仍开启：fail-closed", () => {
    // 0.1.7 的默认值住在 schema 的 .default()，正常装载下 enforceSearchFirst 恒为
    // boolean。这里刻意把 volatile 引用背后的值清空（= 条目没被投影 / 宿主退化），
    // 锁死「读不到」不等于「用户关了门禁」——静默放行检索顺序违规才是更坏的失败。
    tmp = mkdtempSync(path.join(tmpdir(), "zvec-grep-gate-empty-"));
    createdDirs.push(tmp);
    mkdirSync(path.join(tmp, ZG_INDEX_DIR));
    ctx = makeCtx();
    ctx.settingsValue = {};
    applyTo(ctx);
    assert.notEqual(
      guardOf(ctx)({ name: "bash", arguments: { command: "grep foo" }, agent: agent() }),
      undefined,
      "空引用不得被当成「关掉门禁」",
    );
  });

  it("组合顺序：zg_* 安全兜底不受影响（zg_index 缺 confirm 仍拒）", () => {
    const guard = setup();
    assert.notEqual(guard({ name: "zg_index", arguments: { root: "/ws" } }), undefined);
    assert.equal(guard({ name: "zg_search", arguments: { root: "/ws" } }), undefined);
  });
});

// ── 文案双语（与官方 dsh-client-locale 的 settings 偏好同源）───────────────
// host 侧没有官方 i18n 面：工具描述、参数说明、执行回显、guard 拒绝理由与端点
// 错误全自带字典（lib/messages.ts），语言只读官方 locale 命名空间的 preference。
// 见 lib/locale.ts 的契约：读不到（没装 locale 插件）即中文默认。

describe("host 侧文案双语", () => {
  it("locale 命名空间未注册 → 中文默认，且不抛", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const search = toolOf(ctx, "zg_search");
    assert.ok(search.description.includes("语义/混合检索"), "中文工具描述");
    assert.match(ctx.sections[0]?.text ?? "", /zg 规则/u, "中文规则段");
    await assert.rejects(
      () => search.execute({ root: "/nope/missing-workspace", query: "x" }, execOf()),
      /root 目录不存在/u,
    );
  });

  it("偏好 en-US：工具描述与全部参数说明换成英文，不残留中文", async () => {
    const ctx = makeCtx();
    ctx.localeDocument = { preference: "en-US" };
    applyTo(ctx);
    const search = toolOf(ctx, "zg_search");
    assert.ok(search.description.includes("Semantic/hybrid search"), "英文工具描述");
    assert.doesNotMatch(JSON.stringify(search.parameters), /[\u4E00-\u9FFF]/u);
    const properties = search.parameters["properties"] as Record<string, { description: string }>;
    assert.match(properties["root"]?.description ?? "", /Absolute workspace path/u);
    assert.match(ctx.sections[0]?.text ?? "", /must call zg_search first/u);
    await assert.rejects(
      () => search.execute({ root: "/nope/missing-workspace", query: "x" }, execOf()),
      /does not exist/u,
    );
  });

  it("偏好 en：执行回显、guard 拒绝理由与端点错误同为英文", async () => {
    const ctx = makeCtx();
    ctx.localeDocument = { preference: "en" };
    applyTo(ctx);
    const root = ws("en-text");
    ctx.shell.runResults.push({
      exitCode: 127,
      stdout: { text: ZG_NOT_INSTALLED },
      stderr: { text: "" },
    });
    await assert.rejects(
      () => toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root)),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /is not installed or not on PATH/u);
        assert.doesNotMatch(message, /[\u4E00-\u9FFF]/u, "英文回显不得混进中文");
        return true;
      },
    );
    const reason = guardOf(ctx)({ name: "zg_index", arguments: { root: "/ws" } });
    assert.match(reason ?? "", /requires an explicit user request/u);
    const res = makeRes();
    await routeOf(ctx, REBUILD_STATUS_PATH).handler(
      makeReq({ method: "GET", url: `${REBUILD_STATUS_PATH}?jobId=zvec-grep-rebuild-9` }),
      res,
    );
    assert.equal(res.statusCode, 404);
    assert.match(res.body, /left the history window/u);
  });
});

// ── 0.1.7 隐式注册验收：volatileForm(Config) 的字段集 = 设置卡的可编辑字段集 ──
//
// 为什么单独要这一条：0.1.7 的命名空间与可编辑字段都是**从 schema 反推**的，
// 漏写一个 `.volatile()` 不会报错，只会让那一项从设置卡上**静默消失**（宿主的
// describe 只投影 volatileForm 的结果）；全漏则整条被跳过（settings/index.ts:308-309）、
// 写入抛 `has no volatile fields`（:386）。这类退化在本包其它用例里全绿（读侧照用
// schema 默认值），只有拿宿主同一个判据回头看 schema 才拦得住。
//
// ⚠ 它能拦住：字段级 volatile 漏标/多标、字段名漂移、条目 id 与 schema 不同源。
// 它**拦不住**的（仍靠真实宿主启动或人工核对）：profile 里实际装配出来的条目 id
// （本包 cordis.patch.yml 只是它的来源），以及"cordis 真把这份 Config 挂上了 runtime"。
describe("0.1.7 隐式注册验收", () => {
  /** zvec-grep 条目该能编辑的六项（全是实时项，一个都不该漏）。 */
  const EDITABLE = [
    "defaultEmbedding",
    "defaultLimit",
    "enforceSearchFirst",
    "grepBudgetPerSearch",
    "hfEndpoint",
    "unlockWindowMin",
  ];

  it("volatileForm(Config) 的字段集恰为 zvec-grep 条目的六项可编辑字段", () => {
    // 命名空间 = 本包 cordis.patch.yml 的裸条目 id（0.1.7 隐式注册取的就是它）。
    assert.equal(patchEntryId(), "zvec-grep");
    const form = volatileFormOf(plugin.Config as unknown as SchemaNode);
    assert.ok(form !== null, "没有任何 volatile 字段 → 宿主 describe() 整条跳过本条目");
    assert.deepEqual(form.toSorted(), EDITABLE, "投影字段集与设置卡预期可编辑项不一致");
  });

  it("schema 字段全集 = 投影可编辑六项 + 四项非 volatile 部署值（W4）", () => {
    // 部署值（超时三项 + stdout 上限）不该标 volatile：标了会挤上设置卡。这里拿
    // schema 的字段全集对照两个期望清单，新增字段漏改期望时先红（ctx-observe 同款）。
    assert.deepEqual(
      Object.keys(configDict()).toSorted(),
      [
        ...EDITABLE,
        "searchTimeoutMs",
        "statusTimeoutMs",
        "indexTimeoutMs",
        "stdoutMaxBytes",
      ].toSorted(),
    );
  });
});

/** 本机网卡上的非回环 IPv4：`shared/lib/trust.ts:120-129` 只认"确属本机网卡"的那批地址。
 *  取不到就响亮失败而不是跳过——这条用例是本包唯一把 `servingNonLoopback` 拨到 **true** 的
 *  接线（替身没有 `host` 成员时，那道锁在真实接线上永为合着）。 */
function lanIpv4(): string {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) {
        return info.address;
      }
    }
  }
  throw new Error("这台机器上没有非回环 IPv4 网卡地址：非回环服务面的接线用例无法构造");
}

describe("信任闸门：/_dsh/zvec-grep/* 的三条路由", () => {
  // 文件级临时目录回收：require-top-level-describe 不许 hook 裸在文件根，而只含 hook 的
  // describe 会被 vitest 判 "No test found in suite" ⇒ 挂在本文件最后一套套件上（套件按
  // 声明顺序串行跑，触发时刻与原来的文件根 afterAll 相同）。新增顶层套件要排在其后，否则
  // 新套件建的临时目录没人收（rmSync 带 force，漏收只留目录，不改用例结论）。
  afterAll(() => {
    for (const dir of createdDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    createdDirs.length = 0;
  });

  /** DNS 重绑定：Host 外域而 sec-fetch-site 与 Origin 自洽 ⇒ 只有 Host 腿拒得了。 */
  const REBINDING: Record<string, string> = {
    host: "evil.test:8787",
    origin: "http://evil.test:8787",
    "sec-fetch-site": "same-origin",
  };

  it("引导端点（发 token 的那条 GET）被重绑定 ⇒ 403，且体里不许带出 csrf", () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const res = makeRes();
    void routeOf(ctx, REBUILD_ROOTS_PATH).handler(
      makeReq({ method: "GET", url: REBUILD_ROOTS_PATH, headers: REBINDING }),
      res,
    );
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /untrusted host/u);
    assert.doesNotMatch(res.body, /csrf/u, "被拒的响应体里泄露 token 等于闸门白装");
  });

  it("servingNonLoopback 是**接**出来的：只有 webServer.host 声明 0.0.0.0 才放本机网卡权威", () => {
    // 钉的是 host.ts 那一行的接线（`webServer.host === "0.0.0.0"` ⇒ 喂给 guardTrust），不是
    // trust 的纯函数判据（那份在 shared/test/trust.test.ts 里已经钉过，包括读真网卡的缺省臂）。
    // 把 `===` 改成 `!==`、或整条删掉写死 false，下面两个断言会一起反掉 ⇒ 变异跑不掉。
    const lan = `${lanIpv4()}:8787`;
    const headers = { host: lan, origin: `http://${lan}`, "sec-fetch-site": "same-origin" };
    // 替身没声明服务面 ⇒ 非回环权威一律拒（"宿主只绑回环"的常态）。
    const loopbackOnly = makeCtx();
    applyTo(loopbackOnly);
    const refused = makeRes();
    void routeOf(loopbackOnly, REBUILD_ROOTS_PATH).handler(
      makeReq({ method: "GET", url: REBUILD_ROOTS_PATH, headers }),
      refused,
    );
    assert.equal(refused.statusCode, 403);
    assert.match(refused.body, /untrusted host/u);
    // 声明绑了 0.0.0.0 ⇒ 同一个请求过闸门，token 照旧交给卡片。
    const bound = makeCtx();
    bound.webServerHost = "0.0.0.0";
    applyTo(bound);
    const allowed = makeRes();
    void routeOf(bound, REBUILD_ROOTS_PATH).handler(
      makeReq({ method: "GET", url: REBUILD_ROOTS_PATH, headers }),
      allowed,
    );
    assert.equal(allowed.statusCode, 200);
    assert.match(allowed.body, /csrf/u, "过闸的应答该照旧把 token 交给卡片");
  });

  it("写端点 rebuild：恶意 Host 即便带对 token 也在权威那一层被拒", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const { csrf } = fetchAccess(ctx);
    const res = makeRes();
    await routeOf(ctx, REBUILD_PATH).handler(
      makeReq({
        method: "POST",
        url: REBUILD_PATH,
        headers: { ...REBINDING, "x-zvec-grep-csrf": csrf },
        chunks: [JSON.stringify({ root: "/tmp/definitely-not-a-workspace" })],
      }),
      res,
    );
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /untrusted host/u);
  });

  it("判据次序：恶意 Host 与 cross-site 同现时报 Host 腿那句", () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const res = makeRes();
    void routeOf(ctx, REBUILD_ROOTS_PATH).handler(
      makeReq({
        method: "GET",
        url: REBUILD_ROOTS_PATH,
        headers: { host: "evil.test:8787", "sec-fetch-site": SEC_FETCH_CROSS_SITE },
      }),
      res,
    );
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /untrusted host/u);
  });

  it("缺 Host（本地 CLI 与全部既有手搓用例的常态）⇒ 闸门不插手，token 照常下发", () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const access = fetchAccess(ctx);
    assert.equal(typeof access.csrf, "string");
    assert.equal(typeof access.csrf, "string");
    assert.ok(access.csrf.length >= 36, "uuid 形态的 token（形状由上面那条针钉死）");
  });

  it("回环 Host + 异源 Origin ⇒ 拒（这条与 Host 腿无关，钉的是 Origin 腿还在）", () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const res = makeRes();
    void routeOf(ctx, REBUILD_ROOTS_PATH).handler(
      makeReq({
        method: "GET",
        url: REBUILD_ROOTS_PATH,
        headers: { host: "127.0.0.1:8787", origin: "http://evil.test:8787" },
      }),
      res,
    );
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /cross-origin/u);
  });
});
