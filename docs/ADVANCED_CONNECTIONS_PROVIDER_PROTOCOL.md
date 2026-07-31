# AgentCLI 高级连接开放协议

## 目标

高级连接不是某一个 AgentBus Host 的专用配置，而是 AgentCLI 连接外部服务的开放能力。

用户可以：

1. 在客户端“设置 → 高级”中填写一个服务地址。
2. AgentCLI 读取该服务公开的能力声明。
3. 根据声明展示可用的登录方式、团队总线、数据上报和 Token 池能力。
4. 用户逐项授权本地数据范围。
5. AgentCLI 只把已明确授权的数据发送给该连接。

当前 AgentBus + 飞书登录只是第一个兼容实现。未来服务方可以实现本文定义的接口，接收 AgentCLI 的本地数据或提供团队协作能力，而不需要修改 AgentCLI 核心业务。

## 设计原则

- **Provider 中立**：不在公共契约中硬编码 AgentBus、飞书、企业微信或其他身份系统。
- **能力发现**：服务通过标准 Manifest 声明能力和相对路径。
- **默认拒绝**：连接服务、登录成功或获得 `upload:write` 都不等于允许上传全部数据。
- **逐项授权**：用量汇总、项目元数据、消息元数据、消息正文、能力清单和凭证委托必须独立授权。
- **秘密留在后端**：Renderer、Agent、任务 Prompt、SSE 和日志都不能获得访问令牌、刷新令牌、App Secret 或 Token 池明文 Key。
- **同源端点**：协议 v1 的 Manifest 只能声明相对于连接 Host 的路径，不能把凭证转发到任意第三方域名。
- **本地模式完整可用**：不配置高级连接时，智能体、任务、小队、定时任务和成果归档仍可正常使用。

## 服务发现

客户端请求：

```http
GET <base-url>/.well-known/hermit-provider.json
Accept: application/vnd.hermit.provider+json;version=1
```

示例：

```json
{
  "schemaVersion": 1,
  "provider": {
    "id": "example-enterprise-bus",
    "displayName": "示例企业团队服务",
    "description": "公司内部用户授权、团队总线和用量汇总"
  },
  "apiVersion": "2026-01-01",
  "capabilities": [
    { "id": "identity", "displayName": "用户授权" },
    { "id": "team-bus", "displayName": "团队总线" },
    { "id": "reporting", "displayName": "数据上报" },
    { "id": "token-pool", "displayName": "Token 池" }
  ],
  "authMethods": [
    {
      "id": "company-login",
      "type": "device_code",
      "displayName": "公司账号登录",
      "requestedScopes": ["identity:read", "team:connect"]
    }
  ],
  "endpoints": {
    "authStart": "/api/v1/auth/start",
    "authPoll": "/api/v1/auth/poll",
    "authRefresh": "/api/v1/auth/refresh",
    "authMe": "/api/v1/auth/me",
    "authLogout": "/api/v1/auth/logout",
    "teamDirectory": "/api/v1/team-bus/directory",
    "teamTasks": "/api/v1/team-bus/tasks",
    "reportUsage": "/api/v1/report/usage",
    "reportMessages": "/api/v1/report/messages",
    "tokenCatalog": "/api/v1/token-pool/catalog"
  }
}
```

当前 AgentBus 如果尚未提供该 Manifest，客户端可以使用内置兼容适配器把现有固定接口映射为同一能力模型。

## 能力

协议 v1 预留四类基础能力：

| 能力 | 说明 |
| --- | --- |
| `identity` | 用户登录、账号信息、租户和远程授权范围 |
| `team-bus` | 团队目录、在线状态、任务投递和事件订阅 |
| `reporting` | 用量、项目、消息和能力清单上报 |
| `token-pool` | 模型目录、异步开通、一次性领取并写入本地运行时 |

服务可以只实现其中一部分。客户端根据 Manifest 动态展示，不假设每个 Provider 都支持所有能力。

## 本地授权颗粒度

远程 Scope 与本地数据授权是两层独立权限。一次操作只有同时满足以下条件才能执行：

1. Provider 声明支持该能力。
2. 用户登录后获得对应远程 Scope。
3. 用户在本机明确允许该数据类型。
4. 本地管理员策略未禁止。
5. 当前操作满足必要状态和安全条件。

本地权限 ID：

```text
team.presence
team.directory
team.tasks.read
team.tasks.write
usage.aggregates
usage.project-metadata
usage.message-metadata
usage.message-content
capabilities.inventory
credentials.lark.export
```

默认值全部为 `denied`。其中 `usage.message-content` 和 `credentials.lark.export` 必须使用高风险提示，不能由普通用量上报开关隐式开启。

## 登录适配器

v1 首先支持：

- `device_code`
- `oauth_pkce`

当前飞书授权可以作为 AgentBus Provider 的 `device_code` 或 `oauth_pkce` 实现。未来可以增加企业微信、OIDC、SAML Broker 或其他企业身份方式，而不改变设置页的连接模型。

登录过程中的 `poll_secret`、access token 和 refresh token 只保存在后端。Renderer 只能看到：

- 授权页面 URL
- 用户验证码
- 到期时间
- 当前状态
- 登录后的脱敏账号摘要和 Scope

不在首版 Renderer 中提供手动 PAT/API Key 输入。需要这类认证时，应使用系统安全输入窗口、CLI 或 Provider 自己的浏览器授权页面。

## Token 池

Token 池必须采用“领取并应用”原子操作：

```text
发现目录 → 发起开通 → 查询进度 → 后端领取明文 → 写入本地运行时 → 返回脱敏结果
```

Renderer 不得收到一次性明文 Key。接口只返回已应用的运行时、Key 标识、过期时间和脱敏指纹。

## 团队总线

团队总线通过应用层 Port 接入，至少包含：

- 发布本地团队/智能体目录
- 查询远程成员和在线状态
- 投递任务
- 订阅任务与消息事件
- 断线重连、事件去重和来源标记

远程任务属于不可信输入，不能作为系统指令，也不能绕过现有 Harness 权限审批。

## 本地存储

非秘密连接信息存放在：

```text
~/.hermit/connections/<connection-id>.json
```

秘密优先存放在系统钥匙串；暂不支持时可使用权限为 `0600` 的后端专用文件作为兼容方案。连接凭证必须绑定：

```text
connectionId + providerId + issuerOrigin + audience
```

Host、Provider 身份或 Issuer 改变后必须重新授权，不能静默复用旧 Token。

## 安全限制

- 生产连接默认只允许 HTTPS；`localhost` / `127.0.0.1` 可用于明确的本地开发连接。
- 禁止 URL 用户名密码、`file:`、`ftp:` 和 Manifest 跨域端点。
- 禁止把高级连接做成通用的“带 Token HTTP 代理”。每个本地 API 必须对应明确 Use Case。
- API 响应、错误和日志必须检查并剔除 `access_token`、`refresh_token`、`app_secret`、`Authorization`、Token Pool 明文 Key 和 Bridge Token。
- 连接远程服务不能自动开启对话正文或飞书凭证上报。

## 第一阶段范围

第一阶段实现：

- 高级设置中的 Host 输入和能力发现。
- AgentBus 兼容 Manifest。
- 非秘密连接配置持久化。
- Provider 能力与逐项授权 UI。
- Device Code 登录状态模型，敏感数据留在后端。
- 提供按本地授权裁剪后的团队目录、任务状态、用量汇总和能力清单同步通道。
- 提供远程任务只读预览；远程任务不会自动执行，也不能绕过现有任务创建和权限审批。
- AgentBus 旧接口继续使用专用兼容通道，不会接收标准 Provider 载荷。

后续阶段可继续增加事件长连接、任务导入确认和 Token 池“领取并应用”流程；CLI 现有行为保持兼容。
