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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

const pkgDir = path.join(import.meta.dirname, "..");

/** host 半产物体积预算（取实测值上浮后的整数档）。宿主按包名载入它，这些字节是真实的装载成本。 */
const HOST_BUDGET_BYTES = 240_000;
/** client 半产物体积预算（取实测值上浮后的整数档）。浏览器侧加载，按平台单独计账。 */
// 设置卡迁到 @jayyuen66/dsh-plugin-shared/lib/card-ui 后，卡片样式与组件逻辑随包进
// client.js（实测增加约 9 KB），预算按迁移后的实量重定。
const CLIENT_BUDGET_BYTES = 80_000;

/** 下限：闸门只管「别超」时，构建异常只写出空文件或残片会让 `bytes <= budget` 恒真。
 *  取值远低于当期实测（host.js 227,142 B / client.js 65,390 B），正常演进不会撞到；
 *  撞到它就说明产物不是「变快了」而是「变没了」。 */
const HOST_FLOOR_BYTES = 120_000;
const CLIENT_FLOOR_BYTES = 40_000;

/** 产物文件名与「下限 / 上限」的对照。 */
const BUDGETS: readonly (readonly [string, number, number])[] = [
  ["host.js", HOST_FLOOR_BYTES, HOST_BUDGET_BYTES],
  ["client.js", CLIENT_FLOOR_BYTES, CLIENT_BUDGET_BYTES],
];

describe("产物体积", () => {
  // 用 it.each 而不是手写循环：两条预算断言形状完全相同，手写循环多一层缩进，且新增一条
  // 预算时容易忘了把它塞进某个数组的某个分支里。
  it.each(BUDGETS)("%s 体积落在 %s–%s 字节之间", (file, floor, budget) => {
    const target = path.join(pkgDir, file);
    // 先认「在不在」：缺产物时报的是这条门禁的话，而不是裸 ENOENT 堆栈 ——
    // 后者分不清「没构建」与「构建坏了」，而这两种的下一步动作完全不同。
    assert.ok(
      existsSync(target),
      `${file} 不在包根：这道门比的是已构建产物，先跑本仓的 build（见 README 的开发口径）。`,
    );
    const bytes = readFileSync(target).byteLength;
    assert.ok(
      bytes >= floor,
      `${file} 实测 ${bytes.toLocaleString("en-US")} B，低于下限 ` +
        `${floor.toLocaleString("en-US")} B：产物像是被截断或只剩残片，先确认 build 跑完了。`,
    );
    assert.ok(
      bytes <= budget,
      `${file} 实测 ${bytes.toLocaleString("en-US")} B，超出预算 ` +
        `${budget.toLocaleString("en-US")} B：多半是某个切面塞进了大查表或字面量。` +
        "确属正常演进就改 test/dist-size.test.ts 里对应的预算常量，并写明理由。",
    );
  });
});
