#!/usr/bin/env node
/**
 * 5-turn test: ONE cursor-agent process, bidirectional via bridge MCP.
 *
 * Prerequisites:
 *   - orchestrator-bridge MCP enabled: `cursor-agent mcp enable orchestrator-bridge`
 *   - BRIDGE_SESSION_DIR set to /tmp/cursor-bridge-session in mcp.json
 *
 * This script does NOT modify ~/.cursor/mcp.json.
 * It only reads/writes files in the fixed session dir.
 */

import { spawn } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

// ── Config ───────────────────────────────────────────────────────────────────

const SESSION_DIR = "/tmp/cursor-bridge-session";
const MODEL = process.env.CURSOR_AGENT_MODEL || "composer-2";

// Clean session dir
mkdirSync(SESSION_DIR, { recursive: true });
try {
  for (const f of readdirSync(SESSION_DIR)) unlinkSync(join(SESSION_DIR, f));
} catch {}

const log = (tag, msg) =>
  console.log(`[${new Date().toISOString().slice(11, 23)}] [${tag}] ${msg}`);

// ── Pre-scripted orchestrator replies ────────────────────────────────────────

const REPLIES = [
  "Write a JavaScript class called `TaskQueue` that manages async tasks with a concurrency limit. Ask me about the API design.",
  "API: constructor(concurrency:number), add(asyncFn):Promise, waitAll():Promise. Show me a draft and ask for feedback.",
  "Good. Add: 1) onTaskComplete callback option in constructor, 2) pause() and resume() methods. Show updated code and ask if I want tests.",
  "Yes, write 3 tests: concurrency limiting, pause/resume, onTaskComplete callback. Show them and ask if anything else is needed.",
  "Everything looks great. No more changes needed. You are done, stop working.",
];

// ── Orchestrator: poll for questions, provide answers ─────────────────────────

let turnCount = 0;
const answeredTurns = new Set();

function checkForQuestions() {
  try {
    const files = readdirSync(SESSION_DIR)
      .filter((f) => f.startsWith("question_") && f.endsWith(".json"))
      .sort();

    for (const file of files) {
      const turnNum = parseInt(file.match(/question_(\d+)\.json/)?.[1], 10);
      if (!turnNum || answeredTurns.has(turnNum)) continue;

      const answerFile = join(SESSION_DIR, `answer_${turnNum}.json`);
      if (existsSync(answerFile)) continue;

      try {
        const question = JSON.parse(
          readFileSync(join(SESSION_DIR, file), "utf8"),
        );
        turnCount++;
        answeredTurns.add(turnNum);

        const preview = question.message.replace(/\n/g, "\\n").slice(0, 150);
        log(`TURN${turnCount}←`, preview);

        const reply = REPLIES[turnCount - 1] || "Done. Stop working.";
        log(`TURN${turnCount}→`, reply.slice(0, 120));

        writeFileSync(
          answerFile,
          JSON.stringify({ reply, timestamp: Date.now() }),
          "utf8",
        );
      } catch {}
    }
  } catch {}
}

const pollInterval = setInterval(checkForQuestions, 300);

// ── Spawn ONE cursor-agent ───────────────────────────────────────────────────

const TASK_PROMPT = [
  'You have access to a tool called "report_to_orchestrator" from the "orchestrator-bridge" MCP server.',
  "",
  "RULES:",
  "1. Use report_to_orchestrator for ALL communication with me.",
  "2. Call it, read my reply, do work, call it again. Loop until I say stop.",
  "3. Do NOT produce final output without going through the tool first.",
  "",
  "Start NOW: call report_to_orchestrator to ask me what I want you to build.",
].join("\n");

log("INIT", `Model: ${MODEL} | Session dir: ${SESSION_DIR}`);
log("INIT", "Spawning ONE cursor-agent process...\n");

const child = spawn(
  "cursor-agent",
  [
    "--print",
    "--yolo",
    "--model",
    MODEL,
    "--output-format",
    "text",
    TASK_PROMPT,
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  },
);

try {
  child.stdin.end();
} catch {}

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => {
  stdout += d.toString();
});
child.stderr.on("data", (d) => {
  stderr += d.toString();
});

const exitCode = await new Promise((resolve) => {
  child.on("close", (code) => resolve(code));
  setTimeout(() => {
    log("TIMEOUT", "5 min timeout, killing");
    try {
      child.kill("SIGKILL");
    } catch {}
    resolve(-1);
  }, 300_000);
});

clearInterval(pollInterval);

// ── Summary ──────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(60));
log("DONE", `Exit code: ${exitCode} | Turns: ${turnCount}`);

if (stdout.trim()) {
  console.log("\n── Agent output ──");
  console.log(stdout.trim().slice(0, 2000));
  if (stdout.trim().length > 2000) console.log("  ...(truncated)");
}

console.log("\n" + "═".repeat(60));
const pass = turnCount >= 3;
console.log(
  pass
    ? `✓ PASS — ${turnCount} turns in 1 cursor-agent process via MCP`
    : `✗ FAIL — only ${turnCount} turns (agent may not have called the tool)`,
);

process.exit(pass ? 0 : 1);
