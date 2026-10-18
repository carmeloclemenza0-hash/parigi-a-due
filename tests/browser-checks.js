// Controlli automatici del sito, da eseguire con Playwright contro un server locale:
//   cd Vario && python -m http.server 8765 --bind 127.0.0.1
// poi lanciare questo file con lo strumento Playwright "run code" (riceve `page`).
// Ogni controllo stampa OK/FAIL; alla fine c'è il riepilogo.
async (page) => {
  const BASE = 'http://127.0.0.1:8765/parigi-a-due/';
  const browser = page.context().browser();
  const results = [];
  const errors = [];
  const check = (name, pass, detail = '') => results.push(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);

  async function open(options = {}, { iso, hash = '', savedDay } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', ...options });
    if (savedDay) await ctx.addInitScript(day => {
      if (!localStorage.getItem('parigi-a-due-2026-v1')) localStorage.setItem('parigi-a-due-2026-v1', JSON.stringify({ version: 1, selectedDay: day, done: {}, notes: {}, tripNote: '' }));
    }, savedDay);
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    // Gli avvisi sul service worker bloccato li causa il test stesso (serviceWorkers: 'block').
    p.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('blocked by Playwright')) errors.push(m.text()); });
    if (iso) await p.clock.install({ time: new Date(iso) });
    await p.goto(BASE + hash);
    return { ctx, p };
  }

  // 1. Timer. L'orologio simulato avanza durante il caricamento: si accettano fino a 3 s di scarto.
  const readTimer = p => p.evaluate(() => document.getElementById('countdown-units').hidden
    ? document.getElementById('countdown-message').textContent
    : [...document.querySelectorAll('#countdown-units b')].map(b => b.textContent).join(' '));
  const toSeconds = shown => { const [d, h, m, s] = shown.split(' ').map(Number); return ((d * 24 + h) * 60 + m) * 60 + s; };
  const timerCases = [
    ['18/10 ore 12 italiane = 17 g 20 h', '2026-10-18T10:00:00Z', (17 * 24 + 20) * 3600],
    ['tre secondi prima della partenza', '2026-11-05T05:59:57Z', 3],
    ['partenza 5/11 ore 07:00', '2026-11-05T06:00:00Z', 'Ci siamo. Giorno 1 di 5'],
    ['7/11 a Disneyland', '2026-11-07T10:00:00Z', 'Ci siamo. Giorno 3 di 5 · Un po’ di magia'],
    ['10/11 dopo il viaggio', '2026-11-10T09:00:00Z', 'Ci siamo stati']
  ];
  for (const [name, iso, expected] of timerCases) {
    const { ctx, p } = await open({}, { iso });
    const shown = await readTimer(p);
    const pass = typeof expected === 'number'
      ? /^\d\d \d\d \d\d \d\d$/.test(shown) && expected - toSeconds(shown) >= 0 && expected - toSeconds(shown) <= 3
      : shown.startsWith(expected);
    check(`timer: ${name}`, pass, shown);
    if (name.startsWith('18/10')) {
      const before = toSeconds(await readTimer(p));
      await p.clock.runFor(1000);
      const after = toSeconds(await readTimer(p));
      check('timer: avanza di un secondo', before - after === 1, `${before} → ${after}`);
    }
    if (name.startsWith('tre secondi')) {
      await p.clock.runFor(4000);
      check('timer: a zero passa a "Ci siamo"', (await readTimer(p)).startsWith('Ci siamo. Giorno 1'));
    }
    await ctx.close();
  }

  // 2. Giorno di oggi (regressione)
  for (const [iso, hash, expected] of [['2026-11-07T09:00:00Z', '', 3], ['2026-11-08T10:00:00Z', '#giorno-2', 4], ['2026-10-20T10:00:00Z', '#giorno-2', 2], ['2026-10-20T10:00:00Z', '', 4]]) {
    const { ctx, p } = await open({}, { iso, hash, savedDay: 4 });
    const day = Number(await p.locator('#day-nav [aria-pressed="true"]').getAttribute('data-day'));
    check(`giorno di oggi: ${iso.slice(0, 10)} ${hash || '(senza link)'}`, day === expected, `giorno ${day}`);
    await ctx.close();
  }

  // 3. Layout a varie larghezze
  for (const width of [320, 360, 375, 390, 430, 1366]) {
    const mobile = width < 600;
    const { ctx, p } = await open({ viewport: { width, height: mobile ? 800 : 850 }, isMobile: mobile, hasTouch: mobile });
    await p.waitForTimeout(2600); // fine dell'animazione di apertura
    const r = await p.evaluate(() => {
      const rect = s => document.querySelector(s).getBoundingClientRect();
      const small = [];
      for (const el of document.querySelectorAll('body *')) {
        const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        if (!b.width || !b.height || cs.display === 'none' || el.closest('.round-stamp, .postcard-caption, .brand small, .site-footer, .hero .eyebrow')) continue;
        if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1)) continue;
        if (parseFloat(cs.fontSize) < 11) small.push(`${el.className || el.tagName} ${cs.fontSize}`);
      }
      const pol = rect('.polaroid'), title = rect('#hero-title'), units = rect('.countdown');
      return {
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        small: [...new Set(small)],
        polaroidOverTitle: pol.left < title.right && pol.top < title.bottom && pol.bottom > title.top,
        countdownFits: units.right <= document.documentElement.clientWidth,
        fontLoaded: document.fonts.check('500 40px "Cormorant Garamond"'),
        captionFits: (c => c.scrollWidth <= c.clientWidth + 1)(document.querySelector('.polaroid figcaption')),
        tabsCut: [...document.querySelectorAll('#day-nav .day-tab')].some(t => t.scrollWidth > t.clientWidth + 1)
      };
    });
    check(`layout ${width}px: niente scorrimento laterale`, !r.overflowX);
    // Il desktop non era prioritario: lì le scritte piccole preesistenti sono solo segnalate.
    if (mobile) check(`layout ${width}px: testi utili ≥ 11px`, r.small.length === 0, r.small.join(', '));
    else results.push(`INFO layout ${width}px: scritte sotto 11px (preesistenti) — ${r.small.join(', ')}`);
    check(`layout ${width}px: polaroid non copre il titolo`, !r.polaroidOverTitle);
    check(`layout ${width}px: timer dentro lo schermo`, r.countdownFits);
    check(`layout ${width}px: giorni non tagliati`, !r.tabsCut);
    check(`layout ${width}px: Cormorant caricato`, r.fontLoaded);
    check(`layout ${width}px: didascalia polaroid dentro il bordo`, r.captionFits);
    await p.screenshot({ path: `C:/Users/Carme/Desktop/AIWORKSPACE/Vario/.playwright-mcp/shot-${width}.png` });
    await ctx.close();
  }

  // 4. Spunta, cuore e timbro del giorno
  {
    const { ctx, p } = await open({ isMobile: true, hasTouch: true }, { hash: '#giorno-5' });
    await p.locator('#d5-colazione').tap();
    const popped = await p.locator('#d5-colazione').evaluate(e => e.classList.contains('just-checked'));
    const hearts = await p.locator('.heart-burst').count();
    await p.waitForTimeout(1000);
    const heartsAfter = await p.locator('.heart-burst').count();
    check('spunta: pop e cuoricino', popped && hearts === 1, `pop ${popped}, cuori ${hearts}`);
    check('spunta: cuoricino rimosso dopo l’animazione', heartsAfter === 0);
    const before = await p.locator('[data-day="5"]').evaluate(e => e.classList.contains('is-complete'));
    await p.locator('#d5-free').tap();
    const after = await p.locator('[data-day="5"]').evaluate(e => e.classList.contains('is-complete'));
    check('timbro: compare solo a giorno completato', !before && after);
    await p.locator('.day-heading').first().screenshot({ path: 'C:/Users/Carme/Desktop/AIWORKSPACE/Vario/.playwright-mcp/shot-day5.png' });
    await p.locator('#day-nav').screenshot({ path: 'C:/Users/Carme/Desktop/AIWORKSPACE/Vario/.playwright-mcp/shot-nav.png' });
    await ctx.close();
  }

  // 5. Movimento ridotto: tutto visibile subito, nessun cuore
  {
    const { ctx, p } = await open({ reducedMotion: 'reduce', isMobile: true, hasTouch: true });
    const hidden = await p.evaluate(() => [...document.querySelectorAll('.timeline-item, .polaroid, #hero-title')].filter(e => parseFloat(getComputedStyle(e).opacity) < 1).length);
    check('movimento ridotto: niente di invisibile', hidden === 0, `${hidden} elementi`);
    await p.locator('#d1-volo').tap();
    check('movimento ridotto: nessun cuoricino', await p.locator('.heart-burst').count() === 0);
    await ctx.close();
  }

  // 6. Offline con service worker, spunte ricordate, peso totale
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    await p.goto(BASE);
    await p.evaluate(() => navigator.serviceWorker.ready);
    const cache = await p.evaluate(async () => ({ keys: await caches.keys(), files: (await (await caches.open('parigi-v3')).keys()).length }));
    check('cache: solo parigi-v3 con 12 file', cache.keys.join() === 'parigi-v3' && cache.files === 12, JSON.stringify(cache));
    // Il server locale non comprime: qui si sommano le risorse (foto, font, icone, già compresse di loro);
    // il peso di index.html compresso (come lo serve GitHub Pages) si misura a parte, con gzip.
    const weight = await p.evaluate(() => {
      const res = performance.getEntriesByType('resource');
      return { kb: Math.round(res.reduce((sum, r) => sum + (r.transferSize || r.encodedBodySize || 0), 0) / 1024), list: res.map(r => r.name.split('/').pop()), external: res.filter(r => !r.name.startsWith(location.origin)).map(r => r.name) };
    });
    results.push(`INFO peso risorse (senza index.html): ${weight.kb} KB — ${weight.list.join(', ')}`);
    check('nessuna richiesta esterna', weight.external.length === 0, weight.external.join(', '));
    await p.locator('#d1-volo').tap();
    await ctx.setOffline(true);
    await p.reload();
    const loaded = sel => p.locator(sel).evaluate(i => i.complete && i.naturalWidth > 0);
    const offline = { stops: await p.locator('#timeline .timeline-item').count(), checked: await p.locator('#d1-volo').isChecked(), photo: await loaded('.polaroid img') && await loaded('.postcard img') };
    check('offline: sito, spunta e foto disponibili', offline.stops > 0 && offline.checked && offline.photo, JSON.stringify(offline));
    await ctx.close();
  }

  check('console: nessun errore o avviso', errors.length === 0, errors.join(' | '));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  return `${results.join('\n')}\n\n${results.length - failed}/${results.length} controlli superati`;
}
