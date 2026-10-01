-- "Chatea con tus datos" -- BITACORA de consultas (compartida por TODAS las verticales).
--
-- Que registra: QUIEN pregunto (auth.uid()), de que ORGANIZACION, que HERRAMIENTA del
-- catalogo cerrado se ejecuto, con que PARAMETROS tipados (periodo, sucursal, limite...),
-- el resultado en forma de conteo (outcome / row_count / duration_ms). NUNCA guarda los
-- resultados de la consulta, ni el texto libre de la pregunta, ni PII: el motor
-- (packages/agent-core/src/data-chat) ya sanitiza los parametros antes de llamar aqui y
-- esta migracion lo refuerza con CHECKs de forma y tamano.
--
-- Compatibilidad con la base SIN migrar: nada de lo existente depende de esta tabla. El
-- codigo TypeScript que la usa (PostgresDataChatAuditSink) corre `record_data_chat_query`
-- dentro de un SAVEPOINT y, si la funcion todavia no existe (42883/42P01), degrada a un log
-- estructurado: el chat sigue funcionando y la consulta queda en logs de aplicacion.
--
-- Requiere: 0001_core_schema.sql (core.organization, core.staff_user, core.membership).

-- ---------------------------------------------------------------------------
-- 1) core.data_chat_query_log -- append-only, orden total desde el dia uno (seq).
-- ---------------------------------------------------------------------------
create table core.data_chat_query_log (
  id uuid primary key default gen_random_uuid(),
  -- `created_at default now()` es constante dentro de una transaccion; `seq` desempata para
  -- que la paginacion por offset sea estable (mismo criterio que restaurantes.audit_log).
  seq bigint generated always as identity,
  organization_id uuid not null references core.organization(id) on delete restrict,
  user_id uuid not null references core.staff_user(id) on delete restrict,
  vertical text not null check (vertical in ('hoteles', 'restaurantes', 'rentas', 'licitaciones', 'citas', 'despachos')),
  -- null = el turno termino sin ejecutar herramienta (fuera de catalogo, limite, presupuesto).
  tool text check (tool is null or tool ~ '^[a-z0-9_]{1,80}$'),
  -- Solo parametros tipados del catalogo (periodo, fechas, enums, enteros, nombre corto
  -- de sucursal). Acotado en tamano y en forma: un objeto jsonb plano.
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object' and pg_column_size(params) <= 2000),
  outcome text not null check (outcome in ('ok', 'empty', 'unavailable', 'needs_clarification', 'error', 'denied', 'no_tool', 'rate_limited', 'budget_exceeded')),
  row_count integer not null default 0 check (row_count >= 0),
  duration_ms integer not null default 0 check (duration_ms >= 0),
  error_code text check (error_code is null or char_length(error_code) <= 60),
  created_at timestamptz not null default now()
);

create index data_chat_query_log_org_created_idx on core.data_chat_query_log (organization_id, created_at desc, seq desc);
create index data_chat_query_log_user_created_idx on core.data_chat_query_log (user_id, created_at desc);

alter table core.data_chat_query_log enable row level security;

-- Lectura: SOLO owner/admin de la organizacion duena (platform_role). Justificacion: la
-- bitacora dice que pregunto cada compañero; un 'member'/'viewer' no debe verla. Cross-
-- tenant: la policy ata la fila a la membership del propio auth.uid() en ESA organizacion.
create policy "owner/admin lee la bitacora del chat con datos de su organizacion" on core.data_chat_query_log for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = data_chat_query_log.organization_id
      and m.user_id = auth.uid()
      and m.platform_role in ('owner', 'admin')
  ));

-- Escritura: SOLO via core.record_data_chat_query() (abajo). Sin policy de INSERT para
-- `authenticated` (deny-by-default) y sin GRANT de insert/update/delete a nadie: ni
-- `service_role` (bypassrls) tiene vias de escritura directa con un actor arbitrario.
-- `anon` no recibe nada. Solo `select` para authenticated (filtrado por la policy) y
-- service_role (jobs de plataforma).
revoke all on core.data_chat_query_log from public, anon, authenticated, service_role;
grant select on core.data_chat_query_log to authenticated, service_role;

-- Append-only de verdad: triggers de bloqueo incondicional (defensa en profundidad mas
-- alla de la ausencia de GRANT).
create or replace function core.data_chat_query_log_block_mutation()
returns trigger
language plpgsql
set search_path = core, pg_temp
as $$
begin
  raise exception 'data_chat_query_log_append_only: % no esta permitido sobre core.data_chat_query_log', tg_op
    using errcode = '0A000';
end;
$$;

create trigger data_chat_query_log_block_update_trg
  before update on core.data_chat_query_log
  for each row execute function core.data_chat_query_log_block_mutation();
create trigger data_chat_query_log_block_delete_trg
  before delete on core.data_chat_query_log
  for each row execute function core.data_chat_query_log_block_mutation();

-- ---------------------------------------------------------------------------
-- 2) core.record_data_chat_query -- UNICA via de escritura.
--    El actor SIEMPRE sale de auth.uid() (no hay parametro de usuario que falsificar).
--    SECURITY DEFINER (necesario: authenticated no tiene INSERT sobre la tabla) con
--    search_path fijo y revoke de public/anon. Defensa en profundidad:
--      a) auth.uid() no nulo: nunca corre desde la sesion de sistema (28000).
--      b) el actor pertenece a p_organization_id (42501): un staff de otra organizacion
--         no puede sembrar filas en la bitacora de un tenant ajeno.
--      c) vertical valido y coherente con la organizacion: se toma de core.organization,
--         NO de un parametro -- un cliente no puede etiquetar una fila con otra vertical.
--    Truncado/normalizacion DENTRO de la funcion (unica via de escritura): el CHECK de
--    forma de la tabla (nombre de herramienta [a-z0-9_], longitudes) nunca se viola por un
--    caller con un valor largo o con caracteres raros.
-- ---------------------------------------------------------------------------
create or replace function core.record_data_chat_query(
  p_organization_id uuid,
  p_tool text,
  p_params jsonb,
  p_outcome text,
  p_row_count integer,
  p_duration_ms integer,
  p_error_code text
)
returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_vertical text;
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'core.record_data_chat_query: requiere un actor autenticado (auth.uid() es NULL) -- nunca corre desde la sesion de sistema.'
      using errcode = '28000';
  end if;

  if not exists (select 1 from core.membership m where m.organization_id = p_organization_id and m.user_id = v_actor) then
    raise exception 'core.record_data_chat_query: el actor % no pertenece a la organizacion %.', v_actor, p_organization_id
      using errcode = '42501';
  end if;

  select o.vertical into v_vertical from core.organization o where o.id = p_organization_id;

  insert into core.data_chat_query_log (organization_id, user_id, vertical, tool, params, outcome, row_count, duration_ms, error_code)
  values (
    p_organization_id,
    v_actor,
    v_vertical,
    nullif(regexp_replace(lower(left(p_tool, 80)), '[^a-z0-9_]', '_', 'g'), ''),
    case when p_params is not null and jsonb_typeof(p_params) = 'object' then p_params else '{}'::jsonb end,
    p_outcome,
    greatest(coalesce(p_row_count, 0), 0),
    greatest(coalesce(p_duration_ms, 0), 0),
    left(p_error_code, 60)
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function core.record_data_chat_query(uuid, text, jsonb, text, integer, integer, text) from public, anon;
grant execute on function core.record_data_chat_query(uuid, text, jsonb, text, integer, integer, text) to authenticated;

comment on table core.data_chat_query_log is
  'Bitacora append-only de "Chatea con tus datos": quien, que herramienta, parametros tipados y conteos. Nunca resultados ni PII.';
comment on function core.record_data_chat_query(uuid, text, jsonb, text, integer, integer, text) is
  'Unica via de escritura de core.data_chat_query_log: actor = auth.uid(), exige membership en la organizacion, vertical tomada de core.organization.';
