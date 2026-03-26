#!/usr/bin/env node
// PostToolUse hook for cursor-agent orchestrator.
// Scans bridge session dir for pending questions, then injects reminders
// as additionalContext so Claude Code doesn't forget to reply.
//
// Install in Claude Code settings (~/.claude/settings.json):
// {
//   "hooks": {
//     "PostToolUse": [{
//       "command": "node /absolute/path/to/src/hooks/post-tool-use.js",
//       "timeout": 5000
//     }]
//   }
// }

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let input;
try {
  input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
} catch {
  process.exit(0);
}

const lines = [];

// Scan bridge-{pid} subdirs for pending (unanswered) question files
const bridgeBaseDir = process.env.BRIDGE_SESSION_DIR || '/tmp/cursor-bridge-session';
try {
  if (existsSync(bridgeBaseDir)) {
    const entries = readdirSync(bridgeBaseDir, { withFileTypes: true });
    const bridgeDirs = entries.filter(e => e.isDirectory() && e.name.startsWith('bridge-'));
    for (const entry of bridgeDirs) {
      const bridgePath = join(bridgeBaseDir, entry.name);
      try {
        const files = readdirSync(bridgePath);
        const questionFiles = files.filter(f => f.startsWith('question_') && f.endsWith('.json')).sort();
        for (const qFile of questionFiles) {
          const turnNum = parseInt(qFile.match(/question_(\d+)\.json/)?.[1], 10);
          if (!turnNum) continue;
          if (files.includes(`answer_${turnNum}.json`)) continue;
          try {
            const data = JSON.parse(readFileSync(join(bridgePath, qFile), 'utf8'));
            lines.push(`[Cursor-Agent Awaiting Reply]`);
            lines.push(`Bridge: ${entry.name} | Turn ${turnNum}: ${data.message.slice(0, 200)}`);
            lines.push(`Reply via cursor_agent_reply.`);
            lines.push('');
          } catch {}
        }
      } catch {}
    }
  }
} catch {}

if (lines.length === 0) {
  process.exit(0);
}

const response = {
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: lines.join('\n'),
  },
};

process.stdout.write(JSON.stringify(response));
process.exit(0);
