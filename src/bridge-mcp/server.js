/**
 * Bridge MCP Server — file-based blocking IPC for orchestrator communication.
 *
 * Exposes a single tool `report_to_orchestrator` that cursor-agent calls
 * when it needs to communicate with the orchestrating agent (e.g. Claude Code).
 *
 * Flow:
 *   1. cursor-agent calls report_to_orchestrator(message)
 *   2. This server writes the message to a question file
 *   3. It polls for an answer file (blocks until one appears)
 *   4. Returns the answer to cursor-agent
 *
 * The orchestrator watches for question files and writes answer files.
 *
 * Progress heartbeats:
 *   The polling loop sends MCP progress notifications every 30 seconds.
 *   If cursor-agent's MCP client supports resetTimeoutOnProgress, this
 *   prevents the 60-second DEFAULT_REQUEST_TIMEOUT_MSEC from firing.
 *
 * Session isolation:
 *   Each bridge process creates its own subdirectory: {SESSION_DIR}/bridge-{pid}/
 *   This prevents file collisions when multiple agents run simultaneously.
 *
 * Env:
 *   BRIDGE_SESSION_DIR — base directory for IPC (default: /tmp/cursor-bridge-session)
 *   BRIDGE_POLL_MS     — poll interval in ms (default: 500)
 *   BRIDGE_TIMEOUT_MS  — max wait time in ms (default: 300000 = 5 min)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SESSION_DIR = process.env.BRIDGE_SESSION_DIR || '/tmp/cursor-bridge-session';
const BRIDGE_DIR = join(SESSION_DIR, `bridge-${process.pid}`);
mkdirSync(BRIDGE_DIR, { recursive: true });

const POLL_MS = parseInt(process.env.BRIDGE_POLL_MS || '500', 10);
const TIMEOUT_MS = parseInt(process.env.BRIDGE_TIMEOUT_MS || '300000', 10);
const HEARTBEAT_MS = 30_000; // Send progress notification every 30s

let turnCounter = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg) {
  console.error(`[bridge ${process.pid}] ${msg}`);
}

const server = new McpServer(
  { name: 'orchestrator-bridge', version: '1.0.0' },
  {
    instructions: [
      'This MCP provides a single tool: report_to_orchestrator.',
      'Use it to send messages to the orchestrating agent and receive replies.',
      'Call it whenever you need to:',
      '- Ask a clarifying question',
      '- Report progress or intermediate results',
      '- Request feedback on your work',
      '- Deliver your final result',
      'The orchestrator will reply through this same channel.',
      'Always wait for the orchestrator reply before continuing.',
    ].join(' '),
  }
);

server.tool(
  'report_to_orchestrator',
  'Send a message to the orchestrating agent and wait for their reply. Use this for questions, progress updates, intermediate results, or final deliverables.',
  { message: z.string().min(1, 'message is required') },
  async ({ message }, { sendNotification, _meta }) => {
    turnCounter++;
    const turn = turnCounter;
    const startTime = Date.now();

    const hasProgressToken = !!(_meta?.progressToken);
    log(`turn ${turn} started | progressToken: ${hasProgressToken} | msg length: ${message.length}`);

    const questionFile = join(BRIDGE_DIR, `question_${turn}.json`);
    const answerFile = join(BRIDGE_DIR, `answer_${turn}.json`);

    // Write question
    writeFileSync(questionFile, JSON.stringify({ turn, message, timestamp: Date.now() }), 'utf8');
    log(`turn ${turn} question written`);

    // Poll for answer with progress heartbeats
    const deadline = Date.now() + TIMEOUT_MS;
    let heartbeatCount = 0;
    let lastHeartbeat = Date.now();

    while (Date.now() < deadline) {
      if (existsSync(answerFile)) {
        try {
          const data = JSON.parse(readFileSync(answerFile, 'utf8'));
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          log(`turn ${turn} answer received after ${elapsed}s`);
          // Clean up
          try { unlinkSync(questionFile); } catch {}
          try { unlinkSync(answerFile); } catch {}
          return { content: [{ type: 'text', text: data.reply || '(empty reply)' }] };
        } catch {
          // File not fully written yet, retry
        }
      }

      // Send progress heartbeat every 30s to reset client's MCP timeout
      if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
        heartbeatCount++;
        try {
          await sendNotification({
            method: "notifications/progress",
            params: {
              progressToken: _meta?.progressToken ?? 0,
              progress: heartbeatCount,
              total: Math.ceil(TIMEOUT_MS / HEARTBEAT_MS),
              message: `Waiting for orchestrator reply... (${heartbeatCount * 30}s)`,
            }
          });
          log(`turn ${turn} heartbeat ${heartbeatCount} sent`);
        } catch (e) {
          log(`turn ${turn} heartbeat ${heartbeatCount} failed: ${e.message}`);
        }
        lastHeartbeat = Date.now();
      }

      await sleep(POLL_MS);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`turn ${turn} TIMEOUT after ${elapsed}s`);
    return {
      content: [{ type: 'text', text: `Orchestrator did not reply within ${TIMEOUT_MS}ms.` }],
      isError: true,
    };
  }
);

const transport = new StdioServerTransport();
server.connect(transport).catch((e) => {
  console.error('Bridge MCP failed to start:', e);
  process.exit(1);
});
