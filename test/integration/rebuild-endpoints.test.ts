// 设置卡「工作区重建」三条路由的**真实宿主**测试：真 node:http 监听 + 真官方作业注册表 +
// 真本地 bash 执行器 + 真进程。与 test/host.test.ts 里那套 mock req/res 的分工：那边验
// 判据（CSRF/同源/白名单/目录存在的每一种组合），这里验**跨件的那几条**：
//
//   - 引导端点交回的 CSRF 与 roots 在真 HTTP 上原样可用；
//   - 启动端点起来的作业真的进了官方注册表（id/状态/环/泵都由官方件管）；
//   - 轮询端点读得到环里的真输出（stdout+stderr 两路），落定后交回退出码；
//   - 侧表与注册表的「同一枚实例」判据在真实 cordis 上成立（`ctx.get` 每读一次都是新代理，
//     实例身份比较恒为假 ⇒ 这条只有真实宿主能抓到，见 host.ts 的 JobIdentity 注释）；
//   - 卸载时进程与在册作业都被收干净（走官方 kill/remove，不是绕过它直接杀进程）。
//
// 生命周期用例（卸载收进程、超时杀进程）用 installFakeZg 的假 zg：真 zg 的时长受模型加载
// 影响，钉不住「进程真的死了」这种断言；假 zg 仍是真进程、真 spawn、可真杀。

import { describe, it, expect, beforeEach, afterAll, afterEach } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHost, installFakeZg, zgAvailable, sleep } from "./host-stack.ts";
import type { Host } from "./host-stack.ts";

/** `process.kill(pid, 0)` 的存活判据。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 等到那条作业落定（不再是 running/stopping）：返回最终状态词。 */
async function waitTerminal(
  host: Host,
  jobId: string,
  timeoutAt: number,
): Promise<string | undefined> {
  const status = host.ctx.jobs.list().find((row) => row.id === jobId)?.status;
  if (status !== undefined && status !== "running" && status !== "stopping") {
    return status;
  }
  if (Date.now() > timeoutAt) {
    return status;
  }
  await sleep(100);
  return waitTerminal(host, jobId, timeoutAt);
}

/** 逐步等直到进程消失；返回它是否还活着（真的被杀掉就是作业被收干净了）。 */
async function waitForExit(pid: number, timeoutAt = Date.now() + 5000): Promise<boolean> {
  if (!isAlive(pid)) {
    return false;
  }
  if (Date.now() > timeoutAt) {
    return true;
  }
  await sleep(100);
  return waitForExit(pid, timeoutAt);
}

const cleanups: (() => void)[] = [];

/** 临时目录 + 登记清理。 */
function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 一枚待观测的工作区（随后由 observe() 借一次工具调用把它记进重建白名单）。 */
function observedWorkspace(): string {
  const dir = temp("zg-rb-");
  writeFileSync(path.join(dir, "auth.ts"), "export function authService() { return 1; }\n");
  writeFileSync(path.join(dir, ".gitignore"), "dist/\n");
  return dir;
}

/** 让某个 root 进入重建白名单（官方 guard/pre-execute 会登记会话工作区）。 */
async function observe(root: string, host: Host): Promise<void> {
  const outcome = await host.call("zg_status", {}, host.agentOf(root));
  assert.ok(!outcome.isError, host.textOf(outcome));
}

interface RootsBody {
  ok: boolean;
  csrf: string;
  roots: string[];
}

/** 引导端点：拿 CSRF 与候选工作区。 */
async function fetchRoots(host: Host): Promise<{ status: number; body: RootsBody }> {
  const res = await fetch(`http://127.0.0.1:${host.port}/_dsh/zvec-grep/rebuild-roots`);
  return { status: res.status, body: (await res.json()) as RootsBody };
}

interface StartBody {
  ok: boolean;
  jobId?: string;
  reused?: boolean;
  error?: string;
}

/** 启动端点：POST + CSRF + 同源。 */
async function postRebuild(
  host: Host,
  root: string,
  init: { csrf?: string; sameOrigin?: boolean } = {},
): Promise<{ status: number; body: StartBody }> {
  const res = await fetch(
    `http://127.0.0.1:${host.port}/_dsh/zvec-grep/rebuild?root=${encodeURIComponent(root)}`,
    {
      method: "POST",
      headers: {
        ...(init.sameOrigin === false ? { "sec-fetch-site": "cross-site" } : {}),
        ...(init.csrf === undefined ? {} : { "x-zvec-grep-csrf": init.csrf }),
      },
    },
  );
  return { status: res.status, body: (await res.json()) as StartBody };
}

interface StatusBody {
  ok: boolean;
  status?: string;
  exitCode?: number | null;
  output?: string;
  error?: string;
}

/** 轮询端点。 */
async function poll(host: Host, jobId: string): Promise<{ status: number; body: StatusBody }> {
  const res = await fetch(
    `http://127.0.0.1:${host.port}/_dsh/zvec-grep/rebuild-status?jobId=${encodeURIComponent(jobId)}`,
  );
  return { status: res.status, body: (await res.json()) as StatusBody };
}

/** 等到落定（递归而非循环：泵式等待是天然串行的）。 */
async function waitSettled(
  host: Host,
  jobId: string,
  deadlineAt: number,
  timeoutMs = 60_000,
): Promise<StatusBody> {
  const current = await poll(host, jobId);
  if (current.body.ok && current.body.status !== "running") {
    return current.body;
  }
  if (Date.now() > deadlineAt) {
    throw new Error(`rebuild ${jobId} did not settle: ${JSON.stringify(current.body)}`);
  }
  await sleep(200);
  return waitSettled(host, jobId, Date.now() + timeoutMs, timeoutMs);
}

describe.skipIf(!zgAvailable())("真实宿主：重建路由的 HTTP 面", () => {
  afterAll(() => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      cleanup();
    }
  });

  it("引导端点交回 CSRF 与候选工作区，roots 就是这台 daemon 观测到的那些", async () => {
    const host = await startHost();
    const ws = observedWorkspace();
    try {
      await observe(ws, host);
      const { status, body } = await fetchRoots(host);
      assert.equal(status, 200);
      assert.ok(body.ok);
      expect(body.csrf).toBeTypeOf("string");
      assert.ok(body.csrf.length >= 32, body.csrf);
      // 观测过的工作区出现在候选里（realpath 兼容 macOS 的 /private 前缀）。
      expect(body.roots.some((root) => root.endsWith(ws.slice(1)) || root === ws)).toBe(true);
      // 候选只来自本插件自己的数据（不是文件系统扫描）。
      expect(body.roots.length).toBeLessThan(64);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("启动端点：CSRF + 同源 + 白名单都过 ⇒ 真起一条后台作业进官方注册表", async () => {
    const host = await startHost();
    const ws = observedWorkspace();
    try {
      await observe(ws, host);
      const { body: roots } = await fetchRoots(host);
      const started = await postRebuild(host, ws, { csrf: roots.csrf });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      assert.ok(started.body.ok);
      expect(started.body.jobId).toBeTypeOf("string");

      const jobId = started.body.jobId!;
      // 官方注册表里真的有这条（kind + label + 运行态都由官方件管）。
      const listed = host.ctx.jobs.list().find((row) => row.id === jobId);
      expect(listed?.kind).toBe("zvec-grep-rebuild");
      expect(listed?.label).toContain("zg index");
      expect(listed?.label).toContain("--rebuild");
      // 后台 spawn 的请求形态：不带 timeoutMs、onExpiry=none（shell 契约：后台不应用超时）。
      const spawn = host.shellCalls.find((row) => row.request.command.startsWith("zg index"));
      assert.ok(spawn !== undefined);
      assert.equal(spawn.request.timeoutMs, undefined);
      assert.equal(spawn.request.onExpiry, "none");
      expect(spawn.spec.workdir).toBe(ws);

      const settled = await waitSettled(host, jobId, Date.now() + 60_000);
      expect(settled.status).toBe("completed");
      assert.equal(settled.exitCode, 0);
      // 环里两路输出都读得到：stderr 的进度行 + stdout 的统计行（合并投影不许丢任何一路）。
      expect(settled.output).toContain("Scanning files...");
      expect(settled.output).toContain("Indexing complete");
      expect(settled.output).toContain("Workspace index");
    } finally {
      await host.dispose();
    }
  }, 120_000);

  it("轮询端点：同 id 的第二次读也是 200（侧表与官方注册表认得出同一枚实例）", async () => {
    // 回归用例：真实 cordis 的 `ctx.get("jobs")` 每读一次都是新代理，拿「注册表实例引用」做
    // 身份比较会恒为假 ⇒ 每条活着的重建都回 404。身份判据改用 JobView 上的值三段
    // （kind/label/startedAt）之后，同一条作业的连续轮询才读得到读数。
    const host = await startHost();
    const ws = observedWorkspace();
    try {
      await observe(ws, host);
      const { body: roots } = await fetchRoots(host);
      const started = await postRebuild(host, ws, { csrf: roots.csrf });
      const jobId = started.body.jobId!;
      const running = await poll(host, jobId);
      assert.equal(running.status, 200, JSON.stringify(running.body));
      assert.ok(running.body.ok);
      // 再读一次仍是同一条（不是 404，也不是另一条）。
      const again = await poll(host, jobId);
      assert.equal(again.status, 200, JSON.stringify(again.body));
      const settled = await waitSettled(host, jobId, Date.now() + 60_000);
      expect(settled.status).toBe("completed");
    } finally {
      await host.dispose();
    }
  }, 120_000);

  it("两条锁各自生效：缺 CSRF、跨源、root 不在白名单都不起进程", async () => {
    const host = await startHost();
    const ws = observedWorkspace();
    const stranger = observedWorkspace();
    try {
      await observe(ws, host);
      const { body: roots } = await fetchRoots(host);
      const before = host.shellCalls.length;

      const noCsrf = await postRebuild(host, ws, { sameOrigin: true });
      assert.equal(noCsrf.status, 403);
      const crossSite = await postRebuild(host, ws, { csrf: roots.csrf, sameOrigin: false });
      assert.equal(crossSite.status, 403);
      const badToken = await postRebuild(host, ws, { csrf: "not-the-token" });
      assert.equal(badToken.status, 403);
      // 没被观测过的 root：白名单不放行（不是文件系统上存在就能重建）。
      const strangerRun = await postRebuild(host, stranger, { csrf: roots.csrf });
      expect([400, 403, 404]).toContain(strangerRun.status);
      expect(host.shellCalls).toHaveLength(before);
      const indexSpawns = host.shellCalls.filter((row) =>
        row.request.command.startsWith("zg index"),
      );
      expect(indexSpawns).toStrictEqual([]);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("同根第二条启动请求复用在跑的那条（不并发起第二条 zg）", async () => {
    const pidFile = path.join(temp("zg-rb-pid-"), "zg.pid");
    const restore = installFakeZg({ ms: 800, pidFile });
    const host = await startHost();
    const ws = observedWorkspace();
    try {
      await observe(ws, host);
      const { body: roots } = await fetchRoots(host);
      const first = await postRebuild(host, ws, { csrf: roots.csrf });
      assert.ok(first.body.ok);
      const second = await postRebuild(host, ws, { csrf: roots.csrf });
      assert.equal(second.status, 200, JSON.stringify(second.body));
      expect(second.body.jobId).toBe(first.body.jobId);
      expect(second.body.reused).toBe(true);
      expect(
        host.shellCalls.filter((row) => row.request.command.startsWith("zg index")),
      ).toHaveLength(1);
      await waitSettled(host, first.body.jobId!, Date.now() + 60_000);
    } finally {
      restore();
      await host.dispose();
    }
  }, 120_000);

  it("历史窗口外的 jobId 答 404 且不代读别人的作业", async () => {
    const host = await startHost();
    const ws = observedWorkspace();
    try {
      await observe(ws, host);
      const ghost = await poll(host, "zvec-grep-rebuild-999");
      assert.equal(ghost.status, 404);
      assert.ok(!ghost.body.ok);
      expect(ghost.body.error).toContain("历史窗口");
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe.skipIf(!zgAvailable())("真实宿主：后台重建的生命周期", () => {
  const pidDir = mkdtempSync(path.join(tmpdir(), "zg-life-"));
  const pidFile = path.join(pidDir, "zg.pid");
  let restoreFake: (() => void) | undefined;

  beforeEach(() => {
    restoreFake = installFakeZg({ ms: 2000, pidFile });
  });

  afterEach(() => {
    restoreFake?.();
    restoreFake = undefined;
  });

  afterAll(() => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      cleanup();
    }
    rmSync(pidDir, { recursive: true, force: true });
  });

  /** 等假 zg 把 pid 落地（它一被 spawn 就会写）：归帿而非循环。 */
  async function waitForPid(timeoutAt = Date.now() + 5000): Promise<number> {
    if (existsSync(pidFile)) {
      return Number(readFileSync(pidFile, "utf8"));
    }
    if (Date.now() > timeoutAt) {
      throw new Error(`fake zg never wrote ${pidFile}`);
    }
    await sleep(50);
    return waitForPid(timeoutAt);
  }

  it("插件被卸载：进程被杀、作业离开 running、路由一并摘掉", async () => {
    restoreFake?.();
    restoreFake = installFakeZg({ ms: 5000, pidFile });
    const host = await startHost({ indexTimeoutMs: 60_000 });
    const ws = observedWorkspace();
    await observe(ws, host);
    const { body: roots } = await fetchRoots(host);
    const started = await postRebuild(host, ws, { csrf: roots.csrf });
    const jobId = started.body.jobId!;
    // 进程真的起来了（假 zg 把 pid 落地）。
    const pid = await waitForPid();
    assert.ok(Number.isInteger(pid) && pid > 0, pidFile);
    expect(host.ctx.jobs.list().some((row) => row.id === jobId)).toBe(true);

    await host.unload();
    // 卸载效应收口：走**官方注册表** kill（不是绕过它直接杀进程）⇒ 名册里那条被推到
    // stopping/killed，模型侧 job_list 看得见结局；环也由官方件收。
    const terminal = await waitTerminal(host, jobId, Date.now() + 5000);
    expect(terminal, "卸载后那条作业必须离开 running").not.toBe("running");

    const alive = await waitForExit(pid);
    assert.equal(alive, false, `进程 ${pid} 必须被收掉`);
    // 路由也摘掉了：同一 URL 不再由本插件应答（webServer 回 404）。
    const after = await fetch(`http://127.0.0.1:${host.port}/_dsh/zvec-grep/rebuild-roots`);
    assert.equal(after.status, 404);
    await host.dispose();
  }, 120_000);

  it("超过 indexTimeoutMs：kill 定时器收进程，轮询端点说明为什么没跑完", async () => {
    const host = await startHost({ indexTimeoutMs: 700 });
    const ws = observedWorkspace();
    try {
      await observe(ws, host);
      const { body: roots } = await fetchRoots(host);
      const started = await postRebuild(host, ws, { csrf: roots.csrf });
      const settled = await waitSettled(host, started.body.jobId!, Date.now() + 30_000);
      expect(settled.status).not.toBe("running");
      // 超时说明必须出现在投影里（它由本包合成，不进官方环）。
      expect(settled.output).toContain("超时");
    } finally {
      await host.dispose();
    }
  }, 120_000);

  it("模型侧后台索引与设置卡那条路同形：作业号可轮询、落定后交回退出码", async () => {
    const host = await startHost();
    const ws = observedWorkspace();
    try {
      await observe(ws, host);
      const started = await host.call(
        "zg_index",
        { confirm: true, background: true, rebuild: true },
        host.agentOf(ws),
      );
      assert.ok(!started.isError, host.textOf(started));
      const jobId = /zvec-grep-rebuild-\d+/u.exec(host.textOf(started))?.[0];
      assert.ok(jobId !== undefined, host.textOf(started));
      // 同一个官方注册表、同一种投影：卡片与模型看到的是同一条作业。
      expect(host.ctx.jobs.list().some((row) => row.id === jobId)).toBe(true);
      const settled = await waitSettled(host, jobId, Date.now() + 60_000);
      expect(settled.status).toBe("completed");
      assert.equal(settled.exitCode, 0);
    } finally {
      await host.dispose();
    }
  }, 120_000);

  it("重建期间同根的检索不失败（等它落定后重试，而不是把失败直接丢给模型）", async () => {
    const host = await startHost({ indexTimeoutMs: 60_000, config: { rebuildWaitMs: 30_000 } });
    const ws = observedWorkspace();
    try {
      await observe(ws, host);
      const started = await host.call(
        "zg_index",
        { confirm: true, background: true, rebuild: true },
        host.agentOf(ws),
      );
      assert.ok(!started.isError, host.textOf(started));
      const search = await host.call("zg_search", { query: "authService" }, host.agentOf(ws));
      assert.ok(!search.isError, host.textOf(search));
    } finally {
      await host.dispose();
    }
  }, 120_000);
});
