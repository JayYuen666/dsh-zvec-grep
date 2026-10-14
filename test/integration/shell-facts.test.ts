// 本包与**官方执行器**之间的事实：环境变量下发、超时口径、stdout 截尾、降级提示。
//
// 这四条都有一侧在官方件里（subprocess-local 的凭据擦除、bash-local 的 deadline 与 spill、
// 环的消费式游标），mock shell 一个都代表不了；而它们又都是「模型看到什么」的直接组成。

import { describe, it, expect, afterAll } from "vitest";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { startHost, installEnvDumpZg, zgAvailable, TEST_EMBEDDING } from "./host-stack.ts";

const cleanups: (() => void)[] = [];

/** 宿主进程里装凭据的那个变量名（配置里只记名字、值现读）。 */
const ENV_KEY_NAME = "ZG_TEST_EMBED_KEY";
/** 密钥值（两条用例共用同一个，断言里也只引用它一次）。 */
const FORWARDED_KEY = "sk-forwarded";

/**
 * 这台机器上 zg 守护进程的真实就绪态。判据与 host.ts 同源：`--check-ready` 只用**退出码**
 * 表达就绪与否（非零即未就绪，那条错误没有 `Code:` 行）。用例跟着它给期望值，而不是替
 * 这台机器编一个答案——否则没起 daemon 的开发机上这条必红，起了 daemon 的机器上又恒绿。
 * 不用同步 API：本包的 node/no-sync 只开写盘那一组。
 */
async function daemonReady(): Promise<boolean> {
  const child = spawn("zg", ["server", "status", "--check-ready"]);
  // 就绪报告是给人看的状态表，本用例只取退出码；不排空两路流，子进程会挂着不退出。
  child.stdout.resume();
  child.stderr.resume();
  const signals: unknown[] = await once(child, "close");
  return signals[0] === 0;
}

/** 本地 embedding 权重是否已缓存（否则 zg index 要联网下载）。 */
function indexable(): boolean {
  const models = path.join(homedir(), ".zvec-grep", "models");
  return (
    existsSync(path.join(models, "hf_Qwen_Qwen3-Embedding-0.6B-Q8_0.gguf")) ||
    existsSync(path.join(models, "model2vec", "minishlab--potion-code-16M-v2"))
  );
}

/** 临时工作区。 */
function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "zg-exec-"));
  for (const [name, body] of Object.entries({
    "auth.ts": "export function authService() { return 1; }\n",
    ...files,
  })) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 一枚独立的 dump 文件（假 zg 往里写子进程环境）。 */
function dumpFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "zg-env-"));
  const file = path.join(dir, "env.json");
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return file;
}

/** 读回假 zg 记下的子进程环境。 */
function readEnv(file: string): Record<string, string | null> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, string | null>;
}

describe.skipIf(!zgAvailable())("真实宿主：凭据经环境变量下发到 zg 子进程", () => {
  afterAll(() => {
    delete process.env["ZG_TEST_EMBED_KEY"];
    for (const cleanup of cleanups.splice(0).toReversed()) {
      cleanup();
    }
  });

  it("镜像端点与密钥都到了子进程，而密钥名本身被官方层擦掉", async () => {
    const dump = dumpFile();
    const restore = installEnvDumpZg(dump);
    process.env[ENV_KEY_NAME] = FORWARDED_KEY;
    const host = await startHost({
      config: {
        hfEndpoint: "https://mirror.example.com/models/",
        allowRemoteEmbedding: true,
        remoteEmbeddingEndpoint: "https://api.example.com/v1",
        remoteEmbeddingApiKeyFrom: "ZG_TEST_EMBED_KEY",
      },
    });
    const ws = workspace();
    try {
      const outcome = await host.call("zg_status", {}, host.agentOf(ws));
      assert.ok(!outcome.isError, host.textOf(outcome));
      const env = readEnv(dump);
      // 尾斜杠被规范化掉（node-llama-cpp 自己会补）。
      assert.equal(env["HF_ENDPOINT"], "https://mirror.example.com/models");
      assert.equal(env["ZVEC_GREP_ENDPOINT"], "https://api.example.com/v1");
      // 密钥：官方层擦掉了名字命中 /KEY/ 的继承变量，只有本包显式转发的那一份到得了子进程。
      assert.equal(env["SECRET_NAME"], null);
      assert.equal(env["ZVEC_GREP_API_KEY"], "sk-forwarded");
      // argv 里绝不出现密钥（进程列表/作业 label 都看得见 argv）。
      const commands = host.shellCalls.map((row) => row.request.command).join("\n");
      expect(commands).not.toContain(FORWARDED_KEY);
    } finally {
      restore();
      await host.dispose();
    }
  }, 60_000);

  it("远程 embedding 关着（默认）时端点与密钥都不下发", async () => {
    const dump = dumpFile();
    const restore = installEnvDumpZg(dump);
    process.env[ENV_KEY_NAME] = FORWARDED_KEY;
    const host = await startHost();
    const ws = workspace();
    try {
      const outcome = await host.call("zg_status", {}, host.agentOf(ws));
      assert.ok(!outcome.isError, host.textOf(outcome));
      const env = readEnv(dump);
      assert.equal(env["ZVEC_GREP_ENDPOINT"], null);
      assert.equal(env["ZVEC_GREP_API_KEY"], null);
    } finally {
      restore();
      await host.dispose();
    }
  }, 60_000);
});

describe.skipIf(!zgAvailable())("真实执行器：超时口径", () => {
  it("searchTimeoutMs=1 时官方执行器真的杀掉进程，回执说的是超时而不是退出码", async () => {
    const host = await startHost({ config: { searchTimeoutMs: 1 } });
    const ws = workspace();
    try {
      const outcome = await host.call("zg_search", { query: "authService" }, host.agentOf(ws));
      assert.ok(outcome.isError);
      expect(host.textOf(outcome)).toContain("超时");
      // 断言落在官方件的 timeoutMs 上（本包把部署值原样递过去，没有自己的兜底数值）。
      const call = host.shellCalls.find((row) => row.request.command.startsWith("zg query"));
      assert.ok(call !== undefined);
      assert.equal(call.spec.timeoutMs, 1);
      assert.equal(call.spec.onExpiry, "kill");
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

/** 建一个真索引的工作区（本地 embedding，离线可建）。 */
async function indexedWorkspace(files: Record<string, string>): Promise<string> {
  const dir = workspace(files);
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

describe.skipIf(!zgAvailable() || !indexable())(
  "真实执行器：stdout 上限与降级提示（索引通道）",
  () => {
    afterAll(() => {
      for (const cleanup of cleanups.splice(0).toReversed()) {
        cleanup();
      }
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
      const ws = await indexedWorkspace(files);
      const host = await startHost({
        config: {
          stdoutMaxBytes: 20_000,
          searchTimeoutMs: 300_000,
          defaultEmbedding: TEST_EMBEDDING,
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
        // 命令侧的 limit 与摘要口径一致（50 = LIMIT_MAX），上限也原样递过去。
        const call = host.shellCalls.find((row) => row.request.command.startsWith("zg query"));
        assert.ok(call !== undefined);
        assert.equal(call.spec.stdoutMaxBytes, 20_000);
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
      const ws = await indexedWorkspace({});
      const host = await startHost({
        config: { clientMode: "direct", defaultEmbedding: TEST_EMBEDDING },
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
        expect(text).not.toContain("zg server on");
        // 而 zg 自己的降级警告本就不该出现——命令压根没被 dispatch。
        expect(text).not.toContain("requires Server mode");
        expect(host.shellCalls.some((row) => row.request.command.startsWith("zg query"))).toBe(
          false,
        );
      } finally {
        await host.dispose();
      }
    }, 600_000);

    it("clientMode=auto 时按守护进程的真实就绪态收口：缺席拒、就绪才下发 --refresh background", async () => {
      // 这一档的答案取决于这台机器上守护进程在不在，所以断言跟着真探测走，而不是替它编一个。
      // 两臂都是判据：缺席时必须拒（旧行为是静默降级成 off），就绪时才允许把 background 发出去。
      const ready = await daemonReady();
      const ws = await indexedWorkspace({});
      const host = await startHost({ config: { defaultEmbedding: TEST_EMBEDDING } });
      try {
        const outcome = await host.call(
          "zg_search",
          { query: "authService", refresh: "background" },
          host.agentOf(ws),
        );
        const text = host.textOf(outcome);
        const dispatched = host.shellCalls.find((row) =>
          row.request.command.startsWith("zg query"),
        );
        // 断言写成**无条件**的形式，期望值本身由这台机器的真实就绪态决定：分支式 expect 会让
        // 「这次跳过了哪一臂」不可见，而这条用例的价值恰恰在于两臂都被钉住。
        assert.equal(outcome.isError, !ready, "缺席就必须在发命令前停住；就绪就该放行");
        assert.equal(
          text.includes("zg server on"),
          !ready,
          "只有缺席那一臂该给出 `zg server on` 这条出路",
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
          (row) => row.request.command === "zg server status --check-ready",
        );
        assert.ok(probe !== undefined, "这一档要读守护进程的真实就绪态");
        expect(probe.spec.workdir).toBe(tmpdir());
      } finally {
        await host.dispose();
      }
    }, 600_000);
  },
);
