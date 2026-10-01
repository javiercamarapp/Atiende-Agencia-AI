-- Rn-01 (P0) -- sync iCal como lote idempotente: claim/lease por feed, backoff por feed
-- fallido, bitácora/alertas del sync y resolución de conflictos de calendario.
--
-- Contexto. Hasta ahora el cron `/internal/rentas/ical-sync` recorría TODOS los feeds
-- activos en cada invocación, sin ninguna coordinación: dos instancias del cron a la vez
-- (reintento de Vercel, disparo manual, o una cadencia más corta como los 15 min que se
-- proponen en docs/DEPLOY.md) procesaban el mismo feed en paralelo, y un feed caído se
-- reintentaba en CADA corrida sin espaciamiento. Además nada persistía una bitácora del
-- sync ni una alerta consultable, y `rentas.conflicto_calendario` (overbooking entre
-- canales y capa cruzada, ver 001) no tenía forma de marcarse como resuelto.
--
-- Esta migración NO cambia ninguna cadencia de cron (vercel.json no se toca). Es
-- aditiva: el código TypeScript que la usa cae al camino anterior (listar todos los
-- feeds, sin lease) si la base todavía no la tiene (SQLSTATE 42883/42P01/42703).
--
-- Requiere: 001, 008 y 015 (rentas.canal_feed_externo, rentas.conflicto_calendario y el
-- escape hatch `auth.uid() is null` de la sesión de sistema del cron).

-- ---------------------------------------------------------------------------
-- 1) Columnas de lease + backoff en rentas.canal_feed_externo.
-- ---------------------------------------------------------------------------
-- lease_hasta/lease_token: "claim" del feed por UNA instancia del cron. Un feed con
--   lease vigente (lease_hasta > now()) no se entrega a otra instancia; si la instancia
--   muere, el lease expira solo (no hay estado que limpiar a mano). El token es la
--   "valla" (fencing): solo quien lo posee puede liberar el lease.
-- ultimo_intento_en: cuándo se reclamó por última vez (equidad: se reclama primero el
--   feed menos recientemente intentado) y piso de espaciamiento entre corridas.
-- proximo_intento_en: backoff por feed fallido; null = sin espera.
alter table rentas.canal_feed_externo
  add column lease_hasta timestamptz,
  add column lease_token uuid,
  add column ultimo_intento_en timestamptz,
  add column proximo_intento_en timestamptz;

create index canal_feed_externo_cola_idx on rentas.canal_feed_externo (ultimo_intento_en nulls first) where activo;

-- Justificación de seguridad (GRANT por columna): hasta hoy `authenticated` tenía UPDATE
-- a nivel de TABLA sobre rentas.canal_feed_externo (008). Las columnas de lease son un
-- mecanismo de exclusión mutua del sistema: si cualquier staff pudiera escribirlas
-- podría (a) vaciar el lease de un feed en proceso y provocar doble proceso, o (b)
-- fijarse un lease eterno y apagar el sync de su propio feed sin dejar rastro. Se
-- reemplaza el UPDATE de tabla por UPDATE por columna que EXCLUYE lease_hasta,
-- lease_token y ultimo_intento_en: solo las funciones security definer de abajo
-- (guardadas con auth.uid() is null) las escriben. Las columnas que SÍ se conceden son
-- exactamente las que ya escriben connectFeed/disconnectFeed (url_importacion, activo,
-- updated_at), persistFeedSyncState (estado de cuarentena/cache HTTP/resumen) y
-- proximo_intento_en (reiniciar el backoff al reconectar un feed con otra URL).
revoke update on rentas.canal_feed_externo from authenticated;
grant update (
  url_importacion, activo,
  ultima_sincronizacion_exitosa_en, en_cuarentena_desde, intentos_fallidos_consecutivos, motivo_cuarentena,
  etag_import, ultima_modificacion_http_import, drift_ultima_reconciliacion_completa, ultimo_resumen,
  updated_at, proximo_intento_en
) on rentas.canal_feed_externo to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Backoff por feed fallido (función pura, inmutable).
-- ---------------------------------------------------------------------------
-- 15 min * 2^n, con n = fallos consecutivos acotado a [1, 10], tope de 6 h:
-- 1 -> 30 min, 2 -> 60 min, 3 -> 2 h, 4 -> 4 h, 5 o más -> 6 h. El espejo en TypeScript
-- (calcularBackoffFeedSegundos, domain-rentas/src/sync/lease.ts) usa la misma tabla y un
-- test la compara contra esta función en el verify de Postgres real.
-- Sin security definer: no lee ninguna tabla, solo calcula.
create function rentas.ical_backoff_segundos(p_fallos_consecutivos integer)
returns integer
language sql
immutable
set search_path = pg_catalog
as $$
  select least(21600, 900 * power(2, least(greatest(coalesce(p_fallos_consecutivos, 1), 1), 10))::integer)
$$;

revoke all on function rentas.ical_backoff_segundos(integer) from public;
grant execute on function rentas.ical_backoff_segundos(integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Bitácora / alertas del sync iCal.
-- ---------------------------------------------------------------------------
-- Solo se registran EVENTOS NOTABLES (fallo, cuarentena, vacío inesperado, cambios
-- aplicados, conflictos detectados, error interno), nunca un renglón por cada corrida
-- sin cambios: con una cadencia de 15 min eso serían ~96 filas/día/feed sin valor. Una
-- fila con severidad 'aviso' o 'critica' y atendida_en null ES una alerta abierta.
-- `detalle` es texto corto y acotado (nunca el cuerpo del .ics, nunca la URL del feed,
-- que puede ser un secreto de facto -- ver 020_break_glass_lectores).
create table rentas.ical_sync_bitacora (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  unidad_id uuid not null references rentas.unidad(id) on delete cascade,
  feed_id uuid not null references rentas.canal_feed_externo(id) on delete cascade,
  canal_id uuid not null references rentas.canal(id),
  tipo text not null check (tipo in ('sync_con_cambios', 'sync_fallido', 'cuarentena_activada', 'cuarentena_persistente', 'vacio_inesperado', 'conflicto_detectado', 'error_interno')),
  severidad text not null check (severidad in ('info', 'aviso', 'critica')),
  detalle text not null default '' check (char_length(detalle) <= 500),
  eventos_aplicados integer not null default 0 check (eventos_aplicados >= 0),
  conflictos integer not null default 0 check (conflictos >= 0),
  creado_en timestamptz not null default now(),
  atendida_en timestamptz,
  atendida_por uuid references core.staff_user(id) on delete set null,
  constraint ical_sync_bitacora_atencion_coherente check (atendida_por is null or atendida_en is not null)
);
create index ical_sync_bitacora_property_creado_idx on rentas.ical_sync_bitacora (property_id, creado_en desc);
create index ical_sync_bitacora_alertas_abiertas_idx on rentas.ical_sync_bitacora (property_id, creado_en desc) where atendida_en is null and severidad in ('aviso', 'critica');

alter table rentas.ical_sync_bitacora enable row level security;

-- Justificación de seguridad (RLS): lectura solo para staff con acceso a la property
-- (misma autoridad que el resto de rentas.*: core.has_property_access, nunca un
-- tenant_id propio). Sin policy de INSERT ni DELETE para `authenticated`: la bitácora se
-- escribe solo vía rentas.registrar_ical_sync_evento (sistema) y es append-only.
create policy "staff ve la bitacora de sync de su property" on rentas.ical_sync_bitacora for select
  using (core.has_property_access(auth.uid(), property_id));

-- Justificación de seguridad (UPDATE acotado): el staff solo puede MARCAR UNA ALERTA
-- COMO ATENDIDA, una sola vez y atribuyéndosela a sí mismo: using exige que siga abierta
-- y with check exige atendida_en no nulo y atendida_por = auth.uid() (nadie puede
-- atribuir la atención a otro ni reabrir una alerta). El GRANT es por columna: ninguna
-- otra columna de la bitácora es escribible por `authenticated`.
create policy "staff atiende alertas de sync de su property" on rentas.ical_sync_bitacora for update
  using (core.has_property_access(auth.uid(), property_id) and atendida_en is null)
  with check (core.has_property_access(auth.uid(), property_id) and atendida_en is not null and atendida_por = auth.uid());

revoke all on rentas.ical_sync_bitacora from public, anon;
grant select on rentas.ical_sync_bitacora to authenticated;
grant update (atendida_en, atendida_por) on rentas.ical_sync_bitacora to authenticated;
grant select, insert, update, delete on rentas.ical_sync_bitacora to service_role;

-- ---------------------------------------------------------------------------
-- 4) Resolver conflictos de calendario (rentas.conflicto_calendario).
-- ---------------------------------------------------------------------------
-- 001 solo concedía select + insert: un conflicto detectado (overbooking entre canales o
-- capa cruzada) quedaba abierto para siempre. Justificación de seguridad: UPDATE por
-- columna solo de resuelto_en/resuelto_por; using exige que siga abierto y with check
-- exige resuelto_en no nulo y resuelto_por = auth.uid() (una sola transición, atribuida
-- al actor real; no se puede reabrir ni resolver "a nombre de" otro). La sesión de
-- sistema (auth.uid() is null) NO resuelve conflictos: no hay escape hatch aquí a
-- propósito -- resolver es una decisión humana (el sistema nunca cancela una reserva).
create policy "staff resuelve conflictos de su property" on rentas.conflicto_calendario for update
  using (core.has_property_access(auth.uid(), property_id) and resuelto_en is null)
  with check (core.has_property_access(auth.uid(), property_id) and resuelto_en is not null and resuelto_por = auth.uid());

grant update (resuelto_en, resuelto_por) on rentas.conflicto_calendario to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Funciones de SOLO-SISTEMA (cron): claim, liberar, registrar evento.
-- ---------------------------------------------------------------------------
-- Las tres corren como el rol dueño (security definer) porque las columnas de lease y la
-- tabla de bitácora no son escribibles por `authenticated`; las tres exigen
-- auth.uid() is null (la sesión de sistema del cron, ver 015) y rechazan con 42501 a
-- cualquier staff autenticado. search_path fijo; EXECUTE revocado a public (y por tanto
-- a anon) y concedido solo a authenticated (el rol bajo el que corre la sesión de
-- sistema) y service_role.

-- 5a) Reclamar un lote de feeds.
-- Idempotente y segura entre instancias: `for update skip locked` garantiza que dos
-- llamadas concurrentes nunca reciben el mismo feed; el lease evita que un feed sea
-- reclamado de nuevo mientras otra instancia lo procesa; p_intervalo_minimo_segundos es
-- el piso de espaciamiento entre intentos (un cron más frecuente de lo previsto no
-- golpea a los canales de más); proximo_intento_en respeta el backoff.
create function rentas.claim_ical_feeds(
  p_limite integer default 10,
  p_lease_segundos integer default 120,
  p_intervalo_minimo_segundos integer default 600
)
returns table (feed_id uuid, lease_token uuid)
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_limite integer := least(greatest(coalesce(p_limite, 10), 1), 50);
  v_lease integer := least(greatest(coalesce(p_lease_segundos, 120), 30), 900);
  v_minimo integer := least(greatest(coalesce(p_intervalo_minimo_segundos, 600), 0), 3600);
begin
  if auth.uid() is not null then
    raise exception 'rentas.claim_ical_feeds: solo la sesion de sistema (auth.uid() es NULL) puede reclamar feeds.' using errcode = '42501';
  end if;

  return query
  with candidatos as (
    select f.id
    from rentas.canal_feed_externo f
    where f.activo
      and (f.lease_hasta is null or f.lease_hasta <= now())
      and (f.proximo_intento_en is null or f.proximo_intento_en <= now())
      and (f.ultimo_intento_en is null or f.ultimo_intento_en <= now() - make_interval(secs => v_minimo))
    order by coalesce(f.ultimo_intento_en, '-infinity'::timestamptz), f.id
    limit v_limite
    for update skip locked
  ), reclamados as (
    update rentas.canal_feed_externo f
    set lease_hasta = now() + make_interval(secs => v_lease),
        lease_token = gen_random_uuid(),
        ultimo_intento_en = now()
    from candidatos c
    where f.id = c.id
    returning f.id, f.lease_token
  )
  select r.id, r.lease_token from reclamados r;
end;
$$;

revoke all on function rentas.claim_ical_feeds(integer, integer, integer) from public;
grant execute on function rentas.claim_ical_feeds(integer, integer, integer) to authenticated, service_role;

-- 5b) Liberar el lease. Solo quien conserva el token vigente puede liberar (un
-- consumidor cuyo lease ya expiró y fue reclamado por otro NO pisa el lease nuevo).
-- Tras un fallo, fija el backoff con base en intentos_fallidos_consecutivos (que el
-- motor ya persistió en su propia transacción); un fallo sin contador (error interno que
-- revirtió la transacción) cuenta como mínimo 1. Devuelve false si el token ya no es el
-- vigente.
create function rentas.liberar_ical_feed(p_feed_id uuid, p_lease_token uuid, p_exito boolean)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'rentas.liberar_ical_feed: solo la sesion de sistema (auth.uid() es NULL) puede liberar un lease.' using errcode = '42501';
  end if;

  update rentas.canal_feed_externo f
  set lease_hasta = null,
      lease_token = null,
      proximo_intento_en = case
        when coalesce(p_exito, false) then null
        else now() + make_interval(secs => rentas.ical_backoff_segundos(f.intentos_fallidos_consecutivos))
      end
  where f.id = p_feed_id and f.lease_token is not null and f.lease_token = p_lease_token
  returning f.id into v_id;

  return v_id is not null;
end;
$$;

revoke all on function rentas.liberar_ical_feed(uuid, uuid, boolean) from public;
grant execute on function rentas.liberar_ical_feed(uuid, uuid, boolean) to authenticated, service_role;

-- 5c) Registrar un evento de la bitácora. organization/property/unidad/canal se derivan
-- SIEMPRE del feed (nunca de parámetros): un llamador no puede escribir una fila con el
-- tenant de otra organización.
create function rentas.registrar_ical_sync_evento(
  p_feed_id uuid,
  p_tipo text,
  p_severidad text,
  p_detalle text,
  p_eventos_aplicados integer default 0,
  p_conflictos integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'rentas.registrar_ical_sync_evento: solo la sesion de sistema (auth.uid() es NULL) escribe la bitacora de sync.' using errcode = '42501';
  end if;

  insert into rentas.ical_sync_bitacora (organization_id, property_id, unidad_id, feed_id, canal_id, tipo, severidad, detalle, eventos_aplicados, conflictos)
  select f.organization_id, f.property_id, f.unidad_id, f.id, f.canal_id, p_tipo, p_severidad, left(coalesce(p_detalle, ''), 500), greatest(coalesce(p_eventos_aplicados, 0), 0), greatest(coalesce(p_conflictos, 0), 0)
  from rentas.canal_feed_externo f
  where f.id = p_feed_id
  returning id into v_id;

  if v_id is null then
    raise exception 'rentas.registrar_ical_sync_evento: el feed % no existe.', p_feed_id using errcode = 'P0002';
  end if;
  return v_id;
end;
$$;

revoke all on function rentas.registrar_ical_sync_evento(uuid, text, text, text, integer, integer) from public;
grant execute on function rentas.registrar_ical_sync_evento(uuid, text, text, text, integer, integer) to authenticated, service_role;
