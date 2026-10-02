// lib/rebuild-state.ts —— **活跃重建的统一状态源**（纯逻辑，无宿主依赖）。
//
// 为什么要有它：重建有两条入口——设置卡的重建端点与模型侧的前台索引工具——两者此前各自
// 判断「这条树上是不是已经在重建」，检查与真正起进程之间又隔着一次 await，于是并发两次
// 点击（或卡片重建与模型索引同时发生）会各自起一条 zg；而 zg 对同一根的并发写锁是**直接
// 失败**的，第二条秒退并被报成「启动失败」。把「占位」收进一个按归一化根索引的注册表，
// 并在任何 await **之前**完成登记，这条竞态就没有窗口了。
//
// 三条不变式：
//   - 同一根同时只有一条活跃重建：claim 在已有活跃条目时拒绝。
//   - 占位不是可轮询记录：作业 id 只在官方注册表真正接纳之后才由 attach 补上，之前恒为
//     undefined（调用方据此不得去轮询或回显 id）。
//   - 释放必达：每条 claim 都配一次 release（含超时、被取消、失败、卸载四种出口），且
//     release 幂等，重复调用不会误伤已经归一的条目。
//
// 等待者挂在条目自带的 promise 上，由 release 统一唤醒：等待与放行是同一条收口，
// 不存在「等待者还在、条目已消失」的悬挂。

// 官方作业品牌串（type-only：产物里零运行时引用，本文件仍是纯逻辑模块）。
import type { JobId } from "@deepseek-ai/dsh-jobs";
// 覆盖判据复用门禁/授权那一个（同一份 pathInsideRoot），不另写一套路径前缀比较。
import { pathInsideRoot } from "./search-predicates.ts";
import type { ZvecGrepMessages } from "./messages.ts";

/** 活跃重建的两个阶段：起进程前后由 attach 划界。 */
export type RebuildPhase = "starting" | "running";

/** 谁发起的重建：设置卡端点还是模型侧工具。用于日志与文案归因。 */
export type RebuildOrigin = "card" | "tool";

export interface ActiveRebuild {
  /** 归一化后的根路径（注册表的键）。 */
  readonly root: string;
  readonly origin: RebuildOrigin;
  readonly startedAt: number;
  /** 阶段；attach 之后才推进到 running。 */
  phase: RebuildPhase;
  /**
   * 官方作业注册表签发的 id。占位期间恒为 undefined —— 这是「尚未可轮询」的判据，
   * 调用方绝不能把 undefined 当成一个有效 id 去读状态。
   *
   * 用官方的品牌串 `JobId`（@deepseek-ai/dsh-jobs，type-only）而不是 `string`：
   * attach 的入参与 jobs.start 的返回值同型，于是「谁往这里塞了一个普通字符串」
   * 在类型上不可能发生。本文件因此不再有一处品牌加宽断言。
   */
  jobId: JobId | undefined;
  /** 条目落定时兑现；等待者只挂这一条。 */
  readonly settled: Promise<void>;
  /**
   * 兑现 `settled` 的那枚函数：与条目同生命周期，释放与淘汰两条路径都要它，
   * 故是条目成员而不是闭包私有。
   */
  settle: () => void;
}

/** 一条等待者的结果：区分「等到落定」与「自己先到头了」。 */
export type WaitOutcome = "settled" | "timeout" | "aborted";

export interface RebuildRegistry {
  /** 原子占位。已有活跃重建 ⇒ null（调用方据此复用而不是再起一条）。 */
  claim: (root: string, origin: RebuildOrigin, startedAt?: number) => ActiveRebuild | null;
  /** 官方注册接纳后补作业 id（同时把阶段推进到 running）。条目已释放则安全空转。 */
  attach: (root: string, jobId: JobId) => void;
  /** 释放占位并唤醒全部等待者；幂等，返回是否确实释放了一条。 */
  release: (root: string) => boolean;
  /** 当前该根的活跃条目（**精确键**：写操作的互斥判据就是它）。 */
  active: (root: string) => ActiveRebuild | undefined;
  /**
   * 覆盖给定 root 的活跃条目：重建根是该 root 的**祖先或同一处**时命中。
   *
   * 为什么读侧要放宽到「祖先」：重建登记用的是它自己的根，而检索/状态查询用的是调用方给的
   * 根。卡片在 `/repo` 起重建、模型对 `/repo/pkg` 发查询时，精确键查不到——于是门禁那一侧
   * （先 `findIndexRoot` 找到祖先索引根）放行了，等待与状态投影却不触发，调用直接撞一条裸
   * `LOCK.BUSY`。
   *
   * 为什么**只**放宽到祖先、不用双向的 `pathsRelated`：zg 的锁按工作区 home 走，重建
   * `/repo/pkg` 那一格不会挡住读 `/repo` 的索引库。判成「相关」会让 `zg_status /repo` 谎报
   * 「正在重建」，而那是比等不到更糟的结论。
   *
   * 多条同时命中时取 `startedAt` 最早的那条：判据与结果都确定，不随 Map 插入序漂移。
   */
  covering: (root: string, messages: ZvecGrepMessages) => ActiveRebuild | undefined;
  /** 该根是否有「官方已接纳、持有作业 id」的活跃重建。 */
  hasPollable: (root: string) => boolean;
  /**
   * 在给定时限内等**覆盖该根**的那条重建落定（口径同 covering）；条目中途消失也算落定
   * （等待者不会悬挂）。没有覆盖的重建时立刻返回 settled，不空等。
   */
  wait: (
    root: string,
    messages: ZvecGrepMessages,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<WaitOutcome>;
  /** 当前全部活跃根（卸载收口与测试用）。 */
  keys: () => string[];
}

/** 上限容器的条目数：超过按插入序淘汰最早的（常驻进程内存有界）。 */
export const MAX_TRACKED_REBUILDS = 32;

/** 等到信号被取消为止。 */
async function abortOf(signal: AbortSignal): Promise<undefined> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  signal.addEventListener(
    "abort",
    () => {
      resolve(undefined);
    },
    { once: true },
  );
  return promise;
}

/** 等到信号被取消为止，并归一成等待的一种结局。 */
async function abortedOutcome(signal: AbortSignal): Promise<WaitOutcome> {
  await abortOf(signal);
  return "aborted";
}

/** 延时；用不可撤销的定时器换来收尾路径里没有「撤销自己」那种分支。 */
async function delay(ms: number): Promise<undefined> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(() => {
    resolve(undefined);
  }, ms);
  return promise;
}

/**
 * 容量上限：超过就淘汰若干条目，但**绝不淘汰已经交出作业号的那条**。
 *
 * 为什么：淘汰会把条目从表里删掉并兑现它的 `settled`——对一条真在跑的重建来说，那等于
 * 告诉所有等待者「结束了」，而它的 zg 其实还在写这棵树的索引。表一空，下一条 claim 就会
 * 成功，于是两条 `zg index` 同时啃一份索引，撞上 zg 的写锁直接失败——那正是这个注册表
 * 存在的理由。官方作业注册表本身就把同时在跑的作业数卡在一个很小的量级，所以「全部都是
 * running、淘汰不动」时表短暂超限是无害的，内存依然有界。
 */
function trimToMax(entries: Map<string, ActiveRebuild>, max: number, keep: ActiveRebuild): void {
  // 快照一次再遍历：下面要在循环体里 delete 自己。
  for (const [root, entry] of entries) {
    if (entries.size <= max) {
      return;
    }
    // 跳过刚 claim 出来的那一条：调用方正拿着它的引用往回走，而 claim 的返回值就是
    // 「占位成功」的唯一凭据。把它淘汰掉等于当场把这个凭据作废。
    // 在跑的（已有作业号）那一条同样跳过：见上面那段注释。
    if (entry !== keep && entry.jobId === undefined) {
      entries.delete(root);
      entry.settle();
    }
  }
}

/**
 * 覆盖给定 root 的那条活跃条目：重建根是 root 的祖先或同一处时命中，多条命中取
 * startedAt 最早的一条。抽成自由函数是为了让 `covering` 与 `wait` 共用同一段判据
 * ——两者一旦分叉，就会重演「门禁等得到、等待等不到」那个口径不一致的毛病。
 */
function coveringOf(
  entries: Map<string, ActiveRebuild>,
  root: string,
  messages: ZvecGrepMessages,
): ActiveRebuild | undefined {
  let best: ActiveRebuild | undefined;
  for (const entry of entries.values()) {
    // 重建根是查询根的祖先或同一处 ⇒ 这条重建占着本次读取要用的那个索引库。
    // 其余条目与本次读取无关，跳过（写成嵌套 if 而不是 continue：少一个控制流出口）。
    // startedAt 相同（单测的可控时钟会让同毫秒 claim 两条）时保留先遍历到的那条，
    // 结果仍然确定：Map 的插入序在一次进程生命周期内是稳定的。
    if (
      pathInsideRoot(root, entry.root, messages) &&
      (best === undefined || entry.startedAt < best.startedAt)
    ) {
      best = entry;
    }
  }
  return best;
}

/**
 * 建一份注册表。时钟可注入（单测推进时间用），等待上限可注入（单测不必真等）。
 */
export function createRebuildRegistry(
  options: {
    now?: () => number;
    maxTracked?: number;
  } = {},
): RebuildRegistry {
  const now = options.now ?? Date.now;
  const maxTracked = options.maxTracked ?? MAX_TRACKED_REBUILDS;
  const entries = new Map<string, ActiveRebuild>();

  const release = (root: string): boolean => {
    const entry = entries.get(root);
    if (entry === undefined) {
      return false;
    }
    entries.delete(root);
    entry.settle();
    return true;
  };

  return {
    claim(root, origin, startedAt): ActiveRebuild | null {
      if (entries.has(root)) {
        return null;
      }
      // 用 withResolvers 而不是先建空 Promise 再补兑现函数：条目一诞生就同时拿到
      // 承诺与兑现器，没有「已构造但还不能兑现」的中间态可被误用。
      const { promise: settled, resolve } = Promise.withResolvers<undefined>();
      const settle = (): void => {
        resolve(undefined);
      };
      const entry: ActiveRebuild = {
        root,
        origin,
        startedAt: startedAt ?? now(),
        phase: "starting",
        jobId: undefined,
        settled,
        settle,
      };
      entries.set(root, entry);
      trimToMax(entries, maxTracked, entry);
      return entry;
    },

    attach(root: string, jobId: JobId): void {
      const entry = entries.get(root);
      // 条目已释放时（超时/取消先到）空转：那次的 zg 已经在别处被收掉了。
      if (entry === undefined) {
        return;
      }
      entry.jobId = jobId;
      entry.phase = "running";
    },

    release,

    active(root: string): ActiveRebuild | undefined {
      return entries.get(root);
    },

    covering(root: string, messages: ZvecGrepMessages): ActiveRebuild | undefined {
      return coveringOf(entries, root, messages);
    },

    hasPollable(root: string): boolean {
      return entries.get(root)?.jobId !== undefined;
    },

    async wait(
      root: string,
      messages: ZvecGrepMessages,
      timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<WaitOutcome> {
      const entry = coveringOf(entries, root, messages);
      if (entry === undefined) {
        return "settled";
      }
      if (signal?.aborted === true) {
        return "aborted";
      }
      // 三条出口各占一个承诺，取最先兑现的那个。没有「撤销自己那条」的动作：
      // 定时器到点自然兑现、取消监听是 once 的，等待者最多兑现一次，多余的那次
      // 只是让一个已经落定的定时器空转到点而已——换来的是不必在收尾里维护定时器与
      // 监听器的成对撤销，也就没有「撤销时它们已经是 undefined」那种分支。
      const settleOutcome = async (): Promise<WaitOutcome> => {
        await entry.settled;
        return "settled";
      };
      const expireOutcome = async (): Promise<WaitOutcome> => {
        await delay(Math.max(0, timeoutMs));
        return "timeout";
      };
      const settled = settleOutcome();
      const expired = expireOutcome();
      // 没有取消信号就只竞两条：与其塞一条永不兑现的承诺占位（那还会在它身上留一段
      // 永远走不到的回执代码），不如根本不把它放进 race。
      const raced =
        signal === undefined ? [settled, expired] : [settled, expired, abortedOutcome(signal)];
      return Promise.race(raced);
    },

    keys(): string[] {
      return [...entries.keys()];
    },
  };
}
