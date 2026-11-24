#!/usr/bin/env node
// Liga (ou desliga, com --uninstall) os hooks da Claude Island em ~/.claude/settings.json.
// Faz backup antes de gravar e não mexe nos outros hooks.
const fs = require('fs');
const os = require('os');
const path = require('path');

const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
// O hook é copiado para ~/.claude/hooks: assim os hooks não quebram se a pasta do projeto mudar de lugar.
const hookSrc = path.join(__dirname, 'hook', 'island-hook.js');
const hookDest = path.join(os.homedir(), '.claude', 'hooks', 'island-hook.js');
const hookFile = hookDest.replace(/\\/g, '/');
const command = `node "${hookFile}"`;
const MARK = 'island-hook.js';

const EVENTS = {
  SessionStart: {},
  UserPromptSubmit: {},
  PreToolUse: { matcher: '*' },
  PostToolUse: { matcher: '*' },
  PostToolUseFailure: { matcher: '*' },
  PermissionRequest: { matcher: '*', timeout: 40 },
  Notification: {},
  Stop: {},
  StopFailure: {},
  SessionEnd: {},
};

const uninstall = process.argv.includes('--uninstall');
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
fs.writeFileSync(`${settingsPath}.bak-claude-island`, JSON.stringify(settings, null, 2));

settings.hooks = settings.hooks || {};
for (const ev of Object.keys(settings.hooks)) {
  settings.hooks[ev] = settings.hooks[ev]
    .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !String(h.command || '').includes(MARK)) }))
    .filter(g => g.hooks.length);
  if (!settings.hooks[ev].length) delete settings.hooks[ev];
}

if (!uninstall) {
  fs.mkdirSync(path.dirname(hookDest), { recursive: true });
  fs.copyFileSync(hookSrc, hookDest);
  for (const [ev, opt] of Object.entries(EVENTS)) {
    const hook = { type: 'command', command };
    // só PermissionRequest precisa esperar a resposta; o resto roda em segundo plano
    if (opt.timeout) hook.timeout = opt.timeout;
    else hook.async = true;
    const group = { hooks: [hook] };
    if (opt.matcher) group.matcher = opt.matcher;
    (settings.hooks[ev] = settings.hooks[ev] || []).push(group);
  }
}

// Statusline: manda o uso do plano (rate_limits) para a ilha. Só liga se não houver outra.
const statusSrc = path.join(__dirname, 'hook', 'island-status.js');
const statusDest = path.join(os.homedir(), '.claude', 'hooks', 'island-status.js');
const STATUS_MARK = 'island-status.js';
const ours = sl => sl && String(sl.command || '').includes(STATUS_MARK);
if (!uninstall && fs.existsSync(statusSrc)) {
  fs.copyFileSync(statusSrc, statusDest);
  if (!settings.statusLine || ours(settings.statusLine)) {
    settings.statusLine = { type: 'command', command: `node "${statusDest.replace(/\\/g, '/')}"` };
  } else {
    console.log('Já existe uma statusLine: o uso do plano não aparece na ilha. Para ligar, troque a sua pela island-status.js.');
  }
}
if (uninstall && ours(settings.statusLine)) delete settings.statusLine;

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
if (uninstall && fs.existsSync(hookDest)) fs.unlinkSync(hookDest);
if (uninstall && fs.existsSync(statusDest)) fs.unlinkSync(statusDest);
console.log(uninstall ? 'Hooks da Claude Island removidos.' : `Hooks da Claude Island ligados em ${settingsPath}`);
console.log(`Backup: ${settingsPath}.bak-claude-island`);
