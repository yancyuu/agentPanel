export const meta = {
  name: 'workflow-inventory-audit',
  description:
    'Read-only inventory audit for AgentCLI and Claude Code workflows, commands, skills, cron, hooks, and generated dynamic workflow scripts.',
  category: 'compliance',
  safety: 'audit',
  order: 115,
  phases: [
    {
      title: 'Inventory',
      detail: 'Find saved and generated automation assets without executing them',
    },
    {
      title: 'Classify',
      detail:
        'Classify assets as workflow, command, skill, cron, connector, docs, or do-not-migrate',
    },
    { title: 'Report', detail: 'Return a concise migration and risk report' },
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
    projectRoot:
      typeof parsed.projectRoot === 'string' && parsed.projectRoot.trim()
        ? parsed.projectRoot.trim()
        : 'current project',
    hermitWorkflowDir:
      typeof parsed.hermitWorkflowDir === 'string' && parsed.hermitWorkflowDir.trim()
        ? parsed.hermitWorkflowDir.trim()
        : '~/.hermit/.claude/workflow',
    includeGeneratedArtifacts: parsed.includeGeneratedArtifacts !== false,
  };
}

const options = normalizeOptions(args);
const safetyRules = [
  '只读审计：不要创建、编辑、移动、删除、复制、格式化、提交、推送、发布或部署任何文件。',
  '不要执行 workflow、script、hook、cron、package script 或外部命令；只读取文件名、metadata、说明和少量结构。',
  '不要读取 .env、.mcp.json、settings.local.json、credential、token、cookie、private key 或 secret 文件内容。',
  '如遇敏感路径，只报告路径类别、文件名或风险类型，不输出值。',
  '所有改变长期状态的动作必须停在人工确认计划。',
];

phase('Inventory');
const inventory = await agent(
  `只读盘点 AgentCLI / Claude Code / 项目自动化资产。

目标项目：${options.projectRoot}
AgentCLI 预设 workflow 目录：${options.hermitWorkflowDir}
includeGeneratedArtifacts=${options.includeGeneratedArtifacts}

安全边界：
${safetyRules.map((rule) => `- ${rule}`).join('\n')}

请只读查找这些资产是否存在，并提取路径、名称、描述、类型和明显风险动作：
1. ${options.hermitWorkflowDir} 下的动态 workflow (*.js) 与兼容 prompt workflow (*.md)。
2. 项目级 .claude/commands、.claude/skills、.claude/agents。
3. .omc/workflows、.omc/state、.omc/plans 中的可复用流程线索。
4. .github/workflows、package scripts、cron schedules、hooks。
5. capability packs、MCP/plugin/connector 配置的非敏感结构。
6. 如果 includeGeneratedArtifacts=true，查找会话生成的 workflow scripts，但不要执行。

不要读取或输出 secret 文件内容。`,
  {
    label: 'inventory-automation-assets',
    phase: 'Inventory',
    agentType: 'Explore',
  }
);

phase('Classify');
const classification = await agent(
  `根据以下只读清单，把自动化资产分类并判断是否适合沉淀为 AgentCLI 预设动态 workflow。

清单：
${JSON.stringify(inventory)}

分类：workflow / command / skill / cron-loop / connector-mcp / docs-reference / do-not-migrate。
成熟度：ready / needs-parameterization / needs-approval-gate / rewrite-required / do-not-migrate。
风险：read-only / reporting / audit / proposal-only / apply / destructive。

判断原则：
- 多步骤、需要 LLM 判断、可周期执行的流程优先归类为 workflow。
- 稳定知识、工具用法、SOP 归类为 skill。
- 外部系统写入、密钥、私有业务 ID、删除/移动/上传默认 rewrite-required 或 do-not-migrate。
- 已有 prompt command 不要重复造第二套，建议复用或升级为动态 workflow。

返回分类矩阵和迁移建议。`,
  {
    label: 'classify-automation-assets',
    phase: 'Classify',
  }
);

phase('Report');
const report = await agent(
  `用中文生成 AgentCLI 运维能力盘点报告。

分类结果：
${JSON.stringify(classification)}

输出：
1. 已安装/已沉淀能力。
2. 值得产品化为 AgentCLI 预设动态 workflow 的候选，含建议文件名、用途、安全等级和理由。
3. 重复或冲突入口。
4. 高风险自动化和必须人工确认的边界。
5. 不建议迁移的资产及原因。

不要提出任何已经执行过的修改；只输出报告和下一步计划。`,
  {
    label: 'report-workflow-inventory',
    phase: 'Report',
  }
);

return { options, inventory, classification, report };
