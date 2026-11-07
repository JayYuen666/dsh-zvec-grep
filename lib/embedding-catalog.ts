// lib/embedding-catalog.ts —— embedding 候选清单（本地 + 远程两组）。
// 数据源：zvec-grep 0.3.0 的模型目录（`zg --help models` 现量）。
// 本地组取其中 provider === 'local' 的条目（引用、后端、维度三列与上游帮助原文逐条核对一致）；
// 远程组取 provider === 'remote' 的三个 qwen 模型（上游 0.3.0 新增；引用与维度同源核对）。
// 这是卡片的单一数据源：host.ts（默认值校验）
// 与 src/client-entry.ts（<select> 候选）都从这里取；zg 自身在 index 时还会
// 二次校验，未知引用会拒绝，双保险。
//
// 本文件只有**数据**：模型引用、后端枚举、维度。卡片的 <select> 也只渲染这三位的投影
// （引用 + 维度，见 src/client-entry.ts），所以「哪档模型多大、要什么后端」是**选型说明**
// 而不是文案：它写在下面的分组注释里，不另立一张没有消费者的双语字典。

/** 本地后端白名单（单一来源）：联合类型由它推导，测试与运行时判据共用同一份。 */
export const LOCAL_EMBEDDING_BACKENDS = ["llama-cpp", "transformers-js", "model2vec"] as const;
export type LocalEmbeddingBackend = (typeof LOCAL_EMBEDDING_BACKENDS)[number];

/** 字段全 readonly：候选清单是不可变数据，消费者改写条目会造出「卡片显示的维度与
 *  zg 实际索引维度不一致」这类无报错的漂移，约束必须落在类型上。 */
export interface LocalEmbeddingOption {
  readonly reference: string;
  readonly backend: LocalEmbeddingBackend;
  readonly dimension: number;
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
 * 本地候选清单，按后端分三档（体积/语言规则，实测 zg v0.2.2）：
 *   - llama-cpp：qwen3-embedding-0.6b 约 640MB（本包默认）、
 *     embeddinggemma-300m 约 300MB（英文）——两档都要原生件，Metal 加速由 zg 侧 device=auto 试；
 *   - model2vec：potion-code-16m-v2 约 32MB（代码专用、最轻最快）、potion-multilingual-128m
 *     （多语言轻量）、potion-retrieval-32m（通用检索）——纯 JS worker，零原生依赖；
 *   - transformers-js：其余 ONNX 小模型，384 维那批是英文/多语言轻量档，768 维那批里
 *     jina 面向代码、gte/nomic 面向 8192 长文。
 */
const EMBEDDINGS: LocalEmbeddingOption[] = [
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

export const LOCAL_EMBEDDINGS: readonly LocalEmbeddingOption[] = Object.freeze(
  EMBEDDINGS.map((entry) => Object.freeze(entry)),
);

export function isLocalEmbedding(reference: string): boolean {
  const normalized = reference.trim();
  return LOCAL_EMBEDDINGS.some((entry) => entry.reference === normalized);
}

/**
 * 远程 embedding 候选清单（上游 0.3.0 新增的三个 qwen 远程模型，`zg --help models` 现量）。
 * 远程模型的语义与本地完全不同：索引/查询向量会把**工作区内容**送到上游端点，因此本包
 * 对它有三道独立的闸（见 lib/cli.ts 的 indexEmbedding 与 host.ts 的 allowRemoteEmbedding）：
 * 部署配置显式开放 + 命令带 `--allow-remote`（或用户预先 `zg --auth grant` 持久授权）+
 * 凭据只走环境变量。清单收进来的意义是「开放后能选哪些」是**闭集**——`allowRemote=true`
 * 放行的是这张清单，不是任意前缀的引用（`evil/http://attacker/x` 这类值在任何开关下都不放行）。
 */
/** 远程条目（维度与 token 上限取自上游帮助的 DIMS/TOKENS 两列）。 */
export interface RemoteEmbeddingOption {
  readonly reference: string;
  readonly dimension: number;
}

const REMOTE_EMBEDDINGS: RemoteEmbeddingOption[] = [
  { reference: "qwen/qwen3-vl-embedding", dimension: 2560 },
  { reference: "qwen/qwen3.7-text-embedding", dimension: 1024 },
  { reference: "qwen/text-embedding-v4", dimension: 1024 },
];

export const REMOTE_EMBEDDING_CATALOG: readonly RemoteEmbeddingOption[] = Object.freeze(
  REMOTE_EMBEDDINGS.map((entry) => Object.freeze(entry)),
);

export function isRemoteEmbedding(reference: string): boolean {
  const normalized = reference.trim();
  return REMOTE_EMBEDDING_CATALOG.some((entry) => entry.reference === normalized);
}

/** 构造期 allowlist 的全集：本地 ∪ 远程。未知引用在任何部署开关下都不放行。 */
export function isKnownEmbedding(reference: string): boolean {
  return isLocalEmbedding(reference) || isRemoteEmbedding(reference);
}
