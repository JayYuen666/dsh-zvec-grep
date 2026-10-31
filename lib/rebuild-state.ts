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
import { normalizeRoot, pathInsideRoot } from "./search-predicates.ts";
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

/** 「某条占位已落定」这条承诺的收口：只交回结论，把 promise 本身留在注册表内部。 */
async function settledOutcome(target: ActiveRebuild): Promise<WaitOutcome> {
  await target.settled;
  return "settled";
}

export interface RebuildRegistry {
  /** 原子占位。已有活跃重建 ⇒ null（调用方据此复用而不是再起一条）。 */
  claim: (root: string, origin: RebuildOrigin, startedAt?: number) => ActiveRebuild | null;
  /**
   * 官方注册接纳后补作业 id（同时把阶段推进到 running）。条目已释放则安全空转。
   *
   * 调用方**必须**把 claim 拿到的那枚条目当凭据传进来（第三位）：只按 root 写的话，
   * claim 与 attach 之间那次 await 里占位可能已被释放、同根的新 claim 可能已经顶上来，
   * 旧作业的 id 就会被写进**别人的**条目，新条目回显一个不属于它的、甚至早已落定的
   * 作业号。传了凭据而条目已换代时**不写**并返回 false（调用方据此收掉那条作业）。
   */
  attach: (root: string, jobId: JobId, claimed?: ActiveRebuild) => boolean;
  /**
   * 释放占位并唤醒全部等待者；幂等，返回是否确实释放了一条。
   *
   * 同 attach：传了 claim 的凭据时先校验代次，条目已被同根的新 claim 顶替时返回
   * false 且**不删、不 settle**——否则一份迟到的收尾会把同根的新条目连同它的等待者
   * 一起兑现，同根就能同时跑两条 zg。
   */
  release: (root: string, claimed?: ActiveRebuild) => boolean;
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

/**
 * 活跃表超过这个条数就报警。
 *
 * 它**不是**淘汰阈值。表里的每一条要么正在被调用方起（`starting`：进程可能已经 spawn、
 * 只是官方注册表还没接纳），要么已经拿到作业号（`running`）。两种都不能淘汰——淘汰会把
 * 条目兑现成「已落定」并从表里删掉，等待者被告知结束了，而同根的下一次 claim 会成功，
 * 于是两条 `zg index` 同时啃一份索引，撞上 zg 的写锁直接失败。那正是这个注册表存在的理由。
 *
 * 「`jobId === undefined` 就是还没起进程」这个前提不成立：claim 在 spawn **之前**登记，
 * 所以 undefined 恰恰覆盖了「进程已在跑、作业号还没补上」这段窗口期。在这段窗口里淘汰
 * 占位，调用方手里那枚凭据当场作废，它随后 attach 到一条已不存在的条目上静默空转，
 * 那条 zg 就成了没人管的孤儿。
 *
 * 正常路径上表的大小由并发重建条数决定（官方注册表自己卡着并发数），条目在 release 时
 * 删除。所以超过阈值只可能是「有一次 claim 没配对 release」——那是本包自己的缺陷，
 * 报警让人看见远比悄悄淘汰一条正在跑的重建安全。
 */
export const MAX_TRACKED_REBUILDS = 32;

/**
 * 表超过阈值就报警一次（不删任何条目）。
 *
 * 为什么只报不删：见 MAX_TRACKED_REBUILDS 的注释——两个阶段都可能有真在跑的 zg，
 * 淘汰就是造孤儿。真正该做的是让「有一次 claim 没配对 release」这件事被人看见。
 * 只在刚越过阈值那一刻报一次（回落之后才重新武装），否则每次 claim 都刷一行。
 * @param entries 活跃表
 * @param max 阈值
 * @param alreadyCrowded 上一次判定为「已越阈值」
 * @returns 本次是否越阈值（供调用方回写状态）
 */
function warnIfCrowded(
  entries: Map<string, ActiveRebuild>,
  max: number,
  alreadyCrowded: boolean,
): boolean {
  if (entries.size <= max) {
    return false;
  }
  if (!alreadyCrowded) {
    console.warn(
      `[zvec-grep] 活跃重建表有 ${String(entries.size)} 条，超过阈值 ${String(max)}：` +
        "这不是容量淘汰（淘汰会让正在跑的重建失去占位，同根就能起第二条 zg），" +
        "而是有一次 claim 没配对 release —— 请把这段告警连同调用场景报给维护者。",
    );
  }
  return true;
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
  let crowded = false;

  const release = (root: string, claimed?: ActiveRebuild): boolean => {
    const key = normalizeRoot(root);
    const entry = entries.get(key);
    // 代次校验：传了凭据而当前条目不是它 ⇒ 这次释放属于上一代作业，不许碰新条目。
    if (entry === undefined || (claimed !== undefined && claimed !== entry)) {
      return false;
    }
    entries.delete(key);
    entry.settle();
    // 回落到阈值以下就重新武装告警：下一次真越阈值还要再报一次。
    if (entries.size <= maxTracked) {
      crowded = false;
    }
    return true;
  };

  return {
    claim(root, origin, startedAt): ActiveRebuild | null {
      const key = normalizeRoot(root);
      if (entries.has(key)) {
        return null;
      }
      // 用 withResolvers 而不是先建空 Promise 再补兑现函数：条目一诞生就同时拿到
      // 承诺与兑现器，没有「已构造但还不能兑现」的中间态可被误用。
      const { promise: settled, resolve } = Promise.withResolvers<undefined>();
      const settle = (): void => {
        resolve(undefined);
      };
      const entry: ActiveRebuild = {
        root: key,
        origin,
        startedAt: startedAt ?? now(),
        phase: "starting",
        jobId: undefined,
        settled,
        settle,
      };
      entries.set(key, entry);
      crowded = warnIfCrowded(entries, maxTracked, crowded);
      return entry;
    },

    attach(root: string, jobId: JobId, claimed?: ActiveRebuild): boolean {
      const entry = entries.get(normalizeRoot(root));
      // 条目已释放（超时/取消先到）或已被同根的新 claim 顶替时**不写**：那次的 zg 已经
      // 没有归属，调用方拿到 false 才能把它收掉，而不是让一条作业挂在别人的投影上。
      if (entry === undefined || (claimed !== undefined && claimed !== entry)) {
        return false;
      }
      entry.jobId = jobId;
      entry.phase = "running";
      return true;
    },

    release,

    active(root: string): ActiveRebuild | undefined {
      return entries.get(normalizeRoot(root));
    },

    covering(root: string, messages: ZvecGrepMessages): ActiveRebuild | undefined {
      return coveringOf(entries, normalizeRoot(root), messages);
    },

    async wait(
      root: string,
      messages: ZvecGrepMessages,
      timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<WaitOutcome> {
      const entry = coveringOf(entries, normalizeRoot(root), messages);
      if (entry === undefined) {
        return "settled";
      }
      if (signal?.aborted === true) {
        return "aborted";
      }
      // 两条**需要清理**的出口（等待上限、取消）同抢一枚兑现器，取最先兑现的那个；
      // 条目落定那条另起一条承诺一起 race。收尾在 finally 里成对撤销——不撤销的话，一次再
      // 普通不过的等待都会在 caller 的 signal 上留一个永不触发的 abort 监听，并在事件循环里
      // 留一枚到点才响的定时器；宿主进程常驻，两者都随调用次数累积（重建窗口内每次
      // zg_search / zg_status 都走这里一次）。
      const { promise, resolve } = Promise.withResolvers<WaitOutcome>();
      const timer = setTimeout(
        () => {
          resolve("timeout");
        },
        Math.max(0, timeoutMs),
      );
      const onAbort = (): void => {
        resolve("aborted");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      // 等的是「这条根**不再被任何重建覆盖**」，不是「startedAt 最早的那条落定」：
      // 祖先与后代两条同时覆盖时必须都等到，否则调用方按 settled 重试会再撞 LOCK.BUSY。
      // 逐轮重算覆盖集（而不是并行等所有条目）：一轮的赢家决定下一轮等谁，这是递归不是循环。
      const waitCovering = async (target: ActiveRebuild): Promise<WaitOutcome> => {
        const outcome = await Promise.race([settledOutcome(target), promise]);
        if (outcome !== "settled") {
          return outcome;
        }
        const next = coveringOf(entries, root, messages);
        return next === undefined ? "settled" : waitCovering(next);
      };
      try {
        const outcome = await waitCovering(entry);
        return outcome;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },

    keys(): string[] {
      return [...entries.keys()];
    },
  };
}
