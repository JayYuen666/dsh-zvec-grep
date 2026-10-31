// 设置卡「工作区重建」读面的**真实宿主**测试：真官方作业注册表 + 真本地 bash 执行器 +
// 真进程。与 test/host.test.ts 里那套 mock ctx 的分工：那边验判据（白名单/绝对路径/同根互斥
// 的每一格），这里验**跨件的那几条**：
//
//   - 引导读面在真实 cordis 上注册得到，交回的候选工作区就是这台 daemon 观测到的那些；
//   - 启动读面起来的作业真的进了官方注册表（id/状态/环/泵都由官方件管）；
//   - 轮询读面读得到环里的真输出（stdout+stderr 两路），落定后交回退出码；
//   - 侧表与注册表的「同一枚实例」判据在真实 cordis 上成立（`ctx.get` 每读一次都是新代理，
//     实例身份比较恒为假 ⇒ 这条只有真实宿主能抓到，见 host.ts 的 JobIdentity 注释）；
//   - 卸载时进程与在册作业都被收干净（走官方 kill/remove，不是绕过它直接杀进程）。
//
// 三个读面都按**服务方法的原样**调用（不再包一层 `{status, body}` 的 HTTP 形状：那层壳把
// 成功恒写成 200，于是 `assert.equal(status, 200)` 检的是夹具自己，不是本包）。
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
import type {
  RebuildRefused,
  RebuildRoots,
  RebuildSnapshot,
  RebuildStarted,
  RebuildStartRequest,
  RebuildStartResult,
  RebuildStatusRequest,
  RebuildStatusResult,
} from "../../lib/rebuild-shape.ts";

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

/** 宿主上下文里那枚命名空间服务的三个方法（形状直接取发布侧的声明，不在测试里再造一份）。 */
interface RebuildApi {
  roots: () => Promise<RebuildRoots>;
  rebuild: (request: RebuildStartRequest) => Promise<RebuildStartResult>;
  /** `status` 是**同步**方法（投影全部来自已在手里的侧表与注册表），别 await 一个非 Promise。 */
  status: (request: RebuildStatusRequest) => RebuildStatusResult;
}

/**
 * 本包注册在宿主上下文里的那枚服务（`TypertRemoteService` 以命名空间为自己provide 的键）。
 * 这里**不经官方网关**：网关那一层（客户端 `$mount` 的贡献 + strict codec + `remote.<ns>`
 * 键）由 test/rebuild-remote.test.ts 拿 descriptor 与 `remoteMethods()` 对质钉住，
 * 端到端挂到真 `remote` 服务上则要有客户端 fiber，不在本文件的台架里。
 */
function rebuildApi(host: Host): RebuildApi {
  const service: unknown = host.ctx.get("zvecGrepRebuild");
  assert.ok(service !== undefined, "zvecGrepRebuild 没注册到宿主上下文");
  return service as RebuildApi;
}

/** 引导读面：候选工作区 + 守护进程就绪态。 */
async function readRoots(host: Host): Promise<RebuildRoots> {
  return rebuildApi(host).roots();
}

/** 启动读面：白名单/绝对路径/同根互斥都在服务方法里判。 */
async function startRebuild(host: Host, root: string): Promise<RebuildStartResult> {
  return rebuildApi(host).rebuild({ root });
}

/** 轮询读面。 */
function readStatus(host: Host, jobId: string): RebuildStatusResult {
  return rebuildApi(host).status({ jobId });
}

/**
 * 落定的那条读数。终态判据与生产同口径：**running 与 stopping 都算仍在跑**
 * （`stopping` = 取消已发出、进程还没收完，此时退出码与尾部输出都还没定）。
 * 本文件另一处的 `waitTerminal` 早已排除这两枚；这里原先只排 `running`，
 * 于是同一次等待在两个helper 手里有两种「落定」——一轮落在 stopping 的读数会让
 * 后续那几条 `completed` 断言以「没落定」的形态变红（红的是测量）。
 */
function settledSnapshot(body: RebuildStatusResult): RebuildSnapshot | undefined {
  return body.ok && body.status !== "running" && body.status !== "stopping" ? body : undefined;
}

/** 启动读面的成功臂。`assert.fail` 返回 never，所以判完之后 TS 也认这条窄形。 */
function startedOf(body: RebuildStartResult): RebuildStarted {
  if (!body.ok) {
    assert.fail(`rebuild 应成功，实际 ${body.status} ${body.error}`);
  }
  return body;
}

/** 轮询读面的成功臂。 */
function snapshotOf(body: RebuildStatusResult): RebuildSnapshot {
  if (!body.ok) {
    assert.fail(`status 应读数，实际 ${body.status} ${body.error}`);
  }
  return body;
}

/** 任一读面的拒绝臂（连同它保留下来的语义码——那是"哪条判据拦的"唯一可机判的形态）。 */
function refusedOf(body: RebuildStartResult | RebuildStatusResult): RebuildRefused {
  if (body.ok) {
    assert.fail(`本应被拒，实际放行：${JSON.stringify(body)}`);
  }
  return body;
}

/** 等到落定（递归而非循环：泵式等待是天然串行的）。 */
async function waitSettled(
  host: Host,
  jobId: string,
  deadlineAt: number,
): Promise<RebuildSnapshot> {
  const done = settledSnapshot(readStatus(host, jobId));
  if (done !== undefined) {
    return done;
  }
  // 递归时必须把**同一个**截止点传下去。原先每层重算 Date.now() + timeoutMs，等于没有截止：
  // 作业一直不落定就轮询到 vitest 的用例超时，报出来的是「用例超时」而不是它等的那件事没发生。
  if (Date.now() > deadlineAt) {
    throw new Error(`rebuild ${jobId} did not settle`);
  }
  await sleep(200);
  return waitSettled(host, jobId, deadlineAt);
}

describe.skipIf(!zgAvailable())("真实宿主：重建读面的跨件契约", () => {
  afterAll(() => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      cleanup();
    }
  });

  it("引导读面交回候选工作区与就绪位，roots 就是这台 daemon 观测到的那些", async () => {
    const host = await startHost();
    const ws = observedWorkspace();
    try {
      await observe(ws, host);
      const roots = await readRoots(host);
      // 观测过的工作区出现在候选里（realpath 兼容 macOS 的 /private 前缀）。
      expect(roots.roots.some((root) => root.endsWith(ws.slice(1)) || root === ws)).toBe(true);
      // 候选只来自本插件自己的数据（不是文件系统扫描）。
      expect(roots.roots.length).toBeLessThan(64);
      // 卡片那一行守护进程就绪态由真探测给出：应答里必须有这一位、且是布尔。
      // 具体值由这台机器上 `zg server` 的真实状态决定（断言它可机判，不钉死某一臂）。
      expect(roots.serverReady).toBeTypeOf("boolean");
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it("启动读面：白名单与绝对路径判据都过 ⇒ 真起一条后台作业进官方注册表", async () => {
    const host = await startHost();
    const ws = observedWorkspace();
    try {
      await observe(ws, host);
      const started = startedOf(await startRebuild(host, ws));
      expect(started.jobId).toBeTypeOf("string");

      const { jobId } = started;
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

  it("轮询读面：同 id 的第二次读仍是同一条（侧表与官方注册表认得出同一枚实例）", async () => {
    // 回归用例：真实 cordis 的 `ctx.get("jobs")` 每读一次都是新代理，拿「注册表实例引用」做
    // 身份比较会恒为假 ⇒ 每条活着的重建都回 404。身份判据改用 JobView 上的值三段
    // （kind/label/startedAt）之后，同一条作业的连续轮询才读得到读数。
    const host = await startHost();
    const ws = observedWorkspace();
    try {
      await observe(ws, host);
      const { jobId } = startedOf(await startRebuild(host, ws));
      const running = snapshotOf(readStatus(host, jobId));
      expect(running.status).toBe("running");
      // 再读一次仍是同一条（不是查无此条，也不是另一条）。
      const again = snapshotOf(readStatus(host, jobId));
      expect(again.root).toBe(running.root);
      const settled = await waitSettled(host, jobId, Date.now() + 60_000);
      expect(settled.status).toBe("completed");
    } finally {
      await host.dispose();
    }
  }, 120_000);

  it("白名单仍拦未观测的 root 与相对路径，且不起进程", async () => {
    const host = await startHost();
    const ws = observedWorkspace();
    const stranger = observedWorkspace();
    try {
      await observe(ws, host);
      const before = host.shellCalls.length;

      // 没被观测过的 root：白名单不放行（不是文件系统上存在就能重建）。
      const strangerRun = refusedOf(await startRebuild(host, stranger));
      assert.equal(strangerRun.status, 403);
      assert.match(strangerRun.error, /工作区/u);
      // 相对路径在服务方法里就被拒，不会落到白名单。
      const relative = refusedOf(await startRebuild(host, "relative/root"));
      assert.equal(relative.status, 400);
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
      const first = startedOf(await startRebuild(host, ws));
      const second = startedOf(await startRebuild(host, ws));
      expect(second.jobId).toBe(first.jobId);
      expect(second.reused).toBe(true);
      expect(
        host.shellCalls.filter((row) => row.request.command.startsWith("zg index")),
      ).toHaveLength(1);
      await waitSettled(host, first.jobId, Date.now() + 60_000);
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
      const ghost = refusedOf(readStatus(host, "zvec-grep-rebuild-999"));
      assert.equal(ghost.status, 404);
      expect(ghost.error).toContain("历史窗口");
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

  it("插件被卸载：进程被杀、作业离开 running，且本包全程不注册路由", async () => {
    restoreFake?.();
    restoreFake = installFakeZg({ ms: 5000, pidFile });
    const host = await startHost({ indexTimeoutMs: 60_000 });
    // 这个用例故意造「卸载时还有活作业」：任何一条断言失败都必须把宿主收掉，否则那条
    // 假 zg（ms:5000）与已绑定的端口会留给后面的用例，失败点从断言漂到污染。
    try {
      const ws = observedWorkspace();
      await observe(ws, host);
      const { jobId } = startedOf(await startRebuild(host, ws));
      // 进程真的起来了（假 zg 把 pid 落地）。
      const pid = await waitForPid();
      assert.ok(Number.isInteger(pid) && pid > 0, pidFile);
      expect(host.ctx.jobs.list().some((row) => row.id === jobId)).toBe(true);

      // 旧 URL 在**装载态**就是 404：读面走的是官方网关，不是本包注册的 webServer 路由。
      // 只在卸载之后测一次的话，将来谁把路由加回来也不会红。
      const during = await fetch(`http://127.0.0.1:${host.port}/_dsh/zvec-grep/rebuild-roots`);
      assert.equal(during.status, 404);

      await host.unload();
      // 卸载效应收口：走**官方注册表** kill（不是绕过它直接杀进程）⇒ 名册里那条被推到
      // stopping/killed，模型侧 job_list 看得见结局；环也由官方件收。
      const terminal = await waitTerminal(host, jobId, Date.now() + 5000);
      expect(terminal, "卸载后那条作业必须离开 running").not.toBe("running");

      const alive = await waitForExit(pid);
      assert.equal(alive, false, `进程 ${pid} 必须被收掉`);
    } finally {
      await host.dispose();
    }
  }, 120_000);

  it("超过 indexTimeoutMs：kill 定时器收进程，轮询读面说明为什么没跑完", async () => {
    const host = await startHost({ indexTimeoutMs: 700 });
    const ws = observedWorkspace();
    try {
      await observe(ws, host);
      const settled = await waitSettled(
        host,
        startedOf(await startRebuild(host, ws)).jobId,
        Date.now() + 30_000,
      );
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
      // 不从文案里抠号，也不按名册的**位置**取号（`list()[0]` 会在注册表里多出一条不属于
      // 本包的作业时报错到别条作业身上）。按本包作业的 kind 取，并要求恰好一条——kind 是
      // 独立写死的字面量，不是从被测代码里读出来的，所以它红了就是真的漂了。
      const mine = host.ctx.jobs.list().filter((row) => row.kind === "zvec-grep-rebuild");
      assert.equal(mine.length, 1, `本包侧应有恰好一条作业，实际 ${String(mine.length)} 条`);
      const [row] = mine;
      assert.ok(row, "上一条已要求恰好一条，这里只把下标访问的类型收窄");
      const jobId = String(row.id);
      assert.ok(host.textOf(started).includes(jobId), host.textOf(started));
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
