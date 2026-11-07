// 本包与**官方执行器**之间的事实：环境变量下发、超时规则、stdout 截尾、降级提示。
//
// 这四条都有一侧在官方件里（subprocess-local 的凭据擦除、bash-local 的 deadline 与 spill、
// 环形缓冲的消费式游标），mock shell 一个都代表不了；而它们又都是「模型看到什么」的直接组成。

import { describe, it, expect, afterAll } from "vitest";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  startHost,
  installEnvDumpZg,
  zgAvailable,
  TEST_EMBEDDING,
  drainCleanups,
  makeTempDir,
  DUMP_ENV_KEY_NAME,
  DUMP_SECRET_FIELD,
} from "./host-stack.ts";
import type { Cleanups, Host } from "./host-stack.ts";
import { embeddingCached } from "../embedding-cache.ts";

/** 宿主进程里装凭据的那个变量名（配置里只记名字、值现读；假件读的是同一枚）。 */
const ENV_KEY_NAME = DUMP_ENV_KEY_NAME;
/** 密钥值：两条用例都从这里取，断言里不再另写字面量。 */
const FORWARDED_KEY = "sk-forwarded";

/**
 * 这台机器上 zg 守护进程的真实就绪态。判据与 host.ts 同源：`--check-ready` 只用**退出码**
 * 表达就绪与否（非零即未就绪，那条错误没有 `Code:` 行）。用例跟着它给期望值，而不是替
 * 这台机器编一个答案——否则没起 daemon 的开发机上这条必红，起了 daemon 的机器上又永远通过。
 * 不用同步 API：本包的 node/no-sync 只开写盘那一组。
 */
async function daemonReady(timeoutMs = 10_000): Promise<boolean> {
  const child = spawn("zg", ["server", "status", "--check-ready"]);
  // 就绪报告是给人看的状态表，本用例只取退出码；不排空两路流，子进程会挂着不退出。
  child.stdout.resume();
  child.stderr.resume();
  // 不用 events.once：它对 'error' 直接 reject。而「PATH 上有 zg 但不可执行」（EACCES/ENOENT）与「守护进程没起」是同一档事实——未就绪，不该红成一次抛错。
  // 装在对象里：回调里的赋值不参与 TS 的控制流收窄，读出来仍是 boolean 而不是字面量 false。
  const state = { failed: false };
  child.once("error", () => {
    state.failed = true;
  });
  // 守护进程挂住时 close 永不来：到点自己收，而不是等 600s 的用例超时替我们收尾。
  const killer = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [code] = (await once(child, "close")) as [unknown, unknown];
    return !state.failed && code === 0;
  } catch {
    // 'error' 会让 once 以原始错误 reject（PATH 上有 zg 但不可执行就是这一支）：归进未就绪。
    return false;
  } finally {
    clearTimeout(killer);
  }
}

/** 临时工作区。 */
function workspace(cleanups: Cleanups, files: Record<string, string> = {}): string {
  const dir = makeTempDir(cleanups, "zg-exec-");
  for (const [name, body] of Object.entries({
    "auth.ts": "export function authService() { return 1; }\n",
    ...files,
  })) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return dir;
}

/** 一枚独立的 dump 文件（假 zg 往里写子进程环境）。 */
function dumpFile(cleanups: Cleanups): string {
  const dir = makeTempDir(cleanups, "zg-env-");
  return path.join(dir, "env.json");
}

/** 读回假 zg 记下的子进程环境。 */
function readEnv(file: string): Record<string, string | null> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, string | null>;
}

// 这一组全程用 installEnvDumpZg 的假件应答，与机器上装没装真 zg 无关 —— 它钉的是
// 「密钥必须显式转发、继承来的环境变量被官方层擦掉」这条安全事实，按真 zg 在场与否门控会让
// 干净 runner 上这两条永久不执行。
describe("真实宿主：凭据经环境变量下发到 zg 子进程", () => {
  const cleanups: Cleanups = [];

  afterAll(() => {
    // 赋值清空而不是 delete：本仓 lint 的 `typescript/no-dynamic-delete` 不许按计算键删属性。
    // 空串对本包等同「没配」——lib/zg-config.ts 只转发 trim 之后非空的那一份。
    process.env[ENV_KEY_NAME] = "";
    drainCleanups(cleanups);
  });

  it("镜像端点与密钥都到了子进程，而密钥名本身被官方层擦掉", async () => {
    const dump = dumpFile(cleanups);
    const restore = installEnvDumpZg(dump);
    process.env[ENV_KEY_NAME] = FORWARDED_KEY;
    // startHost 也可能抛（配置校验、官方件装载）。原先它在 try 之外：抛时 try 还没进，
    // restore 不执行 ⇒ PATH 永久留着这枚假 zg，后面每条用例的 `zg` 都落到 dump 脚本上。
    let host: Host | undefined;
    try {
      host = await startHost({
        config: {
          hfEndpoint: "https://mirror.example.com/models/",
          allowRemoteEmbedding: true,
          remoteEmbeddingEndpoint: "https://api.example.com/v1",
          remoteEmbeddingApiKeyFrom: ENV_KEY_NAME,
        },
      });
      const ws = workspace(cleanups);
      const outcome = await host.call("zg_status", {}, host.agentOf(ws));
      assert.ok(!outcome.isError, host.textOf(outcome));
      const env = readEnv(dump);
      // 尾斜杠被规范化掉（node-llama-cpp 自己会补）。
      assert.equal(env["HF_ENDPOINT"], "https://mirror.example.com/models");
      assert.equal(env["ZVEC_GREP_ENDPOINT"], "https://api.example.com/v1");
      // 密钥：官方层擦掉了名字命中 /KEY/ 的继承变量，只有本包显式转发的那一份到得了子进程。
      assert.equal(env[DUMP_SECRET_FIELD], null);
      assert.equal(env["ZVEC_GREP_API_KEY"], FORWARDED_KEY);
      // argv 里绝不出现密钥（进程列表/作业 label 都看得见 argv）。
      const commands = host.shellCalls.map((row) => row.request.command).join("\n");
      expect(commands).not.toContain(FORWARDED_KEY);
    } finally {
      restore();
      await host?.dispose();
    }
  }, 60_000);

  it("远程 embedding 关着（默认）时端点与密钥都不下发", async () => {
    const dump = dumpFile(cleanups);
    const restore = installEnvDumpZg(dump);
    process.env[ENV_KEY_NAME] = FORWARDED_KEY;
    let host: Host | undefined;
    try {
      host = await startHost();
      const ws = workspace(cleanups);
      const outcome = await host.call("zg_status", {}, host.agentOf(ws));
      assert.ok(!outcome.isError, host.textOf(outcome));
      const env = readEnv(dump);
      assert.equal(env["ZVEC_GREP_ENDPOINT"], null);
      assert.equal(env["ZVEC_GREP_API_KEY"], null);
    } finally {
      restore();
      await host?.dispose();
    }
  }, 60_000);
});

describe.skipIf(!zgAvailable())("真实执行器：超时规则", () => {
  const cleanups: Cleanups = [];

  afterAll(() => {
    drainCleanups(cleanups);
  });

  it("searchTimeoutMs=1 时官方执行器真的杀掉进程，回执说的是超时而不是退出码", async () => {
    // transport 钉在 cli：本组断言的是官方执行器的 CLI 请求形态（auto 档 + daemon 在场会
    // 走 MCP，那条 lane 没有执行器请求，见传输判定组的用例）。
    const host = await startHost({ config: { searchTimeoutMs: 1, transport: "cli" } });
    const ws = workspace(cleanups);
    try {
      const outcome = await host.call("zg_search", { query: "authService" }, host.agentOf(ws));
      assert.ok(outcome.isError);
      expect(host.textOf(outcome)).toContain("超时");
      // 断言落在官方件的 timeoutMs 上（本包把部署值原样递过去，没有自己的兜底数值）。
      const call = host.shellCalls.find((row) => row.request.command.startsWith("zg --rg"));
      assert.ok(call !== undefined);
      assert.equal(call.spec.timeoutMs, 1);
      assert.equal(call.spec.onExpiry, "kill");
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

/** 建一个真索引的工作区（本地 embedding，离线可建）。 */
async function indexedWorkspace(
  cleanups: Cleanups,
  files: Record<string, string>,
): Promise<string> {
  const dir = workspace(cleanups, files);
  const host = await startHost({
    config: { indexTimeoutMs: 300_000, defaultEmbedding: TEST_EMBEDDING },
  });
  try {
    const outcome = await host.call("zg_index", { confirm: true }, host.agentOf(dir));
    assert.ok(!outcome.isError, host.textOf(outcome));
  } finally {
    await host.dispose();
  }
  return dir;
}

describe.skipIf(!zgAvailable() || !embeddingCached(TEST_EMBEDDING))(
  "真实执行器：stdout 上限与降级提示（索引通道）",
  () => {
    const cleanups: Cleanups = [];

    afterAll(() => {
      drainCleanups(cleanups);
    });

    it("输出超过 stdoutMaxBytes 时截尾被打标", async () => {
      // 长文件 + --preview full + --limit 50：整段源码进 stdout，越过 stdoutMaxBytes。
      const files: Record<string, string> = {};
      for (let index = 0; index < 8; index += 1) {
        const body = Array.from(
          { length: 400 },
          (_unused, line) => `// line ${line} authService marker padding padding`,
        ).join("\n");
        files[`src/mod-${index}.ts`] = `${body}\nexport const v${index} = ${index};\n`;
      }
      const ws = await indexedWorkspace(cleanups, files);
      const host = await startHost({
        config: {
          stdoutMaxBytes: 500,
          searchTimeoutMs: 300_000,
          defaultEmbedding: TEST_EMBEDDING,
          // 断言的是 CLI 请求形态（--limit/--preview 进 argv）；auto 档 daemon 在场会走 MCP。
          transport: "cli",
        },
      });
      try {
        const outcome = await host.call(
          "zg_search",
          { query: "authService", preview: "full", limit: 50 },
          host.agentOf(ws),
        );
        assert.ok(!outcome.isError, host.textOf(outcome));
        // 截尾必须说出来（否则模型会把半份输出当完整证据）。
        expect(host.textOf(outcome)).toContain("截断");
        // 命令侧的 limit 与摘要规则一致（50 = LIMIT_MAX），上限也原样递过去。
        const call = host.shellCalls.find((row) => row.request.command.startsWith("zg --hybrid="));
        assert.ok(call !== undefined);
        assert.equal(call.spec.stdoutMaxBytes, 500);
        expect(call.spec.command).toContain("--limit 50");
        expect(call.spec.command).toContain("--preview full");
      } finally {
        await host.dispose();
      }
    }, 600_000);

    it("clientMode 钉死 direct 时 refresh=background 构造期即拒，命令根本没发出去", async () => {
      // 旧行为是让命令照发、由 zg 静默把刷新关掉、只在 stderr 留一行
      // `warning: --refresh background requires Server mode; Direct mode uses --refresh off`。
      // 退出码照旧 0、命中照旧出——唯独「后台在刷新」是假的，而那是本包该拒的那一类。
      const ws = await indexedWorkspace(cleanups, {});
      const host = await startHost({
        // transport 钉 cli：这一档考的是 CLI 通道的构造期拒绝（auto 档 daemon 在场会走
        // MCP，那条 lane 的 freshness 语义没有「direct 钉死」这回事）。
        config: { clientMode: "direct", defaultEmbedding: TEST_EMBEDDING, transport: "cli" },
      });
      try {
        const outcome = await host.call(
          "zg_search",
          { query: "authService", refresh: "background" },
          host.agentOf(ws),
        );
        assert.ok(outcome.isError, "钉死 direct 时这一档必须在发命令之前停住");
        const text = host.textOf(outcome);
        expect(text).toContain("clientMode");
        // 那句指错方向的出路不该出现：这一档不是「去起个守护进程」能解决的。
        expect(text).not.toContain("zg --server on");
        // 而 zg 自己的降级警告本就不该出现——命令压根没被 dispatch。
        expect(text).not.toContain("requires Server mode");
        expect(host.shellCalls.some((row) => row.request.command.startsWith("zg --rg"))).toBe(
          false,
        );
      } finally {
        await host.dispose();
      }
    }, 600_000);

    it("clientMode=auto 时按守护进程的真实就绪态统一处理：缺席拒、就绪才下发 --refresh background", async () => {
      // 这一档的答案取决于这台机器上守护进程在不在，所以断言跟着真探测走，而不是替它编一个。
      // 两分支都是判据：缺席时必须拒（旧行为是静默降级成 off），就绪时才允许把 background 发出去。
      const ready = await daemonReady();
      // 这条 TOCTOU 是本用例的固有形状：期望值由宿主之外的一次读决定，而宿主自己还会再读一次。
      // 兜法是在调用之后重读一次并要求和第一次一致——不一致就直接点名「这台机器的就绪态在两次读之间变了」，
      // 而不是让后面那组 `命令发没发出去` 的断言替它报红。
      const ws = await indexedWorkspace(cleanups, {});
      // transport 钉 cli：两分支（缺席拒 / 就绪放行）都是 CLI 命令形态的事；auto 档就绪
      // 会走 MCP（没有 --refresh 旗标可言），那条路径归传输判定组的用例。
      const host = await startHost({
        config: { defaultEmbedding: TEST_EMBEDDING, transport: "cli" },
      });
      try {
        const outcome = await host.call(
          "zg_search",
          { query: "authService", refresh: "background" },
          host.agentOf(ws),
        );
        const text = host.textOf(outcome);
        const dispatched = host.shellCalls.find((row) => row.request.command.startsWith("zg --rg"));
        // 断言写成**无条件**的形式，期望值本身由这台机器的真实就绪态决定：分支式 expect 会让
        // 「这次跳过了哪一分支」不可见，而这条用例的价值恰恰在于两分支都被钉住。
        assert.equal(outcome.isError, !ready, "缺席就必须在发命令前停住；就绪就该放行");
        assert.equal(
          // 对 "server on" 比：文案里是 `zg --server on`（0.3.0 旗标形态），
          // 断言只核「出路指到起守护进程」这件事，不钉旗标写法。
          text.includes("server on"),
          !ready,
          "只有缺席那一条分支该给出 `zg --server on` 这条出路",
        );
        expect(text).not.toContain("requires Server mode");
        assert.equal(dispatched !== undefined, ready, "被拒的调用不该把命令发出去");
        // 发出去时命令必须带着 background 这一档（而不是被静默换成 off）；没发出去时无所谓。
        assert.equal(
          (dispatched?.request.command ?? "").includes("--refresh background"),
          ready,
          "命令与请求的那一档必须一致",
        );
        // 就绪态的探测本身是纯读，且挂在系统临时目录上（不因某个会话工作区不存在而失败）。
        const probe = host.shellCalls.find(
          (row) => row.request.command === "zg --server status --check-ready",
        );
        assert.ok(probe !== undefined, "这一档要读守护进程的真实就绪态");
        expect(probe.spec.workdir).toBe(tmpdir());
        const readyAfter = await daemonReady();
        assert.equal(
          readyAfter,
          ready,
          `这台机器的守护进程就绪态在两次读之间变了（先 ${String(ready)} 后 ${String(readyAfter)}）：上面那组断言的期望值不再成立`,
        );
      } finally {
        await host.dispose();
      }
    }, 600_000);
  },
);
