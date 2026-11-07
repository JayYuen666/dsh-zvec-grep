// 卡片轮询生命周期的源码结构门禁（无 DOM 渲染器时的最小可复跑判据）。
//
// 为什么不是行为用例：本仓 devDependencies 没有 react-dom / jsdom / react-test-renderer，
// 为一条清理判据引入整套 DOM 垫片不划算。这里钉的是实现必须保留的三处结构；真正的
// 浏览器观测（开卡→重建→关页后不再打 status）不在本文件覆盖范围内，结论中会如实标注。
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import assert from "node:assert/strict";

const source = readFileSync(path.resolve(import.meta.dirname, "../src/client-entry.ts"), "utf8");

/** 去掉空白后比对，避免缩进/换行让结构门禁变成排版门禁。 */
const compact = (text: string): string => text.replaceAll(/\s+/gu, "");

describe("卡片轮询的卸载与在途守卫", () => {
  it("卸载 cleanup 同时落挂载位并停轮询", () => {
    assert.ok(
      compact(source).includes(compact("mountedRef.current = false; stopPolling();")),
      "useEffect 的 cleanup 必须同时把 mountedRef 置假并清掉 interval",
    );
  });

  it("在途应答写入 state 前先判挂载与会话代次", () => {
    const body = compact(source);
    assert.ok(
      body.includes(compact("if (!isMounted() || jobRef.current !== jobId) { return; }")),
      "await 回来后必须先判挂载与 jobId 代次，再写板/停轮询",
    );
    assert.ok(
      body.includes(
        compact("if (pollingRef.current || !isMounted() || jobRef.current !== jobId) { return; }"),
      ),
      "进入 pollStatus 时必须有在途守卫，避免慢响应叠发",
    );
  });

  it("stopPolling 清 interval 并作废代次", () => {
    const body = compact(source);
    assert.ok(body.includes(compact("jobRef.current = null;")), "停轮询必须作废旧 jobId");
    assert.ok(
      body.includes(compact("clearInterval(pollRef.current);")),
      "停轮询必须真的 clearInterval",
    );
  });
});
