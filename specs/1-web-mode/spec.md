# Feature Spec: Hermit Web Mode

## Summary

Extend Hermit from an Electron-only desktop app to a fully functional web application accessible via browser. Users deploy via Docker, open the URL, and get the complete Hermit experience — Teams, Feishu integration, CLI management, settings, editor, and code review — without installing anything locally.

## Background & Motivation

Hermit currently requires Electron runtime, limiting deployment to developer machines. Web mode enables:

- **Zero-install access**: Open in any browser on any OS
- **Docker deployment**: One command to run, easy to scale
- **Remote collaboration**: Team members access the same Hermit instance
- **CI/CD integration**: Agents run in containers alongside the management UI

The foundational work is complete: standalone HTTP server, api proxy abstraction, Docker build pipeline, and basic Teams HTTP endpoints are live. This spec covers closing the remaining gaps to achieve feature parity.

## User Scenarios

### Primary: Docker deploy and use

1. User runs `docker run -p 4567:4567 -v ~/.claude:/data/.claude ghcr.io/yancyuu/hermit:latest`
2. Opens `http://localhost:4567` in browser
3. Sees full Hermit UI — projects, sessions, teams, settings
4. Creates a team, assigns tasks, sends messages, reviews code — all from browser
5. Feishu channel messages arrive in real-time; replies go back to Feishu

### Secondary: Remote server

1. User deploys Hermit on a cloud server
2. Accesses it from laptop, phone, or any device with a browser
3. Monitors running teams, checks task progress, reviews diffs

### Edge: Mixed mode

1. Some team members use Electron desktop app, others use browser
2. Both access the same data and teams
3. No feature gaps between the two interfaces

## Functional Requirements

### FR-1: Teams — Full functionality in browser

- **FR-1.1**: List all teams with status (alive/dead/draft)
- **FR-1.2**: View team data: members, tasks, kanban board, messages, activity
- **FR-1.3**: Create new teams with member configuration and prompt
- **FR-1.4**: Delete, restore, and permanently delete teams
- **FR-1.5**: Task CRUD: create, update status, update owner, update fields, soft delete, restore
- **FR-1.6**: Kanban operations: move tasks between columns, reorder columns, request review
- **FR-1.7**: Send messages to team members (lead and teammates)
- **FR-1.8**: View message history with pagination and real-time updates
- **FR-1.9**: Member management: add, remove, replace, update role
- **FR-1.10**: Task relationships: add/remove blockedBy/blocks/related
- **FR-1.11**: Task comments with file attachments
- **FR-1.12**: Activity feed: member activity, task activity, logs
- **FR-1.13**: Review system: view diffs, approve/reject changes, hunk-level decisions
- **FR-1.14**: Template sources: list, save, refresh team templates

### FR-2: Feishu channel — Live in standalone mode

- **FR-2.1**: LeadChannelListener starts in standalone mode when configured
- **FR-2.2**: Incoming Feishu messages route to correct team lead
- **FR-2.3**: Lead replies delivered back to Feishu channel in real-time
- **FR-2.4**: Global lead channel configuration and status visible in browser
- **FR-2.5**: Start/stop Feishu channel from browser UI
- **FR-2.6**: Thinking content included in Feishu notifications (labeled `[思考]`)

### FR-3: CLI management — Status and updates in browser

- **FR-3.1**: Display CLI installation status (installed version, auth state)
- **FR-3.2**: Show available CLI updates
- **FR-3.3**: Trigger CLI update from browser (when running in Docker)
- **FR-3.4**: CLI install/health diagnostic information visible

### FR-4: Settings — Complete configuration in browser

- **FR-4.1**: General settings: language, theme, notification preferences
- **FR-4.2**: Notification triggers: CRUD with test capability
- **FR-4.3**: Advanced settings: ignore patterns, custom project paths
- **FR-4.4**: Configuration import/export
- **FR-4.5**: Claude root path configuration
- **FR-4.6**: Restore defaults

### FR-5: Extensions and plugins

- **FR-5.1**: List installed MCP servers with connection status
- **FR-5.2**: List registered skills
- **FR-5.3**: View extension configuration
- **FR-5.4**: Graceful degradation for features requiring local filesystem (clear messaging, not hidden)

### FR-6: Editor and file operations

- **FR-6.1**: Browse project file tree
- **FR-6.2**: Read file contents with syntax highlighting
- **FR-6.3**: Edit files and save changes
- **FR-6.4**: Create new files and directories
- **FR-6.5**: Delete and rename files
- **FR-6.6**: Search across files
- **FR-6.7**: Git status display
- **FR-6.8**: Binary file preview (images, etc.)
- **FR-6.9**: File change watching with live updates

### FR-7: UI parity — No hidden features

- **FR-7.1**: All tabs and navigation items visible in browser mode
- **FR-7.2**: Features that genuinely can't work show a clear explanation with workaround suggestions, not just "only available in Electron"
- **FR-7.3**: Window chrome (title bar) adapts: browser uses native tabs, no custom traffic lights
- **FR-7.4**: Zoom controls delegated to browser (no custom zoom UI)

## Success Criteria

| Criterion | Measure |
|-----------|---------|
| Feature parity | 100% of Electron features accessible or gracefully degraded in browser |
| Teams completeness | Create team, assign tasks, send messages, view activity — all work in browser |
| Feishu integration | Messages flow bidirectionally between Feishu and web UI in real-time |
| Docker image size | Under 1.5 GB |
| Startup time | Container ready and serving pages within 5 seconds |
| No regressions | All existing Electron desktop functionality unchanged |
| Browser compatibility | Works in Chrome, Firefox, Safari, Edge (latest 2 versions) |

## Key Entities

- **Team**: name, members, config, kanban columns, status
- **TeamTask**: id, title, description, status, owner, assignee, kanban column
- **TeamMember**: name, role, color, session status
- **InboxMessage**: from, to, text, timestamp, attachments, task references
- **TeamConfig**: provider settings, member definitions, channel config
- **FileNode**: path, type (file/directory), content, git status
- **ReviewChange**: file path, hunks, decisions (approve/reject)

## Assumptions

- The standalone server has filesystem access to `~/.claude/` (mounted in Docker)
- Claude Code CLI is pre-installed in the Docker image
- SSE (Server-Sent Events) is sufficient for real-time updates (no WebSocket needed)
- Authentication is handled at the infrastructure level (VPN, reverse proxy) — not in app scope
- File editing in browser operates on the server's filesystem (Docker-mounted project code)

## Out of Scope

- Multi-user authentication/authorization system
- Horizontal scaling (single-instance deployment)
- Mobile-optimized responsive layout (desktop browser layout)
- Offline/PWA support
- Built-in terminal emulator in browser

## Dependencies

- Existing standalone HTTP server infrastructure
- Existing `api` proxy abstraction layer
- Docker build pipeline
- TeamDataService and TeamProvisioningService
- LeadChannelListenerService for Feishu integration
