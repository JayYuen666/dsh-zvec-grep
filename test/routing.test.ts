// lib/routing.ts 单元测试：systemPrompt 规则段常量 + zgGuard 安全兜底谓词 +
// search-first 门禁的编排（索引根发现/额度扣减/拦截文案）。
// 门禁的三条判据（命令文本 / 目标路径 / 解锁额度）住在 lib/search-predicates.ts，本文件
// 从那里直接取用——用例逐条照旧，只是 import 跟着拆分走（断言一字未改）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  ROUTING_NAME,
  ROUTING_ORDER,
  zgGuard,
  findIndexRoot,
  searchFirstGuard,
  MAX_PARENT_WALK,
  rootSessionKeyOf,
  sessionKeyOf,
  DEFAULT_GREP_BUDGET,
  DEFAULT_UNLOCK_WINDOW_MIN,
  INDEX_DIR_NAME,
  WORKSPACE_MANIFEST_FILE,
} from "../lib/routing.ts";
import type { GuardExecution, SearchFirstDeps } from "../lib/routing.ts";
import {
  isGrepRgCommand,
  normalizeRoot,
  pathInsideRoot,
  hasExternalTarget,
  unlockActive,
} from "../lib/search-predicates.ts";
import type { SearchUnlock } from "../lib/search-predicates.ts";
import { MESSAGES } from "../lib/messages.ts";

/**
 * 中文消息表：guard 拒绝理由与规则段的文本按语言由调用点注入（纯函数不读设置），
 * 本测试直接喂字典；宿主在生产调用点传 messagesFor(MESSAGES, locale 偏好)。
 */
const zhMessages = MESSAGES.zh;

/**
 * 期望的索引库目录名：本文件把它与 `INDEX_DIR_NAME` 对撞的那条断言，以及「规则文本里
 * 提到了这个目录」的两条 includes，都按这一串查。**故意不引** lib/routing.ts 的常量——
 * 引过来就等于让常量自己给自己作证，改名再也不会红。
 */
const EXPECTED_INDEX_DIR = ".zvec-grep";
/** workspace manifest 文件名：同上，故意不引生产常量。 */
const EXPECTED_MANIFEST_FILE = "manifest.json";

/**
 * 索引根（`"/repo"`）之下的子目录：会话工作区开在子包、索引建在仓库根的形态，
 * 门禁必须向上走才拦得到。
 */
const INDEXED_SUBDIR = "/repo/packages/app";

describe("ROUTING 常量", () => {
  it("order 落在 grep(1500) 与 jobs(1600) 之间", () => {
    assert.equal(ROUTING_ORDER, 1550);
  });

  it("name 唯一且非空", () => {
    assert.equal(ROUTING_NAME, "zvec-grep-routing");
  });

  it("规则文本包含关键路由指令（中文一份）", () => {
    assert.ok(zhMessages.routingText.includes("zg_search"));
    assert.ok(zhMessages.routingText.includes("grep"));
    assert.ok(zhMessages.routingText.includes("zg_index"));
    assert.ok(zhMessages.routingText.includes("confirm"));
    // search-first 规则：已建索引工作区先 zg_search 再 grep/rg（硬门禁提示）
    assert.ok(zhMessages.routingText.includes(EXPECTED_INDEX_DIR));
    assert.ok(zhMessages.routingText.includes("先调用 zg_search"));
  });

  it("英文偏好下规则文本仍是同一套指令（两语同源、只剩措辞不同）", () => {
    const en = MESSAGES.en.routingText;
    for (const token of [
      "zg_search",
      "zg_index",
      "zg_status",
      "grep",
      "confirm",
      EXPECTED_INDEX_DIR,
    ]) {
      assert.ok(en.includes(token), `en 规则文本缺 ${token}`);
    }
    assert.ok(en.includes("must call zg_search first"), "en 版给出同一条硬规则");
    assert.doesNotMatch(en, /[一-龥]/u, "en 版不得残留中文");
  });

  // 「恰好三工具」这一钉原来在本文件（直接摊开 lib 的 ZG_TOOLS 常量比一遍）。常量已不外露
  // ——guard 侧的名单自己给自己作证，改名只会让两边一起红。注册名由 test/host.test.ts 的
  // 「注册 3 个工具」用例从 ctx 的注册轨迹上钉，那才是模型真正拿得到的东西。
});

describe("zgGuard", () => {
  it("非 zg_* 工具一律放行", () => {
    assert.equal(zgGuard({ name: "grep", arguments: {} }, zhMessages), undefined);
    assert.equal(zgGuard({ name: "read", arguments: { root: "x" } }, zhMessages), undefined);
    assert.equal(zgGuard({ name: undefined, arguments: {} }, zhMessages), undefined);
  });

  it("zg_index 缺 confirm=true 拒绝", () => {
    const reason = zgGuard({ name: "zg_index", arguments: { root: "/ws" } }, zhMessages);
    assert.equal(reason?.includes("confirm"), true);
  });

  it("zg_index confirm=false 拒绝", () => {
    const reason = zgGuard(
      { name: "zg_index", arguments: { root: "/ws", confirm: false } },
      zhMessages,
    );
    assert.equal(reason?.includes("confirm"), true);
  });

  it("zg_index confirm=true + 绝对 root 放行", () => {
    assert.equal(
      zgGuard({ name: "zg_index", arguments: { root: "/ws", confirm: true } }, zhMessages),
      undefined,
    );
  });

  it("zg_search 缺 root 且无会话工作区 → 拒绝", () => {
    const reason = zgGuard({ name: "zg_search", arguments: {} }, zhMessages);
    assert.equal(reason?.includes("root"), true);
  });

  it("zg_search 缺 root 但有会话工作区 → 放行（0.1.5 agent 面兜底）", () => {
    const agent = { session: { header: { cwd: "/sess" } } };
    assert.equal(zgGuard({ name: "zg_search", arguments: {}, agent }, zhMessages), undefined);
    const agentNoCwd = { session: { header: {} } };
    const reason = zgGuard({ name: "zg_status", arguments: {}, agent: agentNoCwd }, zhMessages);
    assert.equal(reason?.includes("root"), true);
  });

  it("zg_search 相对 root 拒绝", () => {
    const reason = zgGuard({ name: "zg_search", arguments: { root: "ws" } }, zhMessages);
    assert.equal(reason?.includes("绝对路径"), true);
  });

  it("zg_search 绝对 root 放行", () => {
    assert.equal(zgGuard({ name: "zg_search", arguments: { root: "/ws" } }, zhMessages), undefined);
  });

  it("zg_status 绝对 root 放行、NUL 拒绝", () => {
    assert.equal(zgGuard({ name: "zg_status", arguments: { root: "/ws" } }, zhMessages), undefined);
    const reason = zgGuard({ name: "zg_status", arguments: { root: "/a\u0000b" } }, zhMessages);
    assert.equal(reason?.includes("NUL"), true);
  });
});

describe("isGrepRgCommand", () => {
  it("grep/rg/egrep/fgrep 检索命中", () => {
    assert.equal(isGrepRgCommand("grep foo src"), true);
    assert.equal(isGrepRgCommand("rg pattern"), true);
    assert.equal(isGrepRgCommand("egrep -n foo ."), true);
    assert.equal(isGrepRgCommand("fgrep bar file.txt"), true);
    assert.equal(isGrepRgCommand("GREP foo"), true);
  });

  it("管道与绝对路径调用命中", () => {
    assert.equal(isGrepRgCommand("cat a.txt | grep foo"), true);
    assert.equal(isGrepRgCommand("/opt/homebrew/bin/rg foo src"), true);
    assert.equal(isGrepRgCommand("git grep foo"), true);
    assert.equal(isGrepRgCommand('find . -name "*.ts" | xargs grep TODO'), true);
    assert.equal(isGrepRgCommand('rg "foo|bar" && echo done'), true);
  });

  it("非检索命令不命中", () => {
    assert.equal(isGrepRgCommand("ls -la"), false);
    assert.equal(isGrepRgCommand("git log --grep=foo"), false);
    assert.equal(isGrepRgCommand("cat grepbar.ts"), false);
    assert.equal(isGrepRgCommand("echo GREP_OPTIONS=1"), false);
    assert.equal(isGrepRgCommand("./scripts/grep-helper run"), false);
    assert.equal(isGrepRgCommand("npm run build"), false);
  });

  it("引号/注释里的 grep 不是命令（旧实现过度拦截的三种形态）", () => {
    assert.equal(isGrepRgCommand('echo "grep something"'), false);
    assert.equal(isGrepRgCommand("printf 'grep'"), false);
    assert.equal(isGrepRgCommand('git commit -m "use rg"'), false);
    assert.equal(isGrepRgCommand("echo done # grep foo"), false);
    // 异种引号在字符串内是字面量，不会误开/误闭引号状态
    assert.equal(isGrepRgCommand('echo "it\'s a grep-ish file"'), false);
    assert.equal(isGrepRgCommand("cat 'say \"grep\" out.txt'"), false);
    // 注释只到行尾：下一行真检索照拦
    assert.equal(isGrepRgCommand("true # grep foo\ngrep bar src"), true);
  });

  it("转义/选项形态按命令位判定", () => {
    // \grep 是绕 alias 的常见写法，仍是命令位上的 grep
    assert.equal(isGrepRgCommand(String.raw`cat a | \grep foo`), true);
    assert.equal(isGrepRgCommand(String.raw`gr\ep foo`), true);
    // 选项形状（-*/--*）不是命令名
    assert.equal(isGrepRgCommand("--grep foo"), false);
    assert.equal(isGrepRgCommand("echo x; --rg foo"), false);
  });

  it("探测形态豁免（不产生检索）", () => {
    assert.equal(isGrepRgCommand("which rg"), false);
    assert.equal(isGrepRgCommand("command -v rg"), false);
    assert.equal(isGrepRgCommand("type grep"), false);
    assert.equal(isGrepRgCommand("man grep"), false);
    assert.equal(isGrepRgCommand("rg --version"), false);
    assert.equal(isGrepRgCommand("grep -V"), false);
    assert.equal(isGrepRgCommand("rg --help"), false);
  });
});

describe("pathInsideRoot", () => {
  const root = "/repo";

  it("缺省/空串 = 缺省搜整个工作区", () => {
    assert.equal(pathInsideRoot(undefined, root, zhMessages), true);
    assert.equal(pathInsideRoot("", root, zhMessages), true);
  });

  it("相对路径按相对 root 解析，在内为 true", () => {
    assert.equal(pathInsideRoot("src/a.ts", root, zhMessages), true);
    assert.equal(pathInsideRoot("src", root, zhMessages), true);
  });

  it("绝对路径在内/等于 root 为 true", () => {
    assert.equal(pathInsideRoot("/repo/src/a.ts", root, zhMessages), true);
    assert.equal(pathInsideRoot("/repo", root, zhMessages), true);
    assert.equal(pathInsideRoot("/repo/", root, zhMessages), true);
  });

  it("出界/逃逸/前缀相似目录为 false", () => {
    assert.equal(pathInsideRoot("/other/x", root, zhMessages), false);
    assert.equal(pathInsideRoot("../outside", root, zhMessages), false);
    assert.equal(pathInsideRoot("a/../../b", root, zhMessages), false);
    // 按路径段前缀：/repository 不是 /repo 之内
    assert.equal(pathInsideRoot("/repository/x", root, zhMessages), false);
    // `..` 越出文件系统根：归一化本身失败 → 判在根外（不抛错）
    assert.equal(pathInsideRoot("a/../../../b", root, zhMessages), false);
    assert.equal(pathInsideRoot("/repo/../../out", root, zhMessages), false);
  });
});

describe("hasExternalTarget", () => {
  const root = "/repo";

  it("无路径 token（纯模式/相对在内）→ false", () => {
    assert.equal(hasExternalTarget(root, "grep foo", zhMessages), false);
    assert.equal(hasExternalTarget(root, "rg foo src", zhMessages), false);
    assert.equal(hasExternalTarget(root, "grep -r foo src tests", zhMessages), false);
    assert.equal(hasExternalTarget(root, "cat a.txt | grep foo", zhMessages), false);
    assert.equal(hasExternalTarget(root, "git grep foo", zhMessages), false);
  });

  it("绝对路径在索引根内 → false", () => {
    assert.equal(hasExternalTarget(root, "grep foo /repo/src", zhMessages), false);
    assert.equal(hasExternalTarget(root, "rg foo /repo/src/a.ts /repo", zhMessages), false);
  });

  it("外部绝对路径 → true", () => {
    assert.equal(hasExternalTarget(root, "grep foo /plain-project/src", zhMessages), true);
    assert.equal(hasExternalTarget(root, "grep -r foo /var/log", zhMessages), true);
    // 混合目标含任一外部绝对路径即整体放行（已知近似）
    assert.equal(hasExternalTarget(root, "rg foo /repo/src /tmp/x", zhMessages), true);
  });

  it("../ 逃逸与裸 .. → true", () => {
    assert.equal(hasExternalTarget(root, "grep foo ../other", zhMessages), true);
    assert.equal(hasExternalTarget(root, "rg -r foo ..", zhMessages), true);
    assert.equal(hasExternalTarget(root, "grep foo src/../../outside", zhMessages), true);
  });

  it("flag 选项与无路径形状 token 不参与判定", () => {
    assert.equal(hasExternalTarget(root, "rg --glob '*.ts' foo /repo", zhMessages), false);
    assert.equal(hasExternalTarget(root, "grep 'v1.2.3' /repo/version.txt", zhMessages), false);
    // --exclude-dir= 粘连值以 - 开头，跳过不判
    assert.equal(
      hasExternalTarget(root, "rg -r foo /repo --exclude-dir=node_modules", zhMessages),
      false,
    );
  });

  it("cd 到外部目录再 grep → 绝对路径证据命中放行", () => {
    assert.equal(hasExternalTarget(root, "cd /outside && grep foo .", zhMessages), true);
    assert.equal(hasExternalTarget(root, "cd /repo && grep foo .", zhMessages), false);
  });
});

/** 索引探测工厂（模块作用域：纯参数派生，unicorn/consistent-function-scoping）。 */
const probeOf = (dirs: Set<string>) => (dir: string) => dirs.has(dir);

describe("findIndexRoot", () => {
  it("索引目录名与 manifest 文件名常量都与 zg 落盘一致", () => {
    assert.equal(INDEX_DIR_NAME, EXPECTED_INDEX_DIR);
    assert.equal(WORKSPACE_MANIFEST_FILE, EXPECTED_MANIFEST_FILE);
  });

  it("本层命中", () => {
    const probeWs = probeOf(new Set(["/ws"]));
    assert.equal(findIndexRoot("/ws", probeWs), "/ws");
  });

  it("会话在索引根子目录时向上命中祖先", () => {
    const probe = probeOf(new Set(["/repo"]));
    assert.equal(findIndexRoot(INDEXED_SUBDIR, probe), "/repo");
  });

  it("无索引到根返回 undefined", () => {
    const probeEmpty = probeOf(new Set());
    assert.equal(findIndexRoot("/a/b/c", probeEmpty), undefined);
    assert.equal(findIndexRoot("/", probeEmpty), undefined);
  });

  it("maxDepth 限制向上层数", () => {
    const probe = probeOf(new Set(["/a"]));
    assert.equal(findIndexRoot("/a/b/c/d/e/f/g/h/i/j", probe, 8), undefined);
    assert.equal(findIndexRoot("/a/b/c/d/e/f/g/h/i", probe, 8), "/a");
  });

  it("尾部斜杠归一化", () => {
    assert.equal(normalizeRoot("/ws/"), "/ws");
    assert.equal(normalizeRoot("/"), "/");
  });
});

/** 构造 guard 的 agent 面（模块作用域：纯参数派生）。 */
const agent = (id: string, cwd: string): { session: { id: string; header: { cwd: string } } } => ({
  session: { id, header: { cwd } },
});

describe("searchFirstGuard", () => {
  const INDEXED = "/repo";
  const NOW = 1_000_000_000;
  // looked = 查表用到的索引根；consumed = 每次扣减后的余量（宿主同款副作用）。
  const makeDeps = (
    opts: { enabled?: boolean; unlock?: SearchUnlock } = {},
  ): { looked: string[]; consumed: number[]; deps: SearchFirstDeps } => {
    const looked: string[] = [];
    const consumed: number[] = [];
    return {
      looked,
      consumed,
      deps: {
        enabled: opts.enabled ?? true,
        indexProbe: (dir: string) => dir === INDEXED,
        now: () => NOW,
        grepBudget: DEFAULT_GREP_BUDGET,
        windowMin: DEFAULT_UNLOCK_WINDOW_MIN,
        lookupUnlock: (indexRoot: string) => {
          looked.push(indexRoot);
          return opts.unlock;
        },
        consumeGrep: (unlock: SearchUnlock) => {
          unlock.grepsLeft -= 1;
          consumed.push(unlock.grepsLeft);
        },
      },
    };
  };

  it("开关关闭一律放行", () => {
    const { deps } = makeDeps({ enabled: false });
    assert.equal(
      searchFirstGuard(
        { name: "bash", arguments: { command: "grep foo" }, agent: agent("s1", INDEXED) },
        deps,
        zhMessages,
      ),
      undefined,
    );
  });

  it("非 bash/pwsh/grep 工具放行", () => {
    const { deps } = makeDeps();
    assert.equal(
      searchFirstGuard(
        { name: "read", arguments: { file: "/repo/a.ts" }, agent: agent("s1", INDEXED) },
        deps,
        zhMessages,
      ),
      undefined,
    );
    assert.equal(
      searchFirstGuard(
        { name: "zg_search", arguments: {}, agent: agent("s1", INDEXED) },
        deps,
        zhMessages,
      ),
      undefined,
    );
  });

  it("无会话 cwd 放行（无法定位索引，宁可漏拦）", () => {
    const { deps } = makeDeps();
    assert.equal(
      searchFirstGuard({ name: "bash", arguments: { command: "grep foo" } }, deps, zhMessages),
      undefined,
    );
  });

  it("bash 非 grep 命令放行", () => {
    const { deps } = makeDeps();
    assert.equal(
      searchFirstGuard(
        { name: "bash", arguments: { command: "ls -la && npm test" }, agent: agent("s1", INDEXED) },
        deps,
        zhMessages,
      ),
      undefined,
    );
  });

  it("bash grep + 有索引 + 无解锁（从未 zg_search）→ 拒绝，消息含出路与状态", () => {
    const { deps } = makeDeps();
    const reason = searchFirstGuard(
      { name: "bash", arguments: { command: "rg foo src" }, agent: agent("s1", INDEXED) },
      deps,
      zhMessages,
    );
    if (reason === undefined) {
      assert.fail("expected search-first 拦截 reason");
    }
    assert.ok(reason.includes("zg_search"));
    assert.ok(reason.includes(INDEXED));
    assert.ok(reason.includes("尚未"));
    assert.ok(reason.includes(String(DEFAULT_GREP_BUDGET)));
  });

  it("bash grep + 无索引放行", () => {
    const { deps } = makeDeps();
    assert.equal(
      searchFirstGuard(
        { name: "bash", arguments: { command: "grep foo" }, agent: agent("s1", "/plain") },
        deps,
        zhMessages,
      ),
      undefined,
    );
  });

  it("bash grep 目标指向索引根之外（绝对路径/../逃逸）→ 放行（误拦回归）", () => {
    const { deps } = makeDeps();
    // 从有索引工作区检索其它无索引工作区：绝对路径
    assert.equal(
      searchFirstGuard(
        {
          name: "bash",
          arguments: { command: "grep foo /plain-project/src" },
          agent: agent("s1", INDEXED),
        },
        deps,
        zhMessages,
      ),
      undefined,
    );
    // 相对路径逃逸到索引根之外
    assert.equal(
      searchFirstGuard(
        {
          name: "bash",
          arguments: { command: "grep foo ../other" },
          agent: agent("s1", INDEXED_SUBDIR),
        },
        deps,
        zhMessages,
      ),
      undefined,
    );
    // pwsh 同样豁免
    assert.equal(
      searchFirstGuard(
        {
          name: "pwsh",
          arguments: { command: "rg foo /plain-project" },
          agent: agent("s1", INDEXED),
        },
        deps,
        zhMessages,
      ),
      undefined,
    );
  });

  it("bash grep 目标在索引根内（绝对/相对）→ 仍拦截", () => {
    const { deps } = makeDeps();
    const reason = searchFirstGuard(
      { name: "bash", arguments: { command: "rg foo /repo/src" }, agent: agent("s1", INDEXED) },
      deps,
      zhMessages,
    );
    if (reason === undefined) {
      assert.fail("expected search-first 拦截 reason");
    }
    assert.ok(reason.includes("zg_search"));
    assert.equal(
      searchFirstGuard(
        { name: "bash", arguments: { command: "grep foo src" }, agent: agent("s1", INDEXED) },
        deps,
        zhMessages,
      ),
      reason,
    );
  });

  it("bash grep + 有效解锁 → 放行且扣减配额", () => {
    const { deps, looked, consumed } = makeDeps({
      unlock: { grepsLeft: 2, expiresAt: NOW + 60_000 },
    });
    assert.equal(
      searchFirstGuard(
        { name: "bash", arguments: { command: "grep foo" }, agent: agent("s1", INDEXED) },
        deps,
        zhMessages,
      ),
      undefined,
    );
    assert.deepEqual(looked, [INDEXED], "解锁额度按索引根查");
    assert.deepEqual(consumed, [1], "放行一次应扣掉一次额度");
  });

  it("配额用尽 → 拒绝且不扣减", () => {
    const { deps, looked, consumed } = makeDeps({
      unlock: { grepsLeft: 0, expiresAt: NOW + 60_000 },
    });
    const reason = searchFirstGuard(
      { name: "bash", arguments: { command: "grep foo" }, agent: agent("s1", INDEXED) },
      deps,
      zhMessages,
    );
    assert.equal(reason?.includes("配额已用尽"), true);
    assert.deepEqual(looked, [INDEXED]);
    assert.deepEqual(consumed, [], "拒绝不得扣额度");
  });

  it("解锁过期 → 拒绝且不扣减", () => {
    const { deps, looked, consumed } = makeDeps({ unlock: { grepsLeft: 3, expiresAt: NOW - 1 } });
    const reason = searchFirstGuard(
      { name: "bash", arguments: { command: "grep foo" }, agent: agent("s1", INDEXED) },
      deps,
      zhMessages,
    );
    assert.equal(reason?.includes("过期"), true);
    assert.deepEqual(looked, [INDEXED]);
    assert.deepEqual(consumed, [], "过期不得扣额度");
  });

  it("会话隔离：另一会话的解锁不影响本会话拦截（deps 按会话分片，与宿主一致）", () => {
    const unlocksBySession = new Map<string, Map<string, SearchUnlock>>([
      ["s1", new Map([[INDEXED, { grepsLeft: 3, expiresAt: NOW + 60_000 }]])],
    ]);
    const call = (id: string): string | undefined =>
      searchFirstGuard(
        { name: "bash", arguments: { command: "grep foo" }, agent: agent(id, INDEXED) },
        {
          enabled: true,
          indexProbe: (dir: string) => dir === INDEXED,
          now: () => NOW,
          grepBudget: DEFAULT_GREP_BUDGET,
          windowMin: DEFAULT_UNLOCK_WINDOW_MIN,
          lookupUnlock: (indexRoot: string) => unlocksBySession.get(id)?.get(indexRoot),
          consumeGrep: (unlock: SearchUnlock) => {
            unlock.grepsLeft -= 1;
          },
        },
        zhMessages,
      );
    assert.ok(call("s2") !== undefined);
    assert.equal(call("s1"), undefined);
  });

  it("会话工作区是索引根子目录时命中祖先索引", () => {
    const { deps } = makeDeps();
    const reason = searchFirstGuard(
      {
        name: "bash",
        arguments: { command: "grep foo" },
        agent: agent("s1", INDEXED_SUBDIR),
      },
      deps,
      zhMessages,
    );
    assert.equal(reason?.includes(INDEXED), true);
  });

  it("原生 grep 工具同样拦截；path 出界放行", () => {
    const { deps } = makeDeps();
    const reason = searchFirstGuard(
      { name: "grep", arguments: { pattern: "foo" }, agent: agent("s1", INDEXED) },
      deps,
      zhMessages,
    );
    assert.equal(reason?.includes("zg_search"), true);
    assert.equal(
      searchFirstGuard(
        {
          name: "grep",
          arguments: { pattern: "foo", path: "/tmp/other" },
          agent: agent("s1", INDEXED),
        },
        deps,
        zhMessages,
      ),
      undefined,
    );
    assert.equal(
      searchFirstGuard(
        { name: "grep", arguments: { pattern: "foo", path: "src" }, agent: agent("s1", INDEXED) },
        deps,
        zhMessages,
      ),
      reason,
    );
  });

  it("pwsh 复用 bash 规则", () => {
    const { deps } = makeDeps();
    const reason = searchFirstGuard(
      { name: "pwsh", arguments: { command: "rg foo" }, agent: agent("s1", INDEXED) },
      deps,
      zhMessages,
    );
    assert.ok(reason !== undefined);
  });

  it("sessionKeyOf：字符串/数字 id 直用，无 id 归共享桶", () => {
    assert.equal(sessionKeyOf({ agent: { session: { id: "s1" } } }), "s1");
    assert.equal(sessionKeyOf({ agent: { session: { id: 42 } } }), "42");
    assert.equal(sessionKeyOf({ agent: { session: {} } }), "__anonymous__");
    assert.equal(sessionKeyOf(undefined), "__anonymous__");
  });
});

/** 一条会话表：`id -> 它的父会话 id`（无父则查不到）。 */
function table(
  links: Record<string, string>,
): (id: string) => { parentSession?: unknown } | undefined {
  return (id: string) => {
    const parent = links[id];
    return parent === undefined ? undefined : { parentSession: parent };
  };
}

/** 造一个执行面：会话 id + 可选的父会话 id（子代理挂在谁下面）。 */
function at(id: string, parent?: string): GuardExecution {
  return {
    agent: { session: { id, header: parent === undefined ? {} : { parentSession: parent } } },
  };
}

describe("rootSessionKeyOf（子代理与主代理共享一份配额）", () => {
  it("自身即顶层：没有 parentSession 就用自己的 id", () => {
    assert.equal(rootSessionKeyOf(at("s1"), table({})), "s1");
    assert.equal(rootSessionKeyOf(at("s1")), "s1");
  });

  it("一级子代理：退到父会话", () => {
    assert.equal(rootSessionKeyOf(at("child", "parent"), table({})), "parent");
  });

  it("多级子代理：一路上溯到最顶层", () => {
    assert.equal(
      rootSessionKeyOf(at("child", "mid"), table({ child: "mid", mid: "grand", grand: "root" })),
      "root",
    );
  });

  it("同一棵树上的兄弟子代理得到同一个键（这正是共享配额的前提）", () => {
    const lookup = table({ kidA: "mid", kidB: "mid", mid: "root" });
    assert.equal(
      rootSessionKeyOf(at("kidA", "mid"), lookup),
      rootSessionKeyOf(at("kidB", "mid"), lookup),
    );
  });

  it("缺席会话查询面：停在已知的最后一跳，不猜", () => {
    assert.equal(rootSessionKeyOf(at("child", "mid"), undefined), "mid");
  });

  it("链上某一跳查不到：停在那一跳，不越过去", () => {
    assert.equal(rootSessionKeyOf(at("child", "mid"), table({ mid: "root" })), "root");
    assert.equal(rootSessionKeyOf(at("child", "mid"), table({})), "mid");
  });

  it("链成环时停住，不无限上溯", () => {
    const lookup = table({ hopA: "hopB", hopB: "hopA" });
    const key = rootSessionKeyOf(at("entry", "hopA"), lookup);
    assert.ok(["hopA", "hopB"].includes(key));
  });

  it("跳数有上限：超长链停在上限处", () => {
    const links: Record<string, string> = {};
    for (let index = 0; index < MAX_PARENT_WALK + 10; index += 1) {
      links[`s${String(index)}`] = `s${String(index + 1)}`;
    }
    assert.equal(rootSessionKeyOf(at("s0", "s1"), table(links)), `s${String(MAX_PARENT_WALK + 1)}`);
  });

  it("非字符串的 parentSession 一律按「没有父」处理（复原值未经校验）", () => {
    assert.equal(
      rootSessionKeyOf(
        { agent: { session: { id: "s1", header: { parentSession: 42 } } } },
        table({}),
      ),
      "s1",
    );
    assert.equal(
      rootSessionKeyOf(
        { agent: { session: { id: "s1", header: { parentSession: null } } } },
        table({}),
      ),
      "s1",
    );
  });

  it("无会话身份：仍落共享桶（与旧口径同）", () => {
    assert.equal(rootSessionKeyOf(undefined, table({})), "__anonymous__");
    assert.equal(rootSessionKeyOf({ agent: { session: {} } }, table({})), "__anonymous__");
  });
});

describe("unlockActive", () => {
  const NOW = 1_000_000_000;

  it("无解锁 / 零配额 / 已过期 → false", () => {
    assert.equal(unlockActive(undefined, NOW), false);
    assert.equal(unlockActive({ grepsLeft: 0, expiresAt: NOW + 60_000 }, NOW), false);
    assert.equal(unlockActive({ grepsLeft: 3, expiresAt: NOW - 1 }, NOW), false);
    assert.equal(unlockActive({ grepsLeft: 0, expiresAt: NOW - 1 }, NOW), false);
  });

  it("有配额且未过期 → true（过期时刻本身不算有效）", () => {
    assert.equal(unlockActive({ grepsLeft: 1, expiresAt: NOW + 60_000 }, NOW), true);
    assert.equal(unlockActive({ grepsLeft: 3, expiresAt: NOW }, NOW), false);
  });

  it("默认阈值导出（与宿主 BUILTIN_BASE 单源）", () => {
    assert.equal(DEFAULT_GREP_BUDGET, 3);
    assert.equal(DEFAULT_UNLOCK_WINDOW_MIN, 10);
  });
});
