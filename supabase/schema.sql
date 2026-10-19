-- Ricordi condivisi di "Parigi, a due". Si esegue una volta nel progetto Supabase "PARIGI ❤️".
-- La sicurezza è tutta qui: il sito è pubblico, la chiave pubblica pure; decidono login e RLS.

create schema if not exists private;

-- Chi fa parte della coppia (riempita a mano dopo aver creato i due utenti).
create table public.couple_members (
  user_id uuid primary key references auth.users on delete cascade,
  name text not null
);

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  stop_id text not null check (stop_id ~ '^d[1-5]-[a-z0-9-]+$'),
  author_id uuid not null default auth.uid() references auth.users on delete cascade,
  note text not null default '' check (char_length(note) <= 2000),
  photos text[] not null default '{}' check (cardinality(photos) <= 6),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  -- un ricordo vuoto non ha senso: serve almeno una nota o una foto
  check (char_length(btrim(note)) > 0 or cardinality(photos) > 0)
);
create index memories_stop_id_idx on public.memories (stop_id);
create index memories_author_id_idx on public.memories (author_id);

-- Vero se chi chiama è Carmelo o Adiel. Nello schema "private": non è esposta dalle API.
create function private.is_couple() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.couple_members where user_id = (select auth.uid())) $$;
revoke all on function private.is_couple() from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.is_couple() to authenticated;

-- Le tabelle si raggiungono dalle API solo da collegati; quali righe, lo decide RLS.
revoke all on public.couple_members, public.memories from anon;
grant select on public.couple_members to authenticated;
grant select, insert, update, delete on public.memories to authenticated;
-- Si modifica solo la nota: le altre colonne (foto, tappa, autore, data) non si toccano dalle API.
-- (Il trigger su updated_at funziona lo stesso: i trigger non passano dai permessi di colonna.)
revoke update on public.memories from authenticated;
grant update (note) on public.memories to authenticated;

alter table public.couple_members enable row level security;
alter table public.memories enable row level security;

create policy "la coppia vede i nomi" on public.couple_members
  for select to authenticated using ((select private.is_couple()));
create policy "la coppia legge i ricordi" on public.memories
  for select to authenticated using ((select private.is_couple()));
create policy "si scrive a proprio nome" on public.memories
  for insert to authenticated with check ((select private.is_couple()) and author_id = (select auth.uid()));
create policy "si modificano i propri" on public.memories
  for update to authenticated using (author_id = (select auth.uid())) with check (author_id = (select auth.uid()));
create policy "si cancellano i propri" on public.memories
  for delete to authenticated using (author_id = (select auth.uid()));

create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$ begin new.updated_at := now(); return new; end $$;
create trigger memories_touch before update on public.memories
  for each row execute function private.touch_updated_at();

-- Foto: bucket privato, solo JPEG fino a 5 MB (il sito le manda già rimpicciolite).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('memories', 'memories', false, 5242880, array['image/jpeg']);

create policy "la coppia vede le foto" on storage.objects
  for select to authenticated using (bucket_id = 'memories' and (select private.is_couple()));
create policy "la coppia carica foto" on storage.objects
  for insert to authenticated with check (bucket_id = 'memories' and (select private.is_couple()));
create policy "si cancellano le proprie foto" on storage.objects
  for delete to authenticated using (bucket_id = 'memories' and owner_id = (select auth.uid()::text));
