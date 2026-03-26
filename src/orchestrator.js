#!/usr/bin/env node
/**
 * Orchestrator CLI — clean abstraction for bridge MCP communication.
 *
 * Usage:
 *   node orchestrator.js spawn "prompt" [--model M] [--cwd DIR]
 *   node orchestrator.js check
 *   node orchestrator.js reply "answer text"
 *   node orchestrator.js status
 *   node orchestrator.js result
 *   node orchestrator.js kill
 *   node orchestrator.js auto-reply "template"   # auto-answer with template
 */

import { spawn as spawnProc } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  unlinkSync,
  createWriteStream,
} from "node:fs";
import { join } from "node:path";

const SESSION_DIR =
  process.env.BRIDGE_SESSION_DIR || "/tmp/cursor-bridge-session";
const STATE_FILE = join(SESSION_DIR, ".orchestrator-state.json");

mkdirSync(SESSION_DIR, { recursive: true });

// ── State persistence ────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { pid: null, taskId: null, answeredCount: 0, startedAt: null };
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// ── File IPC helpers ─────────────────────────────────────────────────────────

function findPendingQuestion() {
  const files = readdirSync(SESSION_DIR)
    .filter((f) => f.startsWith("question_") && f.endsWith(".json"))
    .sort();

  for (const file of files) {
    const turnNum = parseInt(file.match(/question_(\d+)\.json/)?.[1], 10);
    if (!turnNum) continue;

    const answerFile = join(SESSION_DIR, `answer_${turnNum}.json`);
    if (existsSync(answerFile)) continue;

    try {
      const data = JSON.parse(readFileSync(join(SESSION_DIR, file), "utf8"));
      return { turn: turnNum, message: data.message, file };
    } catch {
      continue;
    }
  }
  return null;
}

function writeAnswer(turnNum, reply) {
  const answerFile = join(SESSION_DIR, `answer_${turnNum}.json`);
  writeFileSync(
    answerFile,
    JSON.stringify({ reply, timestamp: Date.now() }),
    "utf8",
  );
}

function countAnswered() {
  return readdirSync(SESSION_DIR).filter(
    (f) => f.startsWith("answer_") && f.endsWith(".json"),
  ).length;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

const cmd = process.argv[2];

if (cmd === "spawn") {
  const prompt = process.argv[3];
  if (!prompt) {
    console.error('Usage: spawn "prompt" [--model M] [--cwd DIR]');
    process.exit(1);
  }

  const modelIdx = process.argv.indexOf("--model");
  const model = modelIdx >= 0 ? process.argv[modelIdx + 1] : "composer-2";
  const cwdIdx = process.argv.indexOf("--cwd");
  const cwd = cwdIdx >= 0 ? process.argv[cwdIdx + 1] : process.cwd();

  // Clean old session files
  for (const f of readdirSync(SESSION_DIR)) {
    if (f.startsWith("question_") || f.startsWith("answer_")) {
      try {
        unlinkSync(join(SESSION_DIR, f));
      } catch {}
    }
  }

  const child = spawnProc(
    "cursor-agent",
    ["--print", "--yolo", "--model", model, "--output-format", "text", prompt],
    {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    },
  );

  child.stdin.end();
  child.unref();

  // Save stdout/stderr to files for later retrieval
  const outFile = join(SESSION_DIR, ".agent-stdout.txt");
  const errFile = join(SESSION_DIR, ".agent-stderr.txt");
  const outStream = createWriteStream(outFile);
  const errStream = createWriteStream(errFile);
  child.stdout.pipe(outStream);
  child.stderr.pipe(errStream);

  const state = { pid: child.pid, answeredCount: 0, startedAt: Date.now() };
  saveState(state);

  console.log(
    JSON.stringify({
      status: "spawned",
      pid: child.pid,
      model,
      session_dir: SESSION_DIR,
    }),
  );
} else if (cmd === "check") {
  const q = findPendingQuestion();
  if (q) {
    console.log(
      JSON.stringify({ pending: true, turn: q.turn, message: q.message }),
    );
  } else {
    console.log(JSON.stringify({ pending: false }));
  }
} else if (cmd === "reply") {
  const reply = process.argv[3];
  if (!reply) {
    console.error('Usage: reply "answer text"');
    process.exit(1);
  }

  const q = findPendingQuestion();
  if (!q) {
    console.log(JSON.stringify({ error: "no pending question" }));
    process.exit(1);
  }

  writeAnswer(q.turn, reply);
  const state = loadState();
  state.answeredCount = countAnswered();
  saveState(state);

  console.log(
    JSON.stringify({ answered: q.turn, total_answered: state.answeredCount }),
  );
} else if (cmd === "status") {
  const state = loadState();
  const running = state.pid ? isProcessRunning(state.pid) : false;
  const q = findPendingQuestion();
  const answered = countAnswered();
  const elapsed = state.startedAt
    ? Math.round((Date.now() - state.startedAt) / 1000)
    : 0;

  let agentStatus;
  if (running && q) agentStatus = "waiting_for_reply";
  else if (running) agentStatus = "working";
  else agentStatus = "completed";

  console.log(
    JSON.stringify({
      agent: agentStatus,
      pid: state.pid,
      running,
      questions_answered: answered,
      pending_question: q ? q.message : null,
      elapsed_seconds: elapsed,
    }),
  );
} else if (cmd === "result") {
  const outFile = join(SESSION_DIR, ".agent-stdout.txt");
  if (existsSync(outFile)) {
    const content = readFileSync(outFile, "utf8").trim();
    console.log(content || "(no output yet)");
  } else {
    console.log("(no output file — agent may not have been spawned)");
  }
} else if (cmd === "kill") {
  const state = loadState();
  if (state.pid) {
    try {
      process.kill(state.pid, "SIGTERM");
      console.log(JSON.stringify({ killed: state.pid }));
    } catch {
      console.log(
        JSON.stringify({ error: "process not found", pid: state.pid }),
      );
    }
  } else {
    console.log(JSON.stringify({ error: "no agent running" }));
  }
} else {
  console.log(
    `Usage: node orchestrator.js <spawn|check|reply|status|result|kill>`,
  );
  process.exit(1);
}
