-- PL-16 -- topes de mensajes por plan que SE HACEN CUMPLIR, avisos de fin de prueba y lectura de
-- consumo del cliente / de superadmin.
--
-- Hallazgo (disponibilidad/negocio, no de confidencialidad): core.plan_limit (0028) ya guarda un tope
-- 'mensajes_mes' con accion_al_exceder (avisar | cobrar | pausar), pero NADIE lo lee al enviar: un plan
-- con tope de 1000 mensajes enviaba los que fuera, sin aviso ni registro de excedente. Y
-- core.organization.status = 'trial' no tenia fecha de fin, asi que no habia nada que avisar.
--
-- Esta migracion agrega SOLO la base de datos del medidor; ningun mensaje se bloquea por si misma:
--   A) core.organization.trial_ends_at (nullable: NULL = sin fecha de fin configurada, nunca se avisa) y
--      core.organization.timezone (default America/Mexico_City; trigger valida que sea una zona IANA real).
--      El corte de mes del medidor se hace en esa zona, no en UTC.
--   B) core.message_usage_event: libro mayor de mensajes atendidos (un mensaje saliente de WhatsApp enviado
--      por el outbox). Idempotente por (ref_tipo, ref_id): reintentar un registro no cuenta dos veces.
--      Tambien guarda los proactivos OMITIDOS por tope con su motivo (resultado 'omitido_proactivo').
--      Los turnos de agente NO se cuentan aparte: cada respuesta del agente sale por el mismo outbox y
--      contarla dos veces duplicaria el consumo.
--   C) Funciones de SOLO-SISTEMA (auth.uid() is null: cron/dispatcher):
--        core.message_quota_check   -- decide si un envio puede salir (solo bloquea proactivos no criticos
--                                      en planes con accion 'pausar' que ya llegaron al tope).
--        core.message_usage_record  -- registra un mensaje, calcula excedente y devuelve si cruzo 80 % / 100 %.
--   D) core.trial_notice_log + core.trial_notice_claim / _recipients / _mark (SOLO-SISTEMA): reclama una sola vez
--      por (organizacion, dias_antes, fecha de fin) los avisos de 7/3/1 dias; los correos fallidos se reintentan
--      hasta 3 veces.
--   E) Lecturas caller-bound: core.message_usage_for_org (miembro de la organizacion o superadmin) y
--      core.superadmin_list_message_usage (superadmin) -- ambas agregadas en una sola consulta (sin N+1).
--
-- Justificacion de seguridad (cada tabla, trigger, funcion y GRANT trae su razon):
--   * core.message_usage_event y core.trial_notice_log: RLS habilitada SIN policy y REVOKE ALL a public, anon,
--     authenticated y service_role: nadie las lee ni escribe directo; solo las funciones security definer de
--     abajo. No se otorga nada a anon ni GRANT a nivel columna porque no hay acceso directo a otorgar.
--   * Funciones de solo-sistema (check/record/claim/recipients/mark): security definer con search_path fijo,
--     REVOKE ALL a public y anon y GRANT EXECUTE a authenticated (el rol con el que corre la sesion de
--     sistema); la autorizacion real esta DENTRO: `auth.uid() is not null` lanza 42501, de modo que un
--     usuario autenticado no puede inflar ni vaciar el medidor de ninguna organizacion.
--   * core.message_usage_for_org: security definer, search_path fijo, REVOKE de public, GRANT a authenticated.
--     Exige auth.uid() = p_caller_id (42501 si no) y devuelve NULL (no un error que confirme existencia) a quien
--     no es miembro de la organizacion ni superadmin: cross-tenant aislado.
--   * core.superadmin_list_message_usage: exige auth.uid() = p_caller_id y core.is_platform_superadmin via
--     core.superadmin_require_caller; cualquier otro recibe 42501.
--   * core.trial_notice_recipients devuelve correos de owner/admin SOLO a la sesion de sistema que va a enviar el
--     aviso; nunca a un usuario autenticado. Los correos no se guardan en el log.
--   * El trigger de zona horaria solo valida contra pg_timezone_names; no concede nada.
--
-- NO escribe datos, NO toca produccion, NO programa ningun cron. Base sin esta migracion: el codigo TypeScript
-- captura 42883/42P01/42703 dentro de un SAVEPOINT y sigue como hoy (sin medidor, sin 500).

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Columnas de organizacion
-- ═══════════════════════════════════════════════════════════════════════════
alter table core.organization
  add column trial_ends_at timestamptz,
  add column timezone text not null default 'America/Mexico_City';

create or replace function core.organization_timezone_valida()
returns trigger language plpgsql set search_path = core, pg_temp as $$
begin
  if not exists (select 1 from pg_timezone_names z where z.name = new.timezone) then
    raise exception 'organization.timezone: zona horaria IANA desconocida' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger organization_timezone_valida_trg
  before insert or update of timezone on core.organization
  for each row execute function core.organization_timezone_valida();

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Libro mayor del medidor mensual
-- ═══════════════════════════════════════════════════════════════════════════
create table core.message_usage_event (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- Primer dia del mes en la zona horaria de la organizacion (corte de mes de negocio, no UTC).
  periodo date not null,
  ref_tipo text not null check (ref_tipo ~ '^[a-z][a-z0-9_]{0,40}$'),
  ref_id text not null check (char_length(ref_id) between 1 and 200),
  occurred_at timestamptz not null,
  proactivo boolean not null default false,
  resultado text not null check (resultado in ('contado', 'omitido_proactivo')),
  -- true si ESTE mensaje ya supero el tope del plan al registrarse (base del cobro por excedente).
  excedente boolean not null default false,
  motivo text check (motivo is null or char_length(motivo) <= 80),
  created_at timestamptz not null default now(),
  -- Idempotencia: el mismo mensaje de origen no se cuenta dos veces.
  unique (ref_tipo, ref_id)
);
create index message_usage_event_org_periodo_idx on core.message_usage_event (organization_id, periodo, resultado);
alter table core.message_usage_event enable row level security;
revoke all on core.message_usage_event from public, anon, authenticated, service_role;

-- Foto agregada (interna, sin GRANT): una sola consulta, sin N+1.
create or replace function core.message_usage_snapshot(p_org uuid, p_periodo date)
returns table (usado bigint, excedente bigint, omitidos bigint, limite bigint, accion text, plan_id text)
language sql stable security definer set search_path = core, pg_temp as $$
  select
    count(*) filter (where e.resultado = 'contado'),
    count(*) filter (where e.resultado = 'contado' and e.excedente),
    count(*) filter (where e.resultado = 'omitido_proactivo'),
    pl.limite,
    pl.accion_al_exceder,
    op.plan_id
  from (select 1) base
  left join core.message_usage_event e on e.organization_id = p_org and e.periodo = p_periodo
  left join core.organization_plan op on op.organization_id = p_org
  left join core.plan_limit pl on pl.plan_id = op.plan_id and pl.metrica = 'mensajes_mes'
  group by pl.limite, pl.accion_al_exceder, op.plan_id;
$$;
revoke all on function core.message_usage_snapshot(uuid, date) from public, anon, authenticated;

create or replace function core.message_usage_periodo(p_org uuid, p_at timestamptz)
returns date language sql stable security definer set search_path = core, pg_temp as $$
  select (date_trunc('month', p_at at time zone o.timezone))::date from core.organization o where o.id = p_org;
$$;
revoke all on function core.message_usage_periodo(uuid, timestamptz) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Decision y registro (solo-sistema)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.message_quota_check(
  p_organization_id uuid,
  p_proactivo boolean,
  p_critico boolean default false,
  p_at timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_periodo date;
  v_snap record;
  v_permitir boolean := true;
  v_motivo text := null;
begin
  if auth.uid() is not null then
    raise exception 'message_quota_check: solo sesion de sistema' using errcode = '42501';
  end if;
  v_periodo := core.message_usage_periodo(p_organization_id, coalesce(p_at, now()));
  if v_periodo is null then
    raise exception 'message_quota_check: la organizacion no existe' using errcode = 'P0002';
  end if;
  select * into v_snap from core.message_usage_snapshot(p_organization_id, v_periodo);
  -- Regla: SIEMPRE se permite lo transaccional (respuesta a un cliente final) y lo critico. Solo un plan con
  -- accion 'pausar' que ya consumio todo su tope omite avisos proactivos no criticos.
  if coalesce(p_proactivo, false) and not coalesce(p_critico, false)
     and v_snap.limite is not null and v_snap.accion = 'pausar' and v_snap.usado >= v_snap.limite then
    v_permitir := false;
    v_motivo := 'tope_mensajes_plan';
  end if;
  return jsonb_build_object(
    'permitir', v_permitir, 'motivo', v_motivo, 'periodo', v_periodo,
    'usado', v_snap.usado, 'limite', v_snap.limite, 'accion', v_snap.accion
  );
end;
$$;
revoke all on function core.message_quota_check(uuid, boolean, boolean, timestamptz) from public, anon;
grant execute on function core.message_quota_check(uuid, boolean, boolean, timestamptz) to authenticated;

create or replace function core.message_usage_record(
  p_organization_id uuid,
  p_ref_tipo text,
  p_ref_id text,
  p_occurred_at timestamptz default now(),
  p_proactivo boolean default false,
  p_omitido boolean default false,
  p_motivo text default null
) returns jsonb
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_at timestamptz := coalesce(p_occurred_at, now());
  v_periodo date;
  v_snap record;
  v_excede boolean;
  v_insertados integer;
  v_antes bigint;
  v_despues bigint;
  v_cruce text := 'ninguno';
begin
  if auth.uid() is not null then
    raise exception 'message_usage_record: solo sesion de sistema' using errcode = '42501';
  end if;
  if p_ref_tipo is null or p_ref_tipo !~ '^[a-z][a-z0-9_]{0,40}$' or p_ref_id is null or char_length(p_ref_id) not between 1 and 200 then
    raise exception 'message_usage_record: referencia invalida' using errcode = '22023';
  end if;
  v_periodo := core.message_usage_periodo(p_organization_id, v_at);
  if v_periodo is null then
    raise exception 'message_usage_record: la organizacion no existe' using errcode = 'P0002';
  end if;
  -- Serializa los registros de una misma organizacion y mes: el conteo y el cruce de umbral son exactos.
  perform pg_advisory_xact_lock(hashtextextended('message_usage:' || p_organization_id::text || ':' || v_periodo::text, 0));
  select * into v_snap from core.message_usage_snapshot(p_organization_id, v_periodo);
  v_antes := v_snap.usado;
  v_excede := not coalesce(p_omitido, false) and v_snap.limite is not null and v_antes + 1 > v_snap.limite;

  insert into core.message_usage_event (organization_id, periodo, ref_tipo, ref_id, occurred_at, proactivo, resultado, excedente, motivo)
  values (p_organization_id, v_periodo, p_ref_tipo, p_ref_id, v_at, coalesce(p_proactivo, false),
          case when coalesce(p_omitido, false) then 'omitido_proactivo' else 'contado' end, v_excede, p_motivo)
  on conflict (ref_tipo, ref_id) do nothing;
  get diagnostics v_insertados = row_count;

  if v_insertados = 1 and not coalesce(p_omitido, false) and v_snap.limite is not null and v_snap.limite > 0 then
    v_despues := v_antes + 1;
    if v_despues > v_snap.limite and v_antes <= v_snap.limite then
      v_cruce := 'excedido';
    elsif v_despues * 100 > v_snap.limite * 80 and v_antes * 100 <= v_snap.limite * 80 then
      v_cruce := 'aviso80';
    end if;
  elsif v_insertados = 1 and not coalesce(p_omitido, false) and v_snap.limite = 0 and v_antes = 0 then
    v_cruce := 'excedido';
  end if;

  select * into v_snap from core.message_usage_snapshot(p_organization_id, v_periodo);
  return jsonb_build_object(
    'registrado', v_insertados = 1, 'periodo', v_periodo, 'cruce', v_cruce,
    'usado', v_snap.usado, 'limite', v_snap.limite, 'accion', v_snap.accion,
    'excedente', v_snap.excedente, 'omitidos', v_snap.omitidos
  );
end;
$$;
revoke all on function core.message_usage_record(uuid, text, text, timestamptz, boolean, boolean, text) from public, anon;
grant execute on function core.message_usage_record(uuid, text, text, timestamptz, boolean, boolean, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Avisos de fin de prueba (7 / 3 / 1 dias)
-- ═══════════════════════════════════════════════════════════════════════════
create table core.trial_notice_log (
  organization_id uuid not null references core.organization(id) on delete cascade,
  dias_antes smallint not null check (dias_antes in (7, 3, 1)),
  trial_ends_at timestamptz not null,
  claimed_at timestamptz not null default now(),
  intentos smallint not null default 1,
  correo_estado text not null default 'pendiente'
    check (correo_estado in ('pendiente', 'enviado', 'sin_destinatarios', 'no_configurado', 'error')),
  primary key (organization_id, dias_antes, trial_ends_at)
);
alter table core.trial_notice_log enable row level security;
revoke all on core.trial_notice_log from public, anon, authenticated, service_role;

-- Reclama los avisos que corresponden HOY (dias calendario en la zona de la organizacion) y los reintentos de
-- correo pendientes. Un aviso exitoso nunca se reclama dos veces (clave primaria).
create or replace function core.trial_notice_claim(p_now timestamptz default now())
returns table (organization_id uuid, organization_name text, vertical text, slug text, dias_antes integer, trial_ends_at timestamptz, es_reintento boolean)
language plpgsql security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'trial_notice_claim: solo sesion de sistema' using errcode = '42501';
  end if;
  return query
    with nuevos as (
      insert into core.trial_notice_log as l (organization_id, dias_antes, trial_ends_at, claimed_at)
      select o.id, d.dias::smallint, o.trial_ends_at, p_now
      from core.organization o
      cross join (values (7), (3), (1)) d(dias)
      where o.status = 'trial'
        and o.trial_ends_at is not null
        and o.trial_ends_at > p_now
        and ((o.trial_ends_at at time zone o.timezone)::date - (p_now at time zone o.timezone)::date) = d.dias
      on conflict do nothing
      returning l.organization_id, l.dias_antes, l.trial_ends_at
    ), reintentos as (
      update core.trial_notice_log l
      set intentos = l.intentos + 1, claimed_at = p_now
      from core.organization o
      where o.id = l.organization_id
        and o.status = 'trial'
        and l.trial_ends_at = o.trial_ends_at
        and l.trial_ends_at > p_now
        and l.correo_estado in ('pendiente', 'error', 'no_configurado')
        and l.intentos < 3
        and l.claimed_at < p_now - interval '30 minutes'
        and not exists (select 1 from nuevos n where n.organization_id = l.organization_id and n.dias_antes = l.dias_antes)
      returning l.organization_id, l.dias_antes, l.trial_ends_at
    ), todos as (
      select n.organization_id, n.dias_antes, n.trial_ends_at, false as es_reintento from nuevos n
      union all
      select r.organization_id, r.dias_antes, r.trial_ends_at, true from reintentos r
    )
    select t.organization_id, o.name, o.vertical, o.slug, t.dias_antes::integer, t.trial_ends_at, t.es_reintento
    from todos t join core.organization o on o.id = t.organization_id;
end;
$$;
revoke all on function core.trial_notice_claim(timestamptz) from public, anon;
grant execute on function core.trial_notice_claim(timestamptz) to authenticated;

create or replace function core.trial_notice_recipients(p_organization_id uuid)
returns table (email text)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'trial_notice_recipients: solo sesion de sistema' using errcode = '42501';
  end if;
  return query
    select distinct s.email
    from core.membership m
    join core.staff_user s on s.id = m.user_id
    where m.organization_id = p_organization_id
      and m.platform_role in ('owner', 'admin')
      and s.email is not null;
end;
$$;
revoke all on function core.trial_notice_recipients(uuid) from public, anon;
grant execute on function core.trial_notice_recipients(uuid) to authenticated;

create or replace function core.trial_notice_mark(p_organization_id uuid, p_dias_antes integer, p_trial_ends_at timestamptz, p_correo_estado text)
returns boolean
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_filas integer;
begin
  if auth.uid() is not null then
    raise exception 'trial_notice_mark: solo sesion de sistema' using errcode = '42501';
  end if;
  if p_correo_estado not in ('enviado', 'sin_destinatarios', 'no_configurado', 'error') then
    raise exception 'trial_notice_mark: estado de correo invalido' using errcode = '22023';
  end if;
  update core.trial_notice_log
  set correo_estado = p_correo_estado
  where organization_id = p_organization_id and dias_antes = p_dias_antes and trial_ends_at = p_trial_ends_at;
  get diagnostics v_filas = row_count;
  return v_filas = 1;
end;
$$;
revoke all on function core.trial_notice_mark(uuid, integer, timestamptz, text) from public, anon;
grant execute on function core.trial_notice_mark(uuid, integer, timestamptz, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- E) Lecturas caller-bound
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.message_usage_for_org(p_caller_id uuid, p_organization_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = core, pg_temp as $$
declare
  v_org record;
  v_periodo date;
  v_snap record;
  v_plan_nombre text;
  v_dias integer := null;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'message_usage_for_org: caller binding invalido (auth.uid() no coincide con p_caller_id)' using errcode = '42501';
  end if;
  if not (
    exists (select 1 from core.membership m where m.user_id = p_caller_id and m.organization_id = p_organization_id)
    or core.is_platform_superadmin(p_caller_id)
  ) then
    return null;
  end if;
  select o.id, o.status, o.timezone, o.trial_ends_at into v_org from core.organization o where o.id = p_organization_id;
  if v_org.id is null then
    return null;
  end if;
  v_periodo := (date_trunc('month', now() at time zone v_org.timezone))::date;
  select * into v_snap from core.message_usage_snapshot(p_organization_id, v_periodo);
  select pl.nombre into v_plan_nombre from core.plan pl where pl.id = v_snap.plan_id;
  if v_org.status = 'trial' and v_org.trial_ends_at is not null then
    v_dias := (v_org.trial_ends_at at time zone v_org.timezone)::date - (now() at time zone v_org.timezone)::date;
  end if;
  return jsonb_build_object(
    'organizationId', p_organization_id,
    'periodo', v_periodo,
    'zonaHoraria', v_org.timezone,
    'mensajes', jsonb_build_object(
      'usado', v_snap.usado, 'limite', v_snap.limite, 'accion', v_snap.accion,
      'excedente', v_snap.excedente, 'proactivosOmitidos', v_snap.omitidos
    ),
    'plan', case when v_snap.plan_id is null then null else jsonb_build_object('id', v_snap.plan_id, 'nombre', v_plan_nombre) end,
    'prueba', jsonb_build_object(
      'activa', v_org.status = 'trial' and v_org.trial_ends_at is not null,
      'terminaEn', case when v_org.status = 'trial' then v_org.trial_ends_at else null end,
      'diasRestantes', v_dias
    )
  );
end;
$$;
revoke all on function core.message_usage_for_org(uuid, uuid) from public, anon;
grant execute on function core.message_usage_for_org(uuid, uuid) to authenticated;

create or replace function core.superadmin_list_message_usage(p_caller_id uuid, p_limit integer default 200)
returns table (
  organization_id uuid, organization_name text, slug text, vertical text, periodo date,
  plan_id text, limite bigint, accion text, usado bigint, excedente bigint, proactivos_omitidos bigint
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_list_message_usage');
  return query
    select o.id, o.name, o.slug, o.vertical, per.periodo,
           op.plan_id, pl.limite, pl.accion_al_exceder,
           coalesce(agg.usado, 0)::bigint, coalesce(agg.excedente, 0)::bigint, coalesce(agg.omitidos, 0)::bigint
    from core.organization o
    cross join lateral (select (date_trunc('month', now() at time zone o.timezone))::date as periodo) per
    left join core.organization_plan op on op.organization_id = o.id
    left join core.plan_limit pl on pl.plan_id = op.plan_id and pl.metrica = 'mensajes_mes'
    left join lateral (
      select count(*) filter (where e.resultado = 'contado') as usado,
             count(*) filter (where e.resultado = 'contado' and e.excedente) as excedente,
             count(*) filter (where e.resultado = 'omitido_proactivo') as omitidos
      from core.message_usage_event e
      where e.organization_id = o.id and e.periodo = per.periodo
    ) agg on true
    order by (case when pl.limite is not null and pl.limite > 0 then coalesce(agg.usado, 0)::numeric / pl.limite else 0 end) desc, o.name
    limit greatest(1, least(coalesce(p_limit, 200), 500));
end;
$$;
revoke all on function core.superadmin_list_message_usage(uuid, integer) from public, anon;
grant execute on function core.superadmin_list_message_usage(uuid, integer) to authenticated;
