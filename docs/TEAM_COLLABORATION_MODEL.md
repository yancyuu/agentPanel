# AgentPanel 团队协作模型

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

## 当前桌面运行模型

桌面工作台中的协作团队成员地位平等，每个任务通过结构化圆桌投票选出临时队长。成员可以使用：

- Claude Code：复用长连接 stream-json 会话。
- Codex：使用 `codex exec --json` 的一次性任务进程。
- 内置 Pi：使用 `pi --print --mode text` 的一次性任务进程。

Codex 和 Pi 的任务正文通过 stdin 传入，不出现在进程参数中；三种运行方式最终都转换为统一的完成/错误事件，因此单智能体任务和小队任务共用同一状态机。

用户要求修改小队交付时，根任务进入 `needsFix`，对应 Collaboration Run 会从 `review` 回到 `executing`：已有成员工作项保持任务 ID 不变，但重新进入待执行状态，全体成员基于用户反馈返工，最后由原临时队长重新整合并再次提交审核。

## 任务编排

1. 用户为协作团队创建的顶层任务默认分配给 Leader。
2. Leader 使用 AgentPanel Task Bus 查看入口任务、拆分子任务并指派成员。
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

## AgentPanel 命令协议

所有成员使用同一个内置 `agentpanel`，不存在单独的 Leader CLI。当前公开且稳定的任务发现命令只有：

```bash
agentpanel tasks list --team <team-slug> --port <agentpanel-port>
```

`team-slug` 和端口必须由当前运行环境注入，不能在文档或 Prompt 中写死测试值。任务创建、领取、评论、澄清、完成和改派由桌面客户端及本地任务服务执行；在 CLI 正式提供对应命令之前，不得在 Agent 指令中引用不存在的子命令。

禁止使用 MCP、Skills 或 Harness 原生 Task/Todo 系统维护协作看板。

## Prompt 注入

### Leader

- 当前 Team、Leader Agent ID 和成员范围。
- 新任务先进入 Leader 收件范围。
- 通过桌面任务服务拆分、指派和汇总，必要时只使用 `agentpanel tasks list` 核对任务事实。
- 不得直接调用未公开的内部 API，不得伪造任务 ID、团队 slug 或端口。

### 普通成员

- 当前 Team、Agent ID 和成员角色。
- 只处理桌面任务服务或 `agentpanel tasks list` 返回且明确指派给自己的任务。
- 任务状态和反馈通过桌面任务服务持久化，不得调用不存在的 CLI 子命令。
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
2. 在现有 AgentPanel 中增加 `team` 和 `tasks assign` 命令。
3. 扩展 Task Bus 的 parent/assignee Agent 字段与 Leader/Member 权限。
4. 按角色注入不同 Prompt；继续明确禁止 MCP、Skills 和原生 Task/Todo。
5. 新增 `/collaboration` Web 模块和团队任务看板。
6. 最后收紧短期身份令牌，停止信任裸 `--team`。
