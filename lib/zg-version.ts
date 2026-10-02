// lib/zg-version.ts —— zg CLI 的**版本门槛**判据（纯逻辑，无宿主依赖）。
//
// 为什么要这道门槛：本包下发的命令形态与旗标名是照 zvec-grep 的某个版本写的。装了一个
// 更老的 zg 时，最糟的失败方式不是「报个错」，而是**命令被当成别的东西执行**——用户
// 看到的是一份看起来正常、实则什么都没查的结果。门槛把那种失败提前到命令构造之前，
// 换成一句能照着做的指引。
//
// 取值口径（`zg --version` 实测）：stdout 只有版本号一行，形如 `0.2.2`，exit 0。
// 解析只认「整串就是一个三段数字版本」这一种形状：多一行前缀说明上游改了输出形态，
// 那时**判为「探测不到」**而不是猜一个版本出来——门槛只拦「确知太老」，绝不拦
// 「没读懂」。探测不到时按当前行为放行（见 host.ts 的 probeZgVersion）。
//
// 门槛的实数依据与取舍：`zg index` 子命令与 `--embedding-concurrency` 自 zvec-grep
// 最早的 v0.1.5 起就都在，本包下发的每个旗标在 v0.2.1 与 v0.2.2 的选项集里逐字相同。
// 换句话说这条门槛拦的是一个**已知不会发生**的降级；保留它是因为「万一」比「万一
// 没有」便宜——多一次带 TTL 的子进程，代价远小于一次看不懂的静默失败。完整取证
// （含选项集 comm 对比与逐 tag 核对）见 docs/review-and-fix-plan.md。

/** 本包按之书写的 zg 语义版本。低于它一律在命令构造前拒绝。 */
export const MINIMUM_ZG_VERSION = "0.2.2";

/** 一个解析出来的语义版本号。只三段：zg 的 `--version` 不给 pre/build 段。 */
export interface ZgVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * 形状：整串就是一个三段数字版本，可带前后的空白与换行。
 * 刻意不接受 `v0.2.2` / `0.2.2-rc.1` / `>=0.2.2` 这类——真出现了就说明输出形态变了，
 * 那属于「读不懂」，归到 undefined 由调用方按「探测不到」处理。
 */
const VERSION_SHAPE = /^\s*(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)\s*$/u;

/** 门槛值本身就是常量，拿它自己当被测对象即可（写成字面量免去一次可失败的解析）。 */
const MINIMUM: ZgVersion = { major: 0, minor: 2, patch: 2 };

/**
 * 不是版本号时用的哨兵：版本分量恒非负，故负数只可能来自「没解析出来」。
 * 三个函数都收敛成**单一 return**（`return a` 与 `return undefined` 混排会被本仓的
 * consistent-return 判成两种返回形态），故用哨兵而不是提前 return。
 */
const UNPARSED = -1;

/** 取一段具名捕获组；组不存在时给哨兵。 */
function segment(found: RegExpExecArray | null, name: string): number {
  const raw = found?.groups?.[name];
  return raw === undefined ? UNPARSED : Number(raw);
}

/** 解析 `zg --version` 的 stdout；形状不符即 undefined（**不猜**）。 */
export function parseZgVersion(stdout: string): ZgVersion | undefined {
  const found = VERSION_SHAPE.exec(stdout);
  const major = segment(found, "major");
  const minor = segment(found, "minor");
  const patch = segment(found, "patch");
  const parsed: ZgVersion | undefined =
    major < 0 || minor < 0 || patch < 0 ? undefined : { major, minor, patch };
  return parsed;
}

/** 版本号的字面形态（回显用：门槛文案要让用户看得见自己装的是哪个版本）。 */
export function formatZgVersion(version: ZgVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/** actual 是否 >= minimum：逐段比数值（不是比字符串，否则 `0.10.0 < 0.9.0`）。 */
export function versionAtLeast(actual: ZgVersion, minimum: ZgVersion): boolean {
  if (actual.major !== minimum.major) {
    return actual.major > minimum.major;
  }
  if (actual.minor !== minimum.minor) {
    return actual.minor > minimum.minor;
  }
  return actual.patch >= minimum.patch;
}

/**
 * 门槛判定：够新（或读不懂）返回 undefined；确知太老则交回实际版本，供文案回显。
 * 「读不懂」与「太老」必须分开：前者放行、后者拒绝，混在一起就成了用一个猜出来的
 * 版本去拦真实用户。
 */
export function tooOldZgVersion(stdout: string): ZgVersion | undefined {
  const parsed = parseZgVersion(stdout);
  const verdict = parsed === undefined || versionAtLeast(parsed, MINIMUM) ? undefined : parsed;
  return verdict;
}
