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

  // --- Pulsanti sotto le tappe ---
  function buttonLabel(stopId, counts) {
    if (unavailable) return 'Ricordi non disponibili';
    if (!user) return 'Accedi per i ricordi';
    return counts[stopId] ? `Ricordi · ${counts[stopId]}` : 'Aggiungi un ricordo';
  }
  function renderButtons() {
    const counts = countByStop(memories);
    for (const button of document.querySelectorAll('[data-memories]')) {
      button.textContent = buttonLabel(button.dataset.memories, counts);
      button.classList.toggle('has-memories', Boolean(user && counts[button.dataset.memories]));
      button.disabled = Boolean(unavailable);
    }
  }
  document.addEventListener('timeline:rendered', renderButtons);

  // --- Post-it di un ricordo (pannello e diario) ---
  const timeFormat = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  function memoryCard(memory, editable) {
    const photos = memory.photos.map(path => urls[path]
      ? `<button type="button" class="memory-photo" data-photo="${esc(path)}"><img src="${esc(urls[path])}" alt="Foto di ${esc(memory.authorName)}" loading="lazy"></button>`
      : '<span class="memory-photo is-missing">Foto visibile con la rete</span>').join('');
    const own = editable && user && memory.authorId === user.id;
    return `<article class="memory-card" data-memory="${esc(memory.id)}">${memory.note ? `<p class="memory-note">${esc(memory.note)}</p>` : ''}${photos ? `<div class="memory-photos">${photos}</div>` : ''}<footer class="memory-meta"><span>${esc(memory.authorName)} · ${esc(timeFormat.format(new Date(memory.createdAt)))}</span>${own ? '<span class="memory-actions"><button type="button" class="text-button" data-edit>Modifica</button><button type="button" class="text-button" data-delete>Cancella</button></span>' : ''}</footer></article>`;
  }

  // --- Pannello dal basso ---
  let openStop = null;
  const drafts = {};          // bozze per tappa: { note, photos: Blob[] } — restano finché la pagina è aperta
  let previewUrls = [];

  function setStatus(message, isError = false) {
    $('memory-status').textContent = message;
    $('memory-status').classList.toggle('is-error', isError);
  }
  function openSheet(stopId) {
    if (!user) { openLogin(); return; }
    openStop = stopId;
    drafts[stopId] ||= { note: '', photos: [] };
    $('sheet-title').textContent = stops.get(stopId).item.title;
    $('memory-note').value = drafts[stopId].note;
    $('memory-save').textContent = 'Salva';
    setStatus('');
    renderSheet();
    $('memory-sheet').showModal();
  }
  function renderSheet() {
    if (!openStop) return;
    const list = memories.filter(m => m.stopId === openStop);
    $('memory-list').innerHTML = list.length ? list.map(m => memoryCard(m, true)).join('') : '<p class="memory-empty">Ancora nessun ricordo qui.</p>';
    renderPreviews();
  }
  function renderPreviews() {
    previewUrls.forEach(url => URL.revokeObjectURL(url));
    previewUrls = (drafts[openStop]?.photos || []).map(blob => URL.createObjectURL(blob));
    $('memory-previews').innerHTML = previewUrls.map((url, i) => `<span class="memory-preview"><img src="${url}" alt="Foto ${i + 1} da salvare"><button type="button" data-unpick="${i}" aria-label="Togli la foto ${i + 1}">×</button></span>`).join('');
  }
  $('memory-sheet').addEventListener('close', () => {
    if (openStop) drafts[openStop].note = $('memory-note').value;
    openStop = null;
  });

  // Foto rimpicciolita nel browser: lato lungo 1600 px, JPEG.
  async function resizePhoto(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const size = fitWithin(bitmap.width, bitmap.height);
    const canvas = Object.assign(document.createElement('canvas'), size);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close();
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Foto non leggibile.')), 'image/jpeg', JPEG_QUALITY));
  }

  $('memory-photos').addEventListener('change', async event => {
    const files = [...event.target.files];
    event.target.value = '';
    const draft = drafts[openStop];
    const room = Math.max(0, MAX_PHOTOS - draft.photos.length);
    if (files.length > room) setStatus(`Al massimo ${MAX_PHOTOS} foto per ricordo: ne ho tenute ${room}.`, true);
    for (const file of files.slice(0, room)) {
      try { draft.photos.push(await resizePhoto(file)); }
      catch (error) { setStatus(`“${file.name}” non si riesce a leggere come foto.`, true); }
    }
    renderPreviews();
  });

  $('memory-form').addEventListener('submit', async event => {
    event.preventDefault();
    const stopId = openStop;
    const draft = drafts[stopId];
    draft.note = $('memory-note').value;
    const note = draft.note.trim().slice(0, MAX_NOTE);
    if (!note && !draft.photos.length) { setStatus('Scrivi qualcosa o aggiungi una foto.', true); return; }
    if (!navigator.onLine) {
      setStatus('Nessuna rete: il ricordo è rimasto qui. Tocca “Riprova” quando torni online.', true);
      $('memory-save').textContent = 'Riprova';
      return;
    }
    $('memory-save').disabled = true;
    $('memory-save').textContent = 'Salvo…';
    let saved;
    try {
      saved = await api.add({ stopId, note, photos: draft.photos });
    } catch (error) {
      setStatus(`Non salvato: ${error.message} Il ricordo è rimasto qui: tocca “Riprova”.`, true);
      $('memory-save').textContent = 'Riprova';
      return;
    } finally {
      $('memory-save').disabled = false;
    }
    memories.push(saved);
    writeCache(memories);
    drafts[stopId] = { note: '', photos: [] };
    $('memory-note').value = '';
    $('memory-save').textContent = 'Salva';
    try { Object.assign(urls, await api.photoUrls(saved.photos)); }
    catch (error) { toast(`Ricordo salvato, ma le foto si vedranno al prossimo aggiornamento: ${error.message}`); }
    renderAll();
    setStatus('Ricordo salvato.');
  });

  // Modifica e cancellazione: solo i propri ricordi, con conferma dentro il post-it.
  $('memory-list').addEventListener('click', async event => {
    const card = event.target.closest('[data-memory]');
    const memory = card && memories.find(m => m.id === card.dataset.memory);
    if (!memory) return;
    if (event.target.closest('[data-delete]')) {
      card.querySelector('.memory-meta').innerHTML = '<span>Cancellare questo ricordo?</span><span class="memory-actions"><button type="button" class="text-button" data-cancel>No</button><button type="button" class="text-button danger" data-confirm-delete>Sì, cancella</button></span>';
    } else if (event.target.closest('[data-confirm-delete]')) {
      try {
        await api.remove(memory);
        memories = memories.filter(m => m.id !== memory.id);
        writeCache(memories);
        renderAll();
        setStatus('Ricordo cancellato.');
      } catch (error) { setStatus(`Non cancellato: ${error.message}`, true); }
    } else if (event.target.closest('[data-edit]')) {
      card.innerHTML = `<textarea class="memory-edit" maxlength="${MAX_NOTE}" aria-label="Modifica la nota">${esc(memory.note)}</textarea><footer class="memory-meta"><span></span><span class="memory-actions"><button type="button" class="text-button" data-cancel>Annulla</button><button type="button" class="text-button danger" data-save-edit>Salva</button></span></footer>`;
      card.querySelector('textarea').focus();
    } else if (event.target.closest('[data-save-edit]')) {
      const note = card.querySelector('textarea').value.trim().slice(0, MAX_NOTE);
      if (!note && !memory.photos.length) { setStatus('Un ricordo senza foto ha bisogno di una nota.', true); return; }
      try {
        const updated = await api.updateNote(memory.id, note);
        memories = memories.map(m => m.id === memory.id ? updated : m);
        writeCache(memories);
        renderAll();
        setStatus('Nota modificata.');
      } catch (error) { setStatus(`Modifica non salvata: ${error.message}`, true); }
    } else if (event.target.closest('[data-cancel]')) {
      renderSheet();
    }
  });
  $('memory-previews').addEventListener('click', event => {
    const unpick = event.target.closest('[data-unpick]');
    if (!unpick) return;
    drafts[openStop].photos.splice(Number(unpick.dataset.unpick), 1);
    renderPreviews();
  });

  // Pulsanti sparsi nella pagina: tappa, foto da ingrandire, "Accedi" del diario.
  document.addEventListener('click', event => {
    const stopButton = event.target.closest('[data-memories]');
    const photo = event.target.closest('[data-photo]');
    if (stopButton) openSheet(stopButton.dataset.memories);
    else if (photo && urls[photo.dataset.photo]) {
      $('photo-viewer-img').src = urls[photo.dataset.photo];
      $('photo-viewer').showModal();
    } else if (event.target.closest('[data-login]')) openLogin();
  });

  // --- Diario: tutti i ricordi, giorno per giorno ---
  function renderDiary() {
    const box = $('diary');
    if (unavailable) { box.innerHTML = `<p class="diary-empty">${esc(unavailable)}</p>`; return; }
    if (!user) { box.innerHTML = '<p class="diary-empty">Il diario è solo per noi due.</p><button type="button" class="button secondary" data-login>Accedi</button>'; return; }
    const groups = groupByDay(memories);
    box.innerHTML = groups.length
      ? groups.map(({ day, memories: list }) => `<section class="diary-day"><h3>Giorno ${day.id} · ${esc(day.weekday)} ${esc(day.shortDate)}</h3>${list.map(m => `<p class="diary-stop">${esc(stops.get(m.stopId).item.title)}</p>${memoryCard(m, false)}`).join('')}</section>`).join('')
      : '<p class="diary-empty">Qui finiranno i vostri ricordi: tocca “Aggiungi un ricordo” sotto una tappa.</p>';
  }

  function renderAll() {
    renderAccount();
    renderButtons();
    renderSheet();
    renderDiary();
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
