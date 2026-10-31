// zg 结构化失败识别层与 embedding 清单的属性面：随机 stderr（噪声行 + 结构行混排）下，
// 码抽取、明细表、并发失败归类必须与「只认认得出的形状、认不出不猜」的契约一致。
// 期望值由测试内的独立 oracle（按 lib/zg-errors.ts 头注写明的输出形状协议实现）给出。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  classifyConcurrentFailure,
  DAEMON_LEASE_CODE,
  LOCK_BUSY_CODE,
  REBUILD_OPERATION,
  zgErrorDetails,
  zgErrorCode,
} from "../../lib/zg-errors.ts";
import {
  DEFAULT_EMBEDDING,
  isLocalEmbedding,
  LOCAL_EMBEDDINGS,
} from "../../lib/embedding-catalog.ts";

/** 不含换行、不以 Code:/Details: 开头的噪声行（保证 oracle 里结构行的位置可控）。 */
const noiseLineArb = fc
  .string({ maxLength: 30 })
  .filter(
    (line) => !line.includes("\n") && !/^\s*Code:/u.test(line) && !/^\s*Details:\s*$/u.test(line),
  );

/** zg 风格的错误码：单一大写 token，且不与两个已知码相撞。 */
const unknownCodeArb = fc
  .stringMatching(/^[A-Z][A-Z0-9._]{2,29}$/u)
  .filter((code) => code !== LOCK_BUSY_CODE && code !== DAEMON_LEASE_CODE);

/** 明细键：字母开头 + [\w-]。 */
const detailKeyArb = fc.stringMatching(/^[A-Za-z][\w-]{0,15}$/u);
/** 明细值：非空白开头、无换行（明细行协议只保证这些）。 */
const detailValueArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((value) => !value.includes("\n") && !/^\s/u.test(value));

const detailPairArb = fc.tuple(detailKeyArb, detailValueArb);
const detailPairListArb = fc.array(detailPairArb, { maxLength: 4 });
const duplicateKeyListArb = fc.array(detailKeyArb, { minLength: 1, maxLength: 2 });
const maybeOwnerOperationArb = fc.option(detailValueArb, { nil: undefined });
const knownReferenceArb = fc.constantFrom(...LOCAL_EMBEDDINGS.map((option) => option.reference));

/** 两个本地后端之外的取值集合（用 Set 而不是字面量链，收窄规则不需要参与）。 */
const LOCAL_BACKENDS = new Set(["llama-cpp", "transformers-js", "model2vec"]);

describe("zgErrorCode 对「Code: 行协议」", () => {
  it("有码行抽首条；无码行返回 undefined，绝不从散文里猜", () => {
    fc.assert(
      fc.property(
        fc.array(noiseLineArb, { maxLength: 3 }),
        fc.array(noiseLineArb, { maxLength: 3 }),
        unknownCodeArb,
        fc.boolean(),
        (before, after, code, present) => {
          const lines = [...before];
          if (present) {
            lines.push(`Code: ${code}`);
          }
          lines.push(...after);
          assert.equal(zgErrorCode(lines.join("\n")), present ? code : undefined);
        },
      ),
    );
  });

  it("码行带尾注（Code: XXX (detail)）按形状已变处理：宁可不判", () => {
    assert.equal(zgErrorCode("Error: x\nCode: ZVEC_GREP.ENGINE.LOCK.BUSY (owner=1)\n"), undefined);
  });

  it("首条码行胜出：两条码行不顺延到后一条", () => {
    fc.assert(
      fc.property(unknownCodeArb, unknownCodeArb, (first, second) => {
        fc.pre(first !== second);
        const stderr = `Code: ${first}\nmid\nCode: ${second}\n`;
        assert.equal(zgErrorCode(stderr), first);
      }),
    );
  });
});

describe("zgErrorDetails 对「缩进键值」协议", () => {
  it("明细表收 Details: 之后的缩进行（重复键取首次），非键值行终止；值按协议去尾随空白", () => {
    fc.assert(
      fc.property(detailPairListArb, duplicateKeyListArb, (pairs, duplicateKeys) => {
        const lines: string[] = ["Error: boom", `Code: ${LOCK_BUSY_CODE}`, "Details:"];
        const expected = new Map<string, string>();
        for (const [key, value] of pairs) {
          lines.push(`  ${key}: ${value}   `);
          if (!expected.has(key)) {
            expected.set(key, value.trimEnd());
          }
        }
        // 重复键行本身也是合法明细行，只是不覆盖已有键。
        for (const key of duplicateKeys) {
          lines.push(`  ${key}: LATER-VALUE`);
          if (!expected.has(key)) {
            expected.set(key, "LATER-VALUE");
          }
        }
        lines.push("Hint: this prose ends the block");
        const details = zgErrorDetails(lines.join("\n"));
        assert.equal(details.size, expected.size);
        for (const [key, value] of expected) {
          assert.equal(details.get(key), value);
        }
      }),
    );
  });

  it("没有 Code 行时绝不捡明细（头注钉住的那一支）", () => {
    fc.assert(
      fc.property(detailPairArb, ([key, value]) => {
        const stderr = ["Error: boom", "Details:", `  ${key}: ${value}`].join("\n");
        assert.equal(zgErrorDetails(stderr).size, 0);
      }),
    );
  });

  it("码行与 Details: 之间夹一条零缩进内容：这一块没有明细", () => {
    fc.assert(
      fc.property(detailPairArb, ([key, value]) => {
        const stderr = [
          `Code: ${LOCK_BUSY_CODE}`,
          "some prose between blocks",
          "Details:",
          `  ${key}: ${value}`,
        ].join("\n");
        assert.equal(zgErrorDetails(stderr).size, 0);
      }),
    );
  });
});

describe("classifyConcurrentFailure 的归类面", () => {
  it("lock-busy 归类：rebuild 只认占锁方自报 index.rebuild", () => {
    fc.assert(
      fc.property(maybeOwnerOperationArb, (ownerOperation) => {
        const lines = [`Code: ${LOCK_BUSY_CODE}`, "Details:"];
        if (ownerOperation !== undefined) {
          lines.push(`  ownerOperation: ${ownerOperation}`);
        }
        const classified = classifyConcurrentFailure(lines.join("\n"));
        if (classified?.kind !== "lock-busy") {
          assert.fail("LOCK_BUSY_CODE 必须归类为 lock-busy");
        }
        assert.equal(classified.ownerOperation, ownerOperation?.trimEnd());
        assert.equal(classified.rebuild, ownerOperation?.trimEnd() === REBUILD_OPERATION);
      }),
    );
  });

  it("daemon-lease 归类并带 pid；其余码与无码一律 null", () => {
    fc.assert(
      fc.property(detailValueArb, unknownCodeArb, (pid, unknownCode) => {
        const leaseStderr = [`Code: ${DAEMON_LEASE_CODE}`, "Details:", `  pid: ${pid}`].join("\n");
        const lease = classifyConcurrentFailure(leaseStderr);
        if (lease?.kind !== "daemon-lease") {
          assert.fail("DAEMON_LEASE_ACTIVE 必须归类为 daemon-lease");
        }
        assert.equal(lease.pid, pid.trimEnd());
        assert.equal(classifyConcurrentFailure(`Code: ${unknownCode}\n`), null);
        assert.equal(classifyConcurrentFailure("plain failure without structure\n"), null);
      }),
    );
  });
});

describe("embedding 清单的结构不变量", () => {
  it("isLocalEmbedding 与清单成员一一对应；默认模型必在清单内", () => {
    fc.assert(
      fc.property(knownReferenceArb, (reference) => {
        assert.equal(isLocalEmbedding(reference), true);
      }),
    );
    assert.equal(isLocalEmbedding(DEFAULT_EMBEDDING), true);
    assert.equal(isLocalEmbedding("local/not-in-catalog"), false);
    assert.equal(isLocalEmbedding("qwen/qwen3-embedding-0.6b"), false);
  });

  it("清单自洽：reference 唯一、维度为正、backend 落在三个后端的闭集内", () => {
    const references = LOCAL_EMBEDDINGS.map((option) => option.reference);
    assert.equal(new Set(references).size, references.length, "reference 必须唯一");
    for (const option of LOCAL_EMBEDDINGS) {
      assert.ok(option.dimension > 0, option.reference);
      assert.ok(LOCAL_BACKENDS.has(option.backend), option.reference);
    }
  });
});
