# Koshi (骨子)

A skeleton framework for agentic assistants. Built for Claude, not model-agnostic. Thin core, plugin everything else.

## Install

```bash
git clone https://github.com/Musqet-Rich/koshi.git
cd koshi
pnpm install
pnpm build
```

## Configure

```bash
# Set your Anthropic API key
node dist/cli.js set anthropic.apiKey sk-ant-your-key-here

# Copy the example config
cp koshi.example.yaml koshi.yaml
```

Secrets are stored in `~/.config/koshi/secrets.yaml` (chmod 600, never committed).

Edit `koshi.yaml` to customise the soul, models, plugins, and routes.

## Run

```bash
# Start the daemon
node dist/cli.js start

# Connect with the TUI (in another terminal)
node dist/cli.js tui
```

The daemon runs on port 3100 by default. The TUI connects via WebSocket.

## Manage secrets

```bash
node dist/cli.js set <key> <value>    # e.g. set anthropic.apiKey sk-ant-...
node dist/cli.js get [key]            # show redacted value, or list all
node dist/cli.js unset <key>          # remove a secret
```

## Development

```bash
pnpm check      # typecheck + lint (must pass before committing)
pnpm typecheck  # tsc only
pnpm lint       # biome only
pnpm lint:fix   # biome auto-fix
pnpm dev        # run daemon with tsx (no build step)
```

## Documentation

- [Claude Code Integration](docs/claude-code-integration.md) — using Max/Pro subscription as LLM backend

## Design Philosophy

Four primitives, each with a clear role:

- **Skills** teach the agent *how* to handle things
- **Memory** gives it *what* it knows
- **Tools** let it *act* directly
- **Prompts** steer but don't micromanage

Everything else is composition.

## Architecture

- **Single Node.js process** — Fastify server, plugin architecture
- **Plugins**: channels (bidirectional), services (outbound), listeners (inbound)
- **TUI** ships with core — `src/tui/` contains both the channel plugin and the Ink terminal app
- **Memory** — SQLite + FTS5 with reinforcement scoring
- **Message buffer** — persistent SQLite queue with configurable batching
- **Smart routing** — pattern-matching rules at router level, no LLM needed for routing

## Licence

GPL-3.0
