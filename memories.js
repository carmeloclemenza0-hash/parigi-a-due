/* Ricordi condivisi per tappa: pulsante sotto ogni tappa, pannello dal basso, accesso, diario.
 * I dati passano solo da `api` (memories-api.js, o la versione finta dei test). */
(function () {
  const trip = window.PARIS_TRIP;
  const { toast, icon, escapeHTML: esc } = window.PARIS_APP;
  const $ = id => document.getElementById(id);
  const CACHE_KEY = `${trip.storageKey}-memories`;
  const MAX_SIDE = 1600;
  const JPEG_QUALITY = 0.82;
  const MAX_PHOTOS = 6;
  const MAX_NOTE = 2000;

  // Ogni tappa per id, con il suo giorno: serve per titoli e diario.
  const stops = new Map();
  for (const day of trip.days) for (const group of day.groups) for (const item of group.items) stops.set(item.id, { day, item });

  // --- Logica pura (provata in tests/browser-checks.js) ---

  // Misure della foto rimpicciolita: il lato lungo non supera `max`, mai ingrandita.
  function fitWithin(width, height, max = MAX_SIDE) {
    const scale = Math.min(1, max / Math.max(width, height));
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  }

  function countByStop(memories) {
    const counts = {};
    for (const memory of memories) counts[memory.stopId] = (counts[memory.stopId] || 0) + 1;
    return counts;
  }

  // Diario: un gruppo per giorno del viaggio, ricordi in ordine di tempo; i giorni vuoti spariscono.
  function groupByDay(memories) {
    return trip.days
      .map(day => ({ day, memories: memories.filter(m => stops.get(m.stopId)?.day === day).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }))
      .filter(group => group.memories.length);
  }

  window.ParisMemories = { fitWithin, countByStop, groupByDay };

  // --- Stato ---
  let api = null;
  let unavailable = '';       // messaggio se i ricordi non possono funzionare (libreria mancante)
  let user = null;
  let memories = readCache();
  let urls = {};              // percorso foto → URL firmato
  let lastRefresh = 0;

  function readCache() {
    try {
      const saved = JSON.parse(localStorage.getItem(CACHE_KEY));
      // Si accettano solo ricordi con forma giusta e tappe esistenti.
      return Array.isArray(saved) ? saved.filter(m => m && typeof m.id === 'string' && stops.has(m.stopId) && Array.isArray(m.photos)) : [];
    } catch (error) { return []; }
  }
  function writeCache(list) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(list)); }
    catch (error) { toast('Ricordi non salvati per l’uso offline: memoria del telefono piena o bloccata.'); }
  }
  function clearCache() {
    try { localStorage.removeItem(CACHE_KEY); } catch (error) { /* niente da togliere */ }
  }

  // --- Accesso ---
  function renderAccount() {
    const button = $('account-button');
    button.classList.toggle('is-signed-in', Boolean(user));
    button.setAttribute('aria-label', user ? `Ciao ${user.name}: account e uscita` : 'Accedi ai ricordi');
  }
  function openLogin() {
    $('login-error').hidden = true;
    $('login-dialog').showModal();
  }
  function openAccount() {
    $('account-title').textContent = `Ciao ${user.name}.`;
    $('password-status').textContent = '';
    $('new-password').value = '';
    $('account-dialog').showModal();
  }

  $('account-button').addEventListener('click', () => {
    if (unavailable) toast(unavailable);
    else if (user) openAccount();
    else openLogin();
  });

  $('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('login-submit').disabled = true;
    $('login-error').hidden = true;
    try {
      user = await api.signIn($('login-email').value.trim(), $('login-password').value);
      $('login-password').value = '';
      $('login-dialog').close();
      toast(`Ciao ${user.name}! I ricordi sono pronti.`);
      renderAll();
      await refresh();
    } catch (error) {
      $('login-error').textContent = navigator.onLine ? error.message : 'Serve la rete per accedere.';
      $('login-error').hidden = false;
    } finally {
      $('login-submit').disabled = false;
    }
  });

  $('password-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('password-submit').disabled = true;
    try {
      await api.changePassword($('new-password').value);
      $('new-password').value = '';
      $('password-status').textContent = 'Password cambiata.';
    } catch (error) {
      $('password-status').textContent = `Password non cambiata: ${error.message}`;
    } finally {
      $('password-submit').disabled = false;
    }
  });

  $('logout-button').addEventListener('click', async () => {
    try {
      await api.signOut();
    } catch (error) {
      toast(`Uscita non riuscita: ${error.message}`);
      return;
    }
    // Su un telefono condiviso non devono restare ricordi visibili.
    user = null; memories = []; urls = {};
    clearCache();
    $('account-dialog').close();
    renderAll();
    toast('Sei uscito da questo dispositivo.');
  });

  // Chiude il dialog in cui sta il pulsante (Annulla, Chiudi, ×).
  document.addEventListener('click', event => {
    const closer = event.target.closest('[data-close]');
    if (closer) closer.closest('dialog').close();
  });

  // --- Sincronizzazione ---
  async function refresh() {
    if (!user) { renderAll(); return; }
    try {
      memories = await api.list();
      writeCache(memories);
      lastRefresh = Date.now();
      urls = await api.photoUrls(memories.flatMap(m => m.photos));
    } catch (error) {
      // Offline si resta sulla copia salvata, senza disturbare; con la rete l'errore si dice.
      if (navigator.onLine) toast(`Ricordi non aggiornati: ${error.message}`);
    }
    renderAll();
  }

  function renderAll() {
    renderAccount();
  }

  window.addEventListener('online', () => { if (user) refresh(); });
  // Gli URL delle foto scadono dopo un'ora: tornando sull'app dopo un po' si rinnovano.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && user && Date.now() - lastRefresh > 45 * 60 * 1000) refresh();
  });

  (async function init() {
    try {
      api = window.PARIS_MEMORIES_API || window.createMemoriesApi();
    } catch (error) {
      unavailable = error.message;
      renderAll();
      return;
    }
    try {
      user = await api.currentUser();
    } catch (error) {
      toast(`Accesso ai ricordi non verificato: ${error.message}`);
    }
    if (!user) { memories = []; clearCache(); }
    renderAll();
    refresh();
  })();
})();
