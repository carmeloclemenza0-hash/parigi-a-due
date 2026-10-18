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

  // 6. Invito a installare l'app
  {
    const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const cardState = p => p.evaluate(() => ({ visible: !document.getElementById('install-card').hidden, ios: !document.getElementById('install-ios').hidden, button: !document.getElementById('install-button').hidden }));

    // iPhone in Safari: istruzioni visibili, niente pulsante; "Non ora" lo nasconde anche dopo una ricarica.
    let { ctx, p } = await open({ userAgent: IPHONE_UA, isMobile: true, hasTouch: true });
    await p.waitForTimeout(2800);
    const ios = await cardState(p);
    check('installa (iPhone): istruzioni Condividi, senza pulsante', ios.visible && ios.ios && !ios.button, JSON.stringify(ios));
    await p.screenshot({ path: 'C:/Users/Carme/Desktop/AIWORKSPACE/Vario/.playwright-mcp/install-ios.png' });
    await p.locator('#install-later').tap();
    await p.reload();
    await p.waitForTimeout(2800);
    check('installa (iPhone): dopo "Non ora" non ricompare', !(await cardState(p)).visible);
    await ctx.close();

    // App già aperta dalla schermata Home: nessun invito.
    {
      const c = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: IPHONE_UA, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
      await c.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
      const pg = await c.newPage();
      await pg.goto(BASE);
      await pg.waitForTimeout(2800);
      check('installa: nascosto se l’app è già installata', !(await cardState(pg)).visible);
      await c.close();
    }

    // Android: l'evento del browser mostra il pulsante, che avvia l'installazione.
    ({ ctx, p } = await open({ isMobile: true, hasTouch: true }));
    await p.evaluate(() => {
      const ev = new Event('beforeinstallprompt');
      ev.prompt = () => { window.__prompted = true; };
      ev.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(ev);
    });
    await p.waitForTimeout(2800);
    const android = await cardState(p);
    check('installa (Android): pulsante Installa visibile', android.visible && android.button && !android.ios, JSON.stringify(android));
    await p.locator('#install-button').tap();
    await p.waitForTimeout(200);
    check('installa (Android): il pulsante avvia l’installazione e chiude il riquadro', await p.evaluate(() => window.__prompted === true) && !(await cardState(p)).visible);
    await ctx.close();

    // Computer: nessun invito.
    ({ ctx, p } = await open({ viewport: { width: 1366, height: 850 } }));
    await p.waitForTimeout(2800);
    check('installa: nascosto su computer', !(await cardState(p)).visible);
    await ctx.close();
  }

  // 7. Offline con service worker, spunte ricordate, peso totale
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

  // 8. Contrasto dei testi (WCAG AA) di giorno e di notte, a misura di telefono.
  // Animazioni ridotte, così niente è a metà dissolvenza; le tappe già fatte sono sbiadite di proposito.
  for (const scheme of ['light', 'dark']) {
    const { ctx, p } = await open({ colorScheme: scheme, reducedMotion: 'reduce', isMobile: true, hasTouch: true });
    await p.waitForTimeout(500);
    const bad = await p.evaluate(() => {
      const parse = c => { const m = c.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
      const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
      // Sfondo effettivo: si compongono gli sfondi degli antenati, dal più esterno al più interno.
      const backgroundOf = el => {
        const layers = [];
        for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
          const bg = parse(getComputedStyle(node).backgroundColor);
          if (bg.a > 0) layers.push(bg);
          if (bg.a === 1) break;
        }
        return layers.reverse().reduce((acc, layer) => over(layer, acc), { r: 255, g: 255, b: 255, a: 1 });
      };
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        if (!b.width || !b.height || cs.visibility === 'hidden' || el.closest('[hidden], .is-done, .print-only, .skip-link, .static-itinerary, .round-stamp, .install-card')) continue;
        if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1)) continue;
        const fg = over(parse(cs.color), backgroundOf(el));
        const bg = backgroundOf(el);
        const [l1, l2] = [lum(fg), lum(bg)].sort((x, y) => y - x);
        const ratio = (l1 + 0.05) / (l2 + 0.05);
        const size = parseFloat(cs.fontSize); const bold = Number(cs.fontWeight) >= 700;
        const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
        if (ratio < need) out.push(`${(typeof el.className === 'string' && el.className.split(' ')[0]) || el.tagName} "${el.textContent.trim().slice(0, 18)}" ${ratio.toFixed(2)}`);
      }
      return [...new Set(out)];
    });
    check(`contrasto ${scheme === 'light' ? 'giorno' : 'notte'}: testi leggibili (AA)`, bad.length === 0, bad.slice(0, 12).join(' · ') + (bad.length > 12 ? ` … +${bad.length - 12}` : ''));
    await ctx.close();
  }

  check('console: nessun errore o avviso', errors.length === 0, errors.join(' | '));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  return `${results.join('\n')}\n\n${results.length - failed}/${results.length} controlli superati`;
}
