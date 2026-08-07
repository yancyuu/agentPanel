# Research: Cross-Host Team Task Dispatch

## Decision 1: Transport Layer

**Decision**: Redis Streams for task dispatch, Redis Pub/Sub for status sync

**Rationale**:
- cc-connect Bridge WebSocket is local-only (127.0.0.1:9810), not designed for cross-Hermit routing
- Extending cc-connect would require Go changes and a new release cycle
- Redis is a standard, lightweight dependency (single binary, easy to run via Docker)
- Streams provide persistence (offline delivery), Pub/Sub provides real-time broadcast
- `ioredis` is the standard Node.js Redis client with built-in reconnection

**Alternatives considered**:
- Extend cc-connect relay: Would work but adds coupling, requires Go changes, slower release cycle
- P2P (libp2p): Too complex, debugging nightmare, no clear benefit over Redis
- Git-based sync: High latency, conflict resolution is hard
- Plain TCP/WebSocket: Have to reimplement queuing, retry, presence — Redis gives this for free

## Decision 2: Local vs Remote Routing

**Decision**: TaskDispatchService abstracts transport; local teams use direct file write, remote teams use Redis

**Rationale**:
- Zero-config local mode (no Redis needed) is critical for single-machine use
- Same service interface regardless of transport keeps code simple
- Local path is just filesystem — no network, no serialization overhead

**Alternatives considered**:
- Always use Redis even locally: Forces Redis dependency for all users, bad DX
- Two separate services: Unnecessary abstraction, duplicated logic

## Decision 3: Agent Discovery Mechanism

**Decision**: MCP tool `list_teams` returns merged list (local teams + Redis-discovered remote teams)

**Rationale**:
- Agents already use MCP tools (hermit-tasks server) for task operations
- Adding `list_teams` follows existing patterns, no new concepts
- Redis sorted set `task:teams` with heartbeat provides dynamic discovery
- Local teams always available regardless of Redis

**Alternatives considered**:
- Static config file listing remote teams: Requires manual updates, stale data
- DNS/service discovery: Overkill for this use case
- cc-connect project listing: Tied to cc-connect, doesn't work without it

## Decision 4: Offline Reliability

**Decision**: Redis Streams (XADD/XREADGROUP) for dispatch, consumer groups for delivery guarantee

**Rationale**:
- Streams persist messages until consumed and acknowledged (XACK)
- If target Hermit goes offline, messages queue in the stream
- Consumer groups ensure exactly-once delivery per team
- No message loss even during reconnection

**Alternatives considered**:
- Plain Pub/Sub: Messages lost if no subscriber online
- Application-level retry queue: Rediseliant, more code to maintain
- Database-backed queue: Heavier than needed

## Decision 5: Dispatch Rules for Agents

**Decision**: v1 hardcoded rules in MCP tool description, v2 user-configurable via markdown file

**Rationale**:
- v1 needs to work immediately without any configuration
- MCP tool descriptions are the natural place for agent guidance
- Markdown file (`~/.hermit/dispatch-rules.md`) is human-readable and easy to edit
- Hot-reload allows rule changes without restart

**Alternatives considered**:
- JSON/YAML rules: More structured but harder for non-technical users
- Database-stored rules: Overkill for a config that rarely changes
- No rules, let agent decide: Too unpredictable, agents would dispatch randomly

## Decision 6: ioredis as Dependency Strategy

**Decision**: Dynamic import, optional dependency

**Rationale**:
- Users without Redis should not have to install ioredis
- Dynamic `import('ioredis')` loaded only when Redis is configured
- Package.json `optionalDependencies` ensures it's available but doesn't block install

**Alternatives considered**:
- Required dependency: Forces all users to download ioredis
- Bundled Redis client: Maintenance burden
- HTTP-based Redis (Upstash REST): Limits to specific Redis providers
