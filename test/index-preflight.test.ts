// lib/index-preflight.ts 的单元测试：目标解析（node:path）、错误码分流与 drop 跳过。
// 「坏路径写进工作区索引状态」的上游事实由 test/e2e/zg-cli.test.ts 对真 zg 钉；这里只钉
// 预检自己的判据，不触任何 zg 进程。
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertIgnoreFilesExist, isUnusableFileCode } from "../lib/index-preflight.ts";
import { MESSAGES, fill } from "../lib/messages.ts";

const zhMessages = MESSAGES.zh;

/** 本轮建过的临时工作区；由 describe 里的 `afterEach` 逐个删掉。
 *  vitest 不清 os.tmpdir() —— 原来那句「由运行器环境兜底」不成立，反复跑会持续累积，
 *  而 ELOOP 那条留下的自指软链会让后续扫描多走一段冤枉路。 */
const created: string[] = [];

/** 每个用例一座临时工作区（登记进 `created`，由 afterEach 负责回收）。 */
function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "zg-preflight-"));
  created.push(dir);
  return dir;
}

/** 跑一次并交回落下来的错误；没抛就是 undefined。
 *  「必须抛」与「抛的是什么码」分两步断：同一个 catch 罩住 assert.fail 时，
 *  实现回归成不抛也只能看到一条 ERR_ASSERTION，看不出真正偏在哪一半。 */
function thrownBy(run: () => void): unknown {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  return thrown;
}

/** 造一个空的可用文件（accessSync R_OK + isFile 都过）。 */
function touch(file: string): void {
  writeFileSync(file, "");
}

describe("isUnusableFileCode（错误码分流判据）", () => {
  it("四种「文件不合适」的码判真；其余一律判假", () => {
    for (const code of ["ENOENT", "EACCES", "EISDIR", "ENOTDIR"]) {
      assert.equal(isUnusableFileCode({ code }), true, code);
    }
    assert.equal(isUnusableFileCode({ code: "ELOOP" }), false, "环境故障不归文件形状");
    assert.equal(isUnusableFileCode({ code: 42 }), false, "非字符串码不算");
  });

  it("非 Error 形状（真 fs 抛不出，判别面在此钉住）：一律判假", () => {
    for (const shape of ["boom", 42, null, undefined, {}, { other: 1 }]) {
      assert.equal(isUnusableFileCode(shape), false);
    }
  });
});

describe("assertIgnoreFilesExist", () => {
  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("相对条目按 root 解析后可用即放行；绝对条目原样用", () => {
    const root = workspace();
    mkdirSync(path.join(root, "sub"));
    const relative = path.join("sub", ".zgignore");
    touch(path.join(root, relative));
    const absolute = path.join(root, "abs.ignore");
    touch(absolute);
    // 不抛即放行：可用条目不产生任何错误（相对按 root 解析、绝对原样，两态都量）。
    assert.doesNotThrow(() => {
      assertIgnoreFilesExist({ root, ignoreFiles: [relative] }, root, zhMessages);
    });
    assert.doesNotThrow(() => {
      assertIgnoreFilesExist({ root, ignoreFiles: [absolute] }, root, zhMessages);
    });
  });

  it("报错点名解析后的目标：相对与绝对条目都给完整路径，不再说「在 root 下」", () => {
    const root = workspace();
    const relativeTarget = path.join(root, "missing.ignore");
    const relativeThrown = thrownBy(() => {
      assertIgnoreFilesExist({ root, ignoreFiles: ["missing.ignore"] }, root, zhMessages);
    });
    assert.ok(relativeThrown !== undefined, "缺失的忽略文件必须被拦");
    // 结构断言而不是 `!includes(" 在 ")`：后者耦合中文模板的空格排版，文案换行或补一句
    // 合法的话就会误报，而真回归（把 root 拼回去）换个排版又能漏判。期望值直接由那份模板算出来。
    assert.equal(
      relativeThrown instanceof Error ? relativeThrown.message : "",
      fill(MESSAGES.zh.ignoreFileMissing, { path: relativeTarget }),
      "文案就是模板填好目标的那一句，不多不少",
    );
    // 绝对条目也放在本用例自己的工作区里造一个确定不存在的路径：
    // 借全局 tmpdir 的固定名会被上次运行残留或并行用例建出来的文件污染（偶发假绿）。
    const absoluteTarget = path.join(root, "absent-abs.ignore");
    const absoluteThrown = thrownBy(() => {
      assertIgnoreFilesExist({ root, ignoreFiles: [absoluteTarget] }, root, zhMessages);
    });
    assert.ok(absoluteThrown !== undefined, "绝对条目缺失同样要拦");
    assert.ok(
      absoluteThrown instanceof Error && absoluteThrown.message.includes(absoluteTarget),
      "绝对条目须原样出现在文案里",
    );
  });

  it("条目存在但是目录 ⇒ 按不可用拦，并点名该目录", () => {
    // 判据是 `usable = accessSync 通过 && statSync().isFile()`：只量「不存在」与「ELOOP」
    // 等于把 isFile 那一半留成无判据的分支（把它改成恒真，本组用例当时全绿）。
    const root = workspace();
    const dir = path.join(root, "a-directory");
    mkdirSync(dir);
    const thrown = thrownBy(() => {
      assertIgnoreFilesExist({ root, ignoreFiles: ["a-directory"] }, root, zhMessages);
    });
    assert.ok(thrown !== undefined, "目录不能当忽略文件用");
    assert.ok(thrown instanceof Error && thrown.message.includes(dir), "文案须点名那个目录");
  });

  it("drop=true 整段跳过：坏条目不触发预检（构造器另有自己的互斥拒绝）", () => {
    // 不抛即放行：同一个条目在 drop=false 时必被拦（上一组用例），这里被跳过。
    assert.doesNotThrow(() => {
      assertIgnoreFilesExist(
        { root: "/ws", drop: true, ignoreFiles: ["/definitely/not/there"] },
        "/ws",
        zhMessages,
      );
    });
  });

  const ELOOP_UNAVAILABLE = process.platform === "win32";

  it.skipIf(ELOOP_UNAVAILABLE)(
    "环境类故障（符号链接环 ELOOP）原样上抛，不被说成「文件不可用」",
    () => {
      // 自指软链让 accessSync 以 ELOOP 失败：把 fd 耗尽/链接环这类与用户输入无关的
      // 故障归并进「请给一个真实存在的文件」，会把排查引向错误的方向。
      const root = workspace();
      symlinkSync("loop", path.join(root, "loop"));
      const probe = path.join(root, "loop");
      assert.throws(
        () => {
          accessSync(probe, constants.R_OK);
        },
        (error: unknown) => (error as { code?: string }).code === "ELOOP",
        "前置确认：夹具真的以 ELOOP 失败",
      );
      const thrown = thrownBy(() => {
        assertIgnoreFilesExist({ root, ignoreFiles: ["loop"] }, root, zhMessages);
      });
      assert.ok(thrown !== undefined, "ELOOP 必须上抛，而不是被归进「文件不可用」");
      assert.equal((thrown as { code?: string }).code, "ELOOP");
    },
  );
});
