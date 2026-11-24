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
