#!/usr/bin/env node
// Hook do Claude Code para a Claude Island.
// Lê o JSON do evento no stdin e manda para a ilha (127.0.0.1:47821).
// Em PermissionRequest espera a resposta da ilha e a imprime no stdout.
// Se a ilha não estiver aberta, sai calado: o Claude Code segue normal.
const http = require('http');

const PORT = 47821;

// Título que o app Claude mostra para a tarefa (displayName). O app guarda um
// scheduled-tasks.json por conta em %LOCALAPPDATA%\Claude-Data\<pacote>\claude-code-sessions\<conta>\<org>\.
// Lê do mais recente para o mais antigo; qualquer erro devolve null.
function taskTitle(id) {
  try {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(process.env.LOCALAPPDATA || '', 'Claude-Data');
    const files = [];
    for (const pkg of fs.readdirSync(root)) {
      const sessions = path.join(root, pkg, 'claude-code-sessions');
      if (!fs.existsSync(sessions)) continue;
      for (const acc of fs.readdirSync(sessions)) {
        const accDir = path.join(sessions, acc);
        if (!fs.statSync(accDir).isDirectory()) continue;
        for (const org of fs.readdirSync(accDir)) {
          const f = path.join(accDir, org, 'scheduled-tasks.json');
          if (fs.existsSync(f)) files.push({ f, t: fs.statSync(f).mtimeMs });
        }
      }
    }
    files.sort((a, b) => b.t - a.t);
    for (const { f } of files) {
      const tasks = JSON.parse(fs.readFileSync(f, 'utf8')).scheduledTasks || [];
      const hit = tasks.find(t => t.id === id && t.displayName);
      if (hit) return hit.displayName;
    }
  } catch {}
  return null;
}
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => {
  let evt = {};
  try { evt = JSON.parse(raw); } catch { process.exit(0); }
  const waits = evt.hook_event_name === 'PermissionRequest';

  // Tarefa agendada do app Claude: o prompt começa com <scheduled-task name="...">.
  // O texto do prompt não vai para a ilha, só o nome da tarefa.
  if (typeof evt.prompt === 'string') {
    const m = evt.prompt.match(/^\s*<scheduled-task name="([^"]+)"/);
    if (m) {
      const id = m[1];
      const words = id.replace(/[-_]+/g, ' ').trim();
      evt.scheduled_task = { id, title: taskTitle(id) || words.charAt(0).toUpperCase() + words.slice(1) };
    }
    delete evt.prompt;
  }
  raw = JSON.stringify(evt);

  const req = http.request(
    { host: '127.0.0.1', port: PORT, path: '/event', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) },
      timeout: waits ? 35000 : 800 },
    res => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', c => (out += c));
      res.on('end', () => {
        if (res.statusCode === 200 && out) process.stdout.write(out);
        process.exit(0);
      });
    });
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.on('error', () => process.exit(0));
  req.end(raw);
});
