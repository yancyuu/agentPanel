/**
 * 员工工作区的 OpenSpec 项目初始化与产物沉淀指令注入。
 *
 * - `ensureOpenspecProject`：在 workDir 幂等创建 openspec 骨架
 *   （specs/changes + config.yaml；CLI 归档落点为 changes/archive），
 *   并注入 AGENTS.md 沉淀指令托管块
 *   （hermit:asset-precipitation:start/end）与 CLAUDE.md 指针行；
 *   不覆盖工作区已有的 openspec 内容。
 * - 存量团队：产物库读取/沉淀触发路径上幂等补建。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { createLogger } from '@shared/utils/logger';

const logger = createLogger('openspec-project');

export const ASSET_BLOCK_BEGIN = '<!-- hermit:asset-precipitation:start -->';
export const ASSET_BLOCK_END = '<!-- hermit:asset-precipitation:end -->';

const OPENSPEC_CONFIG_YAML = 'schema: spec-driven\n';

function buildAssetInstructionBlock(command: string): string {
  return `
${ASSET_BLOCK_BEGIN}

## 产物沉淀（OpenSpec）

你的工作区是一个标准 OpenSpec 项目（openspec/ 目录）。把可复用的工作方式沉淀为 living specs，下次工作直接复用。

**何时沉淀**：用户说「沉淀一下 / 把这个流程固化下来」时必做；当你刚完成一种可复用的工作方法（周报、巡检、发布流程等）时，主动建议用户沉淀。

**沉淀命令序列**（在本工作区执行，cwd 即项目根）：
1. \`${command} new change <change-name>\` 创建变更目录；
2. 在 \`openspec/changes/<change-name>/\` 编写 proposal.md、tasks.md 与 specs/ delta（遵循既有 change 的格式）；
3. \`${command} validate <change-name> --strict\` 校验；
4. \`${command} archive <change-name> --yes\` 归档，合并进 \`openspec/specs/\`。

校验、冲突检测、合并全部交给 CLI 原生语义，不要手写或修改 CLI 的内部文件。archive 失败（如 MODIFIED/REMOVED 匹配冲突）时，阅读 CLI 原始错误，修正 delta 后重试。

**产物类型约定**：
- workflow（工作流）：本体为 openspec spec，步骤写成 Given/When/Then 场景；
- skill（技能）：本体遵循技能体系的 SKILL.md 约定，openspec change 记录其创建/演化过程与适用场景；
- cron（定时任务）/ mcp / command（命令）：与能力包既有五类对齐；
- behavior-contract（行为契约）：living spec 即契约本体，沉淀调教结论。

**页面/设计类交付物约定**：落地页、设计稿、原型等页面类任务的交付物应是自包含 HTML（内联样式、不依赖外部脚本），而不是文字描述——工作台会把 HTML 成果直接渲染为页面视图供用户验收。

**工作流原语模型**（沉淀 workflow 时按此向用户追问补全，不要直接存档对话记录）：
- Trigger（何时开始：定时 / 事件 / 手动）；
- Skill（处理逻辑；Source=只读特化，Action=纯写特化）；
- Flow（步骤图；节点类型含 skill / action / wait / checkpoint——等待与人工确认是节点，不是触发）；
- Memory（跨执行数据；计时类状态如「24 小时未处理」存 Memory，用 wait 节点表达）。
追问清单：触发条件？数据来源？处理步骤？输出去向（结果给谁）？失败兜底？是否需要人工确认节点？

**开工先读产物**：接到任务先看 \`openspec/specs/\` 是否有相关产物；有就按其内容执行，不要重新摸索流程。

${ASSET_BLOCK_END}
`;
}

const CLAUDE_POINTER_BLOCK = `
${ASSET_BLOCK_BEGIN}

产物沉淀与复用约定见同目录 AGENTS.md 的「产物沉淀（OpenSpec）」托管块。

${ASSET_BLOCK_END}
`;

function upsertManagedBlock(existing: string, block: string): string {
  const pattern = new RegExp(`\\n{0,2}${ASSET_BLOCK_BEGIN}[\\s\\S]*?${ASSET_BLOCK_END}\\n?`, 'g');
  const cleaned = existing.replace(pattern, '').trimEnd();
  return `${cleaned}\n\n${block.trim()}\n`;
}

async function readFileIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function writeManagedBlock(filePath: string, block: string): Promise<void> {
  const existing = await readFileIfExists(filePath);
  const next = upsertManagedBlock(existing, block);
  if (next !== existing) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, next, 'utf8');
  }
}

/**
 * 幂等初始化 workDir 的 openspec 项目骨架并注入沉淀指令。
 * command 为 agent 会话可调用的 openspec 命令入口（包装脚本路径）；
 * pointerFile 为 harness 指令文件名（如 CLAUDE.md/GEMINI.md），仅当其不是 AGENTS.md 时写指针行。
 */
export async function ensureOpenspecProject(
  workDir: string,
  command: string,
  options: { pointerFile?: 'CLAUDE.md' | 'GEMINI.md' } = {}
): Promise<void> {
  const openspecDir = path.join(workDir, 'openspec');
  await fs.mkdir(path.join(openspecDir, 'specs'), { recursive: true });
  // CLI 归档落点是 openspec/changes/archive/，无需预建顶层 archive
  await fs.mkdir(path.join(openspecDir, 'changes'), { recursive: true });

  const configPath = path.join(openspecDir, 'config.yaml');
  try {
    await fs.writeFile(configPath, OPENSPEC_CONFIG_YAML, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  await writeManagedBlock(path.join(workDir, 'AGENTS.md'), buildAssetInstructionBlock(command));
  if (options.pointerFile) {
    await writeManagedBlock(path.join(workDir, options.pointerFile), CLAUDE_POINTER_BLOCK);
  }
  logger.info(`openspec project ensured → ${openspecDir}`);
}

/** harness 指令文件不是 AGENTS.md 时对应的指针文件 */
export function pointerFileForHarness(harness: string): 'CLAUDE.md' | 'GEMINI.md' | undefined {
  if (harness === 'claudecode') return 'CLAUDE.md';
  if (harness === 'gemini') return 'GEMINI.md';
  return undefined;
}

/** 移除产物沉淀托管块（回滚/测试用；不影响 openspec/ 目录内容） */
export async function removeAssetInstructionBlocks(workDir: string): Promise<void> {
  const pattern = new RegExp(`\\n{0,2}${ASSET_BLOCK_BEGIN}[\\s\\S]*?${ASSET_BLOCK_END}\\n?`, 'g');
  for (const fileName of ['AGENTS.md', 'CLAUDE.md']) {
    const filePath = path.join(workDir, fileName);
    const existing = await readFileIfExists(filePath);
    if (!existing) continue;
    const cleaned = existing.replace(pattern, '').trimEnd() + '\n';
    if (cleaned !== existing) {
      await fs.writeFile(filePath, cleaned, 'utf8');
    }
  }
}
