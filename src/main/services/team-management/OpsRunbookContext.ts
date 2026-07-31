/**
 * Compact AgentCLI operations context injected into managed agent instructions.
 *
 * Keep this short: agents need the stable runbook boundary and pointers, not the
 * full public guide copied into every session.
 */

export const HERMIT_OPS_GUIDE_URL = 'https://yancyuu.github.io/agentcli/';

const OPS_CONTEXT_BEGIN = '<!-- hermit:ops-runbook-context:start -->';
const OPS_CONTEXT_END = '<!-- hermit:ops-runbook-context:end -->';

const OPS_RUNBOOK_CONTEXT = `## AgentCLI Ops Runbook Context

Local canonical docs: README.md, docs/README.md, docs/TEAM_COLLABORATION_MODEL.md
Bundled diagnostics guide: the versioned AgentCLI guide written to the diagnostics CLAUDE.md.

AgentCLI is a local-first digital-worker Workbench. Humans create long-running work from
the global “创建任务” inbox, review delivery in “待审核”, and use “调教” from an Agent page
for short behavior adjustments. Agents maintain task state through the bundled AgentCLI
Task Bus. Treat ~/.hermit/ and HERMIT_* as backward-compatible storage/API contracts, not
as the current product name. hermit-bridge remains an internal compatibility sidecar.

Compatibility diagnostic workflows may still use the historical /hermit namespace under
~/.claude/commands/hermit/. Keep these names internal; the user-facing product entry is “诊断”:
- /hermit:doctor — diagnose install/runtime/config health.
- /hermit:loop-scan — inspect Loop assets and recommended recurring loops.
- /hermit:summary — summarize team/session status and next actions.
- /hermit:daily-folder-hygiene — check temporary files, stale reports, and workspace clutter.
- /hermit:daily-memory-conflict-check — check CLAUDE/AGENTS/memory/settings conflicts.
- /hermit:daily-workflow-extraction — extract reusable prompts/workflows from recent work.
- /hermit:worktree-scan — inspect dirty or stale worktrees before cleanup decisions.

Safety boundary for operations workflows:
- Default to read-only diagnosis. Do not modify, delete, move, format, commit, push,
  publish, deploy, or run destructive commands unless the user explicitly approves.
- Explain the purpose before commands; prefer read-only commands for diagnostics.
- Do not expose secrets, tokens, cookies, private keys, or full sensitive paths.
- If a fix is needed, report recommendations, verification steps, and an optional
  patch plan before applying changes.
- Treat the bundled versioned diagnostics guide and local docs as authoritative. Do not
  copy installation commands or product semantics from historical openHermit pages.`;

export function buildHermitOpsRunbookContext(): string {
  return `${OPS_CONTEXT_BEGIN}\n\n${OPS_RUNBOOK_CONTEXT}\n\n${OPS_CONTEXT_END}`;
}

export function removeHermitOpsRunbookContext(content: string): string {
  return content
    .replace(new RegExp(`\\n{0,2}${OPS_CONTEXT_BEGIN}[\\s\\S]*?${OPS_CONTEXT_END}\\n?`, 'g'), '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

export function buildMemberWorkflowWithOpsContext(memberWorkflow?: string): string {
  const workflow = removeHermitOpsRunbookContext(memberWorkflow ?? '').trim();
  const context = buildHermitOpsRunbookContext();
  return workflow ? `${workflow}\n\n${context}` : context;
}
