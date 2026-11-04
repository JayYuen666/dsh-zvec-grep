// test/host-freshness.test.ts —— 新鲜度夹具自己的形状判据。
//
// 为什么单列：host-freshness.ts 是被各包 build-host.test.ts 使用的**夹具**，
// 它读的是别的包的 build-host.mjs —— builder 交回什么东西，类型面只是断言，运行期什么都可能。
// 缺了这两条判据时，症状是一句与包名无关的 `files.entries is not a function`，
// 或一条看着像「产物过期」的误报红（相对键会按 runner 的 cwd 解析），
// 排查的人会先去查构建，而不是查清单口径。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hostFreshnessEvidence } from "./host-freshness.ts";

/** 夹具包名：写进 manifest、断言 evidence.pkgName、认报错里的身份，三处共用一枚。 */
const FIXTURE_NAME = "@fixture/host-fresh";

/** 单产物分支的正文：builder 交回什么，磁盘上就该躺什么。 */
const INLINE_CODE = "inline-code";

/** 夹具包的 build-host.mjs 实现体：按包根拼路径。 */
type BuilderBody = (pkgDir: string) => string;

/** 两份产物的 builder：键是包根下的绝对路径，正文与落盘内容一致。 */
const twoArtifacts: BuilderBody = (pkgDir) => {
  const root = JSON.stringify(pkgDir);
  return [
    `  const root = ${root};`,
    '  return new Map([[root + "/dist/a.js", "alpha"], [root + "/dist/b.js", "beta"]]);',
  ].join("\n");
};

/**
 * 造一个最小包：`<根>/package.json` + `<根>/build-host.mjs` + `<根>/test/`
 * （evidence 按 `testFileUrl` 的上一级定位包根）。
 * @param body - 写进 build-host.mjs 的 `buildHost` 实现体
 * @returns 包根、一份包内 test 文件的 URL，以及一份清理函数
 */
async function fakePackage(
  body: BuilderBody,
): Promise<{ pkgDir: string; testFileUrl: string; cleanup: () => Promise<void> }> {
  const pkgDir = await mkdtemp(path.join(tmpdir(), "zg-host-fresh-"));
  await mkdir(path.join(pkgDir, "test"), { recursive: true });
  const manifest = JSON.stringify({ name: FIXTURE_NAME, type: "module" }, null, 2);
  await writeFile(path.join(pkgDir, "package.json"), `${manifest}\n`);
  const script = `export function buildHost() {\n${body(pkgDir)}\n}\n`;
  await writeFile(path.join(pkgDir, "build-host.mjs"), script);
  const testFile = path.join(pkgDir, "test", "build-host.test.ts");
  await writeFile(testFile, "");
  return {
    pkgDir,
    testFileUrl: pathToFileURL(testFile).href,
    cleanup: async () => {
      await rm(pkgDir, { recursive: true, force: true });
    },
  };
}

/** 跑一次 evidence，把落下来的错误消息交回去（没抛就是 undefined）。 */
async function messageOf(testFileUrl: string): Promise<string | undefined> {
  let message: string | undefined;
  try {
    await hostFreshnessEvidence(testFileUrl);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  return message;
}

describe("hostFreshnessEvidence：builder 返回值的形状", () => {
  it("既不是字符串也不是 Map ⇒ 点名包与 builder，而不是炸在 entries 上", async () => {
    const pkg = await fakePackage(() => "  return undefined;");
    try {
      const message = await messageOf(pkg.testFileUrl);
      assert.ok(message !== undefined, "必须当场抛错，而不是交回一份说不清的门禁证据");
      assert.ok(message.includes(`[${FIXTURE_NAME}]`), "要认得出是哪个包");
      assert.match(message, /buildHost\(\)/u, "要认得出是哪个 builder");
      assert.match(message, /既不是字符串也不是/u);
    } finally {
      await pkg.cleanup();
    }
  });

  it("键不是绝对路径 ⇒ 点名那枚键", async () => {
    const pkg = await fakePackage(() => '  return new Map([["dist/host.js", "x"]]);');
    try {
      const message = await messageOf(pkg.testFileUrl);
      assert.ok(message !== undefined, "相对键必须报错");
      assert.match(
        message,
        /键不是绝对路径：dist\/host\.js/u,
        "相对键会按 runner 的 cwd 解析，折出来的差异看着像产物过期",
      );
    } finally {
      await pkg.cleanup();
    }
  });

  it("manifest 的 name 坏了 ⇒ 抛错点名目录，不退回 unknown", async () => {
    const pkg = await fakePackage(() => '  return "x";');
    try {
      await writeFile(path.join(pkg.pkgDir, "package.json"), '{"type":"module"}\n');
      const message = await messageOf(pkg.testFileUrl);
      assert.ok(message !== undefined);
      assert.match(message, /name 缺失或不是字符串/u);
      const where = fileURLToPath(pathToFileURL(pkg.pkgDir));
      assert.ok(message.includes(where), "报错要带包根");
    } finally {
      await pkg.cleanup();
    }
  });

  it("字符串形态走单产物分支：读包根那一份产物正文", async () => {
    const pkg = await fakePackage(() => `  return ${JSON.stringify(INLINE_CODE)};`);
    try {
      await writeFile(path.join(pkg.pkgDir, "host.js"), INLINE_CODE);
      const evidence = await hostFreshnessEvidence(pkg.testFileUrl);
      assert.equal(evidence.built, INLINE_CODE);
      assert.equal(evidence.onDisk, INLINE_CODE, "磁盘那一份与构建一致时两侧相等");
      assert.equal(evidence.pkgName, FIXTURE_NAME);
    } finally {
      await pkg.cleanup();
    }
  });

  it("多产物形态折成「相对路径 + 摘要」清单；磁盘侧漂移时两侧不再相等", async () => {
    const pkg = await fakePackage(twoArtifacts);
    try {
      await mkdir(path.join(pkg.pkgDir, "dist"), { recursive: true });
      await writeFile(path.join(pkg.pkgDir, "dist", "a.js"), "alpha");
      await writeFile(path.join(pkg.pkgDir, "dist", "b.js"), "beta");
      const evidence = await hostFreshnessEvidence(pkg.testFileUrl);
      assert.equal(evidence.onDisk, evidence.built, "磁盘与构建一致 ⇒ 两侧清单同字");
      assert.match(evidence.built, /^dist\/a\.js\t/u, "键已相对化且按路径排序");
      // 反向一侧：磁盘正文变了 ⇒ 摘要行不同。少了它，"两侧相等"这条可能只是因为
      // 两边都折成了空清单。
      await writeFile(path.join(pkg.pkgDir, "dist", "a.js"), "stale");
      const drifted = await hostFreshnessEvidence(pkg.testFileUrl);
      assert.notEqual(drifted.onDisk, drifted.built, "磁盘与构建不一致时必须可见");
    } finally {
      await pkg.cleanup();
    }
  });
});
