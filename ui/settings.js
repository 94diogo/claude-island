// Janela de configurações: lê config.json pelo Rust, salva a cada mudança (aplica na hora).
(() => {
  const T = window.__TAURI__;
  // fora do Tauri (navegador): dados de exemplo para ver a tela
  const DEMO = {
    cfg: { ocultar: { navegador: true, teams: true, discord: false, telacheia: false, extras: true },
      dnd: { ligado: true, inicio: '22:00', fim: '08:00', dias: [1, 2, 3, 4, 5] },
      aparencia: { opacidade: 0.85, escala: 1, compacto: false }, uso: { mostrar: true } },
    grupos: [{ chave: 'navegador', rotulo: 'Reunião no navegador (Meet etc.)' }, { chave: 'teams', rotulo: 'Microsoft Teams' },
      { chave: 'discord', rotulo: 'Discord (chamada de voz)' }, { chave: 'telacheia', rotulo: 'Jogo ou app em tela cheia' },
      { chave: 'extras', rotulo: 'Apps da lista extra' }],
    uso: { rate_limits: { five_hour: { used_percentage: 42, resets_at: Date.now() / 1000 + 7200 }, seven_day: { used_percentage: 86, resets_at: Date.now() / 1000 + 300000 } } },
  };
  const invoke = T ? T.core.invoke : async cmd => (cmd === 'get_config' ? structuredClone(DEMO) : null);
  const listen = T ? T.event.listen : () => {};
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  let cfg = null;
  const get = k => k.split('.').reduce((o, p) => (o == null ? o : o[p]), cfg);
  const set = (k, v) => {
    const ps = k.split('.');
    const last = ps.pop();
    ps.reduce((o, p) => (o[p] ??= {}), cfg)[last] = v;
  };

  /* ---------- salvar com pequeno atraso (deslizante manda muitos eventos) ---------- */
  let saveT = 0, flashT = 0;
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      invoke('set_config', { cfg }).then(() => {
        const el = $('[data-saved]');
        el.textContent = 'Salvo';
        el.classList.add('on');
        clearTimeout(flashT);
        flashT = setTimeout(() => el.classList.remove('on'), 1200);
      }).catch(e => { $('[data-saved]').textContent = 'Erro ao salvar'; console.error(e); });
    }, 180);
  }

  /* ---------- montar ---------- */
  const DAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
  const DAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

  function build(groups) {
    $('[data-groups]').replaceChildren(...groups.map(g => {
      const row = document.createElement('label');
      row.className = 'row';
      const span = document.createElement('span');
      span.textContent = g.rotulo;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'switch';
      input.dataset.k = 'ocultar.' + g.chave;
      row.append(span, input);
      return row;
    }));
    $('[data-days]').replaceChildren(...DAYS.map((d, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = d;
      b.dataset.day = i;
      b.setAttribute('aria-label', DAY_NAMES[i]);
      return b;
    }));
  }

  function fill() {
    $$('[data-k]').forEach(el => {
      const v = get(el.dataset.k);
      if (el.type === 'checkbox') el.checked = !!v;
      else if ('pct' in el.dataset) el.value = Math.round((Number(v) || 1) * 100);
      else el.value = v ?? '';
    });
    const days = get('dnd.dias') || [];
    $$('[data-day]').forEach(b => b.setAttribute('aria-pressed', days.includes(Number(b.dataset.day))));
    outputs();
    $('[data-dnd]').classList.toggle('off', !get('dnd.ligado'));
  }

  function outputs() {
    $$('[data-out]').forEach(o => { o.textContent = Math.round((Number(get(o.dataset.out)) || 1) * 100) + '%'; });
  }

  /* ---------- eventos ---------- */
  document.addEventListener('input', e => {
    const el = e.target;
    if (!el.dataset?.k) return;
    if (el.type === 'checkbox') set(el.dataset.k, el.checked);
    else if ('pct' in el.dataset) set(el.dataset.k, Number(el.value) / 100);
    else set(el.dataset.k, el.value);
    outputs();
    $('[data-dnd]').classList.toggle('off', !get('dnd.ligado'));
    save();
  });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-day]');
    if (!b) return;
    const d = Number(b.dataset.day);
    const days = new Set(get('dnd.dias') || []);
    days.has(d) ? days.delete(d) : days.add(d);
    set('dnd.dias', [...days].sort());
    b.setAttribute('aria-pressed', days.has(d));
    save();
  });
  $('[data-extras]').addEventListener('click', () => invoke('open_extras'));

  /* ---------- uso do plano ---------- */
  function renderUsage(u) {
    const el = $('[data-usage]');
    const rl = u && u.rate_limits;
    const ws = [['five_hour', 'Janela de 5 horas'], ['seven_day', 'Semana']]
      .map(([k, label]) => rl && rl[k] && typeof rl[k].used_percentage === 'number' ? { label, ...rl[k] } : null)
      .filter(Boolean);
    if (!ws.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'Sem dados ainda. Os números chegam pela statusline do Claude Code depois da primeira resposta de uma sessão (planos Pro, Max e Ultra).';
      return el.replaceChildren(p);
    }
    el.replaceChildren(...ws.map(w => {
      const pct = Math.round(w.used_percentage);
      const d = document.createElement('div');
      d.className = 'w' + (pct >= 80 ? ' hot' : '');
      const b = document.createElement('b'); b.textContent = w.label;
      const s = document.createElement('span'); s.textContent = pct + '%';
      const bar = document.createElement('div'); bar.className = 'bar';
      const i = document.createElement('i'); i.style.setProperty('--p', Math.min(100, pct) + '%'); bar.append(i);
      const sm = document.createElement('small');
      sm.textContent = w.resets_at ? 'Volta a zero ' + new Date(w.resets_at * 1000).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
      d.append(b, s, bar, sm);
      return d;
    }));
  }

  invoke('get_config').then(r => {
    if (!r) return;
    cfg = r.cfg;
    build(r.grupos);
    fill();
    renderUsage(r.uso);
  });
  listen('island-usage', e => renderUsage(e.payload));
})();
