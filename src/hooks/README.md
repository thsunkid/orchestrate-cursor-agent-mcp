# PostToolUse Hook for Cursor-Agent Bridge

This hook integrates with Claude Code's hook system to proactively remind Claude Code when a cursor-agent is waiting for a reply via the bridge MCP.

## What it does

After every tool call, the hook:
1. Scans `bridge-{pid}/` subdirectories in the bridge session dir for unanswered `question_N.json` files
2. If any pending question exists, injects `additionalContext` into Claude Code's conversation
3. The context includes the pending message and a reminder to call `cursor_agent_reply`

## Installation

Add to your Claude Code settings (`.claude/settings.json` or project-level):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "command": "node /absolute/path/to/src/hooks/post-tool-use.js",
        "timeout": 5000
      }
    ]
  }
}
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `BRIDGE_SESSION_DIR` | `/tmp/cursor-bridge-session` | Base directory for bridge IPC files |

## How it works

```
cursor-agent calls report_to_orchestrator("Found 3 issues, want details?")
  → Bridge MCP writes question_1.json, blocks waiting for answer

Claude Code does other work (reads files, makes edits, etc.)
  → [PostToolUse hook fires after each tool call]
  → Hook detects unanswered question in bridge-{pid}/
  → Injects: "[Cursor-Agent Awaiting Reply] Turn 1: Found 3 issues..."
  → Claude Code sees the reminder and calls cursor_agent_reply

Claude Code calls cursor_agent_reply("Yes, show me the details")
  → Orchestrator writes answer_1.json → bridge unblocks → cursor-agent continues
```

## Notes

- The hook is optional — the bridge tools work without it. It just ensures Claude Code doesn't "forget" about a pending question while doing other work.
- Hook timeout is set to 5 seconds — the file scan is fast (sub-100ms typically).
