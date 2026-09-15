-- Segunda migración del esquema `despachos.*` (Fase 5) — persistencia de mapeos de
-- migración de catálogo contable entre bases de clientes (puerto de
-- `b2b_ai/features/migracion_catalogo/`, ver domain-despachos/src/migracion-catalogo/).
-- Mismo patrón RLS que 001_despachos_schema.sql (`core.has_property_access`).
--
-- Alcance de Fase 5 (ver informe de auditoría de esta fase): solo se persiste el
-- MAPEO (clasificación + decisión humana aprobar/rechazar/editar) — el catálogo
-- origen/destino y las pólizas migradas viven en las bases del cliente, fuera de
-- este monorepo (ver domain-despachos/src/migracion-catalogo/cross-db-port.ts,
-- adaptador fail-closed documentado: requiere credenciales reales no disponibles
-- aquí). Esta tabla es la única pieza de esa capacidad que fusion persiste hoy.
--
-- La conciliación bancaria (motor de matching de 4 niveles, ver
-- domain-despachos/src/conciliacion/) se expone en esta fase como endpoint puro/
-- calculadora (mismo criterio que declaraciones.ts/nomina.ts, ver comentario de
-- cabecera de apps/api/.../despachos/conciliacion.ts) — no requiere tabla nueva.
--
-- NOTA (barrido de documentación/observabilidad): esta migración corría SOLO como
-- `supabase/migrations/20240101000037_002_despachos_migracion_catalogo_schema.sql`
-- (copia consolidada aplicada al proyecto real) sin fuente canónica en este
-- paquete — a diferencia de las demás migraciones de `despachos.*`, que sí viven
-- aquí primero y se copian a `supabase/migrations/` con timestamp (ver
-- `packages/db/README.md` para la convención). Este archivo es esa fuente
-- canónica que faltaba; el contenido es idéntico byte a byte al que ya corre en
-- `supabase/migrations/` (verificado con diff), así que no reaplica ni cambia
-- nada en ningún proyecto Supabase real ya migrado.

create table despachos.mapeo_migracion_cuenta (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  origen_cuenta_id text not null,
  destino_cuenta_id text,
  tipo_match text not null check (tipo_match in ('exacto', 'alerta_riesgo', 'fuzzy', 'sin_match')),
  score numeric(5, 2) not null check (score >= 0 and score <= 100),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'aprobado', 'rechazado', 'editado')),
  aprobado_por uuid references core.staff_user(id) on delete set null,
  aprobado_en timestamptz,
  nota text,
  estrategia_conciliacion_saldos text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- ADR-3 (ver matching.ts): solo "exacto" puede nacer aprobado; ningún otro tipo de
  -- match se auto-aprueba sin decisión humana, sin importar el score.
  constraint mapeo_migracion_solo_exacto_nace_aprobado check (
    estado <> 'aprobado' or aprobado_por is not null or tipo_match = 'exacto'
  )
);
create index mapeo_migracion_property_idx on despachos.mapeo_migracion_cuenta (property_id);
create index mapeo_migracion_origen_idx on despachos.mapeo_migracion_cuenta (property_id, origen_cuenta_id);
create index mapeo_migracion_destino_idx on despachos.mapeo_migracion_cuenta (property_id, destino_cuenta_id) where destino_cuenta_id is not null;

alter table despachos.mapeo_migracion_cuenta enable row level security;

create policy "staff ve mapeos de migración de su property" on despachos.mapeo_migracion_cuenta for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff inserta mapeos de migración de su property" on despachos.mapeo_migracion_cuenta for insert
  with check (core.has_property_access(auth.uid(), property_id));
create policy "staff actualiza mapeos de migración de su property" on despachos.mapeo_migracion_cuenta for update
  using (core.has_property_access(auth.uid(), property_id)) with check (core.has_property_access(auth.uid(), property_id));

grant select, insert, update on despachos.mapeo_migracion_cuenta to authenticated;
grant select, insert, update, delete on despachos.mapeo_migracion_cuenta to service_role;
