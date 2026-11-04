// test/host-freshness.ts —— host 侧产物新鲜度指纹门禁（13 包共用，复制式分发，同 client-freshness.ts）。
// 本包副本形态：只提供**证据**（磁盘 host 产物 vs 当期内存构建产物 + 包名与包根），用例注册留在
// test/build-host.test.ts 的 describe 里。共享夹具一旦自行 it()，它就变成用例文件，
// vitest 的结构类规则（require-hook / consistent-test-it / valid-title）全部落到夹具上。
//
// 背景：host.ts / lib/*.ts 改后忘跑 node build-host.mjs，dsh 载入的仍是旧 host.js。client 侧
// 早就有这道门（test/client-freshness.ts），host 侧缺这道门时真实漏过一次：
// danger-guard/host.js 的生成时间早于 host.ts 的下一次改动——产物已过期，而没有任何门会报出来。
// settings.js 由同一份 builder 的另一条导出产出，同样没人看管，所以它进的是同一道门。
// mtime 断言在 git clone / touch 下不稳定，故用**内容指纹**：内存构建（build-host.mjs 的纯函数
// 导出，不落盘）vs 磁盘产物逐字节比对。源任何变更未重建 → 字节必差 → 红。
//
// 用法（各包 test/build-host.test.ts 的指纹用例里）：
//   const evidence = await hostFreshnessEvidence(import.meta.url)
//   —— 自动定位 ../host.js 与 ../build-host.mjs 的 buildHost()。第二个参数指名「另一条导出 +
//   另一个产物文件」：danger-guard 的设置半走 builder: buildSettings、artifact: settings.js，
//   两个产物各自比字节。导出名不在门禁这侧统一，因为改 builder 的导出面比写清选项代价大。
//
// 形态自适应：构建函数返回字符串 → 单文件逐字节；返回「落盘路径 → 正文」的 Map（shared 的多
// 入口 dist 产物，它压根不产 host.js，门禁不替它硬造一个）→ 两侧都折成按路径排序的
// 「相对路径 + 正文摘要」清单再比。摘要只当字节身份（同摘要即同字节），换来红时是十来行、
// 每行点名一个产物的 diff，而不是几十 KB 正文并排。
//
// 注意：构建函数必须是确定性构建（同输入同输出）。13 包的 build-host.mjs 实测同一进程内双跑
// 逐字节一致（rolldown 的 [hash] 是内容哈希，不含时间戳/随机数），逐字节相等成立；若未来构建
// 引入非确定性，改为规范哈希比较并在 build-host.mjs 里输出 canonical 形态。

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** build-host.mjs 的导出返回形状：单文件正文，或「落盘绝对路径 → 正文」的产物清单。 */
type BuiltArtifacts = string | Map<string, string>;

/** 指纹门禁的两份产物 + 包名与包根（消息里标身份与修复命令，两侧同源）。 */
export interface HostFreshnessEvidence {
  readonly pkgName: string;
  readonly pkgDir: string;
  readonly onDisk: string;
  readonly built: string;
}

/** 门禁认哪条导出、比哪个产物（缺省 buildHost() 与包根 host.js）。 */
export interface HostFreshnessOptions {
  /** build-host.mjs 里的具名导出（danger-guard 的设置半是 buildSettings）。 */
  readonly builder?: string;
  /** 包根下的产物文件（danger-guard 的设置半是 settings.js）。 */
  readonly artifact?: string;
}

const DEFAULT_BUILDER = "buildHost";
const DEFAULT_ARTIFACT = "host.js";

/** 磁盘上没有这份产物时的占位正文：让门禁红在比对里，而不是红在 ENOENT 的栈里。 */
const ABSENT = "[产物缺失：运行 node build-host.mjs]";

/**
 * 读一份文本产物；不存在时交回缺失占位。
 * @param file - 绝对路径
 * @returns 正文，或 ABSENT
 */
function readText(file: string): string {
  if (existsSync(file)) {
    return readFileSync(file, "utf8");
  }
  return ABSENT;
}

/**
 * 一份正文的字节身份。
 * @param text - 产物正文
 * @returns sha256 十六进制
 */
function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 取包名：JSON.parse 后读顶层 `name`（与 client 侧夹具同一读法）。
 * 正则抠第一处 `"name":` 会命中嵌套对象里的同名键（`bin` / `contributes` 排在顶层之前时就取错），
 * 而静默回退 `unknown` 会让用例名变成 `unknown: …` 却照样绿 —— manifest 坏了没人知道。
 * @param pkgDir - 包根绝对路径
 * @returns package.json 的 name；缺失或不是非空字符串时抛错点名目录
 */
function packageNameOf(pkgDir: string): string {
  const manifest = JSON.parse(readText(path.resolve(pkgDir, "package.json"))) as { name?: unknown };
  const { name } = manifest;
  if (typeof name !== "string" || name === "") {
    throw new Error(`[${pkgDir}] package.json 的 name 缺失或不是字符串，新鲜度门禁无从标身份`);
  }
  return name;
}

/**
 * 多产物形态：把清单折成按路径排序的「相对路径 + 正文摘要」文本，两侧共用同一排序。
 *
 * ⚠ 键必须是**落盘绝对路径**：相对键会按 runner 的 cwd 解析，`path.relative` 于是产出
 * `../xx` 这种越出包根的路径、`readText` 则多半读不到东西，两侧差异看着像"产物过期"，
 * 实际是清单口径错了 —— 误报红且 diff 里看不出病因，所以这里先判形状再折。
 * ⚠ 只比对本轮声明的产物：磁盘上多出来的陈旧产物（构建已不再产出、旧文件还躺着）不进这张表，
 * 因此这一道门不检测残留。要覆盖残留得从产物根目录枚举实际文件再对照，本仓没有那个需求。
 * ⚠ 清单文本按 POSIX 分隔符写：`path.relative` 在 win32 上交回 `dist\a.js`，而两侧都走同一
 * 归一化才不会把「平台分隔符」误报成「产物过期」；排序也落在归一化后的行上，跨平台同字。
 * @param pkgDir - 包根绝对路径（相对化是为了清单不绑定装机位置）
 * @param pkgName - 包名，只用于报错时标身份
 * @param files - 构建函数交回的「落盘绝对路径 → 正文」
 * @param fromDisk - true 时逐个读盘算摘要（缺文件即摘要不同，行里已点名是哪个产物）
 * @returns 可直接与另一侧逐字节相等的清单文本
 */
function manifestOf(
  pkgDir: string,
  pkgName: string,
  files: Map<string, string>,
  fromDisk: boolean,
): string {
  const rows: string[] = [];
  for (const [file, code] of files.entries()) {
    if (!path.isAbsolute(file)) {
      throw new TypeError(`[${pkgName}] 产物清单的键不是绝对路径：${file}`);
    }
    const identity = fromDisk ? digestOf(readText(file)) : digestOf(code);
    const relative = path.relative(pkgDir, file).split(path.sep).join("/");
    rows.push(`${relative}\t${identity}`);
  }
  return `${rows.toSorted((left, right) => left.localeCompare(right)).join("\n")}\n`;
}

/**
 * 取指纹门禁证据：磁盘 host 产物与当期内存构建产物（构建只在内存里跑，不落盘）。
 * @param testFileUrl - 调用方用例文件的 import.meta.url
 * @param options - 指认 builder / artifact（缺省 buildHost() vs 包根 host.js）
 * @returns 两份产物文本 + 包名与包根
 */
export async function hostFreshnessEvidence(
  testFileUrl: string,
  options: HostFreshnessOptions = {},
): Promise<HostFreshnessEvidence> {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const pkgDir = path.resolve(testDir, "..");
  const builder = options.builder ?? DEFAULT_BUILDER;
  const artifact = options.artifact ?? DEFAULT_ARTIFACT;
  const pkgName = packageNameOf(pkgDir);
  // 动态导入 .mjs 对 TS 为 any，先收窄到调用面再 await（避免 no-unsafe-*）。
  // 载入与构建失败带上下文重抛：这条门禁的语义是「产物过期」，连构建都跑不起来
  // 属于另一类病因，裸 ERR_MODULE_NOT_FOUND / rolldown 栈看不出是哪个包。
  let mod: Record<string, (() => Promise<BuiltArtifacts>) | undefined>;
  try {
    mod = (await import(pathToFileURL(path.resolve(pkgDir, "build-host.mjs")).href)) as Record<
      string,
      (() => Promise<BuiltArtifacts>) | undefined
    >;
  } catch (error: unknown) {
    throw new Error(
      `[${pkgName}] 无法载入 ${path.resolve(pkgDir, "build-host.mjs")}：门禁要对它做内存构建`,
      { cause: error },
    );
  }
  const build = mod[builder];
  if (typeof build !== "function") {
    throw new TypeError(
      `[${pkgName}] build-host.mjs 没有可调用导出 ${builder}：门禁的 builder 选项必须指它真实导出的名字。`,
    );
  }
  let built: BuiltArtifacts;
  try {
    built = await build();
  } catch (error: unknown) {
    throw new Error(
      `[${pkgName}] build-host.mjs 的 ${builder}() 构建失败：先让构建本身过，再谈产物新鲜度`,
      { cause: error },
    );
  }
  if (typeof built === "string") {
    return { pkgName, pkgDir, onDisk: readText(path.resolve(pkgDir, artifact)), built };
  }
  // 类型面 `BuiltArtifacts` 是断言出来的（.mjs 对 TS 就是无类型），运行期真拿到别的东西
  // （undefined、`{ code }` 这一类）时不该在 `files.entries()` 上炸一句与包名无关的栈：
  // 先验形状，报错点名是哪个包的哪个 builder。经 unknown 判，而不是对已收窄成 Map 的值
  // 再问一次 instanceof（那在类型面是恒真，会被 lint 判成多余条件）。
  const shape: unknown = built;
  if (!(shape instanceof Map)) {
    throw new TypeError(
      `[${pkgName}] build-host.mjs 的 ${builder}() 返回值既不是字符串也不是「路径→正文」的 Map：门禁无法比对。`,
    );
  }
  return {
    pkgName,
    pkgDir,
    onDisk: manifestOf(pkgDir, pkgName, built, true),
    built: manifestOf(pkgDir, pkgName, built, false),
  };
}
