// lib/embedding-catalog.ts 单元测试：清单完整性 + 默认值 + 引用查找判据。
// 清单只有数据（引用/后端/维度）；候选的体积与语言口径是选型说明，留在
// lib/embedding-catalog.ts 的注释里——卡片 <select> 只渲染「引用（N维）」，
// 没有第二处需要翻译的地方，故这里不再对一张文案表配对。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { DEFAULT_EMBEDDING, LOCAL_EMBEDDINGS, isLocalEmbedding } from "../lib/embedding-catalog.ts";

const VALID_BACKENDS = new Set(["llama-cpp", "transformers-js", "model2vec"]);

describe("本地候选清单（LOCAL_EMBEDDINGS）", () => {
  it("恰好 11 个本地候选", () => {
    assert.equal(LOCAL_EMBEDDINGS.length, 11);
  });

  it("reference 唯一", () => {
    const refs = LOCAL_EMBEDDINGS.map((entry) => entry.reference);
    assert.equal(new Set(refs).size, refs.length);
  });

  it("每个条目 backend 合法、维度为正", () => {
    for (const entry of LOCAL_EMBEDDINGS) {
      assert.ok(VALID_BACKENDS.has(entry.backend), `bad backend: ${entry.reference}`);
      assert.ok(entry.dimension > 0, `bad dimension: ${entry.reference}`);
    }
  });
});

// 套件名写 DEFAULT_EMBEDDING 的**值**（valid-title 只收字符串字面量）：打印出来的名字与
// 原来逐字相同，而下面那条用例把这个值钉在同一个串上，值漂移时这里与用例各红一次。
describe("local/qwen3-embedding-0.6b", () => {
  it("默认是本地最强 qwen3-embedding-0.6b", () => {
    assert.equal(DEFAULT_EMBEDDING, "local/qwen3-embedding-0.6b");
  });

  it("默认值在候选清单中", () => {
    assert.ok(isLocalEmbedding(DEFAULT_EMBEDDING));
  });
});

describe("isLocalEmbedding", () => {
  it("候选内返回 true", () => {
    assert.ok(isLocalEmbedding("local/potion-code-16m-v2"));
    assert.ok(isLocalEmbedding("local/multilingual-e5-small"));
  });

  it("候选外返回 false", () => {
    assert.equal(isLocalEmbedding("qwen/text-embedding-v4"), false);
    assert.equal(isLocalEmbedding("local/nope"), false);
  });
});
