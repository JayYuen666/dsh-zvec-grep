// lib/index-preflight.ts 的单元测试：目标解析（node:path）、错误码分流与 drop 跳过。
// 「坏路径写进工作区索引状态」的上游事实由 test/e2e/zg-cli.test.ts 对真 zg 钉；这里只钉
// 预检自己的判据，不触任何 zg 进程。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { accessSync, constants, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertIgnoreFilesExist, isUnusableFileCode } from "../lib/index-preflight.ts";
import { MESSAGES } from "../lib/messages.ts";

const zhMessages = MESSAGES.zh;

/** 每个用例一座临时工作区（系统临时目录，测试运行结束后由运行器环境兜底）。 */
function workspace(): string {
  return mkdtempSync(path.join(tmpdir(), "zg-preflight-"));
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
    try {
      assertIgnoreFilesExist({ root, ignoreFiles: ["missing.ignore"] }, root, zhMessages);
      assert.fail("缺失的忽略文件必须被拦");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(message.includes(path.join(root, "missing.ignore")), message);
      assert.ok(!message.includes(" 在 "), "文案不再把目标说成 root 之下");
    }
    const absolute = path.join(tmpdir(), "zg-preflight-absent.ignore");
    try {
      assertIgnoreFilesExist({ root, ignoreFiles: [absolute] }, root, zhMessages);
      assert.fail("缺失的忽略文件必须被拦");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(message.includes(absolute), message);
    }
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
      let caught: unknown;
      try {
        // 显式不抛才 fail：assert.fail 在抛出后不可达。
        assertIgnoreFilesExist({ root, ignoreFiles: ["loop"] }, root, zhMessages);
        assert.fail("ELOOP 必须上抛");
      } catch (error) {
        caught = error;
      }
      assert.equal((caught as { code?: string }).code, "ELOOP");
    },
  );
});
