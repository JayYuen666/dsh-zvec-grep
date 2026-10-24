// lib/rebuild-remote.ts —— 设置卡「工作区重建」的**宿主读面**（官方 Typert Remote）+ 它
// 背后的作业编排。
//
// 为什么是 Remote：重建是宿主进程里的动作（占位、官方作业注册表、zg 子进程），而卡片跑在
// 浏览器里。设置面没有「宿主执行动作」的口子（`ctx.settings` 只有 configure/describe/
// update/replace/mutate），唯一的官方通道就是 Typert Remote —— 官方
// `permission-presets` 正是这么把进程级目录交给客户端 UI 的。
//
// 为什么手写 descriptor 而不跑生成器：官方网关在源模式（SRC）下从**方法签名**推出参数名，
// 参数与结果都用 `{ mode: "src-json" }` 编解码；这两样都不需要生成器的 `typeSymbol` /
// `create()` 产物。本服务的三个方法都是「一元、JSON 出参」，手写 client descriptor 比引入
// 一条构建期代码生成链（外加生成物随包发布）便宜得多。
//
// ⚠ 值导入面：`TypertRemoteService` 是个**类**（要 `extends`），没有 type-only 的造法，
// 因此它落 `peerDependencies`（`dependencies` 是禁区，由 test/publish-manifest.test.ts
// 钉着），产物里保持**裸说明符**（build-host.mjs 的外部化名单读 dependencies ∪
// peerDependencies）。
//
// 安全边界不再靠 HTTP 面那两道锁：这条读面只经官方网关暴露给**本 profile 的客户端**，
// 参数又只有 `{ root }` / `{ jobId }` 两个串。工作区白名单、绝对路径归一、目录存在、
// 以及「jobId 不在本包侧表里就不代读别人作业」全部原样留在下面的方法体里——它们护的是
// 动作本身，与传输方式无关。

import { existsSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type {
  JobId,
  JobOutputRead,
  JobOutputSource,
  JobRegistry,
  JobSourceRead,
  JobSpec,
  JobStatus,
  JobView,
} from "@deepseek-ai/dsh-jobs";
import type { ShellExecution, ShellExecutor } from "@deepseek-ai/dsh-shell";
import type { TimerService } from "@deepseek-ai/cordis-plugin-timer";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
import { jobOutcomeOf } from "@jayyuen66/dsh-plugin-shared/lib/job-outcome";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { truncateStart } from "@jayyuen66/dsh-plugin-shared/lib/text";

import { assertAbsoluteRoot, buildIndexCommand } from "./cli.ts";
import type { IndexArgs } from "./cli.ts";
import { assertIgnoreFilesExist } from "./index-preflight.ts";
import { fill } from "./messages.ts";
import type { ZvecGrepMessages } from "./messages.ts";
import { procSandboxNote } from "./sandbox-note.ts";
import type { RebuildRegistry } from "./rebuild-state.ts";
import { REBUILD_REMOTE_NAMESPACE } from "./rebuild-shape.ts";
import type {
  RebuildRefusedStatus,
  RebuildRoots,
  RebuildStartRequest,
  RebuildStartResult,
  RebuildStatusRequest,
  RebuildStatusResult,
} from "./rebuild-shape.ts";
import { allowRemoteEmbedding, readClientMode, readDefaultEmbedding, zgEnv } from "./zg-config.ts";
import type { ZgDeployConfig } from "./zg-config.ts";

// 官方给生产者的 kind 扩展点（installed dsh-jobs/lib/types/view.d.ts 的 JobKindMap，
// dsh-tool-pwsh / dsh-tool-workflow 同款写法）：kind 既是 id 命名空间也是 id 前缀。
// 位置在 import 块之后：declare module 是一条语句，夹在 import 中间会让后面每条 import
// 都违反 import/first（ESM 下 import 本就被提升，先于模块体执行，挪动不改运行时行为）。
declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    "zvec-grep-rebuild": "zvec-grep-rebuild";
  }
}

/** 本包作业的 kind（宿主据此发出的 id 形如 `zvec-grep-rebuild-<hex>`）。 */
const REBUILD_JOB_KIND = "zvec-grep-rebuild";

/**
 * 本 kind 在注册表里的**已落定**记录上限：每次 start 前先剪到 `MAX-1` 条，新那条落定后
 * 正好 `MAX` 条在册（文案与卡片拒绝提示都按这个数说）。同时能跑几个不在这里——那是
 * 注册表的容量闸（实测未拥有桶 10，满员是**拒绝**新 start，不是淘汰旧的）。官方件**不会**
 * 自行回收落定记录（"A settled record stays listed until its owner's disposal, service
 * disposal, or an explicit remove"），而注册表又随宿主活着、不随本插件卸载而死 ⇒ 这条
 * 裁剪是本包的责任。
 */
const REBUILD_HISTORY_MAX = 10;

/** 卡片视图的尾部长度（打标文案在 lib/messages.ts，随语言走）。 */
const JOB_OUT_VIEW_CHARS = 4000;

/**
 * 官方 JobRegistry（@deepseek-ai/dsh-jobs，abstract Service → 名义比较）的方法面投影：
 * 本包用这七位。三条不是可选的：
 *  - `attachController`：官方件在「没有 controller 服务这个 owner」时**直接拒绝 start**
 *   （installed `@deepseek-ai/dsh-jobs-local` 里 `start` 的 `servesOwner` 判定，报错原文
 *   `background jobs unavailable: no job controller serves this agent`）。本包的作业是**未拥有**的，
 *   而未拥有作业只被 global 层服务；落哪一层由**访问方 ctx 的作用域**决定（复核后补测：
 *   同一枚注册表，从未绑作用域的插件 ctx attach ⇒ global 层非空、未拥有 start 放行）。
 *  - `get` / `readAt`：卡片投影的两个读数（状态与非消费的输出窗）。
 *  - `list`：历史窗口要按 kind 在**整个注册表**里找本包的已落定记录（卸载后的残留记录不在
 *   本包的侧表里，只清侧表等于把环留在宿主内存里）。
 */
export type JobsService = Pick<
  JobRegistry,
  "start" | "list" | "get" | "readAt" | "kill" | "remove" | "attachController"
>;

/** 重建编排真正用到的宿主两面（不取整个 HostCtx：这台服务的依赖面越小越好断言）。 */
export interface RebuildHost {
  shell: Pick<ShellExecutor, "resolve" | "execute">;
  timer: Pick<TimerService, "timeout">;
}

/** 工作区白名单的读面（宿主侧的 RootLedger 有 add，本模块只读）。 */
export interface RebuildLedger {
  list: () => string[];
  has: (root: string) => boolean;
}

/** 守护进程就绪门槛（与三条工具共用同一份缓存）。 */
export interface RebuildServerGate {
  ready: () => Promise<boolean>;
}

/** zg 版本门槛（与工具面共用同一份缓存，探测结果不该因入口不同而分叉）。 */
export interface RebuildVersionGate {
  ensure: (messages: ZvecGrepMessages) => Promise<void>;
}

/**
 * 起一条 `zg index` 写操作所需的那部分依赖。
 *
 * 单独成一层是因为它有**两类调用方**：设置卡的重建方法与模型侧的 `zg_index
 * background=true`。后者不是远程调用，过去要凑出整套路由依赖就得给 CSRF 塞空串、
 * 给非回环标志塞 `false`——两个哑值。收窄成这一层之后，哑值在类型上不再可能构造。
 */
export interface IndexWriteRoutes {
  host: RebuildHost;
  config: ZgDeployConfig;
  /** 现取一份文案（语言随官方 locale 偏好，改语言不必重载插件）。 */
  messages: () => ZvecGrepMessages;
  /** 官方注册表每次用时现读（理由见 ZvecRebuildService 的类文档）。 */
  jobsOf: () => JobsService | undefined;
  /** 本包侧表（引用共享：远程方法与模型侧后台索引、卸载效应读写同一张表）。 */
  records: Map<string, RebuildRecord>;
  /** 活跃重建状态源：远程方法与模型侧索引工具共用，占位互斥跨入口成立。 */
  rebuilds: RebuildRegistry;
  /** zg 版本门槛：起 zg 之前先过一道（与三条工具共用同一份缓存）。 */
  versionGate: RebuildVersionGate;
}

/** 重建读面的全部依赖：起写操作那一层 + 白名单与就绪态两位只读面。 */
export interface ZvecRebuildDeps extends IndexWriteRoutes {
  ledger: RebuildLedger;
  serverGate: RebuildServerGate;
}

/**
 * 侧表记录：官方注册表管身份、生命周期与输出环，这里只存**注册表给不出**的本包事实。
 *  - `proc`：沙箱事实与 `exitCode` 的现读来源（卡片契约要这两件，官方 JobView 没有槽）；
 *  - `root`：卡片要回显重建的是哪棵树；
 *  - `id`：宿主签发的那枚 `JobId`（品牌类型）。回注册表只用它，绝不把请求带来的字符串递进去；
 *  - `state`：这条作业的**可变**部分，见 {@link RebuildState}。
 *
 * 这里**不存注册表引用**：jobs 每次用时现读，于是服务被重载时侧表里的旧记录只会走
 * 「查无此条」那一臂，而不是继续往一枚已销毁的实例里读。
 */
export interface RebuildRecord {
  proc: ShellExecution;
  root: string;
  id: JobId;
  state: RebuildState;
}

/**
 * 一条作业的身份证：官方 `JobView` 上三段**值稳定**的事实（kind / label / startedAt）。
 *
 * 为什么不存「注册表实例引用」：`ctx.get("jobs")` 每读一次都会新建一枚 traceable 代理
 * （installed `@deepseek-ai/cordis/lib/index.js` 的 `getTraceable` → `createTraceable`，
 * 对带 tracker 的服务值恒返回新 Proxy），于是**同一枚服务**的两次读也不 `===`（实测：
 * 真实宿主里 `ctx.get("jobs") === ctx.get("jobs")` 为 false）。拿实例引用做身份比较在真实
 * 宿主上恒为假：轮询会对每条活着的重建报「查无此条」，卸载效应也只会 kill 进程而不 remove
 * 作业、把环留在宿主内存里。故身份必须由投影**值**推导。
 */
interface JobIdentity {
  readonly kind: JobView["kind"];
  readonly label: JobView["label"];
  readonly startedAt: JobView["startedAt"];
}

/** 从名册投影推导身份证（官方 `JobView` 的三段稳定事实）。 */
function identityOf(view: JobView): JobIdentity {
  return { kind: view.kind, label: view.label, startedAt: view.startedAt };
}

/** 两段身份证是否同一回事（三段全同才算）。 */
function sameIdentity(left: JobIdentity, right: JobIdentity): boolean {
  return (
    left.kind === right.kind && left.label === right.label && left.startedAt === right.startedAt
  );
}

/**
 * 身份证尚未盖章时的占位出生时刻。
 *
 * `startedAt` 由官方签发（`Date.now()`，永不为 0），而 kind/label 在 `start` 之前就已
 * 已知——那正是本包递给官方的那份规格。于是"start 的同步块里就跑到了 `run()`"那一档读取
 * 比对时必然落到"对不上"：那一刻还没有可比的出生时刻，不该把同 id 的另一条作业当成自己的收走。
 */
const UNSIGNED_STARTED_AT = 0;

/**
 * 名册里那条 id 是不是**我们**的那条作业。
 *
 * 只比 id 不够：id 是从请求里读进来的，名册里同 id 的那条完全可能是另一条作业（另一棵树、
 * 另一条命令），旧卡片跟上去就是串台。三段身份都由官方签发。
 */
function sameJob(state: RebuildState, view: JobView): boolean {
  return sameIdentity(state.identity, identityOf(view));
}

/**
 * 一条重建的**可变**状态，与 {@link RebuildRecord} 分开是有原因的：记录要等 `start` 交回 id
 * 与出生时刻才建得出来（在那之前进侧表，`run()` 抛错时就留下一条"名册不认、却永远钉着一枚
 * proc"的幽灵），而 `run()` 里的超时臂与源的读数必须先有一个能写的地方。两边共用这只盒子。
 *
 * 丢失记账为什么归我们：注册表的环只知道自己裁了头部（`output.earliest`，那是**显示**口径），
 * 而执行器的读者抛错或报 lossy 是"zg 的输出确实少了一段"——两者必须分开标，否则会把
 * "看不见了"说成"没跑出来"。
 */
interface RebuildState {
  /** 这条作业的身份证（kind/label/startedAt 三段）。`start` 交回投影前
   *  `startedAt` 是未盖章占位值（见 UNSIGNED_STARTED_AT）。 */
  identity: JobIdentity;
  /** 执行器的读者报 lossy 或抛错 ⇒ 真少了字节（与"环按留存窗裁过头部"分开标）。 */
  lost: boolean;
  /** 超时说明。不进环（环的写权归注册表的泵），由投影层合成。 */
  timeoutNote: string | null;
}

/**
 * 本包作业的输出面：官方 pull source，stdout/stderr 各一只游标，外加一层"读失败不许
 * 拖垮泵"的兜。选 pull 而不是生产者 push（`JobHandle.append`）是复核后按实测定下的：
 *  - `proc.observed[*].readFrom` 是**非消费**的独立观察者面（installed dsh-shell
 *    types.d.ts："without stealing bytes from `readOutput`"），与本包前台用的
 *    消费式游标互不干扰；
 *  - 泵按注册表自己的节拍跑（实测默认 150ms，落定前再排最后一次）⇒ **卡片关着环也前进**，
 *    模型侧 job_output 随时看得见进度；push 形态把可见性绑在了轮询上。
 * @param proc 后台进程句柄
 * @param state 这条重建的状态盒（见 {@link RebuildState}）
 * @returns 交给 JobSpec.output 的两条源
 */
function rebuildSources(proc: ShellExecution, state: RebuildState): JobOutputSource[] {
  return (["stdout", "stderr"] as const).map((channel) => {
    // 官方 `guardSource` 会把抛错的源读作"此后已尽"（实测：400ms 里第 3 抛之后不再敲第四下），
    // 但那道兜**只把抛错记进宿主日志，环里什么标记都不留** ⇒ 卡片看不出少了一段。本包因此
    // 自己兜一层：抛错转成"游标原地不动 + 空增量 + 记进 state.lost"。也正因为我们兜住了，
    // 官方的 exhausted 替身永远不会生效 ⇒ **闩得我们自己上**，否则每 150ms 敲一只已经坏掉的
    // 读者，一直敲到落定。
    let failed = false;
    return {
      channel,
      read: (fromByte: number): JobSourceRead => {
        if (failed) {
          return { text: "", nextOffset: fromByte, lossy: true };
        }
        try {
          const read = proc.observed[channel].readFrom(fromByte);
          if (read.lossy) {
            state.lost = true;
          }
          return read;
        } catch {
          state.lost = true;
          failed = true;
          return { text: "", nextOffset: fromByte, lossy: true };
        }
      },
    };
  });
}

/** 官方件对未知/已淘汰 id 抛错；本包的判据要的是"有没有"，不是异常（无 ⇒ null）。 */
function jobView(jobs: JobsService, id: JobId): JobView | null {
  try {
    return jobs.get(id);
  } catch {
    return null;
  }
}

/** 一次成对读数：状态投影 + 留存窗内容；注册表已无此 id ⇒ null。 */
function readRebuildOutput(
  jobs: JobsService,
  id: JobId,
): { view: JobView; retained: JobOutputRead } | null {
  // 侧表里有、注册表里没有是**合法事件**（宿主重载了 jobs 那一行 ⇒ 它清空名册，而我们
  // 手里的记录还在）。必须折成 null 让调用方回答「查无此条」，绝不能让异常抛穿到网关：
  // 卡片只会在那一轮看到一条笼统的失败，然后停掉轮询。
  try {
    return { view: jobs.get(id), retained: jobs.readAt(id, 0) };
  } catch {
    return null;
  }
}

/** 官方 JobStatus 里"仍在跑"的两枚：`stopping` 是取消已发出、进程还没收完。 */
function isLiveStatus(status: JobStatus): boolean {
  return status === "running" || status === "stopping";
}

/**
 * 收掉子进程，**忽略抛错**：进程可能已自然退出或已被系统回收，此时 kill 失败不是本包的失败。
 * 调用点都在清理臂（卸载、被拒、超时）上，那里没有可行动的下一步；把异常抛出去只会让清理链
 * 半途而废，留下更难的现场。
 */
function killProc(proc: Pick<ShellExecution, "kill">): void {
  try {
    proc.kill();
  } catch {
    // 忽略
  }
}

/**
 * 历史窗口有界：按注册表的**可见集合**淘汰本 kind 最老的已落定记录。
 *
 * 剪到**只剩 `MAX-1` 条**才是对的：这一剪发生在 start 之前，紧接着就有一条新作业进来，
 * 它落定之后名册里正好是最近 `MAX` 条已落定记录 ⇒ 与卡片文案「只保留最近 10 条已结束的重建」
 * 同一口径。判据的时点是**新作业落定之后**，不是剪完那一刻——只看后者会把这条判反。
 * 在跑的一条不动——官方件对超额的答法是拒绝 start（实测），不是替我们杀任务。
 * 侧表里没有的 id（上一次 apply 卸载后残留的记录）同样要能清掉，所以遍历的是
 * `list()` 而不是 `records`。
 * @param jobs 官方注册表
 * @param records 本包侧表（被淘汰记录同步删掉）
 * @returns {void}
 */
function pruneRebuildHistory(jobs: JobsService, records: Map<string, RebuildRecord>): void {
  const ours = jobs.list().filter((job) => job.kind === REBUILD_JOB_KIND);
  const settled = ours.filter((job) => !isLiveStatus(job.status));
  for (const job of settled.slice(0, Math.max(settled.length - (REBUILD_HISTORY_MAX - 1), 0))) {
    jobs.remove(job.id);
    records.delete(job.id);
  }
}

/**
 * 从官方容量闸的错误文本里取出上限（实测原文：`background job limit reached for this
 * owner (limit: 10)`）。认不出来 ⇒ undefined，调用方退回通用的启动失败文案。
 * 为什么单独认这一条：它是本包唯一会把宿主英文原话插进中文卡片的错误，又恰恰最该翻成
 * 人话的那一条——用户此时要做的是去 job_list 里收掉不需要的作业，而不是读一句英文。
 */
function capacityLimitOf(error: unknown): string | undefined {
  const matched = /\(limit: (?<limit>\d+)\)/u.exec(errorText(error));
  return matched?.groups?.["limit"];
}

/**
 * 「工作区重建」的四道前置校验：绝对路径 + 归一化、本 daemon 观测过的白名单、
 * 目录此刻仍存在。不过就交回可直接显示的文案（错误文本全走双语字典）。
 *
 * 白名单是**动作**的闸门：没有它，任何拿得到这条读面的一方都能用任意绝对路径去
 * `zg index --rebuild`——读遍那棵树、写 `.zvec-grep/`，还可能把其中的非隐藏敏感文件
 * 灌进向量库并回显到上下文。
 * @param raw 请求里带来的 root（未经类型校验）
 * @param ledger 观测到的工作区白名单
 * @param started 本次请求语言的文案表
 * @returns 归一化后可用的绝对路径；不合格时 `{ error }`
 */
function acceptableRoot(
  raw: unknown,
  ledger: RebuildLedger,
  started: ZvecGrepMessages,
): { root: string } | { error: { value: string; status: RebuildRefusedStatus } } {
  let root: string;
  try {
    root = assertAbsoluteRoot(raw, started);
  } catch (error) {
    return {
      error: {
        value: fill(started.endpointRootInvalid, { reason: errorText(error) }),
        status: 400,
      },
    };
  }
  if (!ledger.has(root)) {
    return { error: { value: fill(started.endpointRootUntracked, { root }), status: 403 } };
  }
  if (!existsSync(root)) {
    return { error: { value: fill(started.endpointRootGone, { root }), status: 400 } };
  }
  return { root };
}

/**
 * 这个 root 上有没有**仍在跑**的本包重建？有 ⇒ 返回那枚作业 id 让新面板跟随。
 *
 * 判据是三条一起："侧表里有这条" + "名册里同 id 的那条确实是我们那条（比出生时刻）" +
 * "状态还在跑/正在收"。第二条不能省：jobs 被重载之后 id 会重名，只查侧表就把一张新面板
 * 领到别人的作业上。
 * @param jobs 调用方已确认在场的注册表（缺席那一支在重建方法更早答过）
 * @param records 本包侧表
 * @param root 已归一化的工作区
 * @returns 跟进的那枚作业 id；没有可跟的就是 undefined
 */
function followRunningRebuild(
  jobs: JobsService,
  records: Map<string, RebuildRecord>,
  root: string,
): JobId | undefined {
  const following = [...records.values()].find((record) => {
    if (record.root !== root) {
      return false;
    }
    const view = jobView(jobs, record.id);
    return view !== null && sameJob(record.state, view) && isLiveStatus(view.status);
  });
  return following?.id;
}

/**
 * 把「起一条 zg 失败」的原因翻成卡片文案。
 *
 * **本函数不杀进程**：杀由 `attachIndexWrite` 负责——它才是真正握着那条进程句柄、
 * 且知道作业有没有登记成功的地方（preflight 在 controller/容量/入参上拒掉作业时，spawn
 * 已经发生，不杀就会留下一条没登记、谁也停不掉的 zg）。这里只管文案。
 *
 * 满员那一档单独翻文案：它是本包唯一会把宿主英文原话插进卡片的错误，又最该翻成人话
 * （用户要做的是去 job_list 收作业，不是读一句英文）。
 */
function startupFailureText(error: unknown, started: ZvecGrepMessages): string {
  const capacity = capacityLimitOf(error);
  return capacity === undefined
    ? fill(started.endpointStartFailed, { reason: errorText(error) })
    : fill(started.endpointJobsAtCapacity, { limit: capacity });
}

/**
 * 在 controller 闸门下起一条未拥有作业。
 *
 * 官方件在"没有 controller 服务这个 owner"时直接拒绝 `start`（实测），而未拥有
 * 作业只被 global 层服务；web 面上宿主自己的 `tool-jobs` 被移进了各 preset realm
 * （packages/bundle/web-app/cordis.patch.yml 把 tool-jobs 在宿主平面 disabled），
 * 所以本包必须自带一枚从无作用域上下文 attach 的 controller。但**只在 start 这一瞬挂**：
 * 实测挂上即放行、摘掉即恢复拒绝、可反复，而 global 层的 controller 只被 `servesOwner`
 * 读，作业的后续（read/kill/落定）都不依赖它。留一枚常驻 token 等于在"宿主故意没装 job
 * 工具"的组成里替全宿主开着那道闸门——官方契约写的是"生产者不能起一台 owner 收不掉、
 * 停不掉的作业"，常驻就是把它反过来做。
 */
function startUnderController(jobs: JobsService, spec: JobSpec): JobId {
  const detach = jobs.attachController("zvec-grep: rebuild");
  try {
    return jobs.start(spec);
  } finally {
    detach();
  }
}

/**
 * 交给注册表的作业规格：输出源 + `run` 的两枚钩子（cancel / done）与那枚 kill 定时器。
 * 单独成一段是因为它只在 `start` 的那一拍被同步调用一次，与「登记进侧表」是两件事。
 * @param routes 本次注册的共享依赖（config 现读超时、host 挂 timer、jobsOf 现读注册表）
 * @param proc 已经起来的 zg 进程
 * @param state 这条重建的状态盒（与侧表记录共用）
 * @param command 实际执行的命令行（作业 label，模型在 job_list 里看见的那句）
 * @returns 官方 JobSpec：kind / label / output / run
 */
function rebuildJobSpec(
  routes: IndexWriteRoutes,
  proc: ShellExecution,
  state: RebuildState,
  command: string,
  root: string,
): JobSpec {
  const { config, host, jobsOf, messages } = routes;
  return {
    kind: REBUILD_JOB_KIND,
    label: command,
    output: rebuildSources(proc, state),
    run: (handle) => {
      // 名册里那条还是不是我们这条：换过注册表就不是（id 会重名），那就谁也不许动它。
      const liveJob = (): { jobs: JobsService; status: JobStatus } | null => {
        const live = jobsOf();
        if (live === undefined) {
          return null;
        }
        const view = jobView(live, handle.id);
        if (view === null || !sameJob(state, view)) {
          return null;
        }
        return { jobs: live, status: view.status };
      };
      // 后台进程必须显式加超时：dsh-shell 契约明确 start 不应用 timeoutMs
      //（"no timeout applies to background processes"），否则 zg 挂住即 job
      // 永远 running、卡片每 2s 无限轮询。用宿主 timer 归属插件纤维，插件
      // 卸载时随 effect 自动回收；进程先结束则取消定时器。
      const cancelKillTimer = host.timer.timeout(() => {
        // 进程可能恰在超时点自然完成——注册表的落定排在 done 的微任务链上，此刻
        // 名册里仍是 running。以实时的 proc.status 为准，否则会给一条已成功的重建
        // 记下超时，并与随后落定的 completed 矛盾。
        if (proc.status !== "running") {
          return;
        }
        // 名册里已在收（stopping）或已收完 ⇒ 有人负责了，不再重复。
        const live = liveJob();
        if (live !== null && live.status !== "running") {
          return;
        }
        const minutes = Math.round(config.indexTimeoutMs / 60_000);
        state.timeoutNote = fill(messages().rebuildTimeout, { minutes });
        if (live === null) {
          // 注册表已经不认这条了（服务被重载）⇒ 只剩我们手里的进程可收，直接杀。
          killProc(proc);
          return;
        }
        // 超时也经注册表收，而不是绕过它直接杀进程：官方件据此把记录推到 stopping，
        // 并把 reason 追加进模型可见的 detail（实测），模型因此分得清"超时回收"与
        // "用户手工 job_kill"；进程本身由它回调上来的 cancel() 终止。
        live.jobs.kill(handle.id, undefined, fill(messages().jobReasonTimeout, { minutes }));
      }, config.indexTimeoutMs);
      return {
        cancel: () => {
          killProc(proc);
        },
        // pull source 形态下生产者不再往环里折任何东西（官方契约："a producer folds
        // nothing into its done"）——最后一次排水由注册表在落定前自己跑（实测）。
        // await 形态取代 .then 链：官方 JobSpec.run 必须**同步**交出 JobHooks
        // （dts 原文 "Start the work after preflight and synchronously return its
        // hooks"），所以 await 只能装在一枚立即执行的 async 箭头里当场产出
        // Promise<JobOutcome>，不能把 run 本身改成 async（那会让 run 返回 Promise）。
        done: (async () => {
          // 收口必须包住 `await proc.done` 本身：那条 reject 时不进下面的 try，
          // cancelKillTimer() 与 release(root) 都会被跳过 —— 超时定时器留着（残到插件
          // 卸载才回收），而这棵树被永久标成「重建中」，检索一直排队等一条早已落定的重建。
          try {
            await proc.done;
            return jobOutcomeOf(proc);
          } finally {
            cancelKillTimer();
            routes.rebuilds.release(root);
          }
        })(),
      };
    },
  };
}

/**
 * 起一条 `zg index`：命令构造 + resolve + execute 三步。
 *
 * 远程重建与模型侧后台索引**共用**这一个函数（不是复制品），所以两条入口起的作业
 * 在名册、状态投影、轮询读面上完全同形。命令形态由 `indexArgs` 决定，故它也服务普通建索引。
 *
 * 版本门槛排在命令构造**之前**：确知装的是太老的 zg 时，在这一行就给出可照做的指引，
 * 而不是起一条命令形态对不上的 zg 再让人对着结果猜。注意这个顺序也保证了「门槛失败」
 * 发生在任何进程存在之前，调用方那条 `release` 出口足以收干净。
 *
 * 任一步抛错即就地翻成 `{ error, status }`；**本函数不释放占位**，那由调用方做（它才持有 root）。
 * @param routes 本次注册的共享依赖（现读 config / host / jobsOf）
 * @param started 本次请求语言的文案表
 * @param indexArgs 已归一 root 的索引入参
 * @param embedding 设置里的默认 embedding（`indexArgs.embedding` 为空时用它）
 * @returns 起来的进程与它跑的命令；失败为 `{ error, status }`
 */
export async function spawnIndexWrite(
  routes: IndexWriteRoutes,
  started: ZvecGrepMessages,
  indexArgs: IndexArgs,
  embedding: string,
): Promise<
  { proc: ShellExecution; command: string } | { error: string; status: RebuildRefusedStatus }
> {
  const { config, host } = routes;
  let spawned: { proc: ShellExecution; command: string };
  try {
    // 版本门槛先于命令构造：太老的 zg 会在这一行就拿到可照做的指引，而不是起一条
    // 命令形态对不上的 zg 再让人对着结果猜。
    await routes.versionGate.ensure(started);
    // 与前台索引同一道预检（见 assertIgnoreFilesExist）：后台这条路的入参同样来自模型。
    assertIgnoreFilesExist(indexArgs, assertAbsoluteRoot(indexArgs.root, started), started);
    const built = buildIndexCommand(
      indexArgs,
      embedding,
      started,
      readClientMode(config, started),
      allowRemoteEmbedding(config),
    );
    const env = zgEnv(config);
    // 注：后台路径显式带 onExpiry:'none' 取无界（0.1.7 起 bash-local resolve 缺省
    // 'kill'，不传就会被缺省 timeoutMs 杀掉），deadline 由下面宿主 timer 挂的 kill
    // 定时器兜底。stdoutMaxBytes 在 0.1.7 对每次 spawn 都生效（bash-local execute 把
    // spec.stdoutMaxBytes 传进 spawnSpec），它约束的是**执行器**那段缓冲；进了官方环
    // 之后的留存窗另算（retainBytes 那一档，取官方件自己的默认值）。两项都是部署值，现读
    // Config（行 config 改了这里立即跟着走，不留写死的常量分支）。
    const spec = host.shell.resolve({
      command: built.command,
      workdir: built.workdir,
      onExpiry: "none",
      stdoutMaxBytes: config.stdoutMaxBytes,
      ...(env ? { env } : {}),
    });
    spawned = { proc: await host.shell.execute(spec), command: built.command };
  } catch (error) {
    return { error: fill(started.endpointStartFailed, { reason: errorText(error) }), status: 500 };
  }
  return spawned;
}

/**
 * 把起来的那条进程登记进官方注册表与本包侧表，交回宿主签发的 id。
 *
 * 三种失败（注册表换人 / 同名不同命 / start 抛错）都**先把那条进程杀掉**再交回错误：
 * 此刻作业没进名册，没人能通过 job 工具收它，不杀就是一条孤儿 zg 占着这棵树的写锁。
 * 同样地，本函数不释放占位——那件事由调用方做。
 * @param routes 本次注册的共享依赖（jobsOf 现读、侧表引用）
 * @param root 已过前置校验的工作区（写进侧表供卡片回显）
 * @param started 本次请求语言的文案表
 * @param spawned spawnIndexWrite 交回的进程与命令
 * @returns 宿主签发的 `{ jobId }`；失败为 `{ error, status }`
 */
export function attachIndexWrite(
  routes: IndexWriteRoutes,
  root: string,
  started: ZvecGrepMessages,
  spawned: { proc: ShellExecution; command: string },
): { jobId: JobId } | { error: string; status: RebuildRefusedStatus } {
  const { jobsOf, records } = routes;
  const { proc, command } = spawned;
  // 上面 `await host.shell.execute()` 让出了一拍：那期间 `jobs` 可能被关掉或换成另一枚
  // 实例。用** spawn 之前**那枚引用去 prune/start 等于往一枚可能已死的注册表里登记
  // （实测已 dispose 的 fiber 上 attachController 抛
  // `cannot create effect on inactive context`，被下面的 catch 收成启动失败）。现读现用。
  const starting = jobsOf();
  if (starting === undefined) {
    killProc(proc);
    return { error: started.endpointJobsUnavailable, status: 503 };
  }
  // 历史裁剪也包在失败收口里：`list()` / `remove()` 抛错时若不接住，异常会穿过本函数，
  // 调用方那两条 release 都轮不到执行 —— 刚 spawn 的 zg 成了孤儿（继续写这棵树），
  // 占位也永远留在「重建中」。
  try {
    pruneRebuildHistory(starting, records);
  } catch (error) {
    killProc(proc);
    return { error: startupFailureText(error, started), status: 500 };
  }
  // 丢失记账先于 start：源的 read 可能在 start 里同步跑第一拍。
  const state: RebuildState = {
    // kind/label 与下面那份规格同源（就是命令本身）；startedAt 等官方签。
    identity: { kind: REBUILD_JOB_KIND, label: command, startedAt: UNSIGNED_STARTED_AT },
    lost: false,
    timeoutNote: null,
  };
  let jobId: JobId;
  try {
    jobId = startUnderController(starting, rebuildJobSpec(routes, proc, state, command, root));
    // 登记进侧表与身份证都在 start **成功之后**：`run()` 里任何一步抛错（宿主 timer 面
    // 已拆就是这一档）都会被官方件按"不注册、序号作废"处理，那时侧表里不该留着这条。
    state.identity = identityOf(starting.get(jobId));
    // 这里没有"同 id 撞车"那一臂：官方号是 `<kind>-<16 位 hex>`，换一枚实例也不会再发出同一枚，
    // 于是串台只能从读侧进来——下面盖的身份证（sameJob）就是那一侧的闸。
    records.set(jobId, { proc, root, id: jobId, state });
  } catch (error) {
    killProc(proc);
    return { error: startupFailureText(error, started), status: 500 };
  }
  return { jobId };
}

/**
 * 卸载效应的收口：把侧表里的进程与在册作业收干净。
 * @param deps 本次注册的共享依赖（jobsOf 现读、侧表引用、文案现取）
 * @returns {void}
 */
function releaseRebuildRecords(
  deps: Pick<ZvecRebuildDeps, "jobsOf" | "messages" | "records">,
): void {
  const { jobsOf, messages, records } = deps;
  // 注册表随宿主活着，**不**随本插件卸载而死：在跑的作业必须我们杀（否则那条 zg 继续
  // 读整棵树，而且再没有人能在 job_list 里收它）；已落定的顺手 remove（环还占着宿主内存）。
  // 刚被 kill 的那几条此刻移不走（官方件不许删在跑作业），由下一次 apply 的
  // pruneRebuildHistory 按 kind 清掉——那正是它遍历 `list()` 而不是遍历侧表的原因。
  // reason 在这里就算好，不留到循环里现取：文案要走官方 locale 的翻译服务，而卸载效应
  // 跑到一半时本包 fiber 已经在拆。
  const unloadReason = messages().jobReasonUnload;
  const jobs = jobsOf();
  if (jobs === undefined) {
    // 注册表已经不在了（`jobs` 那一行被关掉/重载 ⇒ 它清空了名册）：没东西可标记，
    // 但进程还是我们的，只把它们收干净。
    for (const record of records.values()) {
      killProc(record.proc);
    }
  } else {
    for (const record of records.values()) {
      // 每条独立收口：一条收失败不能中断整轮，也不能跳过 records.clear() —— 那正是
      // 「卸载跑完了、侧表里却还钉着一批已死的记录」那一档，之后每次 apply 都要再撞一遍。
      try {
        const view = jobView(jobs, record.id);
        if (view === null || !sameJob(record.state, view)) {
          // 名册里没有这条（已被别人收走），或者同名不同命（`jobs` 换过一枚实例）：
          // 两种都只剩我们手里的进程可收，绝不去 kill/remove 别人那条健康作业。
          killProc(record.proc);
        } else if (isLiveStatus(view.status)) {
          // 走注册表而不是直接杀进程：官方件据此把记录推到 stopping、把 reason 落进
          // detail，再经本包的 cancel() 收到 proc.kill()。绕过它会让模型名册里那条
          // 永远停在 running，环也一直不关（实测：本包测试就先被这条抓到过）。
          jobs.kill(record.id, undefined, unloadReason);
        } else {
          jobs.remove(record.id);
        }
      } catch {
        // 注册表对它不认了也能走到这里（remove 在跑作业上会抛）：进程还是我们手里的，收掉。
        killProc(record.proc);
      }
    }
  }
  records.clear();
}

/**
 * 设置卡片「工作区重建」的读面（引导 / 启动 / 轮询三个方法）。
 *
 * ⚠ 服务在**构造时**注册（cordis `Service` 的契约：`ctx.reflect.provide`，随所属 fiber
 * 卸载自动撤），所以调用方拿实例没有任何用处——装入口 `installRebuildRemote` 说明了这一点。
 *
 * ⚠ `jobsOf` 必须每次用时现读，不在闭包里钉住一枚实例。`ctx.get` 是无 inject 语义的存储
 * 读（官方 reflect.d.ts："or `undefined` when not (yet) provided"，实测读一次就只那一次）——
 * 在 apply 里读会把两种正常事件变成永久故障：服务比本插件晚到位 ⇒ 启动从此一直回答不可用
 * （还指着用户去装一个其实装好了的包）；服务被重载 ⇒ 从此往一枚已销毁的实例里起作业。
 * 本包也不把 `jobs` 列进 `inject` 名单：那会让缺席的整条 client 入口都不激活，而缺席只该让
 * 「启动/轮询」这一档不可用。
 */
export class ZvecRebuildService extends TypertRemoteService {
  private readonly deps: ZvecRebuildDeps;

  public constructor(ctx: Context, deps: ZvecRebuildDeps) {
    super(ctx, REBUILD_REMOTE_NAMESPACE);
    this.deps = deps;
  }

  /** 引导读面：白名单里的工作区 + 守护进程就绪态（都是本插件自己的数据）。 */
  public async roots(): Promise<RebuildRoots> {
    // 守护进程就绪态走 TTL 缓存（与三条工具同一份），卡片每开一次不至于多起一次 zg。
    const serverReady = await this.deps.serverGate.ready();
    return { roots: this.deps.ledger.list(), serverReady };
  }

  /**
   * 起一条重建（或跟随同根已在跑的那条）。
   *
   * 占位是**互斥的唯一依据**，必须落在第一个 await 之前。先「查在不在跑」再占位，
   * 两次并发点击会同时通过那次查询、各自 spawn——两个进程在同一份索引上互相啃，
   * 后一条被 zg 的写锁直接顶掉并报成「启动失败」。改成「先占位、抢不到就跟随」，
   * 这条竞态就没有窗口了。
   */
  public async rebuild(request: RebuildStartRequest): Promise<RebuildStartResult> {
    const started = this.deps.messages();
    const accepted = acceptableRoot(
      isRecord(request) ? request.root : undefined,
      this.deps.ledger,
      started,
    );
    if ("error" in accepted) {
      return { ok: false, error: accepted.error.value, status: accepted.error.status };
    }
    const { root } = accepted;
    const jobs = this.deps.jobsOf();
    if (jobs === undefined) {
      // 官方注册表不在（宿主没装 dsh-jobs-local）：这条动作没有降级形态——没有环、
      // 没有容量、也没有人能在 job_list 里看到它，起一条没人管的 zg 比不起更糟。
      return { ok: false, error: started.endpointJobsUnavailable, status: 503 };
    }
    if (this.deps.rebuilds.claim(root, "card") === null) {
      // 抢不到说明同根已有一条在跑：把那条的 id 回给这张面板跟随。
      // 跟不到（它正在落定、或注册表刚被换过）也要**答完**：这一支直接返回而不回答，
      // 卡片侧只会看到一次「查询状态失败」并停止轮询，而那条重建还在界面上凭空消失。
      const following = followRunningRebuild(jobs, this.deps.records, root);
      return following === undefined
        ? { ok: false, error: started.endpointRebuildInFlight, status: 409 }
        : { ok: true, jobId: following, reused: true };
    }
    const embedding = readDefaultEmbedding(this.deps.config);
    const spawned = await spawnIndexWrite(
      this.deps,
      started,
      { root, embedding, rebuild: true },
      embedding,
    );
    if ("error" in spawned) {
      // spawn 抛错或被拒：占位必须交还，否则这棵树会被永久标记成「重建中」。
      this.deps.rebuilds.release(root);
      return { ok: false, error: spawned.error, status: spawned.status };
    }
    const attached = attachIndexWrite(this.deps, root, started, spawned);
    if ("error" in attached) {
      this.deps.rebuilds.release(root);
      return { ok: false, error: attached.error, status: attached.status };
    }
    this.deps.rebuilds.attach(root, attached.jobId);
    return { ok: true, jobId: attached.jobId };
  }

  /**
   * 轮询读面：官方状态投影 + 退出码/沙箱事实 + 打标后的输出尾窗（卡片每 2s 敲一次）。
   *
   * 侧表就是这条投影的授权边界：官方 id 是可预测的 `<kind>-<hex>`（宿主 bash 工具的
   * `bash-1` 同样猜得到），而它不在本包表里 ⇒ 一律拒绝，绝不代读别人的作业。
   */
  public status(request: RebuildStatusRequest): RebuildStatusResult {
    const marks = this.deps.messages();
    const raw = isRecord(request) ? request.jobId : undefined;
    const record =
      typeof raw === "string" && raw.length > 0 ? this.deps.records.get(raw) : undefined;
    if (record === undefined) {
      // 历史窗口用尽后旧 jobId 会消失——给出可行动提示，而非一句裸失败让卡片只显示
      // "查询状态失败"。
      return {
        ok: false,
        error: fill(marks.unknownJobId, { maxJobs: REBUILD_HISTORY_MAX }),
        status: 404,
      };
    }
    const jobs = this.deps.jobsOf();
    if (jobs === undefined) {
      // 与启动同一口径：注册表不在就没有读数。这条分支在"服务起得来、后来被关掉"
      // 那一档才走到（侧表里还有记录），此时进程可能仍在跑，由卸载效应负责收。
      return { ok: false, error: marks.endpointJobsUnavailable, status: 503 };
    }
    const output = readRebuildOutput(jobs, record.id);
    if (output === null) {
      // 名册里已经没有这条了（`jobs` 那一行被重载 ⇒ 它清空名册，或记录已被别人收走）。
      // 侧表条目留着——它还钉着 proc，卸载时那一臂要凭它杀进程——但这一轮只能答查无此条。
      return {
        ok: false,
        error: fill(marks.unknownJobId, { maxJobs: REBUILD_HISTORY_MAX }),
        status: 404,
      };
    }
    if (!sameJob(record.state, output.view)) {
      // 同名不同命：`jobs` 那一行被重载后新实例重新签发了这个 id。旧卡片读不到新作业，
      // 新作业也不许被旧卡片的轮询/超时/卸载臂碰到。
      return {
        ok: false,
        error: fill(marks.unknownJobId, { maxJobs: REBUILD_HISTORY_MAX }),
        status: 404,
      };
    }
    const { view, retained } = output;
    // 状态取官方投影（多出的 stopping/failed 由卡片按"仍在跑/出错"归位），退出码与沙箱
    // 事实仍从 proc 现读——JobView 没有这两个槽。这一对读都是**非消费**的：
    // 卡片每 2s 一次轮询，不许把模型的 job_output 游标推走（实测）。
    const text = retained.chunks.map((chunk) => chunk.text).join("");
    // shown/total 一律按 **UTF-16 码元**计数（命名口径：`.length` 就是码元，
    // 文案说的"字符"也是它）；环的留存按 UTF-8 字节裁，两套单位各管各的，别混称。
    // 切点走 shared 的 truncateStart：官方环的裁切按 UTF-8 边界，但我们这道 4000 的
    // 尾切若用裸 slice 会在切点留下孤立低代理项。
    const shown = truncateStart(text, JOB_OUT_VIEW_CHARS);
    const viewMark =
      text.length > JOB_OUT_VIEW_CHARS
        ? fill(marks.jobOutputView, { shown: JOB_OUT_VIEW_CHARS, total: text.length })
        : "";
    return {
      ok: true,
      status: view.status,
      exitCode: record.proc.exitCode,
      root: record.root,
      // 沙箱事实原样透传：runnerFailed 让卡片判「未执行」而非「完成」。
      ...(record.proc.sandbox === undefined ? {} : { sandbox: record.proc.sandbox }),
      // 打标顺序 = 环裁过头部 → 泵读不到过字节 → 超时 → 沙箱事实 → 尾窗说明 → 正文。
      // 后两条从前是**写进环尾**的，现在由投影层合成：注册表在落定之后丢弃一切写入
      // （实测），把"为什么这次重建没跑成"寄存在一条会被丢掉的写上，正是最不该丢的信息。
      output:
        // 两条丢失各自独立可观测：`earliest > 0` 是官方环按留存窗裁掉了头部（显示口径）；
        // `state.lost` 是执行器的读者报 lossy 或干脆抛了（真少了字节，可能有 spill 文件）。
        // 合用一条标就会把"看不见了"说成"没跑出来"。
        (view.output.earliest > 0 ? marks.jobOutputTruncated : "") +
        (record.state.lost ? marks.jobOutputLost : "") +
        (record.state.timeoutNote ?? "") +
        (procSandboxNote(record.proc, marks) ?? "") +
        viewMark +
        shown,
    };
  }
}

/**
 * 标准装饰器的**程序化调用**：`@Remote` 的全部作用就是往类原型写一枚描述符，而标准装饰器
 * 语法需要一条 tsc 降级管线（本仓的测试/构建解析器都不降级它）。这里直接按 TC39 的
 * `ClassMethodDecoratorContext` 形状调同一个 decorator 函数，把标记落到真正的原型上，
 * 于是源码里不再需要装饰器语法，构建与测试都不必再挂那枚预转换插件。
 */
function markRemote(prototype: ZvecRebuildService, methodName: string): void {
  // 官方 `Remote` 的运行时只读 name/private/static 与 addInitializer（TC39 的 access/metadata
  // 它一概不读），故这里只给这四位；`Reflect.apply` 让装饰器工厂保持未类型化的调用面。
  const context = {
    kind: "method",
    name: methodName,
    static: false,
    private: false,
    addInitializer: (initializer: (this: unknown) => void): void => {
      // 初始器只做 `Object.getPrototypeOf(this)` 后落标记；用原型造一枚替身实例即可。
      Reflect.apply(initializer, Object.create(prototype), []);
    },
  };
  // oxlint-disable-next-line eslint/new-cap -- `Remote(…)` 是装饰器工厂，不是大写开头的构造调用
  const decorate = Remote(methodName);
  Reflect.apply(decorate, undefined, [Reflect.get(prototype, methodName), context]);
}

markRemote(ZvecRebuildService.prototype, "roots");
markRemote(ZvecRebuildService.prototype, "rebuild");
markRemote(ZvecRebuildService.prototype, "status");

/**
 *
 * 为什么是一枚函数而不是让调用方直接 `new`：这枚 `new` 的**全部意义在构造期的注册副作用**
 * 上——实例由 cordis 的 fiber 持有（`Service` 基类把 `reflect.provide` 的 disposer 挂给
 * fiber），调用方拿到它没有任何用处。卸载效应也在这里登记：侧表里的进程与在册作业必须
 * 随本插件一起收干净。
 *
 * @param ctx - 宿主上下文
 * @param deps - 重建读面的全部依赖（见 ZvecRebuildDeps）
 */
export function installRebuildRemote(ctx: Context, deps: ZvecRebuildDeps): boolean {
  // 替身上下文没有 cordis 的服务注册口（`reflect.provide`）：那是可选读面缺席的同一档，
  // 只该少掉卡片这一栏，绝不该让 apply 当场炸掉（与 danger-guard 的 installStatsRemote 同口径）。
  if (!isRecord(ctx) || !isRecord(ctx.reflect) || typeof ctx.reflect.provide !== "function") {
    return false;
  }
  // oxlint-disable-next-line eslint/no-new -- 见函数文档：构造即注册，返回值无意义
  new ZvecRebuildService(ctx, deps);
  ctx.effect(
    () => () => {
      releaseRebuildRecords(deps);
    },
    "zvec-grep: rebuild records",
  );
  return true;
}
