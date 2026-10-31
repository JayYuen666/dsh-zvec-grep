// 生产源码的同步写盘 API 守卫（README 承诺「The package itself writes no files」）。
//
// 为什么要有：oxlint 的 node/no-sync 把写盘那一组（mkdirSync / mkdtempSync / rmSync /
// writeFileSync / chmodSync）只在本仓 oxlint.config.ts 点名的文件里豁免，因此这道门与 lint
// 有一条重叠。它仍然独立存在，因为期望值写死在这里、不从 scope 表派生：将来谁把某枚写侧 API
// 的豁免扩进 lib/ 或 host.ts，lint 会安静下来，这道门照样红。README 承诺「The package itself
// writes no files」，判据就落在这份名单上（测试文件豁免——夹具要在临时目录造文件）。
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";
import assert from "node:assert/strict";

/** 写盘/改元数据的同步 API：期望值独立写死，不从 oxlint.config.ts 的 scope 表派生。 */
const WRITE_APIS: readonly string[] = [
  "mkdirSync",
  "mkdtempSync",
  "rmSync",
  "writeFileSync",
  "chmodSync",
];

/** 生产源码面：测试文件与门禁夹具刻意不在内（它们造夹具是合法的）。 */
const PRODUCTION_DIRS: readonly string[] = ["lib", "src"];
const PRODUCTION_FILES: readonly string[] = ["host.ts"];

/** 递归收集目录下的 .ts 文件（不吞读目录的错：读不到就该红，而不是量出假的干净）。 */
async function tsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return tsFiles(full);
      }
      return entry.name.endsWith(".ts") ? [full] : [];
    }),
  );
  return nested.flat();
}

/** 调用形状：`writeFileSync(` 且不属于更大的标识符（writeFileSyncX、myWriteFileSync）。 */
function writeCallHits(source: string): string[] {
  return WRITE_APIS.filter((api) => new RegExp(`(?<![\\w$])${api}\\s*\\(`, "u").test(source));
}

describe("生产源码不写盘（写侧豁免只落在本仓点名的文件里）", () => {
  it("lib/、src/ 与 host.ts 里不出现写盘 API 的调用形状", async () => {
    const pkgDir = path.resolve(import.meta.dirname, "..");
    const collected = await Promise.all(
      PRODUCTION_DIRS.map((dir) => tsFiles(path.join(pkgDir, dir))),
    );
    const files = [...collected.flat(), ...PRODUCTION_FILES.map((name) => path.join(pkgDir, name))];
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
