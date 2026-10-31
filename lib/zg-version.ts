// lib/zg-version.ts —— zg CLI 的**版本门槛**判据（纯逻辑，无宿主依赖）。
//
// 为什么要这道门槛：本包下发的命令形态与旗标名是照 zvec-grep 的某个版本写的。装了一个
// 更老的 zg 时，最糟的失败方式不是「报个错」，而是**命令被当成别的东西执行**——用户
// 看到的是一份看起来正常、实则什么都没查的结果。门槛把那种失败提前到命令构造之前，
// 换成一句能照着做的指引。
//
// 取值口径（`zg --version` 实测）：stdout 只有版本号一行，形如 `0.2.2`，exit 0。
// 解析只认「整串就是一个三段数字版本（`v` 前缀可有可无）」这一种形状：多一行前缀、
// pre-release 段或比较符说明上游改了输出形态，那时**判为「探测不到」**而不是猜一个
// 版本出来——门槛只拦「确知太老」，绝不拦「没读懂」。`v` 前缀单独容忍：最该被这道
// 门槛拦住的老 zg 若恰好输出 `v0.1.0`，把它当「读不懂」等于对最坏的那一档 fail-open；
// 形态变化的代价（误判为更老而报错）远小于误放行。探测不到时按当前行为放行（见
// host.ts 的 probeZgVersion）。
//
// 门槛的实数依据与取舍：`zg index` 子命令与 `--embedding-concurrency` 自 zvec-grep
// 最早的 v0.1.5 起就都在，本包下发的每个旗标在 v0.2.1 与 v0.2.2 的选项集里逐字相同。
// 换句话说这条门槛拦的是一个**已知不会发生**的降级；保留它是因为「万一」比「万一
// 没有」便宜——多一次带 TTL 的子进程，代价远小于一次看不懂的静默失败。「本包下发的
// 旗标被真 zg 接受」由 test/e2e/zg-cli.test.ts 的「点对点：本包构造的命令行 vs 真 zg
// CLI」那一组兜住；跨版本（v0.2.1 与 v0.2.2）的选项集逐字对比当时手工做过，本机只装了
// 一个版本，**未验证**、无从复跑。

/**
 * 门槛本体：比较用的对象是唯一事实来源，回显用的字符串由它派生——两处在编译期
 * 就不可能漂移，改门槛只改这一个字面量。
 */
const MINIMUM: ZgVersion = { major: 0, minor: 2, patch: 2 };

/** 版本号的字面形态（回显用：门槛文案要让用户看得见自己装的是哪个版本）。 */
export function formatZgVersion(version: ZgVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/** 本包按之书写的 zg 语义版本（字面形态，给文案回显）。低于它一律在命令构造前拒绝。 */
export const MINIMUM_ZG_VERSION = formatZgVersion(MINIMUM);

/** 一个解析出来的语义版本号。只三段：zg 的 `--version` 不给 pre/build 段。 */
export interface ZgVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * 形状：整串就是一个三段数字版本，`v` 前缀可有可无，可带前后的空白与换行。
 * 分量至多 9 位数字：`Number()` 对超长数字串会丢精度乃至得到 Infinity，畸形输入
 * 会被当成「版本极大」而放行——把「读不懂」当成「够新」是 fail-open。仍不接受
 * `0.2.2-rc.1` / `>=0.2.2` / 带标题前缀这类——真出现了就说明输出形态变了，那属于
 * 「读不懂」，归到 undefined 由调用方按「探测不到」处理。
 */
const VERSION_SHAPE = /^\s*v?(?<major>\d{1,9})\.(?<minor>\d{1,9})\.(?<patch>\d{1,9})\s*$/u;

/**
 * 不是版本号时用的哨兵：版本分量恒非负，故负数只可能来自「没解析出来」。
 * `parseZgVersion` 收敛成**单一 return**（`return a` 与 `return undefined` 混排会被本仓的
 * consistent-return 判成两种返回形态），故用哨兵而不是提前 return；其它函数不受此约束。
 */
const UNPARSED = -1;

/** 版本分量名。收成字面量联合，组名写错在编译期就红，不会退化成「永远读不懂」。 */
type VersionPart = "major" | "minor" | "patch";

/** 取一段具名捕获组；组不存在时给哨兵。 */
function segment(found: RegExpExecArray | null, name: VersionPart): number {
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
