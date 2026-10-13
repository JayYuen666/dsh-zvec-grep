// 工具执行面的**真实宿主**集成测试：本包插件装进官方服务栈，三个 zg_* 工具经官方
// ToolRuntime.execute 全管线（pre-execute → guard → 调度 → render）跑，命令由官方 bash
// 执行器真 spawn 给真 zg CLI。这里断的是**跨件契约**，不是本包自己的纯函数：
//
//   - 参数面活在官方 JSON Schema 子集里（assertSupportedJsonSchema）；
//   - 行 config 经真实 cordis 装载期（schema 校验 + volatile 引用）落到 shell 请求上；
//   - `--check-ready` 的非零退出码被吸收，stdout 里的就绪报告不丢（真 zg 的行为）；
//   - 无索引时的自动改道、命中摘要对**真输出**的解析、root 不存在的前置归因；
//   - ignoreFiles 的存在性预检（上游会把整棵树弄坏，见 e2e 那条）。
//
// 需要真 embedding 模型的那几例（建索引）按模型缓存是否就绪跳过：没有权重时 zg index 要
// 走网络下载，那不是本包契约该背的条件；其余用例只依赖 zg CLI 本身。

import { describe, it, expect, afterAll } from "vitest";
import assert from "node:assert/strict";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";
import { startHost, canMakeUnreadableFile, zgAvailable, TEST_EMBEDDING } from "./host-stack.ts";

const cleanups: (() => void)[] = [];

/** 预检用例里那条"不存在"的忽略文件名（多处引用，提成常量免得字面量重复触发 sonarjs）。 */
const MISSING_IGNORE = "does-not-exist.ignore";

/** 本地 embedding 权重是否已缓存（否则 zg index 要联网下载 ⇒ 跳过索引路径用例）。 */
function localModelCached(): boolean {
  const models = path.join(homedir(), ".zvec-grep", "models");
  return (
    existsSync(path.join(models, "hf_Qwen_Qwen3-Embedding-0.6B-Q8_0.gguf")) ||
    existsSync(path.join(models, "model2vec", "minishlab--potion-code-16M-v2"))
  );
}

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

describe.skipIf(!zgAvailable())("真实宿主：工具执行面", () => {
  afterAll(() => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      cleanup();
    }
  });
  describe("真实宿主：工具注册与官方参数面子集", () => {
    it("三个工具经官方注册面登记，且参数面过官方 JSON Schema 子集校验", async () => {
      const host = await startHost();
      try {
        const names = host.ctx.tools.schemas().map((row) => row.name);
        expect(names).toStrictEqual(["zg_search", "zg_index", "zg_status"]);
        for (const name of names) {
          const definition = host.ctx.tools.get(name);
          assert.ok(definition !== undefined, name);
          // 官方受支持子集：注册期不验 parameters，但模型面渲染验。anyOf 这类关键词在这里
          // 就会炸——这正是参数面必须留在子集内的硬约束（本包注释里的实测结论）。
          assert.doesNotThrow(() => {
            assertSupportedJsonSchema(definition.parameters);
          }, `${name} parameters`);
          // 输出面由官方 register() 校验过（能取到 definition 即已过），这里补钉 render 全性。
          assert.equal(typeof definition.output.render, "function", name);
        }
        // 闭集枚举与单值/多值并集都从同一份名单来：参数面里的枚举必须与取值器同源。
        const search = host.ctx.tools.get("zg_search")?.parameters as {
          properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }>;
        };
        expect(search.properties["preview"]?.enum).toStrictEqual(["none", "short", "full"]);
        expect(search.properties["refresh"]?.enum).toStrictEqual(["background", "wait", "off"]);
        expect(search.properties["symbolTypes"]?.items?.enum).toStrictEqual([
          "module",
          "class",
          "interface",
          "function",
          "value",
          "alias",
        ]);
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("宿主缺 settings 时 apply 快速失败（服务面守卫不是装饰）", async () => {
      const host = await startHost({ settings: false });
      try {
        // 缺面的那一行 inject 仍在等 ⇒ 插件 fiber 未激活，工具一个都没注册。
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
        const call = host.shellCalls.find((row) => row.request.command.startsWith("zg query"));
        assert.ok(call !== undefined);
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
        expect(host.textOf(outcome)).toContain("Workspace index is not configured");
        expect(host.textOf(outcome)).toContain(".zvec-grep/index.zvec");
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
        // 命令侧：--rg 在，索引侧旗标不在。
        const call = host.shellCalls.find((row) => row.request.command.startsWith("zg query"));
        assert.ok(call !== undefined);
        expect(call.spec.command).toContain("--rg");
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
        const call = host.shellCalls.find((row) => row.request.command.startsWith("zg query"));
        expect(call?.spec.command).toContain("--mode direct");
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
        expect(text).toContain("Workspace index is not configured");
        // 本包把它翻成结论，并且保留原始失败文本（detail）供排查。
        assert.match(text, /未就绪|not ready/iu);
        expect(text).toContain("Next");
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("默认 embedding 原样进命令行（不换默认、不偷偷回落）", async () => {
      // 这条只起进程不建索引：不加载模型权重（并行跑全套时的内存大户），
      // 却把「设置默认值 → 命令行」这条链路钉住。
      const host = await startHost();
      const ws = workspace();
      try {
        const outcome = await host.call(
          "zg_index",
          { confirm: true, maxDepth: 1 },
          host.agentOf(ws),
        );
        assert.ok(!outcome.isError, host.textOf(outcome));
        const call = host.shellCalls.find((row) => row.request.command.startsWith("zg index"));
        // 设置卡默认值（DEFAULT_EMBEDDING）逐字出现在命令行上；本测试文件另有一组用例
        // 显式覆盖它（TEST_EMBEDDING），免得几个并行 zg 进程同时加载几百 MB 权重。
        expect(call?.spec.command).toContain("--embedding");
        expect(call?.spec.command).toMatch(/--embedding 'local\/[a-z0-9.-]+'/u);
      } finally {
        await host.dispose();
      }
    }, 120_000);

    it("root 不存在时前置归因，不把 spawn 失败说成「zg 没装」", async () => {
      const host = await startHost();
      const gone = path.join(tmpdir(), "zg-int-vanished", "nope");
      rmSync(gone, { recursive: true, force: true });
      try {
        const outcome = await host.call("zg_status", { root: gone }, host.agentOf(tmpdir()));
        assert.ok(outcome.isError);
        assert.match(host.textOf(outcome), /不存在|no such/iu);
        // 没有目录就不该发出命令：existsSync 预检在 resolve 之前。
        expect(
          host.shellCalls.filter((row) => row.request.command.startsWith("zg status")),
        ).toStrictEqual([]);
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
        expect(
          host.shellCalls.filter((row) => row.request.command.startsWith("zg index")),
        ).toStrictEqual([]);
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
        const call = host.shellCalls.find((row) => row.request.command.startsWith("zg index"));
        expect(call?.spec.command).toContain("--ignore-file '.zvecignore'");
      } finally {
        await host.dispose();
      }
    }, 60_000);

    it("绝对路径的 ignore 文件按原样递过去（预检不把它改成相对 root）", async () => {
      const host = await startHost();
      const ws = workspace();
      const outside = path.join(tmpdir(), `zg-ignore-${Math.random().toString(36).slice(2)}`);
      writeFileSync(outside, "*.log\n");
      cleanups.push(() => {
        rmSync(outside, { force: true });
      });
      try {
        const outcome = await host.call(
          "zg_index",
          { confirm: true, ignoreFiles: [outside] },
          host.agentOf(ws),
        );
        assert.ok(!outcome.isError, host.textOf(outcome));
        const call = host.shellCalls.find((row) => row.request.command.startsWith("zg index"));
        expect(call?.spec.command).toContain(`--ignore-file '${outside}'`);
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

    it("drop 那一臂跳过预检：drop + 不存在的 ignoreFiles 不被误拒（ignoreFiles 本就不进 drop 命令）", async () => {
      // buildIndexCommand 的 drop 分支只有 `zg index <root> --drop --yes`，ignoreFiles 被静默
      // 丢掉、根本不进 zg（也就无从损坏索引）。预检若照跑，会拿"给一个真实存在的忽略文件"
      // 这句误导文案把一次合法的删索引拦下——故 drop 为真时整段跳过。
      const host = await startHost();
      const ws = workspace();
      try {
        const outcome = await host.call(
          "zg_index",
          { confirm: true, drop: true, ignoreFiles: [MISSING_IGNORE] },
          host.agentOf(ws),
        );
        // 命令照构造、照起：drop 分支带 --drop、且不含 --ignore-file（那条被丢掉了）。
        const call = host.shellCalls.find((row) => row.request.command.startsWith("zg index"));
        assert.ok(call !== undefined, host.textOf(outcome));
        expect(call.spec.command).toContain("--drop");
        expect(call.spec.command).not.toContain("--ignore-file");
        // 绝不是那句存在性误拒（预检被 drop 跳过，没读 ignoreFiles）。
        expect(host.textOf(outcome)).not.toContain(MISSING_IGNORE);
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
          expect(
            host.shellCalls.filter((row) => row.request.command.startsWith("zg index")),
          ).toStrictEqual([]);
        } finally {
          chmodSync(target, 0o644);
          await host.dispose();
        }
      },
      60_000,
    );
  });

  describe.skipIf(!localModelCached())("真实宿主：索引通道（本地 embedding）", () => {
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
        // 真 zg 的索引检索输出形状：组头 + hits 计数 + 名次头行。
        expect(text).toContain("query groups (1):");
        assert.match(text, /hits: \d+/u);
        assert.match(text, /#\d+ matchedBy=\S+/u);
        // 摘要行由本包从真输出里解析出来（分组计数/去重位置数）。
        expect(text).toContain("命中摘要");
        expect(text).toContain("1 个查询组");
        // 走的是索引通道：没有改道声明，也没有 --rg。
        expect(text).not.toContain("穷举词法检索");
        const call = fresh.shellCalls.find((row) => row.request.command.startsWith("zg query"));
        expect(call?.spec.command).not.toContain("--rg");
        expect(call?.spec.command).toContain("--refresh wait");
      } finally {
        await fresh.dispose();
      }
    }, 300_000);

    it("建完索引前搜过一次的话，建完后的那一次检索仍照旧改道（负向探测缓存 60s）", async () => {
      // 这条钉的是**已知取舍**而不是期望行为：zg_index 是运行期动作，而探测缓存的负向条目
      // TTL 是 60s。于是"先搜过一次（那时没有索引）→ 建索引 → 再搜"会拿到一条已经过时的
      // `尚无 zg 索引` 声明 + rg 结果，而索引明明已经在盘上。改动这个缓存策略（例如索引成功
      // 后主动作废条目）必须让这条先红。
      const host = await startHost({ config: { defaultEmbedding: TEST_EMBEDDING } });
      const ws = workspace();
      try {
        const agent = host.agentOf(ws);
        const before = await host.call("zg_search", { query: "authService" }, agent);
        assert.ok(!before.isError, host.textOf(before));
        expect(host.textOf(before)).toContain("穷举词法检索");

        const built = await host.call("zg_index", { confirm: true }, agent);
        assert.ok(!built.isError, host.textOf(built));
        const index = host.shellCalls.find((row) => row.request.command.startsWith("zg index"));
        expect(index?.spec.command).toContain("--embedding");

        const after = await host.call("zg_search", { query: "authService" }, agent);
        assert.ok(!after.isError, host.textOf(after));
        expect(host.textOf(after)).toContain("穷举词法检索");
        // 此刻盘上已经有索引：这条声明与事实不符（缓存陈旧），把现象钉在这里。
        expect(host.textOf(after)).toContain("尚无 zg 索引");
      } finally {
        await host.dispose();
      }
    }, 300_000);
  });

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
