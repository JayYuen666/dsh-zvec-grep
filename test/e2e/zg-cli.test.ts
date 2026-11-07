// 点对点（P2P）契约测试：**本包构造的命令 vs 真 zg CLI**。
//
// 这一层没有任何 mock，也没有插件参与——只有 lib/cli.ts 造出来的命令行与真 zg 的
// argv 解析器/输出格式化/错误码面对话。它盯的是「上游事实有没有变」（0.3.0 现量）：
//
//   - 每一条旗标真 zg 还认不认（`--preview` / `--symbol-type` / `--reset-paths` …）；
//   - 穷举通道的冲突集合还是不是注释里写的那几条（含报错原文）；
//   - `--check-ready` 的非零退出码语义（报告在 stdout、结论在退出码）；
//   - 命中摘要的正则还匹配不匹配真输出的形状（`#N 路径:行号`，组间 `-- query` 分隔行）；
//   - stderr 进度噪声词表还覆不覆盖真进度行；
//   - 并发建索引的错误码还是不是 lib/zg-errors.ts 认的那几个；
//   - `--ignore-file` 指向不存在的文件时 0.3.0 **静默容忍**（0.2.2 会弄坏整棵树）；
//   - MCP lane：daemon 的 HTTP 端点、token 鉴权与 lib/daemon-client.ts 的全流程。
//
// 需要本地 embedding 权重的那几例按缓存是否就绪跳过（否则 zg 要联网下载模型）。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import {
  buildIndexCommand,
  buildSearchCommand,
  buildStatusCommand,
  clientModeOf,
} from "../../lib/cli.ts";
import type { BuiltCommand, ClientMode, IndexArgs } from "../../lib/cli.ts";
import { embeddingCached } from "../embedding-cache.ts";
import { MESSAGES } from "../../lib/messages.ts";
import type { ZvecGrepMessages } from "../../lib/messages.ts";
import { classifyConcurrentFailure } from "../../lib/zg-errors.ts";
import {
  MINIMUM_ZG_VERSION,
  parseZgVersion,
  tooOldZgVersion,
  versionAtLeast,
} from "../../lib/zg-version.ts";
import { hitSummary, signalStderr } from "../../host.ts";
import { createDaemonClient } from "../../lib/daemon-client.ts";
import { inOrder, zgAvailable } from "../integration/host-stack.ts";

/**
 * 子进程退出码（close 事件的第一个参数）。
 *
 * 被信号打死与「没有数字退出码」都抛出去并带上命令行：把信号终止折成 `-1`，
 * 下游那些「非零退出」的断言会在进程根本没跑成的前提下照样通过——那与折成 0 只是
 * 换一种藏法，两种都不该藏。
 */
async function exitCode(child: ChildProcess, command: string): Promise<number> {
  const [code, signal] = (await once(child, "close")) as [unknown, unknown];
  if (typeof signal === "string") {
    throw new TypeError(`子进程被信号 ${signal} 终止，没有退出码可判：${command}`);
  }
  if (typeof code !== "number") {
    throw new TypeError(`子进程交回的退出码不是数字（实际 ${String(code)}）：${command}`);
  }
  return code;
}

/** 读完一路流（空流端视为空串）。 */
async function drain(stream: Readable | null): Promise<string> {
  if (stream === null) {
    return "";
  }
  let text = "";
  for await (const chunk of stream) {
    text += String(chunk);
  }
  return text;
}

/**
 * 一条命令的上限。本套用例递出去的都是单棵小树，真跑用不了这么久；超了就是它挂住
 * （等锁、联网下载权重），由这里先把进程收掉，而不是留给 vitest 的用例超时——
 * 用例超时只让这条用例红，不杀子进程，被挂住的 zg 会带着工作区锁留给后面的用例。
 */
const RUN_TIMEOUT_MS = 20_000;

/**
 * 异步跑一条命令（不用同步 API：本包审查只开 node/no-sync 的写盘一组）。
 * 非零退出也不抛：失败输出正是这套用例要对照的资料（上游拒绝原文）。
 *
 * `shell: true` 把命令串交给 sh 解析，因此引号完全由 lib/cli.ts 的 shq 负责：
 * 这里不接受未加引号的拼接。超时的 SIGKILL 打到的就是 zg 本身——`sh -c` 对单条命令
 * 直接 exec，不再多留一层 shell（本机实测：超时后按命令名找不到遗留进程）。
 */
async function run(
  command: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; status: number }> {
  const child = execFile(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    killSignal: "SIGKILL",
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  // spawn 失败走 'error'，必须接住并点名命令。maxBuffer 超限本机实测**不**走 'error'：
  // 而是把子进程打死、以 close(code=null, signal=SIGKILL) 收（`seq 1 400000` 实测），
  // 于是超限与挂住都由 exitCode 抛出去，而不是留下一段被截断的输出配一句 status=0。
  let spawnError: Error | undefined;
  child.on("error", (error: Error) => {
    spawnError = error;
  });
  let stdout: string;
  let stderr: string;
  let status: number;
  try {
    [stdout, stderr, status] = await Promise.all([
      drain(child.stdout),
      drain(child.stderr),
      exitCode(child, command),
    ]);
  } catch (error) {
    // 打死进程后一路流会提前结束（实测 `Error: Premature close`）：把它折回带命令行的失败，
    // 否则栈上只有那句流内部的措辞，看不出是哪条命令没跑成。
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`读这条子进程的输出时失败：${command}\n${reason}`, { cause: error });
  }
  if (spawnError !== undefined) {
    throw new Error(`子进程没能正常跑完：${command}\n${spawnError.message}`);
  }
  return { stdout, stderr, status };
}

/** 文案表：本包双语资源里的中文那份（下游校验均用它）。 */
const messages: ZvecGrepMessages = MESSAGES.zh;

/** 在同一棵树上按字面量搜一次（索引通道，refresh=off 免得被别的进程刷新干扰）。 */
async function searchLiteral(dir: string, marker: string): Promise<string> {
  const built = buildSearchCommand(
    { root: dir, query: marker, refresh: "off", preview: "none" },
    messages,
    clientModeOf(undefined, messages),
  );
  const result = await run(built.command, dir);
  assert.equal(result.status, 0, `${built.command}\n${result.stderr}`);
  return result.stdout;
}

/** 本包给 zg 索引命令的 embedding（本地模型，本机已缓存）。 */
const LOCAL_EMBEDDING = "local/potion-code-16m-v2";

/** 本地权重是否在场（缺了它，真建索引的用例会转成联网下载）。 */
const modelReady = embeddingCached(LOCAL_EMBEDDING);

/** 索引命令的本包规则：embedding / 文案表 / clientMode 缺省那一路都收在这里，调用点只递 args。 */
function indexCommand(args: IndexArgs, mode?: ClientMode): BuiltCommand {
  return buildIndexCommand(args, LOCAL_EMBEDDING, messages, clientModeOf(mode, messages));
}

/** 索引/检索那组用例的前置：真 zg 在场，且这枚本地权重已在缓存里（否则要联网下载）。 */
const indexSuiteReady = zgAvailable() && embeddingCached(LOCAL_EMBEDDING);
/** 样本文件名与统一检索字面量（断言里多次引用）。 */
const AUTH_TS_NAME = "auth.ts";
const NOTES_NAME = "notes.md";
/** 这套用例统一检索的字面量（真索引与真 rg 两条通道都命中它）。 */
const AUTH_QUERY = "authService";
/** 重建这一位：这组用例重复发它。 */
const REBUILD_ARGS = { rebuild: true };
/** 单行版样本（磁盘上只需要一行，命中表达就够）。 */
const SINGLE_LINE_AUTH_BODY = "export function authService() { return 1; }\n";
/** 三条固定样本内容（断言里反复引用，抽出来免得每处抄一份）。 */
const AUTH_TS_BODY = 'export function authService() {\n  return "token";\n}\n';
const NOTES_BODY = `# workspace notes\n\n${AUTH_QUERY} is exported from ${AUTH_TS_NAME}\n`;
const GITIGNORE_NAME = ".gitignore";
const GITIGNORE_BODY = "dist/\n*.log\n";

const cleanups: (() => void)[] = [];

/**
 * 默认 home 里 model2vec 权重的缓存目录（model2vec 后端的模型按仓库分目录落在这里）。
 * 供隔离 home 的用例复制到同位路径：下载通道在本机网络下不可用（HF 超时 +
 * ModelScope 403，实测），复用已缓存权重是唯一离线路径。
 */
function modelCacheSource(): string {
  return path.join(os.homedir(), ".zvec-grep", "models", "model2vec");
}

/** 一个带源文件（与一份真实 .gitignore）的工作区。 */
function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "zg-p2p-"));
  writeFileSync(path.join(dir, GITIGNORE_NAME), GITIGNORE_BODY);
  for (const [name, body] of Object.entries({
    [AUTH_TS_NAME]: AUTH_TS_BODY,
    [NOTES_NAME]: NOTES_BODY,
    ...files,
  })) {
    writeFileSync(path.join(dir, name), body);
  }
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

describe.skipIf(!zgAvailable())("点对点：本包构造的命令行 vs 真 zg CLI", () => {
  /** 全套用的工作区（beforeAll 里建，同一套里全部共用）。 */
  let ws: string;

  beforeAll(() => {
    ws = workspace();
  });

  afterAll(() => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      cleanup();
    }
  });

  it("真 zg --version 的原文被解析，且不低于本包阈值", async () => {
    const { stdout: raw } = await run("zg --version", ws);
    // 门口径：真输出必须被解析成版本号（读不懂 ⇒ 门槛失效），且不低于本包门槛。
    // **不钉具体版本号**：上游发 0.3.1 时命令行旗标可能一字未改，钉死补丁号只会让它误红。
    // 比较必须走逐段数值（versionAtLeast），不能用字符串字典序——"0.10.0" < "0.2.2"。
    const parsed = parseZgVersion(raw);
    assert.ok(parsed !== undefined, `读不懂 zg --version 原文：${raw}`);
    expect(tooOldZgVersion(raw)).toBeUndefined();
    const minimum = parseZgVersion(MINIMUM_ZG_VERSION);
    assert.ok(minimum !== undefined, MINIMUM_ZG_VERSION);
    assert.ok(versionAtLeast(parsed, minimum), `装了 ${raw.trim()}，阈值 ${MINIMUM_ZG_VERSION}`);
  }, 30_000);

  it("老版本字面量被判为太老（形状就是真 zg 的 <版本号> 行）", () => {
    // tooOldZgVersion 的「太老」是**交回实际版本**，「够新或读不懂」是 undefined：
    // 它从不返回 null，所以 not.toBeNull() 永远成立、一条回归都拦不住。断言具体版本号。
    expect(tooOldZgVersion("0.0.1\n")).toStrictEqual({ major: 0, minor: 0, patch: 1 });
    expect(tooOldZgVersion("0.2.2\n")).toStrictEqual({ major: 0, minor: 2, patch: 2 });
    // 反向两臂：恰好等于门槛时放行；读不懂时也放行（门槛只拦「确知太老」）。
    expect(tooOldZgVersion(`${MINIMUM_ZG_VERSION}\n`)).toBeUndefined();
    expect(tooOldZgVersion("0.3.0-rc.1\n")).toBeUndefined();
  });

  it("穷举检索命令在真 zg 上跑通（0.3.0 顶层 --rg + 路径/时间过滤 + --mode）", async () => {
    const { command } = buildSearchCommand(
      {
        root: ws,
        query: AUTH_QUERY,
        globs: ["*.ts"],
        fileTypes: ["ts"],
        excludedFileTypes: ["md"],
        modifiedAfter: "2020-01-01",
        device: "auto",
      },
      messages,
      clientModeOf(undefined, messages),
      "exhaustive",
    );
    const result = await run(command, ws);
    assert.ok(
      !/unknown|unexpected|invalid/iu.test(result.stderr + result.stdout),
      `${command}\n${result.stderr}`,
    );
    assert.equal(result.status, 0, `${command}\n${result.stderr}`);
    expect(result.stdout).toContain("auth.ts");
  }, 30_000);

  it("状态命令在真 zg 上跑通（0.3.0 --status + --check-ready + --mode）", async () => {
    // 独立的一棵树：这几条判的是「这棵树建过 / 还没建索引」，共享的 ws 会被别条用例改掉状态。
    const own = workspace();
    const { command } = buildStatusCommand({ root: own, checkReady: true }, messages);
    const result = await run(command, own);
    // 未建索引 ⇒ --check-ready 以非零退出码表达「未就绪」，报告仍在 stdout。
    assert.notEqual(result.status, 0, `${command}\n${result.stderr}`);
    expect(result.stdout).toContain("Unavailable (index not configured)");
  }, 30_000);

  it.skipIf(!modelReady)(
    "索引命令的每一个旗标都被真 zg 的 --index 接受",
    async () => {
      // 独立的一棵树：这几条判的是「这棵树建过 / 还没建索引」，共享的 ws 会被别条用例改掉状态。
      const own = workspace();
      const { command } = indexCommand({
        root: own,
        rebuild: true,
        globs: ["**/*.ts"],
        insensitiveGlobs: ["!*.map"],
        fileTypes: ["ts"],
        excludedFileTypes: ["md"],
        hidden: true,
        noIgnore: false,
        excludeSecrets: true,
        maxDepth: 3,
        maxFileSizeBytes: 1_000_000,
        follow: false,
        embeddingConcurrency: 2,
        device: "auto",
        resetPaths: true,
      });
      const result = await run(command, own);
      assert.equal(result.status, 0, `${command}\n${result.stderr}`);
      expect(result.stdout).toContain("Workspace index");
    },
    60_000,
  );

  it("穷举通道的冲突集合与实测报错原文一致（0.3.0 的两条合并文案）", async () => {
    // lib/cli.ts 的 assertExhaustiveArgs 把这一整组拦在构造期，理由是这些实测原文；
    // 上游一旦改口，本包给出的中文指引会与真报错对不上——这里逐条对。0.3.0 把
    // preview/refresh/trace/symbol 合并成一句、hybrid/fts/vector/fuse 合并成另一句。
    const cases: [string, RegExp][] = [
      [
        "--preview short",
        /--rg cannot be combined with indexed preview, trace, refresh, or symbol options/u,
      ],
      [
        "--refresh wait",
        /--rg cannot be combined with indexed preview, trace, refresh, or symbol options/u,
      ],
      [
        "--trace",
        /--rg cannot be combined with indexed preview, trace, refresh, or symbol options/u,
      ],
      ["--fuse", /--rg cannot be combined with --hybrid, --fts, --vector, or --fuse/u],
      ["--fts authService", /--rg cannot be combined with --hybrid, --fts, --vector, or --fuse/u],
    ];
    const outcomes = await inOrder(
      cases.map(
        ([flag]) =>
          () =>
            run(`zg --rg ${flag} ${AUTH_QUERY}`, ws),
      ),
    );
    for (const [index, entry] of cases.entries()) {
      const [flag, expected] = entry;
      const result = outcomes[index]!;
      assert.notEqual(result.status, 0, flag);
      assert.match(result.stderr, expected, flag);
    }
  }, 60_000);

  it("0.3.0 新旗标在真 zg 上实跑：fuse + preview detail + category；--rg --files；--nested-git", async () => {
    // 索引通道：显式 --hybrid 路由 + --fuse + detail 档 + --category 组合（计划验收清单四项一次跑）。
    // 索引通道需要真索引：独立建一棵（共享 ws 未建索引，别条用例会改它的状态）。
    const fusedWs = workspace();
    const seeded = await run(indexCommand({ root: fusedWs }).command, fusedWs);
    assert.equal(seeded.status, 0, seeded.stderr);
    const fused = buildSearchCommand(
      {
        root: fusedWs,
        query: AUTH_QUERY,
        fuse: true,
        preview: "detail",
        category: ["code"],
        limit: 3,
      },
      messages,
      clientModeOf(undefined, messages),
    );
    const fusedResult = await run(fused.command, fusedWs);
    assert.equal(fusedResult.status, 0, `${fused.command}\n${fusedResult.stderr}`);
    // detail 档的结构化字段（实测原文：Signature/Range/Status）
    expect(fusedResult.stdout).toContain("Signature:");
    expect(fusedResult.stdout).toContain("Range: 1");
    // hitSummary 对 detail 头行（剥尾部 score=）仍能去重
    const summary = hitSummary(fusedResult.stdout, 3, false, messages);
    assert.ok(summary !== null, fusedResult.stdout);

    // 文件发现通道：--rg --files + -g 过滤（gitignore 感知、排序、无 --limit）
    const filesBuilt = buildSearchCommand(
      { root: ws, files: true, globs: ["*.ts"] },
      messages,
      clientModeOf(undefined, messages),
      "files",
    );
    const filesResult = await run(filesBuilt.command, ws);
    assert.equal(filesResult.status, 0, `${filesBuilt.command}\n${filesResult.stderr}`);
    expect(filesResult.stdout).toContain("auth.ts");
    expect(filesResult.stdout, "-g '*.ts' 过滤生效").not.toContain("notes.md");
    assert.ok(!filesBuilt.command.includes("--limit"), "文件清单不发 --limit");

    // 索引命令带 --nested-git 被真 zg 接受（0.3.0 新扫描规则）
    const own = workspace();
    const nested = indexCommand({ root: own, nestedGit: true });
    const nestedResult = await run(nested.command, own);
    assert.equal(nestedResult.status, 0, `${nested.command}\n${nestedResult.stderr}`);
    expect(nestedResult.stdout).toContain("Workspace index");
  }, 90_000);

  it("符号类型只认小写闭集（大写由真 zg 拒，正是本包绑定闭集的原因）", async () => {
    const result = await run(`zg --symbol-type Class ${AUTH_QUERY} --refresh off`, ws);
    assert.notEqual(result.status, 0, result.stderr);
    // 0.3.0 把取值域收到 clap 层：报错带七个合法值（enum 是 0.3.0 新增档）。
    assert.match(result.stderr, /invalid value 'Class' for '--symbol-type/u);
    assert.match(
      result.stderr,
      /possible values: alias, class, enum, function, interface, module, value/u,
    );
  }, 30_000);

  it.skipIf(!modelReady)(
    "密钥排除旗标被真 zg 接受，且排在本函数最后（用户 iglob 之后）",
    async () => {
      // 独立的一棵树：这几条判的是「这棵树建过 / 还没建索引」，共享的 ws 会被别条用例改掉状态。
      const own = workspace();
      const built = indexCommand({
        root: own,
        globs: ["**/*.ts"],
        insensitiveGlobs: ["**"],
        excludeSecrets: true,
      });
      // `**` 这条宽泛正向规则若排在密钥规则之后会把密钥文件救回索引：真 zg 的求值顺序是全
      // --glob 先于全 --iglob，而密钥规则是本包最后追加的 --iglob。
      const iglobs = built.command.match(/--iglob '[^']*'/gu) ?? [];
      expect(iglobs.length).toBeGreaterThan(3);
      expect(iglobs.at(-1)).toContain("id_ed25519");
      const result = await run(built.command, own);
      assert.equal(result.status, 0, `${built.command}\n${result.stderr}`);
    },
    60_000,
  );

  it.skipIf(!modelReady)(
    "drop 分支在真 zg 上非交互删索引（0.3.0 无 --yes，删除立即执行）",
    async () => {
      // 独立的一棵树：这几条判的是「这棵树建过 / 还没建索引」，共享的 ws 会被别条用例改掉状态。
      const own = workspace();
      const seed = indexCommand({ root: own });
      const seeded = await run(seed.command, own);
      assert.equal(seeded.status, 0, `${seed.command}\n${seeded.stderr}`);
      const built = indexCommand({ root: own, drop: true });
      assert.ok(!built.command.includes("--yes"), "0.3.0 的 drop 没有 --yes（实测 exit 2）");
      const result = await run(built.command, own);
      assert.equal(result.status, 0, `${built.command}\n${result.stderr}`);
      const status = await run(buildStatusCommand({ root: own }, messages).command, own);
      expect(status.stdout).toContain("index not configured");
    },
    60_000,
  );

  it.skipIf(!modelReady)(
    "0.3.0 对读不成的 ignore 文件静默容忍：索引照建、坏路径记进 roots 行（预检拦在构造前的理由）",
    async () => {
      // 0.2.2 实测：ENOENT ⇒ 整次索引失败，坏路径写进工作区索引状态，只有 drop 能救。
      // 0.3.0 实测：exit 0，索引照常建（`1 scanned, … 1 unchanged`），坏路径只记在回执的
      // `roots` 行（`ignore-file=does-not-exist.ignore`）——排除规则**悄悄不生效**。
      // lib/index-preflight.ts 拦它不再是因为「上游会弄坏树」，而是因为「静默错误答案」：
      // 模型以为排除规则在挡东西，实际什么都没排除。这条钉住 0.3.0 的事实本身。
      const dir = workspace();
      const bad = indexCommand({ root: dir, ignoreFiles: ["does-not-exist.ignore"] });
      const badResult = await run(bad.command, dir);
      assert.equal(badResult.status, 0, `${bad.command}\n${badResult.stderr}`);
      expect(badResult.stdout).toContain("ignore-file=does-not-exist.ignore");
      // 对照半边：真实存在的忽略文件照常工作（roots 行不带坏路径）。
      const fresh = workspace();
      const good = indexCommand({ root: fresh, ignoreFiles: [GITIGNORE_NAME] });
      const goodResult = await run(good.command, fresh);
      assert.equal(goodResult.status, 0, `${good.command}\n${goodResult.stderr}`);
      assert.ok(!goodResult.stdout.includes("does-not-exist"), goodResult.stdout);
    },
    120_000,
  );

  it("消息表的占位符与真 zg 的词汇对齐（statusNotReady 的 detail 有去处）", () => {
    const text = MESSAGES.zh.statusNotReady.replace("{root}", ws).replace("{detail}", "detail");
    expect(text).toContain("detail");
    expect(text).toContain(ws);
  });
});

describe.skipIf(!indexSuiteReady)("点对点：索引检索的输出形状与摘要解析", () => {
  const cleanupsIndexed: (() => void)[] = [];

  afterAll(() => {
    for (const cleanup of cleanupsIndexed.splice(0).toReversed()) {
      cleanup();
    }
  });

  /** 建一个真索引的工作区（本地 embedding，离线可建）。 */
  async function indexedWorkspace(): Promise<string> {
    const dir = mkdtempSync(path.join(tmpdir(), "zg-p2p-idx-"));
    writeFileSync(path.join(dir, AUTH_TS_NAME), SINGLE_LINE_AUTH_BODY);
    cleanupsIndexed.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const built = indexCommand({ root: dir });
    const result = await run(built.command, dir);
    assert.equal(result.status, 0, `${built.command}\n${result.stderr}`);
    return dir;
  }

  it("hitSummary 按真输出解析去重位置数（0.3.0：#N 路径:行号 头行）", async () => {
    const dir = await indexedWorkspace();
    const built = buildSearchCommand(
      { root: dir, query: AUTH_QUERY, limit: 5 },
      messages,
      clientModeOf(undefined, messages),
    );
    const result = await run(built.command, dir);
    assert.equal(result.status, 0, `${built.command}\n${result.stderr}`);
    // 0.3.0 形状：头行 `#N <路径>:<行号范围>`；0.2.2 的 `query groups` 头与 `hits: N`
    // 计数行都不复存在（实测）。单行命中只有 `:行号`，多行命中是 `:起-止`。
    assert.match(result.stdout, /^#\d+ .+:\d+(?:-\d+)?$/mu);
    assert.ok(!result.stdout.includes("matchedBy="), "0.3.0 头行没有 matchedBy=");
    assert.ok(!/^hits: /mu.test(result.stdout), "0.3.0 没有每组计数行");

    const summary = hitSummary(result.stdout, 5, false, messages);
    assert.ok(summary !== null, result.stdout);
    expect(summary).toContain("去重后 1 个不同位置");
    expect(summary).toContain("命中摘要");
  }, 120_000);

  it("--trace 的输出（score:/trace: 独立行）不被误判成命中条目", async () => {
    const dir = await indexedWorkspace();
    const built = buildSearchCommand(
      { root: dir, query: "auth", trace: true, limit: 3 },
      messages,
      clientModeOf(undefined, messages),
    );
    const result = await run(built.command, dir);
    assert.equal(result.status, 0, `${built.command}\n${result.stderr}`);
    // 0.3.0 的分值/轨迹在命中体之后的独立行，头行仍是干净的 `#N 路径:行号`。
    assert.match(result.stdout, /^score: -?\d+(?:\.\d+)?$/mu);
    assert.match(result.stdout, /^trace: \{/mu);
    const summary = hitSummary(result.stdout, 3, false, messages);
    assert.ok(summary !== null, result.stdout);
    expect(summary).toContain("去重后");
  }, 120_000);

  it("多组查询（--hybrid + --fts）的分组分隔行与重复命中被正确去重", async () => {
    const dir = await indexedWorkspace();
    const built = buildSearchCommand(
      { root: dir, query: AUTH_QUERY, fts: ["authService"], limit: 3 },
      messages,
      clientModeOf(undefined, messages),
    );
    const result = await run(built.command, dir);
    assert.equal(result.status, 0, `${built.command}\n${result.stderr}`);
    // 0.3.0 的组间分隔行（实测原文）。
    assert.match(result.stdout, /^-- query 1\/2: /mu);
    assert.match(result.stdout, /^-- query 2\/2: /mu);
    // 同一处位置在两组各出现一次，摘要只算一处。
    const summary = hitSummary(result.stdout, 3, false, messages);
    assert.ok(summary !== null, result.stdout);
    expect(summary).toContain("去重后 1 个不同位置");
  }, 120_000);

  it("stderr 进度噪声词表覆盖真索引进度行，且不漏掉告警", async () => {
    const dir = await indexedWorkspace();
    const built = indexCommand({ root: dir, rebuild: true });
    const result = await run(built.command, dir);
    assert.equal(result.status, 0, `${built.command}\n${result.stderr}`);
    // 0.3.0 真进度行（Scanning — … / Indexing: N/M files / Saving index …）进噪声表：
    // signalStderr 之后一句都不剩。
    expect(signalStderr(result.stderr)).toBe("");
    // 认不出的行一律保留（这条是判据的另外一半：只丢认得的）。
    expect(signalStderr("warning: embedding model fell back to lexical\n")).toBe(
      "warning: embedding model fell back to lexical",
    );
  }, 120_000);

  it("0.3.0 默认跳过密钥文件（binary/unsupported），插件的排除规则是双保险", async () => {
    // 0.2.2 实测：`.pem`/`.P12` 照样 `3 scanned, 3 added` 进索引，插件的 --iglob 排除是
    // **唯一**防线。0.3.0 实测（--debug 的 Index diagnostics 原文）：`secret.pem`/`cert.pem`
    // 记 `reason:"binary"`（格式目录把 Pem 归 Binary，text-only 索引直接跳过），
    // `id_rsa`/`secret.P12` 记 `reason:"unsupported"`（无/未知扩展名不识别格式，同样跳过）
    // ——上游默认就把本包排除清单的全部对象挡在索引外。规则保留为双保险：两种开关下
    // 都取不回来，正常源码照常可检索。
    const secretName = "secret.pem";
    const secretMarker = "ZZSECRETP EMLINE";
    const mixedName = "secret.P12";
    const mixedMarker = "ZZSECRETP12LINE";

    /** 一棵只有「密钥文件 + 一份正常源码」的工作区（正常源码保证索引不是空的）。 */
    function secretWorkspace(): string {
      const dir = mkdtempSync(path.join(tmpdir(), "zg-p2p-secret-"));
      writeFileSync(path.join(dir, GITIGNORE_NAME), GITIGNORE_BODY);
      writeFileSync(path.join(dir, AUTH_TS_NAME), SINGLE_LINE_AUTH_BODY);
      writeFileSync(path.join(dir, secretName), `${secretMarker} body\n`);
      writeFileSync(path.join(dir, mixedName), `${mixedMarker} body\n`);
      cleanupsIndexed.push(() => {
        rmSync(dir, { recursive: true, force: true });
      });
      return dir;
    }

    /** 按给定排除开关建一次索引。 */
    async function indexSecrets(
      excludeSecrets: boolean,
    ): Promise<{ dir: string; receipt: string }> {
      const dir = secretWorkspace();
      const built = indexCommand({ root: dir, excludeSecrets });
      const result = await run(built.command, dir);
      assert.equal(result.status, 0, `${built.command}\n${result.stderr}`);
      return { dir, receipt: result.stdout };
    }

    const bare = await indexSecrets(false);
    // 上游默认（排除关着）就不收密钥文件：回执只有正常源码那一枚（`1 scanned, 1 added`）。
    expect(bare.receipt).toContain("1 scanned, 1 added");

    const guarded = await indexSecrets(true);
    // 排除开着（本包默认）：同样取不回来，正常源码仍在 —— 规则是双保险，不是死规则。
    await expect(searchLiteral(guarded.dir, secretMarker)).resolves.not.toContain(secretName);
    await expect(searchLiteral(guarded.dir, mixedMarker)).resolves.not.toContain(mixedName);
    await expect(searchLiteral(guarded.dir, AUTH_QUERY)).resolves.toContain(AUTH_TS_NAME);
  }, 180_000);

  it("守护进程就绪探测的旗标在真 zg 上存在（非零码就是未就绪）", async () => {
    // host.ts 的 SERVER_READY_COMMAND 是 BackgroundSupport 的唯一证据源：上游改名或取消
    // `--check-ready` 时，本机所有 mock 用例照绿（它们比的是字符串），症状却是
    // refresh=background 这一档永久被拒。这里问一次**真** zg（0.3.0 旗标形态）。
    const dir = mkdtempSync(path.join(tmpdir(), "zg-p2p-ready-"));
    cleanupsIndexed.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const result = await run("zg --server status --check-ready", dir);
    // 就绪与否由这台机器的事实决定，两种都合法；不合法的是「旗标不认识」。
    const rejected = /unknown|unexpected|invalid|unrecognized/iu;
    assert.ok(!rejected.test(result.stderr + result.stdout), `${result.stderr}\n${result.stdout}`);
    if (result.status !== 0) {
      // 未就绪那一条分支必须用退出码 + 那句原文表达（判据读的是退出码，文本只是给人的）。
      assert.match(result.stderr, /server is not ready/u);
    }
  }, 60_000);

  it("并发重建的真实报错被 classifyConcurrentFailure 认出（0.3.0：RESOURCE_BUSY）", async () => {
    // 真 zg 在另一条写路径持锁时会给出结构化失败；这里连起两条真索引来撞它。
    // 传输模式显式取 direct：auto 那一支在该 root 的索引写权被守护进程持住时会双双改道，
    // 于是「至少一分支真把索引建出来」这条见证与守护进程状态耦合。direct 让两条命令
    // 自己抢锁，撞出来的仍是 RESOURCE_BUSY 那一族。
    const root = await indexedWorkspace();
    const { rebuild } = REBUILD_ARGS;
    const args = { root, rebuild };
    const built = indexCommand(args, "direct");
    const { command } = built;
    // 两条**同时**起：await 完第一条再起第二条等于串行，锁早已释放，本组会永远通过。
    const first = run(command, root);
    const concurrent = run(command, root);
    const [built0, second] = await Promise.all([first, concurrent]);
    // 并发之后**两条都可能**撞锁，不许再假定「第一条必然成功」；但至少要有一条真把索引建出来，
    // 否则两分支都失败就什么都没证到。
    const both = [built0, second];
    assert.ok(
      both.some((outcome) => outcome.status === 0),
      `${command}\n${both.map((outcome) => outcome.stderr).join("\n")}`,
    );
    for (const failed of both.filter((outcome) => outcome.status !== 0)) {
      const classified = classifyConcurrentFailure(failed.stderr);
      assert.ok(classified !== null, failed.stderr);
      // 0.3.0 没有 DAEMON_LEASE 独立码：锁竞争落在 RESOURCE_BUSY（lock-busy），
      // 远程授权被拒是 PERMISSION_DENIED。本组只可能撞出前者。
      expect(["lock-busy", "permission-denied"]).toContain(classified.kind);
      if (classified.kind === "lock-busy") {
        // 占锁方自报的操作名决定「要不要排队等」：不是重建就一等不到头。
        assert.equal(typeof classified.ownerOperation, "string");
      }
    }
  }, 180_000);
});

describe.skipIf(!zgAvailable())(
  "点对点：MCP lane（daemon HTTP 端点 + lib/daemon-client.ts）",
  () => {
    const cleanupsDaemon: (() => void)[] = [];
    /** 隔离的 daemon 状态目录（绝不碰用户真实的 ~/.zvec-grep）。 */
    let home: string;
    /** 该目录里的一棵小工作区（本组建索引用）。 */
    let wsDir: string;
    /** daemon 令牌夹具：上游要求 ≥32 字符且无控制字符（实测报错原文），插件自启的
     *  randomBytes(24).toString("hex") 是 48 个 hex 字符，满足同一条约束。 */
    const DAEMON_URL = "http://127.0.0.1:7999/mcp";
    const TOKEN = "e2e-token-0123456789abcdef0123456789abcdef";

    beforeAll(async () => {
      home = mkdtempSync(path.join(tmpdir(), "zg-p2p-mcp-home-"));
      wsDir = mkdtempSync(path.join(tmpdir(), "zg-p2p-mcp-ws-"));
      writeFileSync(path.join(wsDir, AUTH_TS_NAME), SINGLE_LINE_AUTH_BODY);
      cleanupsDaemon.push(() => {
        rmSync(home, { recursive: true, force: true });
        rmSync(wsDir, { recursive: true, force: true });
      });
      // 先用 CLI 通道建索引（离线本地模型），再起 daemon——search 走 MCP 时索引已在。
      // 隔离 home 没有模型缓存，而本机网络下载已被上游双源拒（HF 超时 + ModelScope 403，
      // 实测）——把默认 home 里已缓存的 model2vec 权重**复制**进沙箱 home 的同位路径，
      // 隔离与离线两头都保住；复制不依赖任何缓存路径变量的解析规则。
      if (modelReady) {
        await cp(modelCacheSource(), path.join(home, "models", "model2vec"), {
          recursive: true,
        });
        const built = indexCommand({ root: wsDir });
        const result = await run(built.command, wsDir, { ZVEC_GREP_HOME: home });
        assert.equal(result.status, 0, `${built.command}\n${result.stderr}`);
      }
      // 带 token 起 daemon（本插件自启 daemon 的同一形态：env ZVEC_GREP_SERVER_TOKEN）。
      // --mcp-toolset full：daemon 缺省是 agent 工具集（只有 zvec_grep_search），本组还要
      // 实调 server_status（full 才有，实测缺它报 tool not found）。
      await run("zg --server off", home, { ZVEC_GREP_HOME: home }).catch(() => "");
      const started = await run("zg --server on --mcp-toolset full", home, {
        ZVEC_GREP_HOME: home,
        ZVEC_GREP_SERVER_TOKEN: TOKEN,
      });
      assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
    }, 120_000);

    afterAll(async () => {
      // 收尾把 daemon 停掉。off 与 on 一样是管理操作：daemon 带 token 时必须带同一枚
      // （实测不带会被 401 拒、daemon 泄漏到下一次运行）。
      await run("zg --server off", home, {
        ZVEC_GREP_HOME: home,
        ZVEC_GREP_SERVER_TOKEN: TOKEN,
      }).catch(() => "");
      for (const cleanup of cleanupsDaemon.splice(0).toReversed()) {
        cleanup();
      }
    });

    it("initialize → tools/call 全流程（带 Bearer token；server_status 应答为 daemon JSON）", async () => {
      const client = createDaemonClient({
        url: DAEMON_URL,
        tokenOf: () => TOKEN,
      });
      const result = await client.call({
        tool: "zvec_grep_server_status",
        args: {},
        timeoutMs: 15_000,
      });
      assert.equal(result.isError, false, result.text);
      // server_status 的应答是 daemon 自述 JSON（version/uptime/队列计数），无检索语义。
      expect(result.text).toContain('"version"');
      expect(result.text).toContain('"queued_jobs"');
    }, 30_000);

    it("无 token 调用被 401 拒（鉴权真实生效，回环端口不是裸的）", async () => {
      const client = createDaemonClient({ url: DAEMON_URL, tokenOf: () => "" });
      await assert.rejects(
        () =>
          client.call({
            tool: "zvec_grep_server_status",
            args: {},
            timeoutMs: 15_000,
          }),
        /401|Unauthorized/iu,
      );
    }, 30_000);

    it("管理命令与守护进程同源 token：带 token 的 zg --status 退 0，不带退 401", async () => {
      // 这条钉的是上游契约本身：token 保护的 daemon 在场时，--mode auto 的管理命令也走
      // 守护进程、也必须带同一枚 Bearer。插件侧「三条前台通道都带 token」由
      // test/host.test.ts 的 mock 断言钉住；两半合起来才是完整的同源证据。
      const built = buildStatusCommand({ root: wsDir }, MESSAGES.zh, "auto");
      const withToken = await run(built.command, wsDir, {
        ZVEC_GREP_HOME: home,
        ZVEC_GREP_SERVER_TOKEN: TOKEN,
      });
      assert.equal(withToken.status, 0, `${built.command}\n${withToken.stderr}`);
      const withoutToken = await run(built.command, wsDir, { ZVEC_GREP_HOME: home });
      assert.notEqual(withoutToken.status, 0, "没有 token 的管理命令必须失败，不能静默降级");
      assert.match(withoutToken.stderr, /401|Unauthorized/iu);
    }, 60_000);

    it.skipIf(!modelReady)(
      "zvec_grep_search 实调：参数映射（root+query）被真 daemon 接受，应答是 #N 头行文本",
      async () => {
        const client = createDaemonClient({
          url: DAEMON_URL,
          tokenOf: () => TOKEN,
        });
        const result = await client.call({
          tool: "zvec_grep_search",
          args: { root: wsDir, query: AUTH_QUERY, limit: 3 },
          timeoutMs: 30_000,
        });
        assert.equal(result.isError, false, result.text);
        assert.match(result.text, /^#\d+ /mu, "应答文本与 CLI stdout 同构（#N 头行）");
        const summary = hitSummary(result.text, 3, false, messages);
        assert.ok(summary !== null, result.text);
      },
      60_000,
    );

    it("zvec_grep_search 对无索引 root 报错：isError=true 且错误文本带 ZG.ENGINE.NOT_FOUND 码", async () => {
      const client = createDaemonClient({ url: DAEMON_URL, tokenOf: () => TOKEN });
      const missing = mkdtempSync(path.join(tmpdir(), "zg-p2p-mcp-empty-"));
      cleanupsDaemon.push(() => {
        rmSync(missing, { recursive: true, force: true });
      });
      const result = await client.call({
        tool: "zvec_grep_search",
        args: { root: missing, query: AUTH_QUERY, limit: 3 },
        timeoutMs: 30_000,
      });
      assert.equal(result.isError, true, result.text);
      assert.match(result.text, /ZG\.ENGINE\.NOT_FOUND/u);
      // classifyConcurrentFailure 对 MCP 错误文本（小写 error[）同样认路。
      assert.equal(classifyConcurrentFailure(result.text), null, "NOT_FOUND 不归并发类");
    }, 60_000);
  },
);
