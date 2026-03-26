# Orchestrate Cursor Agent MCP

Let your Claude Code instance spawn and bidirectionally communicate with `cursor-agent` (Cursor's CLI) as a background subagent. One cursor-agent process, many turns, fully non-blocking.

## MCP Servers

| MCP Server Name | Registered In | Purpose |
|---|---|---|
| `cursor-agent-orchestrator` | `src/orchestrator-mcp/server.js` | Claude Code side — spawn/check/reply/status/result/kill |
| `orchestrator-bridge` | `src/bridge-mcp/server.js` | cursor-agent side — `report_to_orchestrator` (blocking IPC) |

## What It Does

Claude Code instance can delegate tasks to Cursor's model catalog (GPT-5, Gemini, Composer, Claude, etc.) while maintaining a **multi-turn conversation loop** with the subagent. The subagent can ask clarifying questions, report progress, and receive instructions — all through file-based IPC.

## Setup

### Prerequisites

- Node.js 18+
- `cursor-agent` CLI installed and authenticated (`cursor-agent status`)

### Install

```bash
git clone https://github.com/thsunkid/orchestrate-cursor-agent-mcp.git
cd src
npm install
```

### Configure Bridge MCP for cursor-agent

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "orchestrator-bridge": {
      "command": "node",
      "args": ["/path/to/orchestrate-cursor-agent-mcp/src/bridge-mcp/server.js"],
      "env": {
        "BRIDGE_SESSION_DIR": "/tmp/cursor-bridge-session",
        "BRIDGE_POLL_MS": "500",
        "BRIDGE_TIMEOUT_MS": "300000"
      }
    }
  }
}
```

Then enable it:

```bash
cursor-agent mcp enable orchestrator-bridge
cursor-agent mcp list-tools orchestrator-bridge
# Should show: report_to_orchestrator (message)
```

### Configure Orchestrator MCP for Claude Code

Add to `.mcp.json` at the project root (see `mcp.json.example`):

```json
{
  "mcpServers": {
    "cursor-agent-orchestrator": {
      "command": "node",
      "args": ["/path/to/orchestrate-cursor-agent-mcp/src/orchestrator-mcp/server.js"],
      "env": { "BRIDGE_SESSION_DIR": "/tmp/cursor-bridge-session" }
    }
  }
}
```

### Install the Claude Code Skill (optional but recommended)

The `skill/` directory contains a Claude Code skill that teaches Claude Code how to use the orchestrator tools — spawn/reply workflow, background watchers, crash recovery, etc.

```bash
cp -r /path/to/orchestrate-cursor-agent-mcp/skill ~/.claude/skills/cursor-agent-orchestrator
```

Once installed, Claude Code will automatically know to use `cursor_agent_spawn` when you say things like "delegate this to cursor-agent", "use a different model for this", or "spin off a subagent".
## Architecture

```
┌──────────────────────┐       MCP tools           ┌───────────────────────┐
│   Claude Code        │◄─────────────────────────►│  Orchestrator MCP     │
│   (master agent)     │  cursor_agent_spawn/      │  (cursor-agent-       │
│                      │  check/reply/status/      │   orchestrator)       │
│                      │  result/kill              │  src/orchestrator-mcp │
└──────────────────────┘                           └───────┬───────────────┘
                                                           │ file IPC
                                                           │ /tmp/cursor-bridge-session/
                                                           │   bridge-{pid}/
                                                           │     question_N.json ↔ answer_N.json
┌──────────────────────┐       MCP tool            ┌───────┴───────────────┐
│   cursor-agent       │──────────────────────────►│  Bridge MCP           │
│   (subagent, 1 proc) │  report_to_orchestrator   │  (orchestrator-bridge)│
│   --print --yolo     │  (blocks until answered)  │  src/bridge-mcp       │
└──────────────────────┘                           └───────────────────────┘
```

Each bridge MCP process creates its own `bridge-{pid}/` subdirectory, so multiple concurrent agents never collide.

### Communication Flow

1. Claude Code calls `cursor_agent_spawn(task, model)` → orchestrator MCP spawns `cursor-agent --print --yolo` in background
2. cursor-agent works on the task. When it needs to communicate, it calls `report_to_orchestrator` (bridge MCP tool)
3. Bridge MCP writes `question_N.json` to the session dir, then **blocks** polling for `answer_N.json`
4. Claude Code calls `cursor_agent_check()` → sees the question
5. Claude Code calls `cursor_agent_reply(answer)` → writes `answer_N.json`
6. Bridge MCP reads the answer, unblocks, returns it to cursor-agent
7. cursor-agent continues working, repeats from step 2
8. When done, Claude Code calls `cursor_agent_result()` for final output

## Components

### 1. Orchestrator MCP (`src/orchestrator-mcp/server.js`)

MCP name: **`cursor-agent-orchestrator`**

**Claude Code connects to this.** Provides 6 tools:

| Tool | Description |
|------|-------------|
| `cursor_agent_spawn` | Spawn background cursor-agent with task + model |
| `cursor_agent_check` | Check for pending message from cursor-agent |
| `cursor_agent_reply` | Send reply to cursor-agent's question |
| `cursor_agent_status` | Get agent status: working / waiting_for_reply / completed |
| `cursor_agent_result` | Get agent's final stdout output |
| `cursor_agent_kill` | Force-terminate the agent |

### 2. Bridge MCP (`src/bridge-mcp/server.js`)

MCP name: **`orchestrator-bridge`**

**cursor-agent connects to this.** Single tool: `report_to_orchestrator(message)`. Writes a question file, blocks polling for an answer file, returns the answer.

### 3. Orchestrator CLI (`src/orchestrator.js`)

Standalone CLI wrapper for the same file IPC, useful for testing or Bash-based workflows.

## Key Design Decisions

- **One process per task.** cursor-agent runs as a single `--print --yolo` process. Its agentic loop calls `report_to_orchestrator` multiple times.
- **File-based IPC.** Simple, debuggable, no sockets. Question/answer JSON files in a shared directory.
- **Blocking bridge.** The bridge MCP blocks until the orchestrator answers. cursor-agent waits naturally.
- **Non-blocking orchestrator.** Claude Code spawns the agent in background and checks on it when convenient.
- **Session isolation.** Each bridge process creates its own subdirectory (`bridge-{pid}/`), enabling multiple concurrent agents.

## File Structure

```
orchestrate-cursor-agent-mcp/
├── README.md                          # This file
├── mcp.json.example                   # Example .mcp.json for Claude Code
├── skill/                             # Claude Code skill (copy to ~/.claude/skills/)
│   ├── SKILL.md                       # Skill instructions — workflow, rules, models
│   └── references/
│       └── patterns.md                # Advanced patterns — auto-reply, crash recovery
└── src/                               # Core implementation
    ├── orchestrator.js                # CLI wrapper for file IPC
    ├── package.json
    ├── bridge-mcp/
    │   └── server.js                  # Bridge MCP (name: orchestrator-bridge)
    ├── orchestrator-mcp/
    │   ├── server.js                  # Orchestrator MCP (name: cursor-agent-orchestrator)
    │   └── ARCHITECTURE.md            # Detailed architecture diagrams
    ├── hooks/
    │   ├── post-tool-use.js           # PostToolUse hook for auto-discovering pending questions
    │   └── README.md
    └── test_5turn_bridge.mjs          # Bridge MCP e2e (5-turn, file IPC)
```


## Testing

Quick smoke test:

```bash
# Terminal 1: Spawn agent
node src/orchestrator.js spawn "Ask me what to build via report_to_orchestrator" --model composer-2

# Terminal 2: Watch for questions and answer
node src/orchestrator.js check
node src/orchestrator.js reply "Build a hello world function"
node src/orchestrator.js result
```

Automated test:

```bash
cd src
node test_5turn_bridge.mjs    # 5-turn bridge MCP e2e (file IPC, single process)
```

