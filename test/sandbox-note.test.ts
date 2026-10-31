// lib/sandbox-note.ts：把执行器交回的沙箱事实投影成一句可读后缀。

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ShellSandboxInfo } from "@deepseek-ai/dsh-shell";
import { MESSAGES } from "../lib/messages.ts";
import { sandboxFacts } from "../lib/sandbox-note.ts";

const { zh } = MESSAGES;

/** 运行态数据可能绕过类型交回空白串；这里只造投影层要处理的形状。 */
function infoOf(raw: { mode: string; enforcement?: string }): ShellSandboxInfo {
  return raw as unknown as ShellSandboxInfo;
}

describe("sandboxFacts", () => {
  it("mode 与 enforcement 都齐全时渲染两个字段", () => {
    assert.equal(
      sandboxFacts(infoOf({ mode: "workspace-write", enforcement: "full" }), zh),
      "（沙箱 mode=workspace-write、enforcement=full）",
    );
  });

  it("mode 为空或全空白时用 unknown 占位，不渲染 mode=", () => {
    assert.equal(sandboxFacts(infoOf({ mode: "  " }), zh), "（沙箱 mode=unknown）");
  });

  it("enforcement 只有空白时不渲染该段", () => {
    assert.equal(
      sandboxFacts(infoOf({ mode: "workspace-write", enforcement: " " }), zh),
      "（沙箱 mode=workspace-write）",
    );
  });
});
