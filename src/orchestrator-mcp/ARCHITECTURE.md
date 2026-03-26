# Cursor Agent Orchestrator — Architecture

## Overview

This system lets Claude Code spawn and communicate with background `cursor-agent` processes bidirectionally. Each cursor-agent runs a different model (GPT, Gemini, Composer, Claude, etc.) and stays alive across multiple turns.

```
┌──────────────────────────────────────────────────────────────────┐
│                         Claude Code                              │
│                                                                  │
│  ┌────────────────────┐    ┌──────────────────────────────────┐  │
│  │  cursor-subagent   │    │  cursor-agent-orchestrator MCP   │  │
│  │  SKILL.md          │───>│  (orchestrator-mcp/server.js)    │  │
│  │  (instructions)    │    │                                  │  │
│  └────────────────────┘    │  Tools:                          │  │
│                            │    cursor_agent_spawn            │  │
│                            │    cursor_agent_check            │  │
│                            │    cursor_agent_reply            │  │
│                            │    cursor_agent_status           │  │
│                            │    cursor_agent_result           │  │
│                            │    cursor_agent_kill             │  │
│                            └──────────┬───────────────────────┘  │
│                                       │                          │
│  ┌────────────────────────────┐       │                          │
│  │  Background Watcher        │       │                          │
│  │  Bash(run_in_background)   │<──────┘ (returned after          │
│  │  watches for question_N    │          spawn/reply)            │
│  │  auto-surfaces on complete │                                  │
│  └────────────────────────────┘                                  │
└──────────────────────────────────────────────────────────────────┘
         │ spawn()                        ▲ file watcher
         │                                │
         ▼                                │
┌─────────────────────────────────────────┴────────────────────────┐
│                    /tmp/cursor-bridge-session/                   │
│                                                                  │
│  ┌─────────────────────┐  ┌─────────────────────┐                │
│  │ {session-uuid}/     │  │ bridge-{pid}/       │                │
│  │  .orchestrator-     │  │  question_1.json ◄───── bridge write │
│  │    state.json       │  │  answer_1.json   ◄───── orch write   │
│  │  .agent-stdout.txt  │  │  question_2.json    │                │
│  │  .agent-stderr.txt  │  │  answer_2.json      │                │
│  └─────────────────────┘  │  ...                │                │
│  (metadata per session)   └─────────────────────┘                │
│                           (IPC files per bridge)                 │
│                                                                  │
│  .active-session  (tracks most recent session_id)                │
└──────────────────────────────────────────────────────────────────┘
         ▲ file I/O                       │
         │                                │
         ▼                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                       cursor-agent CLI                           │
│                  (background process, PID tracked)               │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  orchestrator-bridge MCP  (bridge-mcp/server.js)         │    │
│  │                                                          │    │
│  │  Tool: report_to_orchestrator(message)                   │    │
│  │    1. Write question_N.json to bridge-{pid}/             │    │
│  │    2. Poll for answer_N.json (blocks up to 5 min)        │    │
│  │    3. Return answer to cursor-agent                      │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Model: composer-2 / gpt-5.3 / opus-4.6 / gemini-3-pro / ...     │
└──────────────────────────────────────────────────────────────────┘
```

## Spawn Flow

```
Claude Code                    Orchestrator MCP               cursor-agent
    │                               │                              │
    │  cursor_agent_spawn(task)     │                              │
    │──────────────────────────────>│                              │
    │                               │                              │
    │                               │  1. Generate session UUID    │
    │                               │  2. Snapshot bridge dirs     │
    │                               │  3. Disable interactive-     │
    │                               │     feedback-mcp             │
    │                               │  4. Build prompt with        │
    │                               │     BRIDGE_PREAMBLE + task   │
    │                               │                              │
    │                               │  spawn(cursor-agent          │
    │                               │    --print --yolo            │
    │                               │    --model composer-2        │
    │                               │    --output-format text      │
    │                               │    <prompt>)                 │
    │                               │─────────────────────────────>│
    │                               │                              │
    │                               │  5. Pipe stdout/stderr       │
    │                               │     to session dir files     │
    │                               │                              │
    │                               │  6. Wait 3 seconds           │
    │                               │  7. Check PID alive          │
    │                               │                              │
    │                               │  8. Find NEW bridge-{pid}/   │
    │                               │     dir (set difference)     │
    │                               │                              │
    │                               │  9. Save state with          │
    │                               │     bridgeDir, nextTurn=1    │
    │                               │                              │
    │  { session_id, PID,           │                              │
    │    watcher command }          │                              │
    │<──────────────────────────────│                              │
    │                               │                              │
    │  Bash(run_in_background):     │                              │
    │  watch for question_1.json    │                              │
    │  in bridge-{pid}/             │                              │
    │                               │                              │
    │  END TURN                     │                              │
    │  "Agent is working..."        │                              │
```

## Communication Cycle

```
cursor-agent              Bridge MCP               Filesystem          Watcher           Claude Code
    │                         │                         │                  │                   │
    │  (does work)            │                         │                  │                   │
    │                         │                         │                  │ watching for      │
    │  report_to_orchestrator │                         │                  │ question_1.json   │
    │  (message: "found X")   │                         │                  │ in bridge-{pid}/  │
    │────────────────────────>│                         │                  │                   │
    │                         │                         │                  │                   │
    │                         │  write question_1.json  │                  │                   │
    │                         │────────────────────────>│                  │                   │
    │                         │                         │                  │                   │
    │                         │  poll for answer_1.json │  ┌───────────┐   │                   │
    │                         │  (blocks, 500ms poll)   │  │ detected! │   │                   │
    │                         │                         │  └─────┬─────┘   │                   │
    │                         │                         │        │         │                   │
    │                         │                         │        │ cat     │                   │
    │                         │                         │        │ file    │                   │
    │                         │                         │        │         │  auto-surface     │
    │                         │                         │        │         │  question content │
    │                         │                         │        └────────>│──────────────────>│
    │                         │                         │                  │                   │
    │                         │                         │                  │  (Claude Code     │
    │                         │                         │                  │   reads message,  │
    │                         │                         │                  │   decides reply)  │
    │                         │                         │                  │                   │
    │                         │                         │                  │ cursor_agent_reply│
    │                         │                         │                  │ (message: "dig    │
    │                         │                         │                  │  into X next")    │
    │                         │                         │<─────────────────┤                   │
    │                         │                         │ write answer_1   │                   │
    │                         │                         │                  │                   │
    │                         │  answer_1.json found!   │                  │  start new watcher│
    │                         │<────────────────────────│                  │  for question_2   │
    │                         │                         │                  │                   │
    │                         │  delete question_1      │                  │                   │
    │                         │  delete answer_1        │                  │                   │
    │                         │────────────────────────>│                  │                   │
    │                         │                         │                  │                   │
    │  reply: "dig into X"    │                         │                  │                   │
    │<────────────────────────│                         │                  │                   │
    │                         │                         │                  │                   │
    │  (continues working...) │                         │                  │                   │
    │                         │                         │                  │                   │
    │  report_to_orchestrator │                         │                  │                   │
    │  (message: "found Y")   │                         │                  │                   │
    │────────────────────────>│                         │                  │                   │
    │         ...             │      (cycle repeats)    │                  │                   │
```

## Session Isolation

Multiple agents can run simultaneously. Each gets its own isolated IPC directory.

```
/tmp/cursor-bridge-session/
├── .active-session              # tracks most recent session UUID
│
├── {uuid-A}/                    # session A metadata
│   ├── .orchestrator-state.json #   { pid, bridgeDir, nextTurn, ... }
│   ├── .agent-stdout.txt        #   cursor-agent stdout capture
│   └── .agent-stderr.txt        #   cursor-agent stderr capture
│
├── {uuid-B}/                    # session B metadata
│   ├── .orchestrator-state.json
│   ├── .agent-stdout.txt
│   └── .agent-stderr.txt
│
├── bridge-42019/                # agent A's bridge IPC dir (PID-based)
│   ├── question_1.json          #   { turn, message, timestamp }
│   └── answer_1.json            #   { reply, timestamp }
│
└── bridge-42087/                # agent B's bridge IPC dir (PID-based)
    ├── question_1.json          #   no collision with agent A!
    └── answer_1.json
```

**How isolation works:**

1. Bridge MCP creates `bridge-{process.pid}/` on startup
2. Orchestrator snapshots bridge dirs BEFORE spawn, then finds the NEW one after
3. Bridge dir path stored in session state — all subsequent operations scoped to it
4. Watchers watch a specific bridge dir for a specific turn number
5. No cross-talk: agent A's watcher only sees agent A's bridge dir

## Bridge Preamble

The orchestrator prepends this to every task prompt. It tells the cursor-agent:
- Use ONLY `report_to_orchestrator` for communication
- Call back FREQUENTLY (every 1-2 steps) to avoid timeouts
- Never exit on its own — wait for explicit stop signal

```
ORCHESTRATION MODE: You are a subagent. Communicate ONLY via
report_to_orchestrator (orchestrator-bridge MCP).

CRITICAL: Call report_to_orchestrator FREQUENTLY — after every
1-2 steps, not at the end. Do NOT read all files and then report
at the end. Report incrementally as you go. Waiting too long
before calling back will cause a timeout and lose all your work.

After each meaningful step → report_to_orchestrator(what you found
+ what you want to do next). Wait for reply → continue → repeat.

Stop only when: task done + results reported, OR explicit
"stop"/"done", OR fatal error (report first).
```

## Background Watcher

The watcher is a bash script that runs as a Claude Code background task. It replaces polling.

```bash
PID={agent_pid}
TIMEOUT=300
START=$(date +%s)

while true; do
    # Check for the specific next question file
    [ -f {bridge_dir}/question_{N}.json ] && \
        cat {bridge_dir}/question_{N}.json && break

    # Check if agent is still alive
    kill -0 $PID 2>/dev/null || \
        { echo "ERROR: Agent not running"; exit 1; }

    # Check timeout (5 minutes)
    [ $(( $(date +%s) - START )) -gt $TIMEOUT ] && \
        { echo "ERROR: Timeout"; exit 1; }

    sleep 2
done
```

**Key properties:**
- Watches ONE specific file (`question_{N}.json` in a specific bridge dir)
- Checks agent liveness every 2 seconds via `kill -0`
- 5-minute timeout to prevent zombie watchers
- Auto-surfaces in Claude Code when the file appears (background task completion)
- Claude Code must END ITS TURN after starting the watcher — never call `TaskOutput`

## Error Handling

```
Agent crashed?
    │
    ▼
Watcher detects: kill -0 fails
    │
    ▼
Watcher outputs: "ERROR: Agent (PID X) not running"
    │
    ▼
Background task auto-surfaces error
    │
    ▼
Claude Code calls cursor_agent_result(session_id)
    │
    ▼
Returns full diagnostic:
    ├── STDERR: connection errors, stack traces
    ├── STDOUT: last output before crash
    ├── State: PID, elapsed time, turns answered
    └── Bridge dir: which turn it died on
```

## Component Files

```
src/
├── orchestrator-mcp/
│   ├── server.js          # Orchestrator MCP (6 tools, runs in Claude Code)
│   └── ARCHITECTURE.md    # This file
│
├── bridge-mcp/
│   └── server.js          # Bridge MCP (1 tool, runs in cursor-agent)
│
├── hooks/
│   └── post-tool-use.js   # PostToolUse hook
│
└── orchestrator.js        # CLI wrapper for file IPC
```

## Known Limitations

1. **cursor-agent doesn't forward env vars to MCP subprocesses.**
   The bridge always gets `BRIDGE_SESSION_DIR` from cursor-agent's stored MCP config,
   not from the spawn env. Session isolation works via PID-based bridge subdirectories
   instead.

2. **Bridge timeout vs cursor-agent timeout.**
   The bridge waits 5 minutes for a reply, but cursor-agent may have its own shorter
   MCP tool call timeout. If the agent works too long before calling
   `report_to_orchestrator`, the tool call may time out. The preamble mitigates this
   by requiring frequent check-ins.

3. **`interactive-feedback-mcp` competes with bridge.**
   cursor-agent may prefer `interactive-feedback-mcp` over `orchestrator-bridge`.
   The orchestrator disables it before spawn and re-enables after exit. If the
   orchestrator crashes, it may remain disabled — re-enable manually:
   `cursor-agent mcp enable interactive-feedback-mcp`

4. **Some models have connection instability.**
   Gemini models in particular may drop connections and fail after 2 retries.
   Use `cursor_agent_result` to diagnose — stderr will show retry logs.
