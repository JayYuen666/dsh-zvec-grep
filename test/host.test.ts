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
import { describe, it, beforeAll, afterAll, vi } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
// 命名导入：缓存工厂是导出面（单测直接钉命中/TTL/LRU 行为，不必经 fs 间接观测）。
import plugin, {
  createIndexProbeCache,
  createRootLedger,
  hitSummary,
  signalStderr,
  INDEX_PROBE_CACHE_MAX,
  INDEX_PROBE_TTL_MS,
} from "../host.ts";
import { DEFAULT_EMBEDDING } from "../lib/embedding-catalog.ts";
import { MESSAGES, fill } from "../lib/messages.ts";
import { MINIMUM_ZG_VERSION } from "../lib/zg-version.ts";
import { SECRET_EXCLUDE_GLOBS } from "../lib/argv-guard.ts";

// 默认密钥排除的命令行形态（由 lib/argv-guard.ts 单一来源派生，避免两处硬编码漂移）。
// 旗标是 --iglob 而非 --glob：大小写不敏感、且排在用户 iglob 之后，理由见 lib/cli.ts 的 pushIndexGlobs。
const SECRET_ARGS = SECRET_EXCLUDE_GLOBS.map((globStr) => `--iglob '${globStr}'`).join(" ");

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
 * workspace manifest 文件名（<root>/.zvec-grep/manifest.json）。门禁只在**它也在场**时
 * 才认这个工作区建过索引——`.zvec-grep` 这个名字同时是 zg 全局 home 的目录名，只判目录
 * 会把祖先撞名的普通工作区误判成已建索引。同值独立抄一份，理由同上。
 */
const ZG_MANIFEST_FILE = "manifest.json";

/** 版本门槛的探测命令（字面量与 host.ts 的 probeZgVersion 同源，改一处两边都红）。 */
const ZG_VERSION_COMMAND = "zg --version";
/** 健康的本机 zg：恰好等于门槛值，故默认放行（实机 stdout 就是这一行 + 换行）。 */
const ZG_VERSION_OK = `${MINIMUM_ZG_VERSION}\n`;

/** 一次健康的版本探测执行（stdout 只有版本号一行，实测形态）。 */
function versionOkRun(): ShellRunResult {
  return { exitCode: 0, stdout: { text: ZG_VERSION_OK }, stderr: { text: "" } };
}

/** 一次「探到太老的 zg」的执行：退出 0、stdout 是那个旧版本号。 */
function oldVersionRun(version: string): ShellRunResult {
  return { exitCode: 0, stdout: { text: `${version}\n` }, stderr: { text: "" } };
}

/** 本组反复用到的三个字面量：远程引用、端点、凭据所在环境变量名。 */
const REMOTE_EMBEDDING = "qwen/text-embedding-v4";
const REMOTE_ENDPOINT = "https://api.example.com/v1";
const EMBED_KEY_ENV = "ZGTEST_EMBED_KEY";
/** 凭据的字面值（一次性测试夹具，不是任何真实凭据）。 */
const FAKE_KEY = "sk-forwarded";

/**
 * 临时设一个环境变量，交回还原函数。
 * 还原走 Reflect.deleteProperty 而不是 `delete env[name]`：后者是动态键删除
 * （本仓 lint 明令禁止），而前者正是官方 scrubbedParentEnv 清理同名变量的写法。
 */
function withEnv(name: string, value: string): () => void {
  process.env[name] = value;
  return () => {
    Reflect.deleteProperty(process.env, name);
  };
}

/** 在 root 下造出一个「真建过索引」的索引库（目录 + manifest）。 */
/**
 * 在 root 下造出一个「真建过索引」的索引库（目录 + 清单）。
 *
 * 清单按**真实** workspace manifest 的形状写（实测上游形状），且 `rootPaths` 真的指回这个
 * root：探测判据现在要校验清单结构与根路径覆盖，`{}` 那种占位会被判成「这不是一份索引」，
 * 于是所有依赖「已建索引」前提的用例都会掉进穷举通道。
 */
function makeIndexed(root: string): void {
  mkdirSync(path.join(root, ZG_INDEX_DIR), { recursive: true });
  writeFileSync(
    path.join(root, ZG_INDEX_DIR, ZG_MANIFEST_FILE),
    `${JSON.stringify({
      manifestVersion: 1,
      path: path.join(root, ZG_INDEX_DIR),
      rootPaths: [{ absolutePath: root, recursive: true }],
    })}\n`,
  );
}
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
  // header 的形状与官方 SessionHeader 对齐到本包真读的那两位：cwd（会话工作区）与
  // parentSession（子代理挂在谁下面，配额按根会话分片要用）。
  agent?: {
    session?: { id?: unknown; header?: { cwd?: unknown; parentSession?: unknown } };
  } | null;
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
  /**
   * 版本门槛探测（`zg --version`）的请求单。**刻意不排进 resolveCalls**：那是各用例断言
   * 命令形态（命令文本/workdir/env）的地方，把基础设施探测混进去会让这些断言被一次
   * 与被测行为无关的调用顶掉。单独记账，断言探测行为时看这里。
   */
  versionProbeCalls: ResolveRequest[];
  /** 版本探测这一次执行要交回的结果；undefined = 健康的本机 zg（门槛值本身）。 */
  zgVersionResult: ShellRunResult | undefined;
  /** 版本探测这一次执行直接抛错（模拟执行器缺席/spawn 失败）：同样必须按「读不懂」放行。 */
  versionProbeThrows: boolean;
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
  /** 官方会话存储的活会话表：`id -> 它的父会话 id`（无父不出现在表里）。 */
  sessionLinks: Record<string, string>;
  /** true ⇒ ctx.get("sessions") 交不出会话存储（宿主没装 dsh-session 的那一档）。 */
  noSessions: boolean;
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
  /** ctx.on(event, handler)：登记事件监听；替身按事件名分桶保存，供 preExecuteOf 串联瀑布。 */
  on: (
    event: string,
    handler: (exec: GuardExec, next: () => Promise<unknown>) => unknown,
  ) => () => void;
  /** 取某个事件名下的监听器（按注册顺序）：preExecuteOf 串联瀑布用。 */
  eventHandlers: (event: string) => ((exec: GuardExec, next: () => Promise<unknown>) => unknown)[];
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
    on: () => noop,
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
  /** ctx.on 登记的事件监听（按事件名分桶）：pre-execute 那道用户确认闸就落在这里。 */
  const eventListeners = new Map<
    string,
    ((exec: GuardExec, next: () => Promise<unknown>) => unknown)[]
  >();
  const shell: ShellMock = {
    resolveCalls: [],
    versionProbeCalls: [],
    zgVersionResult: undefined,
    versionProbeThrows: false,
    runResults: [],
    startCalls: [],
    startedProcs: [],
    startThrows: "none",
    vanishJobsAfterExecute: 0,
    resolve(spec) {
      if (spec.command === ZG_VERSION_COMMAND) {
        shell.versionProbeCalls.push(spec);
      } else {
        shell.resolveCalls.push(spec);
      }
      return spec;
    },
    // 0.1.7：execute 是前后台唯一入口。判据沿用宿主自身的分工——runForeground 必带
    // timeoutMs（deadline），后台 rebuild 不带（shell 契约：后台不应用超时）。
    async execute(rawSpec) {
      // 官方 execute 的入参在替身上是 unknown（官方 abstract Service 的方法面投影），
      // 这里只读两个字段，故先收成最小形状而不是断言成某个具体请求类型。
      const spec = rawSpec as { command: string; timeoutMs?: number };
      const isVersionProbe = spec.command === ZG_VERSION_COMMAND;
      const isBackground = spec.timeoutMs === undefined;
      if (isBackground) {
        if (shell.startThrows === "error") {
          throw new Error("no such executor");
        }
        if (shell.startThrows === "alien") {
          // 跨 realm 抛出的 Error：本域 `instanceof Error` 为 false，走 String() 兜底
          vm.runInNewContext("throw new Error('boom from another realm')");
        }
        shell.startCalls.push(rawSpec as ResolveRequest);
      }
      if (isVersionProbe && shell.versionProbeThrows) {
        throw new Error("no such executor");
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
        // 版本探测**不吃这条队列**：它不是被测命令的结果，是基础设施的一次自检。
        result: async () =>
          isVersionProbe
            ? (shell.zgVersionResult ?? versionOkRun())
            : (shell.runResults.shift() ?? {
                exitCode: 0,
                stdout: { text: "OK" },
                stderr: { text: "" },
              }),
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
    sessionLinks: {},
    noSessions: false,
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
    eventHandlers: (event: string) => eventListeners.get(event) ?? [],
    on(event: string, handler: (exec: GuardExec, next: () => Promise<unknown>) => unknown) {
      const bucket = eventListeners.get(event) ?? [];
      bucket.push(handler);
      eventListeners.set(event, bucket);
      return () => {
        const at = bucket.indexOf(handler);
        if (at !== -1) {
          bucket.splice(at, 1);
        }
      };
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
      if (name === "sessions") {
        // 复刻「宿主没装会话存储」那一档：rootSessionKeyOf 随之退化成「有父用父、无父用自己」。
        // 官方会话存储的最小替身：活会话表 `id -> header.parentSession`。默认空表
        // （等价于「没有子代理」）；要测委派树时用 ctx.sessionLinks 填。
        return ctx.noSessions
          ? undefined
          : {
              list: () =>
                Object.entries(ctx.sessionLinks).map(([id, parent]) => ({
                  id,
                  header: { parentSession: parent },
                })),
            };
      }
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

/** 索引通道的缺省命令行：既有断言反复引用，抽成常量避免三处硬编码漂移。 */
const INDEXED_SEARCH_COMMAND =
  "zg query 'hi' --limit 10 --preview short --refresh wait --device 'auto' --mode auto";

/** 一个真实存在但**没有** zg 索引的目录（穷举检索路径的前提）。 */
function bareWs(name = "bare"): string {
  const created = mkdtempSync(path.join(tmpdir(), `zvec-${name}-`));
  createdDirs.push(created);
  return created;
}

/**
 * 一个真实存在的目录（zg 要求 root 落盘存在）。
 *
 * 默认**已建索引**：检索工具在无索引时会自动改走穷举词法通道（见 host.ts 的
 * pickExhaustive），所以绝大多数用例要的是「有索引」这一前提，否则构造出来的命令形态
 * 与被断言的东西对不上。确需「无索引」工作区时用 bareWs()。
 */
function ws(name = "root"): string {
  const created = bareWs(name);
  makeIndexed(created);
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

/**
 * 跑一次 pre-execute 瀑布：按注册顺序把每个监听器串起来，任一监听器不给 `next()`
 * 就以它的返回值收口。返回的 `allow` 表示整条瀑布放行。
 * 返回 `{ allow: false }` 那一支就是「被问/被拒/被取消」——本包只关心"没放行"。
 */
async function preExecuteOf(
  ctx: MockCtx,
  exec: GuardExec,
): Promise<{ allow: boolean; decision: unknown }> {
  const handlers = ctx.eventHandlers("tools/pre-execute");
  const run = async (index: number): Promise<unknown> => {
    const handler = handlers[index];
    if (handler === undefined) {
      return { kind: "allow" };
    }
    return handler(exec, () => run(index + 1));
  };
  const decision = await run(0);
  const kind = (decision as { kind?: unknown } | undefined)?.kind;
  return { allow: kind === "allow", decision };
}

/** 一个待决 Promise 的结局文本：兑现时给空串，抛错时给错误消息（供并行断言收口）。 */
async function reasonOf(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * 一条最小可路由的 pre-execute 入参：带 agent 才有会话工作区可读。
 * 官方 ToolExecution.arguments 是 unknown，这里按调用点真实形态给。
 */
function askExec(
  name: string,
  root: unknown,
  cwd: string | undefined,
  rawArguments?: unknown,
): GuardExec {
  const { signal } = new AbortController();
  const session = cwd === undefined ? undefined : { id: "s1", header: { cwd } };
  return {
    name,
    arguments: rawArguments ?? (root === undefined ? {} : { root }),
    signal,
    ...(session === undefined ? {} : { agent: { session } }),
  };
}

/** 批量跑若干条 pre-execute，只取「有没有放行」这一位（各条互不相关，可并行）。 */
async function allowVerdicts(
  ctx: MockCtx,
  cases: { name: string; root: unknown; cwd: string | undefined }[],
): Promise<boolean[]> {
  return Promise.all(
    cases.map(async (one): Promise<boolean> => {
      const verdict = await preExecuteOf(ctx, askExec(one.name, one.root, one.cwd));
      return verdict.allow;
    }),
  );
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

describe("zg 版本门槛", () => {
  it("版本够新：放行，且探测不吃命令结果队列", async () => {
    const root = ws();
    const ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("HITS"));
    const out = await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root));
    assert.match((out as { text: string }).text, /^HITS/u);
    assert.equal(ctx.shell.versionProbeCalls.length, 1, "第一次调用探一次版本");
    assert.equal(ctx.shell.versionProbeCalls[0]?.command, ZG_VERSION_COMMAND);
  });

  it("三个工具与后台索引都先过这道门槛（口径只有一处）", async () => {
    const root = ws();
    const ctx = makeCtx();
    ctx.shell.zgVersionResult = oldVersionRun("0.2.1");
    applyTo(ctx);
    // 前台三条 + 工具/卡片共用的后台 spawn：每条都必须在**起 zg 之前**停住。
    await assert.rejects(
      () => toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root)),
      /zg 版本过低/u,
    );
    assert.equal(ctx.shell.resolveCalls.length, 0, "门槛没过就不该发任何 zg 命令");
    await assert.rejects(
      () => toolOf(ctx, "zg_status").execute({ root }, execOf(root)),
      /zg 版本过低/u,
    );
    assert.equal(ctx.shell.resolveCalls.length, 0);
    await assert.rejects(
      () => toolOf(ctx, "zg_index").execute({ root, confirm: true }, execOf(root)),
      /zg 版本过低/u,
    );
    assert.equal(ctx.shell.resolveCalls.length, 0, "前台索引同样没过门槛");
    assert.equal(ctx.shell.startCalls.length, 0);
  });

  it("后台索引（设置卡重建端点那条路）也过门槛：一条 zg 都不起", async () => {
    const root = ws();
    const ctx = makeCtx();
    ctx.shell.zgVersionResult = oldVersionRun("0.2.1");
    applyTo(ctx);
    trackRoot(ctx, root);
    const res = await postRebuild(ctx, root);
    assert.notEqual(res.statusCode, 200, "版本太老时端点不得回答 200");
    // 卡片只看得到响应体，所以可行动的文案必须真的落在 body 里（不是被吞进日志）。
    assert.match(res.body, /zg 版本过低/u, "响应体要带回门槛文案");
    assert.match(res.body, /0\.2\.1/u, "并回显实际版本");
    assert.equal(ctx.shell.startCalls.length, 0, "一条后台 zg 都不该起");
    // 门禁那一侧同样不消费配额：门槛没过就没有「已检索」这回事。
    assert.equal(ctx.shell.startedProcs.length, 0);
  });

  it('分支用的布尔按严格取值读：1 / "true" 静默变 false 是本仓点名要避免的失败', async () => {
    // 参数面声明着 type: "boolean"，但宿主对 parameters 只做注册期的「输出」schema 检查，
    // 入参原样交给 execute —— 框架不替我们兜。所以这三处分支决策必须自己严格取值。
    const root = ws("strictbool");
    const ctx = makeCtx();
    applyTo(ctx);
    const tool = toolOf(ctx, "zg_index");
    const status = toolOf(ctx, "zg_status");
    // 三个分支的调用面：[工具名, 入参, 期望被点名的参数名]。
    const surfaces: [typeof tool, Record<string, unknown>, string][] = [
      [tool, { root, confirm: true, rebuild: null }, "rebuild"],
      [tool, { root, confirm: true, background: null }, "background"],
      [status, { root, checkReady: null }, "checkReady"],
    ];
    const badValues: unknown[] = [1, "true", "yes", {}, []];
    const verdicts = await Promise.all(
      badValues.map(async (bad): Promise<string[]> => {
        const calls = surfaces.map(async ([target, args, name]) =>
          reasonOf(target.execute({ ...args, [name]: bad }, execOf(root))),
        );
        return Promise.all(calls);
      }),
    );
    for (const [index, row] of verdicts.entries()) {
      const bad = JSON.stringify(badValues[index]);
      // 三个分支各抛一次，且每次都要点名自己那个参数——不能是同一个泛化错误。
      for (const [slot, thrown] of row.entries()) {
        const name = surfaces[slot]?.[2] ?? "";
        assert.match(
          thrown,
          new RegExp(`${name} 必须是布尔值`, "u"),
          `${bad}：${name} 那一支应当被拒且点名自己（实得 ${JSON.stringify(row)}）`,
        );
      }
    }
  });

  it("命令**构造**失败也不泄漏重建占位（构造期 allowlist 拒非本地 embedding 是模型够得着的）", async () => {
    // 回归护栏：buildIndexCommand 曾被放在 try 之外，而它在 allowlist 那条路上会抛。
    // 抛出绕过 finally ⇒ 占位永不交还 ⇒ 这棵树被永久标成「重建中」。
    const root = ws("leak2");
    const ctx = makeCtx();
    applyTo(ctx);
    await assert.rejects(
      () =>
        toolOf(ctx, "zg_index").execute(
          { root, confirm: true, rebuild: true, embedding: "evil/http://attacker/x" },
          execOf(root),
        ),
      /allowRemoteEmbedding/u,
    );
    // 占位已交还：同根应当还能再起一次重建，而不是被「已有一条重建在进行中」挡回。
    const again = await toolOf(ctx, "zg_index").execute(
      { root, confirm: true, rebuild: true },
      execOf(root),
    );
    assert.doesNotMatch(
      (again as { text: string }).text,
      /已有一条重建/u,
      "构造失败把占位带走了：同根再也起不了重建",
    );
    assert.equal(ctx.shell.resolveCalls.length, 1, "第二次应当真的起了一条 zg index");
  });

  it("门槛失败不泄漏重建占位：否则这棵树会被永久标成「重建中」", async () => {
    // 回归护栏：门槛曾被放在 claim **之后**，而它的失败出口不在那几条 finally 覆盖范围内
    // ——zg 过老时占位永不交还，之后每次重建都只得到「已有一条重建在进行中」。
    const root = ws("leak");
    const ctx = makeCtx();
    ctx.shell.zgVersionResult = oldVersionRun("0.2.1");
    applyTo(ctx);
    await assert.rejects(
      () => toolOf(ctx, "zg_index").execute({ root, confirm: true, rebuild: true }, execOf(root)),
      /zg 版本过低/u,
    );
    // 占位交还了吗？把时钟推过门槛的 TTL，让第二次调用真的重新探一次版本——
    // 只有占位已交还，它才可能走到「起一条重建」而不是被「已有一条重建在进行中」挡回。
    vi.useFakeTimers({ now: Date.now() });
    try {
      ctx.shell.zgVersionResult = undefined;
      vi.advanceTimersByTime(11 * 60_000);
      const again = await toolOf(ctx, "zg_index").execute(
        { root, confirm: true, rebuild: true },
        execOf(root),
      );
      assert.doesNotMatch(
        (again as { text: string }).text,
        /已有一条重建/u,
        "占位没交还：zg 过老一次就把这棵树永久标成「重建中」了",
      );
      assert.equal(ctx.shell.resolveCalls.length, 1, "第二次应当真的起了一条 zg index");
      assert.match(ctx.shell.resolveCalls[0]?.command ?? "", /^zg index/u);
    } finally {
      vi.useRealTimers();
    }
  });

  it("门槛文案回显实际版本与门槛值，并给出唯一出路", async () => {
    const root = ws();
    const ctx = makeCtx();
    ctx.shell.zgVersionResult = oldVersionRun("0.1.9");
    applyTo(ctx);
    await assert.rejects(
      () => toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root)),
      (error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        assert.match(text, /0\.1\.9/u, "要回显装的是哪个版本");
        assert.ok(text.includes(MINIMUM_ZG_VERSION), "要回显门槛值");
        assert.match(text, /npm install -g @zvec\/zvec-grep@latest/u, "要给出可照做的出路");
        return true;
      },
    );
  });

  it("探测结果按 TTL 缓存：同一轮里只探一次", async () => {
    const root = ws();
    const ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("A"), okRun("B"), okRun("C"));
    // 三条工具顺序调用（它们共享同一张 runResults 队列，顺序即消费次序）。
    await toolOf(ctx, "zg_search").execute({ root, query: "a" }, execOf(root));
    await toolOf(ctx, "zg_status").execute({ root }, execOf(root));
    await toolOf(ctx, "zg_index").execute({ root, confirm: true }, execOf(root));
    assert.equal(
      ctx.shell.versionProbeCalls.length,
      1,
      "缓存期内不得为每次调用各探一次（那会让每次检索都多一个子进程）",
    );
  });

  it("探测失败一律按「版本未知」放行，绝不拿读不懂的输出去拦真实用户", async () => {
    // 四种「探测不出来」：非零退出、形状不认识、带 v 前缀的版本号、stdout 空。
    // 「读不懂」与「太老」必须分开——混在一起就成了拿猜出来的版本去拦真实用户。
    const unreadable = [
      { exitCode: 1, stdout: { text: "" }, stderr: { text: "boom" } },
      { exitCode: 0, stdout: { text: "not a version" }, stderr: { text: "" } },
      { exitCode: 0, stdout: { text: "v0.2.1" }, stderr: { text: "" } },
      { exitCode: 0, stdout: { text: "" }, stderr: { text: "" } },
    ];
    // 四种并行跑（各自一套 ctx，互不相干）：顺序无关，且不必在循环里 await。
    const verdicts = await Promise.all(
      unreadable.map(async (probeResult): Promise<string> => {
        const root = ws();
        const ctx = makeCtx();
        ctx.shell.zgVersionResult = probeResult;
        applyTo(ctx);
        ctx.shell.runResults.push(okRun("STILL-WORKS"));
        const out = await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root));
        return (out as { text: string }).text;
      }),
    );
    for (const [index, text] of verdicts.entries()) {
      assert.match(
        text,
        /^STILL-WORKS/u,
        `探测不出来时必须照常放行：${JSON.stringify(unreadable[index]?.stdout)}`,
      );
    }
  });

  it("探测本身抛错（执行器缺席/spawn 失败）：照样放行，绝不阻断主流程", async () => {
    const root = ws();
    const ctx = makeCtx();
    ctx.shell.versionProbeThrows = true;
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("UNBLOCKED"));
    const out = await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root));
    assert.match(
      (out as { text: string }).text,
      /^UNBLOCKED/u,
      "探测抛错与探测不到同义：都不该把用户的检索挡下来",
    );
  });

  it("探测命令挂在系统临时目录：不借会话工作区、不碰 root 授权", async () => {
    const root = ws();
    const ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("OK"));
    await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root));
    const [probe] = ctx.shell.versionProbeCalls;
    assert.ok(probe !== undefined, "探测发生过");
    assert.notEqual(probe.workdir, root, "探测是纯打印，不能挂在被检索的工作区上");
    assert.ok(typeof probe.timeoutMs === "number", "探测自带短超时，不借检索超时");
  });
});

describe("官方用户确认（tools/pre-execute → ctx.approval）", () => {
  /** 本组反复出现的两个路径：一个未登记的 root、一个本会话工作区。 */
  const CWD = "/repo";
  const UNREGISTERED_ROOT = "/elsewhere";

  it("默认关：任何显式 root 都直接放行（不打扰用户，也不改变既有行为）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const roots = [UNREGISTERED_ROOT, "/a/b/c"];
    const verdicts = await allowVerdicts(
      ctx,
      roots.map((root) => ({ name: "zg_search", root, cwd: CWD })),
    );
    for (const [index, allow] of verdicts.entries()) {
      assert.equal(allow, true, `默认部署不该发问（root=${roots[index]}）`);
    }
  });

  it("打开后：显式 root 既不是会话工作区、也未登记 → 返回 ask", async () => {
    const ctx = makeCtx();
    applyTo(ctx, { requireApprovalForExplicitRoot: true });
    const { allow, decision } = await preExecuteOf(ctx, askExec("zg_search", "/repo/pkg", CWD));
    assert.equal(allow, false, "该问的要问");
    const ask = decision as {
      kind: string;
      reason?: string;
      displayReason?: { en: string; zh: string };
    };
    assert.equal(ask.kind, "ask");
    assert.match(ask.reason ?? "", /\/repo\/pkg/u, "理由要回显那个 root");
    assert.match(ask.displayReason?.zh ?? "", /\/repo\/pkg/u);
    assert.match(ask.displayReason?.en ?? "", /\/repo\/pkg/u);
    // 相对路径：归一那一步解析不了（assertAbsoluteRoot 抛错），于是按「需要问」处理——
    // 问错一次的代价是一句提示，漏问的代价是把某个目录的内容读进上下文。
    const relative = await preExecuteOf(ctx, askExec("zg_search", "some/relative", CWD));
    assert.equal(relative.allow, false, "解析不了的 root 也要问，而不是当作会话工作区放行");
  });

  it("会话工作区本身、以及已登记的 root：不问（最不该被打扰的两类）", async () => {
    const ctx = makeCtx();
    applyTo(ctx, { requireApprovalForExplicitRoot: true });
    // 同一个会话工作区：归一后相等（含尾部斜杠这种写法）。
    const sameRoots = [CWD, `${CWD}/`];
    const sameVerdicts = await allowVerdicts(
      ctx,
      sameRoots.map((root) => ({ name: "zg_search", root, cwd: CWD })),
    );
    for (const [index, allow] of sameVerdicts.entries()) {
      assert.equal(allow, true, `会话工作区不该被问（root=${sameRoots[index]}）`);
    }
    // 先跑一次工具把 root 登记进 ledger，再问同一个 root。
    const registered = ws("registered");
    const child = path.join(registered, "pkg");
    mkdirSync(child, { recursive: true });
    ctx.shell.runResults.push(okRun("OK"));
    await toolOf(ctx, "zg_status").execute({ root: child }, execOf(registered));
    const after = await preExecuteOf(ctx, askExec("zg_status", child, "/somewhere-else"));
    assert.equal(after.allow, true, "本会话已登记过的 root 不该再问");
  });

  it("三个 zg 工具都问；别家工具一个字都不拦", async () => {
    const ctx = makeCtx();
    applyTo(ctx, { requireApprovalForExplicitRoot: true });
    const toolNames = ["zg_search", "zg_index", "zg_status"];
    const toolVerdicts = await allowVerdicts(
      ctx,
      toolNames.map((tool) => ({ name: tool, root: UNREGISTERED_ROOT, cwd: CWD })),
    );
    for (const [index, allow] of toolVerdicts.entries()) {
      assert.equal(allow, false, `${toolNames[index]} 应当发问`);
    }
    const foreign = await preExecuteOf(ctx, askExec("read", UNREGISTERED_ROOT, CWD));
    assert.equal(foreign.allow, true, "本插件不该对别家工具发问");
  });

  it("没给 root（走缺省）或给了非字符串：都不问", async () => {
    const ctx = makeCtx();
    applyTo(ctx, { requireApprovalForExplicitRoot: true });
    // arguments 根本不是对象（官方面就是 unknown）：读不出 root，同样不问。
    const oddArgs: unknown[] = [null, "not-an-object", 7, ["/elsewhere"]];
    const oddVerdicts = await Promise.all(
      oddArgs.map(async (raw): Promise<boolean> => {
        const odd = await preExecuteOf(ctx, askExec("zg_search", undefined, CWD, raw));
        return odd.allow;
      }),
    );
    for (const [index, allow] of oddVerdicts.entries()) {
      assert.equal(allow, true, `arguments 不是对象时不该问（${JSON.stringify(oddArgs[index])}）`);
    }
    const noRoots: unknown[] = [undefined, 42, "", "   ", null];
    const noVerdicts = await allowVerdicts(
      ctx,
      noRoots.map((root) => ({ name: "zg_search", root, cwd: CWD })),
    );
    for (const [index, allow] of noVerdicts.entries()) {
      assert.equal(allow, true, `没有可判的显式 root 就别问（root=${String(noRoots[index])}）`);
    }
  });

  it("无会话工作区（agent 缺席）时的显式 root：照问（此时最需要人看一眼）", async () => {
    const ctx = makeCtx();
    applyTo(ctx, { requireApprovalForExplicitRoot: true });
    const { allow, decision } = await preExecuteOf(
      ctx,
      askExec("zg_search", UNREGISTERED_ROOT, undefined),
    );
    assert.equal(allow, false);
    const ask = decision as { reason?: string };
    assert.match(ask.reason ?? "", /无会话工作区/u, "理由要说清没有会话工作区可作参照");
  });

  it("这道闸只加不减：批准之后 rootOf 的授权判据一字未改", async () => {
    // 越界的 root 即便假装「用户已批准」，rootOf 照旧拒——确认面不扩大可操作范围。
    const root = ws("strict");
    const ctx = makeCtx();
    applyTo(ctx, { requireApprovalForExplicitRoot: true });
    ctx.shell.runResults.push(okRun("OK"));
    await assert.rejects(
      () => toolOf(ctx, "zg_search").execute({ root: "/etc", query: "hi" }, execOf(root)),
      /未获授权|root/u,
    );
  });
});

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
      // 传输模式缺省自动：有守护进程就走守护进程，没有就直连，两种状态实测均正常。
      clientMode: "auto",
      // 等待同根重建落定的上限：默认两分钟，覆盖常规重建又不至于让检索无限期挂着。
      rebuildWaitMs: 2 * 60_000,
      // 远程 embedding 三件套默认**全关**：关着的时候构造期就拒掉一切非本地引用。
      // 字面值手写不自证：schema 的 .default() 改了，这里先红。
      allowRemoteEmbedding: false,
      remoteEmbeddingEndpoint: "",
      remoteEmbeddingApiKeyFrom: "",
      // 官方用户确认开关：默认关（关着时 pre-execute 那道闸一行都不执行）。
      requireApprovalForExplicitRoot: false,
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

  it("参数面：preview / refresh 带闭集 enum，符号类型逐项带 enum 且与取值器同源", () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const props = toolOf(ctx, "zg_search").parameters["properties"] as Record<
      string,
      { enum?: unknown; oneOf?: unknown; items?: { enum?: unknown } }
    >;
    assert.deepEqual(props["preview"]?.enum, ["none", "short", "full"]);
    assert.deepEqual(props["refresh"]?.enum, ["background", "wait", "off"]);
    assert.deepEqual(props["symbolTypes"]?.items?.enum, [
      "module",
      "class",
      "interface",
      "function",
      "value",
      "alias",
    ]);
  });

  it("参数面：路径过滤项用 oneOf 表达单值或数组（宿主子集不收 anyOf）", () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const search = toolOf(ctx, "zg_search").parameters["properties"] as Record<string, unknown>;
    const index = toolOf(ctx, "zg_index").parameters["properties"] as Record<string, unknown>;
    for (const name of ["globs", "insensitiveGlobs", "fileTypes", "excludedFileTypes"]) {
      for (const [tool, props] of [
        ["zg_search", search],
        ["zg_index", index],
      ] as const) {
        const node = props[name] as { oneOf?: unknown; anyOf?: unknown };
        assert.ok(Array.isArray(node.oneOf) && node.oneOf.length === 2, `${tool}.${name} 缺 oneOf`);
        assert.equal(node.anyOf, undefined, `${tool}.${name} 不该用宿主不收的 anyOf`);
      }
    }
    const ignoreFiles = index["ignoreFiles"] as { oneOf?: unknown };
    assert.ok(Array.isArray(ignoreFiles.oneOf), "index.ignoreFiles 也接受单值");
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

/** 真实 zg 在 --check-ready 判出未就绪时写在 stderr 上的那一行（逐字抄）。 */
const NOT_READY_STDERR = "Error: Workspace index is not ready (state: undecided)";

/** 双路查询输出里重复出现的组头三行，抽成常量避免三处硬编码漂移。 */
const GROUP_HEADER_1 = "query groups (2):";
const GROUP_LINE_1 = "Q1 [supplemental]: parseConfig";
const GROUP_LINE_2 = "Q2 [supplemental]: parse a config file";

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
    const out = await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root));
    assert.equal(ctx.shell.resolveCalls.length, 1);
    assert.equal(ctx.shell.resolveCalls[0]?.command, INDEXED_SEARCH_COMMAND);
    assert.equal(ctx.shell.resolveCalls[0].workdir, root);
    assert.deepEqual(out, { text: "RESULT" });
  });

  it("stdout 带 hits 计数行 → 尾部追加命中摘要（分组求和；未触顶不提上限）", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(
      okRun("query groups (2):\nQ1: q\nhits: 3\n#1 a\nQ2: b\nhits: 2\n#1 c"),
    );
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root))) as {
      text: unknown;
    };
    assert.ok(
      typeof out.text === "string" &&
        out.text.endsWith(
          `\n${fill(MESSAGES.zh.hitSummary, {
            groups: 2,
            grouped: 5,
            dedup: "",
            limit: 10,
            capped: "",
            truncated: "",
          })}`,
        ),
    );
  });

  it("命中数达 --limit → 摘要带上限观察片段；截尾 → 带「只含保留部分」片段", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    const cappedRun = okRun("Q1: q\nhits: 10\n#1 a");
    cappedRun.stdout.truncated = true;
    ctx.shell.runResults.push(cappedRun);
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root))) as {
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
    const out = await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root));
    assert.deepEqual(out, { text: "nothing recognizable" });
  });

  it("hits: 打头但非纯数字的行不当计数（形状意外也不谎称），有效组照常求和", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("hits: N/A\nQ1: q\nhits: 2\n#1 a"));
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root))) as {
      text: unknown;
    };
    assert.ok(
      typeof out.text === "string" &&
        out.text.includes(
          fill(MESSAGES.zh.hitSummary, {
            groups: 1,
            grouped: 2,
            dedup: "",
            limit: 10,
            capped: "",
            truncated: "",
          }),
        ),
      "摘要只数有效组",
    );
  });

  it("多组命中同一处代码 → 分组计数合计与去重后位置数分别给出（求和不再冒充命中总数）", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    // 真实 zg 双组输出（--fts + --vector，未 fuse）：src/beta.ts:1-3 在 fts 组排第 4、
    // 在 vector 组排第 1，matchedBy 也不同——同一处位置被两组各命中一次。
    ctx.shell.runResults.push(
      okRun(
        [
          GROUP_HEADER_1,
          GROUP_LINE_1,
          "hits: 5",
          "#1 matchedBy=fts docs/gamma.md:1-4",
          "#2 matchedBy=fts README.md:1-2",
          "#3 matchedBy=fts src/delta.ts:1",
          "#4 matchedBy=fts src/beta.ts:1-3",
          "#5 matchedBy=fts src/alpha.ts:1-3",
          GROUP_LINE_2,
          "hits: 5",
          "#1 matchedBy=vector src/beta.ts:1-3",
          "#2 matchedBy=vector src/alpha.ts:1-3",
          "#3 matchedBy=vector docs/gamma.md:1-4",
          "#4 matchedBy=vector src/alpha.ts:5-7",
          "#5 matchedBy=vector src/delta.ts:1",
        ].join("\n"),
      ),
    );
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root))) as {
      text: unknown;
    };
    const dedup = fill(MESSAGES.zh.hitDedup, { unique: 6 });
    assert.ok(
      typeof out.text === "string" &&
        out.text.endsWith(
          `\n${fill(MESSAGES.zh.hitSummary, {
            groups: 2,
            grouped: 10,
            dedup,
            limit: 10,
            capped: "",
            truncated: "",
          })}`,
        ),
      "10 条分组计数对应 6 处不同位置",
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
      () => toolOf(ctx, "zg_search").execute({ root: ghost, query: "x" }, execOf(root)),
      /root 目录不存在/u,
    );
    assert.equal(ctx.shell.resolveCalls.length, 0);
  });

  it("非对象参数（null/数组/数字）→ 明确报错", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    const search = toolOf(ctx, "zg_search");
    await assert.rejects(
      () => search.execute(null, execOf(root)),
      /参数必须是一个 JSON 对象.*null/u,
    );
    await assert.rejects(
      () => search.execute(5, execOf(root)),
      /参数必须是一个 JSON 对象.*number/u,
    );
  });

  it("冻结的模型参数（官方 deepFreeze）不抛错且默认 limit 生效", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("RESULT"));
    const frozen = Object.freeze({ root, query: "hi" });
    const out = await toolOf(ctx, "zg_search").execute(frozen, execOf(root));
    assert.deepEqual(out, { text: "RESULT" });
    assert.match(String(ctx.shell.resolveCalls[0]?.command), /--limit 10/u);
    assert.ok(!("limit" in frozen));
  });

  it("设置全缺时回内置默认（limit=10 / 默认 embedding / 默认配额）", async () => {
    ctx = makeCtx();
    ctx.settingsValue = {};
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("RESULT"));
    await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root));
    assert.equal(ctx.shell.resolveCalls[0]?.command, INDEXED_SEARCH_COMMAND);
    assert.equal(ctx.shell.resolveCalls[0].env, undefined);
  });

  it("冻结参数中的显式 limit 被尊重且不抛错", async () => {
    ctx = makeCtx();
    ctx.settingsValue["defaultLimit"] = 7;
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("RESULT"));
    await toolOf(ctx, "zg_search").execute(
      Object.freeze({ root, query: "hi", limit: 3 }),
      execOf(root),
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
      () => toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root)),
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
      () => toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root)),
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
      () => toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root)),
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
      () => toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root)),
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
      () => toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root)),
      /zg 执行超时/u,
    );
    ctx.shell.runResults.push({
      exitCode: null,
      aborted: true,
      stdout: { text: "", truncated: false },
      stderr: { text: "", truncated: false },
    });
    await assert.rejects(
      () => toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root)),
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
          () => search.execute({ root, query: "x" }, execOf(root)),
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
      () => toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root)),
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
      () => toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root)),
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
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root))) as {
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
    const plain = (await toolOf(ctx, "zg_search").execute({ root, query: "a" }, execOf(root))) as {
      text: string;
    };
    assert.ok(plain.text.includes("已截断") && !plain.text.includes("落盘"));
    ctx.shell.runResults.push({
      exitCode: 0,
      stdout: { text: "PART", truncated: true, spillPath: "/tmp/spill.log" },
      stderr: { text: "", truncated: false },
    });
    const spilled = (await toolOf(ctx, "zg_search").execute(
      { root, query: "b" },
      execOf(root),
    )) as {
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
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root))) as {
      text: string;
    };
    assert.ok(out.text.includes("zg stderr"));
    assert.ok(out.text.includes("退化为纯词法检索"));
    ctx.shell.runResults.push({
      exitCode: 0,
      stdout: { text: "HITS", truncated: false },
      stderr: { text: "跳过 --refresh", truncated: true },
    });
    const marked = (await toolOf(ctx, "zg_search").execute({ root, query: "y" }, execOf(root))) as {
      text: string;
    };
    assert.ok(marked.text.includes("：[…]跳过 --refresh"));
  });

  it("成功且无任何异常 → 文本原样，不加噪声", async () => {
    ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("CLEAN"));
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root))) as {
      text: string;
    };
    assert.equal(out.text, "CLEAN");
  });

  it("hfEndpoint 为空/缺省时不传 env", async () => {
    ctx = makeCtx();
    ctx.settingsValue["hfEndpoint"] = "   ";
    applyTo(ctx);
    ctx.shell.runResults.push(okRun());
    await toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root));
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
      .execute({ root, query: "x" }, execOf(root))
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
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root))) as {
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
      () => toolOf(ctx, "zg_index").execute({ root }, execOf(root)),
      /缺少必填参数 confirm/u,
    );
    assert.equal(ctx.shell.resolveCalls.length, 0);
  });

  it("使用设置里的默认 embedding", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("INDEXED"));
    await toolOf(ctx, "zg_index").execute({ root, confirm: true }, execOf(root));
    assert.equal(
      ctx.shell.resolveCalls[0]?.command,
      `zg index '${root}' --embedding '${DEFAULT_EMBEDDING}' ${SECRET_ARGS} --device 'auto' --mode auto`,
    );
  });

  it("设置非法值回退默认，显式 embedding 优先", async () => {
    const ctx = makeCtx();
    ctx.settingsValue["defaultEmbedding"] = "not-a-model";
    applyTo(ctx);
    ctx.shell.runResults.push(okRun(), okRun());
    await toolOf(ctx, "zg_index").execute(
      { root, confirm: true, embedding: "local/potion-code-16m-v2" },
      execOf(root),
    );
    assert.match(String(ctx.shell.resolveCalls[0]?.command), /--embedding 'local\/potion/u);
    await toolOf(ctx, "zg_index").execute({ root, confirm: true }, execOf(root));
    assert.equal(
      ctx.shell.resolveCalls[1]?.command,
      `zg index '${root}' --embedding '${DEFAULT_EMBEDDING}' ${SECRET_ARGS} --device 'auto' --mode auto`,
    );
  });

  it("布尔旗标非布尔即拒（harness 不校验工具入参）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun(), okRun());
    await assert.rejects(
      () => toolOf(ctx, "zg_index").execute({ root, confirm: true, rebuild: 1 }, execOf(root)),
      /rebuild 必须是布尔值/u,
    );
    // drop=true 短路：其它非法布尔也要在构造前报错
    await assert.rejects(
      () => toolOf(ctx, "zg_index").execute({ root, confirm: true, drop: "true" }, execOf(root)),
      /drop 必须是布尔值/u,
    );
  });

  it("hfEndpoint 传给三个工具与 rebuild", async () => {
    const ctx = makeCtx();
    ctx.settingsValue["hfEndpoint"] = "https://modelscope.cn/models/";
    applyTo(ctx);
    const wanted = { HF_ENDPOINT: MODELSCOPE_MIRROR };
    ctx.shell.runResults.push(okRun(), okRun(), okRun());
    await toolOf(ctx, "zg_index").execute({ root, confirm: true }, execOf(root));
    await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root));
    await toolOf(ctx, "zg_status").execute({ root }, execOf(root));
    assert.deepEqual(ctx.shell.resolveCalls[0]?.env, wanted);
    assert.deepEqual(ctx.shell.resolveCalls[1]?.env, wanted);
    assert.deepEqual(ctx.shell.resolveCalls[2]?.env, wanted);
    const started = await startJob(ctx, root);
    const spec = ctx.shell.startCalls[0] as { env?: Record<string, string> };
    assert.deepEqual(spec.env, wanted);
    assert.equal(started.proc.killCount, 0);
  });

  it("默认部署：远程 embedding 三个开关都不下发 env，也不放开引用", async () => {
    const ctx = makeCtx();
    const restore = withEnv(EMBED_KEY_ENV, "sk-should-not-leak");
    try {
      applyTo(ctx);
      // 端点/凭据都没配 ⇒ env 里只有 HF 镜像，一个远程相关的名字都没有。
      ctx.shell.runResults.push(okRun());
      await toolOf(ctx, "zg_index").execute({ root, confirm: true }, execOf(root));
      const env = ctx.shell.resolveCalls[0]?.env ?? {};
      assert.equal(env["ZVEC_GREP_ENDPOINT"], undefined, "默认不得下发端点");
      assert.equal(env["ZVEC_GREP_API_KEY"], undefined, "默认不得下发凭据");
      assert.ok(!JSON.stringify(env).includes("sk-should-not-leak"), "默认不得读任何凭据");
      // 显式远程引用在构造期就被拒。
      await assert.rejects(
        () =>
          toolOf(ctx, "zg_index").execute(
            { root, confirm: true, embedding: REMOTE_EMBEDDING },
            execOf(root),
          ),
        /allowRemoteEmbedding/u,
      );
    } finally {
      restore();
    }
  });

  it("部署开放后：端点与凭据经 env 下发，argv 里两者都不出现", async () => {
    const ctx = makeCtx();
    const restore = withEnv(EMBED_KEY_ENV, FAKE_KEY);
    try {
      applyTo(ctx, {
        allowRemoteEmbedding: true,
        remoteEmbeddingEndpoint: REMOTE_ENDPOINT,
        remoteEmbeddingApiKeyFrom: EMBED_KEY_ENV,
      });
      ctx.shell.runResults.push(okRun());
      await toolOf(ctx, "zg_index").execute(
        { root, confirm: true, embedding: REMOTE_EMBEDDING },
        execOf(root),
      );
      const [call] = ctx.shell.resolveCalls;
      const env = call?.env ?? {};
      assert.equal(env["ZVEC_GREP_ENDPOINT"], REMOTE_ENDPOINT);
      assert.equal(env["ZVEC_GREP_API_KEY"], FAKE_KEY);
      assert.equal(env["HF_ENDPOINT"], MODELSCOPE_MIRROR, "HF 镜像那一路不受影响");
      // 关键：命令行（= 作业 label、卡片回显、ps 进程表）里不得有端点或密钥。
      const command = String(call?.command);
      assert.ok(!command.includes(FAKE_KEY), "argv 里不得出现凭据");
      assert.ok(!command.includes("api.example.com"), "argv 里不得出现端点");
      assert.ok(!command.includes("--api-key"), "本包不构造 --api-key");
      assert.ok(!command.includes("--endpoint"), "本包不构造 --endpoint");
    } finally {
      restore();
    }
  });

  it("部署值被塞成非字符串（绕过 schema）：按「没配」处理，不在命令构造中途抛", async () => {
    // 这两个字段是**非 volatile** 部署值，正常装载下必有值；但行 config 若绕过 schema
    // 直接塞进非字符串，这里必须判成「没配」而不是让 undefined.trim() 抛在半路。
    // 走行 config 而不是 settingsValue 直写：非 volatile 字段是**装载期快照**，
    // apply 之后再改 settingsValue 已经来不及了（本仓替身复刻的就是这个语义）。
    // 而替身的 applyTo 不跑 schema 校验，正好把「绕过 schema」这件事复现出来。
    const ctx = makeCtx();
    applyTo(ctx, {
      allowRemoteEmbedding: true,
      remoteEmbeddingEndpoint: 42,
      remoteEmbeddingApiKeyFrom: null,
    });
    ctx.shell.runResults.push(okRun("OK"));
    const out = await toolOf(ctx, "zg_index").execute(
      { root, confirm: true, embedding: REMOTE_EMBEDDING },
      execOf(root),
    );
    assert.match((out as { text: string }).text, /^OK/u);
    const env = ctx.shell.resolveCalls[0]?.env ?? {};
    assert.equal(env["ZVEC_GREP_ENDPOINT"], undefined, "非字符串端点 = 没配");
    assert.equal(env["ZVEC_GREP_API_KEY"], undefined, "非字符串凭据名 = 没配");
  });

  it("点名的那个环境变量没设/是空白：不下发凭据，但端点照发", async () => {
    const ctx = makeCtx();
    const restore = withEnv(EMBED_KEY_ENV, "   ");
    try {
      applyTo(ctx, {
        allowRemoteEmbedding: true,
        remoteEmbeddingEndpoint: REMOTE_ENDPOINT,
        remoteEmbeddingApiKeyFrom: EMBED_KEY_ENV,
      });
      ctx.shell.runResults.push(okRun());
      await toolOf(ctx, "zg_index").execute(
        { root, confirm: true, embedding: REMOTE_EMBEDDING },
        execOf(root),
      );
      const env = ctx.shell.resolveCalls[0]?.env ?? {};
      assert.equal(env["ZVEC_GREP_ENDPOINT"], REMOTE_ENDPOINT);
      assert.equal(
        env["ZVEC_GREP_API_KEY"],
        undefined,
        "空白凭据等于没配：发一个空的 ZVEC_GREP_API_KEY 只会覆盖 zg 侧的真值",
      );
    } finally {
      restore();
    }
  });

  it("只开 allowRemoteEmbedding、没配端点与凭据名：引用放行，env 一个远程项都不加", async () => {
    const ctx = makeCtx();
    applyTo(ctx, { allowRemoteEmbedding: true });
    ctx.shell.runResults.push(okRun());
    await toolOf(ctx, "zg_index").execute(
      { root, confirm: true, embedding: REMOTE_EMBEDDING },
      execOf(root),
    );
    const env = ctx.shell.resolveCalls[0]?.env ?? {};
    assert.equal(env["ZVEC_GREP_ENDPOINT"], undefined);
    assert.equal(env["ZVEC_GREP_API_KEY"], undefined);
  });

  it("zg_status 构造 status 命令、root 缺省回会话工作区", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    ctx.shell.runResults.push(okRun("STATUS"), okRun("STATUS2"));
    await toolOf(ctx, "zg_status").execute({ root }, execOf(root));
    assert.equal(ctx.shell.resolveCalls[0]?.command, `zg status '${root}' --mode auto`);
    // 回归护栏的另一侧：前台必须保留宿主 deadline 的缺省 kill 语义，不得被
    // onExpiry:'none' 变成无界（那是后台重建专用）。
    assert.equal(ctx.shell.resolveCalls[0].onExpiry, undefined);
    assert.ok(typeof ctx.shell.resolveCalls[0].timeoutMs === "number", "前台请求必须带 timeoutMs");
    await toolOf(ctx, "zg_status").execute({}, execOf(root));
    assert.equal(ctx.shell.resolveCalls[1]?.workdir, root);
  });
});

// ── 就绪判定（--check-ready）与后台重建作业状态整合 ──
//
// 真实 zg 的契约是「preserves the normal output and exits non-zero unless the Workspace
// index is ready」：就绪报告打在 stdout，退出码只表达就绪与否。走普通失败路径会把报告丢掉、
// 只留一句 stderr，恰好扔掉用户最需要的输出。
describe("zg_status 就绪判定", () => {
  it("checkReady=true 透传 --check-ready", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("ready");
    ctx.shell.runResults.push(okRun("STATUS"));
    await toolOf(ctx, "zg_status").execute({ root, checkReady: true }, execOf(root));
    assert.equal(
      ctx.shell.resolveCalls[0]?.command,
      `zg status '${root}' --check-ready --mode auto`,
    );
  });

  it("就绪：退出码 0 时照常返回报告", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("ready");
    ctx.shell.runResults.push(okRun("READY"));
    const out = (await toolOf(ctx, "zg_status").execute(
      { root, checkReady: true },
      execOf(root),
    )) as { text: string };
    assert.equal(out.text, "READY");
  });

  it("未就绪：非零退出仍交回完整报告，并明说这不是执行失败", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("ready");
    // 照抄真实 zg：stdout 是「? Workspace index is not configured …」那份报告，
    // stderr 是「Error: Workspace index is not ready (state: undecided)」。
    const notReady = okRun(
      "? Workspace index is not configured\n\n  Next        zg index or zg query --rg",
    );
    notReady.exitCode = 1;
    notReady.stderr.text = NOT_READY_STDERR;
    ctx.shell.runResults.push(notReady);
    const out = (await toolOf(ctx, "zg_status").execute(
      { root, checkReady: true },
      execOf(root),
    )) as { text: string };
    assert.ok(out.text.startsWith("? Workspace index is not configured"), "报告必须交回");
    assert.ok(out.text.includes(root), "注脚要带上根");
    assert.ok(out.text.includes("未就绪"), "要明说未就绪");
    assert.ok(out.text.includes("这不是执行失败"), "要区分「未就绪」与「执行失败」");
    assert.ok(out.text.includes("is not ready"), "要把 zg 的原始判据一并交回");
  });

  it("未就绪但 stdout 为空：仍按失败抛（不凭空造一份报告）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("ready");
    const failed = okRun("");
    failed.exitCode = 1;
    failed.stderr.text = NOT_READY_STDERR;
    ctx.shell.runResults.push(failed);
    await assert.rejects(
      () => toolOf(ctx, "zg_status").execute({ root, checkReady: true }, execOf(root)),
      /is not ready/u,
    );
  });

  it("未开 checkReady 时不吸收失败：非零退出照旧抛错", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("ready");
    const notReady = okRun("REPORT");
    notReady.exitCode = 1;
    notReady.stderr.text = NOT_READY_STDERR;
    ctx.shell.runResults.push(notReady);
    await assert.rejects(
      () => toolOf(ctx, "zg_status").execute({ root }, execOf(root)),
      /is not ready/u,
    );
  });

  it("重建进行中：就绪判定让位给重建投影（此刻「是否就绪」的答案本就是否定的）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("ready");
    trackRoot(ctx, root);
    const res = await postRebuild(ctx, root);
    assert.equal(res.statusCode, 200, res.body);
    // 重建本身已经起过后台进程，基线要记在状态查询之前。
    const before = ctx.shell.resolveCalls.length;
    const out = (await toolOf(ctx, "zg_status").execute(
      { root, checkReady: true },
      execOf(root),
    )) as { text: string };
    assert.ok(out.text.includes(root), "重建投影要带上根");
    assert.match(out.text, /正在重建中/u);
    assert.equal(ctx.shell.resolveCalls.length, before, "重建投影期间不另起子进程");
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
    makeIndexed(root);
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

// ── 命中摘要的口径（分组计数 vs 去重后位置数）──
//
// 断言面全是真实 zg 输出形状：`#<名次> matchedBy=<来源> <相对路径>:<行号范围>`。身份键
// 取 `matchedBy=` 之后的整段原样文本——名次与匹配来源逐组变化，入键即失效；路径本身
// 可以含空格与冒号，拆行号范围反而会误判。
describe("hitSummary", () => {
  const { zh } = MESSAGES;

  it("同一条位置被多组命中、名次与来源都不同 → 只算一处位置", () => {
    const out = hitSummary(
      [
        GROUP_HEADER_1,
        GROUP_LINE_1,
        "hits: 1",
        "#1 matchedBy=fts src/beta.ts:1-3",
        GROUP_LINE_2,
        "hits: 1",
        "#1 matchedBy=vector src/beta.ts:1-3",
      ].join("\n"),
      10,
      false,
      zh,
    );
    assert.equal(
      out,
      fill(zh.hitSummary, {
        groups: 2,
        grouped: 2,
        dedup: fill(zh.hitDedup, { unique: 1 }),
        limit: 10,
        capped: "",
        truncated: "",
      }),
    );
  });

  it("fuse 输出（matchedBy=fts+vector、单组）照常给出口径", () => {
    const out = hitSummary(
      "query groups (1):\nQ1 [supplemental]: parseConfig | parse a config file\nhits: 1\n" +
        "#1 matchedBy=fts+vector src/beta.ts:1-3",
      10,
      false,
      zh,
    );
    assert.ok(out?.includes(fill(zh.hitDedup, { unique: 1 })) === true, "fuse 单组也要给去重口径");
  });

  it("路径含空格与冒号 → 原样入键，不被拆错", () => {
    const out = hitSummary(
      "query groups (1):\nQ1: q\nhits: 2\n" +
        "#1 matchedBy=fts deep/a/b/c d/we:ird file.ts:1-2\n" +
        "#2 matchedBy=fts deep/a/b/c d/we:ird file.ts:9-9",
      10,
      false,
      zh,
    );
    assert.ok(
      out?.includes(fill(zh.hitDedup, { unique: 2 })) === true,
      "两处行号不同 → 两处位置；含冒号的路径不能被截断成同一个键",
    );
  });

  // 追踪开启后条目头行多出两段装饰（真实 zg 输出照抄）。回归点：分值逐组不同，
  // 带它入键会让同一处位置在两个组里各成"新位置"，去重彻底失效。
  it("--trace 头行的 score= 与选择理由都不入键，同一位置仍只算一处", () => {
    const out = hitSummary(
      [
        GROUP_HEADER_1,
        GROUP_LINE_1,
        "hits: 2",
        "#1 matchedBy=fts score=0.0164 src/beta.ts:1-2",
        "#2 [global_fill] matchedBy=fts score=0.0161 src/alpha.ts:1",
        'trace: query "parseConfig": fts #1, vector #2; fused #1',
        GROUP_LINE_2,
        "hits: 2",
        "#1 matchedBy=vector score=0.0161 src/alpha.ts:1",
        "#2 matchedBy=vector score=0.0164 src/beta.ts:1-2",
      ].join("\n"),
      10,
      false,
      zh,
    );
    assert.ok(
      out?.includes(fill(zh.hitDedup, { unique: 2 })) === true,
      `分值与名次都变了，同一处位置仍应是 2 处：${String(out)}`,
    );
  });

  it("score 形态两种都收：整数与四位小数", () => {
    const out = hitSummary(
      "Q1: q\nhits: 2\n#1 matchedBy=fts score=1 src/a.ts:1-2\n#2 matchedBy=fts score=0.0325 src/a.ts:1-2",
      10,
      false,
      zh,
    );
    assert.ok(out?.includes(fill(zh.hitDedup, { unique: 1 })) === true, String(out));
  });

  it("路径真以 score= 开头时不被误剥（纯数字才当分值）", () => {
    const out = hitSummary(
      "Q1: q\nhits: 2\n#1 matchedBy=fts score=1.txt:1-2\n#2 matchedBy=fts score=2.txt:1-2",
      10,
      false,
      zh,
    );
    assert.ok(out?.includes(fill(zh.hitDedup, { unique: 2 })) === true, String(out));
  });

  it("preview 的源码行、标题行不误判成命中条目", () => {
    const out = hitSummary(
      [
        "query groups (1):",
        "Q1: q",
        "hits: 1",
        "#1 matchedBy=fts docs/gamma.md:1-4",
        "heading: Config",
        "heading_level: 1",
        "source:",
        "1\t# Config",
        "2\t",
        "3\tUse parseConfig.",
      ].join("\n"),
      10,
      false,
      zh,
    );
    assert.ok(
      out?.includes(fill(zh.hitDedup, { unique: 1 })) === true,
      "只有 #n matchedBy= 开头的行才入键",
    );
  });

  it("有命中条目但无 hits 计数行 → 不出摘要（没有组口径就不编）", () => {
    assert.equal(hitSummary("#1 matchedBy=fts src/beta.ts:1-3", 10, false, zh), null);
  });

  it("输出被截尾 → 去重口径只覆盖保留部分，与截尾片段一并出现", () => {
    const out = hitSummary("Q1: q\nhits: 4\n#1 matchedBy=fts src/beta.ts:1-3", 10, true, zh);
    assert.ok(
      out !== null && out.includes(fill(zh.hitTruncated, {})) && out.includes("1"),
      "截尾事实要显式化",
    );
  });

  it("英文口径同源：分组与去重两栏都在", () => {
    const out = hitSummary(
      "Q1: q\nhits: 2\n#1 matchedBy=fts src/beta.ts:1-3\n#2 matchedBy=fts src/alpha.ts:1-3",
      10,
      false,
      MESSAGES.en,
    );
    assert.ok(
      out !== null &&
        out.includes("2 hit(s) in grouped counts") &&
        out.includes("2 distinct location(s) after dedup"),
      `英文摘要缺口径：${String(out)}`,
    );
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
    makeIndexed(tmp);
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

  it("只有 .zvec-grep/ 而没有 manifest → 不算已建索引，grep 直接放行（撞名回归）", () => {
    // 回归钉点：`.zvec-grep` 这个目录名同时是 zg **全局 home** 的名字
    // （`ZVEC_GREP_HOME ?? ~/.zvec-grep`，装 config.json / locks / models）。
    // 探测若只看目录存在，一个祖先恰好是 zg 全局 home 的工作区会被误判成已建索引——
    // 门禁随即在无索引可搜的情况下拦下 grep，而 zg_search 也答不出东西。
    // 分界是 workspace manifest：只有它在场才说明这个工作区真建过索引。
    tmp = mkdtempSync(path.join(tmpdir(), "zvec-grep-gate-homeonly-"));
    createdDirs.push(tmp);
    mkdirSync(path.join(tmp, ZG_INDEX_DIR));
    writeFileSync(path.join(tmp, ZG_INDEX_DIR, "config.json"), "{}\n");
    ctx = makeCtx();
    applyTo(ctx);
    const reason = guardOf(ctx)({
      name: "bash",
      arguments: { command: "grep -r TODO ." },
      agent: { session: { id: "sess-home", header: { cwd: tmp } } },
    });
    assert.equal(reason, undefined, "没有 manifest 就该当没建索引，不拦");
  });

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
    makeIndexed(tmp);
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

  it("schema 字段全集 = 投影可编辑六项 + 十项非 volatile 部署值（W4）", () => {
    // 部署值（超时三项 + stdout 上限 + 传输模式 + 重建等待 + 远程 embedding 三件）
    // 不该标 volatile：标了会挤上设置卡——尤其远程 embedding 那三项，一个是「允许把
    // 工作区内容送出本机」的安全闸、一个是端点、一个是凭据的环境变量名，都不该由
    // 设置卡写。这里拿 schema 的字段全集对照两个期望清单，新增字段漏改期望时先红。
    assert.deepEqual(
      Object.keys(configDict()).toSorted(),
      [
        ...EDITABLE,
        "searchTimeoutMs",
        "statusTimeoutMs",
        "indexTimeoutMs",
        "stdoutMaxBytes",
        "clientMode",
        "rebuildWaitMs",
        "allowRemoteEmbedding",
        "remoteEmbeddingEndpoint",
        "remoteEmbeddingApiKeyFrom",
        "requireApprovalForExplicitRoot",
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

/**
 * 让出若干轮微任务（递归链，不在循环里 await）。
 * @param remaining 还剩几轮
 * @returns 全部让出后的兑现
 */
async function drainMicrotasks(remaining: number): Promise<void> {
  if (remaining <= 0) {
    return;
  }
  await Promise.resolve();
  return drainMicrotasks(remaining - 1);
}

/** 让出若干轮微任务：把调用方推进到「下一次 await」之后的那个位置。 */
async function microTicks(count: number): Promise<undefined> {
  await drainMicrotasks(count);
  return undefined;
}

/** 造一个带索引库的临时工作区（供重建期门禁用例）。 */
function makeIndexedTemp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "zvec-grep-idx-"));
  makeIndexed(dir);
  return dir;
}

/** zg 重建持锁时的一次失败执行（锁名、操作名、进程号都按实测抄）。 */
function lockBusyRun(ownerOperation = "index.rebuild"): ShellRunResult {
  const stderr = [
    "Error: Index unavailable",
    "Code: ZVEC_GREP.ENGINE.LOCK.BUSY",
    "Details:",
    "  lock: /ws/.zvec-grep/locks/home.write",
    "  operation: info",
    `  ownerOperation: ${ownerOperation}`,
    "  ownerPid: 14962",
  ].join("\n");
  return {
    exitCode: 1,
    stdout: { text: "", truncated: false },
    stderr: { text: stderr, truncated: false },
  };
}

/**
 * 在被测插件里登记一条「正在重建」的占位并把落定开关交回测试。
 * 走的是重建端点那条真实接线（卡片发起），不是直接摸内部状态——否则这条用例
 * 自己就成了自证。
 */
async function rebuildInFlight(
  ctx: MockCtx,
  root: string,
): Promise<{ release: () => Promise<void> }> {
  trackRoot(ctx, root);
  const before = ctx.shell.startedProcs.length;
  const res = await postRebuild(ctx, root);
  assert.equal(res.statusCode, 200, res.body);
  return { release: () => settleRebuilds(ctx, before) };
}

// ── 穷举词法检索通道（无索引时的首选路径）──
//
// 三条判据各自有实测支撑：zg 在索引根的**子目录**里同样检索得到（所以判据用 findIndexRoot
// 向上找，不是「根自身有没有」）；--rg 的合法旗标集合与索引通道不同（见 lib/cli.ts 的
// assertExhaustiveArgs）；穷举不发放 grep/rg 配额（不读索引就不构成「先用过语义检索」）。
// ── 子代理与主代理共享一份检索解锁 ──
//
// 分片键取的是会话沿 `header.parentSession` 上溯到的**根**：主代理搜过一次，同一棵委派树上的
// 子代理随即就能用那几次 grep/rg。否则「语义检索优先」在多代理下等于失效——每个子代理都得
// 自己搜一次才解锁，而它们搜的往往是同一棵树。
/**
 * 一次 grep 裁决：放行返回 undefined，被拦返回拒绝理由。
 * `parent` 即该会话 header 上的 `parentSession`（子代理会话挂在谁下面）。
 */
function grepVerdict(
  ctx: MockCtx,
  cwd: string,
  id: string,
  parent?: string,
  command = "grep foo",
): string | undefined {
  return guardOf(ctx)({
    name: "bash",
    arguments: { command },
    agent: {
      session: { id, header: { cwd, ...(parent === undefined ? {} : { parentSession: parent }) } },
    },
  });
}

// ── 模型侧后台索引 ──
//
// 一次 zg_index(background=true) 应当把「起进程 + 登记作业 + 挂超时回收」全做完，把可轮询的
// 作业号交回后立刻返回；起的作业与设置卡那条重建在名册上同形，所以卡片也能看见。
describe("模型侧后台索引", () => {
  it("返回可轮询的作业号，且本次调用不挂着", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = bareWs("bg");
    const out = (await toolOf(ctx, "zg_index").execute(
      { root, confirm: true, background: true },
      execOf(root),
    )) as { text: string };
    assert.match(out.text, /root|后台/u);
    assert.ok(out.text.includes(root), "要带上根");
    assert.match(out.text, /zg index/u, "要把实际命令交回，便于模型复述");
    assert.equal(ctx.shell.resolveCalls.length, 1, "只起一条 zg");
    assert.equal(ctx.shell.resolveCalls[0]?.onExpiry, "none", "后台路径要无界执行");
  });

  it("起的作业进了官方注册表：卡片轮询能读到同一条", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = bareWs("bg");
    const out = (await toolOf(ctx, "zg_index").execute(
      { root, confirm: true, background: true },
      execOf(root),
    )) as { text: string };
    const started = ctx.jobs.list();
    assert.equal(started.length, 1, "应登记进官方名册");
    const polled = await fetchStatus(ctx, started[0]?.id ?? "");
    assert.equal(polled.statusCode, 200, `卡片轮询端点要认这条作业：${polled.body}`);
    assert.ok(out.text.includes(started[0]?.id ?? "x"), "交回的作业号要与名册一致");
  });

  it("占位互斥跨入口成立：卡片那条跟随模型起的同根作业，绝不另起第二条 zg", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = bareWs("bg");
    trackRoot(ctx, root);
    await toolOf(ctx, "zg_index").execute({ root, confirm: true, background: true }, execOf(root));
    const mine = ctx.jobs.list()[0]?.id;
    const before = ctx.shell.startedProcs.length;
    const res = await postRebuild(ctx, root);
    assert.equal(res.statusCode, 200, "同根已在跑，卡片应跟随而不是拒绝");
    const followed: unknown = JSON.parse(res.body);
    assert.equal(
      typeof followed === "object" && followed !== null
        ? Reflect.get(followed, "jobId")
        : undefined,
      mine,
      "跟随的正是模型起的那条",
    );
    assert.equal(ctx.shell.startedProcs.length, before, "绝不能另起第二条 zg");
  });

  it("同根第二次后台索引：拒并交回在飞提示，不起第二条", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = bareWs("bg");
    await toolOf(ctx, "zg_index").execute({ root, confirm: true, background: true }, execOf(root));
    const before = ctx.shell.startedProcs.length;
    const again = (await toolOf(ctx, "zg_index").execute(
      { root, confirm: true, background: true },
      execOf(root),
    )) as { text: string };
    assert.ok(again.text.length > 0, "要答完，不能静默");
    assert.equal(ctx.shell.startedProcs.length, before, "不起第二条");
  });

  it("宿主没装作业注册表时：答不可用、交还占位，绝不起一条没人管的 zg", async () => {
    const ctx = makeCtx();
    ctx.noJobs = true;
    applyTo(ctx);
    const root = bareWs("bg");
    await assert.rejects(
      () =>
        toolOf(ctx, "zg_index").execute({ root, confirm: true, background: true }, execOf(root)),
      /ctx\.jobs/u,
    );
    assert.equal(ctx.shell.startedProcs.length, 0, "起一条没人收的 zg 比不起更糟");
    // 占位已交还：随后走前台重建不再被「在飞」挡住。
    ctx.noJobs = false;
    ctx.shell.runResults.push(okRun("DONE"));
    const out = await toolOf(ctx, "zg_index").execute(
      { root, confirm: true, rebuild: true },
      execOf(root),
    );
    assert.ok(out !== undefined);
  });

  it("spawn 抛错：交还占位并把原因交给模型，绝不留下永久「在飞」", async () => {
    const ctx = makeCtx();
    ctx.shell.startThrows = "error";
    applyTo(ctx);
    const root = bareWs("bg");
    await assert.rejects(
      () =>
        toolOf(ctx, "zg_index").execute({ root, confirm: true, background: true }, execOf(root)),
      /启动重建失败/u,
    );
    // 占位必须已交还：同一棵树随后仍能正常起一次前台重建。
    ctx.shell.startThrows = "none";
    ctx.shell.runResults.push(okRun("DONE"));
    const out = await toolOf(ctx, "zg_index").execute(
      { root, confirm: true, rebuild: true },
      execOf(root),
    );
    assert.ok(out !== undefined);
  });

  it("登记时注册表已被换掉：收掉刚起的 zg、拒登记，并交还占位", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = bareWs("bg");
    trackRoot(ctx, root);
    // spawn 那一拍之后 jobs 消失 → 登记时才发现服务没了。
    ctx.shell.vanishJobsAfterExecute = 1;
    await assert.rejects(
      () =>
        toolOf(ctx, "zg_index").execute({ root, confirm: true, background: true }, execOf(root)),
      /ctx\.jobs/u,
    );
    assert.equal(ctx.shell.startedProcs[0]?.killCount, 1, "没人管的 zg 要收掉");
  });

  it("后台建索引同样与设置卡的重建互斥（占位在第一个 await 之前就抢）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = bareWs("bg");
    trackRoot(ctx, root);
    const res = await postRebuild(ctx, root);
    assert.equal(res.statusCode, 200, res.body);
    const before = ctx.shell.startedProcs.length;
    const out = (await toolOf(ctx, "zg_index").execute(
      { root, confirm: true, background: true },
      execOf(root),
    )) as { text: string };
    assert.ok(out.text.length > 0, "要答完");
    assert.equal(ctx.shell.startedProcs.length, before, "卡片那条已在跑，不得另起");
  });
});

describe("宿主没有会话存储时的降级", () => {
  it("上溯停在已知的最后一跳，功能不中断（仍不阻断任何调用）", async () => {
    const ctx = makeCtx();
    ctx.noSessions = true;
    applyTo(ctx);
    const root = ws("nosess");
    // 查不到任何父 → 键就是自己的 id，主代理自己搜自己用得着。
    ctx.shell.runResults.push(okRun("HITS"));
    await toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root, "main"));
    const verdict = guardOf(ctx)({
      name: "bash",
      arguments: { command: "grep foo" },
      agent: { session: { id: "main", header: { cwd: root } } },
    });
    assert.equal(verdict, undefined, "没有会话存储也不该把功能关掉");
  });

  it("子代理带 parentSession 时退到父会话，而不是无视它", async () => {
    const ctx = makeCtx();
    ctx.noSessions = true;
    applyTo(ctx);
    const root = ws("nosess");
    ctx.shell.runResults.push(okRun("HITS"));
    await toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root, "main"));
    const verdict = guardOf(ctx)({
      name: "bash",
      arguments: { command: "grep foo" },
      agent: { session: { id: "child", header: { cwd: root, parentSession: "main" } } },
    });
    assert.equal(verdict, undefined, "一跳之内仍能对上主代理的额度");
  });
});

const ROOT_SESSION = "root-session";
/** 兄弟子代理树：两个子代理都挂在 mid 下，mid 再挂到根会话。 */
const SIBLING_TREE: Record<string, string> = { kidA: "mid", kidB: "mid", mid: ROOT_SESSION };

// ── 常驻表的有效期与最近使用淘汰 ──
//
// 两张表原来都按插入序淘汰。一张「每次成功检索都重置同一批键」的表永远淘汰不掉真正冷掉
// 的项，而一条很久没被碰过的键一直占位；且一个上月开过的工作区不该今天还占着白名单名额。
// 改成「命中即触摸 + 先按有效期、再按最近使用淘汰」。
/** 非法 root 的样本：相对路径（非绝对）。 */
const RELATIVE_ROOT = "relative/path";

/** 白名单用例里的第 n 号工作区路径。 */
function wsRoot(index: number): string {
  return `/ws/root-${String(index)}`;
}

describe("工作区白名单的有效期与最近使用", () => {
  const root = wsRoot;

  it("命中即触摸：常被查到的那条不会被更早插入的冷条挤掉", () => {
    const now = 1000;
    const ledger = createRootLedger(MESSAGES.zh, 2, () => now, 60_000);
    ledger.add(root(1));
    ledger.add(root(2));
    assert.equal(ledger.has(root(1)), true, "先碰一下 1，把它挪到队尾");
    ledger.add(root(3));
    assert.equal(ledger.has(root(1)), true, "1 最近用过，不该被 2 挤掉");
    assert.equal(ledger.has(root(2)), false, "2 最久没用过，先走");
  });

  it("有效期：很久没被提到的条目直接失效，且不再占名额", () => {
    let now = 1000;
    const ledger = createRootLedger(MESSAGES.zh, 8, () => now, 500);
    ledger.add(root(1));
    now = 1400;
    assert.equal(ledger.has(root(1)), true, "还没到有效期");
    now = 1600;
    assert.equal(ledger.has(root(1)), false, "过了有效期");
  });

  it("有效期与容量两条同时成立：过期先被清掉，冷条才轮到最近使用淘汰", () => {
    let now = 1000;
    const ledger = createRootLedger(MESSAGES.zh, 2, () => now, 200);
    ledger.add(root(1));
    now = 1150;
    ledger.add(root(2));
    // root(1) 已过期，root(2) 仍有效
    now = 1300;
    ledger.add(root(3));
    assert.equal(ledger.has(root(2)), true, "仍有效的条不该被过期清理误伤");
    assert.deepEqual(ledger.list().length, 2, "上界仍是 2");
  });

  it("非法 root 不进表（相对路径 / 越界）", () => {
    const ledger = createRootLedger(MESSAGES.zh, 8, () => 1000, 60_000);
    ledger.add(RELATIVE_ROOT);
    ledger.add("/ws/../..");
    assert.deepEqual(ledger.list(), []);
    assert.equal(ledger.has(RELATIVE_ROOT), false);
    assert.equal(ledger.has("/ws/ok"), false);
  });
});

describe("解锁表的最近使用淘汰", () => {
  it("重新检索即刷新时效：额度在窗内一直可用", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("lru");
    const search = async (id: string): Promise<unknown> => {
      ctx.shell.runResults.push(okRun("HITS"));
      return toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root, id));
    };
    await search("s1");
    await search("s3");
    await search("s1");
    const canGrep = (id: string): boolean =>
      guardOf(ctx)({
        name: "grep",
        arguments: { path: root },
        agent: { session: { id, header: { cwd: root } } },
      }) === undefined;
    assert.equal(canGrep("s1"), true, "s1 有额度");
    assert.equal(canGrep("s3"), true, "s3 有额度");
  });
});

/** 造一个「有 .zvec-grep 目录」但清单内容任给的工作区。 */
function withWorkspaceManifest(name: string, body: string): string {
  const dir = bareWs(name);
  mkdirSync(path.join(dir, ZG_INDEX_DIR), { recursive: true });
  writeFileSync(path.join(dir, ZG_INDEX_DIR, ZG_MANIFEST_FILE), body);
  return dir;
}

/** 起一个已 apply 的上下文。 */
function appliedCtx(): MockCtx {
  const ctx = makeCtx();
  applyTo(ctx);
  return ctx;
}

/** 在一个已建索引的工作区上跑一次检索，stdout 固定为 OUT，stderr 任给。 */
async function searchWithStderr(stderr: string): Promise<string> {
  const ctx = appliedCtx();
  const root = ws("stderr");
  const result = okRun("OUT");
  result.stderr.text = stderr;
  ctx.shell.runResults.push(result);
  const out = (await toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root))) as {
    text: string;
  };
  return out.text;
}

// ── 成功执行的 stderr 分类 ──
//
// zg 在成功时也往 stderr 写索引进度（非 TTY 下逐行落盘）。这些行每次建索引都在，写进回执
// 只是噪声；真正要交回的是降级提示、锁冲突与任何**不认识**的新告警——所以判据是「只丢
// 认得的进度行」，而不是「只留认得的告警」。
describe("成功执行的 stderr 分类", () => {
  const runWithStderr = searchWithStderr;

  it("整段都是索引进度 → 一句注脚都不加", async () => {
    const text = await runWithStderr(
      ["Scanning files...", "Preparing local/qwen3-embedding-0.6b", "Indexing complete", ""].join(
        "\n",
      ),
    );
    assert.equal(text, "OUT", `不该有任何注脚：${text}`);
  });

  it("降级提示原样交回（进度行滤掉、告警留下）", async () => {
    const text = await runWithStderr(
      [
        "Scanning files...",
        "warning: --refresh background requires Server mode; Direct mode uses --refresh off",
      ].join("\n"),
    );
    assert.ok(text.includes("refresh background requires Server mode"), text);
    assert.ok(!text.includes("Scanning files"), "进度行要滤掉");
  });

  it("部分文件失败的信号必须留着：Indexing completed with N failed file(s)", async () => {
    const text = await runWithStderr(
      ["Indexing complete", "Indexing completed with 3 failed files"].join("\n"),
    );
    assert.ok(
      text.includes("3 failed files"),
      `字面上以「Indexing complete」开头，不能被前缀误伤：${text}`,
    );
  });

  it("不认识的新告警一律留下（只丢认得的进度行，不做白名单式过滤）", async () => {
    const text = await runWithStderr(
      ["Something Entirely New Appeared In zg 9.9", "Downloading model · 42% · 1.0 MB/2.0 MB"].join(
        "\n",
      ),
    );
    assert.ok(text.includes("Entirely New"), text);
    assert.ok(!text.includes("Downloading"), "下载进度是噪声");
  });

  it("signalStderr 直测：空白行一并去掉，保留顺序", () => {
    assert.equal(signalStderr(""), "");
    assert.equal(signalStderr("\n\n  \n"), "");
    assert.equal(signalStderr("Model ready: m\nwarning: w\n"), "warning: w");
    assert.equal(signalStderr("Indexing complete\nIndexing complete\n"), "");
  });
});

// ── 索引探测：清单结构与根路径覆盖 ──
//
// 只判「文件在不在」会把两种实况误判成有索引：文件在但不是一份清单，以及清单在但根路径
// 不覆盖这个目录（此时在该目录检索必然失败，而门禁却按「已建索引」拦着 grep/rg）。
describe("索引探测的清单校验", () => {
  const withManifest = withWorkspaceManifest;
  const makeApplied = appliedCtx;

  it("结构完整的清单且根路径覆盖本目录 → 判为有索引", () => {
    const dir = bareWs("ok");
    makeIndexed(dir);
    // 有索引 ⇒ 门禁拦 grep（尚未检索过）。
    const ctx = makeApplied();
    const reason = guardOf(ctx)({
      name: "grep",
      arguments: { path: dir },
      agent: { session: { id: "probe", header: { cwd: dir } } },
    });
    assert.notEqual(reason, undefined, "合法清单应被认成已建索引");
  });

  it("清单不是 JSON / 缺字段 / rootPaths 为空 → 判为无索引（不因为坏文件把门禁关死）", () => {
    for (const body of [
      "not json at all",
      "{}",
      JSON.stringify({ manifestVersion: 1 }),
      JSON.stringify({ manifestVersion: 1, rootPaths: [] }),
      JSON.stringify({ manifestVersion: 1, rootPaths: [{ recursive: true }] }),
    ]) {
      const dir = withManifest("bad", body);
      const ctx = makeApplied();
      const reason = guardOf(ctx)({
        name: "grep",
        arguments: { path: dir },
        agent: { session: { id: "probe", header: { cwd: dir } } },
      });
      assert.equal(reason, undefined, `这份清单不该被认成索引：${body}`);
    }
  });

  it("清单在但根路径指向别处 → 判为无索引（在该目录检索本来就会失败）", () => {
    const dir = withManifest(
      "other",
      JSON.stringify({
        manifestVersion: 1,
        rootPaths: [{ absolutePath: "/somewhere/else", recursive: true }],
      }),
    );
    const ctx = makeApplied();
    const reason = guardOf(ctx)({
      name: "grep",
      arguments: { path: dir },
      agent: { session: { id: "probe", header: { cwd: dir } } },
    });
    assert.equal(reason, undefined, "覆盖不到本目录就不算有索引");
  });

  it("清单写的是解析过的 /private 前缀、调用方给的是未解析形式", () => {
    const dir = bareWs("private");
    mkdirSync(path.join(dir, ZG_INDEX_DIR), { recursive: true });
    // 实测上游清单里的 absolutePath 是**未解析**那一支，而调用方完全可能交来解析过的形式。
    // 两边都再剥一次 /private 前缀再比，故两种写法都能对上。
    writeFileSync(
      path.join(dir, ZG_INDEX_DIR, ZG_MANIFEST_FILE),
      JSON.stringify({
        manifestVersion: 1,
        rootPaths: [{ absolutePath: `/private${dir}`, recursive: true }],
      }),
    );
    const ctx = makeApplied();
    const reason = guardOf(ctx)({
      name: "grep",
      arguments: { path: dir },
      agent: { session: { id: "probe", header: { cwd: dir } } },
    });
    assert.notEqual(reason, undefined, "两种写法指同一处，不该判成无索引");
  });

  it("清单在但缺 manifestVersion → 判为无索引", () => {
    const dir = withManifest(
      "noversion",
      JSON.stringify({ rootPaths: [{ absolutePath: "/x", recursive: true }] }),
    );
    const ctx = makeApplied();
    const reason = guardOf(ctx)({
      name: "grep",
      arguments: { path: dir },
      agent: { session: { id: "probe", header: { cwd: dir } } },
    });
    assert.equal(reason, undefined, "不是本包认的清单版本");
  });

  it("清单版本不是当前认的那一版 → 判为无索引（上游读它会硬失败，索引一次也读不了）", () => {
    // 上游 isWorkspaceManifest 要求 manifestVersion 严格等于 CURRENT_MANIFEST_VERSION，
    // 不等就抛 MANIFEST.INVALID。此处若宽松放行，门禁会按「已建索引」拦住 grep/rg，
    // 而 zg_search 每次都只会撞上那个硬失败——用户等于被卡死在没有出口的状态。
    // 根路径一律写成本目录，确保命中的判据只有版本这一条。
    for (const version of [2, 0, "1", null, undefined]) {
      const dir = bareWs(`ver${String(version)}`);
      const body: Record<string, unknown> = {
        rootPaths: [{ absolutePath: dir, recursive: true }],
      };
      if (version !== undefined) {
        body["manifestVersion"] = version;
      }
      mkdirSync(path.join(dir, ZG_INDEX_DIR), { recursive: true });
      writeFileSync(path.join(dir, ZG_INDEX_DIR, ZG_MANIFEST_FILE), JSON.stringify(body));
      const ctx = makeApplied();
      const reason = guardOf(ctx)({
        name: "grep",
        arguments: { path: dir },
        agent: { session: { id: "probe", header: { cwd: dir } } },
      });
      assert.equal(reason, undefined, `版本 ${String(version)} 不该被认成可检索索引`);
    }
  });
});

describe("子代理共享检索解锁", () => {
  it("主代理搜过之后，它的子代理立刻能用那份额度（不必自己再搜一次）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("deleg");
    // child -> main（子代理会话挂在主会话下）
    ctx.sessionLinks = { child: "main" };
    ctx.shell.runResults.push(okRun("HITS"));
    await toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root, "main"));
    assert.equal(
      grepVerdict(ctx, root, "child", "main"),
      undefined,
      "子代理应共享主代理那次检索解锁的额度",
    );
  });

  it("额度在整棵树上一起扣，不是每个子代理各得一份", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("deleg");
    ctx.sessionLinks = SIBLING_TREE;
    ctx.shell.runResults.push(okRun("HITS"));
    await toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root, ROOT_SESSION));
    // 默认额度 3：三个身份（两个兄弟子代理 + 它们的父）连用三次，第四次该被拦。
    assert.equal(grepVerdict(ctx, root, "kidA", "mid"), undefined);
    assert.equal(grepVerdict(ctx, root, "kidB", "mid"), undefined);
    assert.equal(grepVerdict(ctx, root, "mid", ROOT_SESSION), undefined);
    assert.notEqual(grepVerdict(ctx, root, "kidA", "mid"), undefined, "总额度用尽后应被拦");
  });

  it("另一棵委派树不共享（各有各的额度）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("deleg");
    ctx.sessionLinks = { childA: "mainA", childB: "mainB" };
    ctx.shell.runResults.push(okRun("HITS"));
    await toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(root, "mainA"));
    assert.equal(grepVerdict(ctx, root, "childA", "mainA"), undefined);
    assert.notEqual(grepVerdict(ctx, root, "childB", "mainB"), undefined, "另一棵树没有检索证据");
  });

  it("穷举检索仍不发配额：子代理也一样拿不到", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("deleg");
    ctx.sessionLinks = { child: "main" };
    ctx.shell.runResults.push(okRun("RESULT"));
    await toolOf(ctx, "zg_search").execute({ root, query: "x", rg: true }, execOf(root, "main"));
    assert.notEqual(grepVerdict(ctx, root, "child", "main"), undefined);
  });
});

describe("穷举词法检索通道", () => {
  it("无索引：自动改走 --rg，并在结果前显式声明这次是字面匹配", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = bareWs();
    ctx.shell.runResults.push(okRun("src/a.ts\n  1: hit"));
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "hit" }, execOf(root))) as {
      text: string;
    };
    assert.equal(
      ctx.shell.resolveCalls[0]?.command,
      "zg query --rg 'hit' --limit 10 --device 'auto' --mode auto",
    );
    assert.ok(
      out.text.startsWith(MESSAGES.zh.exhaustiveFallbackNote),
      "自动改道必须声明，否则就是静默给出与请求不符的答案",
    );
    assert.ok(out.text.endsWith("src/a.ts\n  1: hit"));
  });

  it("有索引：照常走索引检索，不加那条声明", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws();
    ctx.shell.runResults.push(okRun("RESULT"));
    const out = (await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root))) as {
      text: string;
    };
    assert.equal(ctx.shell.resolveCalls[0]?.command, INDEXED_SEARCH_COMMAND);
    assert.ok(!out.text.includes("穷举"), "有索引就不该出现穷举声明");
  });

  it("祖先目录有索引时也算「有索引」（与 zg 向上找索引的行为一致）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws();
    const child = path.join(root, "packages", "app");
    mkdirSync(child, { recursive: true });
    ctx.shell.runResults.push(okRun("RESULT"));
    await toolOf(ctx, "zg_search").execute({ root: child, query: "hi" }, execOf(child));
    assert.ok(
      !(ctx.shell.resolveCalls[0]?.command ?? "").includes("--rg"),
      "子目录应沿用祖先索引，不该退化成穷举",
    );
  });

  it("rg=true 显式要求穷举：即使有索引也走 --rg，且不加自动改道声明", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws();
    ctx.shell.runResults.push(okRun("RESULT"));
    const out = (await toolOf(ctx, "zg_search").execute(
      { root, query: "hi", rg: true },
      execOf(root),
    )) as { text: string };
    assert.ok((ctx.shell.resolveCalls[0]?.command ?? "").startsWith("zg query --rg 'hi'"));
    assert.equal(out.text, "RESULT", "模型自己要的就不要再加旁白");
  });

  it("rg=false 显式只要索引检索：无索引时不静默改道，交给 zg 报未建索引", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = bareWs();
    ctx.shell.runResults.push(okRun("RESULT"));
    await toolOf(ctx, "zg_search").execute({ root, query: "hi", rg: false }, execOf(root));
    assert.ok(!(ctx.shell.resolveCalls[0]?.command ?? "").includes("--rg"));
  });

  it("穷举模式不发放 grep/rg 配额：不读索引就不构成「先用过语义检索」", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    // 索引在祖先上、穷举发生在子目录：配额发放的唯一判据就是「这次走的是索引检索」，
    // 所以这里 indexRoot 明明找得到，仍不该发。
    const root = ws();
    const child = path.join(root, "pkg");
    mkdirSync(child, { recursive: true });
    ctx.shell.runResults.push(okRun("RESULT"));
    await toolOf(ctx, "zg_search").execute({ root: child, query: "hi", rg: true }, execOf(child));
    const reason = guardOf(ctx)({
      name: "bash",
      arguments: { command: "grep foo" },
      agent: { session: { id: "sess-1", header: { cwd: child } } },
    });
    assert.notEqual(reason, undefined, "穷举检索后 grep/rg 仍应被门禁拦住");
  });

  it("索引检索成功仍照常发放配额（穷举那条不误伤正常路径）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws();
    ctx.shell.runResults.push(okRun("RESULT"));
    await toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root));
    const reason = guardOf(ctx)({
      name: "bash",
      arguments: { command: "grep foo" },
      agent: { session: { id: "sess-1", header: { cwd: root } } },
    });
    assert.equal(reason, undefined, "索引检索成功后 grep/rg 应被放行");
  });

  it("穷举模式收到索引侧参数即在构造阶段拒绝（不静默丢弃，也不丢给 zg 去失败）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = bareWs();
    await assert.rejects(
      () =>
        toolOf(ctx, "zg_search").execute(
          { root, query: "hi", rg: true, preview: "full" },
          execOf(root),
        ),
      /穷举检索（rg=true）与下列索引侧参数互斥：preview/u,
    );
    assert.equal(ctx.shell.resolveCalls.length, 0, "构造阶段就该停，不该起子进程");
  });
});

// ── root 授权 ──

/** 在指定会话工作区下检索一个根；结果直接交回调用方断言。 */
async function searchIn(ctx: MockCtx, root: string, cwd?: string): Promise<unknown> {
  ctx.shell.runResults.push(okRun("OK"));
  return toolOf(ctx, "zg_search").execute({ root, query: "x" }, execOf(cwd));
}

describe("root 授权", () => {
  it("缺省 root（会话工作区本身）：放行", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws();
    const out = await searchIn(ctx, root, root);
    assert.deepEqual(out, { text: "OK" });
  });

  it("显式 root 与会话工作区相同：放行", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws();
    const out = await searchIn(ctx, root, root);
    assert.deepEqual(out, { text: "OK" });
  });

  it("显式 root 是会话工作区的下级：放行（同一棵树）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const base = ws();
    const child = path.join(base, "packages");
    mkdirSync(child, { recursive: true });
    const out = await searchIn(ctx, child, base);
    assert.deepEqual(out, { text: "OK" });
  });

  it("显式 root 是会话工作区的上级：放行（同一棵树）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const base = ws();
    const child = path.join(base, "sub");
    mkdirSync(child, { recursive: true });
    const out = await searchIn(ctx, base, child);
    assert.deepEqual(out, { text: "OK" });
  });

  it("显式 root 与会话工作区毫无关系：拒", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const here = ws("here");
    const elsewhere = ws("elsewhere");
    await assert.rejects(() => searchIn(ctx, elsewhere, here), /未获授权/u);
  });

  it("没有会话工作区时，显式 root 一律拒（无从判断可操作范围）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const elsewhere = ws("elsewhere");
    await assert.rejects(() => searchIn(ctx, elsewhere), /未获授权/u);
  });

  it("前缀相同但不是祖先关系（/fo 与 /foo）：判为无关", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    // 造一对真实存在、且其中一个是另一个名字前缀的目录（/fo… 与 /fo…-x）。
    const base = mkdtempSync(path.join(tmpdir(), "zvec-fo-"));
    createdDirs.push(base);
    const prefixed = `${base}-x`;
    mkdirSync(prefixed, { recursive: true });
    createdDirs.push(prefixed);
    await assert.rejects(() => searchIn(ctx, prefixed, base), /未获授权/u);
  });

  it("被拒的调用不会把自己写进白名单：下一次仍然拒", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const here = ws("here");
    const elsewhere = ws("elsewhere");
    await assert.rejects(() => searchIn(ctx, elsewhere, here), /未获授权/u);
    await assert.rejects(() => searchIn(ctx, elsewhere, here), /未获授权/u);
  });

  it("授权通过后即入白名单：另一个会话可用同一根", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const first = ws("first");
    const second = ws("second");
    await searchIn(ctx, first, first);
    // 第二个会话并没有把 second 当工作区，但 first 已进白名单 ⇒ 放行。
    const out = await searchIn(ctx, first, second);
    assert.deepEqual(out, { text: "OK" });
  });

  it("工具实际用过的 root 进入重建候选列表", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws();
    await searchIn(ctx, root, root);
    const access = fetchAccess(ctx);
    assert.ok(access.roots.includes(root), "显式用过的根应出现在重建候选里");
  });

  it("等价的路径写法归到同一个白名单键", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const base = ws();
    await searchIn(ctx, `${base}/./`, base);
    await searchIn(ctx, `${base}//`, base);
    const access = fetchAccess(ctx);
    assert.equal(access.roots.filter((entry) => entry === base).length, 1);
  });

  it("建索引同样受授权约束", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const here = ws("here");
    const elsewhere = ws("elsewhere");
    await assert.rejects(
      () => toolOf(ctx, "zg_index").execute({ root: elsewhere, confirm: true }, execOf(here)),
      /未获授权/u,
    );
  });
});

// ── 重建期检索通道 ──────────────────────────────────────────────────────────

describe("重建期检索通道", () => {
  it("等待期间被取消：按中止收口而不是继续挂着", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws();
    const started = await rebuildInFlight(ctx, root);
    ctx.shell.runResults.push(lockBusyRun());
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () =>
        toolOf(ctx, "zg_search").execute(
          { root, query: "hi" },
          { ...execOf(), signal: controller.signal },
        ),
      /中止|aborted/iu,
    );
    await started.release();
  });

  it("占锁方不是重建（如别的进程在索引）：不排队，直接报原失败", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws();
    await rebuildInFlight(ctx, root);
    ctx.shell.runResults.push(lockBusyRun("index"));
    await assert.rejects(
      () => toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root)),
      /索引不可用|Index unavailable|exit/iu,
    );
  });

  it("重建期状态查询：合成投影而不是再问一次 zg", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws();
    const started = await rebuildInFlight(ctx, root);
    const out = await toolOf(ctx, "zg_status").execute({ root }, execOf(root));
    assert.match((out as { text: string }).text, /正在重建/u);
    assert.equal(ctx.shell.runResults.length, 0, "锁忙期不该再起一条 zg status");
    await started.release();
  });

  it("祖先根在重建：子目录的状态查询也给合成投影（等待与门禁必须是同一个口径）", async () => {
    // 门禁那一侧先 findIndexRoot 找到祖先索引根，本来就会放行；等待/投影若还按精确键查，
    // 子目录查询就会漏掉那条重建、撞一条裸 LOCK.BUSY。
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("anc");
    const child = path.join(root, "pkg");
    mkdirSync(child, { recursive: true });
    const started = await rebuildInFlight(ctx, root);
    const out = await toolOf(ctx, "zg_status").execute({ root: child }, execOf(root));
    const { text } = out as { text: string };
    assert.match(text, /正在重建/u);
    // 投影里点名的是**真正在重建的那个根**，不是提问的那个子目录。
    assert.ok(text.includes(root), "投影应点名重建根");
    assert.equal(ctx.shell.runResults.length, 0, "锁忙期不该再起一条 zg status");
    await started.release();
  });

  it("兄弟目录在重建：另一个子目录既不合成投影也不等待（不同树互不影响）", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const base = ws("tree");
    const left = path.join(base, "left");
    const right = path.join(base, "right");
    mkdirSync(left, { recursive: true });
    mkdirSync(right, { recursive: true });
    const started = await rebuildInFlight(ctx, left);
    ctx.shell.runResults.push(okRun("RIGHT-OK"));
    const out = await toolOf(ctx, "zg_status").execute({ root: right }, execOf(base));
    assert.doesNotMatch((out as { text: string }).text, /正在重建/u);
    assert.match((out as { text: string }).text, /RIGHT-OK/u);
    await started.release();
  });

  it("同根正在重建：检索等其落定后自动重试一次", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws();
    const started = await rebuildInFlight(ctx, root);
    ctx.shell.runResults.push(lockBusyRun(), okRun("AFTER"));
    const pending = toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root));
    // 先让检索跑到「等重建落定」那一步，再落定：顺序反了它根本不会走等待分支
    // （占位一交还，重建就不再「活跃」，检索会直接原样失败）。
    await microTicks(8);
    await started.release();
    const out = await pending;
    assert.match((out as { text: string }).text, /^AFTER/u);
    // 两次结果都被消费掉才说明「锁忙 → 等 → 重试」整条路真的走过一遍。
    assert.equal(ctx.shell.runResults.length, 0, "重试那一次应当把第二条结果也用掉");
  });

  it("祖先根在重建：子目录的检索同样等它落定后自动重试一次", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws("ancq");
    const child = path.join(root, "pkg");
    mkdirSync(child, { recursive: true });
    const started = await rebuildInFlight(ctx, root);
    ctx.shell.runResults.push(lockBusyRun(), okRun("AFTER"));
    const pending = toolOf(ctx, "zg_search").execute({ root: child, query: "hi" }, execOf(root));
    await microTicks(8);
    await started.release();
    const out = await pending;
    assert.match((out as { text: string }).text, /^AFTER/u);
    assert.equal(ctx.shell.runResults.length, 0, "子目录也该走完「锁忙 → 等 → 重试」");
  });

  it("无关根在重建：本目录的锁忙原样抛出，不替别人的重建干等", async () => {
    // covering 只认「重建根是查询根的祖先或同一处」：别的树上那条重建占的锁与本次无关，
    // 替它等只会把一次快速失败拖成一次长超时。
    const ctx = makeCtx();
    applyTo(ctx);
    const base = ws("trees");
    const left = path.join(base, "left");
    const right = path.join(base, "right");
    mkdirSync(left, { recursive: true });
    mkdirSync(right, { recursive: true });
    const started = await rebuildInFlight(ctx, left);
    ctx.shell.runResults.push(lockBusyRun());
    await assert.rejects(
      () => toolOf(ctx, "zg_search").execute({ root: right, query: "hi" }, execOf(base)),
      /索引不可用|Index unavailable|exit/iu,
    );
    await started.release();
  });

  it("等待落定超时：不发放配额，给出可行动文案", async () => {
    const ctx = makeCtx();
    applyTo(ctx, { rebuildWaitMs: 1 });
    const root = ws();
    const started = await rebuildInFlight(ctx, root);
    ctx.shell.runResults.push(lockBusyRun());
    await assert.rejects(
      () => toolOf(ctx, "zg_search").execute({ root, query: "hi" }, execOf(root)),
      /重建/iu,
    );
    await started.release();
  });

  it("同根第二次重建：复用已在跑的那条，不再起第二条进程", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const other = ws("other");
    trackRoot(ctx, other);
    const first = await postRebuild(ctx, other);
    assert.equal(first.statusCode, 200, first.body);
    const root = ws();
    trackRoot(ctx, root);
    const second = await postRebuild(ctx, root);
    assert.equal(second.statusCode, 200, second.body);
    const before = ctx.shell.startedProcs.length;
    const secondBody = JSON.parse(second.body) as { jobId?: string };
    const secondJobId = String(secondBody.jobId);
    const again = await postRebuild(ctx, root);
    assert.equal(again.statusCode, 200, again.body);
    const reusedBody = JSON.parse(again.body) as {
      ok?: boolean;
      jobId?: string;
      reused?: boolean;
    };
    assert.equal(reusedBody.reused, true, "第二次应复用已在跑的那条");
    assert.equal(reusedBody.jobId, secondJobId, "复用的应是上一条作业，不是新起的");
    assert.equal(reusedBody.ok, true);
    assert.equal(ctx.shell.startedProcs.length, before, "并发重建不得再 spawn 一条");
    await settleRebuilds(ctx, 0);
  });

  it("两条重建请求真正并发：占位互斥，第二条要么复用要么明确答复", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws();
    trackRoot(ctx, root);
    // 不逐个 await：两条请求会各自跨过 spawn 的那次让出，正是竞态窗口本身。
    const both = Promise.all([postRebuild(ctx, root), postRebuild(ctx, root)]);
    const pair = await both;
    for (const res of pair) {
      assert.ok(res.statusCode === 200 || res.statusCode === 409, res.body);
    }
    // 无论走复用还是在飞未就绪，都必须**有应答**：无应答会让卡片停止轮询，
    // 那条重建就在界面上凭空消失。
    assert.equal(ctx.shell.startedProcs.length, 1, "并发只允许起一条 zg");
    await settleRebuilds(ctx, 0);
  });

  it("重建刚占位、作业号还没签发时：状态投影明说在启动而不是报个空号", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws();
    trackRoot(ctx, root);
    // 与重建请求并发地问状态：查询落在「占位已登记、作业号尚未签发」那一档。
    const [res] = await Promise.all([
      postRebuild(ctx, root),
      toolOf(ctx, "zg_status").execute({ root }, execOf(root)),
    ]);
    assert.equal(res.statusCode, 200);
    await settleRebuilds(ctx, 0);
  });

  it("前台 zg_index 重建：同根已在重建时明确拒绝，不再起第二条", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws();
    const started = await rebuildInFlight(ctx, root);
    const before = ctx.shell.runResults.length;
    const rejected = await toolOf(ctx, "zg_index").execute(
      { root, confirm: true, rebuild: true },
      execOf(root),
    );
    assert.match((rejected as { text: string }).text, /已有一条重建/u);
    assert.equal(ctx.shell.runResults.length, before, "被拒的调用不该起 zg");
    await started.release();
  });

  it("前台 zg_index 重建落定后：占位已交还，同根可再次重建", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws();
    ctx.shell.runResults.push(okRun("INDEXED"));
    const out = await toolOf(ctx, "zg_index").execute(
      { root, confirm: true, rebuild: true },
      execOf(root),
    );
    assert.deepEqual(out, { text: "INDEXED" });
    // 占位已交还 ⇒ 状态查询走真读索引，而不是被「重建中」投影挡住。
    ctx.shell.runResults.push(okRun("READY"));
    const again = await toolOf(ctx, "zg_status").execute({ root }, execOf(root));
    assert.deepEqual(again, { text: "READY" });
  });

  it("重建落定后状态查询回到真读索引", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = ws();
    const started = await rebuildInFlight(ctx, root);
    await started.release();
    ctx.shell.runResults.push(okRun("READY"));
    const out = await toolOf(ctx, "zg_status").execute({ root }, execOf(root));
    assert.deepEqual(out, { text: "READY" });
  });

  it("重建期放行根内 grep/rg：这是「检索失败 + grep 也被拦」双重死锁的出口", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const root = makeIndexedTemp();
    await rebuildInFlight(ctx, root);
    const reason = guardOf(ctx)({
      name: "bash",
      arguments: { command: "grep foo src" },
      agent: { session: { id: "sess-1", header: { cwd: root } } },
    });
    assert.equal(reason, undefined, "重建期该根内检索应放行");
  });

  it("重建放行不越过索引根：换一棵树仍按原门禁拦", async () => {
    const ctx = makeCtx();
    applyTo(ctx);
    const rebuilt = makeIndexedTemp();
    const other = makeIndexedTemp();
    await rebuildInFlight(ctx, rebuilt);
    const reason = guardOf(ctx)({
      name: "bash",
      arguments: { command: "grep foo" },
      agent: { session: { id: "sess-1", header: { cwd: other } } },
    });
    assert.notEqual(reason, undefined, "另一棵索引树没有活跃重建，仍应被拦");
  });
});
