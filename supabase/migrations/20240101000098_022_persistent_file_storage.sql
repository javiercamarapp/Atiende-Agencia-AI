-- Hallazgo de auditoría (severidad CRÍTICA): `PostgresLicitacionesRepository`
-- delegaba el ZIP del expediente (`package_manifest.storage_ref`) y el acuse
-- de presentación (`submission.acknowledgement_storage_ref`) a
-- `domain-licitaciones/src/storage.ts` (`writeFile`/`readFile` de
-- `node:fs/promises` bajo `LICITACIONES_STORAGE_DIR`, default
-- `/tmp/atiende-licitaciones-storage` -- ver `apps/api/src/env.ts`). En una
-- función serverless de Vercel el filesystem es EFÍMERO por invocación: un
-- expediente ensamblado en `POST .../package/assemble` (invocación A) queda
-- irrecuperable en `GET .../package/download` (invocación B, contenedor
-- distinto -- disco `/tmp` propio, nunca compartido) -- `readManifestZip`
-- lanza ENOENT en producción real prácticamente siempre, pese a que
-- `licitaciones.package_manifest.storage_ref` sí apunta a una fila
-- persistida (el registro sobrevive, el ARCHIVO no). Mismo problema para el
-- acuse de presentación (`submission.acknowledgement_storage_ref`).
--
-- Corrección real: el contenido pasa a vivir DENTRO de Postgres (la única
-- pieza de almacenamiento persistente ya aprovisionada en este entorno --
-- `DATABASE_URL`, el mismo `TenantDbSession` que ya usa el resto de
-- `PostgresLicitacionesRepository`). Ningún vertical de este monorepo tiene
-- todavía un adaptador de blob storage tipo S3/Supabase Storage que
-- replicar (verificado: `grep -rn "supabase.*storage\|createSignedUrl" packages
-- apps` no encuentra ninguno -- y `SUPABASE_SERVICE_ROLE_KEY` no está
-- aprovisionada en este entorno, ver comentario de esa variable en
-- `.env.example`), así que este adaptador -- `bytea` bajo RLS, mismo patrón
-- de organization-scoping que el resto del esquema `licitaciones` -- sirve
-- de base reutilizable el día que se construya una pieza de storage
-- compartida entre verticales, igual que `storage.ts` documentaba para sí
-- mismo.
--
-- `licitaciones.file_blob.id` (uuid) reemplaza la ruta relativa de disco
-- como `storage_ref` -- ninguna columna de `package_manifest`/`submission`
-- cambia de tipo (ambas ya eran `text`, un uuid es texto válido).
--
-- Requiere: 001_licitaciones_schema.sql (core.organization), 002_compliance_and_package.sql
-- (can_access_org/can_write_org, y las columnas storage_ref que este blob reemplaza).
create table licitaciones.file_blob (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  sha256 text not null,
  size_bytes integer not null check (size_bytes >= 0),
  content bytea not null,
  created_at timestamptz not null default now()
);
create index file_blob_org_idx on licitaciones.file_blob (organization_id, created_at desc);
-- Búsqueda de contenido ya subido por hash (dedupe del acuse de presentación,
-- ver `storeAcknowledgement` -- mismo criterio que `storage.ts::storeFile`
-- original: subir el mismo contenido dos veces nunca duplica el archivo).
-- Índice, NO constraint único: a diferencia del acuse (deliberadamente
-- deduplicado en código de aplicación antes de insertar), el ZIP del
-- expediente (`writeManifestZip`) nunca deduplica -- cada `POST
-- .../package/assemble` es una fila nueva aunque el contenido coincidiera
-- por casualidad, mismo criterio que el `${proposalId}-${Date.now()}.zip`
-- del origen (nunca colisiona con otra propuesta).
create index file_blob_org_sha256_idx on licitaciones.file_blob (organization_id, sha256);

alter table licitaciones.file_blob enable row level security;
create policy "org ve sus archivos" on licitaciones.file_blob for select using (licitaciones.can_access_org(organization_id));
create policy "escritura: roles de escritura suben archivos" on licitaciones.file_blob for insert with check (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.file_blob from public, anon;
grant select, insert on licitaciones.file_blob to authenticated;
grant select, insert, update, delete on licitaciones.file_blob to service_role;
