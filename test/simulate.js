#!/usr/bin/env node
// Simula uma sessão do Claude Code mandando eventos pelo mesmo hook que o Claude Code usa.
// Uso: node test/simulate.js   (a Claude Island precisa estar aberta)
const { spawn } = require('child_process');
const path = require('path');

const hook = path.join(__dirname, '..', 'hook', 'island-hook.js');
const cwd = 'C:\\Claude\\claude-island';
const wait = ms => new Promise(r => setTimeout(r, ms));

function send(evt) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [hook]);
    let out = '';
    p.stdout.on('data', c => (out += c));
    p.on('close', () => resolve(out));
    p.stdin.end(JSON.stringify({ session_id: 'sim', cwd, ...evt }));
  });
}

(async () => {
  await send({ hook_event_name: 'UserPromptSubmit' });
  await wait(1200);
  for (const [tool_name, tool_input] of [
    ['Read', { file_path: `${cwd}\\ui\\island.js` }],
    ['Grep', { pattern: 'setState' }],
    ['Edit', { file_path: `${cwd}\\ui\\island.css` }],
  ]) {
    await send({ hook_event_name: 'PreToolUse', tool_name, tool_input });
    await wait(1500);
    await send({ hook_event_name: 'PostToolUse', tool_name });
  }
  const tool_input = { command: 'npm install --save-dev vitest' };
  await send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input });
  console.log('Pedindo permissão: clique em Permitir ou Negar na ilha (30 s)...');
  const answer = await send({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input });
  console.log('Resposta do hook:', answer || '(nenhuma: tempo esgotado, o Claude Code mostraria o pedido normal)');
  await wait(1500);
  await send({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  await send({ hook_event_name: 'Stop' });
})();
