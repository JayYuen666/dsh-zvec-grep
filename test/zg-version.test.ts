// lib/zg-version.ts 的单元测试：版本解析、门槛比较、以及「读不懂 ≠ 太老」这条分界。
// 纯逻辑，不触宿主面。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  MINIMUM_ZG_VERSION,
  formatZgVersion,
  parseZgVersion,
  tooOldZgVersion,
  versionAtLeast,
} from "../lib/zg-version.ts";
import type { ZgVersion } from "../lib/zg-version.ts";

/** 实测 `zg --version` 的形态：stdout 只有版本号一行（末尾带换行）。 */
const ver = (text: string): ZgVersion => {
  const parsed = parseZgVersion(text);
  assert.ok(parsed !== undefined, `应能解析：${JSON.stringify(text)}`);
  return parsed;
};

/** 门槛上下反复用到的几个版本字面量，集中成常量免得散落各处改一半。 */
const BELOW = "0.2.1";
const OLD = "0.1.9";
const AT = "0.2.2";
const ABOVE = "0.2.3";
/** 字符串比会判错的那一对（`0.10.0 < 0.9.0`）：门槛必须逐段比数值。 */
const TEN = "0.10.0";
const NINE = "0.9.0";
/** 高段优先的一对。 */
const ONE_ZERO = "1.0.0";
const NINETY_NINE = "0.99.99";

describe("parseZgVersion", () => {
  it("认得实测形态：纯版本号 + 尾随换行", () => {
    assert.deepEqual(ver("0.2.2\n"), { major: 0, minor: 2, patch: 2 });
  });

  it("前后空白一律容忍（某些 shell 会把它包进引号回显）", () => {
    assert.deepEqual(ver("  1.10.3  \n"), { major: 1, minor: 10, patch: 3 });
  });

  it("多段版本号（1.2.3.4）不认：宁可读不懂也不猜", () => {
    assert.equal(parseZgVersion("1.2.3.4"), undefined);
  });

  it("前缀/pre-release/比较符一律不认", () => {
    for (const text of [
      "v0.2.2",
      "0.2.2-rc.1",
      ">=0.2.2",
      "zvec-grep 0.2.2",
      "0.2",
      "0.2.x",
      "",
      "   \n",
    ]) {
      assert.equal(parseZgVersion(text), undefined, `不该认：${JSON.stringify(text)}`);
    }
  });

  it("非数字段不认（Number() 的八进制/空串陷阱由正则先挡掉）", () => {
    for (const text of ["0x1.2.3", "01.2.3x", "..", "0..2"]) {
      assert.equal(parseZgVersion(text), undefined, `不该认：${JSON.stringify(text)}`);
    }
  });
});

describe("versionAtLeast", () => {
  it("同版本算够（门槛是「低于才拒」）", () => {
    assert.equal(versionAtLeast(ver(AT), ver(AT)), true);
  });

  it("逐段比数值而不是比字符串：0.10.0 > 0.9.0", () => {
    assert.equal(versionAtLeast(ver(TEN), ver(NINE)), true);
    assert.equal(versionAtLeast(ver(NINE), ver(TEN)), false);
  });

  it("高段优先：1.0.0 > 0.99.99，0.99.99 < 1.0.0", () => {
    assert.equal(versionAtLeast(ver(ONE_ZERO), ver(NINETY_NINE)), true);
    assert.equal(versionAtLeast(ver(NINETY_NINE), ver(ONE_ZERO)), false);
  });

  it("次段优先于修订段：0.3.0 > 0.2.99", () => {
    assert.equal(versionAtLeast(ver("0.3.0"), ver("0.2.99")), true);
  });
});

describe("tooOldZgVersion", () => {
  it("门槛值本身：放行（交回 undefined）", () => {
    assert.equal(tooOldZgVersion(`${AT}\n`), undefined);
  });

  it("更高版本一律放行", () => {
    for (const text of [ABOVE, "0.3.0", ONE_ZERO, "2.0.0"]) {
      assert.equal(tooOldZgVersion(text), undefined, `${text} 应放行`);
    }
  });

  it("更低版本：交回实际版本供文案回显", () => {
    assert.deepEqual(tooOldZgVersion(`${BELOW}\n`), { major: 0, minor: 2, patch: 1 });
    assert.deepEqual(tooOldZgVersion(`${OLD}\n`), { major: 0, minor: 1, patch: 9 });
  });

  it("读不懂的一律按「探测不到」放行，绝不拿猜出来的版本去拦真实用户", () => {
    for (const text of ["", "not a version", "v0.2.1", "0.2.1-rc.1"]) {
      assert.equal(tooOldZgVersion(text), undefined, `读不懂就放行：${JSON.stringify(text)}`);
    }
  });

  it("门槛常量与比较用的字面量同源（改一处必须改两处，这里钉住）", () => {
    // MINIMUM_ZG_VERSION 是给用户看的字符串，MINIMUM 是拿来比的对象；两者不同步的话
    // 文案会报一个与实际判定不符的版本号。
    assert.equal(
      formatZgVersion(parseZgVersion(MINIMUM_ZG_VERSION) ?? { major: 0, minor: 0, patch: 0 }),
      MINIMUM_ZG_VERSION,
    );
    assert.equal(tooOldZgVersion(MINIMUM_ZG_VERSION), undefined);
  });
});
