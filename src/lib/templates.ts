/**
 * Built-in prompt skeleton, inserted by the "📋 使用模板" button in PromptForm.
 *
 * Five-element framework: Role + Task + Output Format + Constraint + Example.
 * Placeholders use `[...]` (square brackets, not double-curly) so they will
 * NOT be picked up by the {{var}} variable parser. Users can fill them in
 * inline, or delete sections they don't need.
 */
export const PROMPT_TEMPLATE = `## 角色
你是一位 [...]

## 任务
请帮我 [...]

## 输出格式
- [...]
- [...]

## 约束
- 不要 [...]
- 必须 [...]

## 示例
输入：[...]
输出：[...]
`;
