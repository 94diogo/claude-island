// A ilha do topo passa pelos estados do app em loop: parada, trabalhando, permissão, pronto.
(() => {
  const island = document.getElementById('island');
  if (!island) return;
  const timer = island.querySelector('[data-timer]');
  const allow = island.querySelector('[data-allow]');

  // com movimento reduzido, fica parada no estado "trabalhando"
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    island.dataset.state = 'working';
    timer.textContent = '01:42';
    return;
  }

  let t0 = 0, tick = 0;
  const startTimer = () => {
    t0 = performance.now();
    clearInterval(tick);
    tick = setInterval(() => {
      const s = Math.floor((performance.now() - t0) / 1000);
      timer.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }, 250);
  };

  const wait = ms => new Promise(r => setTimeout(r, ms));
  const show = s => { island.dataset.state = s; };

  async function loop() {
    for (;;) {
      show('idle');
      await wait(1400);
      show('working');
      startTimer();
      await wait(4200);
      show('permission');
      await wait(2200);
      allow.classList.add('press');      // o "clique" em Permitir
      await wait(260);
      allow.classList.remove('press');
      show('working');
      await wait(2600);
      clearInterval(tick);
      show('done');
      await wait(2400);
    }
  }
  // espera a página aparecer antes de começar
  setTimeout(loop, 600);
})();

// Downloads: o botão principal baixa o arquivo do sistema de quem visita, e os links
// saem da versão mais recente no GitHub. Se a API falhar, ficam os links fixos do HTML.
(() => {
  const ARQ = {
    win: /_x64-setup\.exe$/,
    'mac-arm': /_aarch64\.dmg$/,
    'mac-intel': /_x64\.dmg$/,
    deb: /_amd64\.deb$/,
    appimage: /_amd64\.AppImage$/,
  };
  const NOME = { win: 'Baixar para Windows', 'mac-arm': 'Baixar para Mac', deb: 'Baixar para Linux' };
  const ua = navigator.userAgent;
  let sistema = /Windows/.test(ua) ? 'win'
    : /Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua) ? 'mac-arm'
    : /Linux/.test(ua) && !/Android/.test(ua) ? 'deb'
    : null;

  function aplicar() {
    if (!sistema) return; // celular e outros: botão leva à página de releases
    const link = document.querySelector('.platforms [data-dl="' + sistema + '"]');
    document.querySelectorAll('[data-dl-main]').forEach(a => { a.href = link.href; });
    document.querySelectorAll('[data-dl-label]').forEach(s => { s.textContent = NOME[sistema]; });
    document.querySelectorAll('.platforms [data-dl="' + sistema + '"]').forEach(a => a.setAttribute('aria-current', 'true'));
  }
  aplicar();

  // Todo Mac se apresenta como "Intel" no texto do navegador. Chrome e Edge dizem a
  // arquitetura de verdade; nos outros, o padrão é Apple Silicon e o link Intel fica ao lado.
  if (sistema === 'mac-arm' && navigator.userAgentData?.getHighEntropyValues) {
    navigator.userAgentData.getHighEntropyValues(['architecture']).then(v => {
      if (v.architecture === 'x86') {
        document.querySelectorAll('[aria-current]').forEach(a => a.removeAttribute('aria-current'));
        sistema = 'mac-intel';
        NOME['mac-intel'] = 'Baixar para Mac';
        aplicar();
      }
    }).catch(() => {});
  }

  fetch('https://api.github.com/repos/94diogo/claude-island/releases/latest')
    .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
    .then(rel => {
      for (const [chave, re] of Object.entries(ARQ)) {
        const asset = (rel.assets || []).find(a => re.test(a.name));
        if (asset) document.querySelectorAll('.platforms [data-dl="' + chave + '"]').forEach(a => { a.href = asset.browser_download_url; });
      }
      document.querySelectorAll('[data-version]').forEach(s => { s.textContent = 'Versão ' + String(rel.tag_name || '').replace(/^v/, ''); });
      aplicar();
    })
    .catch(() => {});
})();
