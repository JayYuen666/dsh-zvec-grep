// lib/rebuild-shape.ts —— 工作区重建（Typert Remote）两侧共用的**线上形状**。
//
// 为什么单列：宿主侧的服务实现与客户端读取器分属两个产物（host.js / client.js），
// 各自内联一份 lib/。把形状放在这个零依赖叶子上，两边引的是同一份声明；写成
// `import type` 后对任一产物的字节数贡献都是零。
//
// 状态词表照抄官方作业注册表的五种取值（running / stopping / completed / killed /
// failed）。这里独立写死而不是从 `@deepseek-ai/dsh-jobs` 借类型：客户端类型程序不该
// 被拖进宿主包的类型图，而服务侧把 `view.status` 赋给这个联合时，官方一旦增删状态词
// 就是编译错误——漂移仍由眼睛之外的东西钉住。

/** 宿主服务键 = 客户端线上命名空间（两侧共用的唯一来源）。 */
export const REBUILD_REMOTE_NAMESPACE = "zvecGrepRebuild";

/** 官方作业状态在卡片契约里的取值域。 */
export type RebuildJobStatus = "running" | "stopping" | "completed" | "killed" | "failed";

/** 引导读面：白名单里的工作区 + 守护进程就绪态。
 *  `serverReady` 的 undefined 是**必要**的一臂：读不到这一位时卡片不显示，而不是把
 *  「不知道」说成「未就绪」（判据收在 lib/card-logic.ts 的 daemonNoteKey）。 */
export interface RebuildRoots {
  readonly roots: readonly string[];
  readonly serverReady: boolean | undefined;
}

/** 启动请求：wire 字段名与宿主方法的参数名同源（源码模式下网关按签名取参数名）。 */
export interface RebuildStartRequest {
  readonly root: string;
}

export interface RebuildStarted {
  readonly ok: true;
  readonly jobId: string;
  /** 同根已有一条在跑，这次没有新起进程——卡片据此知道跟随的是旧作业。 */
  readonly reused?: true;
}

/**
 * 旧 HTTP 面留给拒绝应答的语义码，逐字取自构造点的实发值（lib/rebuild-remote.ts 的
 * 400/403/404/409/500/503）。收敛成字面量联合而不是裸 `number`：构造点误填别的数字
 * 在编译期就红，而不是带着一个没人认识的码上线。客户端只读 error，测试用它保语义。
 */
export type RebuildRefusedStatus = 400 | 403 | 404 | 409 | 500 | 503;

export interface RebuildRefused {
  readonly ok: false;
  readonly error: string;
  readonly status: RebuildRefusedStatus;
}

export type RebuildStartResult = RebuildStarted | RebuildRefused;

/** 轮询请求（同上：wire 字段名即宿主方法参数名）。 */
export interface RebuildStatusRequest {
  readonly jobId: string;
}

/** 一次成对读数：官方状态投影 + 本包侧表里注册表给不出的事实。 */
export interface RebuildSnapshot {
  readonly ok: true;
  readonly status: RebuildJobStatus;
  readonly exitCode: number | null;
  readonly root: string;
  readonly sandbox?: unknown;
  readonly output: string;
}

export type RebuildStatusResult = RebuildSnapshot | RebuildRefused;
