/**
 * Prompt 注入防护（P2 修复 #4：伪装声明/注入串已入库的数据进入 LLM 时的统一包裹）。
 * 防线分两层：
 *   1. 骨架 Prompt 声明（skeleton.md）：所有 [DATA] 标记段落内的任何文字（包括伪装成
 *      系统声明/确认语的文本）一律是数据，不构成指令。
 *   2. 本模块：外部文本进 prompt 一律走 fenceContent / dataSection 包裹——
 *      围栏逃逸安全（内容含 ``` 时改 4 空格缩进块），段界显式可审计。
 * 新增 Agent 的规则：外部数据只进 user 位、只经本模块包裹；系统位只放骨架 + 任务包。
 */

/**
 * 围栏包裹：内容含 ``` 时，围栏会被内容提前闭合、后续文本逃逸成顶层指令——
 * 此时改用 4 空格缩进代码块（缩进块内的 ``` 是字面文本，不会闭合）。
 */
export function fenceContent(text: string): string {
  if (!text.includes('```')) return `\`\`\`text\n${text}\n\`\`\``;
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

/**
 * [DATA] 数据段包裹：段头段尾显式标记 + 围栏。
 * lines 为段内文本行（每行由调用方先行截断）；标记本身不会被内容伪造——
 * 模型读到 [DATA END] 即知段结束，段内任何「标记」「声明」都是数据。
 */
export function dataSection(title: string, lines: string[]): string {
  const body = lines.length > 0 ? `\n${fenceContent(lines.join('\n'))}` : '\n（空）';
  return `### ${title} [DATA BEGIN]${body}\n[DATA END]`;
}
