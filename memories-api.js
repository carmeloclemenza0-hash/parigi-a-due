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

  function fail(error, fallback) {
    if (error) throw new Error(error.message || fallback);
  }

  function createMemoriesApi() {
    if (!window.supabase) throw new Error('Ricordi non disponibili: libreria Supabase non caricata.');
    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'parigi-a-due-2026-v1-auth' }
    });

    let members = null;
    async function loadMembers() {
      if (members) return members;
      try {
        const { data, error } = await client.from('couple_members').select('user_id, name');
        fail(error, 'Impossibile leggere i nomi.');
        members = Object.fromEntries(data.map(row => [row.user_id, row.name]));
        try { localStorage.setItem(MEMBERS_KEY, JSON.stringify(members)); } catch (storageError) { /* si riscaricano la prossima volta */ }
      } catch (error) {
        const saved = (() => { try { return JSON.parse(localStorage.getItem(MEMBERS_KEY)); } catch (e) { return null; } })();
        if (!saved) throw error;
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
        const { data, error } = await client.auth.getSession();
        fail(error, 'Sessione non leggibile.');
        return data.session ? toUser(data.session.user) : null;
      },
      async signIn(email, password) {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.code === 'invalid_credentials' || error.status === 400 ? 'Email o password non corrette.' : (error.message || 'Accesso non riuscito.'));
        members = null; // nuovo utente: si rileggono i nomi con i suoi permessi
        return toUser(data.user);
      },
      async signOut() {
        const { error } = await client.auth.signOut();
        fail(error, 'Uscita non riuscita.');
        members = null;
        try { localStorage.removeItem(MEMBERS_KEY); } catch (storageError) { /* niente da togliere */ }
      },
      async changePassword(password) {
        const { error } = await client.auth.updateUser({ password });
        fail(error, 'Password non cambiata.');
      },
      async list() {
        const names = await loadMembers();
        const { data, error } = await client.from('memories').select('*').order('created_at');
        fail(error, 'Impossibile scaricare i ricordi.');
        return data.map(row => toMemory(row, names));
      },
      async add({ stopId, note, photos }) {
        const paths = [];
        try {
          for (const blob of photos) {
            const path = `${stopId}/${crypto.randomUUID()}.jpg`;
            const { error } = await client.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
            fail(error, 'Foto non caricata.');
            paths.push(path);
          }
          const { data, error } = await client.from('memories').insert({ stop_id: stopId, note, photos: paths }).select().single();
          fail(error, 'Ricordo non salvato.');
          return toMemory(data, await loadMembers());
        } catch (error) {
          // Se il ricordo non si salva, si tolgono le foto già caricate: niente foto orfane.
          if (paths.length) {
            const { error: cleanupError } = await client.storage.from(BUCKET).remove(paths);
            if (cleanupError) console.warn('Foto rimaste senza ricordo:', paths, cleanupError);
          }
          throw error;
        }
      },
      async updateNote(id, note) {
        const { data, error } = await client.from('memories').update({ note }).eq('id', id).select().single();
        fail(error, 'Modifica non salvata.');
        return toMemory(data, await loadMembers());
      },
      async remove(memory) {
        const { error } = await client.from('memories').delete().eq('id', memory.id);
        fail(error, 'Ricordo non cancellato.');
        if (memory.photos.length) {
          const { error: photoError } = await client.storage.from(BUCKET).remove(memory.photos);
          fail(photoError, 'Ricordo cancellato, ma alcune foto sono rimaste su Supabase.');
        }
      },
      async photoUrls(paths) {
        if (!paths.length) return {};
        const { data, error } = await client.storage.from(BUCKET).createSignedUrls(paths, URL_TTL_SECONDS);
        fail(error, 'Foto non disponibili.');
        return Object.fromEntries(data.filter(entry => entry.signedUrl).map(entry => [entry.path, entry.signedUrl]));
      }
    };
  }

  window.createMemoriesApi = createMemoriesApi;
})();
