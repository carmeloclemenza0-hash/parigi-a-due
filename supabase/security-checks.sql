-- Prove di sicurezza RLS. Tutto dentro una transazione annullata: non resta nessun dato.
-- Ogni prova fallita interrompe lo script con un messaggio "FALLITO: ...".
begin;
do $$
declare
  carmelo uuid := (select user_id from public.couple_members where name = 'Carmelo');
  adiel uuid := (select user_id from public.couple_members where name = 'Adiel');
  stranger uuid := gen_random_uuid();
  memory uuid;
  n int;
begin
  -- Fa finta di essere un utente collegato (come fa Supabase con il token di login).
  perform set_config('request.jwt.claims', json_build_object('sub', carmelo, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into public.memories (stop_id, note) values ('d1-eiffel', 'prova') returning id into memory;

  -- 1. Adiel legge il ricordo di Carmelo, ma non lo modifica né lo cancella.
  perform set_config('request.jwt.claims', json_build_object('sub', adiel, 'role', 'authenticated')::text, true);
  select count(*) into n from public.memories where id = memory;
  if n <> 1 then raise exception 'FALLITO: Adiel non vede il ricordo di Carmelo'; end if;
  update public.memories set note = 'manomesso' where id = memory;
  delete from public.memories where id = memory;
  -- 2. Adiel non può scrivere a nome di Carmelo.
  begin
    insert into public.memories (stop_id, note, author_id) values ('d1-eiffel', 'finto', carmelo);
    raise exception 'FALLITO: Adiel ha scritto a nome di Carmelo';
  exception when insufficient_privilege then null;
  end;

  -- 3. Un utente estraneo (non della coppia) non vede niente e non scrive.
  perform set_config('request.jwt.claims', json_build_object('sub', stranger, 'role', 'authenticated')::text, true);
  select count(*) into n from public.memories;
  if n <> 0 then raise exception 'FALLITO: un estraneo vede % ricordi', n; end if;
  begin
    insert into public.memories (stop_id, note, author_id) values ('d1-eiffel', 'intruso', stranger);
    raise exception 'FALLITO: un estraneo ha scritto';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;

  -- 4. Chi non è collegato (anon) non può nemmeno leggere la tabella.
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    select count(*) into n from public.memories;
    if n <> 0 then raise exception 'FALLITO: anon vede % ricordi', n; end if;
  exception when insufficient_privilege then null;
  end;

  -- 5. Il ricordo di Carmelo è ancora intatto.
  execute 'reset role';
  select count(*) into n from public.memories where id = memory and note = 'prova';
  if n <> 1 then raise exception 'FALLITO: il ricordo di Carmelo è stato modificato o cancellato'; end if;
  raise notice 'Tutte le prove di sicurezza superate';
end $$;
rollback;
