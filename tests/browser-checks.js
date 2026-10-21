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

  // Versione finta di Supabase per i test: stessa forma di memories-api.js, dati in memoria.
  // Password valida per entrambi: "password-giusta". Opzioni: signedIn ('Carmelo'|'Adiel'), seed, failList,
  // failSession (true: rete, code 'network'; 'auth': sessione revocata, code 'auth'), failAdd / failSignOut
  // (lanciano 'Failed to fetch' come la rete vera). Da window.__fake si cambiano al volo failSession,
  // listDelay / addDelay (ms di attesa prima della risposta) e si leggono le chiamate a list (listCalls).
  const fakeMemoriesApi = ({ signedIn = null, seed = [], failList = false, failSession = false, failAdd = false, failSignOut = false } = {}) => {
    const people = { 'carmelo@example.test': { id: 'u-carmelo', name: 'Carmelo' }, 'adiel@example.test': { id: 'u-adiel', name: 'Adiel' } };
    const fake = window.__fake = { memories: seed.map(m => ({ ...m })), uploads: [], newPassword: null, failSession, listDelay: 0, addDelay: 0, listCalls: 0 };
    let user = signedIn ? Object.values(people).find(p => p.name === signedIn) : null;
    const needNetwork = () => { if (!navigator.onLine) throw new Error('Failed to fetch'); };
    const wait = ms => ms && new Promise(resolve => setTimeout(resolve, ms));
    const pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
    window.PARIS_MEMORIES_API = {
      async currentUser() {
        if (fake.failSession === 'auth') throw Object.assign(new Error('Sessione scaduta: accedi di nuovo.'), { code: 'auth' });
        if (fake.failSession) throw Object.assign(new Error('Rete assente o instabile.'), { code: 'network' });
        return user;
      },
      async signIn(email, password) { needNetwork(); const p = people[email]; if (!p || password !== 'password-giusta') throw new Error('Email o password non corrette.'); user = p; return p; },
      async signOut() { user = null; if (failSignOut) throw new Error('Failed to fetch'); },
      async changePassword(password) { needNetwork(); fake.newPassword = password; },
      async list() {
        needNetwork(); fake.listCalls++;
        if (failList) throw new Error('Servizio non raggiungibile.');
        // La fotografia del database si fa subito; la risposta può arrivare dopo (listDelay).
        const snapshot = fake.memories.map(m => ({ ...m })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        await wait(fake.listDelay);
        return snapshot;
      },
      async add({ stopId, note, photos }) {
        needNetwork();
        if (!user) throw new Error('Non autenticato.');
        if (failAdd) throw new Error('Failed to fetch');
        const paths = [];
        for (const blob of photos) {
          const bitmap = await createImageBitmap(blob);
          fake.uploads.push({ type: blob.type, width: bitmap.width, height: bitmap.height });
          paths.push(`${stopId}/foto-${fake.uploads.length}.jpg`);
        }
        const memory = { id: `m${Date.now()}${fake.memories.length}`, stopId, authorId: user.id, authorName: user.name, note, photos: paths, createdAt: new Date().toISOString() };
        fake.memories.push(memory);
        // La riga è già nel database, la risposta arriva dopo (addDelay).
        await wait(fake.addDelay);
        return { ...memory };
      },
      async updateNote(id, note) { needNetwork(); if (!user) throw new Error('Non autenticato.'); const m = fake.memories.find(x => x.id === id); if (!m) throw new Error('Ricordo non trovato.'); m.note = note; return { ...m }; },
      async remove(memory) { needNetwork(); fake.memories = fake.memories.filter(m => m.id !== memory.id); },
      async photoUrls(paths) { return Object.fromEntries(paths.map(path => [path, pixel])); }
    };
  };

  async function open(options = {}, { iso, hash = '', savedDay, memories } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', ...options });
    // Nessun test parla col database vero: ogni contesto riceve l'API finta.
    await ctx.addInitScript(fakeMemoriesApi, memories || {});
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
      await c.addInitScript(fakeMemoriesApi, {});
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
    await ctx.addInitScript(fakeMemoriesApi, {});
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    await p.goto(BASE);
    await p.evaluate(() => navigator.serviceWorker.ready);
    const cache = await p.evaluate(async () => ({ keys: await caches.keys(), files: (await (await caches.open('parigi-v6')).keys()).length }));
    check('cache: solo parigi-v6 con 15 file', cache.keys.join() === 'parigi-v6' && cache.files === 15, JSON.stringify(cache));
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

  // 8. Pulsante luna/sole
  {
    const theme = p => p.evaluate(() => ({ theme: document.documentElement.dataset.theme, label: document.getElementById('theme-toggle').getAttribute('aria-label'), bar: document.querySelector('meta[name="theme-color"]').content }));
    // Telefono in modalità chiara: si parte chiari, un tocco passa allo scuro e la scelta resta dopo una ricarica.
    let { ctx, p } = await open({ colorScheme: 'light', isMobile: true, hasTouch: true });
    const start = await theme(p);
    check('tema: segue il telefono (chiaro)', start.theme === 'light' && start.label === 'Passa al tema scuro', JSON.stringify(start));
    await p.locator('#theme-toggle').tap();
    const dark = await theme(p);
    check('tema: il pulsante passa allo scuro', dark.theme === 'dark' && dark.label === 'Passa al tema chiaro' && dark.bar === '#121c18', JSON.stringify(dark));
    await p.reload();
    check('tema: la scelta resta dopo una ricarica', (await theme(p)).theme === 'dark');
    await p.locator('#theme-toggle').tap();
    check('tema: secondo tocco torna al chiaro', (await theme(p)).theme === 'light');
    const header = await p.evaluate(() => {
      const items = [...document.querySelectorAll('.site-header nav > *')].filter(e => getComputedStyle(e).display !== 'none');
      return { names: items.map(e => e.id || e.textContent.trim()), inside: items.every(e => e.getBoundingClientRect().right <= document.documentElement.clientWidth) };
    });
    check('tema: pulsante a sinistra di Itinerario, menu dentro lo schermo', header.names[0] === 'theme-toggle' && header.names[1] === 'Itinerario' && header.inside, JSON.stringify(header));
    await ctx.close();
    // Telefono in modalità scura: si parte scuri.
    ({ ctx, p } = await open({ colorScheme: 'dark', isMobile: true, hasTouch: true, viewport: { width: 320, height: 700 } }));
    const night = await theme(p);
    check('tema: segue il telefono (scuro)', night.theme === 'dark', JSON.stringify(night));
    const fits = await p.evaluate(() => document.querySelector('.header-inner').scrollWidth <= document.querySelector('.header-inner').clientWidth);
    check('tema: intestazione a 320px senza tagli', fits);
    await ctx.close();
  }

  // Testi con contrasto sotto AA. `root`: dove cercare (di default tutta la pagina).
  const contrastIssues = (p, root = 'body') => p.evaluate(root => {
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
      for (const el of document.querySelectorAll(root === 'body' ? 'body *' : `${root} *`)) {
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
  }, root);

  // 9. Contrasto dei testi (WCAG AA) di giorno e di notte, a misura di telefono.
  // Animazioni ridotte, così niente è a metà dissolvenza; le tappe già fatte sono sbiadite di proposito.
  for (const scheme of ['light', 'dark']) {
    const { ctx, p } = await open({ colorScheme: scheme, reducedMotion: 'reduce', isMobile: true, hasTouch: true });
    await p.waitForTimeout(500);
    const bad = await contrastIssues(p);
    check(`contrasto ${scheme === 'light' ? 'giorno' : 'notte'}: testi leggibili (AA)`, bad.length === 0, bad.slice(0, 12).join(' · ') + (bad.length > 12 ? ` … +${bad.length - 12}` : ''));
    await ctx.close();
  }

  // 10. Ricordi: logica pura
  {
    const { ctx, p } = await open();
    const r = await p.evaluate(() => {
      const M = window.ParisMemories;
      const sample = [
        { id: 'a', stopId: 'd1-eiffel', createdAt: '2026-11-05T15:00:00Z' },
        { id: 'b', stopId: 'd1-eiffel', createdAt: '2026-11-05T14:00:00Z' },
        { id: 'c', stopId: window.PARIS_TRIP.days[2].groups[0].items[0].id, createdAt: '2026-11-07T09:00:00Z' }
      ];
      return {
        big: M.fitWithin(4032, 3024), tall: M.fitWithin(1000, 3000), small: M.fitWithin(800, 600),
        counts: M.countByStop(sample),
        days: M.groupByDay(sample).map(g => [g.day.id, g.memories.map(m => m.id).join('')])
      };
    });
    check('ricordi: foto grande ridotta a 1600 px', r.big.width === 1600 && r.big.height === 1200, JSON.stringify(r.big));
    check('ricordi: foto verticale ridotta in altezza', r.tall.width === 533 && r.tall.height === 1600, JSON.stringify(r.tall));
    check('ricordi: foto piccola non ingrandita', r.small.width === 800 && r.small.height === 600);
    check('ricordi: conteggio per tappa', r.counts['d1-eiffel'] === 2, JSON.stringify(r.counts));
    check('ricordi: diario per giorno, in ordine di tempo', JSON.stringify(r.days) === JSON.stringify([[1, 'ba'], [3, 'c']]), JSON.stringify(r.days));
    await ctx.close();
  }

  // 11. Ricordi: accesso
  {
    const { ctx, p } = await open();
    await p.click('#account-button');
    check('accesso: senza login si apre il riquadro Accedi', await p.locator('#login-dialog').evaluate(d => d.open));
    await p.fill('#login-email', 'carmelo@example.test');
    await p.fill('#login-password', 'sbagliata');
    await p.click('#login-submit');
    await p.waitForTimeout(200);
    check('accesso: password sbagliata → messaggio chiaro', (await p.locator('#login-error').textContent()) === 'Email o password non corrette.' && await p.locator('#login-error').isVisible());
    await p.fill('#login-password', 'password-giusta');
    await p.click('#login-submit');
    await p.waitForTimeout(200);
    check('accesso: login riuscito chiude il riquadro', !(await p.locator('#login-dialog').evaluate(d => d.open)));
    check('accesso: pulsante header con il nome', (await p.locator('#account-button').getAttribute('aria-label')) === 'Ciao Carmelo: account e uscita');
    await p.click('#account-button');
    check('accesso: riquadro account saluta Carmelo', (await p.locator('#account-title').textContent()) === 'Ciao Carmelo.');
    await p.fill('#new-password', 'nuovapassword1');
    await p.click('#password-submit');
    await p.waitForTimeout(200);
    check('accesso: cambio password', (await p.evaluate(() => window.__fake.newPassword)) === 'nuovapassword1' && (await p.locator('#password-status').textContent()) === 'Password cambiata.');
    await p.click('#logout-button');
    await p.waitForTimeout(200);
    check('accesso: uscita', (await p.locator('#account-button').getAttribute('aria-label')) === 'Accedi ai ricordi');
    check('accesso: uscita chiude il riquadro e svuota la copia sul telefono', !(await p.locator('#account-dialog').evaluate(d => d.open)) && (await p.evaluate(() => localStorage.getItem('parigi-a-due-2026-v1-memories'))) === null);
    await ctx.close();
  }

  const seed = [
    { id: 'm-c', stopId: 'd1-eiffel', authorId: 'u-carmelo', authorName: 'Carmelo', note: 'La prima volta insieme qui <img src=x onerror="window.__xss=1">', photos: ['d1-eiffel/a.jpg'], createdAt: '2026-11-05T15:10:00Z' },
    { id: 'm-a', stopId: 'd1-eiffel', authorId: 'u-adiel', authorName: 'Adiel', note: 'Che freddo, che bello', photos: [], createdAt: '2026-11-05T15:20:00Z' }
  ];

  // 12. Ricordi: pulsante e pannello
  {
    const { ctx, p } = await open({}, { iso: '2026-11-05T14:00:00Z' });
    check('pannello: senza login la tappa invita ad accedere', (await p.locator('[data-memories="d1-eiffel"]').textContent()) === 'Accedi per i ricordi');
    await p.click('[data-memories="d1-eiffel"]');
    check('pannello: senza login apre il riquadro Accedi', await p.locator('#login-dialog').evaluate(d => d.open));
    await ctx.close();
  }
  {
    const { ctx, p } = await open({}, { iso: '2026-11-05T14:00:00Z', memories: { signedIn: 'Adiel', seed } });
    await p.waitForTimeout(200);
    check('pannello: contatore sulla tappa', (await p.locator('[data-memories="d1-eiffel"]').textContent()) === 'Ricordi · 2');
    check('pannello: tappa senza ricordi', (await p.locator('[data-memories="d1-iena"]').textContent()) === 'Aggiungi un ricordo');
    await p.click('[data-memories="d1-eiffel"]');
    check('pannello: si apre con il titolo della tappa', (await p.locator('#sheet-title').textContent()) === 'Torre Eiffel');
    check('pannello: mostra i due ricordi', await p.locator('#memory-list .memory-card').count() === 2);
    check('pannello: la nota è testo, non codice', !(await p.evaluate(() => window.__xss)) && (await p.locator('#memory-list .memory-note').first().textContent()).includes('<img'));
    check('pannello: Adiel può cancellare solo il suo', await p.locator('#memory-list [data-memory="m-a"] [data-delete]').count() === 1 && await p.locator('#memory-list [data-memory="m-c"] [data-delete]').count() === 0);

    // Nuovo ricordo con una foto grande (3000×2000) creata nel browser.
    await p.fill('#memory-note', 'Il lucchetto sulla Passerelle');
    await p.evaluate(async () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 3000, height: 2000 });
      canvas.getContext('2d').fillRect(0, 0, 3000, 2000);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const input = document.getElementById('memory-photos');
      const files = new DataTransfer(); files.items.add(new File([blob], 'grande.png', { type: 'image/png' }));
      input.files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await p.waitForTimeout(500);
    check('pannello: anteprima della foto scelta', await p.locator('#memory-previews img').count() === 1);
    await p.click('#memory-save');
    await p.waitForTimeout(500);
    const upload = await p.evaluate(() => window.__fake.uploads[0]);
    check('pannello: foto rimpicciolita a 1600 px in JPEG', upload && upload.width === 1600 && upload.height === 1067 && upload.type === 'image/jpeg', JSON.stringify(upload));
    check('pannello: ricordo salvato e contatore aggiornato', (await p.locator('[data-memories="d1-eiffel"]').textContent()) === 'Ricordi · 3' && (await p.locator('#memory-status').textContent()) === 'Ricordo salvato.');
    check('pannello: modulo svuotato dopo il salvataggio', (await p.inputValue('#memory-note')) === '' && await p.locator('#memory-previews img').count() === 0);

    // Modifica della propria nota.
    await p.click('#memory-list [data-memory="m-a"] [data-edit]');
    await p.fill('#memory-list [data-memory="m-a"] .memory-edit', 'Che freddo, che bellissimo');
    await p.click('#memory-list [data-memory="m-a"] [data-save-edit]');
    await p.waitForTimeout(200);
    check('pannello: nota modificata', (await p.locator('#memory-list [data-memory="m-a"] .memory-note').textContent()) === 'Che freddo, che bellissimo');

    // Cancellazione con conferma dentro la pagina.
    await p.click('#memory-list [data-memory="m-a"] [data-delete]');
    check('pannello: chiede conferma prima di cancellare', await p.locator('#memory-list [data-memory="m-a"] [data-confirm-delete]').isVisible());
    await p.click('#memory-list [data-memory="m-a"] [data-confirm-delete]');
    await p.waitForTimeout(200);
    check('pannello: ricordo cancellato', await p.locator('#memory-list [data-memory="m-a"]').count() === 0 && (await p.locator('[data-memories="d1-eiffel"]').textContent()) === 'Ricordi · 2');

    // Senza rete: la bozza resta e si può riprovare.
    await ctx.setOffline(true);
    await p.fill('#memory-note', 'Scritto in metro');
    await p.click('#memory-save');
    await p.waitForTimeout(200);
    check('offline: bozza conservata con messaggio chiaro', (await p.inputValue('#memory-note')) === 'Scritto in metro' && (await p.locator('#memory-status').textContent()).startsWith('Nessuna rete') && (await p.locator('#memory-save').textContent()) === 'Riprova');
    await ctx.setOffline(false);
    await p.click('#memory-save');
    await p.waitForTimeout(300);
    check('offline: “Riprova” salva quando torna la rete', (await p.locator('#memory-status').textContent()) === 'Ricordo salvato.' && (await p.locator('[data-memories="d1-eiffel"]').textContent()) === 'Ricordi · 3');
    await ctx.close();
  }
  {
    // Rete che non risponde: restano i ricordi salvati sul telefono, con un avviso.
    const { ctx, p } = await open({}, { iso: '2026-11-05T14:00:00Z', memories: { signedIn: 'Carmelo', seed, failList: true } });
    await p.evaluate(s => localStorage.setItem('parigi-a-due-2026-v1-memories', JSON.stringify(s)), seed);
    await p.reload();
    await p.waitForTimeout(300);
    check('offline: si vedono i ricordi salvati', (await p.locator('[data-memories="d1-eiffel"]').textContent()) === 'Ricordi · 2');
    check('offline: avviso se il servizio non risponde', (await p.locator('#toast').textContent()).startsWith('Ricordi non aggiornati'));
    await ctx.close();
  }

  // 13. Diario e contrasto dei ricordi
  {
    const { ctx, p } = await open();
    check('diario: senza login invita ad accedere', (await p.locator('#diary').textContent()).includes('solo per noi due'));
    await ctx.close();
  }
  {
    const { ctx, p } = await open({}, { memories: { signedIn: 'Carmelo' } });
    await p.waitForTimeout(200);
    check('diario: vuoto prima del viaggio', (await p.locator('#diary').textContent()).includes('Qui finiranno i vostri ricordi'));
    await ctx.close();
  }
  for (const scheme of ['light', 'dark']) {
    const { ctx, p } = await open({ colorScheme: scheme, reducedMotion: 'reduce', isMobile: true, hasTouch: true }, { iso: '2026-11-05T14:00:00Z', memories: { signedIn: 'Carmelo', seed } });
    await p.waitForTimeout(300);
    const diary = await p.locator('#diary').textContent();
    check(`diario: ricordi raggruppati per giorno (${scheme})`, diary.includes('Giorno 1') && diary.includes('Torre Eiffel') && diary.includes('Che freddo'));
    check(`diario: etichetta della tappa una sola volta per ricordi consecutivi (${scheme})`, (await p.locator('#diary .diary-stop', { hasText: 'Torre Eiffel' }).count()) === 1);
    check(`diario: niente pulsanti Modifica/Cancella (${scheme})`, await p.locator('#diary [data-delete], #diary [data-edit]').count() === 0);
    check(`contrasto ${scheme === 'light' ? 'giorno' : 'notte'}: diario e pulsanti`, (await contrastIssues(p)).length === 0, (await contrastIssues(p)).slice(0, 8).join(' · '));
    await p.click('[data-memories="d1-eiffel"]');
    // Guardia: il controllo vale solo se nel pannello ci sono davvero dei post-it.
    const cards = await p.locator('#memory-sheet .memory-card').count();
    const sheetIssues = await contrastIssues(p, '#memory-sheet');
    check(`contrasto ${scheme === 'light' ? 'giorno' : 'notte'}: pannello dei ricordi`, cards > 0 && sheetIssues.length === 0, `${cards} post-it · ${sheetIssues.slice(0, 8).join(' · ')}`);
    await ctx.close();
  }

  // 14. Ricordi: rete instabile, sessione e modifiche in corso
  const shown = p => p.evaluate(() => `${document.getElementById('toast').textContent} | ${document.getElementById('memory-status').textContent} | ${document.getElementById('password-status').textContent}`);
  {
    // Sessione non verificabile (token scaduto in metro): la copia sul telefono resta e si vede, in sola lettura.
    const { ctx, p } = await open({}, { iso: '2026-11-05T14:00:00Z', memories: { signedIn: 'Carmelo', seed, failSession: true } });
    await p.evaluate(s => localStorage.setItem('parigi-a-due-2026-v1-memories', JSON.stringify(s)), seed);
    await p.reload();
    await p.waitForTimeout(300);
    check('sessione non verificata: si vedono i ricordi salvati', (await p.locator('[data-memories="d1-eiffel"]').textContent()) === 'Ricordi · 2');
    check('sessione non verificata: la copia sul telefono resta', (await p.evaluate(() => JSON.parse(localStorage.getItem('parigi-a-due-2026-v1-memories') || '[]').length)) === 2);
    const text = await shown(p);
    check('sessione non verificata: messaggio in italiano, senza "fetch"', !/fetch/i.test(text) && (await p.locator('#toast').textContent()).includes('sola lettura'), text);
    await p.click('[data-memories="d1-eiffel"]');
    check('sessione non verificata: pannello in sola lettura', await p.locator('#memory-list .memory-card').count() === 2 && await p.locator('#memory-form').isHidden() && await p.locator('#memory-list [data-delete]').count() === 0);
    await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()));
    // Torna la rete: si riprova la sessione e poi si aggiorna.
    await p.evaluate(() => { window.__fake.failSession = false; window.dispatchEvent(new Event('online')); });
    await p.waitForTimeout(300);
    check('sessione: al ritorno della rete si riprova e si aggiorna', (await p.locator('#account-button').getAttribute('aria-label')) === 'Ciao Carmelo: account e uscita' && (await p.locator('[data-memories="d1-eiffel"]').textContent()) === 'Ricordi · 2');
    await ctx.close();
  }
  {
    // Errori di rete: messaggi in italiano, mai "Failed to fetch".
    const { ctx, p } = await open({}, { iso: '2026-11-05T14:00:00Z', memories: { signedIn: 'Adiel', seed } });
    await p.waitForTimeout(200);
    await ctx.setOffline(true);
    await p.click('#account-button');
    await p.fill('#new-password', 'nuovapassword1');
    await p.click('#password-submit');
    await p.waitForTimeout(200);
    let text = await shown(p);
    check('rete assente: cambio password con messaggio italiano', !/fetch/i.test(text) && text.includes('Rete assente'), text);
    await p.click('#account-dialog [data-close]');
    await p.click('[data-memories="d1-eiffel"]');
    await p.click('#memory-list [data-memory="m-a"] [data-edit]');
    await p.fill('#memory-list [data-memory="m-a"] .memory-edit', 'Scritto senza rete');
    await p.click('#memory-list [data-memory="m-a"] [data-save-edit]');
    await p.waitForTimeout(200);
    text = await shown(p);
    check('rete assente: modifica nota con messaggio italiano', !/fetch/i.test(text) && text.includes('Rete assente'), text);
    await ctx.setOffline(false);
    // Modifica in corso + aggiornamento dalla rete: il testo scritto resta.
    await p.fill('#memory-list [data-memory="m-a"] .memory-edit', 'Una modifica a metà');
    await p.evaluate(() => window.dispatchEvent(new Event('online')));
    await p.waitForTimeout(300);
    const kept = await p.locator('#memory-list [data-memory="m-a"] .memory-edit').count() ? await p.inputValue('#memory-list [data-memory="m-a"] .memory-edit') : '(textarea sparita)';
    check('modifica in corso: resta dopo un aggiornamento', kept === 'Una modifica a metà', kept);
    await p.click('#memory-list [data-memory="m-a"] [data-cancel]');
    await p.click('#memory-list [data-memory="m-a"] [data-delete]');
    await p.evaluate(() => window.dispatchEvent(new Event('online')));
    await p.waitForTimeout(300);
    check('conferma di cancellazione: resta dopo un aggiornamento', await p.locator('#memory-list [data-memory="m-a"] [data-confirm-delete]').isVisible());
    await ctx.close();
  }
  {
    // Salvataggio che fallisce davvero: bozza tenuta, "Riprova", messaggio italiano.
    const { ctx, p } = await open({}, { iso: '2026-11-05T14:00:00Z', memories: { signedIn: 'Carmelo', seed, failAdd: true } });
    await p.waitForTimeout(200);
    await p.click('[data-memories="d1-eiffel"]');
    await p.fill('#memory-note', 'Da non perdere');
    await p.click('#memory-save');
    await p.waitForTimeout(300);
    const text = await shown(p);
    check('salvataggio fallito: bozza tenuta e “Riprova”', (await p.inputValue('#memory-note')) === 'Da non perdere' && (await p.locator('#memory-save').textContent()) === 'Riprova');
    check('salvataggio fallito: messaggio italiano, senza "fetch"', !/fetch/i.test(text) && text.includes('Rete assente'), text);
    await ctx.close();
  }
  {
    // Uscita senza risposta dal server: sul telefono non resta niente.
    const { ctx, p } = await open({}, { iso: '2026-11-05T14:00:00Z', memories: { signedIn: 'Carmelo', seed, failSignOut: true } });
    await p.waitForTimeout(200);
    await p.click('[data-memories="d1-eiffel"]');
    await p.fill('#memory-note', 'Bozza privata');
    await p.click('#memory-sheet [data-close]');
    await p.click('#account-button');
    await p.click('#logout-button');
    await p.waitForTimeout(200);
    const state = await p.evaluate(() => ({ label: document.getElementById('account-button').getAttribute('aria-label'), cache: localStorage.getItem('parigi-a-due-2026-v1-memories'), dialogs: [...document.querySelectorAll('dialog')].filter(d => d.open).length, toast: document.getElementById('toast').textContent }));
    check('uscita senza server: ricordi tolti dal telefono', state.label === 'Accedi ai ricordi' && state.cache === null && state.dialogs === 0 && state.toast.startsWith('Sei uscito da questo dispositivo.'), JSON.stringify(state));
    // Rientro: la bozza della sessione precedente non c'è più.
    await p.click('#account-button');
    await p.fill('#login-email', 'carmelo@example.test');
    await p.fill('#login-password', 'password-giusta');
    await p.click('#login-submit');
    await p.waitForTimeout(200);
    await p.click('[data-memories="d1-eiffel"]');
    check('uscita: le bozze sono cancellate', (await p.inputValue('#memory-note')) === '');
    await ctx.close();
  }

  {
    // Sessione revocata davvero (non la rete): si esce come con "Esci", senza mostrare la copia privata.
    const { ctx, p } = await open({}, { iso: '2026-11-05T14:00:00Z', memories: { signedIn: 'Carmelo', seed, failSession: 'auth' } });
    await p.evaluate(s => localStorage.setItem('parigi-a-due-2026-v1-memories', JSON.stringify(s)), seed);
    await p.reload();
    await p.waitForTimeout(300);
    const state = await p.evaluate(() => ({ label: document.getElementById('account-button').getAttribute('aria-label'), stop: document.querySelector('[data-memories="d1-eiffel"]').textContent, cache: localStorage.getItem('parigi-a-due-2026-v1-memories'), toast: document.getElementById('toast').textContent }));
    check('sessione scaduta: si esce e la copia sul telefono sparisce', state.label === 'Accedi ai ricordi' && state.stop === 'Accedi per i ricordi' && state.cache === null, JSON.stringify(state));
    check('sessione scaduta: messaggio "Sessione scaduta: accedi di nuovo."', state.toast === 'Sessione scaduta: accedi di nuovo.', state.toast);
    await ctx.close();
  }
  {
    // Salvataggio e aggiornamento che si incrociano: niente doppioni, niente ricordi cancellati che ricompaiono.
    const { ctx, p } = await open({}, { iso: '2026-11-05T14:00:00Z', memories: { signedIn: 'Adiel', seed } });
    await p.waitForTimeout(200);
    await p.click('[data-memories="d1-eiffel"]');
    await p.fill('#memory-note', 'Salvato mentre si aggiorna');
    await p.evaluate(() => { window.__fake.addDelay = 300; });
    await p.click('#memory-save');
    await p.waitForTimeout(50);
    // L'aggiornamento parte mentre la risposta del salvataggio è in viaggio: la lista ha già la riga nuova.
    await p.evaluate(() => window.dispatchEvent(new Event('online')));
    await p.waitForTimeout(600);
    const added = { cards: await p.locator('#memory-list .memory-card').count(), label: await p.locator('[data-memories="d1-eiffel"]').textContent() };
    check('aggiornamento durante il salvataggio: niente doppioni', added.cards === 3 && added.label === 'Ricordi · 3', JSON.stringify(added));
    // Una lista partita prima della cancellazione arriva dopo: il ricordo cancellato non deve tornare.
    await p.evaluate(() => { window.__fake.addDelay = 0; window.__fake.listDelay = 400; });
    await p.click('#memory-list [data-memory="m-a"] [data-delete]');
    await p.evaluate(() => window.dispatchEvent(new Event('online')));
    await p.click('#memory-list [data-memory="m-a"] [data-confirm-delete]');
    await p.waitForTimeout(700);
    const removed = { gone: await p.locator('#memory-list [data-memory="m-a"]').count() === 0, label: await p.locator('[data-memories="d1-eiffel"]').textContent(), cache: await p.evaluate(() => JSON.parse(localStorage.getItem('parigi-a-due-2026-v1-memories')).some(m => m.id === 'm-a')) };
    check('aggiornamento durante la cancellazione: il ricordo non ricompare', removed.gone && removed.label === 'Ricordi · 2' && !removed.cache, JSON.stringify(removed));
    await ctx.close();
  }
  {
    // Tornando sull'app entro un minuto non si riscarica niente, anche se non ci sono foto (prima: ogni volta).
    const { ctx, p } = await open({}, { iso: '2026-11-05T14:00:00Z', memories: { signedIn: 'Adiel', seed: [seed[1]] } });
    await p.waitForTimeout(300);
    const calls = () => p.evaluate(() => window.__fake.listCalls);
    const first = await calls();
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.waitForTimeout(200);
    const soon = await calls();
    await p.clock.fastForward(61000);
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.waitForTimeout(200);
    const later = await calls();
    check('ritorno sull’app: entro 1 minuto niente nuovo scaricamento, dopo sì', first === 1 && soon === 1 && later === 2, `${first} → ${soon} → ${later}`);
    await ctx.close();
  }

  // 15. Adattatore Supabase vero (memories-api.js) con rete simulata: ogni richiesta a supabase.co riceve
  // una risposta scritta qui con route.fulfill, niente arriva al database vero. Qui la console non si controlla:
  // gli avvisi con l'errore originale (in inglese) sono voluti.
  {
    const SUPA = 'https://syyxotzmlpgwdnbgzetc.supabase.co';
    const AUTH = 'parigi-a-due-2026-v1-auth';
    const MEMBERS = 'parigi-a-due-2026-v1-members';
    const net = { signIn: null, refresh: 'refresh_token_not_found', members: 'ok', membersDelay: 0, logout: null, logoutDelay: 0, failUpload: 0, uploads: 0, active: 0, maxActive: 0, uploaded: [], removed: [], inserts: 0 };
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    // Il contesto può chiudersi con una risposta ancora in attesa: lì l'errore di fulfill non interessa.
    const reply = (route, status, body) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
    const later = ms => new Promise(resolve => setTimeout(resolve, ms));
    const session = (token, id, ttl = 3600) => ({ access_token: token, refresh_token: `r-${token}`, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + ttl, user: { id, aud: 'authenticated', role: 'authenticated', email: `${id}@example.test` } });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await ctx.addInitScript(fakeMemoriesApi, {}); // la pagina usa la finta; l'adattatore vero si crea a mano qui sotto
    await ctx.route(`${SUPA}/**`, async route => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors }).catch(() => {});
      if (path === '/auth/v1/token') {
        if (url.searchParams.get('grant_type') === 'refresh_token') return reply(route, 400, { code: net.refresh, error_code: net.refresh, msg: 'Invalid Refresh Token' });
        if (net.signIn) return reply(route, 400, { code: net.signIn, error_code: net.signIn, msg: 'refused' });
        return reply(route, 200, session('tok-new', 'u-carmelo'));
      }
      if (path === '/auth/v1/logout') {
        net.logout = { scope: url.searchParams.get('scope'), auth: request.headers().authorization };
        await later(net.logoutDelay);
        return route.fulfill({ status: 204, headers: cors }).catch(() => {});
      }
      if (path === '/rest/v1/couple_members') {
        await later(net.membersDelay);
        if (net.members === 'abort') return route.abort('failed').catch(() => {});
        if (net.members === 'jwt') return reply(route, 401, { code: 'PGRST303', message: 'JWT expired', details: null, hint: null });
        return reply(route, 200, [{ user_id: 'u-carmelo', name: 'Carmelo' }, { user_id: 'u-adiel', name: 'Adiel' }]);
      }
      if (path.startsWith('/storage/v1/object/memories/') && request.method() === 'POST') {
        const n = ++net.uploads;
        net.active++; net.maxActive = Math.max(net.maxActive, net.active);
        await later(150);
        net.active--;
        if (n === net.failUpload) return reply(route, 400, { statusCode: '400', error: 'Bad Request', message: 'upload refused' });
        net.uploaded.push(decodeURIComponent(path.slice('/storage/v1/object/memories/'.length)));
        return reply(route, 200, { Key: path.slice('/storage/v1/object/'.length), Id: `f${n}` });
      }
      if (path === '/storage/v1/object/memories' && request.method() === 'DELETE') { net.removed.push(...(request.postDataJSON().prefixes || [])); return reply(route, 200, []); }
      if (path === '/rest/v1/memories' && request.method() === 'POST') {
        net.inserts++;
        const row = request.postDataJSON();
        return reply(route, 201, { id: 'm-new', author_id: 'u-carmelo', created_at: new Date().toISOString(), ...(Array.isArray(row) ? row[0] : row) });
      }
      return reply(route, 404, { message: 'richiesta non prevista dal test' });
    });
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    await p.goto(BASE);
    const store = (key, value) => p.evaluate(([key, value]) => value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)), [key, value]);

    // Rete "appesa" sui nomi: currentUser non resta bloccato, usa la sessione e i nomi salvati.
    await store(AUTH, session('tok-old', 'u-carmelo'));
    await store(MEMBERS, { 'u-carmelo': 'Carmelo' });
    net.membersDelay = 8000;
    const slow = await p.evaluate(async () => {
      const start = performance.now();
      try { return { user: await window.createMemoriesApi().currentUser(), ms: Math.round(performance.now() - start) }; }
      catch (error) { return { error: error.message, ms: Math.round(performance.now() - start) }; }
    });
    net.membersDelay = 0;
    check('adattatore: nomi che non arrivano → utente salvato entro pochi secondi', slow.user?.name === 'Carmelo' && slow.ms < 4500, JSON.stringify(slow));

    // Errori di currentUser: rete e autenticazione si distinguono (code); un'autenticazione rifiutata toglie la sessione.
    const userError = () => p.evaluate(async auth => {
      try { return { user: await window.createMemoriesApi().currentUser(), left: localStorage.getItem(auth) }; }
      catch (error) { return { message: error.message, code: error.code, left: localStorage.getItem(auth) }; }
    }, AUTH);
    await store(AUTH, session('tok-old', 'u-carmelo'));
    await store(MEMBERS, null);
    net.members = 'jwt';
    const jwt = await userError();
    check('adattatore: token rifiutato dal database → errore "auth" e sessione tolta', jwt.code === 'auth' && jwt.left === null && !/jwt/i.test(jwt.message || ''), JSON.stringify(jwt));
    await store(AUTH, session('tok-old', 'u-carmelo'));
    net.members = 'abort';
    const offline = await userError();
    // La query dei nomi si ritenta da sola: o arriva un errore "network" o, dopo 3 s, la sessione salvata. Mai un'uscita.
    check('adattatore: rete giù senza nomi salvati → sessione tenuta (errore "network" o utente salvato)', (offline.code === 'network' || offline.user?.id === 'u-carmelo') && offline.left !== null, JSON.stringify({ ...offline, left: Boolean(offline.left) }));
    net.members = 'ok';
    await store(AUTH, session('tok-exp', 'u-carmelo', -7200));
    const revoked = await userError();
    check('adattatore: rinnovo rifiutato (refresh_token_not_found) → nessuna sessione', (revoked.user === null || revoked.code === 'auth') && revoked.left === null, JSON.stringify(revoked));

    // Accesso rifiutato: messaggio giusto per ogni caso.
    const signInMessage = code => { net.signIn = code; return p.evaluate(async () => { try { await window.createMemoriesApi().signIn('carmelo@example.test', 'x'); return 'entrato'; } catch (error) { return error.message; } }); };
    const wrong = await signInMessage('invalid_credentials');
    const unconfirmed = await signInMessage('email_not_confirmed');
    const other = await signInMessage('validation_failed');
    net.signIn = null;
    check('adattatore: credenziali sbagliate', wrong === 'Email o password non corrette.', wrong);
    check('adattatore: account non confermato', unconfirmed === 'Account non ancora confermato: va confermato dalla dashboard di Supabase.', unconfirmed);
    check('adattatore: altro rifiuto → messaggio generico, non "password sbagliata"', other === 'Accesso non riuscito.', other);

    // "Esci" lento seguito da un nuovo accesso: chiavi tolte subito, solo questo dispositivo, la sessione nuova resta.
    await store(AUTH, session('tok-old', 'u-carmelo'));
    await store(MEMBERS, { 'u-carmelo': 'Carmelo' });
    net.logoutDelay = 800;
    const race = await p.evaluate(async auth => {
      const api = window.createMemoriesApi();
      const out = api.signOut();
      await new Promise(resolve => setTimeout(resolve, 50));
      const clearedAtOnce = localStorage.getItem(auth) === null;
      await api.signIn('carmelo@example.test', 'password-giusta');
      await out.catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 300));
      return { clearedAtOnce, token: JSON.parse(localStorage.getItem(auth) || 'null')?.access_token || null };
    }, AUTH);
    net.logoutDelay = 0;
    check('adattatore: “Esci” vale solo per questo dispositivo (scope local)', net.logout?.scope === 'local' && net.logout.auth === 'Bearer tok-old', JSON.stringify(net.logout));
    check('adattatore: uscita lenta non cancella il nuovo accesso', race.clearedAtOnce && race.token === 'tok-new', JSON.stringify(race));

    // Foto caricate 3 alla volta; se una fallisce, nessun ricordo e nessuna foto orfana.
    const addPhotos = () => p.evaluate(async () => {
      const photos = Array.from({ length: 5 }, () => new Blob(['x'], { type: 'image/jpeg' }));
      try { return (await window.createMemoriesApi().add({ stopId: 'd1-eiffel', note: 'prova', photos })).photos.length; }
      catch (error) { return error.message; }
    });
    await store(AUTH, session('tok-old', 'u-carmelo'));
    const saved = await addPhotos();
    check('adattatore: foto caricate 3 alla volta', saved === 5 && net.maxActive === 3 && net.inserts === 1, JSON.stringify({ saved, maxActive: net.maxActive, inserts: net.inserts }));
    Object.assign(net, { uploads: 0, active: 0, maxActive: 0, uploaded: [], removed: [], inserts: 0, failUpload: 2 });
    const failed = await addPhotos();
    const leftovers = net.uploaded.filter(path => !net.removed.includes(path));
    check('adattatore: una foto rifiutata → nessun ricordo, foto già caricate tolte', failed === 'Foto non caricata.' && net.inserts === 0 && net.uploaded.length > 0 && leftovers.length === 0, JSON.stringify({ failed, uploaded: net.uploaded.length, removed: net.removed.length, leftovers }));
    await ctx.close();
  }

  // 16. Fluidità: ritmo unico, cambio giorno animato, swipe, linguette compatte, effetti di scroll
  {
    const { ctx, p } = await open({ isMobile: true, hasTouch: true }, { hash: '#giorno-1' });
    const tokens = await p.evaluate(() => ['--dur-fast', '--dur-base', '--dur-slow'].map(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim()));
    check('ritmo: durate condivise', tokens.join() === '.2s,.3s,.4s', tokens.join());
    await p.locator('#timeline').scrollIntoViewIfNeeded();
    await p.waitForTimeout(600);
    const staggers = await p.evaluate(() => [...document.querySelectorAll('.timeline-item.is-visible')].map(e => e.style.getPropertyValue('--stagger')));
    check('tappe sfalsate: ritardo crescente, massimo 300 ms', staggers.length > 1 && staggers[0] === '0ms' && staggers[1] === '60ms' && staggers.every(s => parseInt(s) <= 300), staggers.join());
    const duration = await p.locator('.timeline-item').first().evaluate(e => getComputedStyle(e).transitionDuration);
    check('tappe sfalsate: durata del ritmo lento', duration.startsWith('0.4s'), duration);
    await ctx.close();
  }

  check('console: nessun errore o avviso', errors.length === 0, errors.join(' | '));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  return `${results.join('\n')}\n\n${results.length - failed}/${results.length} controlli superati`;
}
