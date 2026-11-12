import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";
import { definePackageConfig } from "@jayyuen66/dsh-plugin-shared/config/vitest.base";
import { viteDecorators } from "@jayyuen66/dsh-plugin-shared/lib/decorator-lowering";

// 装饰器降级要一枚 tsc（见 build-host.mjs 同一段）。`definePackageConfig` 只读
// `coverageInclude` 与 `test`，顶层多传的 `plugins` 会被它静默丢掉——必须自己
// `defineConfig` 展开合并。
const tscEntry = path.join(
  path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
  "bin",
  "tsc",
);

// 公共配置（test.include / environment / testTimeout / provider / exclude / reporter /
// reportsDirectory / 四项 100% 阈值）在 shared/config/vitest.base.ts 唯一来源；这里只留本包差异。
const base = definePackageConfig({
  coverageInclude: [
    "host.ts",
    "lib/**/*.ts",
    // 卡片侧两个可单测的源文件（字典与远程读取器）一并入覆盖率门禁；
    // src/client-entry.ts 刻意排除：纯浏览器入口（document/React 渲染，node 环境无 document），
    // 它的冒烟由 test/build-client.test.ts 对构建产物求值，真渲染走「已发布产物」那条回路。
    "src/ui-messages.ts",
    "src/rebuild-reader.ts",
  ],
});

export default defineConfig({
  ...base,
  plugins: [...(base.plugins ?? []), viteDecorators({ tscEntry })],
});
