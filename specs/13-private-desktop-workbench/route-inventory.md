<!-- markdownlint-disable MD013 -->

# Fastify 路由盘点（Phase 0）

> 本文是 `src/main/server.ts` 拆分前的行为基线。**Spec Kit 硬门禁：完成 server split 及其验证前，不得开始 Electron、renderer 产品流程、CLI 包边界或安装包实现。**

## 核验方法与总数

使用 TypeScript Compiler API 遍历 `CallExpression`，只计 receiver 为 `app`、方法为 `get/post/patch/delete/put/all` 且首参数为静态字符串的注册。结果：

| 方法     |    数量 |
| -------- | ------: |
| GET      |      97 |
| POST     |     108 |
| PATCH    |      13 |
| DELETE   |       9 |
| PUT      |       5 |
| ALL      |       3 |
| **合计** | **235** |

复核命令（脚本位于 `/tmp`，不写仓库）：

```bash
NODE_PATH="$PWD/node_modules" node /tmp/extract-routes.cjs > /tmp/routes.tsv
awk -F "\t" '{ count[$2]++ } END { for (m in count) print m, count[m] }' /tmp/routes.tsv
wc -l /tmp/routes.tsv
```

## 全局顺序与契约注意事项

- **`/api/v1/*` vs readiness：**`ALL /api/v1/*` 在行 1644，`GET /api/v1/system/readiness` 在行 1998。当前 Fastify 靠静态路径高于 wildcard 命中本地 readiness；插件化后必须保持。
- **团队静态路径 vs `:name`：**多个静态路径晚于参数路由注册，当前 router 靠静态段优先级正确解析；提取前应逐项锁定。
- **API fallback：**显式 API、`/api/events`、extensions 之后才设置 not-found。未知 API GET 返回 `[]`，未知非 GET 返回 `{ ok: true }`；Phase 0 不顺手收紧。
- **SSE/static fallback：**真实 `/api/events` 先注册；not-found 再提供 SSE fallback；SPA fallback 只处理非 API、GET/HEAD、无扩展名；static plugin 最后注册。
- **插件作用域：**全局 Origin `preHandler`、wildcard、not-found 和 static 的 Fastify encapsulation 范围不得变化。

## 按拟议 route module 分组

### `routes/bridge.ts` — 代理、Bridge 配置、运行时状态与 direct-cli/MCP（21 routes）

**依赖/顺序：**依赖 `runtimeConfig`、`HermitBridgeClient/Connection/Launcher`、`DirectCliSessionManager`、permission/session route maps。`ALL /api/v1/*` 是兼容代理，但 `GET /api/v1/system/readiness` 是本地端点；必须保留静态路由优先于通配符的行为，不能用先吞掉 readiness 的 hook/fallback 替代。

| 方法  | 路径                                 | `server.ts` 行 |
| ----- | ------------------------------------ | -------------: |
| ALL   | `/api/bridge/*`                      |           1640 |
| ALL   | `/api/cc/*`                          |           1643 |
| ALL   | `/api/v1/*`                          |           1644 |
| GET   | `/api/hermit-bridge-config`          |           1965 |
| POST  | `/api/hermit-bridge-config`          |           1966 |
| GET   | `/api/hermit-bridge-config/raw`      |           1970 |
| POST  | `/api/hermit-bridge-config/raw`      |           1971 |
| GET   | `/api/cc-config`                     |           1976 |
| POST  | `/api/cc-config`                     |           1977 |
| GET   | `/api/cc-config/raw`                 |           1978 |
| POST  | `/api/cc-config/raw`                 |           1979 |
| GET   | `/api/status`                        |           1985 |
| GET   | `/api/v1/system/readiness`           |           1998 |
| GET   | `/api/cc-settings`                   |           2006 |
| PATCH | `/api/cc-settings`                   |           2011 |
| POST  | `/api/cc-restart`                    |           2031 |
| POST  | `/api/cc-reload`                     |           2040 |
| POST  | `/api/terminal/open-external`        |           2232 |
| POST  | `/api/direct-cli/resume-in-terminal` |           2262 |
| GET   | `/mcp`                               |           3742 |
| POST  | `/mcp`                               |           3767 |

### `routes/configuration.ts` — Hermit 本地配置（4 routes）

**依赖/顺序：**依赖 `HERMIT_HOME` 配置文件、原子写入和 runtimeConfig 刷新；raw 与结构化端点必须保持掩码、默认值和错误形状。

| 方法 | 路径                     | `server.ts` 行 |
| ---- | ------------------------ | -------------: |
| GET  | `/api/hermit-config`     |           1650 |
| POST | `/api/hermit-config`     |           1661 |
| GET  | `/api/hermit-config/raw` |           1685 |
| POST | `/api/hermit-config/raw` |           1694 |

### `routes/systemManager.ts` — 系统管理员配置与工作流（6 routes）

**依赖/顺序：**依赖 `SystemManagerConfigService`、`WorkflowPromptService`、admin loop/global workflows；有进程级文件副作用，不得在插件内重复实例化。

| 方法 | 路径                                 | `server.ts` 行 |
| ---- | ------------------------------------ | -------------: |
| POST | `/api/system-manager/ensure`         |           2054 |
| GET  | `/api/system-manager/status`         |           2066 |
| GET  | `/api/system-manager/config`         |           2074 |
| PUT  | `/api/system-manager/config`         |           2083 |
| POST | `/api/system-manager/workflows/list` |           2095 |
| POST | `/api/system-manager/workflows/read` |           2118 |

### `routes/teams.ts` — 团队、任务、消息、会话、审查与执行（107 routes）

**依赖/顺序：**依赖 team workspace/provisioning、cc/bridge/direct-cli、SSE、session/permission maps、日志和 review helpers，是最高风险模块。静态 `/api/teams/runtime/alive`、`tasks`、`provisioning/*`、`templates`、`config`、`review/*`、`tool-approval/read-file`、`validate-cli-args` 必须继续胜过 `:name`。

| 方法   | 路径                                                | `server.ts` 行 |
| ------ | --------------------------------------------------- | -------------: |
| GET    | `/api/teams`                                        |           2311 |
| POST   | `/api/teams/create`                                 |           2387 |
| GET    | `/api/teams/:name/data`                             |           2441 |
| PATCH  | `/api/teams/:name`                                  |           2671 |
| DELETE | `/api/teams/:name`                                  |           2684 |
| GET    | `/api/teams/:name/tasks`                            |           2781 |
| POST   | `/api/teams/:name/tasks`                            |           2790 |
| PATCH  | `/api/teams/:name/tasks/:id`                        |           2807 |
| DELETE | `/api/teams/:name/tasks/:id`                        |           2835 |
| PATCH  | `/api/teams/:name/collaboration`                    |           2862 |
| GET    | `/api/teams/:name/heartbeat`                        |           2888 |
| POST   | `/api/teams/:name/heartbeat/enable`                 |           2898 |
| POST   | `/api/teams/:name/heartbeat/disable`                |           2911 |
| POST   | `/api/teams/:name/heartbeat/pause`                  |           2924 |
| POST   | `/api/teams/:name/heartbeat/resume`                 |           2937 |
| PATCH  | `/api/teams/:name/heartbeat`                        |           2950 |
| GET    | `/api/harnesses`                                    |           2969 |
| GET    | `/api/teams/:name/loop-assets`                      |           3013 |
| POST   | `/api/teams/:name/loop-session`                     |           3197 |
| POST   | `/api/teams/:name/launch`                           |           3260 |
| POST   | `/api/teams/:name/stop`                             |           3323 |
| GET    | `/api/graph`                                        |           3542 |
| GET    | `/api/teams/:name/messages/:messageId/attachments`  |           5010 |
| GET    | `/api/teams/:name/messages`                         |           5027 |
| GET    | `/api/teams/:name/member-activity-meta`             |           5112 |
| GET    | `/api/teams/:name/member-activity`                  |           5123 |
| GET    | `/api/teams/:name/member-spawn-statuses`            |           5134 |
| GET    | `/api/teams/:name/agent-runtime`                    |           5143 |
| GET    | `/api/teams/:name/lead-activity`                    |           5154 |
| GET    | `/api/teams/:name/lead-context`                     |           5159 |
| GET    | `/api/teams/:name/sessions`                         |           5164 |
| GET    | `/api/teams/:name/sessions/:sessionId`              |           5193 |
| DELETE | `/api/teams/:name/sessions/:sessionId`              |           5217 |
| GET    | `/api/teams/runtime/alive`                          |           5244 |
| GET    | `/api/teams/:name/process-alive`                    |           5269 |
| POST   | `/api/teams/:name/process-send`                     |           5280 |
| GET    | `/api/teams/:name/saved-request`                    |           5302 |
| GET    | `/api/teams/:name/kanban`                           |           5305 |
| GET    | `/api/teams/:name/task-change-presence`             |           5312 |
| POST   | `/api/teams/:name/kanban-column-order`              |           5315 |
| GET    | `/api/teams/tasks`                                  |           5320 |
| POST   | `/api/teams/:name/tasks/:id/request-review`         |           5339 |
| PATCH  | `/api/teams/:name/tasks/:id/kanban`                 |           5358 |
| PATCH  | `/api/teams/:name/tasks/:id/status`                 |           5365 |
| PATCH  | `/api/teams/:name/tasks/:id/owner`                  |           5388 |
| PATCH  | `/api/teams/:name/tasks/:id/fields`                 |           5402 |
| POST   | `/api/teams/:name/tasks/:id/start`                  |           5417 |
| POST   | `/api/teams/:name/tasks/:id/start-by-user`          |           5432 |
| POST   | `/api/teams/:name/tasks/:id/soft-delete`            |           5447 |
| POST   | `/api/teams/:name/tasks/:id/restore`                |           5469 |
| GET    | `/api/teams/:name/deleted-tasks`                    |           5480 |
| POST   | `/api/teams/:name/tasks/:id/comments`               |           5488 |
| POST   | `/api/teams/:name/tasks/:id/clarification`          |           5492 |
| POST   | `/api/teams/:name/tasks/:id/relationships`          |           5496 |
| POST   | `/api/teams/:name/members`                          |           5502 |
| DELETE | `/api/teams/:name/members/:memberName`              |           5503 |
| PATCH  | `/api/teams/:name/members/:memberName/role`         |           5507 |
| POST   | `/api/teams/:name/members/:memberName/restart`      |           5511 |
| POST   | `/api/teams/:name/members/:memberName/skip-launch`  |           5515 |
| GET    | `/api/teams/:name/claude-logs`                      |           5521 |
| POST   | `/api/teams/:name/restore`                          |           5527 |
| DELETE | `/api/teams/:name/permanent`                        |           5535 |
| GET    | `/api/teams/:name/config`                           |           5823 |
| PATCH  | `/api/teams/:name/config`                           |           5981 |
| POST   | `/api/teams/provisioning/prepare`                   |           5994 |
| GET    | `/api/teams/provisioning/:runId`                    |           5998 |
| POST   | `/api/teams/provisioning/:runId/cancel`             |           6006 |
| GET    | `/api/teams/templates`                              |           6013 |
| POST   | `/api/teams/templates/save`                         |           6014 |
| POST   | `/api/teams/templates/refresh`                      |           6015 |
| PUT    | `/api/teams/:name/members`                          |           6018 |
| DELETE | `/api/teams/:name/draft`                            |           6021 |
| POST   | `/api/teams/:name/send-message`                     |           6024 |
| POST   | `/api/teams/:name/tasks/:id/review`                 |           6126 |
| PATCH  | `/api/teams/:name/kanban/:id`                       |           6147 |
| PUT    | `/api/teams/:name/kanban/column-order`              |           6153 |
| PUT    | `/api/teams/:name/config`                           |           6158 |
| POST   | `/api/teams/:name/members/:memberName/skip`         |           6171 |
| POST   | `/api/teams/:name/task-clarification/:taskId`       |           6177 |
| DELETE | `/api/teams/:name/tasks/:id/relationships`          |           6183 |
| POST   | `/api/teams/config`                                 |           6193 |
| POST   | `/api/teams/:name/kill-process`                     |           6196 |
| GET    | `/api/teams/:name/member-logs/:memberName`          |           6202 |
| GET    | `/api/teams/:name/task-logs/:taskId`                |           6208 |
| GET    | `/api/teams/:name/activity`                         |           6214 |
| GET    | `/api/teams/:name/task-activity-detail`             |           6217 |
| GET    | `/api/teams/:name/task-log-stream-summary/:taskId`  |           6222 |
| GET    | `/api/teams/:name/task-log-stream/:taskId`          |           6228 |
| GET    | `/api/teams/:name/exact-log-summaries/:taskId`      |           6234 |
| GET    | `/api/teams/:name/exact-log-detail/:taskId`         |           6240 |
| GET    | `/api/teams/:name/member-stats/:memberName`         |           6246 |
| POST   | `/api/teams/:name/tool-approval/respond`            |           6339 |
| POST   | `/api/teams/:name/tool-approval/settings`           |           6378 |
| POST   | `/api/teams/tool-approval/read-file`                |           6397 |
| POST   | `/api/teams/validate-cli-args`                      |           6412 |
| GET    | `/api/teams/:name/review/agent-changes/:memberName` |           7276 |
| GET    | `/api/teams/:name/review/task-changes/:taskId`      |           7288 |
| GET    | `/api/teams/:name/review/change-stats/:memberName`  |           7292 |
| GET    | `/api/teams/:name/review/file-content`              |           7296 |
| POST   | `/api/teams/:name/review/apply-decisions`           |           7299 |
| POST   | `/api/teams/review/check-conflict`                  |           7302 |
| POST   | `/api/teams/review/preview-reject`                  |           7303 |
| POST   | `/api/teams/review/save-edited-file`                |           7304 |
| POST   | `/api/teams/review/decisions/load`                  |           7305 |
| POST   | `/api/teams/review/decisions/save`                  |           7306 |
| POST   | `/api/teams/review/decisions/clear`                 |           7307 |
| GET    | `/api/teams/review/git-file-log`                    |           7308 |

### `routes/setup.ts` — 平台设置与数字员工接入（7 routes）

**依赖/顺序：**依赖 Feishu/Weixin setup、lark-cli 个人 `as user` 授权、cc project 配置和 restart；save 路径必须保留 `await`，使 restart rejection 落入既有 try/catch。

| 方法 | 路径                               | `server.ts` 行 |
| ---- | ---------------------------------- | -------------: |
| POST | `/api/setup/feishu/begin`          |           3364 |
| POST | `/api/setup/feishu/poll`           |           3382 |
| POST | `/api/setup/feishu/save`           |           3400 |
| POST | `/api/setup/weixin/begin`          |           3433 |
| POST | `/api/setup/weixin/poll`           |           3451 |
| POST | `/api/setup/weixin/save`           |           3469 |
| POST | `/api/projects/:name/add-platform` |           3502 |

### `routes/update.ts` — 版本与更新（3 routes）

**依赖/顺序：**依赖 package version 和 `UpdateService`；`/api/version` 必须维持 JSON 字符串 content-type/响应形状。

| 方法 | 路径                | `server.ts` 行 |
| ---- | ------------------- | -------------: |
| GET  | `/api/version`      |           3826 |
| GET  | `/api/update/check` |           3832 |
| POST | `/api/update/apply` |           3835 |

### `routes/projects.ts` — 项目、仪表盘、上下文与通用配置（8 routes）

**依赖/顺序：**依赖 recent-projects loader、cc project/repository/context/config helpers；`/api/config/triggers` 与 schedules 共享配置时应通过 context 注入。

| 方法 | 路径                             | `server.ts` 行 |
| ---- | -------------------------------- | -------------: |
| GET  | `/api/dashboard/recent-projects` |           3863 |
| GET  | `/api/projects`                  |           3865 |
| GET  | `/api/repository-groups`         |           3866 |
| GET  | `/api/contexts`                  |           3877 |
| GET  | `/api/contexts/active`           |           3878 |
| GET  | `/api/config`                    |           3988 |
| POST | `/api/config/update`             |           3993 |
| GET  | `/api/config/triggers`           |           4013 |

### `routes/schedules.ts` — 定时任务（10 routes）

**依赖/顺序：**依赖 `Cron`、schedule runtime maps、持久配置、执行日志和 team/task dispatch；pause/resume/trigger 与 shutdown 清理由同一 context 持有。

| 方法   | 路径                                  | `server.ts` 行 |
| ------ | ------------------------------------- | -------------: |
| GET    | `/api/schedules`                      |           4259 |
| GET    | `/api/schedules/:id`                  |           4271 |
| POST   | `/api/schedules`                      |           4284 |
| PATCH  | `/api/schedules/:id`                  |           4337 |
| DELETE | `/api/schedules/:id`                  |           4387 |
| POST   | `/api/schedules/:id/pause`            |           4465 |
| POST   | `/api/schedules/:id/resume`           |           4493 |
| POST   | `/api/schedules/:id/trigger`          |           4508 |
| GET    | `/api/schedules/:id/runs`             |           4576 |
| GET    | `/api/schedules/:id/runs/:runId/logs` |           4609 |

### `routes/editor.ts` — 工作区与编辑器文件操作（19 routes）

**依赖/顺序：**依赖 workspace root、文件系统、watchers、Git/search/binary preview；路径规范化、越界、symlink 及 move/rename 双端校验必须先有安全测试。

| 方法 | 路径                            | `server.ts` 行 |
| ---- | ------------------------------- | -------------: |
| POST | `/api/config/browse-folders`    |           4622 |
| POST | `/api/workspace/list`           |           4645 |
| POST | `/api/editor/open`              |           4746 |
| POST | `/api/editor/close`             |           4755 |
| GET  | `/api/editor/readDir`           |           4757 |
| GET  | `/api/editor/readFile`          |           4799 |
| POST | `/api/editor/writeFile`         |           4828 |
| POST | `/api/editor/createFile`        |           4853 |
| POST | `/api/editor/createDir`         |           4874 |
| POST | `/api/editor/deleteFile`        |           4893 |
| POST | `/api/editor/moveFile`          |           4907 |
| POST | `/api/editor/renameFile`        |           4924 |
| GET  | `/api/editor/listFiles`         |           4945 |
| GET  | `/api/editor/readBinaryPreview` |           4976 |
| GET  | `/api/editor/gitStatus`         |           4994 |
| POST | `/api/editor/watchDir`          |           5000 |
| POST | `/api/editor/setWatchedFiles`   |           5001 |
| POST | `/api/editor/setWatchedDirs`    |           5002 |
| GET  | `/api/editor/search`            |           5003 |

### `routes/workers.ts` — 数字员工发现与调用（2 routes）

**依赖/顺序：**依赖 team discovery、`discoverableTeamToWorker` 和消息/任务调用链；保持 workerId 校验与错误映射。

| 方法 | 路径                            | `server.ts` 行 |
| ---- | ------------------------------- | -------------: |
| GET  | `/api/workers`                  |           6423 |
| POST | `/api/workers/:workerId/invoke` |           6427 |

### `routes/telemetry.ts` — usage/conversation telemetry 与 task-bus（8 routes）

**依赖/顺序：**依赖 telemetry singleton/runtime、scanner、conversation service、worker status/PID 和 settings。Phase 0 只隔离现状；后续删除 usage 不得连带删除 lark-cli 凭证上报。

| 方法 | 路径                                      | `server.ts` 行 |
| ---- | ----------------------------------------- | -------------: |
| GET  | `/api/settings/task-bus`                  |           6520 |
| PUT  | `/api/settings/task-bus`                  |           6540 |
| POST | `/api/telemetry/scan`                     |           7125 |
| GET  | `/api/telemetry/export`                   |           7148 |
| GET  | `/api/telemetry/conversations`            |           7164 |
| GET  | `/api/telemetry/conversations/export`     |           7200 |
| GET  | `/api/telemetry/conversations/:sessionId` |           7241 |
| GET  | `/api/telemetry/status`                   |           7258 |

### `routes/notifications.ts` — 通知与 SSE（4 routes）

**依赖/顺序：**依赖 `sseClients`、broadcast、通知源和 CLI status。真实 `/api/events` 必须先于 API fallback；未知 API 的 SSE fallback 只匹配 `events|stream|notifications/stream`。

| 方法 | 路径                              | `server.ts` 行 |
| ---- | --------------------------------- | -------------: |
| GET  | `/api/notifications/unread-count` |           3868 |
| GET  | `/api/notifications`              |           3869 |
| GET  | `/api/cli/status`                 |           3872 |
| GET  | `/api/events`                     |           7314 |

### `routes/extensions.ts` — Plugins、MCP、Capability Packs、Skills 与凭证（35 routes）

**依赖/顺序：**依赖 `extensionHandlers`、capability local source、skills watcher emitter、cc cron/team listing、zip helper；local source/emitter 每进程只装配一次。

| 方法   | 路径                                               | `server.ts` 行 |
| ------ | -------------------------------------------------- | -------------: |
| GET    | `/api/extensions/plugins`                          |           7386 |
| GET    | `/api/extensions/plugins/readme/:pluginId`         |           7391 |
| POST   | `/api/extensions/plugins/install`                  |           7397 |
| POST   | `/api/extensions/plugins/uninstall`                |           7403 |
| GET    | `/api/extensions/mcp/installed`                    |           7414 |
| POST   | `/api/extensions/mcp/install-custom`               |           7420 |
| POST   | `/api/extensions/mcp/uninstall`                    |           7426 |
| GET    | `/api/extensions/mcp/library`                      |           7437 |
| POST   | `/api/extensions/mcp/library`                      |           7441 |
| DELETE | `/api/extensions/mcp/library/:id`                  |           7445 |
| POST   | `/api/extensions/mcp/library/import`               |           7450 |
| GET    | `/api/extensions/capability-packs`                 |           7454 |
| POST   | `/api/extensions/capability-packs/import`          |           7458 |
| POST   | `/api/extensions/capability-packs/export`          |           7462 |
| POST   | `/api/extensions/capability-packs/export/download` |           7466 |
| POST   | `/api/extensions/capability-packs/command-prompt`  |           7498 |
| GET    | `/api/extensions/skills`                           |           7502 |
| GET    | `/api/extensions/skills/:skillId`                  |           7508 |
| POST   | `/api/extensions/skills/upsert`                    |           7515 |
| POST   | `/api/extensions/skills/delete`                    |           7520 |
| POST   | `/api/extensions/skills/preview-upsert`            |           7525 |
| POST   | `/api/extensions/skills/apply-upsert`              |           7529 |
| POST   | `/api/extensions/skills/preview-import`            |           7533 |
| POST   | `/api/extensions/skills/apply-import`              |           7537 |
| POST   | `/api/extensions/skills/watching/start`            |           7541 |
| POST   | `/api/extensions/skills/watching/stop`             |           7546 |
| GET    | `/api/extensions/credentials/status`               |           7551 |
| GET    | `/api/extensions/credentials/mcp/:mcpName`         |           7556 |
| POST   | `/api/extensions/credentials/mcp`                  |           7562 |
| GET    | `/api/extensions/credentials/project-env`          |           7571 |
| POST   | `/api/extensions/credentials/project-env`          |           7578 |
| POST   | `/api/extensions/credentials/scan-required`        |           7587 |
| GET    | `/api/extensions/credentials/resolve-agent-env`    |           7603 |
| GET    | `/api/extensions/credentials/skill-env`            |           7610 |
| POST   | `/api/extensions/credentials/skill-env`            |           7617 |

### `routes/static.ts` — renderer 静态资源与 SPA fallback（1 routes）

**依赖/顺序：**依赖 `STATIC_DIR`、`@fastify/static` 和 index.html。所有 API/SSE、not-found 先完成，再最后注册 static；无 build 时 `GET /` 503 是第 235 个显式 route。

| 方法 | 路径 | `server.ts` 行 |
| ---- | ---- | -------------: |
| GET  | `/`  |           7677 |

## Phase 0 最终对照（2026-07-28）

- `src/main/server.ts` 已收缩为 33 行的受保护进程入口；所有路由装配移至 `src/main/workbenchServer.ts`。
- `test/main/server/routeManifestBaseline.ts` 从最终 composition root 与已启用 route modules 提取完整静态 method/path 基线；`workbenchServer.test.ts` 再通过 Fastify `onRoute` 收集默认 standalone composition 的完整运行时集合，并逐项验证两者相等。两边均为 235 条：GET 97、POST 108、PUT 5、PATCH 13、DELETE 9、ALL 3，因此条件/分阶段 registrar 的实际装配也在验收范围内。
- 最终清单不存在重复 method/path，也不存在已抽取但未由 composition root 调用的孤立 registrar。
- `createWorkbenchServer(context, options)` 只构建 Fastify、注册安全 hook/route/static 和 listener，不调用 `listen()`；standalone 监听仅由显式 `startStandaloneServer()` 触发。

## 拆分验收约束

- route module 只能通过显式 `ServerContext` 获取有状态依赖；不得重复创建 bridge、direct-cli manager、watcher、service、SSE set 或 runtime map。
- 提取后重跑结构提取并对照 235 条及方法统计；删除必须有书面决定。
- `pnpm typecheck`、`pnpm build:server`、聚焦 route tests 和 startup/shutdown 全通过后，才可解锁 Electron 工作。
