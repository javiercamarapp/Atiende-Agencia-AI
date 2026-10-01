-- PL-13 P1 (plataforma) -- privacidad a nivel plataforma y por organizacion (cliente):
--   A) vista unificada de solicitudes ARCO con plazos y estados (citas, restaurantes, hoteles),
--   B) politicas de retencion configurables por organizacion con valores por defecto documentados,
--   C) registro de purgas (que, cuando, cuantas filas, SIN PII) y bloqueo previo a purga,
--   D) aviso de privacidad versionado por organizacion con aceptacion registrada.
--
-- Documentacion operativa, NO asesoria legal: los plazos y dias de retencion por defecto son una
-- referencia tecnica conservadora (dias de CALENDARIO) tomada de los verticales ya en main; el
-- responsable debe validarlos con su asesor juridico (ver docs/PRIVACIDAD-PLATAFORMA.md).
--
-- Reutiliza, sin duplicar: las solicitudes ARCO siguen viviendo en citas.data_rights_requests
-- (024), restaurantes.data_rights_requests (030) y hoteles.arco_request (032); aqui SOLO se leen,
-- normalizadas y sin datos de contacto del titular. La retencion de conversaciones y voz de
-- restaurantes ya parametrizada en restaurantes.privacy_config (030) se respeta como valor
-- intermedio (politica de la organizacion > config del vertical > defecto del catalogo).
--
-- Que agrega (todo NUEVO; nada se aplica al mergear -- el codigo TypeScript degrada con
-- SAVEPOINT ante 42883/42P01/42703):
--   Tablas:  core.retention_class, core.retention_policy, core.purge_hold, core.purge_run_log,
--            core.privacy_notice_version, core.privacy_notice_acceptance.
--   Internas (sin EXECUTE para nadie salvo funciones definer): core._privacy_is_org_admin,
--            core._privacy_is_platform_reader, core._arco_union, core._retention_effective.
--   Staff owner/admin de la organizacion: org_list_arco_requests, org_list_retention_policies,
--            org_set_retention_policy, org_clear_retention_policy, org_place_purge_hold,
--            org_release_purge_hold, org_list_purge_holds, org_list_purge_runs,
--            org_publish_privacy_notice, org_accept_privacy_notice, org_list_privacy_notices.
--   Superadmin (solo lectura): platform_list_arco_requests, platform_privacy_overview,
--            platform_list_purge_runs.
--   Solo sistema (cron/endpoint interno, NO programado): system_run_retention_purge y
--            system_list_purge_targets (pares organizacion/clase por paginas de organizaciones).
--
-- Requiere: 0001 (core.organization, core.staff_user, core.membership), 0012
-- (core.is_platform_superadmin), 0034 (core.cfo_zone_role), citas 024, restaurantes 030 y
-- hoteles 032 (aplicadas con timestamp menor en supabase/migrations/).
--
-- Justificacion de seguridad (cada tabla, GRANT y funcion trae su razon):
--   * Las seis tablas: RLS habilitado SIN policy y REVOKE ALL a public, anon, authenticated y
--     service_role. Razon: contienen configuracion de privacidad y evidencia de cumplimiento;
--     ningun rol de la aplicacion lee ni escribe directo. NO hay GRANT por columna porque
--     ninguna columna es accesible por rol alguno: todo pasa por las funciones definer de abajo,
--     que validan rol, organizacion y cada valor (deny-by-default; una columna futura no queda
--     expuesta por accidente). Esto evita ademas `using (true)`.
--   * purge_run_log, privacy_notice_version y privacy_notice_acceptance son append-only: un
--     trigger rechaza UPDATE y DELETE (0A000) incluso para el dueño. Sin PII por diseno: solo
--     organizacion, clase de dato, conteos, fechas y actor (uuid plano, sin FK para que una baja
--     de usuario no choque con el trigger).
--   * Funciones internas (_privacy_*, _arco_union, _retention_effective): security definer con
--     search_path fijo y REVOKE ALL a public/anon/authenticated. Razon: _arco_union lee las
--     tablas de TODOS los clientes sin filtro; si fuera ejecutable por un rol, rompería el
--     aislamiento entre organizaciones. Solo la alcanzan las funciones definer de este archivo.
--   * org_*: security definer, search_path fijo, GRANT a authenticated (no anon). Exigen
--     auth.uid() no nulo y membresia de la organizacion con platform_role owner/admin; el
--     parametro p_org es un dato, nunca una credencial. Las lecturas devuelven CERO filas a quien
--     no cumple (no revelan si la organizacion existe); las escrituras lanzan 42501. Las
--     solicitudes ARCO se devuelven SIN telefono, correo ni nombre del titular (minimizacion):
--     el detalle con datos personales sigue en el panel del vertical.
--   * platform_*: security definer, search_path fijo, GRANT a authenticated (no anon). Exigen
--     auth.uid() = p_caller_id, superadmin real (core.is_platform_superadmin) y que NO tenga rol
--     restringido de zona CFO; si no, cero filas. Son de solo lectura.
--   * system_list_purge_targets: security definer, search_path fijo, GRANT a authenticated y guard
--     `auth.uid() is null`. Razon: enumera organizaciones (solo id y clase, sin PII) para que el
--     endpoint interno recorra una transaccion por unidad; un usuario de staff no la puede llamar.
--   * system_run_retention_purge: security definer, search_path fijo, GRANT a authenticated (la
--     sesion de sistema usa ese rol con sub vacio) y guard `auth.uid() is null`: un usuario de
--     staff, aun owner, NO puede dispararla. Antes de borrar consulta el bloqueo (retencion legal
--     activa) y conserva a todo titular con una solicitud ARCO abierta; cada llamada, incluso
--     bloqueada o simulada, queda en purge_run_log.

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Catalogo de clases de dato retenible (valores por defecto documentados)
-- ═══════════════════════════════════════════════════════════════════════════
create table core.retention_class (
  data_class text primary key check (data_class ~ '^[a-z0-9_]{3,80}$'),
  vertical text not null check (char_length(vertical) between 1 and 40),
  description text not null check (char_length(description) between 10 and 400),
  default_days integer not null check (default_days >= 0),
  min_days integer not null check (min_days >= 0),
  max_days integer not null,
  -- 'plataforma': core.system_run_retention_purge la ejecuta con la politica de la organizacion.
  -- 'vertical': la purga la corre el propio vertical con su configuracion; aqui solo se documenta
  -- el valor por defecto (no se permite una politica de plataforma que el vertical no aplicaria).
  executor text not null check (executor in ('plataforma', 'vertical')),
  check (min_days <= default_days and default_days <= max_days)
);
alter table core.retention_class enable row level security;
revoke all on core.retention_class from public, anon, authenticated, service_role;

-- Los rangos de las dos primeras clases coinciden con los CHECK de restaurantes.privacy_config (030).
insert into core.retention_class (data_class, vertical, description, default_days, min_days, max_days, executor) values
  ('restaurantes_whatsapp_conversaciones', 'restaurantes', 'Mensajes de las conversaciones de WhatsApp de comensales; al vencer se vacia el historial y se conserva la fila y su vinculo al pedido.', 180, 30, 1095, 'plataforma'),
  ('restaurantes_voz_transcripciones', 'restaurantes', 'Transcripciones de llamadas de voz y hash del telefono de quien llamo; 0 = no se conserva transcripcion.', 30, 0, 365, 'plataforma'),
  ('hoteles_identidad_documento', 'hoteles', 'Documento de identidad del huesped en la boveda cifrada: bloqueo y purga al vencer la retencion, salvo retencion legal activa. La purga la corre el vertical (hoteles.sweep_identity_retention).', 30, 0, 365, 'vertical');

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Politica de retencion por organizacion
-- ═══════════════════════════════════════════════════════════════════════════
create table core.retention_policy (
  organization_id uuid not null references core.organization(id) on delete cascade,
  data_class text not null references core.retention_class(data_class) on delete restrict,
  retention_days integer not null check (retention_days >= 0),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (organization_id, data_class)
);
alter table core.retention_policy enable row level security;
revoke all on core.retention_policy from public, anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Bloqueo previo a purga (retencion legal) y registro de purgas
-- ═══════════════════════════════════════════════════════════════════════════
create table core.purge_hold (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- NULL = bloquea TODAS las clases de la organizacion.
  data_class text references core.retention_class(data_class) on delete restrict,
  reason text not null check (char_length(btrim(reason)) between 10 and 300),
  placed_by uuid not null,
  placed_at timestamptz not null default now(),
  released_at timestamptz,
  released_by uuid,
  release_note text check (release_note is null or char_length(release_note) <= 300),
  check ((released_at is null) = (released_by is null))
);
-- Un solo bloqueo ACTIVO por (organizacion, clase o todas).
create unique index purge_hold_active_uniq on core.purge_hold (organization_id, coalesce(data_class, '*')) where released_at is null;
create index purge_hold_org_idx on core.purge_hold (organization_id, seq desc);
alter table core.purge_hold enable row level security;
revoke all on core.purge_hold from public, anon, authenticated, service_role;

create table core.purge_run_log (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  organization_id uuid not null references core.organization(id) on delete restrict,
  data_class text not null references core.retention_class(data_class) on delete restrict,
  status text not null check (status in ('ok', 'simulacion', 'bloqueada', 'sin_ejecutor')),
  retention_days integer check (retention_days is null or retention_days >= 0),
  cutoff_at timestamptz,
  -- Filas vaciadas/borradas (conversaciones vaciadas; turnos de voz borrados).
  rows_affected integer not null default 0 check (rows_affected >= 0),
  -- Filas que quedaron solo anonimizadas (llamadas sin su hash de telefono).
  rows_anonymized integer not null default 0 check (rows_anonymized >= 0),
  -- Filas vencidas que se CONSERVARON porque su titular tiene una solicitud ARCO abierta.
  rows_protected integer not null default 0 check (rows_protected >= 0),
  -- Motivo corto y fijo del bloqueo, nunca texto libre ni PII.
  blocked_reason text check (blocked_reason is null or blocked_reason in ('retencion_legal_activa')),
  triggered_by text not null default 'sistema' check (triggered_by in ('sistema')),
  created_at timestamptz not null default now()
);
create index purge_run_log_org_idx on core.purge_run_log (organization_id, seq desc);
create index purge_run_log_seq_idx on core.purge_run_log (seq desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Aviso de privacidad versionado por organizacion + aceptacion
-- ═══════════════════════════════════════════════════════════════════════════
create table core.privacy_notice_version (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  organization_id uuid not null references core.organization(id) on delete restrict,
  version integer not null check (version >= 1),
  title text not null check (char_length(btrim(title)) between 3 and 200),
  -- Texto del aviso simplificado que se muestra al titular.
  summary text not null check (char_length(btrim(summary)) between 10 and 2000),
  -- URL del aviso integral (https obligatorio).
  notice_url text not null check (notice_url ~ '^https://[^[:space:]]+$' and char_length(notice_url) <= 500),
  -- sha256 de titulo + resumen + URL: evidencia de EXACTAMENTE lo que se publico.
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  published_by uuid not null,
  created_at timestamptz not null default now(),
  unique (organization_id, version)
);
create index privacy_notice_version_org_idx on core.privacy_notice_version (organization_id, version desc);

create table core.privacy_notice_acceptance (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  organization_id uuid not null references core.organization(id) on delete restrict,
  notice_id uuid not null references core.privacy_notice_version(id) on delete restrict,
  version integer not null check (version >= 1),
  accepted_by uuid not null,
  accepted_at timestamptz not null default now(),
  unique (notice_id, accepted_by)
);
create index privacy_notice_acceptance_org_idx on core.privacy_notice_acceptance (organization_id, seq desc);

create or replace function core.privacy_append_only_block_mutation()
returns trigger language plpgsql set search_path = core, pg_temp as $$
begin
  raise exception 'core_privacy_append_only: % no esta permitido sobre %', tg_op, tg_table_name using errcode = '0A000';
end;
$$;
revoke all on function core.privacy_append_only_block_mutation() from public, anon, authenticated;

create trigger purge_run_log_block_update_trg before update on core.purge_run_log for each row execute function core.privacy_append_only_block_mutation();
create trigger purge_run_log_block_delete_trg before delete on core.purge_run_log for each row execute function core.privacy_append_only_block_mutation();
create trigger privacy_notice_version_block_update_trg before update on core.privacy_notice_version for each row execute function core.privacy_append_only_block_mutation();
create trigger privacy_notice_version_block_delete_trg before delete on core.privacy_notice_version for each row execute function core.privacy_append_only_block_mutation();
create trigger privacy_notice_acceptance_block_update_trg before update on core.privacy_notice_acceptance for each row execute function core.privacy_append_only_block_mutation();
create trigger privacy_notice_acceptance_block_delete_trg before delete on core.privacy_notice_acceptance for each row execute function core.privacy_append_only_block_mutation();

alter table core.purge_run_log enable row level security;
alter table core.privacy_notice_version enable row level security;
alter table core.privacy_notice_acceptance enable row level security;
revoke all on core.purge_run_log from public, anon, authenticated, service_role;
revoke all on core.privacy_notice_version from public, anon, authenticated, service_role;
revoke all on core.privacy_notice_acceptance from public, anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- E) Funciones internas (sin EXECUTE para ningun rol de la aplicacion)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core._privacy_is_org_admin(p_org uuid)
returns boolean language sql stable security definer set search_path = core, pg_temp as $$
  select auth.uid() is not null and p_org is not null and exists (
    select 1 from core.membership m
     where m.organization_id = p_org and m.user_id = auth.uid() and m.platform_role in ('owner', 'admin')
  );
$$;
revoke all on function core._privacy_is_org_admin(uuid) from public, anon, authenticated;

create or replace function core._privacy_is_platform_reader(p_caller_id uuid)
returns boolean language sql stable security definer set search_path = core, pg_temp as $$
  select auth.uid() is not null and p_caller_id is not null and auth.uid() = p_caller_id
     and core.is_platform_superadmin(p_caller_id)
     and not exists (select 1 from core.cfo_zone_role r where r.staff_user_id = p_caller_id);
$$;
revoke all on function core._privacy_is_platform_reader(uuid) from public, anon, authenticated;

-- Unifica las solicitudes ARCO de los verticales con estados normalizados y SIN datos del titular.
-- Fechas de hoteles (date) se leen como medianoche UTC del dia limite: la referencia mas temprana.
-- Plazo relevante (due_at): solicitud sin atender ('abierta') -> fecha de respuesta; en proceso o
-- bloqueada -> fecha de ejecucion (o de respuesta si no existe).
create or replace function core._arco_union()
returns table (
  organization_id uuid, vertical text, request_id uuid, right_type text, channel text,
  native_status text, status_bucket text, opened_at timestamptz,
  response_due_at timestamptz, execution_due_at timestamptz, due_at timestamptz,
  resolved_at timestamptz, is_open boolean, is_overdue boolean
)
language sql stable security definer set search_path = core, citas, restaurantes, hoteles, pg_temp as $$
  with u as (
    select r.organization_id, 'citas'::text as vertical, r.id as request_id, r.right_type, r.channel,
           r.status as native_status,
           case r.status when 'pendiente_confirmacion' then 'por_confirmar' when 'recibida' then 'abierta'
             when 'en_proceso' then 'en_proceso' when 'bloqueada' then 'bloqueada' when 'resuelta' then 'resuelta'
             when 'rechazada' then 'rechazada' else 'cerrada' end as status_bucket,
           r.requested_at as opened_at, r.response_due_at, r.execution_due_at, r.resolved_at
      from citas.data_rights_requests r
    union all
    select r.organization_id, 'restaurantes', r.id, r.right_type, r.channel, r.status,
           case r.status when 'pendiente_confirmacion' then 'por_confirmar' when 'recibida' then 'abierta'
             when 'en_proceso' then 'en_proceso' when 'bloqueada' then 'bloqueada' when 'resuelta' then 'resuelta'
             when 'rechazada' then 'rechazada' else 'cerrada' end,
           r.requested_at, r.response_due_at, r.execution_due_at, r.resolved_at
      from restaurantes.data_rights_requests r
    union all
    select a.organization_id, 'hoteles', a.id, a.right_type, a.channel, a.status,
           case a.status when 'recibida' then 'abierta' when 'en_revision' then 'en_proceso'
             when 'procedente' then 'en_proceso' when 'improcedente' then 'rechazada' else 'resuelta' end,
           a.created_at, a.response_due_on::timestamp at time zone 'UTC',
           a.execution_due_on::timestamp at time zone 'UTC', a.executed_at
      from hoteles.arco_request a
  )
  select u.organization_id, u.vertical, u.request_id, u.right_type, u.channel, u.native_status, u.status_bucket,
         u.opened_at, u.response_due_at, u.execution_due_at,
         case when u.status_bucket = 'abierta' then u.response_due_at else coalesce(u.execution_due_at, u.response_due_at) end,
         u.resolved_at,
         u.status_bucket in ('abierta', 'en_proceso', 'bloqueada'),
         u.status_bucket in ('abierta', 'en_proceso', 'bloqueada')
           and case when u.status_bucket = 'abierta' then u.response_due_at else coalesce(u.execution_due_at, u.response_due_at) end < now()
    from u;
$$;
revoke all on function core._arco_union() from public, anon, authenticated;

-- Dias efectivos de retencion: politica de la organizacion > config del vertical > defecto.
create or replace function core._retention_effective(p_org uuid, p_class text)
returns table (out_days integer, out_source text)
language plpgsql stable security definer set search_path = core, restaurantes, pg_temp as $$
declare
  v_class core.retention_class%rowtype;
  v_days integer;
begin
  select * into v_class from core.retention_class c where c.data_class = p_class;
  if not found then
    return;
  end if;
  if v_class.executor = 'plataforma' then
    select p.retention_days into v_days from core.retention_policy p where p.organization_id = p_org and p.data_class = p_class;
    if v_days is not null then
      return query select v_days, 'organizacion'::text;
      return;
    end if;
    if p_class = 'restaurantes_whatsapp_conversaciones' then
      select pc.conversation_retention_days into v_days from restaurantes.privacy_config pc where pc.organization_id = p_org;
    elsif p_class = 'restaurantes_voz_transcripciones' then
      select pc.voice_retention_days into v_days from restaurantes.privacy_config pc where pc.organization_id = p_org;
    end if;
    if v_days is not null then
      return query select v_days, 'vertical'::text;
      return;
    end if;
  end if;
  return query select v_class.default_days, 'defecto'::text;
end;
$$;
revoke all on function core._retention_effective(uuid, text) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- F) Staff owner/admin de la organizacion
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.org_list_arco_requests(p_org uuid, p_only_open boolean, p_limit integer, p_offset integer)
returns table (
  out_vertical text, out_request_id uuid, out_right_type text, out_channel text, out_native_status text,
  out_status_bucket text, out_opened_at timestamptz, out_response_due_at timestamptz, out_execution_due_at timestamptz,
  out_due_at timestamptz, out_resolved_at timestamptz, out_is_open boolean, out_is_overdue boolean, out_total bigint
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if not core._privacy_is_org_admin(p_org) then
    return;
  end if;
  return query
    select u.vertical, u.request_id, u.right_type, u.channel, u.native_status, u.status_bucket, u.opened_at,
           u.response_due_at, u.execution_due_at, u.due_at, u.resolved_at, u.is_open, u.is_overdue,
           count(*) over ()
      from core._arco_union() u
     where u.organization_id = p_org and (not coalesce(p_only_open, false) or u.is_open)
     order by u.is_open desc, u.is_overdue desc, u.due_at asc nulls last, u.opened_at desc, u.request_id
     limit v_limit offset v_offset;
end;
$$;
revoke all on function core.org_list_arco_requests(uuid, boolean, integer, integer) from public, anon;
grant execute on function core.org_list_arco_requests(uuid, boolean, integer, integer) to authenticated;

create or replace function core.org_list_retention_policies(p_org uuid)
returns table (
  out_data_class text, out_vertical text, out_description text, out_executor text,
  out_default_days integer, out_min_days integer, out_max_days integer,
  out_effective_days integer, out_source text, out_updated_at timestamptz
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if not core._privacy_is_org_admin(p_org) then
    return;
  end if;
  return query
    select c.data_class, c.vertical, c.description, c.executor, c.default_days, c.min_days, c.max_days,
           e.out_days, e.out_source, p.updated_at
      from core.retention_class c
      cross join lateral core._retention_effective(p_org, c.data_class) e
      left join core.retention_policy p on p.organization_id = p_org and p.data_class = c.data_class
     order by c.vertical, c.data_class;
end;
$$;
revoke all on function core.org_list_retention_policies(uuid) from public, anon;
grant execute on function core.org_list_retention_policies(uuid) to authenticated;

create or replace function core.org_set_retention_policy(p_org uuid, p_data_class text, p_days integer)
returns integer language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_class core.retention_class%rowtype;
begin
  if v_actor is null or not core._privacy_is_org_admin(p_org) then
    raise exception 'org_set_retention_policy: solo owner/admin de la organizacion' using errcode = '42501';
  end if;
  select * into v_class from core.retention_class c where c.data_class = p_data_class;
  if not found then
    raise exception 'org_set_retention_policy: clase de dato desconocida' using errcode = '22023';
  end if;
  if v_class.executor <> 'plataforma' then
    raise exception 'org_set_retention_policy: la retencion de esta clase la gobierna el vertical' using errcode = '22023';
  end if;
  if p_days is null or p_days < v_class.min_days or p_days > v_class.max_days then
    raise exception 'org_set_retention_policy: los dias deben estar entre % y %', v_class.min_days, v_class.max_days using errcode = '22023';
  end if;
  insert into core.retention_policy as rp (organization_id, data_class, retention_days, updated_by, updated_at)
  values (p_org, p_data_class, p_days, v_actor, now())
  on conflict (organization_id, data_class) do update
    set retention_days = excluded.retention_days, updated_by = excluded.updated_by, updated_at = now();
  return p_days;
end;
$$;
revoke all on function core.org_set_retention_policy(uuid, text, integer) from public, anon;
grant execute on function core.org_set_retention_policy(uuid, text, integer) to authenticated;

create or replace function core.org_clear_retention_policy(p_org uuid, p_data_class text)
returns boolean language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_deleted integer;
begin
  if auth.uid() is null or not core._privacy_is_org_admin(p_org) then
    raise exception 'org_clear_retention_policy: solo owner/admin de la organizacion' using errcode = '42501';
  end if;
  delete from core.retention_policy where organization_id = p_org and data_class = p_data_class;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;
revoke all on function core.org_clear_retention_policy(uuid, text) from public, anon;
grant execute on function core.org_clear_retention_policy(uuid, text) to authenticated;

create or replace function core.org_place_purge_hold(p_org uuid, p_data_class text, p_reason text)
returns uuid language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
begin
  if v_actor is null or not core._privacy_is_org_admin(p_org) then
    raise exception 'org_place_purge_hold: solo owner/admin de la organizacion' using errcode = '42501';
  end if;
  if p_data_class is not null and not exists (select 1 from core.retention_class c where c.data_class = p_data_class) then
    raise exception 'org_place_purge_hold: clase de dato desconocida' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 10 or char_length(btrim(p_reason)) > 300 then
    raise exception 'org_place_purge_hold: el motivo debe tener entre 10 y 300 caracteres' using errcode = '22023';
  end if;
  insert into core.purge_hold (organization_id, data_class, reason, placed_by)
  values (p_org, p_data_class, btrim(p_reason), v_actor)
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'org_place_purge_hold: ya existe un bloqueo activo para esa clase' using errcode = '23505';
end;
$$;
revoke all on function core.org_place_purge_hold(uuid, text, text) from public, anon;
grant execute on function core.org_place_purge_hold(uuid, text, text) to authenticated;

create or replace function core.org_release_purge_hold(p_org uuid, p_hold_id uuid, p_note text)
returns boolean language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_updated integer;
begin
  if v_actor is null or not core._privacy_is_org_admin(p_org) then
    raise exception 'org_release_purge_hold: solo owner/admin de la organizacion' using errcode = '42501';
  end if;
  if p_note is not null and char_length(p_note) > 300 then
    raise exception 'org_release_purge_hold: la nota admite hasta 300 caracteres' using errcode = '22023';
  end if;
  -- La organizacion se exige en el WHERE: un hold de OTRA organizacion no se libera.
  update core.purge_hold h
     set released_at = now(), released_by = v_actor, release_note = nullif(btrim(p_note), '')
   where h.id = p_hold_id and h.organization_id = p_org and h.released_at is null;
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;
revoke all on function core.org_release_purge_hold(uuid, uuid, text) from public, anon;
grant execute on function core.org_release_purge_hold(uuid, uuid, text) to authenticated;

create or replace function core.org_list_purge_holds(p_org uuid)
returns table (
  out_id uuid, out_data_class text, out_reason text, out_placed_at timestamptz,
  out_released_at timestamptz, out_release_note text, out_active boolean
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if not core._privacy_is_org_admin(p_org) then
    return;
  end if;
  return query
    select h.id, h.data_class, h.reason, h.placed_at, h.released_at, h.release_note, h.released_at is null
      from core.purge_hold h
     where h.organization_id = p_org
     order by h.seq desc
     limit 100;
end;
$$;
revoke all on function core.org_list_purge_holds(uuid) from public, anon;
grant execute on function core.org_list_purge_holds(uuid) to authenticated;

create or replace function core.org_list_purge_runs(p_org uuid, p_limit integer, p_before_seq bigint)
returns table (
  out_seq bigint, out_data_class text, out_status text, out_retention_days integer, out_cutoff_at timestamptz,
  out_rows_affected integer, out_rows_anonymized integer, out_rows_protected integer, out_blocked_reason text, out_created_at timestamptz
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if not core._privacy_is_org_admin(p_org) then
    return;
  end if;
  return query
    select l.seq, l.data_class, l.status, l.retention_days, l.cutoff_at, l.rows_affected, l.rows_anonymized,
           l.rows_protected, l.blocked_reason, l.created_at
      from core.purge_run_log l
     where l.organization_id = p_org and (p_before_seq is null or l.seq < p_before_seq)
     order by l.seq desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;
revoke all on function core.org_list_purge_runs(uuid, integer, bigint) from public, anon;
grant execute on function core.org_list_purge_runs(uuid, integer, bigint) to authenticated;

create or replace function core.org_publish_privacy_notice(p_org uuid, p_title text, p_summary text, p_url text)
returns table (out_notice_id uuid, out_version integer)
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_version integer;
  v_id uuid;
  v_title text := btrim(coalesce(p_title, ''));
  v_summary text := btrim(coalesce(p_summary, ''));
  v_url text := btrim(coalesce(p_url, ''));
begin
  if v_actor is null or not core._privacy_is_org_admin(p_org) then
    raise exception 'org_publish_privacy_notice: solo owner/admin de la organizacion' using errcode = '42501';
  end if;
  if char_length(v_title) < 3 or char_length(v_title) > 200 then
    raise exception 'org_publish_privacy_notice: el titulo debe tener entre 3 y 200 caracteres' using errcode = '22023';
  end if;
  if char_length(v_summary) < 10 or char_length(v_summary) > 2000 then
    raise exception 'org_publish_privacy_notice: el resumen debe tener entre 10 y 2000 caracteres' using errcode = '22023';
  end if;
  if v_url !~ '^https://[^[:space:]]+$' or char_length(v_url) > 500 then
    raise exception 'org_publish_privacy_notice: la URL del aviso integral debe ser https y tener hasta 500 caracteres' using errcode = '22023';
  end if;
  -- Serializa las versiones de UNA organizacion (el unique (organizacion, version) es el respaldo).
  perform 1 from core.organization o where o.id = p_org for update;
  select coalesce(max(v.version), 0) + 1 into v_version from core.privacy_notice_version v where v.organization_id = p_org;
  insert into core.privacy_notice_version (organization_id, version, title, summary, notice_url, content_sha256, published_by)
  values (p_org, v_version, v_title, v_summary, v_url,
          encode(sha256(convert_to(v_title || E'\n' || v_summary || E'\n' || v_url, 'UTF8')), 'hex'), v_actor)
  returning id into v_id;
  -- Quien publica la version la acepta en el mismo acto.
  insert into core.privacy_notice_acceptance (organization_id, notice_id, version, accepted_by)
  values (p_org, v_id, v_version, v_actor);
  return query select v_id, v_version;
end;
$$;
revoke all on function core.org_publish_privacy_notice(uuid, text, text, text) from public, anon;
grant execute on function core.org_publish_privacy_notice(uuid, text, text, text) to authenticated;

create or replace function core.org_accept_privacy_notice(p_org uuid, p_version integer)
returns boolean language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_notice core.privacy_notice_version%rowtype;
  v_latest integer;
  v_inserted integer;
begin
  if v_actor is null or not core._privacy_is_org_admin(p_org) then
    raise exception 'org_accept_privacy_notice: solo owner/admin de la organizacion' using errcode = '42501';
  end if;
  select * into v_notice from core.privacy_notice_version v where v.organization_id = p_org and v.version = p_version;
  if not found then
    raise exception 'org_accept_privacy_notice: la version no existe para esta organizacion' using errcode = '22023';
  end if;
  select max(v.version) into v_latest from core.privacy_notice_version v where v.organization_id = p_org;
  if v_notice.version <> v_latest then
    raise exception 'org_accept_privacy_notice: solo se acepta la version vigente' using errcode = '22023';
  end if;
  insert into core.privacy_notice_acceptance (organization_id, notice_id, version, accepted_by)
  values (p_org, v_notice.id, v_notice.version, v_actor)
  on conflict (notice_id, accepted_by) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted > 0;
end;
$$;
revoke all on function core.org_accept_privacy_notice(uuid, integer) from public, anon;
grant execute on function core.org_accept_privacy_notice(uuid, integer) to authenticated;

create or replace function core.org_list_privacy_notices(p_org uuid, p_limit integer)
returns table (
  out_notice_id uuid, out_version integer, out_title text, out_summary text, out_notice_url text,
  out_content_sha256 text, out_created_at timestamptz, out_accepted_count bigint, out_accepted_by_caller boolean, out_is_current boolean
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if not core._privacy_is_org_admin(p_org) then
    return;
  end if;
  return query
    select v.id, v.version, v.title, v.summary, v.notice_url, v.content_sha256, v.created_at,
           (select count(*) from core.privacy_notice_acceptance a where a.notice_id = v.id),
           exists (select 1 from core.privacy_notice_acceptance a where a.notice_id = v.id and a.accepted_by = auth.uid()),
           v.version = (select max(x.version) from core.privacy_notice_version x where x.organization_id = p_org)
      from core.privacy_notice_version v
     where v.organization_id = p_org
     order by v.version desc
     limit least(greatest(coalesce(p_limit, 20), 1), 100);
end;
$$;
revoke all on function core.org_list_privacy_notices(uuid, integer) from public, anon;
grant execute on function core.org_list_privacy_notices(uuid, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- G) Superadmin (solo lectura)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.platform_list_arco_requests(p_caller_id uuid, p_only_open boolean, p_only_overdue boolean, p_limit integer, p_offset integer)
returns table (
  out_organization_id uuid, out_organization_name text, out_vertical text, out_request_id uuid, out_right_type text,
  out_channel text, out_native_status text, out_status_bucket text, out_opened_at timestamptz,
  out_response_due_at timestamptz, out_execution_due_at timestamptz, out_due_at timestamptz,
  out_resolved_at timestamptz, out_is_open boolean, out_is_overdue boolean, out_total bigint
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if not core._privacy_is_platform_reader(p_caller_id) then
    return;
  end if;
  return query
    select u.organization_id, o.name, u.vertical, u.request_id, u.right_type, u.channel, u.native_status, u.status_bucket,
           u.opened_at, u.response_due_at, u.execution_due_at, u.due_at, u.resolved_at, u.is_open, u.is_overdue,
           count(*) over ()
      from core._arco_union() u
      join core.organization o on o.id = u.organization_id
     where (not coalesce(p_only_open, false) or u.is_open) and (not coalesce(p_only_overdue, false) or u.is_overdue)
     order by u.is_overdue desc, u.is_open desc, u.due_at asc nulls last, u.opened_at desc, u.request_id
     limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end;
$$;
revoke all on function core.platform_list_arco_requests(uuid, boolean, boolean, integer, integer) from public, anon;
grant execute on function core.platform_list_arco_requests(uuid, boolean, boolean, integer, integer) to authenticated;

create or replace function core.platform_privacy_overview(p_caller_id uuid, p_limit integer, p_offset integer)
returns table (
  out_organization_id uuid, out_organization_name text, out_vertical text, out_open_arco bigint, out_overdue_arco bigint,
  out_notice_version integer, out_notice_acceptances bigint, out_active_holds bigint,
  out_last_purge_at timestamptz, out_last_purge_status text, out_total bigint
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if not core._privacy_is_platform_reader(p_caller_id) then
    return;
  end if;
  return query
    with arco as (
      select u.organization_id as org, count(*) filter (where u.is_open) as open_cnt, count(*) filter (where u.is_overdue) as overdue_cnt
        from core._arco_union() u group by u.organization_id
    )
    select o.id, o.name, o.vertical,
           coalesce(a.open_cnt, 0), coalesce(a.overdue_cnt, 0),
           n.version,
           coalesce((select count(*) from core.privacy_notice_acceptance x where x.notice_id = n.id), 0),
           (select count(*) from core.purge_hold h where h.organization_id = o.id and h.released_at is null),
           pr.created_at, pr.status,
           count(*) over ()
      from core.organization o
      left join arco a on a.org = o.id
      left join lateral (select v.id, v.version from core.privacy_notice_version v where v.organization_id = o.id order by v.version desc limit 1) n on true
      left join lateral (select l.created_at, l.status from core.purge_run_log l where l.organization_id = o.id order by l.seq desc limit 1) pr on true
     order by coalesce(a.overdue_cnt, 0) desc, coalesce(a.open_cnt, 0) desc, o.name, o.id
     limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end;
$$;
revoke all on function core.platform_privacy_overview(uuid, integer, integer) from public, anon;
grant execute on function core.platform_privacy_overview(uuid, integer, integer) to authenticated;

create or replace function core.platform_list_purge_runs(p_caller_id uuid, p_limit integer, p_before_seq bigint)
returns table (
  out_seq bigint, out_organization_id uuid, out_organization_name text, out_data_class text, out_status text,
  out_retention_days integer, out_cutoff_at timestamptz, out_rows_affected integer, out_rows_anonymized integer,
  out_rows_protected integer, out_blocked_reason text, out_created_at timestamptz
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if not core._privacy_is_platform_reader(p_caller_id) then
    return;
  end if;
  return query
    select l.seq, l.organization_id, o.name, l.data_class, l.status, l.retention_days, l.cutoff_at, l.rows_affected,
           l.rows_anonymized, l.rows_protected, l.blocked_reason, l.created_at
      from core.purge_run_log l
      join core.organization o on o.id = l.organization_id
     where p_before_seq is null or l.seq < p_before_seq
     order by l.seq desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;
revoke all on function core.platform_list_purge_runs(uuid, integer, bigint) from public, anon;
grant execute on function core.platform_list_purge_runs(uuid, integer, bigint) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- H) Purga por retencion -- SOLO SISTEMA (cron/endpoint interno; NO programado)
-- ═══════════════════════════════════════════════════════════════════════════
-- Una organizacion y una clase por llamada (una transaccion por unidad). Orden: (1) bloqueo
-- previo (retencion legal activa -> no se toca nada y se registra); (2) dias efectivos; (3) conservar
-- a todo titular con ARCO abierta (recibida/en_proceso/bloqueada); (4) ejecutar (o simular) por lote
-- acotado; (5) registrar SIEMPRE el resultado sin PII. Con p_dry_run solo cuenta.
create or replace function core.system_run_retention_purge(p_org uuid, p_data_class text, p_dry_run boolean default false, p_limit integer default 500)
returns table (out_run_id uuid, out_status text, out_retention_days integer, out_rows_affected integer, out_rows_anonymized integer, out_rows_protected integer)
language plpgsql security definer set search_path = core, restaurantes, pg_temp as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_dry boolean := coalesce(p_dry_run, false);
  v_class core.retention_class%rowtype;
  v_days integer;
  v_cutoff timestamptz;
  v_affected integer := 0;
  v_anon integer := 0;
  v_protected integer := 0;
  v_status text;
  v_blocked text;
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'system_run_retention_purge: solo para la sesion de sistema' using errcode = '42501';
  end if;
  if not exists (select 1 from core.organization o where o.id = p_org) then
    raise exception 'system_run_retention_purge: la organizacion no existe' using errcode = '22023';
  end if;
  select * into v_class from core.retention_class c where c.data_class = p_data_class;
  if not found then
    raise exception 'system_run_retention_purge: clase de dato desconocida' using errcode = '22023';
  end if;

  select e.out_days into v_days from core._retention_effective(p_org, p_data_class) e;
  v_cutoff := now() - make_interval(days => v_days);

  if v_class.executor <> 'plataforma' then
    v_status := 'sin_ejecutor';
  elsif exists (
    select 1 from core.purge_hold h
     where h.organization_id = p_org and h.released_at is null and (h.data_class is null or h.data_class = p_data_class)
  ) then
    v_status := 'bloqueada';
    v_blocked := 'retencion_legal_activa';
  elsif p_data_class = 'restaurantes_whatsapp_conversaciones' then
    select count(*) into v_protected
      from restaurantes.whatsapp_conversations w
     where w.organization_id = p_org and w.messages <> '[]'::jsonb and w.updated_at < v_cutoff
       and exists (
         select 1 from restaurantes.data_rights_requests r
          where r.organization_id = w.organization_id and r.customer_phone = w.phone and r.status in ('recibida', 'en_proceso', 'bloqueada')
       );
    if v_dry then
      select count(*) into v_affected from (
        select 1 from restaurantes.whatsapp_conversations w
         where w.organization_id = p_org and w.messages <> '[]'::jsonb and w.updated_at < v_cutoff
           and not exists (
             select 1 from restaurantes.data_rights_requests r
              where r.organization_id = w.organization_id and r.customer_phone = w.phone and r.status in ('recibida', 'en_proceso', 'bloqueada')
           )
         order by w.updated_at limit v_limit
      ) s;
    else
      with victims as (
        select w.id from restaurantes.whatsapp_conversations w
         where w.organization_id = p_org and w.messages <> '[]'::jsonb and w.updated_at < v_cutoff
           and not exists (
             select 1 from restaurantes.data_rights_requests r
              where r.organization_id = w.organization_id and r.customer_phone = w.phone and r.status in ('recibida', 'en_proceso', 'bloqueada')
           )
         order by w.updated_at limit v_limit
      ), cleared as (
        update restaurantes.whatsapp_conversations w set messages = '[]'::jsonb from victims v where w.id = v.id returning 1
      )
      select count(*) into v_affected from cleared;
    end if;
    v_status := case when v_dry then 'simulacion' else 'ok' end;
  elsif p_data_class = 'restaurantes_voz_transcripciones' then
    select count(*) into v_protected
      from restaurantes.voice_conversation c
     where c.organization_id = p_org and (c.ended_at is not null or c.started_at < now() - interval '1 day') and c.started_at < v_cutoff
       and (exists (select 1 from restaurantes.voice_turn t where t.conversation_id = c.id) or c.caller_hash is not null)
       and exists (
         select 1 from restaurantes.data_rights_requests r
          where r.organization_id = c.organization_id and r.status in ('recibida', 'en_proceso', 'bloqueada')
            and c.caller_hash = encode(sha256(convert_to(regexp_replace(r.customer_phone, '\D', '', 'g'), 'UTF8')), 'hex')
       );
    if v_dry then
      select count(*), count(*) filter (where s.has_hash) into v_affected, v_anon from (
        select c.caller_hash is not null as has_hash
          from restaurantes.voice_conversation c
         where c.organization_id = p_org and (c.ended_at is not null or c.started_at < now() - interval '1 day') and c.started_at < v_cutoff
           and (exists (select 1 from restaurantes.voice_turn t where t.conversation_id = c.id) or c.caller_hash is not null)
           and not exists (
             select 1 from restaurantes.data_rights_requests r
              where r.organization_id = c.organization_id and r.status in ('recibida', 'en_proceso', 'bloqueada')
                and c.caller_hash = encode(sha256(convert_to(regexp_replace(r.customer_phone, '\D', '', 'g'), 'UTF8')), 'hex')
           )
         order by c.started_at limit v_limit
      ) s;
      -- En simulacion rows_affected cuenta llamadas candidatas (no turnos): se documenta en el catalogo.
    else
      with old_calls as (
        select c.id from restaurantes.voice_conversation c
         where c.organization_id = p_org and (c.ended_at is not null or c.started_at < now() - interval '1 day') and c.started_at < v_cutoff
           and (exists (select 1 from restaurantes.voice_turn t where t.conversation_id = c.id) or c.caller_hash is not null)
           and not exists (
             select 1 from restaurantes.data_rights_requests r
              where r.organization_id = c.organization_id and r.status in ('recibida', 'en_proceso', 'bloqueada')
                and c.caller_hash = encode(sha256(convert_to(regexp_replace(r.customer_phone, '\D', '', 'g'), 'UTF8')), 'hex')
           )
         order by c.started_at limit v_limit
      ), del_turns as (
        delete from restaurantes.voice_turn t using old_calls o where t.conversation_id = o.id returning 1
      ), anon as (
        update restaurantes.voice_conversation c set caller_hash = null from old_calls o where c.id = o.id and c.caller_hash is not null returning 1
      )
      select (select count(*) from del_turns), (select count(*) from anon) into v_affected, v_anon;
    end if;
    v_status := case when v_dry then 'simulacion' else 'ok' end;
  else
    v_status := 'sin_ejecutor';
  end if;

  insert into core.purge_run_log (organization_id, data_class, status, retention_days, cutoff_at, rows_affected, rows_anonymized, rows_protected, blocked_reason)
  values (p_org, p_data_class, v_status, v_days, v_cutoff, v_affected, v_anon, v_protected, v_blocked)
  returning id into v_id;

  return query select v_id, v_status, v_days, v_affected, v_anon, v_protected;
end;
$$;
revoke all on function core.system_run_retention_purge(uuid, text, boolean, integer) from public, anon;
grant execute on function core.system_run_retention_purge(uuid, text, boolean, integer) to authenticated;

-- Pares (organizacion, clase) que la plataforma purga, por paginas de organizaciones ordenadas por id
-- (cursor p_after_org), o solo una organizacion (p_only_org). Una organizacion entra con las clases 'plataforma' de SU vertical. SOLO SISTEMA.
create or replace function core.system_list_purge_targets(p_after_org uuid, p_org_limit integer default 50, p_only_org uuid default null)
returns table (out_organization_id uuid, out_data_class text)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'system_list_purge_targets: solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
    select o.id, c.data_class
      from (
        select x.id, x.vertical from core.organization x
         where (p_after_org is null or x.id > p_after_org) and (p_only_org is null or x.id = p_only_org)
           and exists (select 1 from core.retention_class k where k.vertical = x.vertical and k.executor = 'plataforma')
         order by x.id
         limit least(greatest(coalesce(p_org_limit, 50), 1), 500)
      ) o
      join core.retention_class c on c.vertical = o.vertical and c.executor = 'plataforma'
     order by o.id, c.data_class;
end;
$$;
revoke all on function core.system_list_purge_targets(uuid, integer, uuid) from public, anon;
grant execute on function core.system_list_purge_targets(uuid, integer, uuid) to authenticated;
