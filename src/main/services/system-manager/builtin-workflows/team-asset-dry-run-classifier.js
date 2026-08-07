export const meta = {
  name: 'team-asset-dry-run-classifier',
  description:
    'Dry-run classifier for team scripts, workflows, commands, docs, configs, and reports; recommends where assets should live without moving anything.',
  category: 'team',
  safety: 'proposal-only',
  order: 117,
  phases: [
    { title: 'Explore', detail: 'Inspect team/project assets at metadata level only' },
    {
      title: 'Classify',
      detail:
        'Classify each asset into workflow, skill, command, cron, connector, docs, or do-not-migrate',
    },
    { title: 'Plan', detail: 'Return a dry-run organization and migration plan' },
  ],
};

// <!-- hermit-builtin-workflow:v2-loop -->

function normalizeOptions(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
  return {
    root:
      typeof parsed.root === 'string' && parsed.root.trim()
        ? parsed.root.trim()
        : 'current project or team root',
    maxDepth: Number.isFinite(Number(parsed.maxDepth)) ? Number(parsed.maxDepth) : 3,
    includeHidden: parsed.includeHidden === true,
  };
}

const options = normalizeOptions(args);
const safetyRules = [
  '只做 dry-run 分类：不要创建、编辑、移动、删除、复制、备份、重命名或格式化任何文件。',
  '不执行脚本、workflow、cron、hook、package script、lark-cli、MCP 写接口或外部上传。',
  '不读取 .env、.mcp.json、settings.local.json、credential、token、cookie、private key 或 secret 文件内容。',
  '对疑似敏感文件只输出 skipped-sensitive、路径类别和风险原因，不输出内容。',
  '所有 apply/organize/backup/resolve/migrate 动作都必须停在人工确认计划。',
];

phase('Explore');
const inventory = await agent(
  `只读检查团队/项目资产结构并生成元数据级清单。

根目录：${options.root}
maxDepth=${options.maxDepth}
includeHidden=${options.includeHidden}

安全边界：
${safetyRules.map((rule) => `- ${rule}`).join('\n')}

只读观察这些资产：
1. scripts、bin、tools、一次性 Python/JS/Shell 脚本。
2. workflows、.claude/commands、.hermit/.claude/workflow、.omc/workflows。
3. .claude/skills、.hermit/skills、runbook、SOP、README、docs。
4. cron schedules、hooks、CI workflow、package scripts。
5. MCP、平台 bot、Feishu/Lark/Base、GitHub、数据库等连接器配置的非敏感结构。
6. reports、audit logs、diagnosis output、usage summary、临时 session 产物。

只输出文件名、路径、类型、大小/修改时间等元数据和可安全读取的标题/metadata。`,
  {
    label: 'inventory-team-assets',
    phase: 'Explore',
    agentType: 'Explore',
  }
);

phase('Classify');
const classification = await agent(
  `根据以下资产清单做 dry-run 分类，不要移动或编辑任何文件。

资产清单：
${JSON.stringify(inventory)}

主分类：
- workflow：多步骤、需要 LLM 判断、适合人工触发或 Loop recurring 的运维流程。
- skill：稳定领域知识、工具用法、SOP、判断准则。
- command：短小明确的一次性操作入口。
- cron/loop：周期性只读检查，有明确汇报格式。
- connector/MCP：外部系统访问能力，需要凭据、权限和审计边界。
- docs/reference：背景资料，不应自动化。
- do-not-migrate：强绑定私有路径、密钥、外部写入、删除/移动、一次性修复或风险过高。

成熟度：ready / needs-parameterization / needs-approval-gate / rewrite-required / do-not-migrate。
安全等级：read-only / reporting / audit / proposal-only / apply / destructive。

输出分类矩阵。`,
  {
    label: 'classify-team-assets',
    phase: 'Classify',
  }
);

phase('Plan');
const plan = await agent(
  `用中文生成 dry-run 团队资产沉淀计划。

分类矩阵：
${JSON.stringify(classification)}

输出：
1. 推荐沉淀为 AgentPanel 预设动态 workflow 的资产。
2. 推荐保留为团队级 .claude/commands 或 .claude/skills 的资产。
3. 推荐只作为 docs/reference 的资产。
4. 不建议迁移或必须重写的资产。
5. 每项的建议落点、风险等级、人工确认门槛。

不要声称已移动或已整理任何文件。`,
  {
    label: 'plan-asset-classification',
    phase: 'Plan',
  }
);

return { options, inventory, classification, plan };
