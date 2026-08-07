# Extension Store Backend — Spec

将 `claude_agent_teams_ui` 的 Plugins / MCP Servers / Skills 后端服务移植到 Hermit，并适配 Hermit 的多 harness 架构。

## 1. 目标

在 Hermit 中实现完整的 Extension Store 后端：
- **Plugins** — 从 Claude marketplace 拉取插件目录，支持安装/卸载
- **MCP Servers** — 从 Official Registry + Glama 聚合 MCP 服务目录，支持安装/卸载/自定义添加
- **Skills** — 扫描文件系统中的 SKILL.md，支持 CRUD、导入、审查

Extension Store **只管安装**，不管配置。项目配置（启用哪些 MCP、加载哪些 Skills、环境变量）在 Project Settings 中管理。

## 2. 扩展类型与凭据模型

### 2.1 三种扩展类型的本质区别

| | Plugins | MCP Servers | Skills |
|---|---------|-------------|--------|
| **是什么** | Claude Code 私有扩展 | 通用协议服务进程 | 指令文件（含 CLI/脚本调用） |
| **通用性** | 仅 claudecode | 任何支持 MCP 的 harness | 大部分 harness |
| **凭据** | 无 | 全局一套（跟着 MCP 安装走） | 项目级（不同项目不同凭据） |
| **按项目差异** | 不需要 | 不需要 | 需要 |

### 2.2 凭据管理

**MCP 凭据 → 跟着安装走（全局）**
- MCP 是通用服务（文件系统、数据库、搜索引擎等）
- 安装时配置密钥，全局共享
- 所有项目启用同一个 MCP server，用同一套凭据

**Skills 凭据 → 项目环境变量（按项目不同）**
- Skills 包含 CLI 调用和脚本（如 feishu-cli、gh）
- 不同项目需要不同凭据（不同飞书 app、不同 GitHub org）
- 通过项目级环境变量解决

```
┌─────────────────────────────────────────────────────┐
│ Extension Store（全局安装）                           │
│                                                     │
│ MCP: 安装 + 全局凭据                                 │
│   feishu-mcp → APP_ID=global_id                     │
│   github-mcp → TOKEN=global_token                   │
│                                                     │
│ Skills: 安装到全局目录                                │
│   send-feishu-msg → 纯指令文件                       │
│   create-pr → 纯指令文件                             │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼ 启用 / 配置
┌─────────────────────────────────────────────────────┐
│ Project Settings（项目配置）                          │
│                                                     │
│ 启用 MCP（凭据已在全局配好，直接用）:                  │
│   ☑ feishu-mcp                                      │
│   ☑ github-mcp                                      │
│                                                     │
│ 启用 Skills:                                         │
│   ☑ send-feishu-msg（依赖 feishu-cli）               │
│   ☑ create-pr                                       │
│                                                     │
│ 项目环境变量（供 Skills / CLI 使用）:                  │
│   FEISHU_APP_ID      = aaa    ← 项目 A 的            │
│   FEISHU_APP_SECRET  = bbb                          │
│   GITHUB_TOKEN       = zzz                          │
└─────────────────────────────────────────────────────┘
```

### 2.3 环境变量的来源声明

项目选择后，系统自动扫描该项目需要的 env vars：

```typescript
// MCP server 定义中声明需要什么 env
interface McpCatalogItem {
  envVars: McpEnvVarDef[];  // { name, isRequired, description }
}

// Skill 的 SKILL.md frontmatter 声明依赖
// ---
// name: send-feishu-message
// required-env:
//   - FEISHU_APP_ID
//   - FEISHU_APP_SECRET
// ---
```

**项目环境变量面板流程：**
1. 用户选择项目
2. 系统扫描项目启用的 MCP + Skills，汇总所有 `required-env`
3. 展示面板：必填/可选、已填/未填、来源标注
4. 用户填值 → 加密存储（OS keychain 优先，AES-256-GCM 兜底）
5. Agent 启动时 → 注入已填写的变量 → 缺失的标红提醒

## 3. 多 Harness 安装

### 3.1 跨 Harness 通用性

| 扩展类型 | 跨 harness 通用？ | 原因 |
|---------|:---:|------|
| **Plugins** | 否 | Claude Code 私有格式，只有 claudecode 能用 |
| **MCP Servers** | 是 | MCP 是开放协议，任何支持 MCP 的 harness 都可连接 |
| **Skills** | 大部分 | `SKILL.md` 格式被多个 harness 采用 |

**UI 行为：**
- Plugins tab → 安装时 harness 自动锁定为 claudecode
- MCP tab → 安装时展示 harness 选择器（任何支持 MCP 的 harness）
- Skills tab → 安装时展示 harness 选择器（支持 SKILL.md 的 harness）

### 3.2 安装目标选择

| Scope | 说明 | Harness 可选 |
|-------|------|-------------|
| **Global** | 安装到当前用户全局配置 | Plugins 锁定 claudecode；MCP/Skills 选任一已安装 harness |
| **Project** | 安装到当前打开的项目 | 自动使用项目绑定的 harness，无需选择 |

### 3.3 Harness 安装适配器

```typescript
export interface HarnessInstallAdapter {
  readonly harnessType: CcAgentType;
  readonly supportsPlugins: boolean;
  readonly supportsMcp: boolean;
  readonly supportsSkills: boolean;

  resolveBinary(): Promise<string | null>;
  installPlugin(qualifiedName: string, opts: InstallOpts): Promise<OperationResult>;
  uninstallPlugin(qualifiedName: string, opts: InstallOpts): Promise<OperationResult>;
  installMcp(name: string, spec: McpInstallSpec, envValues: Record<string, string>,
             headers: McpHeaderDef[], opts: InstallOpts): Promise<OperationResult>;
  uninstallMcp(name: string, opts: InstallOpts): Promise<OperationResult>;
  listInstalledMcp(projectPath?: string): Promise<InstalledMcpEntry[]>;
  listInstalledPlugins(projectPath?: string): Promise<InstalledPluginEntry[]>;
  getSkillRoots(projectPath?: string): ResolvedSkillRoot[];
}
```

Harness 能力矩阵：

| Harness | Plugins | MCP | Skills | 安装方式 |
|---------|:-------:|:---:|:------:|---------|
| claudecode | ✓ | ✓ | ✓ | CLI: `claude plugin install` / `claude mcp add` |
| codex | ✗ | ✓ | ✓ | CLI: `codex mcp add` |
| gemini | ✗ | ✓ | ✓ | CLI: `gemini mcp add` |
| opencode | ✗ | ✓ | ✓ | CLI: `opencode mcp add` |
| cursor | ✗ | ✓ | ✓ | 配置文件: `.cursor/mcp.json` |
| 其他 (iflow/kimi/...) | ✗ | ✗ | ✗ | 不支持 |

### 3.4 运行时判断

```typescript
interface ExtensionRuntimeContext {
  activeProjectPath: string | null;
  projectHarness: CcAgentType | null;
  availableHarnesses: Map<CcAgentType, string>;
}
```

安装流程：
1. 用户选择 scope（Global / Project）
2. 根据扩展类型过滤可用 harness
3. Global → 展示过滤后的 harness 选择器
4. Project → 自动使用项目绑定的 harness
5. 获取对应 adapter → 执行安装

## 4. 通知系统

```typescript
interface ExtensionNotification {
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message: string;
  harnessType?: CcAgentType;
  autoHideMs?: number; // success=3000, error=0
}
```

| 事件 | 类型 | 说明 |
|------|------|------|
| 安装成功 | success | `"已安装到 {harness} ({scope})"` |
| 安装失败 | error | 显示原因，secret 脱敏 |
| 卸载成功 | success | `"已从 {harness} 卸载"` |
| MCP 连接失败 | warning | `"MCP server 连接失败"` |
| Skill 保存成功 | success | `"Skill 已保存"` |
| Skill 验证失败 | warning | `"Skill 格式问题：{issues}"` |
| Harness 不可用 | warning | `"所选 harness 未安装或未登录"` |
| 项目缺少 env | info | `"项目缺少必填环境变量：FEISHU_APP_ID"` |

## 5. 架构

### 5.1 目录结构

```
src/main/services/extensions/
├── ExtensionFacadeService.ts
├── runtime/
│   ├── HarnessInstallAdapter.ts       # 接口定义
│   ├── ClaudeCodeAdapter.ts
│   ├── CodexAdapter.ts
│   ├── GeminiAdapter.ts
│   ├── OpenCodeAdapter.ts
│   ├── CursorAdapter.ts
│   └── adapterRegistry.ts
├── catalog/
│   ├── PluginCatalogService.ts
│   ├── OfficialMcpRegistryService.ts
│   ├── GlamaMcpEnrichmentService.ts
│   └── McpCatalogAggregator.ts
├── install/
│   ├── PluginInstallService.ts
│   └── McpInstallService.ts
├── state/
│   ├── PluginInstallationStateService.ts
│   └── McpInstallationStateService.ts
├── skills/
│   ├── SkillsCatalogService.ts
│   ├── SkillScanner.ts
│   ├── SkillMetadataParser.ts
│   ├── SkillValidator.ts
│   ├── SkillRootsResolver.ts
│   └── SkillsMutationService.ts
└── credentials/
    └── CredentialService.ts            # 统一凭据管理（加密存储 + 项目 env）

src/main/ipc/extensions.ts
```

### 5.2 CredentialService（统一凭据）

替代原来的 ApiKeyService，统一管理 MCP 凭据和项目环境变量：

```typescript
interface CredentialService {
  // MCP 凭据（全局）
  saveMcpCredentials(mcpName: string, envValues: Record<string, string>): Promise<void>;
  getMcpCredentials(mcpName: string): Promise<Record<string, string>>;

  // 项目环境变量（供 Skills / CLI 使用）
  saveProjectEnv(projectPath: string, vars: Record<string, string>): Promise<void>;
  getProjectEnv(projectPath: string): Promise<Record<string, string>>;

  // 扫描项目所需变量（从启用的 MCP + Skills 汇总）
  scanRequiredEnv(projectPath: string): Promise<RequiredEnvResult>;

  // Agent 启动时注入
  resolveAgentEnv(projectPath: string): Promise<Record<string, string>>;

  // 加密状态
  getStorageStatus(): Promise<StorageStatus>;
}
```

**存储：**
- MCP 凭据 → `~/.claude/mcp-credentials.json`（加密）
- 项目 env → `~/.claude/projects/{encoded-path}/env.json`（加密）
- 加密方式：OS keychain（优先）或 AES-256-GCM（兜底）
- 文件权限 0o600

**合并优先级（Agent 启动时）：**
1. 项目环境变量（最高优先级）
2. MCP 凭据中与 project env 同名的 key 不覆盖
3. 系统 env（最低优先级）

### 5.3 IPC 通道

```typescript
// 安装请求（Extension Store）
interface PluginInstallRequest {
  pluginId: string;
  scope: InstallScope;
  projectPath?: string;
  harnessType?: CcAgentType;
}

interface McpInstallRequest {
  registryId: string;
  serverName: string;
  scope: InstallScope;
  projectPath?: string;
  envValues: Record<string, string>;
  headers: McpHeaderDef[];
  harnessType?: CcAgentType;
}

// 凭据请求（Project Settings）
interface SaveProjectEnvRequest {
  projectPath: string;
  envVars: Record<string, string>;
}

interface ScanRequiredEnvRequest {
  projectPath: string;
}
```

### 5.4 UI 变更

**Extension Store（三个 tab）：**
- Plugins / MCP / Skills — 安装和卸载
- 移除独立的 API Keys tab

**Project Settings（新增 Environment 区域）：**
- 选择项目 → 自动扫描需要的 env vars
- 展示必填/可选，已填/未填
- 编辑值 → 加密保存
- 显示 env 来源（哪个 MCP/Skill 需要它）

## 6. 实现步骤

### Phase 1: 基础设施（从参考项目移植）

1. 移植 catalog 服务（PluginCatalog / OfficialMcpRegistry / Glama / McpCatalogAggregator）— 直接复制
2. 移植 state 服务（PluginInstallationState / McpInstallationState）— 复制后适配多 harness
3. 移植 skills 服务（全套）— 复制后改造 SkillRootsResolver
4. 移植 ExtensionFacadeService — 复制后注入 adapter

### Phase 2: Harness Adapter 层（新开发）

5. 定义 `HarnessInstallAdapter` 接口 + `adapterRegistry`
6. 实现 ClaudeCodeAdapter（核心，从参考项目的 InstallService 提取逻辑）
7. 实现 CodexAdapter / GeminiAdapter / OpenCodeAdapter
8. 实现 CursorAdapter（配置文件方式，不走 CLI）

### Phase 3: CredentialService（新开发）

9. 实现 CredentialService（替代 ApiKeyService）
   - MCP 凭据加密存储
   - 项目环境变量加密存储
   - 扫描项目所需 env（从 MCP + Skills 汇总）
   - Agent 启动时 env 合并注入

### Phase 4: IPC + Store 对接

10. 创建 `src/main/ipc/extensions.ts`
11. 改造 renderer store（移除 API Keys 独立 tab，增加 Project Environment）
12. MCP 安装对话框 → 从 CredentialService 自动填充 env
13. Project Settings → Environment 面板

## 7. 安全模型

- Renderer 仅发送 `pluginId` / `registryId`，Main 端从 catalog 重新解析 `qualifiedName`
- 所有 scope、server name、env key、header key 经过正则白名单校验
- 路径操作使用 `isPathWithinRoot()` 防止路径穿越
- 错误消息中对 secret 值做 `[REDACTED]` 脱敏
- 凭据文件权限 0o600（仅所有者可读写）

## 8. 现有代码与新建代码

### 已有（可直接复用）

| 类别 | 位置 |
|------|------|
| 类型定义 | `src/shared/types/extensions/` |
| Renderer UI | `src/renderer/components/extensions/` |
| Store | `src/renderer/store/slices/extensionsSlice.ts` |
| API 层 | `src/renderer/api/index.ts` |

### 需要新建

| 类别 | 位置 |
|------|------|
| Main Services | `src/main/services/extensions/` (全部) |
| IPC | `src/main/ipc/extensions.ts` |
| Harness Adapters | `src/main/services/extensions/runtime/` |
| CredentialService | `src/main/services/extensions/credentials/` |
| Project Environment UI | `src/renderer/components/settings/` (新增) |

## 9. 验收标准

- [ ] Extension Store 展示 Plugins / MCP / Skills 三个 tab
- [ ] 插件目录从 marketplace 正确拉取
- [ ] MCP 目录从 Official Registry + Glama 聚合展示
- [ ] Skills 从文件系统扫描并展示
- [ ] Plugins 安装锁定 claudecode
- [ ] MCP 安装展示 harness 选择器
- [ ] Skills 安装展示 harness 选择器
- [ ] 每个 harness 使用正确的安装方式
- [ ] Cursor 通过配置文件安装
- [ ] 已安装状态正确追踪
- [ ] MCP 凭据在安装时配置，全局共享
- [ ] 项目环境变量面板：选择项目 → 扫描所需 env → 填值 → 加密保存
- [ ] Agent 启动时自动注入项目环境变量
- [ ] 安装/卸载/错误时 toast 通知，secret 脱敏
- [ ] MCP 连接异常时 warning 通知
