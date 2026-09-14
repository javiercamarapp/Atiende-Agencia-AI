-- Sincronización de calendario por canal (Fase 5) -- persiste feeds iCal externos por
-- unidad (URL de importación, canal, estado de sync/cuarentena, última corrida) y el
-- bookkeeping de versión (`evento_canal_importado`) / anti-eco (`bloqueo_exportado`)
-- que el motor de sync (packages/domain-rentas/src/sync/motor.ts) necesita. Requiere:
-- 001_rentas_schema.sql ya aplicada (referencia rentas.unidad/rentas.canal/
-- rentas.ocupacion). Ver diseño de esta fase para la justificación de cada tabla --
-- mismo mapeo de rango de origen que `unidad_canal_feed`/`evento_canal_importado`/
-- `bloqueo_exportado` de rentas/packages/db/src/migrations/0020-0021 (repo origen),
-- calificado por schema (`rentas.*`) y con `organization_id`/`property_id` añadidos,
-- mismo criterio que 001_rentas_schema.sql frente a su propio origen.

-- ---------------------------------------------------------------------------
-- Configuración de feed externo por (unidad, canal) -- import periódico.
-- ---------------------------------------------------------------------------
create table rentas.canal_feed_externo (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  unidad_id uuid not null references rentas.unidad(id) on delete cascade,
  canal_id uuid not null references rentas.canal(id),
  -- URL pública del feed .ics del canal externo (sin credenciales -- H-024/H-025, ver
  -- src/sync/net/ssrf.ts: solo https, o http+simulador.local en desarrollo).
  url_importacion text not null check (url_importacion <> ''),
  activo boolean not null default true,

  -- Estado de cuarentena/última corrida (src/sync/cuarentena.ts::EstadoFeedCanal).
  ultima_sincronizacion_exitosa_en timestamptz,
  en_cuarentena_desde timestamptz,
  intentos_fallidos_consecutivos integer not null default 0,
  motivo_cuarentena text,

  -- Caché HTTP condicional (ETag / If-Modified-Since) para no re-descargar un feed
  -- sin cambios en cada corrida.
  etag_import text,
  ultima_modificacion_http_import text,

  -- Drift de la última reconciliación completa (src/sync/reconciliacion.ts) --
  -- métrica de observabilidad, nunca dispara cancelación automática.
  drift_ultima_reconciliacion_completa integer not null default 0,
  -- Resumen JSON de la última corrida (ResultadoImportarCiclo) -- solo para
  -- GET .../sync-status, nunca leído por el propio motor.
  ultimo_resumen jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (unidad_id, canal_id)
);
create index canal_feed_externo_property_idx on rentas.canal_feed_externo (property_id);
create index canal_feed_externo_activos_idx on rentas.canal_feed_externo (unidad_id) where activo;

-- ---------------------------------------------------------------------------
-- Bookkeeping de versión por evento importado (UID -> SEQUENCE/DTSTAMP/hash) -- el
-- motor de resolución de versión (src/sync/resolucion-version.ts) lo usa para decidir
-- aplicar/descartar/sin_cambio/revisar_uid_reciclado sin volver a tocar la red.
-- ---------------------------------------------------------------------------
create table rentas.evento_canal_importado (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  unidad_id uuid not null references rentas.unidad(id) on delete cascade,
  canal_id uuid not null references rentas.canal(id),
  uid_evento text not null,
  sequence integer,
  dtstamp timestamptz not null,
  hash_contenido text not null,
  -- `null` cuando la última acción fue 'eco'/'descartar' sin ocupación asociada, o
  -- cuando la ocupación asociada fue borrada (on delete set null -- el bookkeeping de
  -- versión del UID sobrevive, la próxima corrida decide de nuevo con `previa =
  -- ocupacion_id: null`).
  ocupacion_id uuid references rentas.ocupacion(id) on delete set null,
  ultima_accion text not null check (ultima_accion in ('aplicar', 'descartar', 'sin_cambio', 'revisar_uid_reciclado', 'eco')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (unidad_id, canal_id, uid_evento)
);
create index evento_canal_importado_property_idx on rentas.evento_canal_importado (property_id);
create index evento_canal_importado_ocupacion_idx on rentas.evento_canal_importado (ocupacion_id);

-- ---------------------------------------------------------------------------
-- Bloqueos exportados por (ocupación, canal) -- capa 2/3 del anti-eco
-- (src/sync/anti-eco.ts): un bloqueo que este software exportó y que un canal nos
-- "rebota" en su propio feed nunca se reimporta como una reserva nueva.
-- ---------------------------------------------------------------------------
create table rentas.bloqueo_exportado (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  ocupacion_id uuid not null references rentas.ocupacion(id) on delete cascade,
  canal_id uuid not null references rentas.canal(id),
  uid_exportado text not null,
  hash_contenido text not null,
  sequence integer not null default 0,
  exportado_en timestamptz not null default now(),
  unique (ocupacion_id, canal_id)
);
create index bloqueo_exportado_property_idx on rentas.bloqueo_exportado (property_id);

-- ---------------------------------------------------------------------------
-- RLS -- misma autoridad que 001_rentas_schema.sql: nunca se re-implementa un
-- tenant_id propio, siempre `core.has_property_access`. El motor de sync corre como
-- `service_role` (cron interno, ver apps/api/.../ical-sync-cron.ts) -- el staff solo
-- necesita SELECT/INSERT/UPDATE/DELETE de `canal_feed_externo` (conectar/desconectar
-- un feed) y SELECT de las otras dos (ver estado de sync), nunca escritura directa del
-- bookkeeping de versión/anti-eco.
-- ---------------------------------------------------------------------------
alter table rentas.canal_feed_externo enable row level security;
alter table rentas.evento_canal_importado enable row level security;
alter table rentas.bloqueo_exportado enable row level security;

create policy "staff ve feeds de su property" on rentas.canal_feed_externo for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff conecta feeds de su property" on rentas.canal_feed_externo for insert
  with check (core.has_property_access(auth.uid(), property_id));
create policy "staff actualiza feeds de su property" on rentas.canal_feed_externo for update
  using (core.has_property_access(auth.uid(), property_id)) with check (core.has_property_access(auth.uid(), property_id));

create policy "staff ve bookkeeping de eventos importados de su property" on rentas.evento_canal_importado for select
  using (core.has_property_access(auth.uid(), property_id));

create policy "staff ve bookkeeping de bloqueos exportados de su property" on rentas.bloqueo_exportado for select
  using (core.has_property_access(auth.uid(), property_id));

revoke all on all tables in schema rentas from public, anon;
grant select, insert, update on rentas.canal_feed_externo to authenticated;
grant select on rentas.evento_canal_importado, rentas.bloqueo_exportado to authenticated;
grant select, insert, update, delete on all tables in schema rentas to service_role;
