// menus.mjs — static menu/action data, extracted from hermit.mjs so it is
// importable and unit-testable without hermit.mjs's import-time side effects.
//
// These are pure data (only BRAND) + the pure action-lookup helpers that travel
// with them. State-coupled menu helpers (actionStateLabel / currentMenuStatusItems
// / visibleMenuRows) still live in hermit.mjs — they previously couldn't move
// because they need currentFeatureStates(), which used to live in hermit.mjs
// (moving them then would have created a circular import). currentFeatureStates()
// has since moved to ./featureState.mjs, so that barrier is gone; these helpers
// can now follow it into a tested module whenever that's needed.
import { BRAND } from '../branding.mjs';

export const NAV_ACTIONS = [
  {
    id: 'data-sync',
    label: '消息总线',
    description: '回车展开；消息上报启动后台增量扫描，只上报最近 7 天；可手动重报最近 7 天',
    children: [
      { id: 'toggle-message-upload', label: '开启/关闭 用量上报', toggle: 'conversation-upload' },
      {
        id: 'scan',
        label: '重报最近 7 天',
        description: '忽略游标重扫最近 7 天并补传；服务端按 eventId 自动去重',
      },
      { id: 'upload-logs', label: '查看上报日志', developerOnly: true },
      { id: 'overview', label: '查看同步状态' },
    ],
  },
  {
    id: 'account',
    label: '用户',
    description: '回车展开；登录、查看登录状态、退出登录',
    children: [
      { id: 'login', label: '飞书登录' },
      { id: 'logout', label: '退出登录' },
      { id: 'status', label: '查看登录状态' },
    ],
  },
  {
    id: 'aikey',
    label: 'token 池（Beta）',
    description: '回车展开；签发并认领 AI 网关 key，可选写入 Claude/Codex 配置，支持一键恢复',
    children: [
      {
        id: 'aikey-claim',
        label: '认领',
        description:
          '签发消费者并认领 key；可选写入 Codex / Claude Code / Pi（默认仅 Codex），并更新本地配置与 aikey env',
      },
      {
        id: 'aikey-manual',
        label: '说明书',
        description:
          '在线说明书 + 本地脱敏配置：变量名、端点和可用模型（给 agent 用，不含明文 key）',
      },
      {
        id: 'aikey-restore',
        label: '恢复配置快照',
        description: '选择 ~/.hermit/agentcli.env.bak 中的时间点，还原 Claude/Codex/Pi 配置',
      },
      { id: 'aikey-status', label: '状态', description: '查看当前 token 池状态' },
    ],
  },
  {
    id: 'exit',
    label: '退出',
    description: `离开 ${BRAND.stylizedName} 终端入口`,
  },
];

export const SERVICE_ACTIONS = [
  {
    id: 'start-usage',
    label: '启动 Usage 后台采集',
    description: '轻量后台进程 + 默认开机自启；不上传',
  },
  {
    id: 'start-collaboration',
    label: '团队协作（企业版）',
    description: 'IM 协作为企业版开放；开源版无需开启',
  },
  {
    id: 'status',
    label: '查看服务状态',
    description: '查看本地服务、usage worker 和企业版协作状态',
  },
  {
    id: 'stop-usage',
    label: '停止 Usage 采集',
    description: '停止 usage worker 并关闭开机自启',
  },
  {
    id: 'back',
    label: '返回首页',
    description: `回到 ${BRAND.stylizedName} 导航`,
  },
];

export const LOCAL_USE_ACTIONS = [
  {
    id: 'employees',
    label: '数字员工',
    description: '本机团队创建、列表和管理',
  },
  {
    id: 'local-collection',
    label: '本地数据采集',
    description: '查看本机 Loop 使用概览；无需登录',
  },
  {
    id: 'runtime',
    label: '本地运行时',
    description: '后台服务状态、诊断和生命周期管理',
  },
  {
    id: 'back',
    label: '返回首页',
    description: `回到 ${BRAND.stylizedName} 导航`,
  },
];

export const TEAM_COLLAB_ACTIONS = [
  {
    id: 'task-bus',
    label: 'IM 协作状态',
    description: '查看企业版 IM 协作状态',
  },
  {
    id: 'account',
    label: '用户状态',
    description: `查看或退出当前 ${BRAND.authAccountLabel}`,
  },
  {
    id: 'back',
    label: '返回首页',
    description: `回到 ${BRAND.stylizedName} 导航`,
  },
];

export const EMPLOYEE_ACTIONS = [
  {
    id: 'create-team',
    label: '创建数字员工团队',
    description: '写入本地团队元数据',
  },
  {
    id: 'list-teams',
    label: '查看数字员工列表',
    description: '列出可见团队，隐藏已删除项',
  },
  {
    id: 'back',
    label: '返回首页',
    description: `回到 ${BRAND.stylizedName} 导航`,
  },
];

export const RUNTIME_ACTIONS = [
  {
    id: 'status',
    label: '服务状态',
    description: '查看本地 daemon 和运行状态',
  },
  {
    id: 'doctor',
    label: '本地诊断',
    description: '只读检查配置与服务',
  },
  {
    id: 'stop',
    label: '停止后台服务',
    description: '结束后台 daemon/runtime',
  },
  {
    id: 'back',
    label: '返回首页',
    description: `回到 ${BRAND.stylizedName} 导航`,
  },
];

export const LOCAL_COLLECTION_ACTIONS = [
  {
    id: 'overview',
    label: '查看同步状态',
    description: '显示消息上报后台和本机扫描状态',
  },
  {
    id: 'scan',
    label: '重报最近 7 天',
    description: '忽略游标重扫最近 7 天并补传；服务端按 eventId 自动去重',
  },
  {
    id: 'choose-upload-provider',
    label: '开启消息上报',
    description: '默认同时扫描 Claude Code + Codex；按批次增量上传',
  },
  {
    id: 'stop-background',
    label: '停止消息上报',
    description: '停止消息上报 worker，并关闭开机自启',
  },
  {
    id: 'back',
    label: '返回首页',
    description: `回到 ${BRAND.stylizedName} 导航`,
  },
];

export const TASK_BUS_ACTIONS = [
  {
    id: 'status',
    label: '查看 IM 协作状态',
    description: '企业版 IM 协作状态',
  },
  {
    id: 'doctor',
    label: '本地诊断',
    description: '只读检查服务和本地路径',
  },
  {
    id: 'back',
    label: '返回首页',
    description: `回到 ${BRAND.stylizedName} 导航`,
  },
];

export const ACCOUNT_ACTIONS = [
  {
    id: 'login',
    label: '飞书登录',
    description: '用于云端授权和托管服务；本地使用无需登录',
  },
  {
    id: 'status',
    label: '查看登录状态',
    description: `查看 ${BRAND.authAccountLabel} 授权状态`,
  },
  {
    id: 'logout',
    label: '退出登录',
    description: `退出 ${BRAND.authAccountLabel}，不影响本地 runtime 登录`,
  },
  {
    id: 'back',
    label: '返回首页',
    description: `回到 ${BRAND.stylizedName} 导航`,
  },
];

export function findMenuAction(actions, actionId) {
  for (const action of actions) {
    if (action.id === actionId) return action;
    const child = action.children?.find((item) => item.id === actionId);
    if (child) return child;
  }
  return null;
}

export function menuFooterForEscape() {
  return '[↑↓/Ctrl-N/P 选择 · Enter 展开/确认 · ← 返回 · Esc 退出]';
}
