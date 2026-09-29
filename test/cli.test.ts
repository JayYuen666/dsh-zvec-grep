// lib/cli.ts 与 lib/argv-guard.ts 的单元测试：转义、根路径/limit/数组校验、三条命令构造。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  assertAbsoluteRoot,
  resolveRoot,
  clampLimit,
  buildSearchCommand,
  buildIndexCommand,
  buildStatusCommand,
} from "../lib/cli.ts";
import {
  shq,
  MAX_COMMAND_BYTES,
  MAX_FILTER_CHARS,
  MAX_QUERY_CHARS,
  MAX_QUERY_ROUTES,
  stringList,
  SECRET_EXCLUDE_GLOBS,
} from "../lib/argv-guard.ts";
import { MESSAGES } from "../lib/messages.ts";

/**
 * 中文消息表：cli 的校验文本按语言由调用点注入（纯函数不读设置，见 lib/cli.ts 头），
 * 本测试直接喂字典——宿主在生产调用点传的是 messagesFor(MESSAGES, locale 偏好)。
 */
const zhMessages = MESSAGES.zh;

describe("shq（POSIX 单引号转义）", () => {
  it("普通字符串原样包单引号", () => {
    assert.equal(shq("hello"), "'hello'");
  });

  it(String.raw`内含单引号转义为 \x27\x27\x27 三段`, () => {
    assert.equal(shq("a'b"), String.raw`'a'\''b'`);
  });

  it("内含空格/美元/反引号不逃逸（单引号内均为字面量）", () => {
    assert.equal(shq("a b$`c"), "'a b$`c'");
  });

  it("空字符串返回空单引号对", () => {
    assert.equal(shq(""), "''");
  });
});

describe("assertAbsoluteRoot", () => {
  it("接受绝对路径", () => {
    assert.equal(assertAbsoluteRoot("/Users/x/repo", zhMessages), "/Users/x/repo");
  });

  it("拒绝空串/非字符串", () => {
    // 空串 = 「没给」→ 必填文案（可省略时回退会话工作区）；
    // 非字符串 = 类型错，点名收到的类型（harness 不校验工具入参，见 cli.ts 头）。
    assert.throws(() => assertAbsoluteRoot("", zhMessages), /root 必填/u);
    assert.throws(() => assertAbsoluteRoot("   ", zhMessages), /root 必填/u);
    assert.throws(
      () => assertAbsoluteRoot(undefined, zhMessages),
      /root 必须是字符串（收到 undefined）/u,
    );
    assert.throws(() => assertAbsoluteRoot(null, zhMessages), /root 必须是字符串（收到 null）/u);
    assert.throws(() => assertAbsoluteRoot(123, zhMessages), /root 必须是字符串（收到 number）/u);
  });

  it("拒绝相对路径", () => {
    assert.throws(() => assertAbsoluteRoot("src/x", zhMessages), /绝对路径/u);
  });

  it("拒绝 NUL 字节", () => {
    assert.throws(() => assertAbsoluteRoot("/a\u0000b", zhMessages), /NUL/u);
  });
});

describe("resolveRoot（0.1.5：root 缺省=会话工作区兜底）", () => {
  it("显式绝对 root 优先", () => {
    assert.equal(resolveRoot("/ws", "/fallback", zhMessages), "/ws");
  });

  it("缺失/空串回退到 fallback（会话工作区）", () => {
    assert.equal(resolveRoot(undefined, "/sess", zhMessages), "/sess");
    assert.equal(resolveRoot("", "/sess", zhMessages), "/sess");
    assert.equal(resolveRoot("   /trim  ", "/sess", zhMessages), "/trim");
  });

  it("fallback 也走绝对路径校验（不无条件接受）", () => {
    assert.throws(() => resolveRoot(undefined, "relative", zhMessages), /绝对路径/u);
    assert.throws(() => resolveRoot(undefined, "/a\u0000b", zhMessages), /NUL/u);
  });

  it("两者都缺 → 报错且提示可省略", () => {
    assert.throws(() => resolveRoot(undefined, undefined, zhMessages), /root 必填/u);
    assert.throws(() => resolveRoot("", "", zhMessages), /可省略/u);
  });
});

describe("clampLimit", () => {
  it("未定义/非法回默认 10", () => {
    assert.equal(clampLimit(undefined), 10);
    assert.equal(clampLimit("x"), 10);
    assert.equal(clampLimit(null), 10);
  });

  it("越界钳到 [1,50]", () => {
    assert.equal(clampLimit(0), 1);
    assert.equal(clampLimit(99), 50);
  });

  it("区间内原样", () => {
    assert.equal(clampLimit(7), 7);
  });

  it("自定义回退值", () => {
    assert.equal(clampLimit(undefined, 20), 20);
  });
});

describe("stringList", () => {
  it("过滤空串并 trim", () => {
    assert.deepEqual(stringList(["a", " b ", "", "c"], "x", zhMessages), ["a", "b", "c"]);
  });

  it("非数组报错", () => {
    assert.throws(() => stringList("a", "x", zhMessages), /字符串数组/u);
  });

  it("NUL 报错", () => {
    assert.throws(() => stringList(["a\u0000b"], "x", zhMessages), /NUL/u);
  });
});

describe("buildSearchCommand", () => {
  it("最小 query", () => {
    const { command, workdir } = buildSearchCommand({ root: "/ws", query: "hello" }, zhMessages);
    assert.equal(workdir, "/ws");
    assert.equal(
      command,
      "zg query 'hello' --limit 10 --preview short --refresh wait --device 'auto' --mode direct",
    );
  });

  it("query 含引号被安全转义", () => {
    const { command } = buildSearchCommand({ root: "/ws", query: "it's" }, zhMessages);
    assert.equal(
      command,
      String.raw`zg query 'it'\''s' --limit 10 --preview short --refresh wait --device 'auto' --mode direct`,
    );
  });

  it("多路由 + 全部标志映射", () => {
    const { command, workdir } = buildSearchCommand(
      {
        root: "/ws",
        query: "hi",
        queries: ["q1", "q2"],
        fts: ["Foo", "Bar"],
        vector: ["sem"],
        fuse: true,
        limit: 3,
        globs: ["src/**"],
        insensitiveGlobs: ["DOC/**"],
        fileTypes: ["ts"],
        excludedFileTypes: ["md"],
        symbolTypes: ["class"],
        preferSymbol: true,
        modifiedAfter: "2026-01-01",
        modifiedBefore: "2026-12-31",
      },
      zhMessages,
    );
    assert.equal(workdir, "/ws");
    assert.equal(
      command,
      "zg query 'hi' --hybrid 'q1' --hybrid 'q2' --fts 'Foo' --fts 'Bar' --vector 'sem' --fuse --limit 3 --preview short --refresh wait " +
        "--glob 'src/**' --iglob 'DOC/**' --type 'ts' --type-not 'md' --symbol-type 'class' --prefer-symbol " +
        "--modified-after '2026-01-01' --modified-before '2026-12-31' --device 'auto' --mode direct",
    );
  });

  it("仅 fts 路由也可用", () => {
    const { command } = buildSearchCommand({ root: "/ws", fts: ["needle"] }, zhMessages);
    assert.equal(
      command,
      "zg query --fts 'needle' --limit 10 --preview short --refresh wait --device 'auto' --mode direct",
    );
  });

  it("显式 device 覆盖默认 auto", () => {
    const { command } = buildSearchCommand(
      { root: "/ws", query: "x", device: "metal" },
      zhMessages,
    );
    assert.equal(
      command,
      "zg query 'x' --limit 10 --preview short --refresh wait --device 'metal' --mode direct",
    );
  });

  it("默认带 --refresh wait 与 --preview short（改完代码免手动 index，且带源码窗口）", () => {
    const { command } = buildSearchCommand({ root: "/ws", query: "x" }, zhMessages);
    assert.match(command, /--refresh wait/u);
    assert.match(command, /--preview short/u);
    assert.match(command, /--device 'auto'/u);
  });

  it("无任何路由报错", () => {
    assert.throws(() => buildSearchCommand({ root: "/ws" }, zhMessages), /至少其一/u);
  });

  it("root 相对路径报错", () => {
    assert.throws(() => buildSearchCommand({ root: "ws", query: "x" }, zhMessages), /绝对路径/u);
  });

  it("query 以 '-' 开头 → 移到命令末尾用 -- 分隔（防 clap 当选项）；正常 query 结构不变", () => {
    const dash = buildSearchCommand({ root: "/ws", query: "-foo" }, zhMessages);
    assert.ok(
      dash.command.endsWith("--mode direct -- '-foo'"),
      `dash 开头 query 走尾部 -- 分隔：${dash.command}`,
    );
    assert.ok(!dash.command.startsWith("zg query '-foo'"), "不再置于头部");
    const normal = buildSearchCommand({ root: "/ws", query: "hello" }, zhMessages);
    assert.ok(normal.command.startsWith("zg query 'hello'"), "正常 query 仍在头部（零回归）");
  });

  it("query 含 NUL 报错", () => {
    assert.throws(() => buildSearchCommand({ root: "/ws", query: "a\u0000b" }, zhMessages), /NUL/u);
  });

  // glob 的 '!' 排除形态：仍是 buildSearchCommand 的入参映射，故归在本套件里
  // （require-top-level-describe 不许文件根上裸着用例；作用域与先后顺序都不变）。
  it("'!' 前缀排除原样透传（上游支持：zg --help 'prefix with ! to exclude'，引擎 matchesOrderedGlobs 有序求值）", () => {
    const { command } = buildSearchCommand(
      {
        root: "/ws",
        query: "x",
        globs: ["src/**", "!dist/**", "!*.pem"],
      },
      zhMessages,
    );
    assert.ok(command.includes("--glob 'src/**'"));
    assert.ok(command.includes("--glob '!dist/**'"));
    assert.ok(command.includes("--glob '!*.pem'"));
  });

  it("纯排除列表（无正向规则）同样透传（引擎 hasPositiveRule=false 时默认全含再排除）", () => {
    const { command } = buildSearchCommand(
      { root: "/ws", query: "x", globs: ["!dist/**"] },
      zhMessages,
    );
    assert.ok(command.includes("--glob '!dist/**'"));
  });
});

describe("buildIndexCommand", () => {
  const DEFAULT = "local/qwen3-embedding-0.6b";
  // 默认密钥排除 glob 的命令行形态（由 lib/cli.ts 单一来源派生，避免两处硬编码漂移）。
  const SECRET_ARGS = SECRET_EXCLUDE_GLOBS.map((globStr) => `--glob '${globStr}'`).join(" ");

  it("最小：root + 默认 embedding + 默认密钥排除", () => {
    const { command, workdir } = buildIndexCommand({ root: "/ws" }, DEFAULT, zhMessages);
    assert.equal(workdir, "/ws");
    assert.equal(
      command,
      `zg index '/ws' --embedding '${DEFAULT}' ${SECRET_ARGS} --device 'auto' --mode direct`,
    );
  });

  it("显式 embedding 覆盖默认", () => {
    const { command } = buildIndexCommand(
      { root: "/ws", embedding: "local/potion-code-16m-v2" },
      DEFAULT,
      zhMessages,
    );
    assert.equal(
      command,
      `zg index '/ws' --embedding 'local/potion-code-16m-v2' ${SECRET_ARGS} --device 'auto' --mode direct`,
    );
  });

  it("excludeSecrets=false 关闭密钥排除", () => {
    const { command } = buildIndexCommand(
      { root: "/ws", excludeSecrets: false },
      DEFAULT,
      zhMessages,
    );
    assert.equal(command, `zg index '/ws' --embedding '${DEFAULT}' --device 'auto' --mode direct`);
    assert.ok(!command.includes(".pem"));
  });

  it("ignoreFiles 透传为 --ignore-file 且转义", () => {
    const { command } = buildIndexCommand(
      { root: "/ws", ignoreFiles: ["/ws/.zgignore", "/a'b/.ign"] },
      DEFAULT,
      zhMessages,
    );
    assert.ok(command.includes(`--ignore-file '/ws/.zgignore'`));
    assert.ok(command.includes(`--ignore-file '/a'\\''b/.ign'`));
  });

  it("rebuild + 文件选择 + 设备/并发", () => {
    const { command } = buildIndexCommand(
      {
        root: "/ws",
        rebuild: true,
        globs: ["src/**"],
        insensitiveGlobs: ["DOC/**"],
        fileTypes: ["ts"],
        excludedFileTypes: ["md"],
        hidden: true,
        noIgnore: true,
        maxDepth: 2,
        maxFileSizeBytes: 1_048_576,
        follow: true,
        embeddingConcurrency: 4,
        device: "metal",
      },
      DEFAULT,
      zhMessages,
    );
    assert.equal(
      command,
      `zg index '/ws' --embedding '${DEFAULT}' --rebuild --glob 'src/**' --iglob 'DOC/**' --type 'ts' --type-not 'md' ` +
        `${SECRET_ARGS} --hidden --no-ignore --max-depth 2 --max-filesize 1048576 --follow --embedding-concurrency 4 --device 'metal' --mode direct`,
    );
  });

  it("drop 带 --yes 且忽略 embedding/其它选项", () => {
    const { command } = buildIndexCommand(
      { root: "/ws", drop: true, rebuild: true, embedding: "x" },
      DEFAULT,
      zhMessages,
    );
    assert.equal(command, "zg index '/ws' --drop --yes --mode direct");
  });

  it("maxDepth 负值报错", () => {
    assert.throws(
      () => buildIndexCommand({ root: "/ws", maxDepth: -1 }, DEFAULT, zhMessages),
      /maxDepth/u,
    );
  });

  it("embeddingConcurrency 为 0 报错", () => {
    assert.throws(
      () => buildIndexCommand({ root: "/ws", embeddingConcurrency: 0 }, DEFAULT, zhMessages),
      /embeddingConcurrency/u,
    );
  });

  it("embedding 含 NUL 报错", () => {
    assert.throws(
      () => buildIndexCommand({ root: "/ws", embedding: "a\u0000b" }, DEFAULT, zhMessages),
      /NUL/u,
    );
  });
});

describe("buildStatusCommand", () => {
  it("root 位置参数转义", () => {
    const { command, workdir } = buildStatusCommand({ root: "/ws" }, zhMessages);
    assert.equal(workdir, "/ws");
    assert.equal(command, "zg status '/ws' --mode direct");
  });

  it("root 含引号转义", () => {
    const { command } = buildStatusCommand({ root: "/a'b" }, zhMessages);
    assert.equal(command, String.raw`zg status '/a'\''b' --mode direct`);
  });
});

describe("入参类型与规模上限（harness 不校验工具入参，全部在这里兜住）", () => {
  const fallback = "local/qwen3-embedding-0.6b";

  it("root 是文件系统根也拒（等于对整个磁盘建索引）", () => {
    assert.throws(() => assertAbsoluteRoot("/", zhMessages), /文件系统根目录/u);
    assert.throws(() => assertAbsoluteRoot("//", zhMessages), /文件系统根目录/u);
  });

  it("标量入参类型错即报，不静默回默认", () => {
    assert.throws(
      () => buildSearchCommand({ root: "/ws", query: 5 }, zhMessages),
      /query 必须是字符串（收到 number）/u,
    );
    assert.throws(
      () => buildIndexCommand({ root: "/ws", embedding: {} }, fallback, zhMessages),
      /embedding 必须是字符串（收到 object）/u,
    );
    assert.throws(
      () => buildSearchCommand({ root: "/ws", query: "x", device: true }, zhMessages),
      /device 必须是字符串/u,
    );
    assert.throws(
      () => buildIndexCommand({ root: "/ws", maxDepth: true }, fallback, zhMessages),
      /maxDepth 必须是 >= 0 的整数（收到 boolean）/u,
    );
  });

  it("数组含非字符串项即报（旧实现静默丢，用户以为过滤生效）", () => {
    assert.throws(
      () => buildSearchCommand({ root: "/ws", query: "x", globs: ["src/**", 5] }, zhMessages),
      /globs 含非字符串项（number）/u,
    );
  });

  it("单条文本超长即报", () => {
    assert.throws(
      () => buildSearchCommand({ root: "/ws", query: "q".repeat(MAX_QUERY_CHARS + 1) }, zhMessages),
      new RegExp(`query 超过 ${MAX_QUERY_CHARS} 字符上限`, "u"),
    );
    assert.throws(
      () =>
        buildSearchCommand(
          { root: "/ws", query: "x", globs: ["g".repeat(MAX_FILTER_CHARS + 1)] },
          zhMessages,
        ),
      new RegExp(`globs 超过 ${MAX_FILTER_CHARS} 字符上限`, "u"),
    );
  });

  it("数组超条数即报", () => {
    // 上限写数字而不是引常量：这条断言的价值就是把 64 这档闸门钉住。
    const GREP_ITEM_LIMIT = 64;
    const many = Array.from(
      { length: GREP_ITEM_LIMIT + 1 },
      (_unused, index) => `g${String(index)}`,
    );
    assert.throws(
      () => stringList(many, "globs", zhMessages),
      new RegExp(`globs 最多 ${GREP_ITEM_LIMIT} 项（实际 65）`, "u"),
    );
  });

  it("检索路由合计超上限即报（单列表各自合法也不行）", () => {
    const routes = Array.from(
      { length: MAX_QUERY_ROUTES },
      (_unused, index) => `r${String(index)}`,
    );
    assert.throws(
      () => buildSearchCommand({ root: "/ws", queries: routes, fts: routes }, zhMessages),
      new RegExp(`超过 ${MAX_QUERY_ROUTES} 组上限`, "u"),
    );
  });

  it("整条命令规模超限即报（防 E2BIG）", () => {
    const routes = Array.from({ length: 10 }, () => "z".repeat(MAX_QUERY_CHARS));
    assert.throws(
      () => buildSearchCommand({ root: "/ws", queries: routes }, zhMessages),
      new RegExp(`超过 ${MAX_COMMAND_BYTES} 字符上限，请缩小检索范围`, "u"),
    );
  });

  it("整数字段接受数字字符串形态（模型常把数字写成字符串）", () => {
    const { command } = buildIndexCommand(
      { root: "/ws", maxDepth: "3", maxFileSizeBytes: "1024", embeddingConcurrency: "2" },
      fallback,
      zhMessages,
    );
    assert.ok(command.includes("--max-depth 3"));
    assert.ok(command.includes("--max-filesize 1024"));
    assert.ok(command.includes("--embedding-concurrency 2"));
    assert.throws(
      () => buildIndexCommand({ root: "/ws", maxDepth: "abc" }, fallback, zhMessages),
      /maxDepth 必须是 >= 0 的整数/u,
    );
  });
});
