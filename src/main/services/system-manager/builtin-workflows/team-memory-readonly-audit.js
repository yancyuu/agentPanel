export const meta = {
  name: 'team-memory-readonly-audit',
  description:
    'Read-only audit for team memory, CLAUDE/AGENTS instructions, project memory layers, conflicts, staleness, and sensitive-risk routing.',
  category: 'team',
  safety: 'audit',
  order: 116,
  phases: [
    { title: 'Audit', detail: 'Inspect memory and instruction layers without changing them' },
    {
      title: 'Route',
      detail:
        'Classify conflicts and route knowledge to memory, workflow, skill, command, docs, or review',
    },
    { title: 'Report', detail: 'Return a human-confirmation plan only' },
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
    hermitHome:
      typeof parsed.hermitHome === 'string' && parsed.hermitHome.trim()
        ? parsed.hermitHome.trim()
        : '~/.hermit',
    includeClaudeAutoMemory: parsed.includeClaudeAutoMemory === true,
    includeLegacyCaches: parsed.includeLegacyCaches === true,
  };
}

const options = normalizeOptions(args);
const safetyRules = [
  '默认只读：不要创建、编辑、移动、删除、复制、截断、合并或重写任何 memory/config 文件。',
  '不把建议自动写入 CLAUDE.md、AGENTS.md、.claude、.hermit、.omc 或用户 memory。',
  '不读取 .env、.mcp.json、settings.local.json、credential、token、cookie、private key 或 secret 文件内容。',
  '不输出完整敏感路径、secret 值、用户消息正文或 tool_result 正文。',
  '对 legacy/cache/runtime 状态只报告存在性和风险类型，不把它们当 canonical memory。',
];

phase('Audit');
const audit = await agent(
  `只读审计团队记忆、项目指令和长期规则分层。

项目根：${options.projectRoot}
AgentPanel home：${options.hermitHome}
includeClaudeAutoMemory=${options.includeClaudeAutoMemory}
includeLegacyCaches=${options.includeLegacyCaches}

安全边界：
${safetyRules.map((rule) => `- ${rule}`).join('\n')}

请只读检查：
1. CLAUDE.md、AGENTS.md、README、docs/runbook 中的团队协作和运维规则。
2. .claude/commands、.claude/skills、.claude/settings*.json 的非敏感结构。
3. ${options.hermitHome}/teams/<team>/team.json、团队工作区协作指令和运维说明。
4. ${options.hermitHome}/.claude/workflow/ 中预设动态 workflow 的可发现性。
5. .omc/project-memory.json、项目 memory index、Claude auto-memory 的标题/摘要级信息；仅当 includeClaudeAutoMemory=true 才检查用户 auto-memory。
6. legacy/cache/runtime 仅在 includeLegacyCaches=true 时检查存在性，不读取正文。

重点找：层级冲突、重复事实、过期路径/命令、敏感风险、流程 SOP 被错误写成 memory、需要升级为 workflow/skill 的规则。`,
  {
    label: 'audit-memory-layers',
    phase: 'Audit',
    agentType: 'Explore',
  }
);

phase('Route');
const routing = await agent(
  `根据以下审计结果，为每个问题给出知识路由建议，不要修改任何文件。

审计结果：
${JSON.stringify(audit)}

路由目标：
- team memory：单团队业务事实、数据源、决策、经验教训。
- workspace/project memory：跨团队治理、命名、模板、运行规则。
- dynamic workflow：稳定可重复的多步骤运维流程。
- skill：稳定领域知识、工具使用准则、SOP。
- command：短小即时操作入口。
- docs/reference：背景材料和外部参考。
- needs-review：不确定、敏感、冲突、可能过期的内容。

输出冲突类型、证据路径、建议路由、是否需要人工确认。`,
  {
    label: 'route-memory-findings',
    phase: 'Route',
  }
);

phase('Report');
const report = await agent(
  `用中文生成团队记忆只读审计报告。

路由建议：
${JSON.stringify(routing)}

输出：
1. 记忆/指令层级图。
2. 冲突、重复、过期和敏感风险清单。
3. 建议路由：memory / dynamic workflow / skill / command / docs / needs-review。
4. 高价值运维规则候选。
5. 后续人工修复计划。

不要声称已修复；不要输出 secret 或完整消息正文。`,
  {
    label: 'report-memory-audit',
    phase: 'Report',
  }
);

return { options, audit, routing, report };
