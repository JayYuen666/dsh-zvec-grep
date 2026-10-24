import { definePackageConfig } from "@jayyuen66/dsh-plugin-shared/config/vitest.base";

// 公共面（test.include / environment / testTimeout / provider / exclude / reporter /
// reportsDirectory / 四项 100% 阈值）在 shared/config/vitest.base.ts 单源；这里只留本包差异。
export default definePackageConfig({
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
