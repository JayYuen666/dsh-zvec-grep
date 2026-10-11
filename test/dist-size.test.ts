// test/dist-size.test.ts —— 产物体积闸门。
//
// 为什么要有：`npm run check` 的顺序是 build 在 test 之前，所以这道门读到的是**当轮刚产出**
// 的产物，不是上一次遗留的。它挡的是「有人往切面里塞进大对象字面量或整段查表」这类回退——
// 体积不是行为，不会让任何现有用例变红，所以必须单独有一把尺子。
//
// 预算怎么定的：取当前实测值上浮约 25%。留这一截是给正常演进的——加一条规则、改一句文案
// 不该立刻逼人来改预算；翻倍一定会顶穿。确属需要突破时，改这些常量并写明理由。
//
// 明确不做的事：**不开 minify**。压缩后产物里的跨包说明符字符串会消失，而
// test/build-host.test.ts 那几条「依赖必须外部化」的断言正是靠检索这些字符串来判的——
// 省下体积的代价是废掉两道真门禁，不划算。
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

const pkgDir = path.join(import.meta.dirname, "..");

/** host 半产物体积预算（实测 190,502 B）。宿主按包名载入它，这些字节是真实的装载成本。 */
const HOST_BUDGET_BYTES = 240_000;
/** client 半产物体积预算（实测 43,134 B）。浏览器侧加载，按平台单独计账。 */
const CLIENT_BUDGET_BYTES = 54_000;

/** 产物文件名与预算的对照。 */
const BUDGETS: readonly (readonly [string, number])[] = [
  ["host.js", HOST_BUDGET_BYTES],
  ["client.js", CLIENT_BUDGET_BYTES],
];

describe("产物体积", () => {
  // 用 it.each 而不是手写循环：两条预算断言形状完全相同，手写循环多一层缩进，且新增一条
  // 预算时容易忘了把它塞进某个数组的某个分支里。
  it.each(BUDGETS)("%s 不超过 %s 字节预算", (file, budget) => {
    const bytes = readFileSync(path.join(pkgDir, file)).byteLength;
    assert.ok(
      bytes <= budget,
      `${file} 实测 ${bytes.toLocaleString("en-US")} B，超出预算 ` +
        `${budget.toLocaleString("en-US")} B：多半是某个切面塞进了大查表或字面量。` +
        "确属正常演进就改 test/dist-size.test.ts 里对应的预算常量，并写明理由。",
    );
  });
});
