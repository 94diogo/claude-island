#!/usr/bin/env node
// Manda um PermissionRequest e imprime a resposta que o Claude Code receberia.
// Uso: node test/permission.js
const { spawn } = require('child_process');
const path = require('path');

const p = spawn(process.execPath, [path.join(__dirname, '..', 'hook', 'island-hook.js')]);
let out = '';
p.stdout.on('data', c => (out += c));
p.on('close', () => console.log('Resposta do hook:', out || '(nenhuma)'));
p.stdin.end(JSON.stringify({
  session_id: 'perm-test',
  cwd: 'C:\\Claude\\claude-island',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'echo oi' },
}));
