# AgentCLI 团队协作模型

## 产品边界

Agent、私信、任务和团队是不同对象：

- **Agent**：独立创建、独立配置、可被多个团队复用的执行实体。
- **私信**：人与 Agent 之间的非任务沟通。
- **任务**：具有负责人、状态、评论和交付记录的工作对象。
- **团队**：由一个 Leader 和一组可调度 Agent 组成的任务编排边界。

团队不是新的运行时，也不复制 Agent 配置。Leader 和成员继续使用各自已有的 Agent runtime。

## 团队定义

```ts
type TeamMemberScope =
  | {
      mode: 'explicit';
      agentIds: string[];
    }
  | {
      mode: 'dynamic-all-others';
    };

interface CollaborationTeamManifest {
  schemaVersion: 1;
  slug: string;
  displayName: string;
  description?: string;
  leaderAgentId: string;
  memberScope: TeamMemberScope;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}
```

### 创建规则

1. Leader 必选且只能有一个。
2. Leader 必须引用一个存在、未删除且已完成创建的 Agent。
3. 用户显式选择成员时，至少选择一个成员。
4. 显式成员不能包含 Leader，必须去重，并且全部引用有效 Agent。
5. 用户不选择成员时，保存为 `dynamic-all-others`，表示当前及未来所有除 Leader 外的有效 Agent 都可被调度。
6. 不使用裸空数组同时表示“无成员”和“全部其他成员”；持久化必须使用判别式 `memberScope`。

## 兼容策略

当前代码中的 `TeamManifest v2` 实际表示一个数字员工及其 runtime/project。迁移期间：

- 现有 `/teams`、`/team/:name` 和 `~/.hermit/teams/` 继续作为 Agent 兼容层，不移动已有任务、消息或运行时配置。
- 新的协作团队使用独立领域对象和独立存储目录，避免把组合团队再次绑定到 cc-connect project。
- 后续新增正式 Agent registry 时，把现有数字员工记录迁移为 Agent；协作团队只保存 Agent ID 引用。
- 历史单人 Team 不自动扩展为“全部其他成员”，避免行为变化。

建议过渡存储：

```text
~/.hermit/collaboration-teams/<team-slug>/team.json
~/.hermit/collaboration-teams/<team-slug>/tasks/tasks.json
```

## 任务编排

1. 用户为协作团队创建的顶层任务默认分配给 Leader。
2. Leader 使用 AgentCLI Task Bus 查看入口任务、拆分子任务并指派成员。
3. 普通成员只处理明确分配给自己的任务。
4. Leader 汇总成员交付，并提交顶层任务的最终交付。
5. Task Bus 是团队协作状态的唯一事实来源；Prompt 只教授协议，不保存事实。

任务需要逐步支持：

```ts
interface CollaborationTaskFields {
  parentTaskId?: string;
  createdByAgentId?: string;
  assigneeAgentId?: string;
  visibility?: 'leader' | 'assignee' | 'team';
}
```

## AgentCLI 命令协议

所有成员使用同一个内置 `agentcli`，不存在单独的 Leader CLI。

```bash
agentcli team status
agentcli team members
agentcli tasks list
agentcli tasks create --parent <task-id>
agentcli tasks assign --id <task-id> --agent <agent-id>
agentcli tasks claim --id <task-id>
agentcli tasks comment --id <task-id> --text "进度"
agentcli tasks clarify --id <task-id> --target leader
agentcli tasks complete --id <task-id> --result "交付"
```

禁止使用 MCP、Skills 或 Harness 原生 Task/Todo 系统维护协作看板。

## Prompt 注入

### Leader

- 当前 Team、Leader Agent ID 和成员范围。
- 新任务先进入 Leader 收件范围。
- 必须使用 `agentcli tasks create/assign/comment/clarify/complete` 拆分、指派和汇总。
- 不得直接调用内部 API，不得伪造任务 ID。

### 普通成员

- 当前 Team、Agent ID 和成员角色。
- 只处理 `agentcli tasks list` 返回且明确指派给自己的任务。
- 开始前 claim，过程中 comment，阻塞时 clarify，完成时 complete。
- 不得创建或改派团队任务。

Prompt 中不注入凭据，不注入 MCP/Skills 扩展，不把用户输入的多行描述直接拼成系统协议。

## 身份边界

`--team`、`--agent` 只用于命令选择，不能作为最终授权依据。最终身份由 Workbench 启动 Agent 时注入的短期凭据确定：

- Workbench URL
- Team ID
- Agent ID
- Team role
- 短期 actor token

短期 token 不写入 Prompt、team.json、shim marker 或日志。

## Web 模块

保持现有路由语义：

- `/teams`：Agent 列表。
- `/team/:agentId`：Agent 详情。
- `/tasks`：私信与待审阅任务收件箱。
- `/collaboration`：独立团队协作模块。

团队协作模块包含：

- 协作团队列表。
- 创建团队：Leader 必选；显式成员或默认全部其他 Agent。
- 团队成员与角色摘要。
- 团队任务看板。
- 顶层任务、子任务、评论和交付状态。

新模块必须保持现有多标签、多窗格、深链和 Tab 挂载语义。

## 分阶段落地

1. 新增 CollaborationTeam 类型、存储、校验和 CRUD API。
2. 在现有 AgentCLI 中增加 `team` 和 `tasks assign` 命令。
3. 扩展 Task Bus 的 parent/assignee Agent 字段与 Leader/Member 权限。
4. 按角色注入不同 Prompt；继续明确禁止 MCP、Skills 和原生 Task/Todo。
5. 新增 `/collaboration` Web 模块和团队任务看板。
6. 最后收紧短期身份令牌，停止信任裸 `--team`。
