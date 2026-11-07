// 工具执行上下文的**真实宿主**集成测试：本包插件装进官方服务栈，三个 zg_* 工具经官方
// ToolRuntime.execute 全流水线（pre-execute → guard → 调度 → render）跑，命令由官方 bash
// 执行器真 spawn 给真 zg CLI。这里断的是**跨件契约**，不是本包自己的纯函数：
//
//   - 参数表必须落在官方 JSON Schema 子集里（assertSupportedJsonSchema）；
//   - 行 config 经真实 cordis 装载期（schema 校验 + volatile 引用）落到 shell 请求上；
//   - `--check-ready` 的非零退出码被吸收，stdout 里的就绪报告不丢（真 zg 的行为）；
//   - 无索引时的自动改道、命中摘要对**真输出**的解析、root 不存在的前置归因；
//   - ignoreFiles 的存在性预检（上游会把整棵树弄坏，见 e2e 那条）。
//
// 需要真 embedding 模型的那几例（建索引）按模型缓存是否就绪跳过：没有权重时 zg index 要
// 走网络下载，那不是本包契约该背的条件；其余用例只依赖 zg CLI 本身。

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";
import {
  startHost,
  canMakeUnreadableFile,
  zgAvailable,
  TEST_EMBEDDING,
  installFakeZg,
  makeTempDir,
} from "./host-stack.ts";
import type { Host, ShellCall } from "./host-stack.ts";
import { embeddingCached } from "../embedding-cache.ts";
import { readPersistedToken, tokenFilePath } from "../../lib/daemon-token.ts";
import { DEFAULT_EMBEDDING } from "../../lib/embedding-catalog.ts";

/** 索引通道命令前缀（多条用例共用同一份字面量，免 no-duplicate-string）。 */
const INDEX_CALL_PREFIX = "zg --index";
/** 0.3.0 未配置索引的 status 报告字样（多条用例共用）。 */
const NOT_CONFIGURED = "index not configured";

const cleanups: (() => void)[] = [];

/** 预检用例里那条"不存在"的忽略文件名（多处引用，提成常量免得字面量重复触发 sonarjs）。 */
const MISSING_IGNORE = "does-not-exist.ignore";

/** 建一个带源文件的临时工作区，并登记清理。 */
function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "zg-int-"));
  writeFileSync(
    path.join(dir, "auth.ts"),
    'export function authService() {\n  return "token";\n}\n',
  );
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * 以该前缀递进官方执行器的命令行名单（`host.shellCalls` 是台架记下的真实请求，不是文案）。
 */
function commandsSent(host: Host, prefix: string): string[] {
  return host.shellCalls
    .filter((row) => row.request.command.startsWith(prefix))
    .map((row) => row.request.command);
}

/**
 * 该前缀的第一条请求。缺席时红在「没递出这条命令」并带上实际递过的前缀，
 * 而不是红在一次可选链读出的 `undefined`（那只能说明断言拿到的不是字符串）。
 */
function firstCall(host: Host, prefix: string): ShellCall {
  const call = host.shellCalls.find((row) => row.request.command.startsWith(prefix));
  if (call === undefined) {
    const seen = [
      ...new Set(
        host.shellCalls.map((row) => row.request.command.split(" ").slice(0, 2).join(" ")),
      ),
    ];
    assert.fail(`本应递出以 ${prefix} 开头的命令，实际递过的是 ${JSON.stringify(seen)}`);
  }
  return call;
}

/** 「一条都不该递」的判据：红时把命中的命令行原样打出来，便于定位是哪条路径起错了进程。 */
function expectNoCommand(host: Host, prefix: string): void {
  assert.deepEqual(commandsSent(host, prefix), [], `不该递出以 ${prefix} 开头的命令`);
}

/** 取一个当前空闲的回环端口（监听 0 拿到端口后立刻释放，留给 daemon 用）。 */
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

/** 在指定 ZVEC_GREP_HOME 下跑 `zg --server status`，交回 stdout+stderr（非零退出也读）。 */
async function zgStatus(home: string): Promise<string> {
  const child = execFile("zg", ["--server", "status"], {
    env: { ...process.env, ZVEC_GREP_HOME: home },
  });
  let text = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  await once(child, "close");
  return text;
}

/** 兜底终止沙箱 home 里的 daemon（token 已随卸载丢失，只能按 status 打印的 PID 收）。 */
async function stopDaemonByPid(home: string): Promise<void> {
  const status = await zgStatus(home);
  const pid = /PID:\s*(?<pid>\d+)/u.exec(status)?.groups?.["pid"];
  if (pid !== undefined) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {
      // 进程可能已退出：兜底清理失败不改变用例结论。
    }
  }
}

describe.skipIf(!zgAvailable())("真实宿主：工具执行面", () => {
  afterAll(() => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      cleanup();
    }
  });
  describe("真实宿主：工具注册与官方参数表子集", () => {
    it("三个工具经官方注册入口登记，且参数表过官方 JSON Schema 子集校验", async () => {
      const host = await startHost();
      try {
        const names = host.ctx.tools.schemas().map((row) => row.name);
        // 契约是「登记这三枚、且只有这三枚」；登记顺序不是本用例的承诺（顺序变了不该红）。
        expect(names.toSorted()).toStrictEqual(["zg_index", "zg_search", "zg_status"]);
        for (const name of names) {
          const definition = host.ctx.tools.get(name);
          assert.ok(definition !== undefined, name);
          // 官方受支持子集：注册期不验 parameters，但渲染时模型那边会验。anyOf 这类关键词在这里
          // 就会炸——这正是参数表必须留在子集内的硬约束（本包注释里的实测结论）。
          assert.doesNotThrow(() => {
            assertSupportedJsonSchema(definition.parameters);
          }, `${name} parameters`);
          // 输出 schema 由官方 register() 校验过（能取到 definition 即已过），这里补钉 render 全性。
          assert.equal(typeof definition.output.render, "function", name);
        }
        // 闭集枚举与单值/多值并集都从同一份名单来：参数表里的枚举必须与取值器同源。
        const searchTool = host.ctx.tools.get("zg_search");
        assert.ok(searchTool !== undefined, "zg_search 没经官方注册面登记");
        const search = searchTool.parameters as {
          properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }>;
        };
        expect(search.properties["preview"]?.enum).toStrictEqual([
          "none",
          "short",
          "full",
          "detail",
        ]);
        expect(search.properties["refresh"]?.enum).toStrictEqual(["background", "wait", "off"]);
        expect(search.properties["symbolTypes"]?.items?.enum).toStrictEqual([
          "alias",
          "class",
          "enum",
          "function",
          "interface",
          "module",
          "value",
        ]);
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("宿主缺 settings 时 apply 快速失败（宿主服务守卫不是装饰）", async () => {
      const host = await startHost({ settings: false });
      try {
        // 缺席的那一行 inject 仍在等 ⇒ 插件 fiber 未激活，工具一个都没注册。
        expect(host.ctx.tools.schemas()).toStrictEqual([]);
      } finally {
        await host.dispose();
      }
    }, 60_000);
  });

  describe("真实宿主：行 config 经 cordis 装载期落到 shell 请求上", () => {
    it("defaultLimit / searchTimeoutMs 从行 config 走进官方执行器请求", async () => {
      const host = await startHost({ config: { defaultLimit: 3, searchTimeoutMs: 4321 } });
      const ws = workspace();
      try {
        const agent = host.agentOf(ws);
        const outcome = await host.call("zg_search", { query: "authService" }, agent);
        assert.ok(!outcome.isError, host.textOf(outcome));
        // 版本探测之外的第一条前台请求就是这次检索。
        const call = firstCall(host, "zg --rg");
        expect(call.spec.command).toContain("--limit 3");
        expect(call.spec.timeoutMs).toBe(4321);
        expect(call.spec.stdoutMaxBytes).toBe(400_000);
        expect(call.spec.onExpiry).toBe("kill");
        expect(call.spec.workdir).toBe(ws);
      } finally {
        await host.dispose();
      }
    }, 60_000);
  });

  describe("真实宿主：三位工具的真 zg 执行", () => {
    it("zg_status 把真 zg 的原状报告原样交回", async () => {
      const host = await startHost();
      const ws = workspace();
      try {
        const outcome = await host.call("zg_status", {}, host.agentOf(ws));
        assert.ok(!outcome.isError, host.textOf(outcome));
        // 真 zg 在未建索引的工作区上打的原文。
        expect(host.textOf(outcome)).toContain(NOT_CONFIGURED);
        expect(host.textOf(outcome)).toContain(".zvec-grep/index");
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("zg_search 在没有索引时自动改道穷举词法，并显式声明改的是哪条通道", async () => {
      const host = await startHost();
      const ws = workspace();
      try {
        const outcome = await host.call("zg_search", { query: "authService" }, host.agentOf(ws));
        assert.ok(!outcome.isError, host.textOf(outcome));
        const text = host.textOf(outcome);
        expect(text).toContain("穷举词法检索");
        // 真 rg 的输出（含相对路径与带行号的源码行）必须原样到模型眼前。
        expect(text).toContain("auth.ts");
        assert.match(text, /1:\s*export function authService/u);
        // 命令侧：0.3.0 顶层 --rg 在（自动改道就是穷举通道），索引侧旗标不在。
        const call = firstCall(host, "zg --rg");
        expect(call.spec.command).toContain("'authService'");
        expect(call.spec.command).not.toContain("--preview");
        expect(call.spec.command).not.toContain("--refresh");
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("clientMode 行 config 直达真 zg（direct 的形态与 auto 不同）", async () => {
      // 守护进程是否在场因环境而异，故这里只断言命令形态；租约报错的识别由 e2e 用真的并发钉。
      const host = await startHost({
        config: { clientMode: "direct", defaultEmbedding: TEST_EMBEDDING },
      });
      const ws = workspace();
      try {
        const outcome = await host.call("zg_search", { query: "authService" }, host.agentOf(ws));
        assert.ok(!outcome.isError, host.textOf(outcome));
        // workspace() 不预建索引 ⇒ 自动改道穷举通道（0.3.0 顶层 --rg）；--mode direct 照旧透传。
        const call = firstCall(host, "zg --rg");
        expect(call.spec.command).toContain("--mode direct");
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("zg_status --check-ready 的非零退出码被吸收，stdout 的就绪报告不丢", async () => {
      const host = await startHost();
      const ws = workspace();
      try {
        const outcome = await host.call("zg_status", { checkReady: true }, host.agentOf(ws));
        assert.ok(!outcome.isError, host.textOf(outcome));
        const text = host.textOf(outcome);
        // 真 zg：未就绪时 stdout 仍是那份完整报告，退出码才表达「未就绪」。
        expect(text).toContain(NOT_CONFIGURED);
        // 本包把它翻成结论，并且保留原始失败文本（detail）供排查。
        assert.match(text, /未就绪|not ready/iu);
        // 0.3.0 的未就绪报告是四字段布局（0.2.2 的「Next: …」指引行已不存在）。
        expect(text).toContain(NOT_CONFIGURED);
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("默认 embedding 原样进命令行（不换默认、不偷偷回落）", async () => {
      // 这条要钉的是「设置默认值 → 命令行」这一截，与权重无关：真起一次 zg index 时上游会
      // 加载默认那枚模型（实测 stderr 打 `Preparing local/qwen3-embedding-0.6b`，本机有权重所以
      // 只是慢，缺权重的机器会转成一次几百 MB 下载）。故进程换成假件：仍是真 spawn、真 argv、
      // 真执行器记录，但不加载权重，也不受缓存与环境摆布。
      const fakeDir = makeTempDir(cleanups, "zg-int-fake-");
      const restoreFake = installFakeZg({ ms: 20, pidFile: path.join(fakeDir, "zg.pid") });
      const host = await startHost();
      const ws = workspace();
      try {
        const outcome = await host.call(
          "zg_index",
          { confirm: true, maxDepth: 1 },
          host.agentOf(ws),
        );
        assert.ok(!outcome.isError, host.textOf(outcome));
        // 设置卡默认值逐字出现在命令行上（不是「任一 local 模型」那种放过）。
        const call = firstCall(host, INDEX_CALL_PREFIX);
        expect(call.spec.command).toContain(`--embedding '${DEFAULT_EMBEDDING}'`);
      } finally {
        await host.dispose();
        restoreFake();
      }
    }, 60_000);

    it("root 不存在时前置归因，不把 spawn 失败说成「zg 没装」", async () => {
      const host = await startHost();
      const gone = path.join(tmpdir(), "zg-int-vanished", "nope");
      rmSync(gone, { recursive: true, force: true });
      try {
        const outcome = await host.call("zg_status", { root: gone }, host.agentOf(tmpdir()));
        assert.ok(outcome.isError);
        assert.match(host.textOf(outcome), /不存在|no such/iu);
        // 没有目录就不该发出命令：existsSync 预检在 resolve 之前。
        expectNoCommand(host, "zg status");
      } finally {
        await host.dispose();
      }
    }, 60_000);
  });

  describe("真实宿主：ignoreFiles 的存在性预检", () => {
    it("指向不存在文件的 ignoreFiles 在起进程之前就被拒，并说清代价", async () => {
      // 上游实测：一条不存在的 ignore 文件会把整棵工作区索引弄坏（ENOENT 写进索引状态，
      // 之后 index/status 都报同一个错，--reset-paths 清不掉）。本包于是在命令构造前拦下。
      const host = await startHost();
      const ws = workspace();
      try {
        const outcome = await host.call(
          "zg_index",
          { confirm: true, ignoreFiles: [MISSING_IGNORE] },
          host.agentOf(ws),
        );
        assert.ok(outcome.isError);
        expect(host.textOf(outcome)).toContain(MISSING_IGNORE);
        // 一条 zg 都不该起来（起了一次就是一次被弄坏的工作区）。
        expectNoCommand(host, INDEX_CALL_PREFIX);
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("真实存在的 ignore 文件照常放行（预检不放任成「一律拒」）", async () => {
      const host = await startHost();
      const ws = workspace({ ".zvecignore": "*.log\n" });
      try {
        const outcome = await host.call(
          "zg_index",
          { confirm: true, ignoreFiles: [".zvecignore"] },
          host.agentOf(ws),
        );
        assert.ok(!outcome.isError, host.textOf(outcome));
        const call = firstCall(host, INDEX_CALL_PREFIX);
        expect(call.spec.command).toContain("--ignore-file '.zvecignore'");
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("绝对路径的 ignore 文件按原样递过去（预检不把它改成相对 root）", async () => {
      const host = await startHost();
      const ws = workspace();
      // 目录由 mkdtemp 给（不靠 Math.random 的姓名，并行进程不会互相覆盖），
      // 且登记在写文件之前：写失败时留下的是一枚空目录，而不是没人收的孤儿文件。
      const outsideDir = makeTempDir(cleanups, "zg-ignore-");
      const outside = path.join(outsideDir, "external.ignore");
      writeFileSync(outside, "*.log\n");
      try {
        const outcome = await host.call(
          "zg_index",
          { confirm: true, ignoreFiles: [outside] },
          host.agentOf(ws),
        );
        assert.ok(!outcome.isError, host.textOf(outcome));
        const call = firstCall(host, INDEX_CALL_PREFIX);
        expect(call.spec.command).toContain(`--ignore-file '${outside}'`);
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("后台那条路（模型侧后台索引）走同一道预检", async () => {
      const host = await startHost();
      const ws = workspace();
      try {
        const outcome = await host.call(
          "zg_index",
          { confirm: true, background: true, rebuild: true, ignoreFiles: ["nope.ignore"] },
          host.agentOf(ws),
        );
        assert.ok(outcome.isError);
        expect(host.textOf(outcome)).toContain("nope.ignore");
        // 后台路径连作业都不该起（预检在 spawnIndexWrite 的命令构造之前）。
        expect(host.ctx.jobs.list()).toStrictEqual([]);
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("drop 携带索引侧参数被点名拒绝（ignoreFiles 不进 drop 命令，也不该被静默收下）", async () => {
      // buildIndexCommand 的 drop 分支只有 `zg --index <root> --drop`（0.3.0 无 --yes）。索引用不上的
      // 参数静默收下只会让模型以为过滤生效了（也就无从损坏索引），故构造期一次点名拒绝；
      // 存在性预检对 drop 整段跳过，那句"给一个真实存在的忽略文件"不会抢在前面出现。
      const host = await startHost();
      const ws = workspace();
      try {
        const outcome = await host.call(
          "zg_index",
          { confirm: true, drop: true, ignoreFiles: [MISSING_IGNORE] },
          host.agentOf(ws),
        );
        assert.ok(outcome.isError, host.textOf(outcome));
        expect(host.textOf(outcome)).toContain("drop 与这些索引侧参数互斥");
        expect(host.textOf(outcome)).toContain("ignoreFiles");
        // 绝不是那句存在性误拒（预检被 drop 跳过，没读 ignoreFiles）。
        expect(host.textOf(outcome)).not.toContain(MISSING_IGNORE);
        // 没有任何 `zg index` 命令被构造出去（版本下限的探测调用不算——它在占位之前）。
        expectNoCommand(host, INDEX_CALL_PREFIX);
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it.skipIf(!canMakeUnreadableFile())(
      "存在但读不了的 ignore 文件也被拦下（statSync 看不出来，accessSync 才看得出来）",
      async () => {
        // mode 000 的文件 statSync().isFile() 照样为真，而真 zg open 它会 EACCES ⇒ 整次索引
        // 失败并把坏路径写进工作区状态（与"不存在"同一种永久损坏，见 e2e 那条）。预检以
        // accessSync(R_OK) 在前把"当前进程真能读"这半段一并判掉，与"不存在/是目录"合成同一句
        // 文案（可读性那档在 windows/root 下造不出来，拆成独立分支会让 windows 那格覆盖率无从而钉）。
        const host = await startHost();
        const name = "unreadable.ignore";
        const ws = workspace({ [name]: "*.log\n" });
        const target = path.join(ws, name);
        chmodSync(target, 0o000);
        try {
          const outcome = await host.call(
            "zg_index",
            { confirm: true, ignoreFiles: [name] },
            host.agentOf(ws),
          );
          assert.ok(outcome.isError, host.textOf(outcome));
          const text = host.textOf(outcome);
          expect(text).toContain(name);
          // 与"不存在"共用那句「不是一份存在且当前进程可读的文件」文案（点名成因覆盖面）。
          expect(text).toContain("存在且当前进程可读");
          // 一条 zg 都不该起来（起了一次就是一次被弄坏的工作区）。
          expectNoCommand(host, INDEX_CALL_PREFIX);
        } finally {
          chmodSync(target, 0o644);
          await host.dispose();
        }
      },
      60_000,
    );
  });

  describe.skipIf(!embeddingCached(TEST_EMBEDDING))("真实宿主：索引通道（本地 embedding）", () => {
    it("zg_index 真建索引 → 新的 apply 会话走索引通道 → 命中摘要按真输出解析", async () => {
      const ws = workspace();
      const builder = await startHost({ config: { defaultEmbedding: TEST_EMBEDDING } });
      try {
        const built = await builder.call("zg_index", { confirm: true }, builder.agentOf(ws));
        assert.ok(!built.isError, builder.textOf(built));
        assert.match(builder.textOf(built), /files\s+\d+ scanned/iu);
      } finally {
        await builder.dispose();
      }

      // 索引落地后**同一个** apply 会话的探测缓存仍是 60s 内的负向条目（见下一条用例），
      // 所以这里换一台新宿主来走索引通道：缓存是进程内的，新 apply 即干净。
      const fresh = await startHost({ config: { defaultEmbedding: TEST_EMBEDDING } });
      try {
        const outcome = await fresh.call("zg_search", { query: "authService" }, fresh.agentOf(ws));
        assert.ok(!outcome.isError, fresh.textOf(outcome));
        const text = fresh.textOf(outcome);
        // 真 zg 0.3.0 的索引检索输出形状：#N 路径:行号 头行（组头与 hits 计数行已不存在）。
        assert.match(text, /#\d+ .+:\d+/u);
        assert.ok(!text.includes("matchedBy="), "0.3.0 头行没有 matchedBy=");
        // 摘要行由本包从真输出里解析出来（0.3.0 只剩去重位置数这一维）。
        expect(text).toContain("命中摘要");
        expect(text).toContain("去重后 1 个不同位置");
        // 走的是索引通道：没有改道声明，也没有 --rg。
        expect(text).not.toContain("穷举词法检索");
        const call = firstCall(fresh, "zg --hybrid=");
        expect(call.spec.command).not.toContain("--rg");
        expect(call.spec.command).toContain("--refresh wait");
      } finally {
        await fresh.dispose();
      }
    }, 300_000);

    it("建完索引后的那一次检索走索引通道（zg_index 成功即失效探测缓存，不等 60s TTL）", async () => {
      // 历史形态（已修）：探测缓存的负向条目只等 TTL 过期，"先搜（无索引）→ zg_index →
      // 再搜"会拿到过时的 `尚无 zg 索引` 声明 + rg 结果——模型被卡在既搜不到也 grep 不了
      // 的窗口里。现在 zg_index 前台落定即 invalidate 该根的缓存条目，下一次检索必须
      // 走索引通道（不再改道穷举、不再带陈旧声明）。
      const host = await startHost({ config: { defaultEmbedding: TEST_EMBEDDING } });
      const ws = workspace();
      try {
        const agent = host.agentOf(ws);
        const before = await host.call("zg_search", { query: "authService" }, agent);
        assert.ok(!before.isError, host.textOf(before));
        expect(host.textOf(before)).toContain("穷举词法检索");

        const built = await host.call("zg_index", { confirm: true }, agent);
        assert.ok(!built.isError, host.textOf(built));
        const index = firstCall(host, INDEX_CALL_PREFIX);
        expect(index.spec.command).toContain("--embedding");

        const after = await host.call("zg_search", { query: "authService" }, agent);
        assert.ok(!after.isError, host.textOf(after));
        // 索引已在盘上：不再改道穷举，陈旧的负向声明随失效一并消失。
        expect(host.textOf(after)).not.toContain("穷举词法检索");
        expect(host.textOf(after)).not.toContain("尚无 zg 索引");
      } finally {
        await host.dispose();
      }
    }, 300_000);
  });

  describe.skipIf(!embeddingCached(TEST_EMBEDDING))(
    "真实宿主：transport=mcp 全回路（真 daemon + token + 卸载）",
    () => {
      let home: string;
      let previousHome: string | undefined;
      let daemonUrl: string;

      beforeAll(async () => {
        // 隔离 daemon 的状态目录：默认 home 里的模型缓存复制进沙箱（与 e2e 的 MCP lane 同法），
        // 这样索引、daemon 查询都用同一枚离线权重，且不碰用户真实的 ~/.zvec-grep。
        const realHome = process.env["ZVEC_GREP_HOME"] ?? path.join(homedir(), ".zvec-grep");
        home = mkdtempSync(path.join(tmpdir(), "zg-int-mcp-home-"));
        await cp(
          path.join(realHome, "models", "model2vec"),
          path.join(home, "models", "model2vec"),
          { recursive: true },
        );
        previousHome = process.env["ZVEC_GREP_HOME"];
        process.env["ZVEC_GREP_HOME"] = home;
        const port = await freePort();
        daemonUrl = `http://127.0.0.1:${port}/mcp`;
      });

      afterAll(async () => {
        // 卸载停 daemon 若失败（用例红），这里按 PID 兜底终止，绝不把进程留给下一次运行。
        await stopDaemonByPid(home);
        if (previousHome === undefined) {
          delete process.env["ZVEC_GREP_HOME"];
        } else {
          process.env["ZVEC_GREP_HOME"] = previousHome;
        }
        rmSync(home, { recursive: true, force: true });
      });

      it("检索自启 daemon（按 daemonUrl 的 --listen）→ 带 token 的 status/index 成功 → 卸载停 daemon", async () => {
        const ws = workspace();
        const host = await startHost({
          config: { defaultEmbedding: TEST_EMBEDDING, transport: "mcp", daemonUrl },
        });
        try {
          const agent = host.agentOf(ws);
          const built = await host.call("zg_index", { confirm: true }, agent);
          assert.ok(!built.isError, host.textOf(built));

          // 索引通道检索：ensure 走真自启，命令必须带上 daemonUrl 的 host:port。
          const search = await host.call("zg_search", { query: "authService" }, agent);
          assert.ok(!search.isError, host.textOf(search));
          expect(host.textOf(search)).toMatch(/#\d+ .+:\d+/u);
          const starts = commandsSent(host, "zg --server on");
          assert.equal(starts.length, 1, "自启一次");
          expect(starts[0]).toContain(`--listen ${new URL(daemonUrl).host}`);

          // 前台管理命令必须带同一枚 token：真实 daemon 在场时它们走 server 模式。
          const status = await host.call("zg_status", {}, agent);
          assert.ok(!status.isError, host.textOf(status));
          const reindex = await host.call("zg_index", { root: ws, confirm: true }, agent);
          assert.ok(!reindex.isError, host.textOf(reindex));

          // 卸载插件：卸载效应用同一枚 token 停掉自己拉起的 daemon。
          await host.unload();
          const stopped = await zgStatus(home);
          expect(stopped).toContain("stopped");
        } finally {
          await host.dispose();
        }
      }, 300_000);

      it("持久化 token：第二个实例复用同一枚，停 daemon 成功后清理文件", async () => {
        const ws = workspace();
        const config = { defaultEmbedding: TEST_EMBEDDING, transport: "mcp", daemonUrl };
        const first = await startHost({ config });
        const second = await startHost({ config });
        try {
          const built = await first.call("zg_index", { confirm: true }, first.agentOf(ws));
          assert.ok(!built.isError, first.textOf(built));
          const search = await first.call("zg_search", { query: "authService" }, first.agentOf(ws));
          assert.ok(!search.isError, first.textOf(search));
          const startCall = first.shellCalls.find((row) =>
            row.request.command.startsWith("zg --server on"),
          );
          const token = startCall?.request.env?.["ZVEC_GREP_SERVER_TOKEN"] ?? "";
          assert.match(token, /^[0-9a-f]{48}$/u);
          const tokenFile = tokenFilePath();
          assert.equal(await readPersistedToken(tokenFile), token, "自启 token 已持久化");

          // 第二个实例：它先于自启创建，apply 时没有 token 文件；首次检索的 ensure 在
          // daemon 就绪分支懒加载持久化 token，MCP 调用成功。
          const reused = await second.call(
            "zg_search",
            { query: "authService" },
            second.agentOf(ws),
          );
          assert.ok(!reused.isError, second.textOf(reused));

          // 由**启动方**卸载：停 daemon 成功并清理 token 文件；重启方不擅自停别人的 daemon。
          await first.unload();
          await expect(zgStatus(home)).resolves.toContain("stopped");
          assert.equal(await readPersistedToken(tokenFile), undefined, "停成功后清理 token 文件");
        } finally {
          await first.dispose();
          await second.dispose();
        }
      }, 300_000);
    },
  );

  describe("真实宿主：退出码与失败归因", () => {
    it("显式 root 越界被授权判据拒（不是 shell 的错）", async () => {
      const host = await startHost();
      const stranger = workspace();
      const mine = workspace();
      try {
        const outcome = await host.call("zg_status", { root: stranger }, host.agentOf(mine));
        assert.ok(outcome.isError);
        expect(host.textOf(outcome)).toContain("未获授权");
      } finally {
        await host.dispose();
      }
    }, 60_000);
  });
});
