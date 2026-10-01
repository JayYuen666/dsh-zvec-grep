// zvec-grep 本地 embedding 候选清单。
// 数据源：zg v0.2.1 的 EMBEDDING_MODEL_CATALOG（src/engine/models/catalog.ts）中
// 所有 provider === 'local' 的条目。这是卡片的单一数据源：host.ts（默认值校验）
// 与 src/client-entry.ts（<select> 候选）都从这里取；zg 自身在 index 时还会
// 用 requireEmbeddingModelCatalogEntry 二次校验，未知引用会拒绝，双保险。
//
// 本文件只有**数据**：模型引用、后端枚举、维度。卡片的 <select> 也只渲染这三位的投影
// （引用 + 维度，见 src/client-entry.ts），所以「哪档模型多大、要什么后端」是**选型说明**
// 而不是文案：它写在下面的分组注释里，不另立一张没有消费者的双语字典。

export type LocalEmbeddingBackend = "llama-cpp" | "transformers-js" | "model2vec";

export interface LocalEmbeddingOption {
  reference: string;
  backend: LocalEmbeddingBackend;
  dimension: number;
}

/** 默认模型：本地最强（1024 维 / 8192 上下文 / 中英通用），约 640MB 一次性下载。 */
export const DEFAULT_EMBEDDING = "local/qwen3-embedding-0.6b";

/**
 * transformers.js 后端的 id。清单里 384/768 维的那批纯 JS ONNX 小模型都挂这一档，
 * 故取值归一处；带 `LocalEmbeddingBackend` 标注，枚举成员改名时这里当场编译红，
 * 而不是静默产出一个不在联合里的字符串。
 */
const TRANSFORMERS_JS_BACKEND: LocalEmbeddingBackend = "transformers-js";

/**
 * 本地候选清单，按后端分三档（体积/语言口径，实测 zg v0.2.1）：
 *   - llama-cpp：qwen3-embedding-0.6b 约 640MB（本包默认）、
 *     embeddinggemma-300m 约 300MB（英文）——两档都要原生件，Metal 加速由 zg 侧 device=auto 试；
 *   - model2vec：potion-code-16m-v2 约 32MB（代码专用、最轻最快）、potion-multilingual-128m
 *     （多语言轻量）、potion-retrieval-32m（通用检索）——纯 JS worker，零原生依赖；
 *   - transformers-js：其余 ONNX 小模型，384 维那批是英文/多语言轻量档，768 维那批里
 *     jina 面向代码、gte/nomic 面向 8192 长文。
 */
export const LOCAL_EMBEDDINGS: readonly LocalEmbeddingOption[] = [
  {
    reference: "local/qwen3-embedding-0.6b",
    backend: "llama-cpp",
    dimension: 1024,
  },
  {
    reference: "local/embeddinggemma-300m",
    backend: "llama-cpp",
    dimension: 768,
  },
  {
    reference: "local/potion-code-16m-v2",
    backend: "model2vec",
    dimension: 256,
  },
  {
    reference: "local/potion-multilingual-128m",
    backend: "model2vec",
    dimension: 256,
  },
  {
    reference: "local/potion-retrieval-32m",
    backend: "model2vec",
    dimension: 512,
  },
  {
    reference: "local/bge-small-en-v1.5",
    backend: TRANSFORMERS_JS_BACKEND,
    dimension: 384,
  },
  {
    reference: "local/all-minilm-l6-v2",
    backend: TRANSFORMERS_JS_BACKEND,
    dimension: 384,
  },
  {
    reference: "local/multilingual-e5-small",
    backend: TRANSFORMERS_JS_BACKEND,
    dimension: 384,
  },
  {
    reference: "local/jina-embeddings-v2-base-code",
    backend: TRANSFORMERS_JS_BACKEND,
    dimension: 768,
  },
  {
    reference: "local/gte-modernbert-base",
    backend: TRANSFORMERS_JS_BACKEND,
    dimension: 768,
  },
  {
    reference: "local/nomic-embed-text-v1.5",
    backend: TRANSFORMERS_JS_BACKEND,
    dimension: 768,
  },
];

export function isLocalEmbedding(reference: string): boolean {
  return LOCAL_EMBEDDINGS.some((entry) => entry.reference === reference);
}
