-- F4c (paridad menor) -- SUBIR PDF o IMAGEN a la base de conocimiento (voz y WhatsApp). Prefijo de supabase/migrations asignado: 20240101000482 (interno 182).
--
-- Decision de diseno: NO se guarda el archivo (ni sus bytes) en la base. El servidor valida el tipo REAL por firma (magic bytes), el tamano y un escaneo, extrae el texto con un
-- adaptador (la extraccion real es una interfaz; hoy sin extractor configurado la carga responde "no disponible aun") y lo convierte en BORRADORES de `conocimiento_negocio` (053,
-- origen 'importado') que el dueno revisa y publica; solo lo publicado llega al prompt, con las mismas validaciones (sin precios ni nombres del menu). Esta tabla guarda solo el
-- REGISTRO de la carga: nombre, tipo, tamano, huella SHA-256 (para no cargar dos veces lo mismo), cuantos caracteres de texto salieron y los ids de los borradores que genero (para
-- que borrar el archivo borre tambien sus borradores). Una base sin esta migracion responde 503 honesto a la carga y lista vacio: nunca un 500.
--
-- Justificacion de seguridad (una por una):
--  * RLS habilitado y `revoke all ... from public, anon`: `anon` no recibe NINGUN privilegio.
--  * SELECT / INSERT / DELETE solo owner/admin de la organizacion (la tabla es administrativa; el agente NO la lee, lee `conocimiento_negocio`). El INSERT exige `subido_por = auth.uid()`.
--  * Sin UPDATE para `authenticated` (el registro de una carga es inmutable; se borra y se vuelve a cargar). GRANT por COLUMNA en INSERT: `organization_id` no cambia de tenant.
--  * CHECK por columna: nombre acotado, tipo MIME de una lista cerrada (pdf/png/jpeg/webp), tamano 1 byte a 5 MiB y huella con formato SHA-256: valores invalidos mueren en la base.
--  * UNIQUE (organization_id, sha256): la misma carga dos veces no duplica borradores.
--  * No guarda PII del cliente final: son documentos del negocio que sube el dueno; el nombre del archivo se sanea en la API (sin rutas ni saltos de linea).
create table restaurantes.conocimiento_archivos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  nombre text not null check (char_length(nombre) between 1 and 120),
  mime text not null check (mime in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  tamano_bytes integer not null check (tamano_bytes between 1 and 5242880),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  caracteres_texto integer not null default 0 check (caracteres_texto >= 0),
  entradas_ids uuid[] not null default '{}' check (cardinality(entradas_ids) <= 50),
  subido_por uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, sha256)
);

create index conocimiento_archivos_org_idx on restaurantes.conocimiento_archivos (organization_id, created_at desc);

alter table restaurantes.conocimiento_archivos enable row level security;

create policy "owner/admin lee los archivos de conocimiento" on restaurantes.conocimiento_archivos for select
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = conocimiento_archivos.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

create policy "owner/admin registra archivos de conocimiento" on restaurantes.conocimiento_archivos for insert
  with check (
    subido_por = auth.uid()
    and exists (
      select 1 from core.membership m
      where m.organization_id = conocimiento_archivos.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

create policy "owner/admin borra archivos de conocimiento" on restaurantes.conocimiento_archivos for delete
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = conocimiento_archivos.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

revoke all on restaurantes.conocimiento_archivos from public, anon;
grant select, delete on restaurantes.conocimiento_archivos to authenticated;
grant insert (organization_id, nombre, mime, tamano_bytes, sha256, caracteres_texto, entradas_ids, subido_por)
  on restaurantes.conocimiento_archivos to authenticated;
grant select, insert, update, delete on restaurantes.conocimiento_archivos to service_role;
