-- Einmal in Supabase ausführen: SQL Editor → New query → einfügen → Run

-- Tabelle mit den geteilten Sounds
create table if not exists public.sounds (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 30),
  emoji text not null default '🔊' check (char_length(emoji) <= 8),
  path text not null unique check (path ~ '^[a-zA-Z0-9-]+\.(m4a|mp3|wav|ogg|webm|aac)$'),
  created_at timestamptz not null default now()
);

alter table public.sounds enable row level security;

-- Jeder App-Nutzer darf Sounds sehen und neue hinzufügen – aber nichts ändern oder löschen
create policy "Sounds lesen" on public.sounds
  for select to anon using (true);
create policy "Sounds hinzufügen" on public.sounds
  for insert to anon with check (true);

-- Öffentlicher Speicher-Bucket für die Audiodateien (max. 1 MB, nur Audio)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sounds', 'sounds', true, 1048576, array[
  'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac',
  'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'audio/webm'
])
on conflict (id) do nothing;

-- Hochladen erlaubt, Überschreiben/Löschen nicht
create policy "Sounds hochladen" on storage.objects
  for insert to anon with check (bucket_id = 'sounds');
