import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";

export default definePluginConfig({
  // 本包真实用到的同步 API —— node/no-sync 的包内例外。
  // 基线只放只读那一组（D13：写盘类谁用谁声明），所以这一条是可独立 review 的声明而不是全局豁免表。
  // 写盘那几条（含 chmodSync 改文件元数据）是门禁/集成用例要在临时目录里造出「索引库 +
  // workspace manifest」那对文件、以及造一个 mode 000 的不可读忽略文件来钉预检的判据。
  // accessSync 是只读的**权限探针**（不是写盘）：ignoreFiles 预检要判「存在但当前进程读不了」
  // 那一档（mode 000 / 他人属主 ⇒ statSync().isFile() 照样为真，而真 zg open 会 EACCES 并把
  // 坏路径写进工作区索引状态、永久弄坏这棵树）。共享基线的只读豁免表恰好没收录它，故只能经
  // 本包这唯一的 sync 例外口子声明。它只查权限位、不读内容，与 statSync 同属一次 O(1) 探测，
  // 没有 readFileSync 那种「把大文件整段读进内存」的代价。
  syncWrites: [
    "mkdirSync",
    "mkdtempSync",
    "rmSync",
    "writeFileSync",
    "chmodSync",
    "accessSync",
    "symlinkSync",
  ],
  titlePrefixes: [
    "BigInt",
    "GET",
    "HEAD",
    "JSON",
    "LRU",
    "NUL",
    "POST",
    "ROUTING",
    "TTL",
    "ZgCard",
  ],
});
