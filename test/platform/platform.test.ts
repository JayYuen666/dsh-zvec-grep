// 跨平台语义钉：本包的根判据按 POSIX 形设计（README Support surface 明写 Windows 主机
// 不在支持面内，失败形态是 fail-fast），但 CI 有 windows 格，命令串可能带着 Windows 侧
// 的换行（CRLF）进来，shq 的转义也要经真 shell 验一遍。这一层钉「平台无关的拒绝档」
// 与「平台相关的容忍档」，不重述单测已有的形状。
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import fc from "fast-check";

import { comparablePath } from "../../host.ts";

import { MESSAGES } from "../../lib/messages.ts";
import { isGrepRgCommand, normalizeRoot } from "../../lib/search-predicates.ts";
import { assertAbsoluteRoot, normalizeAbsolutePath } from "../../lib/cli.ts";
import { shq } from "../../lib/argv-guard.ts";

/** 读完一路流（空流端视为空串），同 test/e2e/zg-cli.test.ts 的手法。 */
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

/** 跑一条 bash 命令取 stdout（非零退出即抛：oracle 只认成功还原）。 */
async function runBash(command: string): Promise<string> {
  const child: ChildProcess = execFile("bash", ["-c", command], { encoding: "utf8" });
  const [stdout] = await Promise.all([drain(child.stdout), once(child, "close")]);
  return stdout;
}

const { zh } = MESSAGES;

const comparablePathSource = (): string => {
  const source = readFileSync(path.resolve(import.meta.dirname, "../../host.ts"), "utf8");
  return source.slice(
    source.indexOf("function comparablePath"),
    source.indexOf("SUPPORTED_MANIFEST_VERSION"),
  );
};

describe("comparablePath 的平台门控（真 bug 的机制级门禁）", () => {
  // 历史：剥 /private 前缀曾是无条件字符串操作——Linux 上 /private/X 与 /X 是无关的
  // 真实目录，manifest 覆盖判据随之把两棵不同的树判成同一棵。修复是把剥除门控在
  // darwin 上。静态门禁钉「门控必须存在」；行为用例注入平台值，两个分支在任何测试机
  // 上都可达（分支覆盖率不靠测试机自己的操作系统）；真盘场景由 host.test.ts 的
  // darwin 用例与 e2e 的真 zg 回路兜住。
  it("剥 /private 前缀必须以 darwin 为条件，不得退回无条件剥除", () => {
    assert.equal(
      comparablePathSource().includes('=== "darwin"'),
      true,
      "comparablePath 的 /private 剥除失去了 darwin 门控",
    );
  });

  it("门控只在剥离分支：非 darwin 平台的原样返回路径不得夹带剥除", () => {
    // 三元结构：条件为 darwin 才剥。用「darwin 比较出现在 startsWith 之前」钉结构。
    const body = comparablePathSource();
    const darwinAt = body.indexOf('=== "darwin"');
    const stripAt = body.indexOf("startsWith");
    assert.ok(darwinAt !== -1 && stripAt !== -1 && darwinAt < stripAt, "门控结构漂移");
  });

  it("darwin 剥前缀、其余平台原样返回（平台注入，行为不随测试机变）", () => {
    const privateTmpWs = "/private/tmp/ws";
    const tmpWs = "/tmp/ws";
    assert.equal(comparablePath(privateTmpWs, "darwin"), tmpWs);
    assert.equal(comparablePath(tmpWs, "darwin"), tmpWs);
    assert.equal(comparablePath(privateTmpWs, "linux"), privateTmpWs);
    assert.equal(comparablePath(privateTmpWs, "win32"), privateTmpWs);
  });
});

describe("win32 形状的根在各平台一律拒绝（fail-fast 是设计决定）", () => {
  it("盘符、盘符相对、反斜杠 UNC、反斜杠混合都不是合法根", () => {
    const rejected = [
      String.raw`C:\repo`,
      String.raw`c:\repo`,
      String.raw`\\host\share`,
      String.raw`\repo`,
      "C:repo",
      String.raw`C:\repo\src`,
    ];
    for (const root of rejected) {
      assert.throws(() => assertAbsoluteRoot(root, zh), /absolute|绝对路径/u, `应拒绝 ${root}`);
    }
  });

  it("反斜杠在 POSIX 上是文件名字符：根判据不把它当分隔符，归一原样保留", () => {
    // "/a\b" 是一个名为 `a\b` 的目录（Linux 合法），不是两层。
    const slashFile = String.raw`/a\b`;
    const slashFileTrailing = `${slashFile}\\`;
    assert.equal(normalizeAbsolutePath(slashFile, zh), slashFile);
    // 尾部斜杠归一只剥 `/`：反斜杠不是尾斜杠。
    assert.equal(normalizeRoot(`${slashFile}/`), slashFile);
    assert.equal(normalizeRoot(slashFileTrailing), slashFileTrailing);
  });
});

describe("命令串带 CRLF 换行（Windows 侧传来）", () => {
  it(String.raw`\r 充当命令分隔：换行后的 grep/rg 仍在命令位上`, () => {
    assert.equal(isGrepRgCommand("ls\r\nrg foo"), true);
    assert.equal(isGrepRgCommand("rg a\r\ngrep b ."), true);
    assert.equal(isGrepRgCommand("rg a\r\nls"), true);
  });

  it(String.raw`引号内的 \r\n 是字面量：不产生命令位、不改变判定`, () => {
    assert.equal(isGrepRgCommand(`echo ${shq("a\r\nb")}`), false);
    assert.equal(isGrepRgCommand(`echo ${shq("grep -r foo\r\nrm -rf /")}`), false);
  });
});

describe("shq 经真 POSIX shell 的往返（转义唯一性的现实验证）", () => {
  // 转义器打给 bash -c 走单引号语义，Windows 的 cmd.exe 不是引号语义同族；
  // 真 shell oracle 只在 POSIX 上跑，Windows 格跳过（escaper 的契约面本来就是 POSIX）。
  describe.skipIf(process.platform === "win32")("bash -c printf 往返", () => {
    it("任意不含 NUL/孤立代理项的串，shq 后经 bash 原样还原", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc
            .string({ maxLength: 60 })
            .filter((content) => !content.includes("\u0000") && content.isWellFormed()),
          async (content) => {
            const command = `printf '%s' ${shq(content)}`;
            const restored = await runBash(command);
            assert.equal(restored, content, JSON.stringify({ content, command }));
          },
        ),
        { numRuns: 25 },
      );
    });
  });
});
