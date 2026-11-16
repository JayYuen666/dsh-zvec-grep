// lib/skill.ts —— 把完整检索规则注册成一枚**虚拟 skill**（rc.2 的 `ctx.skills.register()`）。
//
// 为什么要有这一层：规则全文（messages.routingText）原本整段常驻 systemPrompt，每种语言
// 2.4–3.0KB，每个会话都要背。而其中真正会被门禁拒绝的只有少数几条（先 zg_search、root
// 授权范围、confirm 必填……）——其余是机制细节（配额算法、重建流程、embedding 选择、
// 结果证据怎么读），只在真要用到的时候才需要。所以拆成两份：
//   · systemPrompt 只留摘要（messages.routingSummary），逐条对应「不照做会被拦」；
//   · 全文注册成 skill，模型按名加载（`skill({ name: "zvec-grep" })`）。
//
// **注册动作本身已经收进 shared**：`@jayyuen66/dsh-plugin-shared/lib/skill` 的
// `registerSkill(ctx, spec)` 承担「取可选服务 → 判形状 → register → 回布尔」的全过程
// （含「正文为空不注册」）。本文件只剩两样本仓自己的东西：skill 名，与把三份文本收成
// spec 的那一层。此前三个带常驻提示词的插件各写一遍同一段正文，逐行同构——留着没有意义。
//
// 服务是**可选**的：`@deepseek-ai/dsh-skill` 未装载（精简 profile）时注册只是回 false，
// systemPrompt 那段摘要照旧生效，门禁照旧拦截。shared 那边因此只要求 `get`、不要求 skills
// 进 inject 依赖表：进了就把「有 skill 服务」变成插件的硬性前提。
//
// 上下文类型不能只收 `get`：shared 的 `registerSkill` 还会用可选的 `effect` 接管注册的
// 撤销权（宿主的 `skills.register()` 交回一枚 disposer，不交给 fiber 的话插件卸载后 skill
// 仍留在模型目录里，下一次装配再注册同名条目只会被 first-wins 忽略）。本文件的入参因此
// 直接用 shared 的 `SkillRegistryContext`——写成 `{ get }` 虽然当前直接透传时运行期仍能
// 用到 `effect`，但类型看不见这条契约；一旦重构成只转发 `get`，撤销权就会静默丢掉。
//
// 名字用 kebab-case（`isSkillName` 的语法），与工具名前缀区分开：工具是 zg_search /
// zg_index / zg_status，skill 是 zvec-grep。
import { registerSkill } from "@jayyuen66/dsh-plugin-shared/lib/skill";
import type { SkillRegistryContext } from "@jayyuen66/dsh-plugin-shared/lib/skill";

/** skill 名：kebab-case，也是模型用 skill 工具加载时的入参。 */
export const SKILL_NAME = "zvec-grep";

/**
 * 注册（或重新注册）本包的检索规则 skill。
 *
 * 文案随调用点传入而不是在这里取：语言由 apply 时的官方 locale 偏好决定，与工具描述、
 * 参数说明同源——三处各取一次就会出现「工具描述是中文、skill 正文是英文」那种错位。
 * @param ctx - 只需 `get`（读可选服务），不要求 skills 进 inject；带上 `effect` 时注册的
 *   撤销权交给插件 fiber（见文件头）
 * @param content - 规则全文（`messages.routingText`）
 * @param description - skill 目录里那行说明（模型据此决定要不要加载）
 * @returns 注册成功与否；未装载 skill 服务或正文为空时为 false（不抛，摘要段照旧生效）
 */
export function registerRoutingSkill(
  ctx: SkillRegistryContext,
  content: string,
  description: string,
): boolean {
  return registerSkill(ctx, { name: SKILL_NAME, description, content });
}
