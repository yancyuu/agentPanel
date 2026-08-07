import type { SystemManagerConfig, SystemManagerConfigPatch } from '@shared/types/systemManager';

/**
 * 诊断 bootstrap.
 *
 * On first open of the diagnostics console, the canonical local AgentPanel guide is
 * persisted as the workspace CLAUDE.md (the durable bootstrap marker), then fed
 * to the admin lead session as its first turn. The source of truth for "already
 * initialized" is the CLAUDE.md artifact itself — not a persisted boolean — so
 * deleting or losing the file reliably re-triggers the bootstrap, and a failed
 * agent session can never leave the marker set while the file is missing.
 *
 * Extracted from server.ts as a pure, dependency-injected unit so the
 * idempotency and failure semantics are unit-testable without spawning the
 * direct-CLI runtime or hitting the network.
 */

/** Deterministic id for the bootstrap message (one-shot, never reused). */
export const ADMIN_INIT_MESSAGE_ID = 'agentpanel-diagnostics-init-v2';
export const AGENTPANEL_OPS_GUIDE_MARKER = 'AgentPanel Ops Guide Version: 2';

/** Canonical local guide. Do not bootstrap from the legacy public openHermit installation page. */
export const CURRENT_AGENTPANEL_OPERATIONS_GUIDE = `${AGENTPANEL_OPS_GUIDE_MARKER}
# AgentPanel 诊断与任务运维指南

## 产品模型

- 数字员工：独立执行者。创建完成后即可接收任务。
- 调教：短周期、多轮地调整数字员工的回答和做事方式，不创建任务。
- 任务：长周期目标，必须有状态、澄清、进度、交付和审核。
- 团队：由一个负责人编排多个数字员工，不是数字员工本身。
- 诊断：只读检查本地运行环境、配置、任务总线和工作区健康状态。

## Workbench 与 AgentPanel

- Workbench 内置同版本 AgentPanel，用户不需要全局安装 openhermit、open-hermit 或 hermit。
- 不要修改用户 Shell 配置或全局 PATH。
- Agent 应优先使用 \`$HERMIT_HOME/bin/agentpanel\`；默认 HERMIT_HOME 为 \`~/.hermit\`。
- Workbench 地址由 \`HERMIT_WORKBENCH_URL\` 或当前运行端口提供，不要把 5680 当成永久固定地址。
- \`~/.hermit\`、\`HERMIT_*\` 和旧 API 仅作为历史兼容契约保留。

## 任务生命周期

1. 用户在收件箱选择数字员工并创建任务。
2. 有负责人的任务立即进入“进行中”，并以长周期目标派发。
3. Agent 使用任务总线认领任务并持续更新进度。
4. 信息不足时，Agent 先写清问题，再标记“等待补充说明”。
5. 用户在任务评论区回复后，系统自动清除等待状态并继续派发。
6. Agent 提交交付结果后，任务进入“待审核”。
7. 用户确认后，任务才进入“已完成”。

Agent 使用以下命令维护任务状态：

- \`agentpanel tasks list --team {team-id}\`
- \`agentpanel tasks claim --team {team-id} --id {task-id}\`
- \`agentpanel tasks comment --team {team-id} --id {task-id} --text "进度或问题"\`
- \`agentpanel tasks clarify --team {team-id} --id {task-id} --target user\`
- \`agentpanel tasks complete --team {team-id} --id {task-id} --result "交付结果"\`

不要使用 MCP、Skills、TodoWrite 或运行时自带任务系统替代 AgentPanel 任务总线。

## 用户交互约束

- 面向用户只使用“数字员工、调教、任务、待审核、已完成、诊断”等直白概念。
- 不向用户展示 conversationId、session、runtime、reviewState、Loop 协议或 \`/goal\` 等内部实现。
- “创建任务”是全局长周期入口；“调教”是数字员工详情中的短周期入口。
- 工具调用默认自动允许，不弹出 Allow / Deny / Allow all 授权框。

## 诊断安全边界

- 默认只读诊断，不自动删除、移动、格式化、提交、推送、发布或部署。
- 不输出 token、cookie、私钥或完整凭据。
- 需要修复时先给出问题、证据和验证方法，再执行用户明确批准的修改。
- 诊断页面名称是“诊断”；内部 \`system-manager\` 标识和历史配置路径保持兼容。

## 外部渠道与数据

- 外部渠道只表示数字员工“可对外”，不决定它能否执行任务。
- 飞书等渠道必须按账号或团队隔离 profile，不共享用户凭据。
- Workbench API 和本地 \`~/.hermit\` 数据是任务状态的事实来源。`;

/** Lightweight HTML → plain text: strip script/style, drop tags, decode entities, collapse whitespace. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Build the bootstrap prompt wrapping the guide text. Pure — tested directly. */
export function buildAdminInitMessage(guideText: string): string {
  return [
    '【诊断初始化】当前 AgentPanel 运维手册已经写入工作区 CLAUDE.md。请将它作为最新运行契约。',
    '不要安装或调用旧 openhermit、open-hermit、hermit，也不要从历史网页复制旧安装说明。',
    '任务通过 Workbench 和内置 AgentPanel 任务总线管理；短周期行为调整使用“调教”。',
    '',
    '--- 运维手册 ---',
    guideText,
  ].join('\n');
}

export interface AdminLoopInitDeps {
  getConfig: () => Promise<SystemManagerConfig>;
  updateConfig: (patch: SystemManagerConfigPatch) => Promise<SystemManagerConfig>;
  /** Existing persistent bootstrap artifact, e.g. workspace CLAUDE.md. */
  hasExistingBootstrap?: () => Promise<boolean>;
  /**
   * Persist the bootstrap guide as the workspace CLAUDE.md so the artifact —
   * and therefore the gate — survives even when the dispatched agent session
   * fails to start. The plain-text guide body is passed through unchanged.
   */
  writeBootstrapArtifact?: (guideText: string) => Promise<void>;
  /** Load the canonical ops guide. Resolves with statusCode + raw body. */
  fetchGuide: () => Promise<{ statusCode: number; body: string }>;
  /** Deliver the bootstrap message to the admin lead session. */
  dispatch: (message: { text: string; messageId: string }) => Promise<void>;
  /** Optional diagnostic sink (warnings only). */
  log?: (message: string) => void;
}

/**
 * Run the one-shot bootstrap when the workspace CLAUDE.md artifact is missing.
 *
 * - Artifact-gated: `hasExistingBootstrap` (CLAUDE.md presence) is the single
 *   source of truth — present → done, absent → (re)bootstrap, even if the
 *   persisted `adminInitialized` boolean is already `true`. This makes init
 *   detection reflect reality instead of a flag that can drift out of sync
 *   (e.g. a failed agent session that set the flag but never produced the file).
 * - Failure-tolerant: a network error, non-2xx status, or empty body returns
 *   WITHOUT writing the artifact, dispatching, or setting the flag, so the next
 *   console open retries.
 */
export async function ensureAdminLoopInitialized(deps: AdminLoopInitDeps): Promise<void> {
  if (await deps.hasExistingBootstrap?.()) {
    await syncAdminInitializedMarker(deps);
    return;
  }

  let body = '';
  try {
    const res = await deps.fetchGuide();
    if (res.statusCode >= 200 && res.statusCode < 300) {
      body = htmlToPlainText(res.body);
    }
  } catch (err) {
    deps.log?.(
      `diagnostics init: guide load failed (${err instanceof Error ? err.message : String(err)})`
    );
    return;
  }

  if (!body.trim()) {
    deps.log?.('diagnostics init: empty guide body, will retry next open');
    return;
  }

  // Write the durable CLAUDE.md marker before dispatching, so the gate is
  // satisfied even if the agent session fails to start on this pass.
  await deps.writeBootstrapArtifact?.(body);
  await deps.dispatch({ text: buildAdminInitMessage(body), messageId: ADMIN_INIT_MESSAGE_ID });
  await deps.updateConfig({ adminInitialized: true });
}

/** Keep the persisted `adminInitialized` hint in sync with an existing artifact (idempotent write). */
async function syncAdminInitializedMarker(deps: AdminLoopInitDeps): Promise<void> {
  if (!(await deps.getConfig()).adminInitialized) {
    await deps.updateConfig({ adminInitialized: true });
  }
}
