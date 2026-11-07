// 生产源码的同步写盘 API 守卫（README 承诺「The package itself writes no files」）。
//
// 为什么要有：oxlint 的 node/no-sync 把写盘那一组（mkdirSync / mkdtempSync / rmSync /
// writeFileSync / chmodSync）只在本仓 oxlint.config.ts 点名的文件里豁免，因此这道门与 lint
// 有一条重叠。它仍然独立存在，因为期望值写死在这里、不从 scope 表派生：将来谁把某枚写侧 API
// 的豁免扩进 lib/ 或 host.ts，lint 会安静下来，这道门照样红。README 承诺「The package itself
// writes no files」，判据就落在这份名单上（测试文件豁免——夹具要在临时目录造文件）。
//
// 收集器与调用形状在 test/sync-write-support.ts（探测要驱动同一份实现）。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { sourceFiles, writeCallHits } from "./sync-write-support.ts";

/** 生产源码面：测试文件与门禁夹具刻意不在内（它们造夹具是合法的）。 */
const PRODUCTION_DIRS: readonly string[] = ["lib", "src"];
const PRODUCTION_FILES: readonly string[] = ["host.ts"];

/**
 * 健全性判据的期望值：几枚**独立写死**的生产文件名。
 * 没有这一条，`lib/` 与 `src/` 一旦被裁空（或源码挪去别的扩展名/别的目录），
 * 收集范围就只剩 host.ts，而 `offenders === []` 照样成立——空集不打 ✓。
 */
const REQUIRED_PRODUCTION: readonly string[] = [
  "host.ts",
  "lib/messages.ts",
  "lib/rebuild-shape.ts",
  "src/ui-messages.ts",
  "src/client-entry.ts",
];

describe("生产源码不写盘（写侧豁免只落在本仓点名的文件里）", () => {
  it("lib/、src/ 与 host.ts 里不出现写盘 API 的调用形状", async () => {
    const pkgDir = path.resolve(import.meta.dirname, "..");
    const collected = await Promise.all(
      PRODUCTION_DIRS.map((dir) => sourceFiles(path.join(pkgDir, dir))),
    );
    const files = [...collected.flat(), ...PRODUCTION_FILES.map((name) => path.join(pkgDir, name))];
    const seen = new Set(
      files.map((file) => path.relative(pkgDir, file).split(path.sep).join("/")),
    );
    for (const required of REQUIRED_PRODUCTION) {
      assert.ok(
        seen.has(required),
        `收集面里没有 ${required}：这道门在扫什么？（pkgDir=${pkgDir}）`,
      );
    }
    const sources = await Promise.all(
      files.map(async (file) => [file, await readFile(file, "utf8")] as const),
    );
    const offenders = sources
      .map(([file, source]) => {
        const hits = writeCallHits(source);
        return hits.length > 0 ? `${path.relative(pkgDir, file)}: ${hits.join(", ")}` : "";
      })
      .filter((entry) => entry !== "");
    assert.deepEqual(
      offenders,
      [],
      "生产源码不得调用写盘同步 API（README 承诺包内不写盘）；确有需要先在 oxlint.config.ts 的 syncIoScopes 里按文件登记并说明理由",
    );
  });
});
