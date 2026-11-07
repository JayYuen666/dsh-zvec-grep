// lib/embedding-catalog.ts 单元测试：清单完整性 + 默认值 + 引用查找判据。
// 清单只有数据（引用/后端/维度）；候选的体积与语言规则是选型说明，留在
// lib/embedding-catalog.ts 的注释里——卡片 <select> 只渲染「引用（N维）」，
// 没有第二处需要翻译的地方，故这里不再对一张文案表配对。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  DEFAULT_EMBEDDING,
  LOCAL_EMBEDDINGS,
  LOCAL_EMBEDDING_BACKENDS,
  isLocalEmbedding,
} from "../lib/embedding-catalog.ts";

const VALID_BACKENDS = new Set<string>(LOCAL_EMBEDDING_BACKENDS);
/** 边界用例与快照共用同一串引用：字面量只写一次。 */
const POTION_CODE = "local/potion-code-16m-v2";
const POTION_MULTILINGUAL = "local/potion-multilingual-128m";
const QWEN3_EMBEDDING = "local/qwen3-embedding-0.6b";

describe("本地候选清单（LOCAL_EMBEDDINGS）", () => {
  it("候选集快照（数量与内容一起锁，红时 diff 直接点名增删/改名的那条）", () => {
    const [LLAMA_CPP, TRANSFORMERS_JS, MODEL2VEC] = LOCAL_EMBEDDING_BACKENDS;
    // 快照按 lib 清单原序逐条抄：reference/backend/dimension 三位对齐 zg catalog 实量。
    assert.deepEqual(
      LOCAL_EMBEDDINGS.map((entry) => [entry.reference, entry.backend, entry.dimension]),
      [
        [QWEN3_EMBEDDING, LLAMA_CPP, 1024],
        ["local/embeddinggemma-300m", LLAMA_CPP, 768],
        [POTION_CODE, MODEL2VEC, 256],
        [POTION_MULTILINGUAL, MODEL2VEC, 256],
        ["local/potion-retrieval-32m", MODEL2VEC, 512],
        ["local/bge-small-en-v1.5", TRANSFORMERS_JS, 384],
        ["local/all-minilm-l6-v2", TRANSFORMERS_JS, 384],
        ["local/multilingual-e5-small", TRANSFORMERS_JS, 384],
        ["local/jina-embeddings-v2-base-code", TRANSFORMERS_JS, 768],
        ["local/gte-modernbert-base", TRANSFORMERS_JS, 768],
        ["local/nomic-embed-text-v1.5", TRANSFORMERS_JS, 768],
      ],
      "清单与快照漂移：合法增删模型时请连同这条快照一起改——它是本仓与 zg catalog 对齐的门禁",
    );
  });

  it("reference 唯一", () => {
    const refs = LOCAL_EMBEDDINGS.map((entry) => entry.reference);
    assert.equal(new Set(refs).size, refs.length);
  });

  it("每个条目 backend 合法、维度与 zg catalog 逐条一致、reference 带 local/ 前缀", () => {
    for (const entry of LOCAL_EMBEDDINGS) {
      assert.ok(VALID_BACKENDS.has(entry.backend), `bad backend: ${entry.reference}`);
      // 维度只验 >0 时，把 1024 改成 1025 或把 all-minilm 写成 512 都照样绿——
      // 恰好漏掉这条门最该守的漂移；具体值已由上面的快照逐条钉死，这里保留
      // 「维度为正」作为形状兜底。
      assert.ok(entry.dimension > 0, `bad dimension: ${entry.reference}`);
      assert.ok(
        entry.reference.startsWith("local/"),
        `reference 必须 local/ 前缀: ${entry.reference}`,
      );
    }
  });
});

// 套件名写 DEFAULT_EMBEDDING 的**值**：与下面那条用例钉在同一个串上，值漂移时这里与
// 用例各红一次。（valid-title 只收字符串字面量，故引用常量而不是模板串。）
describe("local/qwen3-embedding-0.6b", () => {
  it("默认是本地最强 qwen3-embedding-0.6b", () => {
    assert.equal(DEFAULT_EMBEDDING, QWEN3_EMBEDDING);
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

  it("匹配语义：输入先 trim 再精确比对（大小写敏感、不做前缀匹配）", () => {
    const base = POTION_CODE;
    // 实现是 `reference.trim()` 后 ===：尾随空格命中是**设计内的宽容**（照抄引用常见），
    // 这里钉住的是这个语义而不是想象中的严格 ===；大小写与前缀仍须不命中。
    assert.equal(isLocalEmbedding(`${base} `), true, "尾随空格被 trim 后命中");
    assert.equal(isLocalEmbedding(base.toUpperCase()), false, "大小写变形不命中");
    assert.equal(isLocalEmbedding(`${base}-extra`), false, "仅前缀不命中");
  });
});
