// test/client-freshness.ts —— 产物新鲜度指纹门禁（8 包共用，TDD）。
//
// 背景：src/client-entry.ts 改后忘跑 node build-client.mjs，浏览器一直加载旧
// client.js——本会话已两次踩坑（rescue 403 修复没进产物；ctx-observe 字段补齐
// 曾靠人工时间戳核对）。mtime 断言在 git clone / touch 下不稳定，故用
// **内容指纹**：内存构建（buildClient()，纯函数、确定性输出）vs 磁盘
// client.js 逐字节比对。src 任何变更未重建 → 字节必差 → 红。
//
// 用法（各包 test/build-client.test.ts 顶部引入后调用；**必须 await**，理由见那里）：
//   await declareClientFreshness(import.meta.url)   // 自动定位 ../client.js 与 ../build-client.mjs
//
// 注意：buildClient() 必须是确定性构建（同输入同输出）。当前 8 包的
// build-client.mjs 均不含时间戳/随机数（rollup 无 banner hash 变量），
// 逐字节相等成立；若未来构建引入非确定性，改为规范哈希比较并在
// build-client.mjs 里输出 canonical 形态。

import { it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// package.json 与磁盘 client.js 都走 fs/promises：门禁本身因此是 async，调用方在
// 用例文件顶层 `await declareClientFreshness()`——登记时机仍在收集期，用例名与顺序不变。

/** 指纹门禁：磁盘 client.js 必须与最新构建逐字节一致。 */
export async function declareClientFreshness(testFileUrl: string): Promise<void> {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const pkgDir = path.resolve(testDir, "..");
  const pkgJson = await readFile(path.resolve(pkgDir, "package.json"), "utf8");
  const nameMatch = /"name":\s*"(?<pkgName>[^"]+)"/u.exec(pkgJson);
  const pkgName = nameMatch?.groups?.["pkgName"] ?? "unknown";

  it(`${pkgName}: client.js 与最新构建逐字节一致（改 src 后必须 node build-client.mjs）`, async () => {
    // 动态 import 的 .mjs 模块为 any：用类型断言收窄 buildClient 签名（测试
    // 豁免 no-unsafe-type-assertion），避免对 any 的 unsafe 调用/赋值。
    const mod = (await import(path.resolve(pkgDir, "build-client.mjs"))) as {
      buildClient: () => Promise<string>;
    };
    const expected = await mod.buildClient();
    const onDisk = await readFile(path.resolve(pkgDir, "client.js"), "utf8");
    assert.equal(
      onDisk,
      expected,
      onDisk === expected
        ? "fresh"
        : `[${pkgName}] client.js 已过期：src/client-entry.ts（或其依赖）变更后未重建。请运行：cd ${pkgDir} && node build-client.mjs`,
    );
  });
}
