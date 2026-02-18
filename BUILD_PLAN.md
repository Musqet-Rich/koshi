# Koshi POC — Build Plan

> Each task is designed to be completed by a single sub-agent in one session.
> Architecture docs: `/home/monomi/.openclaw/workspace/koshi/architecture/`

---

## Wave 1 — Foundation (no dependencies)

### Task 1: Project Initialisation
**Priority:** p1
**Files:** `package.json`, `tsconfig.json`, `pnpm-workspace.yaml`, `.gitignore`, `LICENSE`, `README.md`, `src/core/`, `src/types.ts`
**Description:**
Initialise the Koshi project skeleton:
- `pnpm init`, add dependencies: `fastify`, `better-sqlite3`, `@anthropic-ai/sdk`, `yaml`, `croner`
- Dev deps: `typescript`, `@types/better-sqlite3`, `@types/node`, `tsx`
- `tsconfig.json`: strict mode, ES2022 target, NodeNext module resolution, outDir `dist/`
- Create folder structure: `src/core/`, `src/plugins/`, `data/` (gitignored), `src/types.ts`
- `.gitignore`: `node_modules/`, `dist/`, `data/`, `*.db`
- `LICENSE`: GPL-3.0
- `package.json` scripts: `build`, `dev` (tsx), `start`
- Read `architecture/overview.md` for the full folder structure

**Acceptance Criteria:**
- `pnpm install` succeeds
- `pnpm build` compiles with zero errors (even if source files are stubs)
- Folder structure matches architecture/overview.md

---

### Task 2: TypeScript Type Definitions
**Priority:** p1
**Files:** `src/types.ts`
**Description:**
Define all shared TypeScript interfaces and types referenced throughout the architecture. Read ALL files in `architecture/` for the complete picture.

Key types to define:
- `KoshiConfig` — parsed koshi.yaml shape (identity, models, plugins, routes, templates, buffer, memory, sessions, cron, agent)
- `Plugin`, `Channel`, `ModelPlugin` — plugin interfaces from architecture/overview.md
- `Message`, `IncomingMessage`, `BufferedMessage`, `MessageBatch` — from architecture/buffer.md
- `RouteRule`, `RouteMatch`, `RouteAction` — from architecture/overview.md routes section
- `Task`, `TaskRun`, `TaskStatus`, `TaskPriority` — from architecture/tasks.md
- `Memory`, `MemoryQuery`, `MemoryResult` — from architecture/memory.md
- `SessionMessage`, `Session` — from architecture/overview.md sessions section
- `TokenUsage` — from architecture/agents.md
- `AgentTemplate`, `SpawnOptions` — from architecture/agents.md
- `CronJob` — from architecture/overview.md

**Acceptance Criteria:**
- All interfaces compile
- Types cover every schema and interface mentioned in the architecture docs
- Exported from `src/types.ts`

---

### Task 3: SQLite Schema Definition
**Priority:** p1
**Files:** `src/core/schema.sql`, `src/core/schema.ts`
**Description:**
Create the complete SQLite schema for the single database (`data/koshi.db`). Read architecture docs for all table definitions:
- `memories` + `memories_fts` (FTS5) — from architecture/memory.md
- `tasks` (with `blocked_by` JSON, `project` field) — from architecture/tasks.md
- `task_runs` — from architecture/tasks.md
- `sessions` — table for session metadata
- `messages` — session messages (session_id, role, content, tool_calls, created_at)
- `buffer` — from architecture/buffer.md (with indexes)
- `token_usage` — from architecture/agents.md

Export as both raw SQL string and a TypeScript function that executes it against a `better-sqlite3` Database instance.

**Acceptance Criteria:**
- SQL file contains all CREATE TABLE/INDEX statements
- `schema.ts` exports `applySchema(db: Database): void`
- All tables match the architecture docs exactly
- FTS5 virtual table for memories is correctly defined

---

### Task 4: Config Types and Loader
**Priority:** p1
**Files:** `src/core/config.ts`
**Description:**
Implement the config loader that reads and validates `koshi.yaml`. Read architecture/overview.md for the full config shape.

Features:
- Read `koshi.yaml` from the current working directory (or path passed as argument)
- Parse YAML using the `yaml` npm package
- Environment variable interpolation: replace `${VAR_NAME}` patterns with `process.env.VAR_NAME`
- Validate required fields: `name`, `identity.soul`, at least one entry in `plugins`
- Return a typed `KoshiConfig` object (from `src/types.ts`)
- Throw clear errors for missing required fields or unresolved env vars

**Acceptance Criteria:**
- `loadConfig(path?: string): KoshiConfig` exported
- Env var interpolation works (e.g. `${ANTHROPIC_API_KEY}`)
- Missing required fields throw descriptive errors
- A sample `koshi.example.yaml` is created showing all config options

---

## Wave 2 — Core Infrastructure (depends on Wave 1)

### Task 5: Database Module
**Priority:** p1  
**Depends on:** Task 1, Task 3
**Files:** `src/core/db.ts`
**Description:**
Create the database wrapper module using `better-sqlite3`. Read architecture/overview.md and architecture/daemon.md.

Features:
- `initDatabase(dataDir: string): Database` — open or create `koshi.db`, apply schema from `src/core/schema.ts`, enable WAL mode
- Ensure `data/` directory exists (create if missing)
- Apply schema idempotently (use `CREATE TABLE IF NOT EXISTS`)
- Export the db instance for use by other modules
- Provide a `closeDatabase()` for graceful shutdown

**Acceptance Criteria:**
- Calling `initDatabase('./data')` creates `data/koshi.db` with all tables
- Calling it again on existing DB doesn't error (idempotent)
- WAL mode is enabled
- FTS5 virtual table is created

---

### Task 6: Logger Module
**Priority:** p2  
**Depends on:** Task 1
**Files:** `src/core/logger.ts`
**Description:**
Create a structured JSON logger. Read architecture/daemon.md for log level config.

Features:
- Log levels: `debug`, `info`, `warn`, `error`
- Configurable level (from config or env `LOG_LEVEL`)
- Each log entry: `{ level, timestamp, component, message, ...extra }`
- Output to stdout as JSON lines
- Factory function: `createLogger(component: string)` returns a logger scoped to that component
- Use Fastify's built-in logger integration where possible

**Acceptance Criteria:**
- `createLogger('router').info('message routed', { channel: 'tui' })` outputs structured JSON
- Levels below configured threshold are suppressed
- Timestamps are ISO 8601

---

### Task 7: Plugin Loader
**Priority:** p1  
**Depends on:** Task 1, Task 4
**Files:** `src/core/plugins.ts`
**Description:**
Implement plugin discovery and lifecycle. Read architecture/overview.md and architecture/daemon.md for the plugin interface and lifecycle.

Features:
- Read `plugins` array from `KoshiConfig`
- For each plugin: `require()` the package, validate it exports `{ name, version, init }`
- Call `init(koshi, pluginConfig)` for each plugin in order
- Support local file paths (`./my-plugin`) and npm package names (`@koshi/anthropic`)
- Register shutdown hooks via Fastify's `onClose`
- The `koshi` object passed to plugins must have: `fastify`, `router`, `memory`, `buffer`, `config`

**Acceptance Criteria:**
- Plugins listed in config are loaded and `init()` called
- Invalid plugins (missing name/version/init) throw clear errors
- Local path plugins work
- Shutdown calls `onClose` hooks in reverse order

---

## Wave 3 — Router + Buffer (depends on Wave 2)

### Task 8: Message Buffer
**Priority:** p1  
**Depends on:** Task 5
**Files:** `src/core/buffer.ts`
**Description:**
Implement the persistent message buffer. Read architecture/buffer.md for the complete design.

Features:
- `insert(msg: { channel, sender, conversation, payload, priority? }): number` — write to SQLite buffer table
- `getUnrouted(): MessageBatch[]` — query unrouted messages, group by (conversation, channel), order by priority then id
- `markRouted(ids: number[]): void` — set `routed = TRUE` for given ids
- `cleanup(retentionDays: number): number` — delete routed messages older than retention period
- Priority constants: USER_DM=10, WEBHOOK=50, NOTIFICATION=100

**Acceptance Criteria:**
- Messages persist across module reload (SQLite-backed)
- `getUnrouted()` returns batches grouped by conversation+channel
- Priority ordering: lower value = higher priority
- `cleanup()` never deletes unrouted messages
- Batch structure matches `MessageBatch` type from types.ts

---

### Task 9: Message Router
**Priority:** p1  
**Depends on:** Task 7, Task 8
**Files:** `src/core/router.ts`
**Description:**
Implement the message routing engine. Read architecture/overview.md (routing rules) and architecture/buffer.md (routing outcomes).

Features:
- `registerChannel(name: string, channel: Channel): void` — register a channel plugin
- `route(): void` — called on a timer (batchWindowMs), processes unrouted buffer messages
- Pattern matching: match incoming batches against `routes` config rules (channel, event, action, from fields)
- Three outcomes: forward to main agent queue, spawn sub-agent (via routing rule), or drop
- Mustache-style template interpolation in route action fields (`{{number}}`, `{{title}}`)
- Maintain a queue of batches for the main agent, retrievable via `nextBatch(): MessageBatch | null`
- Start/stop the routing timer

**Acceptance Criteria:**
- Channel registration works
- Route rules from config are matched correctly
- Unmatched messages go to main agent queue by default
- Matched spawn rules create the correct spawn intent
- Timer-based routing with configurable interval

---

## Wave 4 — Memory (depends on Wave 2)

### Task 10: Synonym Map
**Priority:** p2  
**Depends on:** Task 1
**Files:** `src/core/synonyms.ts`
**Description:**
Implement the synonym lookup system. Read architecture/memory.md (synonym section).

Features:
- Built-in base synonym map: common programming/tech terms (e.g. auth→authentication, api→interface, db→database, repo→repository, etc.)
- `expandQuery(query: string): string` — expand each word with OR-joined synonyms for FTS5 (e.g. "api auth" → "(api OR interface) (auth OR authentication OR authorization)")
- `addSynonym(word: string, synonyms: string[]): void` — extend the map at runtime
- `getSynonyms(word: string): string[]` — lookup
- Map stored in memory (not DB) — loaded at startup, extensible

**Acceptance Criteria:**
- `expandQuery("api auth")` returns FTS5-compatible OR expression
- Base map covers ~50 common tech term groups
- Runtime extension works
- Unknown words pass through unchanged

---

### Task 11: Memory Backend
**Priority:** p1  
**Depends on:** Task 5, Task 10
**Files:** `src/core/memory.ts`
**Description:**
Implement the FTS5 memory store. Read architecture/memory.md for the complete design.

Features:
- `store(content, source, tags, sessionId?): number` — insert memory + update FTS5 index
- `query(queryString, limit?): MemoryResult[]` — expand query via synonym map, run FTS5 search, rank by `BM25 × (1 + max(score, 0)) × recency_factor`
- `reinforce(id): void` — increment score by +3, update last_hit_at
- `demote(id): void` — decrement score by -1
- `forget(id): void` — delete memory and FTS5 entry
- `prune(maxSize, prunePercent): number` — archive bottom N% by score when size exceeded
- Keep FTS5 index in sync with memories table (use triggers or manual sync)

**Acceptance Criteria:**
- Store and query round-trip works
- FTS5 search finds partial keyword matches
- Reinforced memories rank higher in results
- Demoted memories rank lower but still appear
- Synonym expansion is applied to queries
- Pruning archives lowest-scored memories

---

## Wave 5 — Agent Integration (depends on Waves 3 + 4)

### Task 12: System Prompt Builder
**Priority:** p1  
**Depends on:** Task 4, Task 11
**Files:** `src/core/prompt.ts`
**Description:**
Implement dynamic system prompt assembly. Read architecture/system-prompt.md.

Features:
- `buildSystemPrompt(config: KoshiConfig, memories: MemoryResult[], tools: Tool[], activeContext?: string): string`
- Sections: identity (from config.identity.soul), relevant memories (formatted list), active context (if any)
- Tools are NOT in the prompt text — they go through Claude's native tool_use API
- Keep total prompt under 2KB target for typical turns
- Memory section format: numbered list with content and tags

**Acceptance Criteria:**
- Output includes identity section from config
- Memories are formatted and included
- Active context appears only when provided
- Empty memories section is omitted, not "No memories found"

---

### Task 13: Anthropic Plugin
**Priority:** p1  
**Depends on:** Task 7, Task 12
**Files:** `src/plugins/anthropic/index.ts`, `src/plugins/anthropic/client.ts`
**Description:**
Implement the `@koshi/anthropic` service plugin. Read architecture/agents.md and architecture/overview.md.

Features:
- Plugin structure: `{ name: '@koshi/anthropic', version: '0.0.1', init(koshi, config) }`
- `client.ts`: wrapper around `@anthropic-ai/sdk` — `complete()` and `stream()` methods matching the `ModelPlugin` interface
- Support streaming responses (AsyncIterable<Chunk>)
- Support `tool_use` — pass tool schemas, handle tool_use responses, execute tools, return results
- Track token usage: after each response, insert into `token_usage` table
- Register named models from config (`models` section) so other components reference by name
- Main agent session: persistent conversation using the model specified in `agent.model`

**Acceptance Criteria:**
- Plugin loads via the plugin loader
- `complete()` sends messages to Claude API and returns response
- `stream()` returns an async iterable of chunks
- Tool use round-trip works (tool_use block → execute → tool_result → continue)
- Token usage is recorded in the database

---

### Task 14: Sub-Agent Spawner
**Priority:** p1  
**Depends on:** Task 13, Task 11
**Files:** `src/core/agents.ts`
**Description:**
Implement sub-agent spawning. Read architecture/agents.md for the full design.

Features:
- `spawnAgent(options: SpawnOptions): Promise<AgentResult>` — create ephemeral Claude conversation
- SpawnOptions: task, template?, model?, tools?, timeout?
- Resolve template from config (merge template defaults with overrides)
- Build system prompt with: task description + relevant memories (queried from DB)
- Run agent loop: send to Claude → handle tool_use → execute tools → continue until done or timeout
- Concurrency limit from config (`agents.maxConcurrent`, default 3)
- Queue if limit exceeded
- On completion: store result as memory, return result to caller
- On failure/timeout: return error

**Acceptance Criteria:**
- Agent spawns with correct tools and model from template
- Tool execution loop works (multiple tool_use rounds)
- Timeout kills the agent and returns error
- Concurrency limit is enforced
- Completed agent result is stored as a memory entry

---

## Wave 6 — Sessions + Tasks (depends on Wave 5)

### Task 15: Session Manager
**Priority:** p1  
**Depends on:** Task 5
**Files:** `src/core/sessions.ts`
**Description:**
Implement session persistence. Read architecture/overview.md (sessions section).

Features:
- `createSession(id?: string): string` — create a new session, return ID
- `addMessage(sessionId, role, content, toolCalls?): void` — append message to session
- `getHistory(sessionId, limit?): SessionMessage[]` — retrieve messages in order
- `pruneSession(sessionId, maxMessages): number` — remove oldest messages when over limit
- Sessions table: id, created_at, updated_at, model, type (main/sub-agent)
- Messages table: session_id, role (user/assistant/tool), content, tool_calls JSON, created_at

**Acceptance Criteria:**
- Messages persist across module reload
- History returns messages in chronological order
- Pruning removes oldest messages first, keeps most recent
- Session metadata tracks creation and last update time

---

### Task 16: Task Manager
**Priority:** p1  
**Depends on:** Task 5
**Files:** `src/core/tasks.ts`
**Description:**
Implement task CRUD and lifecycle. Read architecture/tasks.md for the complete design.

Features:
- `createTask(title, description?, opts?): number` — create task with optional template, priority, source, project, blocked_by, autoRun
- `listTasks(filters?): Task[]` — filter by status, priority, project, source
- `updateTask(id, updates): void` — update status, result, agent_run_id, etc.
- `getReadyTasks(): Task[]` — return open tasks whose dependencies are all done (the SQL query from architecture/tasks.md)
- `addRun(taskId, run): void` — insert into task_runs table
- Status transitions: open → in_progress → done/failed
- `blocked_by` stored as JSON array of task IDs

**Acceptance Criteria:**
- CRUD operations work
- `getReadyTasks()` correctly filters out tasks with incomplete dependencies
- Status transitions are enforced (can't go from done to in_progress)
- Task runs are recorded with timing and result/error

---

## Wave 7 — Plugins + Integration (depends on all above)

### Task 17: Autotest Channel Plugin
**Priority:** p1  
**Depends on:** Task 9
**Files:** `src/plugins/autotest/index.ts`
**Description:**
Implement the autotest channel for programmatic testing. Read architecture/poc.md.

Features:
- Plugin structure: `{ name: '@koshi/autotest', version: '0.0.1', init(koshi, config) }`
- Registers as a channel on the router
- `send(message: string): Promise<void>` — inject a message into the buffer as if from a user
- `waitForResponse(timeoutMs?): Promise<string>` — wait for the agent's response
- `onMessage` callback set by router for receiving responses
- Exposes an HTTP API on Fastify: `POST /autotest/send`, `GET /autotest/response`
- Useful for end-to-end testing without TUI

**Acceptance Criteria:**
- Messages sent via autotest appear in the buffer with channel='autotest'
- Responses from the agent are captured and retrievable
- HTTP endpoints work
- Can be used to validate the full message pipeline

---

### Task 18: TUI Plugin
**Priority:** p2  
**Depends on:** Task 9, Task 13
**Files:** `src/plugins/tui/index.ts`, `src/plugins/tui/client.ts`
**Description:**
Implement the terminal UI channel plugin. Reference OpenClaw's TUI source at `/home/monomi/.npm-global/lib/node_modules/openclaw/` (MIT licensed) for patterns.

Features:
- Plugin structure: `{ name: '@koshi/tui', version: '0.0.1', init(koshi, config) }`
- Server side (`index.ts`): listen on Unix socket (`~/.koshi/koshi.sock`), accept connections, register as channel on router
- Client side (`client.ts`): `koshi tui` command connects to the socket, provides interactive terminal
- Streaming display: show Claude's response tokens as they arrive
- Input handling: multi-line input, send on Enter
- Use IPC over Unix domain socket (not HTTP)
- Keep it minimal for POC — no fancy UI, just working input/output with streaming

**Acceptance Criteria:**
- `koshi tui` connects to running instance
- User can type a message and see Claude's streamed response
- Multiple messages in a session work (conversation history maintained)
- Clean disconnect on Ctrl+C

---

### Task 19: Cron Scheduler
**Priority:** p2  
**Depends on:** Task 16, Task 14
**Files:** `src/core/cron.ts`
**Description:**
Implement the cron scheduler. Read architecture/overview.md (cron config) and architecture/tasks.md (cron integration).

Features:
- Parse `cron` section from config
- Use the `croner` npm package for cron expression parsing and scheduling
- Each cron entry creates a task and optionally auto-runs it (spawns a sub-agent)
- `startCron(config, taskManager, agentSpawner): void`
- `stopCron(): void` — clean up all scheduled jobs
- Log each trigger

**Acceptance Criteria:**
- Cron jobs fire at scheduled times
- Each trigger creates a task record
- `autoRun: true` spawns a sub-agent for the task
- All jobs are cleaned up on stop

---

## Wave 8 — Wiring + Testing

### Task 20: Main Entry Point (Bootstrap)
**Priority:** p1  
**Depends on:** Task 4, Task 5, Task 6, Task 7, Task 8, Task 9, Task 19
**Files:** `src/core/index.ts`, `src/cli.ts`
**Description:**
Wire everything together into the bootstrap sequence. Read architecture/daemon.md for the full lifecycle.

Bootstrap order:
1. Load config (`loadConfig()`)
2. Init logger
3. Init database (`initDatabase()`)
4. Create Fastify instance
5. Init memory store
6. Init message buffer
7. Create router
8. Create session manager
9. Create task manager
10. Create the Koshi context object (fastify + all subsystems)
11. Load and init plugins
12. Start cron scheduler
13. Open IPC socket
14. `fastify.listen()`

Also create `src/cli.ts` for the CLI entry point: `koshi start`, `koshi stop`, `koshi status`, `koshi tui`.

**Acceptance Criteria:**
- `pnpm dev` starts Koshi, loads config, inits DB, loads plugins, starts Fastify
- Graceful shutdown on SIGTERM (all plugins torn down, DB closed)
- PID file written to `~/.koshi/koshi.pid`
- IPC socket opened at `~/.koshi/koshi.sock`
- Health endpoint responds at `GET /health`

---

### Task 21: End-to-End Validation
**Priority:** p1  
**Depends on:** Task 20, Task 17
**Files:** `src/test/e2e.ts`
**Description:**
Create an end-to-end test that validates the full pipeline. Read architecture/poc.md for success criteria.

Test sequence:
1. Boot Koshi with a test config (autotest + anthropic plugins)
2. Send a message via autotest channel: "What is 2+2?"
3. Verify message appears in buffer
4. Verify router processes the message and forwards to main agent
5. Verify Claude responds
6. Verify response is captured by autotest channel
7. Send a memory store command, verify memory is stored
8. Query memory, verify it's found
9. Stop Koshi, restart, verify buffer state persists
10. Send a message that matches a routing rule, verify sub-agent is spawned

**Acceptance Criteria:**
- Full round-trip works: autotest send → buffer → router → Claude → response → autotest receive
- Memory store and query work
- Buffer persistence across restart verified
- All POC success criteria from architecture/poc.md are validated

---

## Dependency Graph

```
Wave 1 (parallel):  T1  T2  T3  T4
                     │   │   │   │
Wave 2:              T5──┤   │   T7──T4
                     │   T3  │   │
                     T6  │   │   │
                     │   │   │   │
Wave 3:              T8──T5  T9──T7,T8
                     │       │
Wave 4:              T10 T11─T5,T10
                     │   │
Wave 5:              T12─T4,T11  T13─T7,T12  T14─T13,T11
                     │           │            │
Wave 6:              T15─T5      T16─T5
                     │           │
Wave 7:              T17─T9  T18─T9,T13  T19─T16,T14
                     │       │           │
Wave 8:              T20─(all core)      T21─T20,T17
```

## Notes for Sub-Agents

- Always read the relevant architecture doc before starting work
- Use the types from `src/types.ts` — don't reinvent interfaces
- All database operations use the single `data/koshi.db` file
- Follow the existing code style in the project
- Run `pnpm build` to verify TypeScript compiles before finishing
