// lib/daemon-args.ts 的单元测试：SearchArgs → zvec_grep_search MCP 参数的映射纪律。
// 期望值独立写明（按 0.3.0 zvec_grep_search 的 inputSchema 现量），不从被测函数派生。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { daemonSearchArgs } from "../lib/daemon-args.ts";
import { MESSAGES } from "../lib/messages.ts";

const { zh } = MESSAGES;

describe("daemonSearchArgs 的基础映射", () => {
  it("root/limit/preview/query 四位直映，缺省字段不进参数表", () => {
    const args = daemonSearchArgs({ root: "/ws", query: "hello" }, zh);
    assert.deepEqual(args, {
      root: "/ws",
      limit: 10,
      preview: "short",
      query: "hello",
      freshness: "wait_for_fresh",
    });
  });

  it("多组路由：queries/fts/vector 数组原样进同名位；fuse=true 才进", () => {
    const args = daemonSearchArgs(
      { root: "/ws", query: "a", queries: ["b"], fts: ["c"], vector: ["d"], fuse: true },
      zh,
    );
    assert.deepEqual(args["queries"], ["b"]);
    assert.deepEqual(args["fts"], ["c"]);
    assert.deepEqual(args["vector"], ["d"]);
    assert.equal(args["fuse"], true);
    const noFuse = daemonSearchArgs({ root: "/ws", query: "a" }, zh);
    assert.equal("fuse" in noFuse, false, "fuse 缺省不得凭空出现");
  });
});

describe("daemonSearchArgs 的 preview 降级（MCP 面只有 short|full）", () => {
  it("none→short、short→short、full→full、detail→full", () => {
    for (const [given, expected] of [
      ["none", "short"],
      ["short", "short"],
      ["full", "full"],
      ["detail", "full"],
    ] as const) {
      const args = daemonSearchArgs({ root: "/ws", preview: given }, zh);
      assert.equal(args["preview"], expected, `${given} → ${expected}`);
    }
    assert.throws(() => daemonSearchArgs({ root: "/ws", preview: "huge" }, zh), /预览档位非法/u);
  });
});

describe("daemonSearchArgs 的 refresh 映射", () => {
  it("wait→wait_for_fresh；off→eventual；background→eventual+autoUpdate", () => {
    assert.equal(
      daemonSearchArgs({ root: "/ws", refresh: "wait" }, zh)["freshness"],
      "wait_for_fresh",
    );
    const off = daemonSearchArgs({ root: "/ws", refresh: "off" }, zh);
    assert.equal(off["freshness"], "eventual");
    assert.equal(
      off["autoUpdate"],
      false,
      "MCP 缺省 autoUpdate=true，off 必须显式 false（上游 zg-transport-mcp 的 SearchInput）",
    );
    const bg = daemonSearchArgs({ root: "/ws", refresh: "background" }, zh);
    assert.equal(bg["freshness"], "eventual");
    assert.equal(bg["autoUpdate"], true);
  });
});

describe("daemonSearchArgs 的过滤族映射", () => {
  it("globs/insensitiveGlobs/fileTypes 原样同名映射（SearchInput.file_types 与 CLI --type 同义）", () => {
    const args = daemonSearchArgs(
      {
        root: "/ws",
        globs: ["src/**"],
        insensitiveGlobs: "doc/**",
        fileTypes: ["ts"],
        excludedFileTypes: ["md"],
      },
      zh,
    );
    assert.deepEqual(args["globs"], ["src/**"]);
    assert.deepEqual(args["insensitiveGlobs"], ["doc/**"]);
    assert.deepEqual(
      args["fileTypes"],
      ["ts"],
      "SearchInput.file_types 上游原文：ripgrep type names",
    );
    assert.deepEqual(args["excludedFileTypes"], ["md"]);
    assert.equal(
      "includedFormats" in args,
      false,
      "includedFormats 是文件名推断格式维度，与本参数无关",
    );
  });

  it("category→categories、categoryNot→excludedCategories", () => {
    const args = daemonSearchArgs({ root: "/ws", category: "code", categoryNot: ["config"] }, zh);
    assert.deepEqual(args["categories"], ["code"]);
    assert.deepEqual(args["excludedCategories"], ["config"]);
  });

  it("符号/时间/trace 各就各位；空缺省不进参数表", () => {
    const args = daemonSearchArgs(
      {
        root: "/ws",
        symbolTypes: ["class"],
        preferSymbol: true,
        trace: true,
        modifiedAfter: "2024-01-01",
        modifiedBefore: "2025-01-01",
      },
      zh,
    );
    assert.deepEqual(args["symbolTypes"], ["class"]);
    assert.equal(args["preferSymbol"], true);
    assert.equal(args["trace"], true);
    assert.equal(args["modifiedAfter"], "2024-01-01");
    assert.equal(args["modifiedBefore"], "2025-01-01");
    const bare = daemonSearchArgs({ root: "/ws" }, zh);
    for (const key of [
      "symbolTypes",
      "preferSymbol",
      "trace",
      "modifiedAfter",
      "modifiedBefore",
      "globs",
    ]) {
      assert.equal(key in bare, false, `${key} 缺省不得凭空出现`);
    }
  });

  it("类型错照旧报错（同一批取值器，绝不静默降级）", () => {
    assert.throws(
      () => daemonSearchArgs({ root: "/ws", globs: 5 }, zh),
      /必须是字符串或字符串数组/u,
    );
    assert.throws(() => daemonSearchArgs({ root: "/ws", limit: "9" }, zh), /limit/u);
    assert.throws(() => daemonSearchArgs({ root: "/ws", fts: [5] }, zh), /非字符串项/u);
  });
});

describe("daemonSearchArgs 的取值上限与 CLI 同源", () => {
  it("symbolTypes 逐项校闭集：大小写错配与未知值在构造期就拒", () => {
    assert.throws(
      () => daemonSearchArgs({ root: "/ws", symbolTypes: ["Class"] }, zh),
      /符号类型非法：Class/u,
    );
    assert.throws(
      () => daemonSearchArgs({ root: "/ws", symbolTypes: ["nope"] }, zh),
      /符号类型非法：nope/u,
    );
  });

  it("symbolTypes 条数上限 7（上游 MCP maxItems），7 收 8 拒", () => {
    const seven = Array.from({ length: 7 }).fill("class");
    assert.deepEqual(
      daemonSearchArgs({ root: "/ws", symbolTypes: seven }, zh)["symbolTypes"],
      seven,
    );
    assert.throws(
      () =>
        daemonSearchArgs({ root: "/ws", symbolTypes: Array.from({ length: 8 }).fill("class") }, zh),
      /symbolTypes 最多 7 项（实际 8）/u,
    );
  });

  it("时间过滤串上限 128 字符（上游 MCP TimeInput），128 收 129 拒", () => {
    assert.equal(
      daemonSearchArgs({ root: "/ws", modifiedAfter: "2".repeat(128) }, zh)["modifiedAfter"],
      "2".repeat(128),
    );
    assert.throws(
      () => daemonSearchArgs({ root: "/ws", modifiedAfter: "2".repeat(129) }, zh),
      /modifiedAfter 超过 128 字符上限（实际 129）/u,
    );
  });
});

describe("daemonSearchArgs 的 device 拒绝", () => {
  it("显式 device 在 MCP lane 被点名拒绝（daemon 检索面没有这一位）", () => {
    assert.throws(
      () => daemonSearchArgs({ root: "/ws", device: "metal" }, zh),
      /device 参数仅 CLI 传输消费/u,
    );
  });
});
