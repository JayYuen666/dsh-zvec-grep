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
  clientModeOf,
  DEFAULT_CLIENT_MODE,
  DEFAULT_PREVIEW,
  DEFAULT_REFRESH,
  SYMBOL_TYPE_NAMES,
} from "../lib/cli.ts";
import type { BuiltCommand } from "../lib/cli.ts";
import {
  shq,
  MAX_COMMAND_BYTES,
  MAX_FILTER_CHARS,
  MAX_QUERY_CHARS,
  MAX_QUERY_ROUTES,
  singleOrList,
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

describe("singleOrList", () => {
  it("单值与数组归一到同一结果，缺省空数组", () => {
    assert.deepEqual(singleOrList("src/**", "globs", zhMessages), ["src/**"]);
    assert.deepEqual(singleOrList(["src/**"], "globs", zhMessages), ["src/**"]);
    assert.deepEqual(singleOrList(undefined, "globs", zhMessages), []);
    assert.deepEqual(singleOrList(null, "globs", zhMessages), []);
  });

  it("单值同样走 trim / 去空串 / 长度校验", () => {
    assert.deepEqual(singleOrList("  a  ", "globs", zhMessages), ["a"]);
    assert.deepEqual(singleOrList("   ", "globs", zhMessages), []);
    assert.throws(
      () => singleOrList("g".repeat(MAX_FILTER_CHARS + 1), "globs", zhMessages),
      /globs 超过 \d+ 字符上限/u,
    );
  });

  it("单值里的 NUL 同样报错（单值不是绕过闸门的旁门）", () => {
    assert.throws(() => singleOrList(`a${String.fromCodePoint(0)}b`, "globs", zhMessages), /NUL/u);
  });

  it("非字符串也非数组仍报错", () => {
    assert.throws(() => singleOrList(5, "globs", zhMessages), /必须是字符串数组/u);
  });
});

describe("buildSearchCommand", () => {
  it("最小 query", () => {
    const { command, workdir } = buildSearchCommand({ root: "/ws", query: "hello" }, zhMessages);
    assert.equal(workdir, "/ws");
    assert.equal(
      command,
      "zg query 'hello' --limit 10 --preview short --refresh wait --device 'auto' --mode auto",
    );
  });

  it("query 含引号被安全转义", () => {
    const { command } = buildSearchCommand({ root: "/ws", query: "it's" }, zhMessages);
    assert.equal(
      command,
      String.raw`zg query 'it'\''s' --limit 10 --preview short --refresh wait --device 'auto' --mode auto`,
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
        "--modified-after '2026-01-01' --modified-before '2026-12-31' --device 'auto' --mode auto",
    );
  });

  it("仅 fts 路由也可用", () => {
    const { command } = buildSearchCommand({ root: "/ws", fts: ["needle"] }, zhMessages);
    assert.equal(
      command,
      "zg query --fts 'needle' --limit 10 --preview short --refresh wait --device 'auto' --mode auto",
    );
  });

  it("显式 device 覆盖默认 auto", () => {
    const { command } = buildSearchCommand(
      { root: "/ws", query: "x", device: "metal" },
      zhMessages,
    );
    assert.equal(
      command,
      "zg query 'x' --limit 10 --preview short --refresh wait --device 'metal' --mode auto",
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
      dash.command.endsWith("--mode auto -- '-foo'"),
      `dash 开头 query 走尾部 -- 分隔：${dash.command}`,
    );
    assert.ok(!dash.command.startsWith("zg query '-foo'"), "不再置于头部");
    const normal = buildSearchCommand({ root: "/ws", query: "hello" }, zhMessages);
    assert.ok(normal.command.startsWith("zg query 'hello'"), "正常 query 仍在头部（零回归）");
  });

  it("query 含 NUL 报错", () => {
    assert.throws(
      () => buildSearchCommand({ root: "/ws", query: `a${String.fromCodePoint(0)}b` }, zhMessages),
      /NUL/u,
    );
  });

  // 参数面扩展：preview / refresh / 符号类型闭集 / 路径过滤单值形态。
  it("preview 与 refresh 缺省透传各自缺省档（原先是硬编码 short + wait）", () => {
    const { command } = buildSearchCommand({ root: "/ws", query: "x" }, zhMessages);
    assert.ok(command.includes("--preview short --refresh wait"));
    assert.equal(DEFAULT_PREVIEW, "short");
    assert.equal(DEFAULT_REFRESH, "wait");
  });

  it("preview / refresh 显式取值原样透传（三档全收）", () => {
    for (const preview of ["none", "short", "full"]) {
      for (const refresh of ["background", "wait", "off"]) {
        const { command } = buildSearchCommand(
          { root: "/ws", query: "x", preview, refresh },
          zhMessages,
        );
        assert.ok(command.includes(`--preview ${preview} --refresh ${refresh}`));
      }
    }
  });

  it("preview / refresh 非法取值即报并列出合法档位（绝不静默回落缺省）", () => {
    assert.throws(
      () => buildSearchCommand({ root: "/ws", query: "x", preview: "huge" }, zhMessages),
      /预览档位非法：huge（合法取值：none \| short \| full）/u,
    );
    assert.throws(
      () => buildSearchCommand({ root: "/ws", query: "x", refresh: "later" }, zhMessages),
      /刷新策略非法：later（合法取值：background \| wait \| off）/u,
    );
    // 非字符串同样报错，不当成"没给"。
    assert.throws(
      () => buildSearchCommand({ root: "/ws", query: "x", preview: 3 }, zhMessages),
      /预览档位非法：number/u,
    );
    assert.throws(
      () => buildSearchCommand({ root: "/ws", query: "x", refresh: 3 }, zhMessages),
      /刷新策略非法：number/u,
    );
  });

  it("符号类型绑定 zg 真实闭集：六值全收，闭集外与大小写错配一律即报", () => {
    const all = buildSearchCommand(
      { root: "/ws", query: "x", symbolTypes: SYMBOL_TYPE_NAMES },
      zhMessages,
    ).command;
    for (const name of ["module", "class", "interface", "function", "value", "alias"]) {
      assert.ok(all.includes(`--symbol-type '${name}'`), `缺 ${name}`);
    }
    // zg 侧 `--symbol-type Class` 退出码非零（Unsupported symbol type: Class），
    // 插件在构造阶段就拦，且不把大写折叠成小写——那是替模型改它没写的约束。
    assert.throws(
      () => buildSearchCommand({ root: "/ws", query: "x", symbolTypes: ["Class"] }, zhMessages),
      /符号类型非法：Class（合法取值：module \| class \| interface \| function \| value \| alias，只接受小写）/u,
    );
    assert.throws(
      () => buildSearchCommand({ root: "/ws", query: "x", symbolTypes: ["enum"] }, zhMessages),
      /符号类型非法：enum/u,
    );
    // 闭集大小**不是**条数上限：7 个各自合法的重复值应当照常构造出一条完整命令，
    // 而不是被「最多 6 项」这条指向错误方向的提示挡下。
    const repeated = buildSearchCommand(
      { root: "/ws", query: "x", symbolTypes: Array.from({ length: 7 }, () => "class") },
      zhMessages,
    );
    assert.ok(repeated.command.includes(`--symbol-type 'class'`), "重复的合法取值不该被当成超限");
  });

  it("路径过滤兼容单值与数组两种形态（上游契约是二者的并集）", () => {
    const single = buildSearchCommand(
      { root: "/ws", query: "x", globs: "src/**", insensitiveGlobs: "doc/**", fileTypes: "ts" },
      zhMessages,
    ).command;
    assert.ok(single.includes("--glob 'src/**' --iglob 'doc/**' --type 'ts'"));
    const arrays = buildSearchCommand(
      {
        root: "/ws",
        query: "x",
        globs: ["src/**"],
        insensitiveGlobs: ["doc/**"],
        fileTypes: ["ts"],
      },
      zhMessages,
    ).command;
    assert.equal(single, arrays, "单值与单元素数组必须拼出同一条命令");
  });

  it("路径过滤收单值后，其它类型错误仍照旧报错（不因兼容单值而放宽类型）", () => {
    assert.throws(
      () => buildSearchCommand({ root: "/ws", query: "x", globs: 5 }, zhMessages),
      /必须是字符串数组/u,
    );
    assert.throws(
      () => buildSearchCommand({ root: "/ws", query: "x", globs: { a: 1 } }, zhMessages),
      /必须是字符串数组/u,
    );
    assert.throws(
      () =>
        buildSearchCommand(
          { root: "/ws", query: "x", globs: "g".repeat(MAX_FILTER_CHARS + 1) },
          zhMessages,
        ),
      /globs 超过 \d+ 字符上限/u,
    );
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

/** 穷举通道构造器：固定 root 与缺省 pattern，只让用例改旗标。 */
function built(args: Record<string, unknown>): BuiltCommand {
  return buildSearchCommand(
    { root: "/ws", query: "parseConfig", ...args },
    zhMessages,
    "auto",
    true,
  );
}

describe("穷举词法通道（buildSearchCommand 的 exhaustive 臂）", () => {
  it("缺省构造：--rg + pattern + limit + 设备 + 模式，绝不带索引侧旗标", () => {
    const { command, workdir } = built({});
    assert.equal(workdir, "/ws");
    assert.equal(command, "zg query --rg 'parseConfig' --limit 10 --device 'auto' --mode auto");
  });

  it("pattern 以 '-' 开头走 -e（实测 --rg 自己的约定，不是索引通道那套尾部 --）", () => {
    const { command } = built({ query: "-foo" });
    assert.equal(command, "zg query --rg -e '-foo' --limit 10 --device 'auto' --mode auto");
  });

  it("路径过滤与时间过滤照常透传（实测这四类旗标在 --rg 下均被 zg 接受）", () => {
    const { command } = built({
      globs: ["src/**"],
      insensitiveGlobs: "doc/**",
      fileTypes: "ts",
      excludedFileTypes: ["md"],
      modifiedAfter: "2024-01-01",
      modifiedBefore: "2025-01-01",
    });
    assert.ok(command.includes("--glob 'src/**' --iglob 'doc/**' --type 'ts' --type-not 'md'"));
    assert.ok(command.includes("--modified-after '2024-01-01' --modified-before '2025-01-01'"));
  });

  it("缺 pattern 即报（穷举模式下 query 就是 pattern，没有多路查询组可退）", () => {
    assert.throws(
      () => buildSearchCommand({ root: "/ws" }, zhMessages, "auto", true),
      /穷举检索（rg=true）需要一个 query 作为匹配模式/u,
    );
  });

  it("索引侧旗标逐个即报并点名（不静默丢弃用户给的那一项）", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ fuse: true }, "fuse"],
      [{ queries: ["a"] }, "queries"],
      [{ fts: ["a"] }, "fts"],
      [{ vector: ["a"] }, "vector"],
      [{ preview: "full" }, "preview"],
      [{ refresh: "off" }, "refresh"],
      [{ symbolTypes: ["class"] }, "symbolTypes"],
      [{ preferSymbol: true }, "preferSymbol"],
    ];
    for (const [args, name] of cases) {
      assert.throws(() => built(args), new RegExp(name, "u"), `${name} 应当被点名拒绝`);
    }
  });

  it("多项冲突一次列全，顺序按校验次序固定（模型一轮就能改对）", () => {
    assert.throws(
      () => built({ fuse: true, preview: "none", fts: ["x"] }),
      /穷举检索（rg=true）与下列索引侧参数互斥：fuse \| fts \| preview/u,
    );
  });

  it("英文侧同源（冲突文案把出路也说清）", () => {
    assert.throws(
      () => buildSearchCommand({ root: "/ws", query: "x", fuse: true }, MESSAGES.en, "auto", true),
      /conflicts with these indexed-search parameters: fuse[\s\S]*build an index/u,
    );
  });
});

/** 本包的默认 embedding（与 lib/embedding-catalog.ts 同值；多组用例都要它当基准）。 */
const DEFAULT_EMBEDDING = "local/qwen3-embedding-0.6b";
/** 远程 provider 引用：allowlist 必须拒它，除非部署显式开放。 */
const REMOTE_REFERENCE = "qwen/text-embedding-v4";

describe("buildIndexCommand", () => {
  const DEFAULT = DEFAULT_EMBEDDING;
  // 默认密钥排除 glob 的命令行形态（由 lib/argv-guard.ts 单一来源派生，避免两处硬编码漂移）。
  // 旗标是 --iglob 而非 --glob：大小写不敏感、且排在用户 iglob 之后，理由见 lib/cli.ts 的 pushIndexGlobs。
  const SECRET_ARGS = SECRET_EXCLUDE_GLOBS.map((globStr) => `--iglob '${globStr}'`).join(" ");

  it("最小：root + 默认 embedding + 默认密钥排除", () => {
    const { command, workdir } = buildIndexCommand({ root: "/ws" }, DEFAULT, zhMessages);
    assert.equal(workdir, "/ws");
    assert.equal(
      command,
      `zg index '/ws' --embedding '${DEFAULT}' ${SECRET_ARGS} --device 'auto' --mode auto`,
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
      `zg index '/ws' --embedding 'local/potion-code-16m-v2' ${SECRET_ARGS} --device 'auto' --mode auto`,
    );
  });

  it("excludeSecrets=false 关闭密钥排除", () => {
    const { command } = buildIndexCommand(
      { root: "/ws", excludeSecrets: false },
      DEFAULT,
      zhMessages,
    );
    assert.equal(command, `zg index '/ws' --embedding '${DEFAULT}' --device 'auto' --mode auto`);
    assert.ok(!command.includes(".pem"));
  });

  it("密钥排除以 --iglob 发出：大小写不敏感，且必须排在用户 iglob 之后", () => {
    const { command } = buildIndexCommand(
      { root: "/ws", globs: ["src/**"], insensitiveGlobs: ["**", "DOC/**"] },
      DEFAULT,
      zhMessages,
    );
    // 引擎把全部 --glob 规则排在全部 --iglob 规则之前有序求值。密钥规则若走 --glob，
    // 用户一条宽泛的正向 --iglob 会在其后求值并把无扩展名的 id_rsa* 救回索引（实测）；
    // 走 --iglob 且落在 iglob 段末尾则任何用户正向规则都覆盖不到它。
    const iglobArgs = command.match(/--iglob '[^']*'/gu) ?? [];
    assert.deepEqual(iglobArgs.slice(0, 2), ["--iglob '**'", "--iglob 'DOC/**'"]);
    assert.deepEqual(
      iglobArgs.slice(2),
      SECRET_EXCLUDE_GLOBS.map((globStr) => `--iglob '${globStr}'`),
    );
    // 密钥排除不得再以任何大小写敏感的形式出现。
    assert.ok(!command.includes("--glob '!"));
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
        `${SECRET_ARGS} --hidden --no-ignore --max-depth 2 --max-filesize 1048576 --follow --embedding-concurrency 4 --device 'metal' --mode auto`,
    );
  });

  it("drop 带 --yes 且忽略 embedding/其它选项", () => {
    const { command } = buildIndexCommand(
      { root: "/ws", drop: true, rebuild: true, embedding: "x" },
      DEFAULT,
      zhMessages,
    );
    assert.equal(command, "zg index '/ws' --drop --yes --mode auto");
  });

  it("drop 与 resetPaths 互斥：构造期拒，而不是把 resetPaths 静默丢掉", () => {
    // drop 那一臂只发 `--drop --yes`，任何别的旗标都会消失。resetPaths 若跟着消失，
    // 用户以为清了继承设置，其实那条 zg 只是把索引删了——必须响亮地拒。
    assert.throws(
      () => buildIndexCommand({ root: "/ws", drop: true, resetPaths: true }, DEFAULT, zhMessages),
      /resetPaths/u,
    );
  });

  it("resetPaths=true 透传 --reset-paths，缺省不下发", () => {
    const off = buildIndexCommand({ root: "/ws" }, DEFAULT, zhMessages);
    assert.ok(!off.command.includes("--reset-paths"), "缺省不得凭空带上这个旗标");
    const on = buildIndexCommand({ root: "/ws", resetPaths: true }, DEFAULT, zhMessages);
    // 位置固定在 embedding-concurrency 之后、--device 之前（测试锁死旗标顺序）。
    assert.equal(
      on.command,
      `zg index '/ws' --embedding '${DEFAULT}' ${SECRET_ARGS} --reset-paths --device 'auto' --mode auto`,
    );
  });

  it("resetPaths 与 globs/fileTypes 同传合法（上游语义是先清后盖，不是互斥）", () => {
    // zvec-grep v0.2.2 `resolveIndexRootPaths`：先 resetRootPathFilters，再
    // applyRootPathOverrides。两段都在时表达「清干净再按这次的规则选」。
    const { command } = buildIndexCommand(
      { root: "/ws", resetPaths: true, globs: ["src/**"], fileTypes: ["ts"] },
      DEFAULT,
      zhMessages,
    );
    assert.ok(command.includes("--glob 'src/**'"));
    assert.ok(command.includes("--type 'ts'"));
    assert.ok(command.includes("--reset-paths"));
  });

  it("resetPaths 非布尔按类型错拒（true 之外的真值不算数）", () => {
    assert.throws(
      () => buildIndexCommand({ root: "/ws", resetPaths: "true" }, DEFAULT, zhMessages),
      /resetPaths/u,
    );
  });
});

describe("embedding 构造期 allowlist", () => {
  const DEFAULT = DEFAULT_EMBEDDING;
  const LOCAL = "local/potion-code-16m-v2";

  it("清单内的本地引用照旧透传", () => {
    const { command } = buildIndexCommand({ root: "/ws", embedding: LOCAL }, DEFAULT, zhMessages);
    assert.ok(command.includes(`--embedding '${LOCAL}'`));
  });

  it("缺省 embedding 走设置里的默认值，不受 allowlist 影响", () => {
    const { command } = buildIndexCommand({ root: "/ws" }, DEFAULT, zhMessages);
    assert.ok(command.includes(`--embedding '${DEFAULT}'`));
  });

  it("三类非法引用在构造期就被拒：远程 provider / 不存在的本地模型 / 任意前缀 URL", () => {
    for (const reference of [
      REMOTE_REFERENCE,
      "local/does-not-exist",
      "evil/http://attacker/x",
      "not-a-provider/model",
    ]) {
      assert.throws(
        () => buildIndexCommand({ root: "/ws", embedding: reference }, DEFAULT, zhMessages),
        (error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          assert.match(text, /allowRemoteEmbedding/u, "文案要指向部署开关");
          assert.ok(text.includes(reference), "文案要回显被拒的那个引用");
          return true;
        },
        `${reference} 应当在构造期被拒`,
      );
    }
  });

  it("部署显式开放远程后，同一批引用放行（闸门在部署，不在模型手里）", () => {
    for (const reference of [REMOTE_REFERENCE, "evil/http://attacker/x"]) {
      const { command } = buildIndexCommand(
        { root: "/ws", embedding: reference },
        DEFAULT,
        zhMessages,
        "auto",
        true,
      );
      assert.ok(command.includes(`--embedding '${reference}'`));
    }
  });

  it("密钥与端点**绝不出现在命令行**：构造器没有这两个入参，多余的键被原样忽略", () => {
    // 远程能力走 env（host.ts 的 zgEnv），argv 里出现任何 key/endpoint 都是泄露面。
    // 这三个键刻意**不在** IndexArgs 声明面上：用展开形态传进去（宿主真实形态就是
    // `{ ...args, root }`），既过得了 tsc（多余属性在展开时被忽略），也测得到
    // 「构造器认不出它们，于是原样丢弃」这一层。
    const EXTRA_REMOTE_KEYS = {
      apiKey: "sk-x",
      endpoint: "http://attacker.example",
      allowRemote: true,
    } as const;
    const { command } = buildIndexCommand(
      // 多余的键走宿主真实的展开形态（`{ ...args, root }`）：IndexArgs 的多余属性在
      // TS 里是「展开时忽略」，不是报错，所以这里传得进去、也测得到它们被忽略。
      { root: "/ws", embedding: REMOTE_REFERENCE, ...EXTRA_REMOTE_KEYS },
      DEFAULT,
      zhMessages,
      "auto",
      true,
    );
    assert.ok(!command.includes("sk-x"), "命令行里不得出现 api key");
    assert.ok(!command.includes("attacker.example"), "命令行里不得出现端点");
    assert.ok(!command.includes("--api-key"), "本包不构造 --api-key");
    assert.ok(!command.includes("--endpoint"), "本包不构造 --endpoint");
    assert.ok(!command.includes("--allow-remote"), "授权那一道由 zg 与用户负责，本包不代劳");
  });
});

describe("buildIndexCommand 入参类型错拒（续 buildIndexCommand 组）", () => {
  const DEFAULT = DEFAULT_EMBEDDING;

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

/** 缺省状态命令行：多处断言引用，抽成常量避免硬编码漂移。 */
const STATUS_COMMAND = "zg status '/ws' --mode auto";

describe("buildStatusCommand", () => {
  it("root 位置参数转义", () => {
    const { command, workdir } = buildStatusCommand({ root: "/ws" }, zhMessages);
    assert.equal(workdir, "/ws");
    assert.equal(command, STATUS_COMMAND);
  });

  it("root 含引号转义", () => {
    const { command } = buildStatusCommand({ root: "/a'b" }, zhMessages);
    assert.equal(command, String.raw`zg status '/a'\''b' --mode auto`);
  });

  it("checkReady=true 透传 --check-ready（位置在 root 之后、模式之前）", () => {
    const { command } = buildStatusCommand({ root: "/ws", checkReady: true }, zhMessages);
    assert.equal(command, "zg status '/ws' --check-ready --mode auto");
  });

  it("checkReady 缺省 / 显式 false 都不带该旗标", () => {
    assert.equal(buildStatusCommand({ root: "/ws" }, zhMessages).command, STATUS_COMMAND);
    assert.equal(
      buildStatusCommand({ root: "/ws", checkReady: false }, zhMessages).command,
      STATUS_COMMAND,
    );
  });

  it('checkReady 非布尔即报错（不把 "true" 当真）', () => {
    assert.throws(
      () => buildStatusCommand({ root: "/ws", checkReady: "true" }, zhMessages),
      /必须是布尔值（收到 string）/u,
    );
  });
});

describe("检索追踪开关", () => {
  it("trace=true 透传 --trace，缺省不带", () => {
    const on = buildSearchCommand({ root: "/ws", query: "x", trace: true }, zhMessages).command;
    const off = buildSearchCommand({ root: "/ws", query: "x" }, zhMessages).command;
    assert.ok(on.includes("--trace"), on);
    assert.ok(!off.includes("--trace"), off);
  });

  it("trace 排在 prefer-symbol 之后、时间过滤之前（位置固定）", () => {
    const { command } = buildSearchCommand(
      { root: "/ws", query: "x", trace: true, preferSymbol: true, modifiedAfter: "2024-01-01" },
      zhMessages,
    );
    assert.ok(command.includes("--prefer-symbol --trace --modified-after '2024-01-01'"), command);
  });

  it("穷举模式与 trace 互斥（实测 zg 报 --rg cannot be combined with --trace）", () => {
    assert.throws(
      () => buildSearchCommand({ root: "/ws", query: "x", trace: true }, zhMessages, "auto", true),
      /穷举检索（rg=true）与下列索引侧参数互斥：trace/u,
    );
  });
});

describe("传输模式（缺省自动，三条命令同源）", () => {
  it("缺省值是自动模式", () => {
    assert.equal(DEFAULT_CLIENT_MODE, "auto");
    assert.equal(clientModeOf(undefined, zhMessages), "auto");
    assert.equal(clientModeOf(null, zhMessages), "auto");
  });

  it("域内取值原样放行", () => {
    for (const mode of ["auto", "direct", "server"]) {
      assert.equal(clientModeOf(mode, zhMessages), mode);
    }
  });

  it("域外取值与错类型都报错，绝不静默降级", () => {
    assert.throws(() => clientModeOf("autoo", zhMessages), /传输模式非法/u);
    assert.throws(() => clientModeOf("AUTO", zhMessages), /传输模式非法/u);
    assert.throws(() => clientModeOf(1, zhMessages), /传输模式非法/u);
    assert.throws(() => clientModeOf(true, zhMessages), /传输模式非法/u);
  });

  it("检索 / 索引 / 状态三条命令透传同一个模式", () => {
    for (const mode of ["auto", "direct", "server"] as const) {
      const search = buildSearchCommand({ root: "/ws", query: "q" }, zhMessages, mode);
      const index = buildIndexCommand({ root: "/ws" }, "local/x", zhMessages, mode);
      const drop = buildIndexCommand({ root: "/ws", drop: true }, "local/x", zhMessages, mode);
      const status = buildStatusCommand({ root: "/ws" }, zhMessages, mode);
      for (const command of [search.command, index.command, drop.command, status.command]) {
        assert.ok(command.endsWith(`--mode ${mode}`), `模式未透传到命令：${command}`);
      }
    }
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
    // 上限写数字而不是引常量：这条断言的价值就是把 128 这档闸门钉住。
    // 该数字与 zg 自己对外的路径过滤项上限一致，不是本包自定的数。
    const GREP_ITEM_LIMIT = 128;
    const many = Array.from(
      { length: GREP_ITEM_LIMIT + 1 },
      (_unused, index) => `g${String(index)}`,
    );
    assert.throws(
      () => stringList(many, "globs", zhMessages),
      new RegExp(`globs 最多 ${GREP_ITEM_LIMIT} 项（实际 ${GREP_ITEM_LIMIT + 1}）`, "u"),
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
    // 组数取路由上限、每组顶到单条上限，整条命令必然冲过 MAX_COMMAND_BYTES。
    const routes = Array.from({ length: MAX_QUERY_ROUTES }, () => "z".repeat(MAX_QUERY_CHARS));
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
