// src/rebuild-reader.ts —— 设置卡读**宿主侧工作区重建**的那一面（官方 Typert Remote 的消费侧）。
//
// 为什么需要它：卡片跑在浏览器里，而重建是宿主进程里的动作（占位、官方作业注册表、zg
// 子进程）。设置面没有「宿主执行动作」的口子，唯一的官方通道就是 Remote。
//
// 为什么 descriptor 是**手写**的：宿主网关在源模式（SRC）下从方法签名推参数名，参数与
// 结果都走 `{ mode: "src-json" }`，不需要生成器的 `typeSymbol` / `create()` 产物。但**客户端**
// 的贡献校验（`$mount` → `requireStrictCodec`）要求每个入参都带 strict codec，非 strict 会
// 拒绝整份贡献。于是这里的入参 codec 写成 strict 的 zod schema：它只在客户端做形状校验，
// 从不跨网；宿主那边仍按源模式从签名取参数名。
//
// ⚠ **为什么走 `ctx.get("remote")` 而不是把 `remote` 写进 `inject`**：cordis 对**未 inject 的
// 服务**读取是**抛错**（`cannot get property "remote" without inject`）。而本卡的其余部分在
// "没装远程面"的部署里也必须照常渲染（远程读面是可选能力），`inject: ["remote", …]` 却会把
// 整条 client 入口绑死在远程面上——缺它就不激活。`ctx.get` 是**显式读取**，不受 inject 门禁
// 约束——官方网关自己也是这么读可选服务的。
//
// ⚠ 类型一律 `import type`（产物里零新说明符）：`@deepseek-ai/*` 只作类型消费。
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from "@deepseek-ai/dsh-typert-protocol";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { z } from "zod";

import type {
  RebuildRoots,
  RebuildStartRequest,
  RebuildStartResult,
  RebuildStatusRequest,
  RebuildStatusResult,
} from "../lib/rebuild-shape.ts";

import { REBUILD_REMOTE_NAMESPACE } from "../lib/rebuild-shape.ts";

const REBUILD_NAMESPACE = REBUILD_REMOTE_NAMESPACE;

/** 网关给命名空间注册的**服务键**：`remote.<namespace>`。它在 `$mount` 完成之后才存在，
 *  所以只能在挂载后按这个键去读，而不是提前 inject。 */
const REBUILD_SERVICE_KEY = `remote.${REBUILD_NAMESPACE}`;

/** 卡片所在 bundle 的包名（`$mount` 的 `package` 位与槽位键同源，见 client-entry.ts 的 BUNDLE_PKG）。 */
const PACKAGE_NAME = "@jayyuen66/dsh-zvec-grep";

/** strict codec 的统一出口：失败交给 zod 的 `prettifyError`，读到的是一份带字段路径的说明。 */
function parseOrThrow<Result>(schema: z.ZodType<Result>, value: unknown): Result {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

const START_SCHEMA = z.object(
  {
    // 非空是必要判据：空 root 在宿主侧会被当成「没给路径」再退到默认工作区，而卡片这边
    // 以为重建的是用户选的那一个。
    root: z
      .string({ error: "rebuild request requires a string root" })
      .trim()
      .min(1, { error: "rebuild request requires a non-empty root" }),
  },
  { error: "rebuild request requires a string root" },
);

const STATUS_SCHEMA = z.object(
  {
    // jobId 来自宿主回执，空串只可能是回执形状坏了：在这里拦下，别让它换成一个无意义的轮询。
    jobId: z
      .string({ error: "rebuild status request requires a string jobId" })
      .trim()
      .min(1, { error: "rebuild status request requires a non-empty jobId" }),
  },
  { error: "rebuild status request requires a string jobId" },
);

/** 启动请求的客户端 parser：只核本方法真正读的那一位（`root` 是串）。 */
const START_CODEC: TypertCodec<RebuildStartRequest> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#rebuild-request`,
  create: () => ({
    parse(value: unknown): RebuildStartRequest {
      return parseOrThrow(START_SCHEMA, value);
    },
  }),
};

/** 轮询请求的客户端 parser（同上）。 */
const STATUS_CODEC: TypertCodec<RebuildStatusRequest> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#rebuild-status-request`,
  create: () => ({
    parse(value: unknown): RebuildStatusRequest {
      return parseOrThrow(STATUS_SCHEMA, value);
    },
  }),
};

/** 把宿主那三个方法挂到客户端远程面上的描述符（`id` 的形状照生成器：`<包>#<命名空间>/<方法>`）。
 *  导出它只为一件事：`test/rebuild-remote.test.ts` 拿它与宿主侧 `remoteMethods()` 的标记对质
 *  —— 两侧分叉时卡片不会报错，只会"读不到"，所以那条比较必须在门禁里。 */
export const REBUILD_DESCRIPTORS: readonly InvocationDescriptor[] = [
  {
    id: `${PACKAGE_NAME}#${REBUILD_NAMESPACE}/roots`,
    service: REBUILD_NAMESPACE,
    namespace: REBUILD_NAMESPACE,
    method: "roots",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${REBUILD_NAMESPACE}/rebuild`,
    service: REBUILD_NAMESPACE,
    namespace: REBUILD_NAMESPACE,
    method: "rebuild",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: START_CODEC }],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${REBUILD_NAMESPACE}/status`,
    service: REBUILD_NAMESPACE,
    namespace: REBUILD_NAMESPACE,
    method: "status",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: STATUS_CODEC }],
    result: { mode: "src-json" },
  },
];

/** 客户端上下文里本模块用到的那一位：**显式读取**一个可选服务（见文件头为什么不用 inject）。 */
export interface RemoteHost {
  get?: (name: string, strict?: boolean) => unknown;
}

/** 官方网关的客户端服务面：本卡只用 `$mount` 一位（挂载一枚手写贡献）。 */
interface RemoteMounter {
  $mount: (contribution: {
    package: string;
    descriptors: readonly InvocationDescriptor[];
  }) => Promise<unknown>;
}

/** 挂载后由网关提供的命名空间服务面（方法名 = descriptor.method，位置参数）。 */
interface RebuildNamespace {
  roots: () => Promise<RemoteResult<RebuildRoots>>;
  rebuild: (request: RebuildStartRequest) => Promise<RemoteResult<RebuildStartResult>>;
  status: (request: RebuildStatusRequest) => Promise<RemoteResult<RebuildStatusResult>>;
}

/** 卡片用到的读取器：三个方法与宿主服务一一对应，失败一律抛出（卡片照旧显示错误文本）。 */
export interface RebuildReader {
  roots: () => Promise<RebuildRoots>;
  rebuild: (root: string) => Promise<RebuildStartResult & { ok: true }>;
  status: (jobId: string) => Promise<Record<string, unknown>>;
}

/** 这个值能当远程面用吗（只核我们要调的那一位；服务来自别的实现或版本时保守当作没有）。 */
const isRemoteMounter = (value: unknown): value is RemoteMounter =>
  isRecord(value) && typeof value["$mount"] === "function";

/** 同上：命名空间服务（挂载之后才有，缺它说明网关没认这枚贡献）。 */
const isRebuildNamespace = (value: unknown): value is RebuildNamespace =>
  isRecord(value) &&
  typeof value["roots"] === "function" &&
  typeof value["rebuild"] === "function" &&
  typeof value["status"] === "function";

/**
 * 线上拒绝（result.ok=false）翻成异常：code 与 message 都来自网关的错误对象。
 * 三个方法同构，收成一个入口——同一份判据，不抄三份。
 */
async function unwrapWire<Value>(
  call: Promise<
    { ok: false; error: { code: string; message: string } } | { ok: true; value: Value }
  >,
): Promise<Value> {
  const result = await call;
  // 两个分支都写成真实语句（if-return / throw）：裸 if-throw 的隐式空 else 在 v8 的块覆盖
  // 里会记成一个无处落位的空块，整包 100% 门禁会被这条伪块随机打红。
  if (result.ok) {
    return result.value;
  }
  throw new Error(`${result.error.code}: ${result.error.message}`);
}

/**
 * 造出真正的读取器（remote 每次现读 + 挂载只在成功后缓存）。
 * @param ctx - 客户端上下文
 * @returns 读取器
 */
function buildRebuildReader(ctx: RemoteHost): RebuildReader {
  let mounted: Promise<unknown> | undefined;
  const namespaceOf = async (): Promise<RebuildNamespace> => {
    // remote 是未写进 inject 的可选服务，cordis 不保证提供方在卡片 apply 之前完成注册：
    // 每次调用现读（与宿主侧可选服务的既定口径一致），缺席时点名抛错——把 apply 期读到
    // 的 undefined 定死，读取器就永远起不来，且没有任何时机重新解析。
    const mounter = ctx.get?.("remote");
    if (!isRemoteMounter(mounter)) {
      throw new Error("工作区重建读面不可用：宿主网关没有提供 remote 服务");
    }
    try {
      mounted ??= mounter.$mount({ package: PACKAGE_NAME, descriptors: REBUILD_DESCRIPTORS });
      await mounted;
    } catch (error) {
      // 挂载失败不留在缓存里：rejected promise 一旦复用，之后每次轮询（含 2s 一次的
      // status）都会撞同一个 rejection，重试永远不会发生。
      //
      // 直接清空即可，不需要「只清自己那一枚」的比较：`mounted ??=` 在 await **之前**
      // 赋值，所以在它被拒之前，缓存里不可能出现「另一枚更新的、已成功的」promise——
      // 新的挂载只有在本行清空之后才可能发生。
      mounted = undefined;
      throw error;
    }
    // 与上面读 `remote` 用同一档 strict（`ctx.get` 的默认值）：两处都以「提供方 fiber 此刻
    // 有效」为准。这里原先显式传 `false`（连未激活的提供方也交回），与上一处的判据不一致——
    // 命名空间是刚刚 `$mount` 挂上去的，提供方就在本卡这条活动链上，放宽读只会读到一个
    // 已经卸下的实现。
    const namespace = ctx.get?.(REBUILD_SERVICE_KEY);
    if (!isRebuildNamespace(namespace)) {
      throw new Error(`${REBUILD_SERVICE_KEY} 未提供：宿主网关没有挂上这枚命名空间`);
    }
    return namespace;
  };
  return {
    async roots(): Promise<RebuildRoots> {
      const ns = await namespaceOf();
      return unwrapWire(ns.roots());
    },
    async rebuild(root: string): Promise<RebuildStartResult & { ok: true }> {
      const ns = await namespaceOf();
      const value = await unwrapWire(ns.rebuild({ root }));
      if (value.ok) {
        return value;
      }
      throw new Error(value.error);
    },
    async status(jobId: string): Promise<Record<string, unknown>> {
      const ns = await namespaceOf();
      const value = await unwrapWire(ns.status({ jobId }));
      // 摊平成普通对象：卡片侧那层解析只认 `status/exitCode/output` 三个键。
      if (value.ok) {
        return { ...value };
      }
      throw new Error(value.error);
    },
  };
}

/**
 * 造一个「读宿主侧工作区重建」的读取器；**连 ctx.get 面都不在时返回 `undefined`**
 * （卡片照常渲染，点重建时给出错误）。remote 服务是否在场**不在这一步判**：
 * 解析推迟到每次调用（见 buildRebuildReader），apply 期它可能还没注册。
 *
 * `$mount` 是**幂等**的（挂进本 fiber，随卡片卸载自动撤），成功后缓存那枚 promise：
 * 同一次会话里反复轮询只挂一次；失败则清缓存，下一次调用重新挂。
 *
 * @param ctx - 客户端上下文（只用 `get` 一位）
 * @returns 读取器；ctx 没有 get 面时 `undefined`
 */
export function createRebuildReader(ctx: RemoteHost): RebuildReader | undefined {
  // 单 return（三元的另一支是 `undefined`）：`consistent-return` 不接受"早退 undefined + 晚退函数"
  // 这种混合形状，而这里两种结果本来就是同一件事的两面。
  return typeof ctx.get === "function" ? buildRebuildReader(ctx) : undefined;
}
