// 点对点（P2P）契约测试：**本包构造的命令 vs 真 zg CLI**。
//
// 这一层没有任何 mock，也没有插件参与——只有 lib/cli.ts 造出来的命令行与真 zg 的
// argv 解析器/输出格式化/错误码面对话。它盯的是「上游事实有没有变」：
//
//   - 每一条旗标真 zg 还认不认（`--preview` / `--symbol-type` / `--reset-paths` …）；
//   - 穷举通道的冲突集合还是不是注释里写的那几条（含报错原文）；
//   - `--check-ready` 的非零退出码语义（报告在 stdout、结论在退出码）；
//   - 命中摘要的两个正则还匹配不匹配真输出的形状（`hits: N` / `#N matchedBy=…`）；
//   - stderr 进度噪声词表还覆不覆盖真进度行；
//   - 并发建索引的错误码与明细键还是不是 lib/zg-errors.ts 认的那几个；
//   - `--ignore-file` 指向不存在的文件时上游会把这棵树弄坏（这不是静默忽略）。
//
// 需要本地 embedding 权重的那几例按缓存是否就绪跳过（否则 zg 要联网下载模型）。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { inOrder, canMakeUnreadableFile, zgAvailable } from "../integration/host-stack.ts";

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
): Promise<{ stdout: string; stderr: string; status: number }> {
  const child = execFile(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    killSignal: "SIGKILL",
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

/** 索引命令的本包口径：embedding / 文案表 / clientMode 缺省那一路都收在这里，调用点只递 args。 */
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
/** 重建面并：这组用例重复发它。 */
const REBUILD_ARGS = { rebuild: true };
/** 单行版样本（磁盘上只需要一行，命中表达就够）。 */
const SINGLE_LINE_AUTH_BODY = "export function authService() { return 1; }\n";
/** 三条固定样本内容（断言里反复引用，抽出来免得每处抄一份）。 */
const AUTH_TS_BODY = 'export function authService() {\n  return "token";\n}\n';
const NOTES_BODY = `# workspace notes\n\n${AUTH_QUERY} is exported from ${AUTH_TS_NAME}\n`;
const GITIGNORE_NAME = ".gitignore";
const GITIGNORE_BODY = "dist/\n*.log\n";

const cleanups: (() => void)[] = [];

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

  it("真 zg --version 的原文被解析，且不低于本包门槛", async () => {
    const { stdout: raw } = await run("zg --version", ws);
    // 门口径：真输出必须被解析成版本号（读不懂 ⇒ 门槛失效），且不低于本包门槛。
    // **不钉具体版本号**：上游发 0.2.3 时旗标面可能一字未改，钉死补丁号只会让它误红。
    // 比较必须走逐段数值（versionAtLeast），不能用字符串字典序——"0.10.0" < "0.2.2"。
    const parsed = parseZgVersion(raw);
    assert.ok(parsed !== undefined, `读不懂 zg --version 原文：${raw}`);
    expect(tooOldZgVersion(raw)).toBeUndefined();
    const minimum = parseZgVersion(MINIMUM_ZG_VERSION);
    assert.ok(minimum !== undefined, MINIMUM_ZG_VERSION);
    assert.ok(versionAtLeast(parsed, minimum), `装了 ${raw.trim()}，门槛 ${MINIMUM_ZG_VERSION}`);
  }, 30_000);

  it("老版本字面量被判为太老（形状就是真 zg 的 <版本号> 行）", () => {
    // tooOldZgVersion 的「太老」是**交回实际版本**，「够新或读不懂」是 undefined：
    // 它从不返回 null，所以 not.toBeNull() 恒真、一条回归都拦不住。断言具体版本号。
    expect(tooOldZgVersion("0.0.1\n")).toStrictEqual({ major: 0, minor: 0, patch: 1 });
    expect(tooOldZgVersion("0.1.0\n")).toStrictEqual({ major: 0, minor: 1, patch: 0 });
    // 反向两臂：恰好等于门槛时放行；读不懂时也放行（门槛只拦「确知太老」）。
    expect(tooOldZgVersion(`${MINIMUM_ZG_VERSION}\n`)).toBeUndefined();
    expect(tooOldZgVersion("0.2.2-rc.1\n")).toBeUndefined();
  });

  it("穷举检索命令在真 zg 上跑通（--rg + 路径/时间过滤 + --mode）", async () => {
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
      true,
    );
    const result = await run(command, ws);
    assert.ok(
      !/unknown|unexpected|invalid/iu.test(result.stderr + result.stdout),
      `${command}\n${result.stderr}`,
    );
    assert.equal(result.status, 0, `${command}\n${result.stderr}`);
    expect(result.stdout).toContain("auth.ts");
  }, 30_000);

  it("状态命令在真 zg 上跑通（root 位置参数 + --check-ready + --mode）", async () => {
    // 独立的一棵树：这几条判的是「这棵树建过 / 还没建索引」，共享的 ws 会被别条用例改掉状态。
    const own = workspace();
    const { command } = buildStatusCommand({ root: own, checkReady: true }, messages);
    const result = await run(command, own);
    // 未建索引 ⇒ --check-ready 以非零退出码表达「未就绪」，报告仍在 stdout。
    assert.notEqual(result.status, 0, `${command}\n${result.stderr}`);
    expect(result.stdout).toContain("Workspace index is not configured");
  }, 30_000);

  it.skipIf(!modelReady)(
    "索引命令的每一个旗标都被真 zg 的 index 接受",
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

  it("穷举通道的冲突集合与实测报错原文一致", async () => {
    // lib/cli.ts 的 assertExhaustiveArgs 把这一整组拦在构造期，理由是这些实测原文；
    // 上游一旦改口，本包给出的中文指引会与真报错对不上——这里逐条对。
    const cases: [string, RegExp][] = [
      ["--preview short", /--preview is not supported with --rg/u],
      ["--refresh wait", /--rg cannot be combined with indexed refresh options/u],
      ["--fuse", /--rg cannot be combined with --fuse/u],
      ["--trace", /--rg cannot be combined with --trace/u],
    ];
    const outcomes = await inOrder(
      cases.map(
        ([flag]) =>
          () =>
            run(`zg query --rg ${flag} authService`, ws),
      ),
    );
    for (const [index, entry] of cases.entries()) {
      const [flag, expected] = entry;
      const result = outcomes[index]!;
      assert.notEqual(result.status, 0, flag);
      assert.match(result.stderr, expected, flag);
    }
  }, 60_000);

  it("--fts/--vector 与 --rg 同用也被真 zg 拒（多路查询组那一组）", async () => {
    const result = await run("zg query --rg --fts authService", ws);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /--rg cannot be combined with --hybrid, --fts, or --vector/u);
  }, 30_000);

  it("符号类型只认小写闭集（大写由真 zg 拒，正是本包绑定闭集的原因）", async () => {
    const result = await run("zg query --symbol-type Class authService --refresh off", ws);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /Unsupported symbol type: Class/u);
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
    "drop 分支的 --yes 让真 zg 非交互删索引",
    async () => {
      // 独立的一棵树：这几条判的是「这棵树建过 / 还没建索引」，共享的 ws 会被别条用例改掉状态。
      const own = workspace();
      const seed = indexCommand({ root: own });
      const seeded = await run(seed.command, own);
      assert.equal(seeded.status, 0, `${seed.command}\n${seeded.stderr}`);
      const built = indexCommand({ root: own, drop: true });
      const result = await run(built.command, own);
      assert.equal(result.status, 0, `${built.command}\n${result.stderr}`);
      const status = await run(buildStatusCommand({ root: own }, messages).command, own);
      expect(status.stdout).toContain("not configured");
    },
    60_000,
  );

  it.skipIf(!modelReady)(
    "--ignore-file 指向不存在的文件会把这棵树的索引弄坏（不是静默忽略）",
    async () => {
      // 上游实测：ENOENT ⇒ 整次索引失败，并且那个坏路径**写进工作区索引状态**——此后这条树上的
      // zg index / zg status 都报同一个 ENOENT，--reset-paths 清不掉，只有 drop 能救。
      // 本包因此在 host.ts 侧补了存在性预检（assertIgnoreFilesExist），这条钉住上游事实。
      const dir = workspace();
      const bad = indexCommand({ root: dir, ignoreFiles: ["does-not-exist.ignore"] });
      const badResult = await run(bad.command, dir);
      assert.notEqual(badResult.status, 0, bad.command);
      assert.match(badResult.stderr, /ZVEC_GREP\.ENGINE\.INDEXING\.WORKSPACE_FAILED/u);
      assert.match(badResult.stderr, /ENOENT/u);
      // 对照半边：换一棵没被弄坏的树，同一条旗标照常工作。
      const fresh = workspace();
      const good = indexCommand({ root: fresh, ignoreFiles: [GITIGNORE_NAME] });
      const goodResult = await run(good.command, fresh);
      assert.equal(goodResult.status, 0, `${good.command}\n${goodResult.stderr}`);
      // 而同一棵树再来一次（哪怕这次给的路径是真的）也救不回来。
      const retry = indexCommand({ root: dir, ignoreFiles: [GITIGNORE_NAME] });
      const retryResult = await run(retry.command, dir);
      assert.notEqual(retryResult.status, 0, `${retry.command}\n${retryResult.stderr}`);
      assert.match(retryResult.stderr, /ENOENT/u);
    },
    120_000,
  );

  it.skipIf(!canMakeUnreadableFile() || !modelReady)(
    "--ignore-file 指向读不了的文件同样把这棵树弄坏（不是静默忽略）",
    async () => {
      // 与"不存在"那一档同一种损坏，但更隐蔽：mode 000 的文件 statSync().isFile() 照样为真，
      // 预检若只查"存在"就会放过它，而真 zg open 它会 EACCES ⇒ 整次索引失败、坏路径写进工作区
      // 状态，此后这条树上的 zg index / zg status 都报同一个 EACCES。本包的预检因此以 accessSync(R_OK)
      // 在前，把"当前进程读得了"与"是文件"合成一次判定。这一档只在造得出「属主也读不了」文件的
      // 环境跑：root 绕过 DAC（mode 000 对 root 可读、zg 也读得了 ⇒ 无从损坏），windows 的 chmod
      // 只翻只读位、不挡属主读取 ⇒ 两种都跳过（见 host-stack 的 canMakeUnreadableFile）。
      const dir = workspace({ "unreadable.ignore": "*.log\n" });
      const unreadable = path.join(dir, "unreadable.ignore");
      chmodSync(unreadable, 0o000);
      try {
        const bad = indexCommand({ root: dir, ignoreFiles: ["unreadable.ignore"] });
        const badResult = await run(bad.command, dir);
        assert.notEqual(badResult.status, 0, bad.command);
        assert.match(badResult.stderr, /ZVEC_GREP\.ENGINE\.INDEXING\.WORKSPACE_FAILED/u);
        assert.match(badResult.stderr, /EACCES/u);
        // 坏路径已写进工作区状态：换一条**可读**的忽略文件再来一次也救不回来（只有 drop 能救）。
        const retry = indexCommand({ root: dir, ignoreFiles: [GITIGNORE_NAME] });
        const retryResult = await run(retry.command, dir);
        assert.notEqual(retryResult.status, 0, `${retry.command}\n${retryResult.stderr}`);
        assert.match(retryResult.stderr, /EACCES/u);
      } finally {
        chmodSync(unreadable, 0o644);
      }
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

  it("hitSummary 按真输出解析分组计数与去重位置数", async () => {
    const dir = await indexedWorkspace();
    const built = buildSearchCommand(
      { root: dir, query: AUTH_QUERY, limit: 5 },
      messages,
      clientModeOf(undefined, messages),
    );
    const result = await run(built.command, dir);
    assert.equal(result.status, 0, `${built.command}\n${result.stderr}`);
    // 真输出形状（逐项对着 formatScore / agentRankedItemHeader 核过）。
    expect(result.stdout).toContain("query groups (1):");
    assert.match(result.stdout, /^hits: \d+$/mu);
    // 单行命中只有 `:行号`，多行命中是 `:起-止`（实测两种都有）。
    assert.match(result.stdout, /^#\d+ matchedBy=\S+ .+:\d+(?:-\d+)?$/mu);

    const summary = hitSummary(result.stdout, 5, false, messages);
    assert.ok(summary !== null, result.stdout);
    expect(summary).toContain("1 个查询组");
    expect(summary).toContain("命中摘要");
  }, 120_000);

  it("--trace 的输出（score= 与 trace 行）也被同一个正则认出位置", async () => {
    const dir = await indexedWorkspace();
    const built = buildSearchCommand(
      { root: dir, query: "auth", trace: true, limit: 3 },
      messages,
      clientModeOf(undefined, messages),
    );
    const result = await run(built.command, dir);
    assert.equal(result.status, 0, `${built.command}\n${result.stderr}`);
    assert.match(result.stdout, /^#\d+ matchedBy=\S+ score=-?\d+(?:\.\d+)? .+:\d+(?:-\d+)?$/mu);
    // 摘要的去重口径必须把 score 排除在键外（同一位置在两个组里分值不同）。
    const summary = hitSummary(result.stdout, 3, false, messages);
    assert.ok(summary !== null, result.stdout);
    expect(summary).toContain("去重后");
  }, 120_000);

  it("stderr 进度噪声词表覆盖真索引进度行，且不漏掉告警", async () => {
    const dir = await indexedWorkspace();
    const built = indexCommand({ root: dir, rebuild: true });
    const result = await run(built.command, dir);
    assert.equal(result.status, 0, `${built.command}\n${result.stderr}`);
    // 真进度行进噪声表：signalStderr 之后一句都不剩。
    expect(signalStderr(result.stderr)).toBe("");
    // 认不出的行一律保留（这条是判据的另外一半：只丢认得的）。
    expect(signalStderr("warning: embedding model fell back to lexical\n")).toBe(
      "warning: embedding model fell back to lexical",
    );
  }, 120_000);

  it("密钥排除真的在挡东西（`.pem` 会被索引，默认那条规则不是死规则）", async () => {
    // lib/cli.ts 的 pushIndexGlobs 有一句被改过的断言：`.pem`「不在可索引类型里」。真 zg 0.2.2 上是**假的**
    // ——单独造一棵只放密钥文件的树，它照样 `added`，照样能被检索回来。这条用例同时钉两半：
    // 关着排除时确实进了索引（规则是有对象的），开着排除时确实取不回来（规则是活的）。
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
    async function indexSecrets(excludeSecrets: boolean): Promise<string> {
      const dir = secretWorkspace();
      const built = indexCommand({ root: dir, excludeSecrets });
      const result = await run(built.command, dir);
      assert.equal(result.status, 0, `${built.command}\n${result.stderr}`);
      return dir;
    }

    const bare = await indexSecrets(false);
    // 排除关着：两类密钥文件都进得了索引 —— 这是「规则有对象」那一半，也是那句错注释的反证。
    await expect(searchLiteral(bare, secretMarker)).resolves.toContain(secretName);
    await expect(searchLiteral(bare, mixedMarker)).resolves.toContain(mixedName);

    const guarded = await indexSecrets(true);
    // 排除开着（本包默认）：同两条字面量都取不回来，而正常源码仍在 —— 规则不是装饰。
    await expect(searchLiteral(guarded, secretMarker)).resolves.not.toContain(secretName);
    await expect(searchLiteral(guarded, mixedMarker)).resolves.not.toContain(mixedName);
    await expect(searchLiteral(guarded, AUTH_QUERY)).resolves.toContain(AUTH_TS_NAME);
  }, 180_000);

  it("守护进程就绪探测的旗标在真 zg 上存在（非零码就是未就绪）", async () => {
    // host.ts 的 SERVER_READY_COMMAND 是 BackgroundSupport 的唯一证据源：上游改名或取消
    // `--check-ready` 时，本机所有 mock 用例照绿（它们比的是字符串），症状却是
    // refresh=background 这一档永久被拒。这里问一次**真** zg。
    const dir = mkdtempSync(path.join(tmpdir(), "zg-p2p-ready-"));
    cleanupsIndexed.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const result = await run("zg server status --check-ready", dir);
    // 就绪与否由这台机器的事实决定，两种都合法；不合法的是「旗标不认识」。
    const rejected = /unknown|unexpected|invalid|unrecognized/iu;
    assert.ok(!rejected.test(result.stderr + result.stdout), `${result.stderr}\n${result.stdout}`);
    if (result.status !== 0) {
      // 未就绪那一臂必须用退出码 + 那句原文表达（判据读的是退出码，文本只是给人的）。
      assert.match(result.stderr, /server is not ready/u);
    }
  }, 60_000);

  it("并发重建的真实报错被 classifyConcurrentFailure 认出（含占锁方字段）", async () => {
    // 真 zg 在另一条写路径持锁时会给出结构化失败；这里连起两条真索引来撞它。
    // 传输模式显式取 direct：auto 那一支在该 root 的索引写权被守护进程持住时，两条显式重建会被
    // **双双**挡下（本机空闲复跑两次读到的形状：两臂 `ENGINE.LOCK.BUSY`，或一臂
    // `ENGINE.DAEMON_LEASE_ACTIVE` 且 `pid: 0`、另一臂才建成），于是「至少一臂真把索引建出来」
    // 这条见证与守护进程状态耦合。direct 让两条命令自己抢锁，撞出来的仍是 lock-busy 那一族。
    const root = await indexedWorkspace();
    const { rebuild } = REBUILD_ARGS;
    const args = { root, rebuild };
    const built = indexCommand(args, "direct");
    const { command } = built;
    // 两条**同时**起：await 完第一条再起第二条等于串行，锁早已释放，本组会恒绿。
    const first = run(command, root);
    const concurrent = run(command, root);
    const [built0, second] = await Promise.all([first, concurrent]);
    // 并发之后**两条都可能**撞锁，不许再假定「第一条必然成功」；但至少要有一条真把索引建出来，
    // 否则两臂都失败就什么都没证到。
    const both = [built0, second];
    assert.ok(
      both.some((outcome) => outcome.status === 0),
      `${command}\n${both.map((outcome) => outcome.stderr).join("\n")}`,
    );
    for (const failed of both.filter((outcome) => outcome.status !== 0)) {
      const classified = classifyConcurrentFailure(failed.stderr);
      assert.ok(classified !== null, failed.stderr);
      expect(["lock-busy", "daemon-lease"]).toContain(classified.kind);
      if (classified.kind === "lock-busy") {
        // 占锁方自报的操作名决定「要不要排队等」：不是重建就一等不到头。
        assert.equal(typeof classified.ownerOperation, "string");
      }
    }
  }, 180_000);
});
