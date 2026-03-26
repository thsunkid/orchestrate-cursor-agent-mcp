/**
 * Orchestrator MCP Server — Claude Code's native interface to cursor-agent.
 *
 * Tools:
 *   cursor_agent_spawn   — spawn a background cursor-agent process
 *   cursor_agent_check   — check for pending question from cursor-agent
 *   cursor_agent_reply   — reply to a pending question
 *   cursor_agent_status  — get agent status (working/waiting/completed)
 *   cursor_agent_result  — get final agent output
 *   cursor_agent_kill    — terminate the agent
 *
 * Session isolation:
 *   Each bridge MCP process creates its own subdir: {BASE_DIR}/bridge-{bridgePid}/
 *   The orchestrator discovers the bridge dir after spawn and stores it in state.
 *   This allows multiple agents to run simultaneously without IPC collisions.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, execSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  unlinkSync,
  createWriteStream,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const BASE_DIR = process.env.BRIDGE_SESSION_DIR || "/tmp/cursor-bridge-session";
const ACTIVE_SESSION_FILE = join(BASE_DIR, ".active-session");
mkdirSync(BASE_DIR, { recursive: true });

// ── Session helpers ───────────────────────────────────────────────────────────

function sessionDir(sessionId) {
  return join(BASE_DIR, sessionId);
}

function stateFile(sessionId) {
  return join(sessionDir(sessionId), ".orchestrator-state.json");
}

function getActiveSessionId() {
  try {
    return readFileSync(ACTIVE_SESSION_FILE, "utf8").trim();
  } catch {
    return null;
  }
}

function setActiveSessionId(sessionId) {
  writeFileSync(ACTIVE_SESSION_FILE, sessionId, "utf8");
}

function resolveSessionId(provided) {
  if (provided) return provided;
  const active = getActiveSessionId();
  if (active) return active;
  return null;
}

function loadState(sessionId) {
  try {
    return JSON.parse(readFileSync(stateFile(sessionId), "utf8"));
  } catch {
    return { pid: null, answeredCount: 0, startedAt: null, sessionId };
  }
}

function saveState(sessionId, state) {
  writeFileSync(
    stateFile(sessionId),
    JSON.stringify({ ...state, sessionId }, null, 2),
    "utf8",
  );
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Bridge dir discovery ─────────────────────────────────────────────────────
// Each bridge MCP creates {BASE_DIR}/bridge-{pid}/. We discover the new one
// by comparing directory listings before and after spawn.

function listBridgeDirs() {
  try {
    return new Set(
      readdirSync(BASE_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith("bridge-"))
        .map((e) => e.name),
    );
  } catch {
    return new Set();
  }
}

function findNewBridgeDir(beforeSet, maxWaitMs = 15000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const current = listBridgeDirs();
    for (const name of current) {
      if (!beforeSet.has(name)) return join(BASE_DIR, name);
    }
    // Busy-wait briefly (only during spawn, not in hot path)
    const waitUntil = Date.now() + 500;
    while (Date.now() < waitUntil) {
      /* spin */
    }
  }
  return null;
}

// ── IPC helpers ──────────────────────────────────────────────────────────────

function findPendingQuestion(bridgeDir, expectedTurn) {
  if (!bridgeDir) return null;
  const qf = join(bridgeDir, `question_${expectedTurn}.json`);
  const af = join(bridgeDir, `answer_${expectedTurn}.json`);
  if (existsSync(qf) && !existsSync(af)) {
    try {
      const data = JSON.parse(readFileSync(qf, "utf8"));
      return { turn: expectedTurn, message: data.message };
    } catch {
      return null;
    }
  }
  return null;
}

function watchCmd(pid, bridgeDir, nextTurn) {
  const targetFile = join(bridgeDir, `question_${nextTurn}.json`);
  return (
    `PID=${pid}; TIMEOUT=300; START=$(date +%s); while true; do ` +
    `[ -f ${targetFile} ] && cat ${targetFile} && break; ` +
    `kill -0 $PID 2>/dev/null || { echo "ERROR: Cursor agent (PID $PID) is not running. It may have crashed or exited."; exit 1; }; ` +
    `[ $(( $(date +%s) - START )) -gt $TIMEOUT ] && { echo "ERROR: Timeout waiting for agent response ($TIMEOUT s)"; exit 1; }; ` +
    `sleep 2; done`
  );
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const BRIDGE_PREAMBLE = [
  "ORCHESTRATION MODE: You are a subagent. Communicate ONLY via report_to_orchestrator (orchestrator-bridge MCP).",
  "",
  "CRITICAL: Call report_to_orchestrator FREQUENTLY — after every 1-2 steps, not at the end.",
  "Do NOT read all files and then report at the end. Report incrementally as you go.",
  "Waiting too long before calling back will cause a timeout and lose all your work.",
  "",
  "After each meaningful step → report_to_orchestrator(what you found + what you want to do next)",
  "Wait for reply → continue → repeat.",
  "",
  'Stop only when: task done + results reported, OR explicit "stop"/"done", OR fatal error (report first).',
  "",
].join("\n");

const server = new McpServer(
  { name: "cursor-agent-orchestrator", version: "1.0.0" },
  {
    instructions: [
      "Tools for spawning and communicating with background cursor-agent subagents.",
      "Each spawn creates an isolated session with a unique session_id.",
      "Multiple agents can run simultaneously — always pass session_id when working with a specific agent.",
      "After spawn or reply, run the returned watcher command in background (Bash run_in_background: true).",
      "When the watcher completes, the agent has a message — read it and reply.",
      "CRITICAL: After starting the background watcher, end your turn. Do NOT call TaskOutput to wait — that blocks the session.",
      "Do NOT poll cursor_agent_check in a loop.",
    ].join(" "),
  },
);

// ── spawn ────────────────────────────────────────────────────────────────────

server.tool(
  "cursor_agent_spawn",
  "Spawn a background cursor-agent process in an isolated session. Returns a session_id — pass it to all subsequent tool calls for this agent. After spawning, run the returned watcher command with Bash(run_in_background: true), then END YOUR TURN. Do NOT call TaskOutput to wait.",
  {
    task: z.string().min(1, "task description is required"),
    model: z.string().default("composer-2"),
    cwd: z.string().optional(),
    output_file: z
      .string()
      .optional()
      .describe("File path for agent to write detailed results to"),
    session_id: z
      .string()
      .optional()
      .describe("Custom session ID (auto-generated if omitted)"),
  },
  async ({ task, model, cwd, output_file, session_id }) => {
    const sid = session_id || randomUUID();
    const dir = sessionDir(sid);
    mkdirSync(dir, { recursive: true });

    // Snapshot existing bridge dirs BEFORE spawning
    const bridgeDirsBefore = listBridgeDirs();

    // Disable competing communication MCPs so the agent uses only orchestrator-bridge
    const COMPETING_MCPS = ["interactive-feedback-mcp"];
    for (const mcp of COMPETING_MCPS) {
      try {
        execSync(`cursor-agent mcp disable ${mcp}`, {
          timeout: 5000,
          stdio: "ignore",
        });
      } catch {}
    }

    let prompt = BRIDGE_PREAMBLE + "\nTASK: " + task;
    if (output_file) {
      prompt += `\n\nWrite detailed results to: ${output_file}`;
    }

    const child = spawn(
      "cursor-agent",
      [
        "--print",
        "--yolo",
        "--model",
        model,
        "--output-format",
        "text",
        prompt,
      ],
      {
        cwd: cwd || process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      },
    );

    child.stdin.end();
    child.unref();

    const outStream = createWriteStream(join(dir, ".agent-stdout.txt"));
    const errStream = createWriteStream(join(dir, ".agent-stderr.txt"));
    child.stdout.pipe(outStream);
    child.stderr.pipe(errStream);

    // Re-enable competing MCPs after agent exits
    child.on("exit", () => {
      for (const mcp of COMPETING_MCPS) {
        try {
          execSync(`cursor-agent mcp enable ${mcp}`, {
            timeout: 5000,
            stdio: "ignore",
          });
        } catch {}
      }
    });

    const state = {
      pid: child.pid,
      answeredCount: 0,
      nextTurn: 1,
      startedAt: Date.now(),
      bridgeDir: null,
    };
    saveState(sid, state);
    setActiveSessionId(sid);

    // Wait briefly and verify the agent process is alive
    await new Promise((r) => setTimeout(r, 3000));
    if (!isRunning(child.pid)) {
      const stderrPath = join(dir, ".agent-stderr.txt");
      const stderr = existsSync(stderrPath)
        ? readFileSync(stderrPath, "utf8").trim().slice(-500)
        : "";
      return {
        content: [
          {
            type: "text",
            text: `ERROR: Agent failed to start (session: ${sid}, PID: ${child.pid}).${stderr ? "\nStderr: " + stderr : ""}`,
          },
        ],
        isError: true,
      };
    }

    // Discover the bridge's IPC directory (bridge-{pid}/ created by bridge MCP)
    const bridgeDir = findNewBridgeDir(bridgeDirsBefore);
    if (!bridgeDir) {
      return {
        content: [
          {
            type: "text",
            text: `Agent spawned (PID: ${child.pid}) but bridge MCP did not create its directory.\nsession_id: ${sid}\nCheck that orchestrator-bridge is enabled: cursor-agent mcp enable orchestrator-bridge`,
          },
        ],
        isError: true,
      };
    }

    state.bridgeDir = bridgeDir;
    saveState(sid, state);

    const cmd = watchCmd(child.pid, bridgeDir, 1);
    return {
      content: [
        {
          type: "text",
          text: `Agent spawned and verified running.\nsession_id: ${sid}\nPID: ${child.pid} | model: ${model} | bridge: ${bridgeDir}\n\nRun this in background to get notified when the agent responds:\nBash(run_in_background: true): ${cmd}`,
        },
      ],
    };
  },
);

// ── check ────────────────────────────────────────────────────────────────────

server.tool(
  "cursor_agent_check",
  'Check if cursor-agent has a pending question. Returns the message or "no pending question". Call at most ONCE — if still working, do other tasks before checking again.',
  {
    session_id: z
      .string()
      .optional()
      .describe(
        "Session ID from cursor_agent_spawn (uses most recent if omitted)",
      ),
  },
  async ({ session_id }) => {
    const sid = resolveSessionId(session_id);
    if (!sid)
      return {
        content: [
          {
            type: "text",
            text: "No active session. Use cursor_agent_spawn first.",
          },
        ],
      };

    const state = loadState(sid);
    const q = findPendingQuestion(state.bridgeDir, state.nextTurn || 1);
    if (q) {
      return {
        content: [
          {
            type: "text",
            text: `[Session ${sid}] [Turn ${q.turn}] Agent says: ${q.message}`,
          },
        ],
      };
    }
    const running = state.pid ? isRunning(state.pid) : false;
    return {
      content: [
        {
          type: "text",
          text: `[Session ${sid}] ${running ? "No pending question. Agent is still working." : "No pending question. Agent has finished."}`,
        },
      ],
    };
  },
);

// ── reply ────────────────────────────────────────────────────────────────────

server.tool(
  "cursor_agent_reply",
  "Reply to cursor-agent's pending question. After replying, run the returned watcher command with Bash(run_in_background: true), then END YOUR TURN.",
  {
    message: z.string().min(1, "reply message is required"),
    session_id: z
      .string()
      .optional()
      .describe(
        "Session ID from cursor_agent_spawn (uses most recent if omitted)",
      ),
  },
  async ({ message, session_id }) => {
    const sid = resolveSessionId(session_id);
    if (!sid)
      return {
        content: [
          {
            type: "text",
            text: "No active session. Use cursor_agent_spawn first.",
          },
        ],
        isError: true,
      };

    const state = loadState(sid);
    const q = findPendingQuestion(state.bridgeDir, state.nextTurn || 1);
    if (!q) {
      return {
        content: [
          {
            type: "text",
            text: `[Session ${sid}] No pending question to reply to.`,
          },
        ],
        isError: true,
      };
    }
    const answerFile = join(state.bridgeDir, `answer_${q.turn}.json`);
    const replyWithReminder =
      message + "\n\n[When done, call report_to_orchestrator.]";
    writeFileSync(
      answerFile,
      JSON.stringify({ reply: replyWithReminder, timestamp: Date.now() }),
      "utf8",
    );

    state.answeredCount = (state.answeredCount || 0) + 1;
    state.nextTurn = q.turn + 1;
    saveState(sid, state);

    const cmd = watchCmd(state.pid, state.bridgeDir, state.nextTurn);
    return {
      content: [
        {
          type: "text",
          text: `[Session ${sid}] Reply sent (turn ${q.turn}, total: ${state.answeredCount}).\n\nRun this in background to get notified when the agent responds next:\nBash(run_in_background: true): ${cmd}`,
        },
      ],
    };
  },
);

// ── status ───────────────────────────────────────────────────────────────────

server.tool(
  "cursor_agent_status",
  "Get current agent status: working, waiting_for_reply, or completed.",
  {
    session_id: z
      .string()
      .optional()
      .describe(
        "Session ID from cursor_agent_spawn (uses most recent if omitted)",
      ),
  },
  async ({ session_id }) => {
    const sid = resolveSessionId(session_id);
    if (!sid)
      return { content: [{ type: "text", text: "No active session." }] };

    const state = loadState(sid);
    const running = state.pid ? isRunning(state.pid) : false;
    const q = findPendingQuestion(state.bridgeDir, state.nextTurn || 1);
    const answered = state.answeredCount || 0;
    const elapsed = state.startedAt
      ? Math.round((Date.now() - state.startedAt) / 1000)
      : 0;

    let status;
    if (running && q) status = "waiting_for_reply";
    else if (running) status = "working";
    else status = "completed";

    return {
      content: [
        {
          type: "text",
          text:
            `[Session ${sid}]\nStatus: ${status} | Answered: ${answered} | Elapsed: ${elapsed}s` +
            (q ? `\nPending: ${q.message}` : ""),
        },
      ],
    };
  },
);

// ── result (full diagnostic) ─────────────────────────────────────────────────

server.tool(
  "cursor_agent_result",
  "Get full diagnostic for an agent: stdout, stderr, state, and bridge dir contents. Use this to understand why an agent died or what it produced.",
  {
    session_id: z
      .string()
      .optional()
      .describe(
        "Session ID from cursor_agent_spawn (uses most recent if omitted)",
      ),
  },
  async ({ session_id }) => {
    const sid = resolveSessionId(session_id);
    if (!sid)
      return { content: [{ type: "text", text: "No active session." }] };

    const dir = sessionDir(sid);
    const state = loadState(sid);
    const running = state.pid ? isRunning(state.pid) : false;
    const elapsed = state.startedAt
      ? Math.round((Date.now() - state.startedAt) / 1000)
      : 0;

    const sections = [];

    // Status summary
    sections.push(`=== Session ${sid} ===`);
    sections.push(
      `PID: ${state.pid || "n/a"} | Running: ${running} | Elapsed: ${elapsed}s | Answered: ${state.answeredCount || 0}`,
    );
    if (state.bridgeDir) sections.push(`Bridge dir: ${state.bridgeDir}`);

    // Stderr (most useful for diagnosing crashes)
    const errFile = join(dir, ".agent-stderr.txt");
    if (existsSync(errFile)) {
      const stderr = readFileSync(errFile, "utf8").trim();
      sections.push(`\n=== STDERR (last 2000 chars) ===`);
      sections.push(stderr ? stderr.slice(-2000) : "(empty)");
    }

    // Stdout (last 2000 chars)
    const outFile = join(dir, ".agent-stdout.txt");
    if (existsSync(outFile)) {
      const stdout = readFileSync(outFile, "utf8").trim();
      sections.push(`\n=== STDOUT (last 2000 chars) ===`);
      sections.push(stdout ? stdout.slice(-2000) : "(empty)");
    }

    // Bridge dir contents (shows IPC state)
    if (state.bridgeDir && existsSync(state.bridgeDir)) {
      const files = readdirSync(state.bridgeDir).sort();
      sections.push(`\n=== Bridge dir files ===`);
      sections.push(files.length ? files.join(", ") : "(empty)");
    } else {
      sections.push(`\n=== Bridge dir ===`);
      sections.push("Not found (bridge may not have started)");
    }

    return { content: [{ type: "text", text: sections.join("\n") }] };
  },
);

// ── kill ─────────────────────────────────────────────────────────────────────

server.tool(
  "cursor_agent_kill",
  "Force-terminate the running cursor-agent process.",
  {
    session_id: z
      .string()
      .optional()
      .describe(
        "Session ID from cursor_agent_spawn (uses most recent if omitted)",
      ),
  },
  async ({ session_id }) => {
    const sid = resolveSessionId(session_id);
    if (!sid)
      return { content: [{ type: "text", text: "No active session." }] };

    const state = loadState(sid);
    if (!state.pid) {
      return {
        content: [{ type: "text", text: `[Session ${sid}] No agent to kill.` }],
      };
    }
    try {
      process.kill(state.pid, "SIGTERM");
      return {
        content: [
          {
            type: "text",
            text: `[Session ${sid}] Killed agent (PID ${state.pid}).`,
          },
        ],
      };
    } catch {
      return {
        content: [
          {
            type: "text",
            text: `[Session ${sid}] Agent (PID ${state.pid}) already stopped.`,
          },
        ],
      };
    }
  },
);

// ── Connect ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport).catch((e) => {
  console.error("Orchestrator MCP failed to start:", e);
  process.exit(1);
});
