// lib/rebuild-state.ts 的单元测试：占位的互斥、作业 id 的补写时机、释放的幂等、
// 等待者的四种出口，以及容量上限。纯逻辑，不触宿主面。
import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { getEventListeners } from "node:events";
// 官方作业品牌串的**值**形式（JobId("x") 只是给同一个字符串贴牌，不做校验）。
// 测试不是产物，值导入不破坏 host.js 的自包含；生产侧一律 type-only。
import { JobId as jobIdOf } from "@deepseek-ai/dsh-jobs";
import { MESSAGES } from "../lib/messages.ts";
import { createRebuildRegistry } from "../lib/rebuild-state.ts";

/** 本组反复出现的工作区路径：祖先根、子目录。 */
const REPO = "/repo";
const PKG = "/repo/pkg";

/** 覆盖判据只为判路径归属，文案表在这一层是摆设（异常文本被丢弃，出界才是结论）。 */
const { zh } = MESSAGES;

/** 挂在某枚 signal 上的 abort 监听数：用来钉「收尾真的把监听撤销了」。 */
function liveAbortListeners(signal: AbortSignal): number {
  return getEventListeners(signal, "abort").length;
}

/** 可控时钟：让 startedAt 的断言不依赖真实时间。 */
function fixedClock(start = 1000): () => number {
  let current = start;
  return () => {
    current += 1;
    return current;
  };
}

describe("占位互斥", () => {
  it("同一根第二次 claim 被拒，调用方据此复用而不是再起一条", () => {
    const rebuilds = createRebuildRegistry();
    assert.notEqual(rebuilds.claim("/ws", "card"), null, "首次占位应当成功");
    assert.equal(rebuilds.claim("/ws", "tool"), null);
    assert.deepEqual(rebuilds.keys(), ["/ws"]);
  });

  it("不同根互不影响，可以并行", () => {
    const rebuilds = createRebuildRegistry();
    assert.notEqual(rebuilds.claim("/a", "card"), null);
    assert.notEqual(rebuilds.claim("/b", "tool"), null);
    assert.deepEqual(rebuilds.keys().toSorted(), ["/a", "/b"]);
  });

  it("释放之后同一根可以再次占位", () => {
    const rebuilds = createRebuildRegistry();
    rebuilds.claim("/ws", "card");
    assert.equal(rebuilds.release("/ws"), true);
    assert.equal(rebuilds.release("/ws"), false, "重复释放必须是空转");
    assert.notEqual(rebuilds.claim("/ws", "tool"), null);
  });
});

describe("占位不是可轮询记录", () => {
  it("官方注册之前没有作业 id，hasPollable 为假", () => {
    const rebuilds = createRebuildRegistry();
    rebuilds.claim("/ws", "card");
    assert.equal(rebuilds.active("/ws")?.jobId, undefined);
    assert.equal(rebuilds.hasPollable("/ws"), false);
  });

  it("attach 之后才有作业 id，阶段同步推进到运行", () => {
    const rebuilds = createRebuildRegistry();
    rebuilds.claim("/ws", "card");
    rebuilds.attach("/ws", jobIdOf("job-1"));
    const entry = rebuilds.active("/ws");
    assert.ok(entry !== undefined, "attach 之后条目仍在");
    assert.equal(entry.jobId, "job-1");
    assert.equal(entry.phase, "running");
    assert.equal(rebuilds.hasPollable("/ws"), true);
  });

  it("条目已释放时 attach 安全空转，不复活一条占位", () => {
    const rebuilds = createRebuildRegistry();
    rebuilds.claim("/ws", "card");
    rebuilds.release("/ws");
    rebuilds.attach("/ws", jobIdOf("job-1"));
    assert.equal(rebuilds.active("/ws"), undefined);
    assert.equal(rebuilds.hasPollable("/ws"), false);
  });
});

describe("等待者", () => {
  it("等到落定", async () => {
    const rebuilds = createRebuildRegistry();
    rebuilds.claim("/ws", "card");
    const waiting = rebuilds.wait("/ws", zh, 5000);
    rebuilds.release("/ws");
    assert.equal(await waiting, "settled");
  });

  it("条目在等待开始前已消失也算落定（不悬挂）", async () => {
    const rebuilds = createRebuildRegistry();
    assert.equal(await rebuilds.wait("/ws", zh, 5000), "settled");
  });

  it("超时自己先到头，且不释放别人的占位", async () => {
    const rebuilds = createRebuildRegistry();
    rebuilds.claim("/ws", "card");
    assert.equal(await rebuilds.wait("/ws", zh, 0), "timeout");
    assert.ok(rebuilds.active("/ws"), "等待者超时不得动占位");
  });

  it("调用前已取消的信号直接判中止", async () => {
    const rebuilds = createRebuildRegistry();
    rebuilds.claim("/ws", "card");
    const controller = new AbortController();
    controller.abort();
    assert.equal(await rebuilds.wait("/ws", zh, 5000, controller.signal), "aborted");
  });

  it("不传取消信号时也能等到落定（无信号那一档不参与竞争）", async () => {
    const rebuilds = createRebuildRegistry();
    rebuilds.claim("/ws", "card");
    const waiting = rebuilds.wait("/ws", zh, 5000);
    rebuilds.release("/ws");
    assert.equal(await waiting, "settled");
  });

  it("等待途中取消", async () => {
    const rebuilds = createRebuildRegistry();
    rebuilds.claim("/ws", "card");
    const controller = new AbortController();
    const waiting = rebuilds.wait("/ws", zh, 60_000, controller.signal);
    controller.abort();
    assert.equal(await waiting, "aborted");
  });

  it("先到的出口生效后，后来者不改变结论（收尾只兑现一次）", async () => {
    const rebuilds = createRebuildRegistry();
    rebuilds.claim("/ws", "card");
    // 超时先到（0ms），随后重建才落定：等待者必须停在「超时」这个结论上。
    assert.equal(await rebuilds.wait("/ws", zh, 0), "timeout");
    rebuilds.release("/ws");
    // 再等一次：条目已消失，按约定算落定而不是又超时一次。
    assert.equal(await rebuilds.wait("/ws", zh, 0), "settled");
  });

  it("多个等待者都被同一次释放唤醒", async () => {
    const rebuilds = createRebuildRegistry();
    rebuilds.claim("/ws", "card");
    const waits = [
      rebuilds.wait("/ws", zh, 5000),
      rebuilds.wait("/ws", zh, 5000),
      rebuilds.wait("/ws", zh, 5000),
    ];
    rebuilds.release("/ws");
    assert.deepEqual(await Promise.all(waits), ["settled", "settled", "settled"]);
  });
});

describe("等待者的收尾（不留监听与悬挂定时器）", () => {
  // 早先的实现让三条出口各占一条承诺、谁赢了都不撤销另外两条：一次再普通不过的等待都会在
  // caller 的 signal 上留一个永不触发的 abort 监听，并在事件循环里留一枚到点才响的定时器。
  // 宿主进程常驻，重建窗口内每次检索都走这里一次 ⇒ 两者都随调用次数累积。
  it("等到落定：abort 监听被撤销", async () => {
    const rebuilds = createRebuildRegistry();
    rebuilds.claim("/ws", "card");
    const controller = new AbortController();
    const waiting = rebuilds.wait("/ws", zh, 60_000, controller.signal);
    rebuilds.release("/ws");
    assert.equal(await waiting, "settled");
    assert.equal(
      liveAbortListeners(controller.signal),
      0,
      "落定后不得把监听留在 caller 的 signal 上",
    );
  });

  it("超时：abort 监听被撤销", async () => {
    const rebuilds = createRebuildRegistry();
    rebuilds.claim("/ws", "card");
    const controller = new AbortController();
    assert.equal(await rebuilds.wait("/ws", zh, 0, controller.signal), "timeout");
    assert.equal(liveAbortListeners(controller.signal), 0);
  });

  it("取消胜出：不留悬挂的等待上限定时器", async () => {
    // 「取消胜出」那一档的监听本来就靠 `once` 语义被摘掉，断言它撤销监听区分不出实现；
    // 能区分的是**定时器**：旧实现让等待上限那枚 setTimeout 留在事件循环里到点才响。
    const rebuilds = createRebuildRegistry();
    rebuilds.claim("/ws", "card");
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const waiting = rebuilds.wait("/ws", zh, 60_000, controller.signal);
      controller.abort();
      assert.equal(await waiting, "aborted");
      assert.equal(liveAbortListeners(controller.signal), 0);
      assert.equal(vi.getTimerCount(), 0, "取消出口也要 clearTimeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("落定后不留悬挂的等待上限定时器", async () => {
    // 假定时器让「那枚 60s 的等待上限还在不在」变成可断言的事实：真实定时器只会让
    // 调用方（与常驻宿主）多在事件循环里背一段到点才响的等待。
    vi.useFakeTimers();
    try {
      const rebuilds = createRebuildRegistry();
      rebuilds.claim("/ws", "card");
      const waiting = rebuilds.wait("/ws", zh, 60_000);
      rebuilds.release("/ws");
      assert.equal(await waiting, "settled");
      assert.equal(vi.getTimerCount(), 0, "收尾必须 clearTimeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("覆盖判据（covering）", () => {
  it("精确键命中：active 与 covering 对同一根给同一条", () => {
    const rebuilds = createRebuildRegistry();
    rebuilds.claim(REPO, "card");
    assert.equal(rebuilds.covering(REPO, zh), rebuilds.active("/repo"));
  });

  it("祖先根在重建 → 子目录查询命中（这正是门禁等得到、等待等不到的那个缺口）", () => {
    const rebuilds = createRebuildRegistry();
    const entry = rebuilds.claim(REPO, "card");
    for (const descendant of [PKG, `${PKG}/src`, "/repo/", "/repo/a/b/c"]) {
      assert.equal(rebuilds.covering(descendant, zh), entry, `${descendant} 应命中祖先的重建`);
    }
  });

  it("兄弟目录与别处的重建都不命中（不同树互不影响）", () => {
    const rebuilds = createRebuildRegistry();
    rebuilds.claim(PKG, "card");
    for (const other of ["/repo", "/repo/other", "/other", "/repo-pkg", "/"]) {
      assert.equal(rebuilds.covering(other, zh), undefined, `${other} 不该命中 /repo/pkg 的重建`);
    }
  });

  it("后代根在重建时不命中祖先的查询（zg 的锁按工作区 home 走，那条重建不挡读）", () => {
    // 反向判成「相关」会让 zg_status /repo 谎报「正在重建」——那比等不到更糟。
    const rebuilds = createRebuildRegistry();
    rebuilds.claim(PKG, "card");
    assert.equal(rebuilds.covering(REPO, zh), undefined);
  });

  it("多条都覆盖时取 startedAt 最早的那条（判据与结果都确定）", () => {
    // startedAt 显式给，不靠注入时钟的推进顺序（那样「谁先 claim」和「谁 startedAt 早」
    // 会缠在一起，测的就不是这条判据了）。
    const rebuilds = createRebuildRegistry();
    // 先 claim 的那条 startedAt 更晚：插入序与时间序故意相反。
    const pkg = rebuilds.claim(PKG, "tool", 200);
    const repo = rebuilds.claim(REPO, "card", 100);
    assert.ok(pkg !== null && repo !== null);
    // 祖先 /repo 与 /repo/pkg 都覆盖 /repo/pkg/src；startedAt 早的那条胜出。
    assert.equal(rebuilds.covering(`${PKG}/src`, zh), repo);
    assert.equal(rebuilds.covering(PKG, zh), repo);
  });

  it("startedAt 相同时仍返回确定的一条（同毫秒并发 claim）", () => {
    const rebuilds = createRebuildRegistry();
    const pkgEntry = rebuilds.claim(PKG, "tool", 7);
    const repoEntry = rebuilds.claim(REPO, "card", 7);
    assert.ok(pkgEntry !== null && repoEntry !== null);
    // 同毫秒时保留遍历先到的那条（Map 插入序），两次调用给同一个对象。
    assert.equal(rebuilds.covering(`${PKG}/src`, zh), pkgEntry);
    assert.equal(rebuilds.covering(`${PKG}/src`, zh), rebuilds.covering(`${PKG}/src`, zh));
  });

  it("等待也走同一条覆盖判据：等的是覆盖查询根的那条，不是精确键", async () => {
    const rebuilds = createRebuildRegistry();
    rebuilds.claim(REPO, "card");
    const waiting = rebuilds.wait(PKG, zh, 5000);
    rebuilds.release(REPO);
    assert.equal(await waiting, "settled", "子目录的等待者应被祖先那条重建的释放唤醒");
  });

  it("子目录等待不会被无关根的释放唤醒（各等各的）", async () => {
    const rebuilds = createRebuildRegistry();
    rebuilds.claim(PKG, "card");
    // /other 不被 /repo/pkg 覆盖 ⇒ 立刻落定，不空等。
    assert.equal(await rebuilds.wait("/other", zh, 5000), "settled");
    assert.equal(rebuilds.active(PKG) !== undefined, true, "等待不得动别人的占位");
  });
});

describe("容量阈值", () => {
  it("超过阈值只报警、不淘汰：在途的一条被挤掉会让同根起第二条 zg", () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown): void => {
      warned.push(String(message));
    };
    try {
      const rebuilds = createRebuildRegistry({ maxTracked: 2 });
      // A 刚 claim、还在起进程（jobId 仍是 undefined）：这正是旧实现会淘汰的那一档。
      const a = rebuilds.claim("/a", "card");
      assert.ok(a !== null);
      assert.equal(a.jobId, undefined);
      rebuilds.claim("/b", "card");
      rebuilds.claim("/c", "card");
      // 三条全在，一条都没被删。
      assert.deepEqual(rebuilds.keys().toSorted(), ["/a", "/b", "/c"]);
      // A 的条目还是同一个对象：调用方手里那枚凭据没作废。
      assert.equal(rebuilds.active("/a"), a);
      // 同根仍然互斥：旧实现把它淘汰掉之后这里会成功。
      assert.equal(rebuilds.claim("/a", "tool"), null);
    } finally {
      console.warn = original;
    }
    assert.equal(warned.filter((line) => line.includes("活跃重建表")).length, 1, "只报一次");
    assert.match(warned.join("\n"), /超过阈值 2/u);
  });

  it("在途占位的等待者不会被超限误唤醒（淘汰会把它兑现成「已落定」）", async () => {
    // 这一跑也会越过阈值：告警本身不是被测对象，屏蔽掉以免 stderr 横幅进噪点表。
    const original = console.warn;
    console.warn = (): void => undefined;
    try {
      const rebuilds = createRebuildRegistry({ maxTracked: 1 });
      rebuilds.claim("/repo", "card");
      const waiting = rebuilds.wait("/repo", zh, 60_000);
      rebuilds.claim("/other", "tool");
      // 用 setTimeout 的 promise 形态（`timers/promises`）：既避开 promise(avoid-new)，
      // 也不用自己包一层 executor。
      const raced = await Promise.race([waiting, delay(20, "still-waiting")]);
      assert.equal(raced, "still-waiting", "占位还在，等待者不该被告知已落定");
      // 真释放才唤醒。
      rebuilds.release("/repo");
      assert.equal(await waiting, "settled");
    } finally {
      console.warn = original;
    }
  });

  it("回落到阈值以下才重新武装告警（不在每次 claim 时刷屏）", () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown): void => {
      warned.push(String(message));
    };
    try {
      const rebuilds = createRebuildRegistry({ maxTracked: 1 });
      rebuilds.claim("/a", "card");
      rebuilds.claim("/b", "card");
      rebuilds.claim("/c", "card");
      // 仍在阈值之上：不再重复报。
      rebuilds.claim("/d", "card");
      assert.equal(warned.length, 1);
      // 回落到阈值以内之后再越阈，应该再报一次。
      rebuilds.release("/b");
      rebuilds.release("/c");
      rebuilds.release("/d");
      rebuilds.claim("/e", "card");
      rebuilds.claim("/f", "card");
      assert.equal(warned.length, 2);
    } finally {
      console.warn = original;
    }
  });
});

describe("时钟注入", () => {
  it("startedAt 取注入的时钟", () => {
    const rebuilds = createRebuildRegistry({ now: fixedClock(500) });
    const entry = rebuilds.claim("/ws", "card");
    assert.equal(entry?.startedAt, 501);
  });

  it("显式传入的 startedAt 优先于时钟", () => {
    const rebuilds = createRebuildRegistry({ now: fixedClock(500) });
    assert.equal(rebuilds.claim("/ws", "card", 42)?.startedAt, 42);
  });
});
