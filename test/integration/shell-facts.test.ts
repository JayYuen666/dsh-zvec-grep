// 本包与**官方执行器**之间的事实：环境变量下发、超时口径、stdout 截尾、降级提示。
//
// 这四条都有一侧在官方件里（subprocess-local 的凭据擦除、bash-local 的 deadline 与 spill、
// 环的消费式游标），mock shell 一个都代表不了；而它们又都是「模型看到什么」的直接组成。

import { describe, it, expect, afterAll } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { startHost, installEnvDumpZg, zgAvailable, TEST_EMBEDDING } from "./host-stack.ts";

const cleanups: (() => void)[] = [];

/** 宿主进程里装凭据的那个变量名（配置里只记名字、值现读）。 */
const ENV_KEY_NAME = "ZG_TEST_EMBED_KEY";
/** 密钥值（两条用例共用同一个，断言里也只引用它一次）。 */
const FORWARDED_KEY = "sk-forwarded";

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

    it("直连模式下 --refresh background 的降级警告原样到模型眼前", async () => {
      // 真 zg 实测原文：`warning: --refresh background requires Server mode; Direct mode uses
      // --refresh off`。它只在 stderr，而成功路径的 stderr 去噪只丢认得的进度行——这条必须留下。
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
        assert.ok(!outcome.isError, host.textOf(outcome));
        const text = host.textOf(outcome);
        expect(text).toContain("requires Server mode");
        // 以本包的 stderr 注形态出现（不是裸贴一行，也不被去噪吃掉）。
        assert.match(text, /zg stderr/iu);
      } finally {
        await host.dispose();
      }
    }, 600_000);
  },
);
