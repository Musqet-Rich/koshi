# Claude Code Integration

Use Claude Code CLI as Koshi's LLM backend, powered by your Anthropic Max or Pro subscription — no API keys required.

## Overview

Koshi can use Claude Code as an LLM provider instead of (or alongside) the direct Anthropic API. This lets you run Claude Opus and Sonnet through your Max/Pro subscription rather than paying per-token via API keys.

The integration works by spawning `claude --print` as a subprocess for each completion. An MCP server running over stdio gives Claude Code access to Koshi's native tools (memory, scheduling, skills, agents) while `--allowedTools` restricts it from using Claude Code's built-in tools (Read, Write, Bash, etc.).

## Prerequisites

- **Node.js** ≥ 20
- **Claude Code CLI** installed globally
- **Anthropic Max or Pro subscription** — logged in via `claude /login`
- **Koshi** built and running (`pnpm build && node dist/cli.js start`)

## How It Works

```
┌─────────────────────────────────────────────────────┐
│  Koshi Daemon (port 3200)                           │
│                                                     │
│  ┌─────────────┐    ┌──────────────────────┐        │
│  │ Agent Loop   │───▶│ Claude Code Plugin    │       │
│  │              │◀───│ (spawns `claude -p`)  │       │
│  └──────┬───────┘    └──────────────────────┘        │
│         │                      │                     │
│         │                      │ stdin: prompt        │
│         │                      │ stdout: JSON response│
│         │                      ▼                     │
│         │            ┌──────────────────────┐        │
│         │            │ claude --print        │        │
│         │            │  --mcp-config ...     │        │
│         │            │  --allowedTools ...   │        │
│         │            └──────────┬────────────┘        │
│         │                      │                     │
│         │            MCP stdio │                     │
│         │                      ▼                     │
│  ┌──────┴───────┐    ┌──────────────────────┐        │
│  │ Tool Executor │◀──│ MCP Server (stdio)    │       │
│  │              │    │ node mcp-server.js    │        │
│  └──────────────┘    └──────────────────────┘        │
│         ▲                      │                     │
│         │    HTTP POST         │                     │
│         │ /api/tools/call      │                     │
│         └──────────────────────┘                     │
└─────────────────────────────────────────────────────┘
```

1. Koshi's agent loop sends messages to the Claude Code plugin
2. The plugin spawns `claude --print` with the prompt on stdin
3. Claude Code starts the MCP server as a child process (configured via `--mcp-config`)
4. When Claude decides to use a tool, it calls the MCP server over stdio
5. The MCP server makes an HTTP POST to `http://127.0.0.1:3200/api/tools/call`
6. Koshi executes the tool and returns the result back through the chain
7. Claude Code returns the final response as JSON on stdout

The `--allowedTools` flag restricts Claude Code to **only** the listed MCP tools — it cannot use its built-in Read, Write, Bash, or other filesystem tools.

## Setup Steps

### 1. Install Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

### 2. Login with your subscription

```bash
claude /login
```

Select the **subscription** option (not API key). This authenticates via OAuth with your Max or Pro plan.

### 3. Configure `koshi.yaml`

Add the Claude Code plugin and define models that use it:

```yaml
models:
  sonnet-max:
    plugin: "./dist/plugins/claude-code/index.js"
    model: sonnet
  opus-max:
    plugin: "./dist/plugins/claude-code/index.js"
    model: opus

agent:
  model: opus-max
  subAgentModel: opus-max

plugins:
  - name: "./dist/plugins/claude-code/index.js"
    bin: /home/monomi/.npm-global/bin/claude
    skipPermissions: true
    mcpConfig: /home/monomi/.openclaw/workspace/koshi/mcp-config.json
    allowedTools:
      - "mcp__koshi__memory_query"
      - "mcp__koshi__memory_store"
      - "mcp__koshi__memory_reinforce"
      - "mcp__koshi__memory_demote"
      - "mcp__koshi__memory_update"
      - "mcp__koshi__schedule_job"
      - "mcp__koshi__cancel_job"
      - "mcp__koshi__list_jobs"
      - "mcp__koshi__load_skill"
      - "mcp__koshi__create_skill"
      - "mcp__koshi__update_skill"
      - "mcp__koshi__spawn_agent"
      - "mcp__koshi__list_agents"
      - "mcp__koshi__read_file"
```

You can mix this with the standard Anthropic API plugin — use `sonnet-max`/`opus-max` for subscription-backed models and `haiku`/`opus` for API-backed ones.

### 4. Create the MCP config file

Create `mcp-config.json` in the project root:

```json
{
  "mcpServers": {
    "koshi": {
      "command": "node",
      "args": ["dist/core/mcp-server.js"],
      "cwd": "/absolute/path/to/koshi",
      "env": {
        "KOSHI_PORT": "3200"
      }
    }
  }
}
```

The server name `koshi` determines the tool prefix. Tools are exposed as `mcp__koshi__<tool_name>` — this must match the `allowedTools` entries.

### 5. Define model names

In the `models` section, the `model` field maps to Claude Code's `--model` flag:

| Koshi model name | `model` value | Resolves to |
|---|---|---|
| `sonnet-max` | `sonnet` | Latest Sonnet via subscription |
| `opus-max` | `opus` | Latest Opus via subscription |

You can use any model identifier that Claude Code accepts.

## Configuration Reference

Plugin options under the `plugins` entry:

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | — | Path to the plugin: `"./dist/plugins/claude-code/index.js"` |
| `bin` | `string` | `"claude"` | Path to the Claude Code binary. Use absolute path to avoid ENOENT. |
| `skipPermissions` | `boolean` | `true` | Pass `--dangerously-skip-permissions` to avoid interactive permission prompts. Required for non-interactive use. |
| `mcpConfig` | `string` | — | Absolute path to the MCP config JSON file. |
| `allowedTools` | `string[]` | — | List of tools Claude Code is allowed to use. Format: `mcp__<server>__<tool>`. If omitted, Claude Code can use all available tools including built-in ones. |

Model options under `models.<name>`:

| Option | Type | Description |
|---|---|---|
| `plugin` | `string` | Must match the plugin `name`: `"./dist/plugins/claude-code/index.js"` |
| `model` | `string` | Model identifier passed to `claude --model`. E.g. `sonnet`, `opus`, `claude-sonnet-4-20250514`. |

## Troubleshooting

### `ENOENT: no such file or directory, spawn 'claude'`

The `claude` binary isn't on the daemon's PATH. Use an absolute path:

```yaml
bin: /home/youruser/.npm-global/bin/claude
```

Find it with `which claude`.

### `Not logged in` or authentication errors

Run `claude /login` interactively and complete the OAuth flow. The daemon uses the same stored credentials.

### MCP tools not appearing / not being called

Check that `allowedTools` entries match the `mcp__<server>__<tool>` format exactly. The server name comes from `mcp-config.json` (the key under `mcpServers`). For a server named `koshi` with a tool named `memory_query`, the allowed tool string is `mcp__koshi__memory_query`.

### Slow responses

Expected. Each completion spawns a new `claude` process — there's no persistent connection or warm pool. The MCP server also starts fresh for each invocation. Typical overhead is 2-5 seconds on top of model inference time.

### Tool calls failing with connection refused

Make sure Koshi's HTTP server is running on the port specified in `mcp-config.json`. Default is 3200. Check with:

```bash
curl http://127.0.0.1:3200/api/tools/call -X POST \
  -H 'Content-Type: application/json' \
  -d '{"tool":"list_jobs","input":{}}'
```

## Limitations

- **Latency**: The CLI wrapper adds 2-5s overhead per completion. Each call is a cold start — new process, new MCP server, new connection.
- **No streaming to TUI**: The TUI doesn't receive incremental text until Claude Code returns the full response. The `stream-json` output mode is used internally but the process must complete before Koshi can relay chunks.
- **ToS compliance**: Anthropic's OAuth tokens are scoped to Claude Code only. This is why Koshi wraps the CLI binary rather than extracting and reusing the OAuth token directly. Don't try to use the token outside of `claude`.
- **Uniform tool scoping**: All invocations (main agent, sub-agents) use the same `allowedTools` list. Per-invocation tool scoping is not yet implemented.
- **No tool definitions passthrough**: Koshi's internal `Tool[]` definitions are not passed to Claude Code. Tools are exposed exclusively via MCP. The `tools` parameter in the plugin's `complete()` method is currently ignored.
