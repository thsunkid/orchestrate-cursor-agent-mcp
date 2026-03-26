---
name: cursor-agent-orchestrator
description: "Spawn a Cursor CLI agent as a background subagent and communicate with it bidirectionally via bridge MCP. Use when: (1) the user asks to delegate a task to cursor-agent or a subagent, (2) the user wants to use a different model (GPT, Gemini, Composer) for a subtask, (3) the user says 'use cursor agent', 'spin off an agent', 'delegate to cursor', or similar. Handles spawning, multi-turn communication, crash recovery, and result retrieval — all within a single stateful cursor-agent process."
---

# Cursor Agent Orchestrator

Spawn a background `cursor-agent` and communicate via native MCP tools. One process, many turns, **stateful by default**.

## Prerequisites

- `cursor-agent` CLI installed and authenticated
- Bridge MCP enabled: `cursor-agent mcp enable orchestrator-bridge`
  - **This is critical.** Without this, the agent cannot communicate back and will exit silently.
- Orchestrator MCP configured in `.mcp.json` (provides `cursor_agent_*` tools)

## How It Works

The MCP automatically:
- Injects rules telling the agent to use ONLY `report_to_orchestrator` (not `interactive-feedback-mcp`)
- Disables competing communication MCPs before spawn, re-enables after exit
- Creates an **isolated session subdirectory** per spawn — multiple agents can run simultaneously without colliding
- Appends a reminder to every reply telling the agent to call back
- Returns a **background watcher command** and **session_id** after spawn/reply

**You do not need any boilerplate** in task prompts or replies. Just send the task.

**Always pass `session_id`** to `cursor_agent_check`, `cursor_agent_reply`, `cursor_agent_status`, `cursor_agent_result`, and `cursor_agent_kill` to target the right agent. The most recent session is used if omitted.

## Workflow

### 1. Spawn

```
cursor_agent_spawn(task: "Research the auth system and write findings to /tmp/auth-research.md", model: "composer-1")
```

The response includes a `session_id` and background watcher command. **Save the session_id** — you'll need it for all subsequent calls to this agent. Run the watcher immediately.

### 2. Start background watcher (MANDATORY after every spawn and reply)

The spawn/reply response includes a `Bash(run_in_background: true)` command. **Always run it:**

```
Bash(run_in_background: true):
  <the watcher command from spawn/reply response>
```

This watches for the agent's next message in the background. When the agent responds, the watcher completes and its output **auto-surfaces at your next turn**.

**CRITICAL: After starting the background watcher, END YOUR TURN immediately.** Tell the user "Agent is working, I'll be notified when it responds." Do NOT call `TaskOutput` to wait for the watcher — that blocks the entire session and prevents the user from chatting. The watcher result auto-surfaces when it completes, just like native background subagents.

### 3. Do other work / wait for auto-surface

After starting the watcher and ending your turn:
- The user can chat with you about other things
- When the agent responds, the background task completes and auto-surfaces
- You'll see the question content appear in your context

**Do NOT call `TaskOutput` to wait. Do NOT call `cursor_agent_check` in a loop. Do NOT use `sleep`.** Just end your turn and let the watcher notify you.

### 4. Agent responds → reply → new watcher

When the background watcher auto-surfaces the agent's message, read it, then:

```
cursor_agent_reply(message: "Now dig into the JWT verification logic")
```

The reply response includes another watcher command. **Run it in background again.** Repeat the cycle.

### 5. Finish

```
cursor_agent_reply(message: "Done. You can stop now.")
```

The agent will exit. No need for a new watcher.

## Key Rules

- **Background watcher after every spawn/reply.** This is mandatory. It replaces polling.
- **Never poll cursor_agent_check in a loop.** The watcher handles it.
- **Keep sessions alive.** A single persistent session is cheaper than spawning multiple agents. Reuse the same session for follow-up tasks, even if they're different from the original task. Only spawn a new agent if the current one has crashed or you explicitly need a different model.
- **No boilerplate needed.** Don't add "never exit" or "ask me again" — the MCP handles this.
- **Low tokens for file-heavy tasks.** Tell the agent to write to a file. Check growth with `stat -f "%z"`.
- **Error handling.** The watcher command includes PID liveness checks and a 5-minute timeout:
  - If spawn returns `isError: true` → agent failed to start. Check the error message.
  - If watcher outputs `ERROR: Cursor agent (PID ...) is not running` → agent died mid-session. Call `cursor_agent_result()` for details, then spawn a new agent.
  - If watcher outputs `ERROR: Timeout` → agent took too long. Check `cursor_agent_status()` and consider killing with `cursor_agent_kill()`.
- **Crash recovery.** Spawn a new agent with context from the previous session (new sessions have NO memory).
- **Don't kill too quickly.** Agents can go silent for several minutes while doing real work. Do NOT kill unless confirmed dead or exhausted retries. If the watcher times out, check `cursor_agent_check` — if it says "still working", restart the watcher.
- **Waiting for user input.** When you need user input before giving the agent its next task, do NOT tell the agent "stand by" — it will immediately call back and burn turns. Instead, tell the agent to run `sleep N` before reporting back, using exponential backoff: start with `sleep 60`, then `sleep 120`, `240`, etc.

## Models

Run `cursor-agent models` for the full list. Common choices:
- `composer-1` (default) — fast, good for most tasks
- `gpt-5.3-codex-xhigh-fast` — GPT-5.3, strong for deep research
- `opus-4.6` / `opus-4.6-thinking` — Claude Opus
- `sonnet-4.5` / `sonnet-4.5-thinking` — Claude Sonnet
- `gemini-3-flash` / `gemini-3-pro` — Gemini

## Advanced Patterns

See [references/patterns.md](references/patterns.md) for auto-reply loops and crash recovery templates.
