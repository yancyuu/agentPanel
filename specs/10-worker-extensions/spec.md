# Spec 10 — 数字员工扩展管理重构

## 背景与动机

当前 extensions 模块（~13,700 行，30+ 文件）包含全局的 Skills 商店、MCP 商店和插件商店。问题：

1. **Skills 和 MCP 的全局商店是多余抽象** — cc-connect 已经在 per-project 级别管理 MCP 和 skills（web UI + API），Hermit 再做一层 catalog / registry / enrichment 是重复劳动。
2. **用户心智模型是 per-worker 的** — 管理者想的是"这个数字员工有什么工具、会什么技能"，而不是"去商店逛逛"。
3. **缺少关键功能** — 每个 Worker（数字员工）的 MCP 和 skills 展示与分配完全没有。
4. **维护成本高** — Glama enrichment、official registry、catalog aggregator 等服务长期维护负担大，但用户价值低。

## 决策

| 扩展类型 | 全局商店 | Per-Worker 管理 | 数据源 |
|----------|----------|----------------|--------|
| **Plugins** | ✅ 保留（轻量化） | — | 本地安装状态 |
| **Skills** | ❌ 移除 | ✅ 新增 | cc-connect API |
| **MCP** | ❌ 移除 | ✅ 新增 | cc-connect API |

## 架构

### Before（当前）

```
全局商店（ExtensionStoreView）
  ├── Skills tab（catalog, scanner, editor, review, scaffold, watcher, import...）
  ├── MCP tab（catalog aggregator, official registry, Glama enrichment, install...）
  └── Plugins tab

→ 安装后不知道分配给了谁
```

### After（目标）

```
插件商店（全局，轻量）
  └── Plugins tab（保留现有插件管理）

Worker 详情页 → "工具" tab
  ├── 已分配 MCP servers（从 cc-connect 读）
  │   └── [添加] → 从 cc-connect 可用 MCP 列表选择 / 手动输入
  ├── 已分配 Skills（从 cc-connect 读）
  │   └── [添加] → 从项目 .claude/skills/ 扫描 / 手动创建
  └── 状态 & 诊断（MCP 连接状态、skill 启用状态）
```

## 要删除的代码

### Main 进程（src/main/services/extensions/）

| 文件 | 行为 |
|------|------|
| `catalog/McpCatalogAggregator.ts` | 删除 — cc-connect 管理 catalog |
| `catalog/OfficialMcpRegistryService.ts` | 删除 — 不再需要官方 registry |
| `catalog/GlamaMcpEnrichmentService.ts` | 删除 — 不再需要 Glama enrichment |
| `install/McpInstallService.ts` | 删除 — 安装走 cc-connect |
| `install/PluginInstallService.ts` | 保留 — 插件安装仍需要 |
| `state/McpInstallationStateService.ts` | 删除 — 不再跟踪 MCP 安装状态 |
| `state/PluginInstallationStateService.ts` | 保留 |
| `skills/SkillsCatalogService.ts` | 删除 — 不再需要全局 skills catalog |
| `skills/SkillScanner.ts` | 评估 — 可能保留用于 per-worker 扫描 |
| `skills/SkillScaffoldService.ts` | 评估 — 创建 skill 仍需要 |
| `skills/SkillsWatcherService.ts` | 删除 — 全局 watcher 不需要 |
| `skills/SkillImportService.ts` | 评估 — 导入功能可能保留 |
| `skills/SkillPlanService.ts` | 删除 |
| `skills/SkillReviewService.ts` | 评估 — per-worker review 可能保留 |
| `skills/SkillRootsResolver.ts` | 保留 — 解析 skill 路径仍需要 |
| `skills/SkillMetadataParser.ts` | 保留 |
| `skills/SkillValidator.ts` | 保留 |
| `skills/SkillsMutationService.ts` | 评估 — 改为 per-worker mutation |
| `runtime/*` | 大部分保留 — 运行时适配仍需要 |

### Renderer（src/renderer/components/extensions/）

| 文件 | 行为 |
|------|------|
| `ExtensionStoreView.tsx` | 重写 — 只保留 plugins tab |
| `mcp/*` | 全部删除 — 移到 Worker 详情页 |
| `skills/SkillsPanel.tsx` | 重写 — 改为 per-worker |
| `skills/SkillEditorDialog.tsx` | 保留 — 编辑 skill 仍需要 |
| `skills/SkillReviewDialog.tsx` | 保留 |
| `skills/skillProjectUtils.ts` | 保留 |
| `plugins/*` | 保留 |
| `env/*` | 保留 |

### Shared types（src/shared/types/extensions/）

| 文件 | 行为 |
|------|------|
| `mcp.ts` | 大幅精简 — 删除 catalog 相关类型 |
| `skill.ts` | 精简 — 删除 catalog 相关类型 |
| `plugin.ts` | 保留 |
| `api.ts` | 精简 |
| `common.ts` | 保留 |
| `apikey.ts` | 保留 |

## 新增功能

### 1. Worker 工具面板（WorkerToolsPanel）

位置：`src/renderer/components/team/WorkerToolsPanel.tsx`

在 Worker 详情页新增 "工具" tab，包含两个子面板：

**MCP 子面板：**
- 展示当前 Worker 已配置的 MCP servers（从 cc-connect `GET /api/v1/projects/:name` 读取）
- 每个 MCP 显示：名称、状态（connected/error）、工具数量
- [添加 MCP] 按钮 → 从 cc-connect 可用列表选择 或 手动输入 command/URL
- [移除] 按钮 → 通过 cc-connect API 更新配置
- MCP 连接诊断（从 cc-connect 读状态）

**Skills 子面板：**
- 展示当前 Worker 已分配的 skills（从 cc-connect 读取 + 本地 `.claude/skills/` 扫描）
- 每个 skill 显示：名称、描述、来源
- [添加 Skill] 按钮 → 从项目 skills 目录选择 / 手动创建
- [编辑] → 打开 SkillEditorDialog
- [移除]

### 2. cc-connect 数据桥接

位置：`src/main/services/ccConnect/CcConnectExtensionBridge.ts`（新建）

```ts
/**
 * 从 cc-connect API 读取 per-project 的 MCP 和 skills 数据，
 * 提供给 renderer 的 Worker 工具面板。
 */
export class CcConnectExtensionBridge {
  constructor(private cc: CcConnectClient) {}

  /** 获取 project 的 MCP 配置 */
  async getProjectMcpServers(projectName: string): Promise<McpServerConfig[]>;

  /** 添加 MCP server 到 project */
  async addMcpServer(projectName: string, config: McpServerConfig): Promise<void>;

  /** 移除 project 的 MCP server */
  async removeMcpServer(projectName: string, serverName: string): Promise<void>;

  /** 获取 project 的 skills 列表 */
  async getProjectSkills(projectName: string): Promise<SkillEntry[]>;

  /** 获取 MCP 连接状态诊断 */
  async getMcpDiagnostics(projectName: string): Promise<McpDiagnostic[]>;
}
```

### 3. 精简后的插件商店

`ExtensionStoreView.tsx` 重写为只包含 plugins tab：
- 移除 skills tab 和 MCP tab
- 移除 catalog 相关的状态管理
- 保留插件的安装/卸载/更新流程

## 数据流

```
用户操作（添加 MCP 到 Worker）
  → renderer: WorkerToolsPanel 点击 [添加 MCP]
  → IPC: team:addMcpServer({ teamName, config })
  → main: CcConnectExtensionBridge.addMcpServer(teamName, config)
    → cc-connect API: PATCH /api/v1/projects/:name + restart if needed
  → renderer: 刷新 MCP 列表
```

## 用户故事

- US-1：作为管理者，我打开一个数字员工的详情页，点击"工具"tab，一眼看到这个员工有哪些 MCP 工具和 Skills。
- US-2：作为管理者，我点击"添加 MCP"，从可用列表中选择一个 MCP server，分配给这个员工。
- US-3：作为管理者，我看到某个 MCP 显示红色（连接错误），点击查看诊断信息。
- US-4：作为管理者，我给一个员工添加一个新 Skill，编辑后保存到项目的 `.claude/skills/` 目录。

## 验收标准

- [ ] 全局商店只保留 plugins tab
- [ ] Worker 详情页有"工具"tab，展示 MCP 和 Skills
- [ ] MCP 列表从 cc-connect API 实时读取
- [ ] Skills 列表从项目目录 + cc-connect 读取
- [ ] 可通过 UI 添加/移除 MCP server（走 cc-connect API）
- [ ] 可通过 UI 添加/编辑/移除 Skill
- [ ] 删除 McpCatalogAggregator、OfficialMcpRegistryService、GlamaMcpEnrichmentService、SkillsCatalogService
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build` 通过

## 落地步骤

1. **新建 CcConnectExtensionBridge** — cc-connect API 数据桥接
2. **新建 WorkerToolsPanel** — Worker 详情页的工具 tab UI
3. **接入 Worker 详情页** — 在 TeamDetailView 添加 tab
4. **精简 ExtensionStoreView** — 只保留 plugins
5. **删除废弃代码** — catalog、registry、enrichment 等
6. **清理 types** — 精简 extensions 类型定义
7. **测试** — typecheck + build + 手动验证

## 预估代码量变化

- 删除：~5,000-6,000 行（catalog、registry、enrichment、全局 MCP/skills UI）
- 新增：~800-1,200 行（WorkerToolsPanel、CcConnectExtensionBridge、IPC）
- 净减少：~4,000-5,000 行
