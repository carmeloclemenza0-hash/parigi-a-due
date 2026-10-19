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
  // Tornando sull'app: lista riletta dopo 1 minuto, URL delle foto (validi 1 h) rinnovati dopo 45.
  const LIST_REFRESH_MS = 60 * 1000;
  const URL_RENEW_MS = 45 * 60 * 1000;
  const NETWORK_MESSAGE = 'Rete assente o instabile.';

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
  let sessionFailed = false;  // sessione non verificabile (rete): si mostra la copia salvata in sola lettura
  let sessionRetry = false;   // verifica della sessione da ripetere al ritorno della rete o sull'app
  let memories = readCache();
  let urls = {};              // percorso foto → URL firmato
  let lastList = 0;           // ultimo elenco scaricato e usato
  let lastUrls = 0;           // ultimo rinnovo completo degli URL foto
  // Cambia a ogni accesso/uscita: le risposte arrivate dopo appartengono a un'altra sessione e si scartano.
  let generation = 0;
  // Cambia a ogni salvataggio/modifica/cancellazione riusciti: un elenco chiesto prima è vecchio e si scarta.
  let localVersion = 0;
  const editing = {};         // modifiche di nota in corso: id ricordo → testo scritto finora
  const confirming = new Set(); // ricordi con la domanda "Cancellare?" aperta
  const busy = new Set();     // ricordi con una richiesta in corso (niente doppio tap)

  const canSee = () => Boolean(user) || sessionFailed;
  // Messaggio da mostrare: mai l'inglese di "Failed to fetch".
  function reason(error) {
    const message = (error && error.message) || '';
    return !navigator.onLine || /failed to fetch|networkerror|load failed|network request failed/i.test(message) ? NETWORK_MESSAGE : message || 'errore sconosciuto.';
  }

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
  // Ricordo nuovo o aggiornato: si sostituisce per id, così un aggiornamento arrivato prima non crea doppioni.
  function putMemory(memory) {
    const index = memories.findIndex(m => m.id === memory.id);
    memories = index < 0 ? [...memories, memory] : memories.map((m, i) => i === index ? memory : m);
    localVersion++;
    writeCache(memories);
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
      sessionFailed = false;
      sessionRetry = false;
      generation++;
      $('login-password').value = '';
      $('login-dialog').close();
      toast(`Ciao ${user.name}! I ricordi sono pronti.`);
      renderAll();
      await refresh();
    } catch (error) {
      $('login-error').textContent = navigator.onLine ? reason(error) : 'Serve la rete per accedere.';
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
      $('password-status').textContent = `Password non cambiata: ${reason(error)}`;
    } finally {
      $('password-submit').disabled = false;
    }
  });

  // Su un telefono condiviso non deve restare niente: ricordi, foto, bozze, finestre aperte.
  function forgetLocal() {
    generation++;
    openStop = null;          // prima di chiudere: il "close" del pannello non deve salvare la bozza
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    user = null; sessionFailed = false; sessionRetry = false; memories = []; urls = {}; lastList = 0; lastUrls = 0;
    clearCache();
    for (const key of Object.keys(drafts)) delete drafts[key];
    for (const key of Object.keys(editing)) delete editing[key];
    confirming.clear(); busy.clear(); saving.clear();
    $('memory-note').value = '';
    previewUrls.forEach(url => URL.revokeObjectURL(url));
    previewUrls = [];
    $('memory-previews').innerHTML = '';
    $('photo-viewer-img').removeAttribute('src');
    renderAll();
  }

  $('logout-button').addEventListener('click', async () => {
    $('logout-button').disabled = true;
    let problem = '';
    try { await api.signOut(); }
    catch (error) { problem = reason(error); }
    finally { $('logout-button').disabled = false; }
    // La pulizia sul telefono si fa sempre, anche se il server non risponde.
    forgetLocal();
    toast(problem ? `Sei uscito da questo dispositivo. Il server non ha confermato (${problem}): lì l’accesso scade da solo.` : 'Sei uscito da questo dispositivo.');
  });

  // Chiude il dialog in cui sta il pulsante (Annulla, Chiudi, ×).
  document.addEventListener('click', event => {
    const closer = event.target.closest('[data-close]');
    if (closer) closer.closest('dialog').close();
  });

  // --- Sincronizzazione ---
  async function refresh() {
    if (!user) { renderAll(); return; }
    const mine = generation;
    const version = localVersion;
    let problem = '';
    // Elenco e foto in due tentativi separati: se fallisce solo una parte, l'altra si tiene.
    try {
      const list = await api.list();
      if (mine !== generation) return;
      // Nel frattempo qui si è salvato/cancellato qualcosa: l'elenco può non saperlo, si tiene quello locale
      // (il prossimo aggiornamento porterà le novità dell'altro telefono).
      if (version === localVersion) {
        memories = list;
        writeCache(memories);
        lastList = Date.now();
      }
    } catch (error) {
      if (mine !== generation) return;
      problem = `Ricordi non aggiornati: ${reason(error)}`;
    }
    // URL firmati: tutti quando i vecchi stanno per scadere, altrimenti solo quelli che mancano.
    const stale = Date.now() - lastUrls > URL_RENEW_MS;
    const wanted = memories.flatMap(m => m.photos).filter(path => stale || !urls[path]);
    if (wanted.length) {
      try {
        const fresh = await api.photoUrls(wanted);
        if (mine !== generation) return;
        urls = stale ? fresh : { ...urls, ...fresh };
        if (stale) lastUrls = Date.now();
      } catch (error) {
        if (mine !== generation) return;
        problem ||= `Foto non aggiornate: ${reason(error)}`;
      }
    }
    // Offline si resta sulla copia salvata, senza disturbare; con la rete l'errore si dice.
    if (problem && navigator.onLine) toast(problem);
    renderAll();
  }

  // Sessione: solo un "nessuno collegato" o un rifiuto certo cancellano la copia sul telefono.
  async function checkSession() {
    try {
      const found = await api.currentUser();
      if (found?.id !== user?.id) generation++;
      user = found;
      sessionFailed = false;
      sessionRetry = false;
      if (!user) { memories = []; urls = {}; clearCache(); }
    } catch (error) {
      if (error.code === 'auth') {
        // Sessione revocata o scaduta davvero: come un'uscita, sul telefono non resta niente.
        forgetLocal();
        toast('Sessione scaduta: accedi di nuovo.');
        return;
      }
      sessionRetry = true;
      if (error.code === 'network') {
        // Rete instabile: si tiene la copia salvata, in sola lettura, e si riprova col ritorno della rete.
        sessionFailed = !user;
        toast('Accesso ai ricordi non verificato: li vedi in sola lettura finché torna la rete.');
      } else {
        // Altro errore del server: la copia resta sul telefono ma non si mostra; si riprova più tardi.
        toast(`Accesso ai ricordi non verificato: ${reason(error)}`);
      }
    }
    renderAll();
    if (user) await refresh();
  }

  // --- Pulsanti sotto le tappe ---
  function buttonLabel(stopId, counts) {
    if (unavailable) return 'Ricordi non disponibili';
    if (!canSee()) return 'Accedi per i ricordi';
    return counts[stopId] ? `Ricordi · ${counts[stopId]}` : 'Aggiungi un ricordo';
  }
  function renderButtons() {
    const counts = countByStop(memories);
    for (const button of document.querySelectorAll('[data-memories]')) {
      button.textContent = buttonLabel(button.dataset.memories, counts);
      button.classList.toggle('has-memories', Boolean(canSee() && counts[button.dataset.memories]));
      button.disabled = Boolean(unavailable);
    }
  }
  document.addEventListener('timeline:rendered', renderButtons);

  // --- Post-it di un ricordo (pannello e diario) ---
  const timeFormat = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  function memoryCard(memory, editable) {
    const own = editable && user && memory.authorId === user.id;
    const pending = busy.has(memory.id) ? ' disabled' : '';
    // Modifica in corso: la textarea si ridisegna con il testo scritto finora (sopravvive agli aggiornamenti).
    if (own && memory.id in editing) {
      return `<article class="memory-card" data-memory="${esc(memory.id)}"><textarea class="memory-edit" maxlength="${MAX_NOTE}" aria-label="Modifica la nota">${esc(editing[memory.id])}</textarea><footer class="memory-meta"><span></span><span class="memory-actions"><button type="button" class="text-button" data-cancel${pending}>Annulla</button><button type="button" class="text-button danger" data-save-edit${pending}>${pending ? 'Salvo…' : 'Salva'}</button></span></footer></article>`;
    }
    const photos = memory.photos.map(path => urls[path]
      ? `<button type="button" class="memory-photo" data-photo="${esc(path)}"><img src="${esc(urls[path])}" alt="Foto di ${esc(memory.authorName)}" loading="lazy"></button>`
      : '<span class="memory-photo is-missing">Foto visibile con la rete</span>').join('');
    const meta = own && confirming.has(memory.id)
      ? `<span>Cancellare questo ricordo?</span><span class="memory-actions"><button type="button" class="text-button" data-cancel${pending}>No</button><button type="button" class="text-button danger" data-confirm-delete${pending}>${pending ? 'Cancello…' : 'Sì, cancella'}</button></span>`
      : `<span>${esc(memory.authorName)} · ${esc(timeFormat.format(new Date(memory.createdAt)))}</span>${own ? '<span class="memory-actions"><button type="button" class="text-button" data-edit>Modifica</button><button type="button" class="text-button" data-delete>Cancella</button></span>' : ''}`;
    return `<article class="memory-card" data-memory="${esc(memory.id)}">${memory.note ? `<p class="memory-note">${esc(memory.note)}</p>` : ''}${photos ? `<div class="memory-photos">${photos}</div>` : ''}<footer class="memory-meta">${meta}</footer></article>`;
  }

  // --- Pannello dal basso ---
  let openStop = null;
  const drafts = {};          // bozze per tappa: { note, photos: Blob[], retry } — restano finché la pagina è aperta
  const saving = new Set();   // tappe con un salvataggio in corso
  let resizing = 0;           // scelte di foto ancora in ridimensionamento
  let previewUrls = [];

  function setStatus(message, isError = false) {
    $('memory-status').textContent = message;
    $('memory-status').classList.toggle('is-error', isError);
  }
  // Esito di un'azione finita dopo un'attesa: nel pannello se è ancora quello giusto, altrimenti in un avviso.
  function report(stopId, message, isError = false) {
    if (openStop === stopId) setStatus(message, isError);
    else toast(message);
  }
  function renderSaveState() {
    if (!openStop) return;
    const preparing = resizing > 0;
    const busyNow = saving.has(openStop);
    $('memory-save').disabled = preparing || busyNow;
    $('memory-photos').disabled = preparing || busyNow;
    $('memory-note').readOnly = busyNow;
    $('memory-save').textContent = preparing ? 'Preparo le foto…' : busyNow ? 'Salvo…' : drafts[openStop].retry ? 'Riprova' : 'Salva';
  }
  function openSheet(stopId) {
    if (!canSee()) { openLogin(); return; }
    openStop = stopId;
    drafts[stopId] ||= { note: '', photos: [] };
    $('sheet-title').textContent = stops.get(stopId).item.title;
    $('memory-note').value = drafts[stopId].note;
    setStatus('');
    renderSheet();
    renderSaveState();
    $('memory-sheet').showModal();
  }
  function renderSheet() {
    if (!openStop) return;
    // Senza sessione verificata si guarda soltanto.
    $('memory-form').hidden = !user;
    // Se si stava scrivendo in una modifica, cursore e selezione tornano dov'erano.
    const active = document.activeElement;
    const focused = active && active.matches && active.matches('#memory-list .memory-edit')
      ? { id: active.closest('[data-memory]').dataset.memory, start: active.selectionStart, end: active.selectionEnd } : null;
    const list = memories.filter(m => m.stopId === openStop);
    $('memory-list').innerHTML = list.length ? list.map(m => memoryCard(m, true)).join('') : '<p class="memory-empty">Ancora nessun ricordo qui.</p>';
    if (focused) {
      const area = $('memory-list').querySelector(`[data-memory="${CSS.escape(focused.id)}"] .memory-edit`);
      if (area) { area.focus(); area.setSelectionRange(focused.start, focused.end); }
    }
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
    try {
      const size = fitWithin(bitmap.width, bitmap.height);
      const canvas = Object.assign(document.createElement('canvas'), size);
      const context = canvas.getContext('2d');
      // Sfondo bianco: in JPEG le parti trasparenti (PNG, screenshot) verrebbero nere.
      context.fillStyle = '#fff';
      context.fillRect(0, 0, size.width, size.height);
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Foto non leggibile.')), 'image/jpeg', JPEG_QUALITY));
    } finally {
      bitmap.close();
    }
  }

  $('memory-photos').addEventListener('change', async event => {
    const files = [...event.target.files];
    event.target.value = '';
    const stopId = openStop;
    const draft = drafts[stopId];
    if (!draft || !files.length) return;
    // Mentre le foto si preparano, Salva e "Aggiungi foto" aspettano (renderSaveState).
    resizing++;
    renderSaveState();
    let skipped = 0;
    const unreadable = [];
    try {
      for (const file of files) {
        // Lo spazio si ricontrolla a ogni foto: il limite di 6 resta anche con più scelte di fila.
        if (draft.photos.length >= MAX_PHOTOS) { skipped++; continue; }
        try {
          const blob = await resizePhoto(file);
          if (draft.photos.length < MAX_PHOTOS) draft.photos.push(blob); else skipped++;
        } catch (error) { unreadable.push(file.name); }
      }
    } finally {
      resizing--;
    }
    if (unreadable.length) report(stopId, `“${unreadable.join('”, “')}” non si riesce a leggere come foto.`, true);
    else if (skipped) report(stopId, `Al massimo ${MAX_PHOTOS} foto per ricordo: ne ho tenute ${draft.photos.length}.`, true);
    if (openStop === stopId) renderPreviews();
    renderSaveState();
  });

  $('memory-form').addEventListener('submit', async event => {
    event.preventDefault();
    const stopId = openStop;
    const draft = drafts[stopId];
    if (!user || !draft || resizing || saving.has(stopId)) return;
    draft.note = $('memory-note').value;
    const note = draft.note.trim().slice(0, MAX_NOTE);
    if (!note && !draft.photos.length) { setStatus('Scrivi qualcosa o aggiungi una foto.', true); return; }
    if (!navigator.onLine) {
      draft.retry = true;
      setStatus('Nessuna rete: il ricordo è rimasto qui. Tocca “Riprova” quando torni online.', true);
      renderSaveState();
      return;
    }
    const mine = generation;
    saving.add(stopId);
    renderSaveState();
    let saved;
    try {
      // Copia delle foto: la bozza resta intatta qualunque cosa succeda durante l'invio.
      saved = await api.add({ stopId, note, photos: [...draft.photos] });
    } catch (error) {
      saving.delete(stopId);
      if (mine !== generation) return;
      draft.retry = true;
      report(stopId, `Non salvato: ${reason(error)} Il ricordo è rimasto qui: tocca “Riprova”.`, true);
      renderSaveState();
      return;
    }
    saving.delete(stopId);
    if (mine !== generation) return;
    putMemory(saved);
    drafts[stopId] = { note: '', photos: [] };
    if (openStop === stopId) $('memory-note').value = '';
    renderSaveState();
    try { Object.assign(urls, await api.photoUrls(saved.photos)); }
    catch (error) { toast(`Ricordo salvato, ma le foto si vedranno al prossimo aggiornamento: ${reason(error)}`); }
    if (mine !== generation) return;
    renderAll();
    report(stopId, 'Ricordo salvato.');
  });

  // Modifica e cancellazione: solo i propri ricordi, con conferma dentro il post-it.
  // Lo stato (modifica/conferma in corso) sta in `editing`/`confirming`, così un aggiornamento non lo perde.
  $('memory-list').addEventListener('input', event => {
    const area = event.target.closest('.memory-edit');
    if (area) editing[area.closest('[data-memory]').dataset.memory] = area.value;
  });
  $('memory-list').addEventListener('click', async event => {
    const card = event.target.closest('[data-memory]');
    const memory = card && memories.find(m => m.id === card.dataset.memory);
    if (!memory || busy.has(memory.id)) return;
    const stopId = openStop;
    const mine = generation;
    if (event.target.closest('[data-delete]')) {
      confirming.add(memory.id);
      renderSheet();
    } else if (event.target.closest('[data-confirm-delete]')) {
      busy.add(memory.id);
      renderSheet();
      try {
        await api.remove(memory);
        if (mine !== generation) return;
        memories = memories.filter(m => m.id !== memory.id);
        localVersion++;
        writeCache(memories);
        confirming.delete(memory.id);
        report(stopId, 'Ricordo cancellato.');
      } catch (error) {
        if (mine !== generation) return;
        report(stopId, `Non cancellato: ${reason(error)}`, true);
      } finally {
        busy.delete(memory.id);
        renderAll();
      }
    } else if (event.target.closest('[data-edit]')) {
      editing[memory.id] = memory.note;
      renderSheet();
      $('memory-list').querySelector(`[data-memory="${CSS.escape(memory.id)}"] textarea`).focus();
    } else if (event.target.closest('[data-save-edit]')) {
      editing[memory.id] = card.querySelector('textarea').value;
      const note = editing[memory.id].trim().slice(0, MAX_NOTE);
      if (!note && !memory.photos.length) { setStatus('Un ricordo senza foto ha bisogno di una nota.', true); return; }
      busy.add(memory.id);
      renderSheet();
      try {
        const updated = await api.updateNote(memory.id, note);
        if (mine !== generation) return;
        putMemory(updated);
        delete editing[memory.id];
        report(stopId, 'Nota modificata.');
      } catch (error) {
        if (mine !== generation) return;
        report(stopId, `Modifica non salvata: ${reason(error)}`, true);
      } finally {
        busy.delete(memory.id);
        renderAll();
      }
    } else if (event.target.closest('[data-cancel]')) {
      delete editing[memory.id];
      confirming.delete(memory.id);
      renderSheet();
    }
  });
  $('memory-previews').addEventListener('click', event => {
    const unpick = event.target.closest('[data-unpick]');
    if (!unpick || saving.has(openStop)) return;
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
    if (!canSee()) { box.innerHTML = '<p class="diary-empty">Il diario è solo per noi due.</p><button type="button" class="button secondary" data-login>Accedi</button>'; return; }
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

  // Torna la rete: se la sessione non si era potuta verificare la si riprova, altrimenti si aggiorna.
  window.addEventListener('online', () => {
    if (sessionRetry) checkSession();
    else if (user) refresh();
  });
  // Tornando sull'app dopo un po': lista dopo 1 minuto, URL delle foto (che scadono dopo un'ora) dopo 45.
  // Gli URL contano solo se ci sono foto: senza, lastUrls non cambia mai e farebbe aggiornare a ogni ritorno.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const urlsOld = memories.some(m => m.photos.length) && Date.now() - lastUrls > URL_RENEW_MS;
    if (sessionRetry && navigator.onLine) checkSession();
    else if (user && (Date.now() - lastList > LIST_REFRESH_MS || urlsOld)) refresh();
  });

  (async function init() {
    try {
      api = window.PARIS_MEMORIES_API || window.createMemoriesApi();
    } catch (error) {
      unavailable = error.message;
      renderAll();
      return;
    }
    await checkSession();
  })();
})();
