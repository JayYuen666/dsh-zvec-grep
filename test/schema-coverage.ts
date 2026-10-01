// test/schema-coverage.ts —— 卡片字段覆盖门禁（多包共用，复制式分发，同 client-freshness.ts）。
//
// 背景：host.ts 导出的 Config 里标了 `.volatile()` 的字段会被宿主投影成设置表单
// （0.1.7 起隐式注册：命名空间 = profile 条目 id，旧的 `settings.register(ns, schema, base)`
// 三面已删），于是可能出现 N 个可配字段里 client 卡片只渲染 M 个（M < N）——那 N-M 个
// 字段用户无法从 UI 触及，只能改 settings 底层或读源码。曾踩过的坑：quality-gate 的
// `memoryFeedback`（功能性开关——当时 host.ts 用 `if (cfg.memoryFeedback !== false)`
// 决定是否把门禁失败写入记忆库，且有专门测试）在卡片
// 漏项，反复审查后才被发现。
//
// 做法：解析 host.ts 的 Schema.object 字段名 + client 源码树（src/** + lib/**）实际绑定的
// 字段名，断言后者 ⊇ 前者。漏项必须显式列入 allowUnbound 并给理由——测试同时校验
// allowUnbound 里的每一项确实未被绑定（防止"挂名豁免"绕过门禁）。
//
// 用法（各包 test/build-client.test.ts 或独立 spec 顶部调用一次；**必须 await**，理由见
// test/client-freshness.ts 的头注释与本包 build-client.test.ts 的调用点）：
//   await declareSchemaCoverage(import.meta.url)
//   await declareSchemaCoverage(import.meta.url, {
//     allowUnbound: [{ field: 'x', reason: '仅 CLI 侧使用，UI 无入口' }],
//   })
//
// 注意：绑定识别是"出现即算绑定"的宽松启发式（见 isBoundField），假阳性只会让门禁
// 更宽松（不会假绿漏拦功能性缺失）；假阴性会立刻报错，故宁可宽不可严。

import { it } from "vitest";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// host/client 源码与 package.json 的读取走 fs/promises（门禁因此是 async）。旧的
// readFileSync/statSync/existsSync 形态在 node/no-sync 里有只读豁免，但用例文件顶层那次
// 裸调用会被 vitest/require-hook 判成 setup：改成 await 调用后登记时机仍在收集期，
// 用例名与顺序都不变。

export interface AllowUnbound {
  field: string;
  reason: string;
}

/** 从 host.ts 抽取 `Schema.object({...})` 块内的字段名。 */
function hostSchemaFields(hostTs: string): string[] {
  const marker = "Schema.object(";
  const start = hostTs.indexOf(marker);
  if (start === -1) {
    return [];
  }
  // 从 Schema.object( 的左括号起做深度匹配，取到对应右括号
  const open = hostTs.indexOf("(", start);
  if (open === -1) {
    return [];
  }
  let depth = 0;
  let end = -1;
  for (let i = open; i < hostTs.length; i += 1) {
    const ch = hostTs[i];
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    return [];
  }
  const block = hostTs.slice(open + 1, end);
  return [...block.matchAll(/^(?:\s{2,})(?<name>[A-Za-z_$][\w$]*):\s*Schema\./gmu)].map(
    (match) => match.groups?.["name"] ?? "",
  );
}

/** 扫描一个 client 源文件，收集作为「设置写入第一参」出现的字段名字面量。 */
function boundFieldsIn(src: string): Set<string> {
  const out = new Set<string>();
  // 输入行组件的 field prop：field: 'x'
  for (const match of src.matchAll(/\bfield\s*:\s*["'](?<name>[A-Za-z_$][\w$]*)["']/gu)) {
    const field = match.groups?.["name"];
    if (field !== undefined) {
      out.add(field);
    }
  }
  // 各种写入惯用法：props.set('x' / set('x' / unset('x' / fireAndForget('x' / writeSet('x'
  //   刻意不要求限定 receiver——各包惯用法不同（props.set / fireAndForget / writer.set），
  //   收得太紧会假阴性。字段名是否算"绑定"由 declareSchemaCoverage 与 host 字段名交集判定。
  for (const match of src.matchAll(
    /\b(?:set|unset|fireAndForget|writeSet|commit)\s*\(\s*["'](?<name>[A-Za-z_$][\w$]*)["']/gu,
  )) {
    const field = match.groups?.["name"];
    if (field !== undefined) {
      out.add(field);
    }
  }
  return out;
}

/** 递归收集目录下所有 .ts 源文件文本（跳过 node_modules）。 */
async function walk(dir: string): Promise<string[]> {
  // fs/promises 没有 existsSync：目录不存在时 readdir 抛 ENOENT，捕获它即等价于旧的
  // `if (!existsSync(dir)) return out`（只吞掉"不存在"，其它错误继续抛出，语义不变）。
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  // 逐项并行 stat/read：no-await-in-loop 的官方口径是 Promise.all 收集，而非循环里串行 await。
  // 结果在 clientBoundFields 里汇入 Set，读取顺序不影响门禁判定，故并行化不改语义。
  const chunks = await Promise.all(
    entries
      .filter((entry) => entry !== "node_modules" && entry !== "test")
      .map(async (entry): Promise<string[]> => {
        const fullPath = path.join(dir, entry);
        const state = await stat(fullPath);
        if (state.isDirectory()) {
          return walk(fullPath);
        }
        if (entry.endsWith(".ts")) {
          return [await readFile(fullPath, "utf8")];
        }
        return [];
      }),
  );
  return chunks.flat();
}

/** client 侧实际绑定的字段名集合（src/** + lib/** + client-entry 同级单文件）。 */
async function clientBoundFields(pkgDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const sources = [
    ...(await walk(path.join(pkgDir, "src"))),
    ...(await walk(path.join(pkgDir, "lib"))),
  ];
  for (const src of sources) {
    for (const field of boundFieldsIn(src)) {
      out.add(field);
    }
  }
  return out;
}

/** 声明「卡片字段覆盖 host schema」门禁。 */
export async function declareSchemaCoverage(
  testFileUrl: string,
  opts: { allowUnbound?: AllowUnbound[] } = {},
): Promise<void> {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const pkgDir = path.resolve(testDir, "..");
  const pkgJson = await readFile(path.resolve(pkgDir, "package.json"), "utf8");
  const nameMatch = /"name":\s*"(?<name>[^"]+)"/u.exec(pkgJson);
  const pkgName = nameMatch?.groups?.["name"] ?? "unknown";
  const hostTs = await readFile(path.resolve(pkgDir, "host.ts"), "utf8");
  const hostFields = hostSchemaFields(hostTs);
  const bound = await clientBoundFields(pkgDir);
  const exemptions = new Map((opts.allowUnbound ?? []).map((x) => [x.field, x.reason]));

  it(`${pkgName}: 卡片覆盖 host schema 全部字段（改 host 字段必须同步卡片或声明豁免）`, () => {
    assert.ok(hostFields.length > 0, "host.ts 未找到 Schema.object 字段（解析失败或该包无设置）");
    const missing = hostFields.filter((field) => !bound.has(field));
    const unexempted = missing.filter((field) => !exemptions.has(field));
    assert.deepEqual(
      unexempted,
      [],
      `[${pkgName}] 以下 host 设置字段卡片未暴露：${unexempted.join(", ")}\n` +
        `host 字段全集：${hostFields.join(", ")}\n` +
        `卡片已绑定：${[...bound].join(", ")}\n` +
        `→ 补卡片控件；若确实不该有 UI 入口，在 declareSchemaCoverage 的 allowUnbound 里\n` +
        `  显式声明 { field, reason }（测试会校验被豁免项确实未绑定，防止挂名豁免）。`,
    );
    // 反向校验：豁免项若其实已绑定，说明豁免过时——删除即可，留着会让门禁失效。
    const stale = [...exemptions].filter(([field]) => bound.has(field));
    assert.deepEqual(
      stale,
      [],
      `[${pkgName}] allowUnbound 已过时——这些字段其实已绑定，请删除豁免声明：${stale.map(([field, reason]) => `${field}（${reason}）`).join(", ")}`,
    );
    // 豁免必须有理由，否则等于无门禁。
    const noReason = [...exemptions].filter(
      ([, reason]) => typeof reason !== "string" || reason.trim().length === 0,
    );
    assert.deepEqual(
      noReason,
      [],
      `[${pkgName}] allowUnbound 项缺少 reason：${noReason.map(([field]) => field).join(", ")}`,
    );
  });
}
