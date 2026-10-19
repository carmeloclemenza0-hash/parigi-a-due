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
  // Foto caricate insieme: abbastanza per non aspettarle una per una, poche per non intasare il 4G.
  const UPLOAD_CONCURRENCY = 3;
  const NETWORK_MESSAGE = 'Rete assente o instabile.';
  const SESSION_EXPIRED_MESSAGE = 'Sessione scaduta: accedi di nuovo.';
  // Accesso rifiutato: solo questi codici hanno un messaggio proprio, il resto è "Accesso non riuscito."
  const SIGN_IN_CODES = {
    invalid_credentials: 'Email o password non corrette.',
    email_not_confirmed: 'Account non ancora confermato: va confermato dalla dashboard di Supabase.'
  };
  // PostgREST: token scaduto o non valido.
  const JWT_CODES = ['PGRST301', 'PGRST302', 'PGRST303'];
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
  // Rifiuto certo della sessione (token revocato, o scaduto e non rinnovabile): aspettare la rete non serve.
  function isAuthError(error) {
    if (!error || isNetworkError(error)) return false;
    if (error.__isAuthError) return error.status >= 400 && error.status < 500;
    return JWT_CODES.includes(error.code) || error.status === 401;
  }
  // Supabase parla inglese: in pagina arriva sempre un messaggio italiano; l'originale resta in `cause` e in console.
  // `code` dice a memories.js di che errore si tratta: 'network' (si riprova), 'auth' (sessione rifiutata), 'server' (il resto).
  function italianError(error, fallback) {
    if (error && error.italian) return error;
    const result = new Error(isNetworkError(error) ? NETWORK_MESSAGE : KNOWN_CODES[error && error.code] || fallback, { cause: error });
    result.italian = true;
    result.code = isNetworkError(error) ? 'network' : isAuthError(error) ? 'auth' : 'server';
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
  const TIMED_OUT = Symbol('timeout');
  const withTimeout = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(TIMED_OUT), ms))]);
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
    // Sessione e nomi chiesti al server: getSession può rinnovare il token, loadMembers fa una query.
    async function sessionUser() {
      let result;
      try { result = await client.auth.getSession(); }
      catch (error) { if (isNetworkError(error)) return savedUser(); throw italianError(error, 'Sessione non leggibile.'); }
      if (result.error && isNetworkError(result.error)) return savedUser();
      fail(result.error, 'Sessione non leggibile.');
      return result.data.session ? guarded('Sessione non leggibile.', () => toUser(result.data.session.user)) : null;
    }
    const toMemory = (row, names) => ({
      id: row.id, stopId: row.stop_id, authorId: row.author_id, authorName: names[row.author_id] || 'Qualcuno',
      note: row.note || '', photos: row.photos || [], createdAt: row.created_at
    });

    return {
      async currentUser() {
        // Offline con token scaduto supabase-js ritenta il rinnovo per ~30 s: si usa subito la sessione salvata.
        if (!navigator.onLine) return savedUser();
        // Il tempo massimo vale per tutto (sessione + nomi): con una rete "appesa" si usa la sessione salvata.
        try {
          const found = await withTimeout(sessionUser(), SESSION_TIMEOUT_MS);
          return found === TIMED_OUT ? savedUser() : found;
        } catch (error) {
          // Sessione rifiutata dal server: la si toglie anche dal telefono, come con "Esci".
          if (error.code === 'auth') {
            forgetSession();
            members = null;
            throw Object.assign(new Error(SESSION_EXPIRED_MESSAGE, { cause: error }), { italian: true, code: 'auth' });
          }
          throw error;
        }
      },
      async signIn(email, password) {
        const { data, error } = await guarded('Accesso non riuscito.', () => client.auth.signInWithPassword({ email, password }));
        // Messaggio proprio solo per i codici certi; gli altri rifiuti passano da `fail` (generico, originale in console).
        if (error && !isNetworkError(error) && SIGN_IN_CODES[error.code]) {
          throw Object.assign(new Error(SIGN_IN_CODES[error.code], { cause: error }), { italian: true, code: 'auth' });
        }
        fail(error, 'Accesso non riuscito.');
        members = null; // nuovo utente: si rileggono i nomi con i suoi permessi
        return guarded('Accesso non riuscito.', () => toUser(data.user));
      },
      async signOut() {
        members = null;
        // Prima di tutto, e subito, la sessione sparisce dal telefono.
        const token = readJSON(AUTH_KEY)?.access_token;
        forgetSession();
        // Offline non si chiama il server: lì la sessione scade da sola.
        if (!navigator.onLine || !token) return;
        // Al server si chiede di chiudere solo QUESTA sessione (scope 'local': gli altri dispositivi restano collegati),
        // con il token appena tolto. Niente client.auth.signOut(): finendo in ritardo toglierebbe dal telefono anche
        // una sessione nuova nata nel frattempo. admin.signOut parla solo col server, non tocca la memoria locale.
        let error = null;
        try {
          const result = await withTimeout(client.auth.admin.signOut(token, 'local'), SIGN_OUT_TIMEOUT_MS);
          error = result === TIMED_OUT ? new TypeError('Failed to fetch (timeout)') : result.error;
        } catch (thrown) { error = thrown; }
        // Token già scaduto o sessione già chiusa (401/403/404): sul server non resta niente da chiudere.
        if (error && [401, 403, 404].includes(error.status)) return;
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
        const paths = photos.map(() => `${stopId}/${crypto.randomUUID()}.jpg`);
        const started = [];   // foto già inviate: se qualcosa va storto si tolgono tutte, anche quelle senza risposta
        let row;
        try {
          // UPLOAD_CONCURRENCY foto alla volta. Al primo errore non se ne iniziano altre, ma si aspettano quelle
          // in viaggio: così la pulizia qui sotto non lascia indietro una foto arrivata dopo.
          let next = 0;
          let failure = null;
          const worker = async () => {
            while (!failure && next < photos.length) {
              const index = next++;
              started.push(paths[index]);
              try {
                const { error } = await client.storage.from(BUCKET).upload(paths[index], photos[index], { contentType: 'image/jpeg' });
                fail(error, 'Foto non caricata.');
              } catch (error) { failure ||= error; }
            }
          };
          await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, photos.length) }, worker));
          if (failure) throw failure;
          const { data, error } = await client.from('memories').insert({ stop_id: stopId, note, photos: paths }).select().single();
          fail(error, 'Ricordo non salvato.');
          row = data;
        } catch (error) {
          // Se il ricordo non si salva, si tolgono le foto già caricate: niente foto orfane.
          if (started.length) {
            const { error: cleanupError } = await client.storage.from(BUCKET).remove(started).catch(thrown => ({ error: thrown }));
            if (cleanupError) console.warn('Foto rimaste senza ricordo:', started, cleanupError);
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
