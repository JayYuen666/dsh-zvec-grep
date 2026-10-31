// 路径判据与 shell 切词的属性面：search-first 门禁与 root 授权的判定底座。
// 单测（test/cli.test.ts、test/routing.test.ts）钉的是想到的形状；这一层用 fast-check
// 扫没想到的形状。期望值由测试内的独立 oracle（栈式归一模型、前缀段规则）算出，
// oracle 只按 lib/cli.ts 与 lib/search-predicates.ts 头注写明的契约实现，不从实现代码派生。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";

import { MESSAGES } from "../../lib/messages.ts";
import {
  hasExternalTarget,
  isGrepRgCommand,
  normalizeRoot,
  pathInsideRoot,
  pathsRelated,
  unlockActive,
} from "../../lib/search-predicates.ts";
import { assertAbsoluteRoot, normalizeAbsolutePath, resolveRoot } from "../../lib/cli.ts";
import { shq } from "../../lib/argv-guard.ts";

/** 覆盖判据只为判路径归属，文案表在这一层是摆设（异常文本被丢弃，出界才是结论）。 */
const { zh } = MESSAGES;

/** 合法路径段：字母数字开头，不含 `/`、`.` 开头、NUL——生成器层面就排除掉歧义形状。 */
const segmentArb = fc.stringMatching(/^[A-Za-z0-9][\w.-]{0,7}$/u);

/** 由段生成的绝对路径（≥1 段，永不归一成 `/`）。 */
const absolutePathArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 5 })
  .map((segments) => `/${segments.join("/")}`);

/** 词法 token：普通段、父段、当前段、空段。 */
const lexTokenArb = fc.oneof(segmentArb, fc.constant(".."), fc.constant("."), fc.constant(""));
const lexSeqArb = fc.array(lexTokenArb, { maxLength: 10 });
/** 同上，但不含空段（幂等性质只对可归一输入有意义）。 */
const lexTokenNoEmptyArb = fc.oneof(segmentArb, fc.constant(".."), fc.constant("."));
const lexSeqNoEmptyArb = fc.array(lexTokenNoEmptyArb, { maxLength: 8 });

const rootSegmentsArb = fc.array(segmentArb, { minLength: 1, maxLength: 4 });
const tailSegmentsArb = fc.array(segmentArb, { maxLength: 3 });

/** 非 `/` 开头的根形状（win32 盘符、UNC、盘符相对、相对路径、空白）。 */
const nonAbsoluteRoots = [
  String.raw`C:\repo`,
  String.raw`c:\repo`,
  String.raw`\\host\share`,
  String.raw`\repo`,
  "C:repo",
  String.raw`C:\repo\src`,
  "repo",
  "./repo",
  "",
  "   ",
  "C:x.md",
  "D:x.md",
];

/** 显式 root 位置上的非字符串值。 */
const nonStringValueArb = fc.oneof(
  fc.integer(),
  fc.boolean(),
  fc.double(),
  fc.constant({ root: 1 }),
  fc.constant([1]),
);

/** 与根不相交的外部绝对路径（首段写死，构造性保证与任何生成的根都不相交）。 */
const externalPathArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 4 })
  .map((segments) => `/elsewhere/${segments.join("/")}`);

/** 任意短文本（引号隔离与 shq 往返用）。 */
const shortTextArb = fc.string({ maxLength: 40 });

/** 不带尾斜杠且非空的串（normalizeRoot 的恒等区）。 */
const noTrailingSlashArb = fc
  .string({ maxLength: 64 })
  .filter((value) => !value.endsWith("/") && value.length > 0);

/** 栈式归一模型：折叠空段与 `.`、`..` 弹栈、越根即抛。按 normalizeAbsolutePath 的头注契约独立实现。 */
function modelNormalize(segments: readonly string[]): string {
  const stack: string[] = [];
  for (const seg of segments) {
    if (seg === "..") {
      if (stack.length === 0) {
        throw new Error("escape");
      }
      stack.pop();
    } else if (seg !== "" && seg !== ".") {
      stack.push(seg);
    }
  }
  return `/${stack.join("/")}`;
}

/** 段前缀模型：target 在 root 内 ⇔ target === root 或以 root + "/" 开头（防 /fo 吞 /foo）。 */
function modelInsideAbsolute(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}

describe("normalizeRoot 的性质", () => {
  it("幂等，且归一后永不再以 / 结尾（除根自身）", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 64 }), (root) => {
        const once = normalizeRoot(root);
        assert.equal(normalizeRoot(once), once);
        assert.ok(once === "/" || !once.endsWith("/"));
      }),
    );
  });

  it("只剥尾部斜杠：不带尾斜杠的非空输入原样返回（空串的固定点是 /）", () => {
    fc.assert(
      fc.property(noTrailingSlashArb, (root) => {
        assert.equal(normalizeRoot(root), root);
      }),
    );
  });

  it("空串与根自身的两个固定点", () => {
    assert.equal(normalizeRoot(""), "/");
    assert.equal(normalizeRoot("/"), "/");
  });
});

describe("normalizeAbsolutePath 对栈式归一模型", () => {
  it("任意段序列（含 ./..//）与模型同判：同结果或同抛", () => {
    fc.assert(
      fc.property(lexSeqArb, (segments) => {
        const path = segments.join("/");
        let model = "";
        let modelThrew = false;
        try {
          model = modelNormalize(segments);
        } catch {
          modelThrew = true;
        }
        if (modelThrew) {
          assert.throws(() => normalizeAbsolutePath(path, zh));
          return;
        }
        assert.equal(normalizeAbsolutePath(path, zh), model);
      }),
    );
  });

  it("可归一的输入幂等", () => {
    fc.assert(
      fc.property(lexSeqNoEmptyArb, (segments) => {
        const path = segments.join("/");
        try {
          const once = normalizeAbsolutePath(path, zh);
          assert.equal(normalizeAbsolutePath(once, zh), once);
        } catch {
          // 越根形状本身允许抛，幂等性质只对可归一的输入成立
        }
      }),
    );
  });
});

describe("assertAbsoluteRoot 的性质", () => {
  it("非字符串一律 TypeError，绝不静默接受", () => {
    fc.assert(
      fc.property(nonStringValueArb, (value) => {
        assert.throws(() => assertAbsoluteRoot(value, zh), TypeError);
      }),
    );
  });

  it("非 / 开头的形状（win32 盘符、UNC、盘符相对、相对路径、空白）一律拒绝", () => {
    for (const root of nonAbsoluteRoots) {
      assert.throws(() => assertAbsoluteRoot(root, zh), `应拒绝 ${root}`);
    }
  });

  it("归一后为文件系统根（/ 与 //）拒绝；合法绝对路径返回归一形式", () => {
    for (const root of ["/", "//"]) {
      assert.throws(() => assertAbsoluteRoot(root, zh));
    }
    fc.assert(
      fc.property(absolutePathArb, (root) => {
        assert.equal(assertAbsoluteRoot(root, zh), modelNormalize(root.split("/")));
      }),
    );
  });

  it("任何位置含 NUL 即拒绝", () => {
    fc.assert(
      fc.property(absolutePathArb, fc.integer({ min: 0, max: 8 }), (root, position) => {
        const injected = `${root.slice(0, position)}\u0000${root.slice(position)}`;
        assert.throws(() => assertAbsoluteRoot(injected, zh));
      }),
    );
  });
});

describe("resolveRoot 的性质", () => {
  it("显式非字符串绝不滑进 fallback", () => {
    fc.assert(
      fc.property(nonStringValueArb, absolutePathArb, (value, fallback) => {
        assert.throws(() => resolveRoot(value, fallback, zh), TypeError);
      }),
    );
  });

  it("显式字符串优先于 fallback，且走同一套归一", () => {
    fc.assert(
      fc.property(absolutePathArb, absolutePathArb, (value, fallback) => {
        const expected = assertAbsoluteRoot(value, zh);
        assert.equal(resolveRoot(`  ${value}  `, fallback, zh), expected);
      }),
    );
  });

  it("缺席时回落 fallback 并归一；两者都缺席才报 rootRequired", () => {
    fc.assert(
      fc.property(absolutePathArb, (fallback) => {
        assert.equal(resolveRoot(undefined, fallback, zh), assertAbsoluteRoot(fallback, zh));
        assert.equal(resolveRoot(null, fallback, zh), assertAbsoluteRoot(fallback, zh));
        assert.throws(() => resolveRoot(undefined, undefined, zh));
      }),
    );
  });
});

describe("pathInsideRoot 对段前缀模型", () => {
  it("根内目标（root 自身 / 后代）恒 true，段前缀陷阱（/a/bx）恒 false", () => {
    fc.assert(
      fc.property(rootSegmentsArb, tailSegmentsArb, (rootSegments, extraSegments) => {
        const root = `/${rootSegments.join("/")}`;
        const inside = `${root}/${extraSegments.join("/")}`;
        const sibling = `${root}x/${extraSegments.join("/")}`;
        assert.equal(pathInsideRoot(inside, root, zh), true);
        assert.equal(pathInsideRoot(root, root, zh), true);
        assert.equal(pathInsideRoot(sibling, root, zh), false);
      }),
    );
  });

  it("不相交的两棵树恒 false（右树首段 = 左树首段加后缀，构造性保证不相交）", () => {
    fc.assert(
      fc.property(rootSegmentsArb, tailSegmentsArb, (leftSegments, rightSegments) => {
        const left = `/${leftSegments.join("/")}`;
        const right = `/${leftSegments[0]}x/${rightSegments.join("/")}`;
        assert.equal(pathInsideRoot(right, left, zh), false);
        assert.equal(pathInsideRoot(left, right, zh), false);
      }),
    );
  });

  it("相对目标按相对 root 解析：留根内 true，.. 逃逸 false（与栈式模型同判）", () => {
    fc.assert(
      fc.property(rootSegmentsArb, lexSeqNoEmptyArb, (rootSegments, relativeSegments) => {
        const root = `/${rootSegments.join("/")}`;
        const relative = relativeSegments.join("/");
        const joined = `${root}/${relative}`;
        let expected: boolean;
        try {
          expected = modelInsideAbsolute(root, modelNormalize(joined.split("/")));
        } catch {
          expected = false;
        }
        assert.equal(pathInsideRoot(relative, root, zh), expected);
      }),
    );
  });

  it("缺席目标 = 检索整个工作区恒 true；根为 / 时任何绝对目标都算根内", () => {
    fc.assert(
      fc.property(absolutePathArb, (target) => {
        assert.equal(pathInsideRoot(undefined, target, zh), true);
        assert.equal(pathInsideRoot("   ", target, zh), true);
        assert.equal(pathInsideRoot(target, "/", zh), true);
      }),
    );
  });
});

describe("pathsRelated 的性质", () => {
  it("对称", () => {
    fc.assert(
      fc.property(absolutePathArb, absolutePathArb, (left, right) => {
        assert.equal(pathsRelated(left, right, zh), pathsRelated(right, left, zh));
      }),
    );
  });

  it("同一棵树（祖先/后代）恒相关，段前缀陷阱恒不相关", () => {
    fc.assert(
      fc.property(rootSegmentsArb, tailSegmentsArb, (rootSegments, extraSegments) => {
        const root = `/${rootSegments.join("/")}`;
        const child = `${root}/${extraSegments.join("/")}`;
        assert.equal(pathsRelated(root, child, zh), true);
        assert.equal(pathsRelated(root, `${root}x`, zh), false);
      }),
    );
  });
});

describe("isGrepRgCommand 的引号隔离性质", () => {
  it("单引号包裹的任意文本（含 grep 字样、换行、引号）不构成检索命令", () => {
    fc.assert(
      fc.property(shortTextArb, (content) => {
        assert.equal(isGrepRgCommand(`echo ${shq(content)}`), false);
      }),
    );
  });

  it("探测旗标豁免整条命令", () => {
    fc.assert(
      fc.property(externalPathArb, (external) => {
        assert.equal(isGrepRgCommand(`rg ${shq(external)} --version`), false);
        assert.equal(isGrepRgCommand("rg --help"), false);
      }),
    );
  });
});

describe("hasExternalTarget 的目标面性质", () => {
  it("根外的显式操作数判外部；同一串作为重定向落点或取值旗标的值都不判", () => {
    fc.assert(
      fc.property(absolutePathArb, externalPathArb, (root, external) => {
        const quoted = shq(external);
        assert.equal(hasExternalTarget(root, `rg foo ${quoted}`, zh), true);
        assert.equal(hasExternalTarget(root, `rg foo > ${quoted}`, zh), false);
        assert.equal(hasExternalTarget(root, `rg --glob ${quoted} foo`, zh), false);
      }),
    );
  });

  it("根内目标不判外部", () => {
    fc.assert(
      fc.property(rootSegmentsArb, tailSegmentsArb, (rootSegments, extraSegments) => {
        const root = `/${rootSegments.join("/")}`;
        const inside = `${root}/${extraSegments.join("/")}`;
        assert.equal(hasExternalTarget(root, `rg foo ${shq(inside)}`, zh), false);
      }),
    );
  });
});

describe("unlockActive 的边界", () => {
  it("余量、时效与边界值", () => {
    assert.equal(unlockActive({ grepsLeft: 1, expiresAt: 100 }, 100), false);
    assert.equal(unlockActive({ grepsLeft: 1, expiresAt: 100 }, 99), true);
    assert.equal(unlockActive({ grepsLeft: 0, expiresAt: 100 }, 50), false);
    assert.equal(unlockActive(undefined, 50), false);
  });
});
