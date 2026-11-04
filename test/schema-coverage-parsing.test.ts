// test/schema-coverage-parsing.test.ts —— 门禁自己那套文本解析的边界。
//
// 为什么单列：`卡片覆盖 host schema` 这条门禁的全部风险都在**读错文本**上，而不是在断言上。
// 读错的两种后果不对称：多认一个键只会多要求一张控件（保守），少认一段代码则让门禁在字段
// 子集上照绿 —— 删掉控件没人响。所以这里钉的都是"少认"方向的那一类形状：正则字面量里的
// `//`、`as const` 尾巴、同名 const 的作用域、字符串里的 marker、按目录名混进来的测试面。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { boundFieldsIn, hostSchemaFields, stripComments, walk } from "./schema-coverage.ts";

/** 取 fields 并排序：并集的来源顺序由扫描次序决定，判据只看集合。 */
function fieldsOf(source: string): string[] {
  return hostSchemaFields(source).fields.toSorted();
}

describe("字面量边界：正则不是注释，注释不是代码", () => {
  it("正则字面量里的 // 与 /* 不当成注释起点（同行后续绑定不丢）", () => {
    // `/https?:\/\//u` 的正文里有 `\/` + `/`：旧写法在这里开一段"行注释"，把同一行后面的
    // props.set(...) 一起吞掉 —— 门禁就此认为这个字段没绑定，反向是逼人补豁免。
    for (const src of [
      String.raw`const urlRe = /https?:\/\//u; props.set("afterEscapedSlash");`,
      String.raw`const cls = /[/*]/u; props.set("afterClassSlash");`,
      String.raw`const quoteRe = /"/u; props.set("afterQuoteClass");`,
    ]) {
      assert.ok(boundFieldsIn(src).has(/after\w+/u.exec(src)?.[0] ?? ""), src);
      assert.equal(stripComments(src).includes("props.set"), true, `${src} 不该被吞成注释`);
    }
  });

  it("除号仍按除号读；真注释仍然整条不算绑定", () => {
    assert.ok(
      boundFieldsIn('const half = total / 2; props.set("afterDivision");').has("afterDivision"),
      "把 ` / ` 当正则起点会走到未闭合分支，随后仍按普通字符处理，这一条证它没被误吞",
    );
    assert.deepEqual([...boundFieldsIn("// props.set('inLineComment');")], []);
    assert.deepEqual([...boundFieldsIn("/* props.set('inBlockComment'); */")], []);
  });

  it("模板串按整段跳过：插值段不参与结构，也不算绑定", () => {
    // 实现如此，注释也改成了如此（原先写的是「插值里的括号本来该参与配对」，与 literalAt 的行为相反）。
    // 外层用模板字面量写样例：`${` 出现在普通字符串里会被 lint 判成"想写模板串却忘了"。
    assert.deepEqual([...boundFieldsIn(`props.set(\`a\${nested}c\`);`)], []);
    assert.equal(fieldsOf(`const note = \`x\${ Schema.object({ a: 1 }) }y\`;`).length, 0);
  });
});

describe("实参是 Schema.object(...) 时的取法", () => {
  it("字面量带 as const / satisfies 尾巴时按配对花括号截，不按末字符砍", () => {
    for (const source of [
      "const S = Schema.object({ alpha: 1, beta: 2 } as const);",
      "const S = Schema.object({ alpha: 1, beta: 2 } satisfies Fields);",
    ]) {
      assert.deepEqual(fieldsOf(source), ["alpha", "beta"], source);
      assert.deepEqual(hostSchemaFields(source).unresolved, [], source);
    }
    // 上一条只证「不丢」，这一条才咬得住：旧写法砍掉末字符后，尾巴里那个类型对象的键
    // 会落在 depth 0 上被当成设置字段（多要求一张不存在的控件），而正确截法只取块内那两个。
    const withTailKeys = "const S = Schema.object({ alpha: 1 } as { tailOnly: number });";
    assert.deepEqual(fieldsOf(withTailKeys), ["alpha"], "尾巴里的类型键不得混进字段集");
  });

  it("实参是括号包起来的对象时交回 unresolved，而不是静默交出空字段集", () => {
    const parsed = hostSchemaFields("const S = Schema.object(({ alpha: 1 }) as const);");
    assert.deepEqual(parsed.fields, []);
    assert.equal(parsed.unresolved.length, 1, "写法不在解析射程内必须报出来");
  });

  it("标识符回溯：名字里的 $ 不当成行尾锚点", () => {
    const source = [
      "const $fields = { dollarField: 1 };",
      "const S = Schema.object($fields);",
    ].join("\n");
    assert.deepEqual(fieldsOf(source), ["dollarField"]);
  });

  it("类型注解里带等号时仍回溯到赋值的那个对象", () => {
    const source = [
      "const FIELDS: Fields<T = string> = { realField: 1 };",
      "const S = Schema.object(FIELDS);",
    ].join("\n");
    assert.deepEqual(fieldsOf(source), ["realField"]);
  });

  it("同名 const 出现多次时取 marker 之前最近的那一条", () => {
    const source = [
      "const FIELDS = { staleField: 1 };",
      "export function build() {",
      "  const FIELDS = { nearField: 1 };",
      "  return Schema.object(FIELDS);",
      "}",
    ].join("\n");
    assert.deepEqual(fieldsOf(source), ["nearField"], "回溯到别的作用域等于字段集悄悄变错而不报");
  });

  it("marker 出现在字符串里时不算块起点", () => {
    const source = [
      'const note = "说明：这里提到 Schema.object( 只是文案";',
      "const FIELDS = { realField: 1 };",
      "const S = Schema.object(FIELDS);",
    ].join("\n");
    assert.deepEqual(fieldsOf(source), ["realField"]);
    assert.deepEqual(
      hostSchemaFields(source).unresolved,
      [],
      "无关文本不该变成一条指向 host.ts 的假红",
    );
  });

  it("括号不闭合时报 malformed 文案，不当成「没有 schema」", () => {
    const parsed = hostSchemaFields("const S = Schema.object({ alpha: 1 };");
    assert.deepEqual(parsed.fields, []);
    assert.match(parsed.unresolved.join("\n"), /括号没有配对/u);
  });
});

describe("绑定面的扫描范围按目录名收口", () => {
  it("名为 test / tests / spec / __tests__ 的目录不进绑定面", async () => {
    // TEST_FILE_SHAPE 只认文件形状（`x.test.ts`、`__tests__/`），目录叫 test 时它匹配不上，
    // 于是那里的断言式 set('x') 会被当成"已绑定"—— 本门禁最忌讳的假绿方向。
    const root = await mkdtemp(path.join(tmpdir(), "zg-walk-skip-"));
    try {
      await mkdir(path.join(root, "card"), { recursive: true });
      await Promise.all(
        ["test", "tests", "spec", "specs", "__tests__", "node_modules"].map(async (dir) => {
          await mkdir(path.join(root, dir), { recursive: true });
          await writeFile(path.join(root, dir, "fixture.ts"), "props.set('fromExcludedDir');\n");
        }),
      );
      await writeFile(path.join(root, "card", "panel.ts"), "props.set('fromCardDir');\n");
      const found = await walk(root);
      const texts = found.join("\n");
      assert.equal(texts.includes("props.set('fromExcludedDir');"), false);
      assert.equal(texts.includes("props.set('fromCardDir');"), true);
      assert.equal(
        [...boundFieldsIn(texts)].toSorted().join(","),
        "fromCardDir",
        "绑定集里只该有卡片目录那一个",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("目录不存在时交回空数组（ENOENT 是「这棵树没有」，不是错误）", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zg-walk-missing-"));
    try {
      assert.deepEqual(await walk(path.join(root, "src")), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
