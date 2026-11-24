#!/usr/bin/env node
// Statusline do Claude Code: manda o JSON (com rate_limits) para a Claude Island
// e imprime uma linha curta com modelo e uso do plano.
// Se a ilha estiver fechada, só imprime a linha.
const http = require('http');

let raw = '';
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => {
  let data = {};
  raw = raw.replace(/^\uFEFF/, '');
  try { data = JSON.parse(raw); } catch {}

  const rl = data.rate_limits || {};
  const pct = w => (w && typeof w.used_percentage === 'number' ? `${Math.round(w.used_percentage)}%` : null);
  const parts = [data.model && data.model.display_name];
  if (pct(rl.five_hour)) parts.push(`5h ${pct(rl.five_hour)}`);
  if (pct(rl.seven_day)) parts.push(`7d ${pct(rl.seven_day)}`);
  const line = parts.filter(Boolean).join(' · ');

  let ended = false;
  const done = () => { if (ended) return; ended = true; process.stdout.write(line, () => process.exit(0)); };
  const req = http.request(
    { host: '127.0.0.1', port: 47821, path: '/status', method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 400 },
    res => { res.resume(); res.on('end', done); }
  );
  req.on('timeout', () => { req.destroy(); done(); });
  req.on('error', done);
  req.end(raw || '{}');
});
