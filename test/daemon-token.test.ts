// lib/daemon-token.ts 的单元测试：路径解析、写入/读回、坏形状、权限与失败分支。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  claimPersistedToken,
  clearPersistedToken,
  persistToken,
  readPersistedToken,
  tokenFilePath,
} from "../lib/daemon-token.ts";

describe("daemon token 持久化", () => {
  it("路径跟随 ZVEC_GREP_HOME，否则落 ~/.zvec-grep", () => {
    assert.equal(
      tokenFilePath({ ZVEC_GREP_HOME: "/tmp/zg-home" }),
      path.join("/tmp/zg-home", "dsh-zvec-grep.token"),
    );
    assert.ok(tokenFilePath({}).endsWith(path.join(".zvec-grep", "dsh-zvec-grep.token")));
  });

  it("写入→读回；短/坏形状不读；clear 删除", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zg-token-"));
    const file = path.join(dir, "token");
    try {
      assert.equal(await readPersistedToken(file), undefined, "文件不存在");
      assert.equal(await persistToken(file, "a".repeat(48)), true);
      assert.equal(await readPersistedToken(file), "a".repeat(48));
      writeFileSync(file, "short");
      assert.equal(await readPersistedToken(file), undefined, "形状不合不读");
      await clearPersistedToken(file);
      assert.equal(await readPersistedToken(file), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("并发认领只产生一枚 token：恰好一位创建者，其余读回同一枚", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zg-token-claim-"));
    const file = path.join(dir, "token");
    try {
      const tokens = ["a".repeat(48), "b".repeat(48), "c".repeat(48)];
      const claims = await Promise.all(tokens.map((token) => claimPersistedToken(file, token)));
      const distinct = new Set(claims.map((claim) => claim.token));
      assert.equal(distinct.size, 1, "所有并发认领必须收敛到同一枚 token");
      assert.equal(
        claims.filter((claim) => claim.owned).length,
        1,
        "只有 O_EXCL 的成功者拥有创建权",
      );
      assert.equal(await readPersistedToken(file), claims[0]?.token, "文件里就是这一枚");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("坏形状的旧文件被删除后重新认领；父路径不可写时退回候选值", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zg-token-claim-bad-"));
    const file = path.join(dir, "token");
    try {
      writeFileSync(file, "broken");
      const claimed = await claimPersistedToken(file, "d".repeat(48));
      assert.equal(claimed.token, "d".repeat(48));
      assert.equal(claimed.owned, true);
      assert.equal(await readPersistedToken(file), "d".repeat(48));
      // 父路径是普通文件：mkdir 失败，调用方拿候选值继续（恢复退化为下一次重试）。
      const blocker = path.join(dir, "blocked");
      writeFileSync(blocker, "x");
      const fallback = await claimPersistedToken(path.join(blocker, "token"), "e".repeat(48));
      assert.deepEqual(fallback, { token: "e".repeat(48), owned: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("首个 write 的非 EEXIST 失败（非法路径）按候选值返回", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zg-token-invalid-"));
    try {
      const candidate = "f".repeat(48);
      assert.deepEqual(await claimPersistedToken(path.join(dir, "bad\u0000name"), candidate), {
        token: candidate,
        owned: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("坏文件删不掉时交回候选值", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zg-token-locked-"));
    const locked = path.join(dir, "locked");
    try {
      mkdirSync(locked);
      const file = path.join(locked, "token");
      writeFileSync(file, "broken");
      chmodSync(locked, 0o500);
      const candidate = "g".repeat(48);
      assert.deepEqual(await claimPersistedToken(file, candidate), {
        token: candidate,
        owned: false,
      });
    } finally {
      chmodSync(locked, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("文件权限是 0600", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zg-token-mode-"));
    const file = path.join(dir, "token");
    try {
      await persistToken(file, "b".repeat(48));
      assert.equal(statSync(file).mode.toString(8).slice(-3), "600");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("写不进去返回 false；清理失败不外抛", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zg-token-fail-"));
    try {
      // 父路径是普通文件 ⇒ mkdir 失败
      const blocker = path.join(dir, "blocked");
      writeFileSync(blocker, "x");
      assert.equal(await persistToken(path.join(blocker, "token"), "c".repeat(48)), false);
      // 非空目录 ⇒ rm 失败（被吞掉）
      const nonEmpty = path.join(dir, "non-empty");
      mkdirSync(nonEmpty);
      writeFileSync(path.join(nonEmpty, "f"), "x");
      await assert.doesNotReject(async () => {
        await clearPersistedToken(nonEmpty);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
