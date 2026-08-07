# Implementation Plan: Hermit Web Mode

## Technical Context

| Area | Current State | Target |
|------|--------------|--------|
| HTTP API | 70+ endpoints for sessions/projects/config, 8 team endpoints | Full coverage for all features |
| Renderer coupling | 57 `isElectronMode()` guards, 109 httpClient throw statements | All guards removed or gracefully degraded |
| Docker | 1.47GB image, runs standalone server | Same, with LeadChannel support |
| Teams API | list, getData, messages, tasks, send-message, member-activity | Full CRUD + review + templates + members |
| Feishu | Not started in standalone | LeadChannelListener active |
| Editor | No HTTP endpoints | Full file operations via HTTP |
| CLI status | Stub no-ops in httpClient | Real status from container |

## Architecture Decision: IPC-over-HTTP Bridge Pattern

Rather than adding 80+ individual HTTP routes, use a two-layer approach:

1. **Direct HTTP routes** for high-traffic operations (teams, tasks, messages, files)
2. **TeamDataService** methods already handle most data operations — just expose them via HTTP

The `api` proxy in renderer automatically routes to HTTP when `window.electronAPI` is absent.

## Implementation Phases

### Phase 1: Teams Complete (Priority: Critical, Est: 4-5 hours)

**Goal**: Full Teams functionality in browser

#### 1.1 Teams Data HTTP Endpoints
Files: `src/main/http/teams.ts`, `src/main/services/team/TeamDataService.ts`

Add HTTP routes for TeamDataService methods that don't have endpoints yet:
- `POST /api/teams/:teamName/tasks` → createTask
- `PATCH /api/teams/:teamName/tasks/:taskId/status` → updateTaskStatus
- `PATCH /api/teams/:teamName/tasks/:taskId/owner` → updateTaskOwner
- `PATCH /api/teams/:teamName/tasks/:taskId/fields` → updateTaskFields
- `DELETE /api/teams/:teamName/tasks/:taskId` → softDeleteTask
- `POST /api/teams/:teamName/tasks/:taskId/restore` → restoreTask
- `PATCH /api/teams/:teamName/kanban/:taskId` → updateKanban
- `PUT /api/teams/:teamName/kanban/column-order` → updateKanbanColumnOrder
- `POST /api/teams/:teamName/tasks/:taskId/review` → requestReview
- `POST /api/teams/:teamName/tasks/:taskId/comments` → addTaskComment
- `POST /api/teams/:teamName/tasks/:taskId/relationships` → addTaskRelationship
- `DELETE /api/teams/:teamName/tasks/:taskId/relationships` → removeTaskRelationship
- `POST /api/teams/:teamName/members` → addMember
- `DELETE /api/teams/:teamName/members/:memberName` → removeMember
- `PUT /api/teams/:teamName/members` → replaceMembers
- `PATCH /api/teams/:teamName/members/:memberName/role` → updateMemberRole
- `DELETE /api/teams/:teamName` → deleteTeam
- `POST /api/teams/:teamName/restore` → restoreTeam
- `DELETE /api/teams/:teamName/permanent` → permanentlyDeleteTeam
- `PUT /api/teams/:teamName/config` → updateConfig
- `GET /api/teams/:teamName/activity` → getTaskActivity
- `GET /api/teams/:teamName/logs` → getMemberLogs
- `GET /api/teams/:teamName/task-logs/:taskId` → getLogsForTask
- `GET /api/teams/templates` → listTemplateSources

#### 1.2 Update HttpAPIClient Teams Methods
File: `src/renderer/api/httpClient.ts`

Update 109 throw-stub methods to call the new HTTP endpoints.

#### 1.3 Remove Teams UI Guards
File: `src/renderer/components/team/TeamListView.tsx`

Remove remaining `electronMode` guards (6 remaining references).

### Phase 2: Feishu Channel (Priority: High, Est: 3-4 hours)

**Goal**: Bidirectional Feishu messaging in Docker/standalone

#### 2.1 Start LeadChannelListener in Standalone
File: `src/main/standalone.ts`

- Import and initialize `LeadChannelListenerService`
- Wire SSE events for Feishu channel status changes
- Pass TeamProvisioningService reference to LeadChannelListener

#### 2.2 Feishu HTTP Endpoints
File: `src/main/http/teams.ts`

- `GET /api/teams/:teamName/lead-channel` → getLeadChannel
- `POST /api/teams/:teamName/lead-channel/save` → saveLeadChannel
- `POST /api/teams/:teamName/lead-channel/feishu/start` → startFeishuLeadChannel
- `POST /api/teams/:teamName/lead-channel/feishu/stop` → stopFeishuLeadChannel
- `GET /api/teams/lead-channel/global` → getGlobalLeadChannel
- `POST /api/teams/lead-channel/global/save` → saveGlobalLeadChannel
- `GET /api/teams/:teamName/lead-activity` → getLeadActivity

#### 2.3 Update HttpAPIClient
File: `src/renderer/api/httpClient.ts`

Replace throw stubs with HTTP calls for all lead channel methods.

### Phase 3: Editor & File Operations (Priority: Medium, Est: 4-5 hours)

**Goal**: File browser, editor, and review in browser

#### 3.1 File Operation HTTP Endpoints
File: `src/main/http/editor.ts` (new file)

- `GET /api/editor/readDir?path=...` → readDir
- `GET /api/editor/readFile?path=...` → readFile
- `POST /api/editor/writeFile` → writeFile
- `POST /api/editor/createFile` → createFile
- `POST /api/editor/createDir` → createDir
- `DELETE /api/editor/deleteFile` → deleteFile
- `POST /api/editor/moveFile` → moveFile
- `POST /api/editor/renameFile` → renameFile
- `GET /api/editor/search?query=...&root=...` → searchInFiles
- `GET /api/editor/listFiles?root=...` → listFiles
- `GET /api/editor/readBinaryPreview?path=...` → readBinaryPreview
- `GET /api/editor/gitStatus?root=...` → gitStatus

#### 3.2 Update HttpAPIClient Editor Methods
File: `src/renderer/api/httpClient.ts`

Replace all `throw new Error('Editor not available')` with actual HTTP calls.

#### 3.3 Review HTTP Endpoints
File: `src/main/http/review.ts` (new file)

- `GET /api/teams/:teamName/review/agent-changes/:memberName` → getAgentChanges
- `GET /api/teams/:teamName/review/task-changes/:taskId` → getTaskChanges
- `POST /api/teams/:teamName/review/apply-decisions` → applyDecisions
- `GET /api/teams/:teamName/review/file-content` → getFileContent
- `POST /api/teams/:teamName/review/save-edited-file` → saveEditedFile

### Phase 4: CLI Status & Settings (Priority: Medium, Est: 2-3 hours)

**Goal**: Full settings page and CLI status in browser

#### 4.1 CLI Status HTTP Endpoint
File: `src/main/http/cliInstaller.ts` (new file)

- `GET /api/cli/status` → getStatus (runs `claude --version`, checks auth)
- `POST /api/cli/install` → install (runs npm install in background)
- `POST /api/cli/invalidate-status` → invalidateStatus

#### 4.2 Update HttpAPIClient CLI Methods
File: `src/renderer/api/httpClient.ts`

Replace `cliInstaller` stubs with HTTP calls.

#### 4.3 Settings UI Guards
File: `src/renderer/components/settings/`

Remove `isElectronMode()` guards from:
- `SettingsTabs.tsx` — show all tabs
- `GeneralSection.tsx` — show CLI status, Claude root settings
- `AdvancedSection.tsx` — show SSH section as disabled with explanation

### Phase 5: UI Parity Cleanup (Priority: Low, Est: 2-3 hours)

**Goal**: No hidden features, graceful degradation

#### 5.1 Audit All isElectronMode Guards
Files: 18 components with 57 guards

For each guard:
- If the feature has HTTP support → remove guard
- If the feature is impossible in browser (native notifications, window controls) → keep guard, show graceful message
- If unclear → add "available in desktop app" badge, don't hide

#### 5.2 Extensions Page
File: `src/renderer/components/extensions/ExtensionStoreView.tsx`

- Show MCP server list (from config file, readable via HTTP)
- Show skills list
- Mark actions requiring local filesystem with clear messaging

#### 5.3 Window Chrome
File: `src/renderer/components/layout/CustomTitleBar.tsx`

- Already uses `isElectronMode()` — no changes needed (hides in browser)

## File Change Summary

| File | Action | Phase |
|------|--------|-------|
| `src/main/http/teams.ts` | Add 25+ routes | 1, 2 |
| `src/main/http/editor.ts` | New file, 12 routes | 3 |
| `src/main/http/review.ts` | New file, 5 routes | 3 |
| `src/main/http/cliInstaller.ts` | New file, 3 routes | 4 |
| `src/main/http/index.ts` | Register new route files | 3, 4 |
| `src/main/standalone.ts` | Add LeadChannelListener | 2 |
| `src/renderer/api/httpClient.ts` | Replace 109 throw stubs | 1-5 |
| `src/renderer/components/team/TeamListView.tsx` | Remove guards | 1 |
| `src/renderer/components/settings/*` | Remove guards | 4 |
| `src/renderer/components/extensions/*` | Graceful degradation | 5 |
| `docker/Dockerfile` | No changes needed | - |

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Breaking Electron mode | `api` proxy always checks `window.electronAPI` first; IPC path unchanged |
| Large file uploads (attachments) | Use multipart form upload with size limits |
| File system security in Docker | All paths validated against mounted project dir; no path traversal |
| Docker image bloat from LeadChannel deps | LeadChannel uses same deps as TeamProvisioningService (already bundled) |

## Estimated Timeline

| Phase | Hours | Dependencies |
|-------|-------|-------------|
| Phase 1: Teams | 4-5h | None |
| Phase 2: Feishu | 3-4h | Phase 1 |
| Phase 3: Editor | 4-5h | None (parallel with 1-2) |
| Phase 4: CLI/Settings | 2-3h | None (parallel with 1-3) |
| Phase 5: UI Cleanup | 2-3h | Phase 1-4 |
| **Total** | **15-20h** | |
