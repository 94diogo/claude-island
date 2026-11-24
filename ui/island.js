// Claude Island: recebe os eventos dos hooks do Claude Code (via Rust) e decide o que a ilha mostra.
// Prioridade: permissão pendente > sessão trabalhando > aviso > "pronto" > parada.
(() => {
  const T = window.__TAURI__;
  const invoke = T ? T.core.invoke : async () => {};
  const listen = T ? T.event.listen : () => {};
  const log = msg => invoke('log', { msg: String(msg) }).catch(() => {});
  addEventListener('error', e => log(`erro: ${e.message} @${e.lineno}`));
  addEventListener('unhandledrejection', e => log(`promise: ${e.reason}`));
  log(`ui carregada, tauri=${!!T}`);

  const island = document.getElementById('island');
  const $ = s => island.querySelector(s);
  const $$ = s => island.querySelectorAll(s);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const SIZES = {
    idle:       { w: 128, h: 34,  r: 17 },
    working:    { w: 340, h: 38,  r: 19 },
    expanded:   { w: 400, h: 176, r: 28 },
    permission: { w: 420, h: 168, r: 28 },
    notice:     { w: 280, h: 38,  r: 19 },
    task:       { w: 440, h: 38,  r: 19 },
    done:       { w: 236, h: 38,  r: 19 },
  };
  // modo compacto: pílulas menores, sem texto enquanto trabalha
  const COMPACT = {
    idle:    { w: 40,  h: 22, r: 11 },
    working: { w: 116, h: 30, r: 15 },
    notice:  { w: 210, h: 30, r: 15 },
    task:    { w: 320, h: 30, r: 15 },
    done:    { w: 120, h: 30, r: 15 },
    info:    { w: 280, h: 30, r: 15 },
  };
  SIZES.info = { w: 320, h: 38, r: 19 };
  // no meio das laterais (ml, mr): pílula em pé; cartões (aberta, permissão, aviso) seguem horizontais
  const VERTICAL = {
    idle:    { w: 22, h: 44,  r: 11 },
    working: { w: 38, h: 172, r: 19 },
    done:    { w: 38, h: 116, r: 19 },
  };
  const PAD = 8;
  let Z = 1;          // escala (aparência > tamanho); a janela cresce junto no Rust
  let cfg = null;     // config.json
  let usage = null;   // rate_limits da statusline
  // canto onde a ilha está: linha (t/m/b) + coluna (l/c/r). A ilha cresce para dentro da tela;
  // no meio das laterais (ml, mr) ela cresce para cima e para baixo a partir do centro.
  let anchor = 'tc';
  function offset(w, h) {
    const col = anchor[1], row = anchor[0];
    const vw = innerWidth / Z, vh = innerHeight / Z;
    const x = col === 'l' ? PAD : col === 'r' ? vw - w - PAD : (vw - w) / 2;
    const y = row === 'b' ? vh - h - PAD : row === 'm' ? (vh - h) / 2 : PAD;
    return { x, y };
  }

  /* ---------- mola: interrompível, leve overshoot ---------- */
  const K = 380, C = 26;
  const cur = { ...SIZES.idle }, vel = { w: 0, h: 0, r: 0 };
  let target = { ...cur }, raf = 0, last = 0;

  function frame(t) {
    const dt = Math.min(0.032, (t - (last || t)) / 1000) || 1 / 60;
    last = t;
    let moving = false;
    for (const k of ['w', 'h', 'r']) {
      vel[k] += (-K * (cur[k] - target[k]) - C * vel[k]) * dt;
      cur[k] += vel[k] * dt;
      if (Math.abs(vel[k]) > 0.05 || Math.abs(cur[k] - target[k]) > 0.05) moving = true;
      else { cur[k] = target[k]; vel[k] = 0; }
    }
    paint();
    if (moving) raf = requestAnimationFrame(frame);
    else { raf = 0; last = 0; sendHit(cur.w, cur.h); }
  }
  function paint() {
    const o = offset(cur.w, cur.h);
    island.style.left = o.x + 'px';
    island.style.top = o.y + 'px';
    island.style.width = cur.w + 'px';
    island.style.height = cur.h + 'px';
    island.style.borderRadius = cur.r + 'px';
  }
  function sendHit(w, h) {
    const o = offset(w, h);
    invoke('set_hit_rect', { x: o.x * Z, y: o.y * Z, w: w * Z, h: h * Z }).catch(() => {});
  }

  let shown = 'idle', shownKey = '';
  function sizeOf(state) {
    if (anchor[0] === 'm' && VERTICAL[state]) return VERTICAL[state];
    return (cfg?.aparencia?.compacto && COMPACT[state]) || SIZES[state];
  }
  function show(state, size) {
    const sz = size || sizeOf(state);
    const key = state + ':' + sz.w + 'x' + sz.h;
    if (key === shownKey) return;
    shown = state; shownKey = key;
    island.dataset.state = state;
    target = { ...sz };
    // enquanto anima, a área clicável cobre o maior dos dois tamanhos
    sendHit(Math.max(cur.w, target.w), Math.max(cur.h, target.h));
    if (reduce) { Object.assign(cur, target); paint(); sendHit(cur.w, cur.h); }
    else if (!raf) raf = requestAnimationFrame(frame);
  }

  /* ---------- estado ---------- */
  const sessions = new Map(); // id -> { cwd, tool, arg, steps, start, working, seen }
  let perms = [];             // { id, session, tool, input, cwd }
  let notice = null;          // { session, text, cwd }
  let done = null;            // { elapsed }
  let doneTimer = 0;
  let hovering = false;
  let pinned = false;         // clique na ilha trabalhando: fica aberta até outro clique
  let flash = null;           // aviso de tarefa agendada: { kind, title, meta }
  let flashTimer = 0;

  const TASK_ICONS = {
    start: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.3 1.5"/></svg>',
    done: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 6.5 12 13 4.5"/></svg>',
    fail: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
  };
  const TASK_KICKER = { start: 'Tarefa iniciada', done: 'Tarefa concluída', fail: 'Tarefa falhou' };

  function showFlash(kind, title, meta, ms) {
    flash = { kind, title, meta };
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash = null; render(); }, ms);
  }

  const base = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
  const shortTool = t => (t || '').startsWith('mcp__') ? t.split('__').pop() : (t || '');

  function summarize(tool, input = {}) {
    switch (tool) {
      case 'Bash': case 'PowerShell': return String(input.command || '').split('\n')[0];
      case 'Read': case 'Edit': case 'Write': case 'MultiEdit': return base(input.file_path);
      case 'NotebookEdit': return base(input.notebook_path);
      case 'Grep': case 'Glob': return input.pattern || '';
      case 'WebFetch': try { return new URL(input.url).host; } catch { return ''; }
      case 'WebSearch': return input.query || '';
      case 'Task': case 'Agent': return input.description || '';
      default: return '';
    }
  }

  function session(id, cwd) {
    if (!sessions.has(id)) sessions.set(id, { cwd: '', tool: '', arg: '', steps: [], start: 0, working: false, seen: 0 });
    const s = sessions.get(id);
    if (cwd) s.cwd = cwd;
    s.seen = performance.now();
    return s;
  }

  function onEvent(e) {
    log(`evento ${e.hook_event_name}`);
    const sid = e.session_id || 'local';
    const s = session(sid, e.cwd);
    switch (e.hook_event_name) {
      case 'UserPromptSubmit':
        Object.assign(s, { working: true, start: performance.now(), tool: 'Pensando', arg: '', steps: [] });
        perms = perms.filter(p => p.session !== sid);
        if (notice?.session === sid) notice = null;
        done = null;
        if (e.scheduled_task) {
          s.scheduled = e.scheduled_task;
          showFlash('start', s.scheduled.title, 'agendada', 3500);
        }
        break;
      case 'PreToolUse': {
        if (!s.working) Object.assign(s, { working: true, start: performance.now(), steps: [] });
        s.tool = shortTool(e.tool_name);
        s.arg = summarize(e.tool_name, e.tool_input);
        s.steps.push({ tool: s.tool, arg: s.arg, st: 'run' });
        s.steps = s.steps.slice(-3);
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const step = s.steps.find(x => x.st === 'run' && x.tool === shortTool(e.tool_name));
        if (step) step.st = e.hook_event_name === 'PostToolUse' ? 'ok' : 'fail';
        perms = perms.filter(p => p.session !== sid);
        break;
      }
      case 'PermissionRequest':
        if (e.island_id != null) perms.push({ id: e.island_id, session: sid, tool: e.tool_name, input: e.tool_input || {}, cwd: s.cwd });
        break;
      case 'Notification': {
        const type = e.notification_type;
        if (type === 'permission_prompt' && perms.some(p => p.session === sid)) break;
        const text = type === 'idle_prompt' ? 'Esperando você'
          : type === 'permission_prompt' ? 'Pedindo permissão'
          : (e.message || 'Aviso');
        notice = { session: sid, text, cwd: s.cwd };
        break;
      }
      case 'StopFailure':
        if (s.working || s.scheduled) {
          showFlash('fail', s.scheduled ? s.scheduled.title : base(s.cwd) || 'Sessão', 'erro', 8000);
        }
        s.working = false;
        perms = perms.filter(p => p.session !== sid);
        break;
      case 'Stop':
        if (s.working && s.scheduled) {
          showFlash('done', s.scheduled.title, fmtElapsed(performance.now() - s.start), 6000);
        } else if (s.working) {
          done = { elapsed: fmtElapsed(performance.now() - s.start) };
          clearTimeout(doneTimer);
          doneTimer = setTimeout(() => { done = null; render(); }, 3200);
        }
        s.working = false;
        perms = perms.filter(p => p.session !== sid);
        break;
      case 'SessionEnd':
        sessions.delete(sid);
        perms = perms.filter(p => p.session !== sid);
        if (notice?.session === sid) notice = null;
        break;
    }
    render();
  }

  // sessão sem sinal há 20 min (terminal fechado sem Stop) deixa de contar
  const STALE = 20 * 60 * 1000;
  function workingSessions() {
    const now = performance.now();
    return [...sessions.values()].filter(s => s.working && now - s.seen < STALE).sort((a, b) => a.start - b.start);
  }
  function focusSession() {
    let best = null;
    for (const s of workingSessions()) if (!best || s.seen > best.seen) best = s;
    return best;
  }

  /* ---------- uso do plano ---------- */
  function usageWindows() {
    const rl = usage?.rate_limits;
    if (!rl || !cfg?.uso?.mostrar) return [];
    const out = [];
    for (const [k, label] of [['five_hour', '5h'], ['seven_day', 'semana']]) {
      const w = rl[k];
      if (w && typeof w.used_percentage === 'number') out.push({ label, pct: Math.round(w.used_percentage), reset: w.resets_at });
    }
    return out;
  }
  const fmtReset = ts => {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const same = d.toDateString() === new Date().toDateString();
    const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return same ? hm : d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '') + ' ' + hm;
  };
  function renderUsage() {
    const ws = usageWindows();
    const el = $('[data-usage]');
    el.hidden = !ws.length;
    el.replaceChildren(...ws.map(w => {
      const span = document.createElement('span');
      span.className = 'u' + (w.pct >= 80 ? ' hot' : '');
      const bar = document.createElement('i');
      bar.style.setProperty('--p', Math.min(100, w.pct) + '%');
      const t = document.createElement('span');
      t.textContent = `${w.label} ${w.pct}%`;
      const r = document.createElement('em');
      r.textContent = w.reset ? 'volta ' + fmtReset(w.reset) : '';
      span.append(t, bar, r);
      return span;
    }));
    return ws.length ? 26 : 0;
  }

  function renderSessions(list) {
    const ul = $('[data-sess]');
    ul.replaceChildren(...list.map(s => {
      const li = document.createElement('li');
      const dot = document.createElement('span'); dot.className = 'st-run';
      const name = document.createElement('span'); name.className = 'name'; name.textContent = s.scheduled ? s.scheduled.title : (base(s.cwd) || 'sessão');
      const what = document.createElement('span'); what.className = 'what'; what.textContent = s.arg ? `${s.tool} ${s.arg}` : s.tool;
      const t = document.createElement('span'); t.className = 'time'; t.dataset.since = s.start;
      li.append(dot, name, what, t);
      return li;
    }));
  }

  /* ---------- desenho ---------- */
  let lastLabel = '';
  function setLabel(tool, arg) {
    const key = tool + '\u0000' + arg;
    if (key === lastLabel) return;
    lastLabel = key;
    $$('[data-tool-label]').forEach(el => {
      const b = document.createElement('b');
      b.textContent = tool;
      el.replaceChildren(b, document.createTextNode(arg));
      if (!reduce) el.animate(
        [{ opacity: 0, filter: 'blur(4px)', transform: 'translateY(4px)' },
         { opacity: 1, filter: 'blur(0)', transform: 'none' }],
        { duration: 240, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    });
  }

  function renderSteps(s) {
    const ul = $('[data-steps]');
    ul.replaceChildren(...s.steps.map(step => {
      const li = document.createElement('li');
      const mark = document.createElement('span');
      if (step.st === 'run') mark.className = 'st-run';
      else { mark.className = step.st === 'ok' ? 'st-ok' : 'st-fail'; mark.textContent = step.st === 'ok' ? '✓' : '✕'; }
      const tool = document.createElement('span'); tool.className = 'tool'; tool.textContent = step.tool;
      const arg = document.createElement('span'); arg.textContent = step.arg;
      li.append(mark, tool, arg);
      return li;
    }));
  }

  function renderPerm(p) {
    const shell = p.tool === 'Bash' || p.tool === 'PowerShell';
    const edit = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(p.tool);
    $('[data-perm-title]').textContent = shell ? 'Quer rodar um comando'
      : edit ? 'Quer editar um arquivo'
      : p.tool === 'WebFetch' ? 'Quer abrir um site'
      : `Quer usar ${shortTool(p.tool)}`;
    const extra = perms.length > 1 ? ` · +${perms.length - 1}` : '';
    $('[data-perm-where]').textContent = base(p.cwd) + extra;
    const body = shell ? p.input.command
      : edit ? (p.input.file_path || p.input.notebook_path)
      : p.tool === 'WebFetch' ? p.input.url
      : JSON.stringify(p.input);
    const pre = document.createElement('span');
    pre.className = 'p';
    pre.textContent = shell ? '$' : shortTool(p.tool);
    $('[data-perm-cmd]').replaceChildren(pre, document.createTextNode(String(body || '').slice(0, 300)));
  }

  let current = null;
  function render() {
    if (perms.length) { renderPerm(perms[0]); return show('permission'); }
    const s = focusSession();
    current = s;
    if (flash) {
      const icon = $('[data-task-icon]');
      icon.dataset.kind = flash.kind;
      icon.innerHTML = TASK_ICONS[flash.kind];
      $('[data-task-kicker]').textContent = TASK_KICKER[flash.kind];
      $('[data-task-title]').textContent = flash.title;
      $('[data-task-meta]').textContent = flash.meta;
      return show('task');
    }
    if (s) {
      const list = workingSessions();
      const many = list.length > 1;
      setLabel(s.tool, s.arg);
      const cnt = $('[data-count]');
      cnt.hidden = !many;
      cnt.textContent = list.length;
      const where = s.cwd ? `${base(s.cwd)} · ${s.cwd}` : '';
      $('[data-meta]').textContent = many ? `${list.length} sessões trabalhando`
        : s.scheduled ? `Tarefa agendada: ${s.scheduled.title}` : where;
      island.classList.toggle('many', many);
      if (many) renderSessions(list.slice(0, 5)); else renderSteps(s);
      renderUsage();
      tickTimer();
      if (!(hovering || pinned)) return show('working');
      // altura pelo conteúdo: cabeçalho, lista ou passos, e a linha de uso
      const layer = $('.l-expanded');
      let h = 0;
      for (const el of layer.children) if (el.offsetParent) h = Math.max(h, el.offsetTop + el.offsetHeight);
      h = Math.max(96, h + 14);
      return show('expanded', { w: 400, h, r: 28 });
    }
    pinned = false;
    if (done) { $('[data-done-time]').textContent = done.elapsed; return show('done'); }
    if (notice) {
      $('[data-notice]').textContent = notice.text;
      $('[data-notice-where]').textContent = base(notice.cwd);
      return show('notice');
    }
    // parada, com o mouse em cima: mostra o uso do plano
    const ws = usageWindows();
    if (hovering && ws.length) {
      $('[data-info]').textContent = ws.map(w => `${w.label} ${w.pct}%`).join(' · ');
      $('[data-info-reset]').textContent = ws[0].reset ? 'volta ' + fmtReset(ws[0].reset) : '';
      return show('info');
    }
    show('idle');
  }

  function fmtElapsed(ms) {
    const s = Math.max(1, Math.round(ms / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  }
  function tickTimer() {
    if (!current) return;
    const s = Math.floor((performance.now() - current.start) / 1000);
    const txt = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    $$('[data-timer]').forEach(el => { if (el.textContent !== txt) el.textContent = txt; });
    const now = performance.now();
    $$('[data-since]').forEach(el => {
      const t = Math.floor((now - Number(el.dataset.since)) / 1000);
      const v = String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
      if (el.textContent !== v) el.textContent = v;
    });
  }
  setInterval(tickTimer, 250);

  /* ---------- interação ---------- */
  function decide(allow) {
    const p = perms.shift();
    if (!p) return;
    invoke('decide', { id: p.id, allow }).catch(() => {});
    render();
  }
  $('[data-allow]').addEventListener('click', () => decide(true));
  $('[data-deny]').addEventListener('click', () => decide(false));
  $('.l-notice').addEventListener('click', () => { notice = null; render(); });
  $('.l-done').addEventListener('click', () => { done = null; render(); });
  $('.l-working').addEventListener('click', () => { pinned = true; render(); });
  $('.l-expanded').addEventListener('click', () => { pinned = false; hovering = false; render(); });

  // Passar o mouse a caminho de outra coisa não abre a ilha: só depois de parar em cima.
  const HOVER_WAIT = 450;
  let enterT = 0, leaveT = 0;
  function setHover(on) {
    clearTimeout(leaveT); clearTimeout(enterT);
    document.body.classList.toggle('hot', on);
    if (dragging) return;
    if (on) enterT = setTimeout(() => { hovering = true; render(); }, HOVER_WAIT);
    else leaveT = setTimeout(() => { hovering = false; render(); }, 180);
  }

  /* ---------- arrastar: solta e ela encaixa no canto mais perto ---------- */
  let press = null, dragging = false, swallowClick = false;
  island.addEventListener('pointerdown', e => {
    log('pointerdown ' + e.button);
    if (e.button !== 0 || e.target.closest('button')) return;
    press = { x: e.screenX, y: e.screenY, id: e.pointerId };
  });
  island.addEventListener('pointermove', e => {
    if (!press || dragging) return;
    if (Math.hypot(e.screenX - press.x, e.screenY - press.y) < 5) return;
    dragging = true;
    island.setPointerCapture(press.id);
    island.classList.add('dragging');
    clearTimeout(enterT);
    hovering = false; pinned = false; render();
    invoke('drag_start').catch(() => {});
  });
  const release = e => {
    log(e.type + ' dragging=' + dragging);
    press = null;
    if (!dragging) return;
    dragging = false;
    swallowClick = true;
    island.classList.remove('dragging');
    invoke('drag_end').catch(() => {});
  };
  island.addEventListener('pointerup', release);
  island.addEventListener('pointercancel', release);
  // o clique que fecha um arraste não conta como clique
  island.addEventListener('click', e => {
    if (swallowClick) { swallowClick = false; e.stopPropagation(); e.preventDefault(); }
  }, true);

  function applyCfg(c) {
    cfg = c;
    const ap = c.aparencia || {};
    Z = Math.min(1.4, Math.max(0.8, Number(ap.escala) || 1));
    document.documentElement.style.zoom = Z;
    document.body.style.setProperty('--op', Math.min(1, Math.max(0.3, Number(ap.opacidade) || 1)));
    document.body.classList.toggle('compact', !!ap.compacto);
    shownKey = '';
    render();
    paint();
    sendHit(Math.max(cur.w, target.w), Math.max(cur.h, target.h));
  }

  function setAnchor(a) {
    anchor = a;
    island.dataset.anchor = a;
    shownKey = '';
    render();
    paint();
    sendHit(Math.max(cur.w, target.w), Math.max(cur.h, target.h));
  }

  if (T) {
    listen('island-event', e => onEvent(e.payload));
    listen('island-expire', e => { perms = perms.filter(p => p.id !== e.payload); render(); });
    listen('island-hover', e => setHover(!!e.payload));
    listen('island-anchor', e => setAnchor(e.payload));
    listen('island-meeting', e => document.body.classList.toggle('meeting', !!e.payload));
    listen('island-config', e => applyCfg(e.payload));
    listen('island-usage', e => { usage = e.payload; render(); });
    invoke('get_config').then(r => { usage = r.uso && r.uso.rate_limits ? r.uso : null; applyCfg(r.cfg); }).catch(() => {});
    invoke('get_anchor').then(setAnchor).catch(() => {});
  } else {
    // fora do Tauri (navegador): hover normal e window.islandEvent para testar
    island.addEventListener('pointerenter', () => setHover(true));
    island.addEventListener('pointerleave', () => setHover(false));
    window.islandEvent = onEvent;
    window.islandCfg = applyCfg;
    window.islandAnchor = setAnchor;
    window.islandUsage = u => { usage = u; render(); };
  }

  paint();
  sendHit(cur.w, cur.h);
})();
