/* Collegamento a Supabase per i ricordi condivisi. È l'unico file che sa che esiste Supabase:
 * memories.js parla solo con l'oggetto restituito da createMemoriesApi(), così i test possono
 * sostituirlo con una versione finta (window.PARIS_MEMORIES_API).
 * La chiave qui sotto è pubblica per natura: a proteggere i dati sono login e regole RLS. */
(function () {
  const SUPABASE_URL = 'https://syyxotzmlpgwdnbgzetc.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_-y-EP5eX9MESp9Lhc1DGpg_YomPQ6f6';
  const BUCKET = 'memories';
  const URL_TTL_SECONDS = 3600;
  // Nomi della coppia salvati sul telefono: servono anche offline.
  const MEMBERS_KEY = 'parigi-a-due-2026-v1-members';
  // Dove supabase-js tiene la sessione (e, se configurato, l'utente a parte in "-user").
  const AUTH_KEY = 'parigi-a-due-2026-v1-auth';
  // Oltre questi tempi una rete "appesa" (metro, roaming) conta come assente.
  const SESSION_TIMEOUT_MS = 3000;
  const SIGN_OUT_TIMEOUT_MS = 5000;
  const NETWORK_MESSAGE = 'Rete assente o instabile.';
  const KNOWN_CODES = {
    same_password: 'La nuova password deve essere diversa da quella attuale.',
    weak_password: 'Password troppo debole: usa almeno 8 caratteri.'
  };

  // Errore di rete (offline, DNS, timeout): si può riprovare, non è un vero rifiuto del server.
  function isNetworkError(error) {
    if (!navigator.onLine) return true;
    if (!error) return false;
    return error instanceof TypeError || error.status === 0 || error.name === 'AuthRetryableFetchError'
      || /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(`${error.message || ''} ${error.details || ''}`);
  }
  // Supabase parla inglese: in pagina arriva sempre un messaggio italiano; l'originale resta in `cause` e in console.
  function italianError(error, fallback) {
    if (error && error.italian) return error;
    const result = new Error(isNetworkError(error) ? NETWORK_MESSAGE : KNOWN_CODES[error && error.code] || fallback, { cause: error });
    result.italian = true;
    console.warn(`Ricordi: ${fallback}`, error);
    return result;
  }
  function fail(error, fallback) {
    if (error) throw italianError(error, fallback);
  }
  // Anche le eccezioni impreviste di un metodo diventano un errore italiano.
  async function guarded(fallback, run) {
    try { return await run(); } catch (error) { throw italianError(error, fallback); }
  }
  const withTimeout = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), ms))]);
  const readJSON = key => { try { return JSON.parse(localStorage.getItem(key)); } catch (error) { return null; } };
  // Utente dell'ultima sessione salvata sul telefono, con i nomi salvati: serve offline.
  function savedUser() {
    const user = readJSON(AUTH_KEY)?.user || readJSON(`${AUTH_KEY}-user`)?.user;
    if (!user || typeof user.id !== 'string') return null;
    const names = readJSON(MEMBERS_KEY) || {};
    return { id: user.id, name: names[user.id] || user.email || 'Tu' };
  }
  function forgetSession() {
    for (const key of [AUTH_KEY, `${AUTH_KEY}-user`, MEMBERS_KEY]) {
      try { localStorage.removeItem(key); } catch (storageError) { /* niente da togliere */ }
    }
  }

  function createMemoriesApi() {
    if (!window.supabase) throw new Error('Ricordi non disponibili: libreria Supabase non caricata.');
    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: AUTH_KEY }
    });

    let members = null;
    async function loadMembers() {
      if (members) return members;
      try {
        const { data, error } = await client.from('couple_members').select('user_id, name');
        if (error) throw error;
        members = Object.fromEntries(data.map(row => [row.user_id, row.name]));
        try { localStorage.setItem(MEMBERS_KEY, JSON.stringify(members)); } catch (storageError) { /* si riscaricano la prossima volta */ }
      } catch (error) {
        const saved = readJSON(MEMBERS_KEY);
        if (!saved) throw italianError(error, 'Impossibile leggere i nomi.');
        members = saved; // offline: si usano i nomi dell'ultima volta
      }
      return members;
    }
    async function toUser(user) {
      const names = await loadMembers();
      return { id: user.id, name: names[user.id] || user.email };
    }
    const toMemory = (row, names) => ({
      id: row.id, stopId: row.stop_id, authorId: row.author_id, authorName: names[row.author_id] || 'Qualcuno',
      note: row.note || '', photos: row.photos || [], createdAt: row.created_at
    });

    return {
      async currentUser() {
        // Offline con token scaduto supabase-js ritenta il rinnovo per ~30 s: si usa subito la sessione salvata.
        if (!navigator.onLine) return savedUser();
        let result;
        try { result = await withTimeout(client.auth.getSession(), SESSION_TIMEOUT_MS); }
        catch (error) { if (isNetworkError(error)) return savedUser(); throw italianError(error, 'Sessione non leggibile.'); }
        if (result.timedOut || (result.error && isNetworkError(result.error))) return savedUser();
        fail(result.error, 'Sessione non leggibile.');
        return result.data.session ? guarded('Sessione non leggibile.', () => toUser(result.data.session.user)) : null;
      },
      async signIn(email, password) {
        const { data, error } = await guarded('Accesso non riuscito.', () => client.auth.signInWithPassword({ email, password }));
        if (error && !isNetworkError(error) && (error.code === 'invalid_credentials' || error.status === 400)) {
          throw Object.assign(new Error('Email o password non corrette.', { cause: error }), { italian: true });
        }
        fail(error, 'Accesso non riuscito.');
        members = null; // nuovo utente: si rileggono i nomi con i suoi permessi
        return guarded('Accesso non riuscito.', () => toUser(data.user));
      },
      async signOut() {
        members = null;
        // Offline non si aspetta il server: basta dimenticare la sessione su questo telefono.
        let error = null;
        if (navigator.onLine) {
          try {
            const result = await withTimeout(client.auth.signOut(), SIGN_OUT_TIMEOUT_MS);
            error = result.timedOut ? new TypeError('Failed to fetch (timeout)') : result.error;
          } catch (thrown) { error = thrown; }
        }
        // Comunque vada, sul telefono non resta la sessione.
        forgetSession();
        // Errori di rete: la sessione sul server scade da sola, non serve disturbare.
        if (error && !isNetworkError(error)) fail(error, 'Uscita dal server non confermata.');
      },
      async changePassword(password) {
        const { error } = await guarded('Password non cambiata.', () => client.auth.updateUser({ password }));
        fail(error, 'Password non cambiata.');
      },
      async list() {
        return guarded('Impossibile scaricare i ricordi.', async () => {
          const names = await loadMembers();
          const { data, error } = await client.from('memories').select('*').order('created_at');
          fail(error, 'Impossibile scaricare i ricordi.');
          return data.map(row => toMemory(row, names));
        });
      },
      async add({ stopId, note, photos }) {
        // I nomi si leggono prima degli upload: dopo l'insert non deve più fallire niente,
        // altrimenti la pulizia qui sotto cancellerebbe le foto di un ricordo già salvato.
        const names = await guarded('Ricordo non salvato.', loadMembers);
        const paths = [];
        let row;
        try {
          for (const blob of photos) {
            const path = `${stopId}/${crypto.randomUUID()}.jpg`;
            const { error } = await client.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
            fail(error, 'Foto non caricata.');
            paths.push(path);
          }
          const { data, error } = await client.from('memories').insert({ stop_id: stopId, note, photos: paths }).select().single();
          fail(error, 'Ricordo non salvato.');
          row = data;
        } catch (error) {
          // Se il ricordo non si salva, si tolgono le foto già caricate: niente foto orfane.
          if (paths.length) {
            const { error: cleanupError } = await client.storage.from(BUCKET).remove(paths).catch(thrown => ({ error: thrown }));
            if (cleanupError) console.warn('Foto rimaste senza ricordo:', paths, cleanupError);
          }
          throw italianError(error, 'Ricordo non salvato.');
        }
        return toMemory(row, names);
      },
      async updateNote(id, note) {
        return guarded('Modifica non salvata.', async () => {
          const names = await loadMembers();
          const { data, error } = await client.from('memories').update({ note }).eq('id', id).select().single();
          fail(error, 'Modifica non salvata.');
          return toMemory(data, names);
        });
      },
      async remove(memory) {
        await guarded('Ricordo non cancellato.', async () => {
          const { error } = await client.from('memories').delete().eq('id', memory.id);
          fail(error, 'Ricordo non cancellato.');
        });
        // La riga non c'è più: per chi usa il sito è un successo. Le foto rimaste si segnalano in console.
        if (memory.photos.length) {
          const { error: photoError } = await client.storage.from(BUCKET).remove(memory.photos).catch(thrown => ({ error: thrown }));
          if (photoError) console.warn('Ricordo cancellato, ma queste foto sono rimaste su Supabase:', memory.photos, photoError);
        }
      },
      async photoUrls(paths) {
        if (!paths.length) return {};
        return guarded('Foto non disponibili.', async () => {
          const { data, error } = await client.storage.from(BUCKET).createSignedUrls(paths, URL_TTL_SECONDS);
          fail(error, 'Foto non disponibili.');
          return Object.fromEntries(data.filter(entry => entry.signedUrl).map(entry => [entry.path, entry.signedUrl]));
        });
      }
    };
  }

  window.createMemoriesApi = createMemoriesApi;
})();
