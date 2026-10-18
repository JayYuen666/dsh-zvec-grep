// src/rebuild-reader.ts —— 设置卡读**宿主侧工作区重建**的那一面（官方 Typert Remote 的消费侧）。
//
// 为什么需要它：卡片跑在浏览器里，而重建是宿主进程里的动作（占位、官方作业注册表、zg
// 子进程）。设置面没有「宿主执行动作」的口子，唯一的官方通道就是 Remote。
//
// 为什么 descriptor 是**手写**的：宿主网关在源模式（SRC）下从方法签名推参数名，参数与
// 结果都走 `{ mode: "src-json" }`，不需要生成器的 `typeSymbol` / `create()` 产物。但**客户端**
// 的贡献校验（`$mount` → `requireStrictCodec`）要求每个入参都带 strict codec，非 strict 会
// 拒绝整份贡献。于是这里的入参 codec 写成 strict 的手写 parser：它只在客户端做形状校验，
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

/** 启动请求的客户端 parser：只核本方法真正读的那一位（`root` 是串）。 */
const START_CODEC: TypertCodec<RebuildStartRequest> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#rebuild-request`,
  create: () => ({
    parse(value: unknown): RebuildStartRequest {
      if (!isRecord(value) || typeof value["root"] !== "string") {
        throw new TypeError("rebuild request requires a string root");
      }
      return { root: value["root"] };
    },
  }),
};

/** 轮询请求的客户端 parser（同上）。 */
const STATUS_CODEC: TypertCodec<RebuildStatusRequest> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#rebuild-status-request`,
  create: () => ({
    parse(value: unknown): RebuildStatusRequest {
      if (!isRecord(value) || typeof value["jobId"] !== "string") {
        throw new TypeError("rebuild status request requires a string jobId");
      }
      return { jobId: value["jobId"] };
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
 * 造出真正的读取器（挂载一次 + 每次读命名空间服务）。
 * @param ctx - 客户端上下文
 * @param remote - 已核过形状的远程面
 * @returns 读取器
 */
function buildRebuildReader(ctx: RemoteHost, remote: RemoteMounter): RebuildReader {
  let mounted: Promise<unknown> | undefined;
  const namespaceOf = async (): Promise<RebuildNamespace> => {
    mounted ??= remote.$mount({ package: PACKAGE_NAME, descriptors: REBUILD_DESCRIPTORS });
    await mounted;
    const namespace = ctx.get?.(REBUILD_SERVICE_KEY, false);
    if (!isRebuildNamespace(namespace)) {
      throw new Error(`${REBUILD_SERVICE_KEY} 未提供：宿主网关没有挂上这枚命名空间`);
    }
    return namespace;
  };
  return {
    async roots(): Promise<RebuildRoots> {
      const ns = await namespaceOf();
      const result = await ns.roots();
      if (!result.ok) {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      return result.value;
    },
    async rebuild(root: string): Promise<RebuildStartResult & { ok: true }> {
      const ns = await namespaceOf();
      const result = await ns.rebuild({ root });
      if (!result.ok) {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      if (!result.value.ok) {
        throw new Error(result.value.error);
      }
      return result.value;
    },
    async status(jobId: string): Promise<Record<string, unknown>> {
      const ns = await namespaceOf();
      const result = await ns.status({ jobId });
      if (!result.ok) {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      if (!result.value.ok) {
        throw new Error(result.value.error);
      }
      // 摊平成普通对象：卡片侧那层解析只认 `status/exitCode/output` 三个键。
      return { ...result.value };
    },
  };
}

/**
 * 造一个「读宿主侧工作区重建」的读取器；**当前部署没有远程面时返回 `undefined`**
 * （卡片照常渲染，只是点重建时给出错误 —— 与 host 侧可选读面同一条口径）。
 *
 * `$mount` 是**幂等**的（挂进本 fiber，随卡片卸载自动撤），所以这里缓存那枚 promise：
 * 同一次会话里反复轮询只挂一次。
 *
 * @param ctx - 客户端上下文（只用 `get` 一位）
 * @returns 读取器；没有远程面时 `undefined`
 */
export function createRebuildReader(ctx: RemoteHost): RebuildReader | undefined {
  const remote = ctx.get?.("remote");
  // 单 return（三元的另一支是 `undefined`）：`consistent-return` 不接受"早退 undefined + 晚退函数"
  // 这种混合形状，而这里两种结果本来就是同一件事的两面。
  return isRemoteMounter(remote) ? buildRebuildReader(ctx, remote) : undefined;
}
