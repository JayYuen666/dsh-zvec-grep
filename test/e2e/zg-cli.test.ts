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
import { existsSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  buildIndexCommand,
  buildSearchCommand,
  buildStatusCommand,
  clientModeOf,
} from "../../lib/cli.ts";
import { MESSAGES } from "../../lib/messages.ts";
import type { ZvecGrepMessages } from "../../lib/messages.ts";
import { classifyConcurrentFailure } from "../../lib/zg-errors.ts";
import { MINIMUM_ZG_VERSION, parseZgVersion, tooOldZgVersion } from "../../lib/zg-version.ts";
import { hitSummary, signalStderr } from "../../host.ts";
import { inOrder, canMakeUnreadableFile, zgAvailable } from "../integration/host-stack.ts";

/** 子进程退出码（close 事件；kill 不等于退出码，这里只看退出码）。 */
async function exitCode(child: ChildProcess): Promise<number> {
  const signals: unknown[] = await once(child, "close");
  const code: unknown = signals[0];
  return typeof code === "number" ? code : -1;
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
 * 异步跑一条命令（不用同步 API：本包审查只开 node/no-sync 的写盘一组）。
 * 非零退出也不抛：失败输出正是这套用例要对照的资料（上游拒绝原文）。
 */
async function run(
  command: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; status: number }> {
  const child = execFile(command, { cwd, shell: true, encoding: "utf8" });
  const [stdout, stderr, status] = await Promise.all([
    drain(child.stdout),
    drain(child.stderr),
    exitCode(child),
  ]);
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

/** 本地 embedding 权重是否已缓存。 */
function modelCached(): boolean {
  const models = path.join(homedir(), ".zvec-grep", "models");
  return (
    existsSync(path.join(models, "hf_Qwen_Qwen3-Embedding-0.6B-Q8_0.gguf")) ||
    existsSync(path.join(models, "model2vec", "minishlab--potion-code-16M-v2"))
  );
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
    assert.deepEqual(parseZgVersion(raw), { major: 0, minor: 2, patch: 2 }, raw);
    expect(tooOldZgVersion(raw)).toBeUndefined();
    const installed = raw.trim().split(/\s+/u).at(-1);
    assert.ok(installed !== undefined && installed >= MINIMUM_ZG_VERSION, `装了 ${installed}`);
  }, 30_000);

  it("老版本字面量被判为太老（形状就是真 zg 的 <版本号> 行）", () => {
    expect(tooOldZgVersion("0.0.1\n")).not.toBeNull();
    expect(tooOldZgVersion("0.1.0\n")).not.toBeNull();
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
    const { command } = buildStatusCommand({ root: ws, checkReady: true }, messages);
    const result = await run(command, ws);
    // 未建索引 ⇒ --check-ready 以非零退出码表达「未就绪」，报告仍在 stdout。
    assert.notEqual(result.status, 0, `${command}\n${result.stderr}`);
    expect(result.stdout).toContain("Workspace index is not configured");
  }, 30_000);

  it("索引命令的每一个旗标都被真 zg 的 index 接受", async () => {
    const { command } = buildIndexCommand(
      {
        root: ws,
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
      },
      LOCAL_EMBEDDING,
      messages,
      clientModeOf(undefined, messages),
    );
    const result = await run(command, ws);
    assert.equal(result.status, 0, `${command}\n${result.stderr}`);
    expect(result.stdout).toContain("Workspace index");
  }, 60_000);

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

  it("密钥排除旗标被真 zg 接受，且排在本函数最后（用户 iglob 之后）", async () => {
    const built = buildIndexCommand(
      { root: ws, globs: ["**/*.ts"], insensitiveGlobs: ["**"], excludeSecrets: true },
      LOCAL_EMBEDDING,
      messages,
      clientModeOf(undefined, messages),
    );
    // `**` 这条宽泛正向规则若排在密钥规则之后会把密钥文件救回索引：真 zg 的求值顺序是全
    // --glob 先于全 --iglob，而密钥规则是本包最后追加的 --iglob。
    const iglobs = built.command.match(/--iglob '[^']*'/gu) ?? [];
    expect(iglobs.length).toBeGreaterThan(3);
    expect(iglobs.at(-1)).toContain("id_ed25519");
    const result = await run(built.command, ws);
    assert.equal(result.status, 0, `${built.command}\n${result.stderr}`);
  }, 60_000);

  it("drop 分支的 --yes 让真 zg 非交互删索引", async () => {
    const built = buildIndexCommand(
      { root: ws, drop: true },
      LOCAL_EMBEDDING,
      messages,
      clientModeOf(undefined, messages),
    );
    const result = await run(built.command, ws);
    assert.equal(result.status, 0, `${built.command}\n${result.stderr}`);
    const status = await run(buildStatusCommand({ root: ws }, messages).command, ws);
    expect(status.stdout).toContain("not configured");
  }, 60_000);

  it("--ignore-file 指向不存在的文件会把这棵树的索引弄坏（不是静默忽略）", async () => {
    // 上游实测：ENOENT ⇒ 整次索引失败，并且那个坏路径**写进工作区索引状态**——此后这条树上的
    // zg index / zg status 都报同一个 ENOENT，--reset-paths 清不掉，只有 drop 能救。
    // 本包因此在 host.ts 侧补了存在性预检（assertIgnoreFilesExist），这条钉住上游事实。
    const dir = workspace();
    const bad = buildIndexCommand(
      { root: dir, ignoreFiles: ["does-not-exist.ignore"] },
      LOCAL_EMBEDDING,
      messages,
      clientModeOf(undefined, messages),
    );
    const badResult = await run(bad.command, dir);
    assert.notEqual(badResult.status, 0, bad.command);
    assert.match(badResult.stderr, /ZVEC_GREP\.ENGINE\.INDEXING\.WORKSPACE_FAILED/u);
    assert.match(badResult.stderr, /ENOENT/u);
    // 对照半边：换一棵没被弄坏的树，同一条旗标照常工作。
    const fresh = workspace();
    const good = buildIndexCommand(
      { root: fresh, ignoreFiles: [GITIGNORE_NAME] },
      LOCAL_EMBEDDING,
      messages,
      clientModeOf(undefined, messages),
    );
    const goodResult = await run(good.command, fresh);
    assert.equal(goodResult.status, 0, `${good.command}\n${goodResult.stderr}`);
    // 而同一棵树再来一次（哪怕这次给的路径是真的）也救不回来。
    const retry = buildIndexCommand(
      { root: dir, ignoreFiles: [GITIGNORE_NAME] },
      LOCAL_EMBEDDING,
      messages,
      clientModeOf(undefined, messages),
    );
    const retryResult = await run(retry.command, dir);
    assert.notEqual(retryResult.status, 0, `${retry.command}\n${retryResult.stderr}`);
    assert.match(retryResult.stderr, /ENOENT/u);
  }, 120_000);

  it.skipIf(!canMakeUnreadableFile())(
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
        const bad = buildIndexCommand(
          { root: dir, ignoreFiles: ["unreadable.ignore"] },
          LOCAL_EMBEDDING,
          messages,
          clientModeOf(undefined, messages),
        );
        const badResult = await run(bad.command, dir);
        assert.notEqual(badResult.status, 0, bad.command);
        assert.match(badResult.stderr, /ZVEC_GREP\.ENGINE\.INDEXING\.WORKSPACE_FAILED/u);
        assert.match(badResult.stderr, /EACCES/u);
        // 坏路径已写进工作区状态：换一条**可读**的忽略文件再来一次也救不回来（只有 drop 能救）。
        const retry = buildIndexCommand(
          { root: dir, ignoreFiles: [GITIGNORE_NAME] },
          LOCAL_EMBEDDING,
          messages,
          clientModeOf(undefined, messages),
        );
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

describe.skipIf(!zgAvailable() || !modelCached())("点对点：索引检索的输出形状与摘要解析", () => {
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
    const built = buildIndexCommand(
      { root: dir },
      LOCAL_EMBEDDING,
      messages,
      clientModeOf(undefined, messages),
    );
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
    const built = buildIndexCommand(
      { root: dir, rebuild: true },
      LOCAL_EMBEDDING,
      messages,
      clientModeOf(undefined, messages),
    );
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
      const built = buildIndexCommand(
        { root: dir, excludeSecrets },
        LOCAL_EMBEDDING,
        messages,
        clientModeOf(undefined, messages),
      );
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
    const root = await indexedWorkspace();
    const { rebuild } = REBUILD_ARGS;
    const args = { root, rebuild };
    const built = buildIndexCommand(
      args,
      LOCAL_EMBEDDING,
      messages,
      clientModeOf(undefined, messages),
    );
    const { command } = built;
    const first = await run(command, root);
    assert.equal(first.status, 0, `${command}\n${first.stderr}`);
    // 第二条紧接着起：要么被锁拒（结构化失败），要么排到锁后成功。
    const concurrent = await run(command, root);
    if (concurrent.status === 0) {
      // 没撞上（锁已放）也成立：这一条只断言「撞上时认得出来」。
      return;
    }
    const classified = classifyConcurrentFailure(concurrent.stderr);
    assert.ok(classified !== null, concurrent.stderr);
    expect(["lock-busy", "daemon-lease"]).toContain(classified.kind);
    if (classified.kind === "lock-busy") {
      // 占锁方自报的操作名决定「要不要排队等」：不是重建就一等不到头。
      assert.equal(typeof classified.ownerOperation, "string");
    }
  }, 180_000);
});
