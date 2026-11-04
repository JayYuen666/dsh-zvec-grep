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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 登记是同步操作：package.json 走同步读，`it()` 之前没有 await，所以调用方漏写 `await`
// 也不会把这条门禁弄丢（实测两种写法都登记、都跑）。函数本身仍保持 async —— 那一条
// 理由见下面 declareClientFreshness 上方的注释。

/** 产物摘要：失败信息只给长度 + 哈希前 12 位，不把数百 KB 正文塞进报告。 */
function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

/**
 * 指纹门禁：磁盘 client.js 必须与最新构建逐字节一致。
 *
 * 失败信息走摘要（长度 + sha256）而不是整份产物 diff：两段文本的 assert.equal
 * 会把数百 KB 的产物正文塞进报告，CI 日志被淹没且难以定位。
 */
// 保持 async（尽管内部全是同步读）：登记写法必须走「顶层 await」这一 require-hook
// 认可的形态（见 build-client.test.ts 的登记段注释）；裸同步调用会被判成 setup 没进 hook。
export async function declareClientFreshness(testFileUrl: string): Promise<void> {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const pkgDir = path.resolve(testDir, "..");
  // 同步读 manifest：登记因此是同步操作，不存在「忘记 await」这一失败面。
  // name 用 JSON.parse 读顶层字段——正则抠第一处 "name": 会命中嵌套对象里的同名键。
  const manifest = JSON.parse(readFileSync(path.resolve(pkgDir, "package.json"), "utf8")) as {
    name?: unknown;
  };
  const { name } = manifest;
  if (typeof name !== "string" || name === "") {
    throw new Error(`[${pkgDir}] package.json 的 name 缺失或不是字符串，指纹门禁无从标身份`);
  }
  const pkgName: string = name;

  it(
    `${pkgName}: client.js 与最新构建逐字节一致（改 src 后必须 node build-client.mjs）`,
    { timeout: 30_000 },
    async () => {
      // 动态 import 的 .mjs 模块为 any：用类型断言收窄 buildClient 签名（测试
      // 豁免 no-unsafe-type-assertion），避免对 any 的 unsafe 调用/赋值。
      // 载入失败带上下文：报错点在「请先构建」，而不是裸 ENOENT。
      let mod: { buildClient?: unknown };
      try {
        mod = (await import(pathToFileURL(path.resolve(pkgDir, "build-client.mjs")).href)) as {
          buildClient?: unknown;
        };
      } catch (error: unknown) {
        throw new Error(
          `[${pkgName}] 无法载入 build-client.mjs：${path.resolve(pkgDir, "build-client.mjs")}`,
          { cause: error },
        );
      }
      if (typeof mod.buildClient !== "function") {
        throw new TypeError(`[${pkgName}] build-client.mjs 没有可调用的 buildClient 导出`);
      }
      const build = mod.buildClient as () => Promise<string>;
      let expected: string;
      try {
        expected = await build();
      } catch (error: unknown) {
        throw new Error(`[${pkgName}] buildClient() 构建失败：先让构建本身过，再谈产物新鲜度`, {
          cause: error,
        });
      }
      const onDiskPath = path.resolve(pkgDir, "client.js");
      let onDisk: string;
      try {
        onDisk = await readFile(onDiskPath, "utf8");
      } catch (error: unknown) {
        throw new Error(
          `[${pkgName}] client.js 不存在：这道门读的是 build 的产出，请先运行 node build-client.mjs`,
          { cause: error },
        );
      }
      if (onDisk === expected) {
        return;
      }
      assert.equal(
        `${onDisk.length}/${digestOf(onDisk)}`,
        `${expected.length}/${digestOf(expected)}`,
        `[${pkgName}] client.js 已过期：src/client-entry.ts（或其依赖）变更后未重建。请运行：cd ${pkgDir} && node build-client.mjs`,
      );
    },
  );
}
