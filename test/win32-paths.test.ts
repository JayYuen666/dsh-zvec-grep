// win32 路径与 pwsh 命令方言的单一来源测试：路径归一/包含判据/向上找索引根/
// search-first 门禁/命令构造/转义。全部用 platform 注入，不依赖测试机的操作系统；
// 真盘行为由 Windows CI 的 host 集成用例覆盖。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { MESSAGES } from "../lib/messages.ts";
import {
  assertAbsoluteRoot,
  buildIndexCommand,
  buildSearchCommand,
  buildStatusCommand,
  normalizeAbsolutePath,
  resolveRoot,
} from "../lib/cli.ts";
import { shq } from "../lib/argv-guard.ts";
import {
  hasExternalTarget,
  isGrepRgCommand,
  normalizeRoot,
  pathInsideRoot,
  pathsRelated,
} from "../lib/search-predicates.ts";
import { createRootLedger } from "../host.ts";
import { createRebuildRegistry } from "../lib/rebuild-state.ts";
import { BACKSLASH } from "../lib/platform.ts";
import { findIndexRoot, searchFirstGuard } from "../lib/routing.ts";
import type { SearchFirstDeps } from "../lib/routing.ts";

const { zh } = MESSAGES;

describe("win32 绝对路径归一", () => {
  it("盘符/UNC/扩展长度前缀都归一成反斜杠、去尾分隔符", () => {
    assert.equal(
      normalizeAbsolutePath(String.raw`C:\repo\.\src\..\lib`, zh, "win32"),
      String.raw`C:\repo\lib`,
    );
    assert.equal(normalizeAbsolutePath("c:/repo/src/", zh, "win32"), String.raw`c:\repo\src`);
    assert.equal(
      normalizeAbsolutePath(String.raw`\\?\C:\repo\src`, zh, "win32"),
      String.raw`C:\repo\src`,
    );
    assert.equal(
      normalizeAbsolutePath(String.raw`\\?\UNC\srv\share\x`, zh, "win32"),
      String.raw`\\srv\share\x`,
    );
  });

  it("盘符根与 UNC 共享根保留尾分隔符；normalizeRoot 识别根自身", () => {
    const driveRoot = String.raw`C:` + BACKSLASH;
    const uncRoot = String.raw`\\srv\share` + BACKSLASH;
    assert.equal(normalizeAbsolutePath("C:/", zh, "win32"), driveRoot);
    assert.equal(normalizeAbsolutePath("//srv/share/", zh, "win32"), uncRoot);
    assert.equal(normalizeRoot("C:/", "win32"), driveRoot);
    assert.equal(normalizeRoot("//srv/share/", "win32"), uncRoot);
    assert.equal(normalizeRoot("C:/Repo/Src/", "win32"), String.raw`C:\Repo\Src`);
    assert.equal(normalizeRoot("//", "win32"), BACKSLASH, "只有分隔符时落回 parse 出的根");
  });

  it("越出盘符/共享根的 .. 抛错，不能静默钳到根", () => {
    assert.throws(
      () => normalizeAbsolutePath(String.raw`C:\..\x`, zh, "win32"),
      /越界|文件系统根/u,
    );
    assert.throws(
      () => normalizeAbsolutePath(String.raw`\\srv\share\..\..\x`, zh, "win32"),
      /越界|文件系统根/u,
    );
  });

  it("盘符绝对与 UNC 是合法根；盘符相对/根相对/文件系统根被拒", () => {
    assert.equal(assertAbsoluteRoot(String.raw`C:\repo`, zh, "win32"), String.raw`C:\repo`);
    assert.equal(assertAbsoluteRoot("c:/repo/src", zh, "win32"), String.raw`c:\repo\src`);
    assert.equal(
      assertAbsoluteRoot(String.raw`\\srv\share\repo`, zh, "win32"),
      String.raw`\\srv\share\repo`,
    );
    for (const root of [
      String.raw`C:` + BACKSLASH,
      String.raw`\\srv\share` + BACKSLASH,
      "C:repo",
      String.raw`\repo`,
      "repo",
    ]) {
      assert.throws(() => assertAbsoluteRoot(root, zh, "win32"), `${root} 应被拒`);
    }
  });

  it("resolveRoot 的 fallback 也走 win32 判据", () => {
    assert.equal(resolveRoot(undefined, String.raw`C:\ws`, zh, "win32"), String.raw`C:\ws`);
    assert.throws(() => resolveRoot(undefined, "C:ws", zh, "win32"), /绝对路径/u);
  });
});

describe("win32 包含判据", () => {
  const root = String.raw`C:\Repo`;

  it("大小写不敏感、两种分隔符等价、根自身与后代都在内", () => {
    assert.equal(pathInsideRoot(String.raw`c:\repo\src`, root, zh, "win32"), true);
    assert.equal(pathInsideRoot("c:/repo/src/a.ts", root, zh, "win32"), true);
    assert.equal(pathInsideRoot(String.raw`C:\Repo`, root, zh, "win32"), true);
    assert.equal(pathInsideRoot(String.raw`\repo\src`, root, zh, "win32"), true);
    assert.equal(pathInsideRoot(String.raw`\other`, root, zh, "win32"), false);
  });

  it(".. 逃逸、不同盘符、不同共享都是根外", () => {
    assert.equal(pathInsideRoot(String.raw`..\other`, root, zh, "win32"), false);
    assert.equal(pathInsideRoot(String.raw`src\..\..\escape`, root, zh, "win32"), false);
    assert.equal(pathInsideRoot(String.raw`..\..\..\escape`, root, zh, "win32"), false);
    assert.equal(pathInsideRoot(String.raw`D:\Repo\src`, root, zh, "win32"), false);
    assert.equal(pathInsideRoot(String.raw`\\srv\share\x`, root, zh, "win32"), false);
  });

  it("pathsRelated 双向都按 win32 判", () => {
    assert.equal(pathsRelated(String.raw`c:\repo\src`, String.raw`C:\Repo`, zh, "win32"), true);
    assert.equal(pathsRelated(String.raw`C:\other`, root, zh, "win32"), false);
  });

  it("向上找索引根：盘符路径逐级到根停止；相对路径不探", () => {
    const probed: string[] = [];
    const probe = (dir: string): boolean => {
      probed.push(dir);
      return dir === String.raw`C:\repo`;
    };
    assert.equal(
      findIndexRoot(String.raw`C:\repo\packages\app`, probe, 8, "win32"),
      String.raw`C:\repo`,
    );
    assert.deepEqual(probed, [
      String.raw`C:\repo\packages\app`,
      String.raw`C:\repo\packages`,
      String.raw`C:\repo`,
    ]);
    assert.equal(findIndexRoot("repo/app", probe, 8, "win32"), undefined);
  });

  it("从 UNC 起点逐级向上到共享根停止", () => {
    const probed: string[] = [];
    const probe = (dir: string): boolean => {
      probed.push(dir);
      return false;
    };
    assert.equal(findIndexRoot(String.raw`\\srv\share\a\b`, probe, 8, "win32"), undefined);
    assert.equal(probed.at(-1), String.raw`\\srv\share` + BACKSLASH);
  });
});

describe("win32 命令门禁与命令构造", () => {
  it("rg.exe / 盘符路径命令 / pwsh -Command 都认成检索", () => {
    assert.equal(isGrepRgCommand("rg.exe foo src", 0, "win32"), true);
    assert.equal(isGrepRgCommand(String.raw`C:\tools\rg.exe foo src`, 0, "win32"), true);
    assert.equal(isGrepRgCommand(String.raw`pwsh -Command 'rg foo C:\repo'`, 0, "win32"), true);
    assert.equal(isGrepRgCommand(String.raw`rg foo C:\repo\src`, 0, "win32"), true);
    // pwsh 的单引号内 `''` 是字面单引号：切词后模式词含引号，命令位仍然是 rg。
    assert.equal(isGrepRgCommand(String.raw`rg foo 'it''s' src`, 0, "win32"), true);
    // 双引号内的反引号是转义：不关闭引号，token 继续吃后面的内容。
    assert.equal(isGrepRgCommand('rg "a`"b" src', 0, "win32"), true);
    assert.equal(isGrepRgCommand("Get-ChildItem | Select-String foo", 0, "win32"), false);
  });

  it("外部目标：盘符/相对逃逸判根外，根内与重定向/取值旗标不判", () => {
    const root = String.raw`C:\repo`;
    assert.equal(hasExternalTarget(root, String.raw`rg foo C:\repo\src`, zh, "win32"), false);
    assert.equal(hasExternalTarget(root, String.raw`rg foo D:\outside`, zh, "win32"), true);
    assert.equal(hasExternalTarget(root, String.raw`rg foo ..\outside`, zh, "win32"), true);
    assert.equal(hasExternalTarget(root, String.raw`rg foo src > C:\tmp\out`, zh, "win32"), false);
    assert.equal(
      hasExternalTarget(root, String.raw`rg --glob C:\tmp\x foo src`, zh, "win32"),
      false,
    );
  });

  it("pwsh 单引号转义：内嵌单引号写成两个", () => {
    assert.equal(shq("it's", "win32"), "'it''s'");
    assert.equal(shq(String.raw`C:\a b\c`, "win32"), String.raw`'C:\a b\c'`);
  });

  it("buildSearchCommand 用 win32 转义与归一后的 workdir", () => {
    const { command, workdir } = buildSearchCommand(
      { root: "c:/ws", query: "it's", platform: "win32" },
      zh,
    );
    assert.equal(workdir, String.raw`c:\ws`);
    assert.match(command, /^zg --hybrid='it''s' --limit 10 --preview short --refresh wait /u);
  });

  it("buildIndexCommand / buildStatusCommand 的 root 是 win32 归一形", () => {
    const index = buildIndexCommand(
      { root: "C:/ws/", platform: "win32" },
      "local/potion-code-16m-v2",
      zh,
    );
    assert.equal(index.workdir, String.raw`C:\ws`);
    assert.ok(index.command.startsWith(String.raw`zg --index 'C:\ws' --embedding `));
    const status = buildStatusCommand({ root: "C:/ws/", platform: "win32" }, zh);
    assert.equal(status.command, String.raw`zg --status 'C:\ws' --mode auto`);
  });

  it("win32 命令规模按 CreateProcess 余量（24000 字节）拒绝", () => {
    const queries = Array.from({ length: 7 }, () => "x".repeat(4000));
    assert.throws(
      () => buildSearchCommand({ root: String.raw`C:\ws`, queries, platform: "win32" }, zh),
      /24000/u,
    );
  });

  it("searchFirstGuard：索引根内的 rg.exe 被拦，盘符外部目标放行", () => {
    const deps: SearchFirstDeps = {
      enabled: true,
      platform: "win32",
      indexProbe: (dir) => dir === String.raw`C:\repo`,
      now: () => 1,
      grepBudget: 3,
      windowMin: 10,
      lookupUnlock: () => void 0,
      consumeGrep: () => void 0,
    };
    const agent = {
      session: { id: "s1", header: { cwd: String.raw`C:\repo\packages\app` } },
    };
    const blocked = searchFirstGuard(
      { name: "pwsh", arguments: { command: "rg.exe foo src" }, agent },
      deps,
      zh,
    );
    assert.match(blocked ?? "", /zg_search/u);
    assert.equal(
      searchFirstGuard(
        { name: "pwsh", arguments: { command: String.raw`rg foo D:\outside` }, agent },
        deps,
        zh,
      ),
      undefined,
    );
    // 原生 grep 工具的 path 也走同一套 win32 拼接与包含判据：相对目标先按 cwd 补全。
    assert.match(
      searchFirstGuard({ name: "grep", arguments: { path: "src" }, agent }, deps, zh) ?? "",
      /zg_search/u,
    );
    assert.equal(
      searchFirstGuard(
        { name: "grep", arguments: { path: String.raw`D:\outside` }, agent },
        deps,
        zh,
      ),
      undefined,
    );
  });

  it("白名单与重建台账的键按 win32 归一（大小写/尾分隔符不产生第二个键）", () => {
    const ledger = createRootLedger(zh, 8, () => 1, 60_000, "win32");
    ledger.add(String.raw`C:\Repo`);
    assert.equal(ledger.has(String.raw`c:\repo` + BACKSLASH), true);
    const rebuilds = createRebuildRegistry({ platform: "win32", now: () => 1 });
    const claimed = rebuilds.claim(String.raw`C:\Repo`, "tool", 1);
    assert.ok(claimed !== null);
    assert.equal(rebuilds.covering(String.raw`c:\repo\src`, zh)?.root, String.raw`C:\Repo`);
    rebuilds.release(String.raw`c:\repo`, claimed);
  });
});
