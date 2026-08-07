# Quickstart: Cross-Host Task Dispatch

## Local Mode (Zero Config)

No Redis needed. Teams on the same Hermit instance can dispatch tasks to each other.

1. Create two teams with collaboration enabled
2. Agent calls `list_teams` → sees local teams
3. Agent calls `dispatch_task("team-beta", "Do something")` → task appears on Beta's board
4. Beta's agent calls `complete_task(...)` → Alpha sees completion

## Cluster Mode (Redis)

1. Start Redis: `docker run -d -p 6379:6379 redis:7`
2. In Hermit Settings → Task Bus → enable, enter Redis host/port
3. Each Hermit instance connects to the same Redis
4. Agents on any instance can discover and dispatch to teams on any other instance
5. Status sync happens in real-time via Redis Pub/Sub

## Agent Dispatch Rules

Agents follow configurable rules to decide when to dispatch vs. do themselves.

### Default Rules (v1 hardcoded)

```
DISPATCH when:
  - Task requires access to a different codebase/repository
  - Task requires tools/expertise the current team doesn't have
  - Task explicitly mentions another team's domain
  - Task is blocked by work owned by another team

DO NOT DISPATCH when:
  - Task is within current team's project scope
  - Task can be completed with available tools and context
  - Task is a quick fix (< 5 minutes estimated)
```

### Future: User-Configurable Rules

Users can edit dispatch rules in `~/.hermit/dispatch-rules.md`:

```markdown
# When to dispatch tasks to other teams

## Always dispatch to "frontend-team"
- Any UI/React component changes
- CSS/Tailwind styling tasks
- Browser compatibility issues

## Always dispatch to "backend-team"
- Database schema changes
- API endpoint modifications
- Authentication/authorization changes

## Never dispatch
- Documentation updates
- Test writing for own code
- Minor config changes
```

The dispatch rules are injected into the agent's system prompt via CLAUDE.md or MCP tool description.
