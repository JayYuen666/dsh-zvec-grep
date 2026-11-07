// zg 结构化失败识别层与 embedding 清单的属性测试：随机 stderr（噪声行 + 结构行混排）下，
// 码抽取、成因抽取、并发失败归类必须与「只认认得出的形状、认不出不猜」的契约一致。
// 期望值由测试内的独立 oracle（按 lib/zg-errors.ts 头注写明的 0.3.0 输出形状协议实现）给出。
// 0.3.0 形状：Error[<码>]: <成因>（MCP 文本小写 error[）；没有 Details: 块，占锁方信息在
// 成因串里（operation=<token> / lock=<路径> / storage_dir=<路径>）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  classifyConcurrentFailure,
  LOCK_BUSY_CODE,
  PERMISSION_DENIED_CODE,
  REBUILD_OPERATION,
  zgErrorCode,
  zgErrorMessage,
} from "../../lib/zg-errors.ts";
import type { LockBusyFailure } from "../../lib/zg-errors.ts";
import {
  DEFAULT_EMBEDDING,
  isLocalEmbedding,
  isRemoteEmbedding,
  isKnownEmbedding,
  LOCAL_EMBEDDINGS,
  REMOTE_EMBEDDING_CATALOG,
} from "../../lib/embedding-catalog.ts";

/** 不含换行、不以码行开头的噪声行（保证 oracle 里结构行的位置可控）。 */
const noiseLineArb = fc
  .string({ maxLength: 30 })
  .filter((line) => !line.includes("\n") && !/^\s*error\[/iu.test(line));

/** zg 风格的错误码：字母开头 + 大写/点/下划线段，且不与两个已知码相撞。 */
const unknownCodeArb = fc
  .stringMatching(/^[A-Z][A-Z0-9._]{2,29}$/u)
  .filter((code) => code !== LOCK_BUSY_CODE && code !== PERMISSION_DENIED_CODE);

/** 成因串 token：非空白开头、无换行、不以空白结尾（zgErrorMessage 会 trim 成因串）。 */
const messageTokenArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((value) => !value.includes("\n") && !/^\s/u.test(value) && !/\s$/u.test(value));

/** 占锁方操作名（成因串 operation= 之后的那个 token）。 */
const operationNameArb = fc
  .stringMatching(/^[a-z][\w.]{0,19}$/u)
  .filter((op) => op !== REBUILD_OPERATION);
const maybeOperationArb = fc.option(operationNameArb, { nil: undefined });
/** 锁路径 token（不含空白，路径里才可能有歧义字符）。 */
const lockPathArb = fc.stringMatching(/^\/[\w./-]{1,40}$/u);
const knownLocalReferenceArb = fc.constantFrom(
  ...LOCAL_EMBEDDINGS.map((option) => option.reference),
);
const knownRemoteReferenceArb = fc.constantFrom(
  ...REMOTE_EMBEDDING_CATALOG.map((option) => option.reference),
);

/** 按协议拼一个 0.3.0 错误块：码行 + 可选 Help + 固定的 Error location 尾行。 */
function errorBlock(code: string, message: string): string {
  return [`Error[${code}]: ${message}`, "Error location: crates/zg/src/main.rs:1:1"].join("\n");
}

/** 收窄助手。 */
function asLockBusy(failure: ReturnType<typeof classifyConcurrentFailure>): LockBusyFailure {
  assert.ok(failure?.kind === "lock-busy", "期望锁忙失败");
  return failure;
}

describe("zgErrorCode 对「Error[码]: 行协议」", () => {
  it("有码行抽首条（大小写不敏感）；无码行返回 undefined，绝不从散文里猜", () => {
    fc.assert(
      fc.property(
        fc.array(noiseLineArb, { maxLength: 3 }),
        fc.array(noiseLineArb, { maxLength: 3 }),
        unknownCodeArb,
        fc.boolean(),
        fc.constantFrom("Error", "error"),
        (before, after, code, present, casing) => {
          const lines = [...before];
          if (present) {
            lines.push(`${casing}[${code}]: something went wrong`);
          }
          lines.push(...after);
          assert.equal(zgErrorCode(lines.join("\n")), present ? code : undefined);
        },
      ),
    );
  });

  it("首条码行胜出：两条码行不互相污染", () => {
    fc.assert(
      fc.property(unknownCodeArb, unknownCodeArb, (first, second) => {
        fc.pre(first !== second);
        const stderr = `Error[${first}]: first\nmid\nError[${second}]: second\n`;
        assert.equal(zgErrorCode(stderr), first);
      }),
    );
  });

  it("成因抽取与码行同源：冒号之后的整段，码行之外的内容不掺入", () => {
    fc.assert(
      fc.property(messageTokenArb, fc.array(noiseLineArb, { maxLength: 2 }), (token, after) => {
        const stderr = errorBlock("X.Y.Z", `boom ${token}`);
        const message = zgErrorMessage(stderr);
        assert.ok(message.startsWith("boom"), message);
        assert.ok(message.includes(token));
        assert.equal(zgErrorMessage(after.join("\n")), "");
      }),
    );
  });
});

describe("classifyConcurrentFailure 的归类型", () => {
  it("lock-busy 归类：rebuild 只认成因串 operation=index.rebuild；operation 缺失不判重建", () => {
    fc.assert(
      fc.property(lockPathArb, maybeOperationArb, (lockPath, operation) => {
        const message =
          operation === undefined
            ? `lock is busy: lock=${lockPath}`
            : `lock is busy: lock=${lockPath} operation=${operation}`;
        const classified = classifyConcurrentFailure(errorBlock(LOCK_BUSY_CODE, message));
        if (classified?.kind !== "lock-busy") {
          assert.fail("RESOURCE_BUSY 必须归类为 lock-busy");
        }
        assert.equal(classified.ownerOperation, operation);
        assert.equal(classified.lockPath, lockPath);
        assert.equal(classified.rebuild, operation === REBUILD_OPERATION);
      }),
    );
  });

  it("等待超时形态（storage_dir=）同样读出锁路径", () => {
    fc.assert(
      fc.property(lockPathArb, operationNameArb, (lockPath, operation) => {
        const message = `timed out waiting for workspace lock: storage_dir=${lockPath} operation=${operation}`;
        const classified = classifyConcurrentFailure(errorBlock(LOCK_BUSY_CODE, message));
        assert.equal(asLockBusy(classified).lockPath, lockPath);
        assert.equal(asLockBusy(classified).rebuild, operation === REBUILD_OPERATION);
      }),
    );
  });

  it("permission-denied 归类；其余码与无码一律 null", () => {
    fc.assert(
      fc.property(messageTokenArb, unknownCodeArb, (token, unknownCode) => {
        const denied = classifyConcurrentFailure(
          errorBlock(PERMISSION_DENIED_CODE, `Remote embedding authorization required: ${token}`),
        );
        assert.equal(denied?.kind, "permission-denied");
        assert.equal(classifyConcurrentFailure(errorBlock(unknownCode, token)), null);
        assert.equal(classifyConcurrentFailure("plain failure without structure\n"), null);
      }),
    );
  });
});

describe("embedding 清单的结构不变量（0.3.0：本地 ∪ 远程闭集）", () => {
  it("isLocalEmbedding 与本地清单一一对应；默认模型必在本地清单内", () => {
    fc.assert(
      fc.property(knownLocalReferenceArb, (reference) => {
        assert.equal(isLocalEmbedding(reference), true);
        assert.equal(isRemoteEmbedding(reference), false);
        assert.equal(isKnownEmbedding(reference), true);
      }),
    );
    assert.equal(isLocalEmbedding(DEFAULT_EMBEDDING), true);
    assert.equal(isLocalEmbedding("local/not-in-catalog"), false);
    assert.equal(isKnownEmbedding("local/not-in-catalog"), false);
  });

  it("远程清单与本地清单互斥且并集成全集；远程引用全过 isRemoteEmbedding", () => {
    fc.assert(
      fc.property(knownRemoteReferenceArb, (reference) => {
        assert.equal(isRemoteEmbedding(reference), true);
        assert.equal(isLocalEmbedding(reference), false);
        assert.equal(isKnownEmbedding(reference), true);
      }),
    );
  });

  it("清单自洽：本地 reference 唯一、维度为正、backend 落在三个后端的闭集内；远程 reference 唯一", () => {
    const references = LOCAL_EMBEDDINGS.map((option) => option.reference);
    assert.equal(new Set(references).size, references.length, "reference 必须唯一");
    const LOCAL_BACKENDS = new Set(["llama-cpp", "transformers-js", "model2vec"]);
    for (const option of LOCAL_EMBEDDINGS) {
      assert.ok(option.dimension > 0, option.reference);
      assert.ok(LOCAL_BACKENDS.has(option.backend), option.reference);
    }
    const remoteReferences = REMOTE_EMBEDDING_CATALOG.map((option) => option.reference);
    assert.equal(
      new Set(remoteReferences).size,
      remoteReferences.length,
      "远程 reference 必须唯一",
    );
    assert.equal(
      remoteReferences.some((reference) => references.includes(reference)),
      false,
      "两组清单不得相交",
    );
  });
});
