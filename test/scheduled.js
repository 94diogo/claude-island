#!/usr/bin/env node
// Simula uma tarefa agendada do app Claude: início, uma ferramenta e o fim.
// Uso: node test/scheduled.js [nome-da-tarefa] [fail]
const { spawnSync } = require('child_process');
const path = require('path');

const hook = path.join(__dirname, '..', 'hook', 'island-hook.js');
const task = process.argv[2] || 'ata-aplica-auto';
const fail = process.argv[3] === 'fail';
const send = evt => spawnSync(process.execPath, [hook], {
  input: JSON.stringify({ session_id: `sched-${task}`, cwd: 'C:\\Claude', ...evt }),
});
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  send({
    hook_event_name: 'UserPromptSubmit',
    prompt: `<scheduled-task name="${task}" file="C:\\x\\SKILL.md">\nThis is an automated run of a scheduled task.`,
  });
  await wait(4500);
  send({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'C:\\x\\SKILL.md' } });
  await wait(2000);
  send({ hook_event_name: 'PostToolUse', tool_name: 'Read' });
  send({ hook_event_name: fail ? 'StopFailure' : 'Stop' });
})();
