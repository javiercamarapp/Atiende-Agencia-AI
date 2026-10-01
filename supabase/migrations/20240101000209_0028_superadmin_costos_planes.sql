-- Superadmin "CFO" -- SA-02 (costo por evento por organizacion, margen y alertas de
-- tope) y SA-03 (catalogo de planes/limites con asignacion desde el superadmin).
--
--   A) core.fx_rate            -- tipo de cambio MXN/USD con fecha y fuente (nunca una
--                                 constante escondida en el codigo).
--   B) core.usage_cost_event   -- una fila por evento facturable que NO es LLM (voz,
--                                 WhatsApp, telefonia, sms, email, storage). El LLM sigue
--                                 viviendo en core.llm_usage_daily (ya tiene tope y reserva);
--                                 el reporte los UNE sin duplicar (un evento LLM nunca se
--                                 escribe aqui: la columna `categoria` no admite 'llm').
--   C) core.plan / plan_limit / organization_plan -- catalogo de planes por vertical, limites
--                                 por plan y asignacion plan <-> organizacion.
--   D) core.plan_assignment_request -- asignar un plan se hace en DOS pasos (solicitar ->
--                                 confirmar), motivo obligatorio, solo el solicitante confirma;
--                                 mismo principio que core.org_admin_action (0025).
--   E) core.plan_audit_log     -- bitacora append-only de todo lo anterior.
--   F) Funciones de lectura/escritura del back office y el reporte de costo/margen.
--
-- Requiere: 0001 (core.organization/property/staff_user), 0009 (organization_billing),
-- 0010 (llm_usage_daily, llm_org_budget, default_llm_org_monthly_cap_micro_usd),
-- core.is_platform_superadmin (0012) y core.superadmin_require_caller (0025).
--
-- No cobra nada, no toca Stripe ni core.organization_billing: el plan asignado es el
-- CONTRATO interno (de donde sale el ingreso esperado para el margen); la cobranza real
-- sigue siendo la suscripcion de Stripe.
--
-- Reglas de seguridad (cada GRANT/policy/funcion trae su razon):
--   * Ninguna tabla nueva recibe GRANT para anon/authenticated/public y todas llevan RLS
--     habilitada SIN policies: todo acceso pasa por las funciones security definer de abajo
--     (corren como el DUEÑO, no sujeto a RLS). Por eso no hay GRANT a nivel columna: nadie
--     escribe columnas directo. Nada se otorga a anon.
--   * Funciones de superadmin: security definer + set search_path fijo + `revoke all ... from
--     public` + `grant execute ... to authenticated`. Escrituras: core.superadmin_require_caller
--     (auth.uid() = p_caller_id Y core.is_platform_superadmin) DENTRO de la funcion. Lecturas:
--     contrato "cero filas" para quien no es superadmin (nunca un error que confirme si hay
--     datos), igual que el resto de las *_for_superadmin.
--   * Funcion de solo-sistema (record_usage_cost_event): exige `auth.uid() is null`. Razon:
--     recibe organization_id como parametro plano y registra costos; si aceptara a un
--     `authenticated`, cualquier tenant podria inflar el costo (y por tanto reducir el margen
--     y disparar alertas) de OTRA organizacion por RPC directo. El vertical NO se acepta del
--     llamador: se deriva de core.organization.
--   * Bitacora core.plan_audit_log: append-only (trigger que bloquea UPDATE/DELETE aun para el
--     dueño), sin GRANT directo.
--   * Aplicar un plan solo toca core.llm_org_budget cuando el plan trae un limite
--     'llm_costo_micro_usd_mes' con accion 'pausar'; es el UNICO limite que hoy se hace cumplir
--     de verdad (lo aplica core.reserve_llm_monthly_budget, que ya existe). Los demas limites
--     se EVALUAN y se muestran (aviso/excedido) pero no cortan nada automaticamente.

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Tipo de cambio
-- ═══════════════════════════════════════════════════════════════════════════
create table core.fx_rate (
  fecha date primary key,
  mxn_por_usd numeric(12, 4) not null check (mxn_por_usd > 0 and mxn_por_usd < 1000),
  fuente text not null check (char_length(fuente) between 3 and 200),
  updated_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table core.fx_rate enable row level security;
revoke all on core.fx_rate from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Eventos de costo (todo lo que no es LLM)
-- ═══════════════════════════════════════════════════════════════════════════
create table core.usage_cost_event (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid references core.property(id) on delete set null,
  vertical text not null check (vertical in ('hoteles','restaurantes','rentas','licitaciones','citas','despachos')),
  occurred_at timestamptz not null default now(),
  categoria text not null check (categoria in ('voz','whatsapp','telefonia','sms','email','storage')),
  proveedor text not null check (char_length(proveedor) between 1 and 80),
  unidad text not null check (unidad in ('segundo','minuto','mensaje','conversacion','unidad')),
  cantidad numeric(14, 3) not null check (cantidad >= 0),
  -- Entero SIEMPRE (micro-USD), igual que core.llm_usage_daily.
  costo_micro_usd bigint not null check (costo_micro_usd >= 0),
  -- true hasta conciliar contra la factura del proveedor.
  costo_estimado boolean not null default true,
  ref_tipo text not null check (ref_tipo ~ '^[a-z][a-z0-9_]{0,40}$'),
  ref_id text not null check (char_length(ref_id) between 1 and 200),
  created_at timestamptz not null default now(),
  -- Idempotencia: el mismo evento de origen (llamada, mensaje) no se cuenta dos veces.
  unique (ref_tipo, ref_id)
);
create index usage_cost_event_org_occurred_idx on core.usage_cost_event (organization_id, occurred_at desc);
alter table core.usage_cost_event enable row level security;
revoke all on core.usage_cost_event from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Catalogo de planes, limites y asignacion
-- ═══════════════════════════════════════════════════════════════════════════
create table core.plan (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$'),
  nombre text not null check (char_length(nombre) between 2 and 80),
  vertical text not null check (vertical in ('hoteles','restaurantes','rentas','licitaciones','citas','despachos')),
  -- Centavos MXN (entero, nunca float). NULL = "precio por configurar": el reporte lo muestra
  -- como no disponible, jamas como 0 ni como un numero inventado.
  precio_base_mxn_centavos bigint check (precio_base_mxn_centavos is null or precio_base_mxn_centavos >= 0),
  precio_asiento_mxn_centavos bigint check (precio_asiento_mxn_centavos is null or precio_asiento_mxn_centavos >= 0),
  asientos_incluidos integer not null default 0 check (asientos_incluidos >= 0),
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references core.staff_user(id) on delete set null
);
alter table core.plan enable row level security;
revoke all on core.plan from public, anon, authenticated;

create table core.plan_limit (
  plan_id text not null references core.plan(id) on delete cascade,
  metrica text not null check (metrica in ('llm_costo_micro_usd_mes','minutos_voz_mes','mensajes_mes','sucursales','asientos')),
  limite bigint not null check (limite >= 0),
  accion_al_exceder text not null check (accion_al_exceder in ('avisar','cobrar','pausar')),
  updated_at timestamptz not null default now(),
  primary key (plan_id, metrica)
);
alter table core.plan_limit enable row level security;
revoke all on core.plan_limit from public, anon, authenticated;

create table core.organization_plan (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  plan_id text not null references core.plan(id),
  assigned_at timestamptz not null default now(),
  assigned_by uuid references core.staff_user(id) on delete set null
);
alter table core.organization_plan enable row level security;
revoke all on core.organization_plan from public, anon, authenticated;

create table core.plan_assignment_request (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  plan_id text not null references core.plan(id),
  motivo text not null check (char_length(btrim(motivo)) >= 20),
  estado text not null default 'pending' check (estado in ('pending','executed','cancelled','expired')),
  creado_por uuid not null references core.staff_user(id),
  creado_en timestamptz not null default now(),
  vence_en timestamptz not null default (now() + interval '10 minutes'),
  confirmado_por uuid references core.staff_user(id),
  confirmado_en timestamptz,
  resultado jsonb
);
-- Una sola solicitud pendiente por organizacion (defensa en la BASE, no solo en la funcion).
create unique index plan_assignment_request_one_pending_idx on core.plan_assignment_request (organization_id) where estado = 'pending';
alter table core.plan_assignment_request enable row level security;
revoke all on core.plan_assignment_request from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- E) Bitacora append-only
-- ═══════════════════════════════════════════════════════════════════════════
create table core.plan_audit_log (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  event text not null check (event in (
    'fx_set', 'plan_upserted', 'plan_limit_set', 'plan_limit_deleted',
    'assignment_requested', 'assignment_executed', 'assignment_cancelled', 'assignment_expired'
  )),
  actor_user_id uuid references core.staff_user(id) on delete set null,
  organization_id uuid references core.organization(id) on delete set null,
  plan_id text,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index plan_audit_log_seq_idx on core.plan_audit_log (seq desc);

create or replace function core.plan_audit_log_block_mutation()
returns trigger language plpgsql set search_path = core, pg_temp as $$
begin
  raise exception 'plan_audit_log_append_only: % no esta permitido sobre %', tg_op, tg_table_name using errcode = '0A000';
end;
$$;
create trigger plan_audit_log_block_update_trg before update on core.plan_audit_log
  for each row execute function core.plan_audit_log_block_mutation();
create trigger plan_audit_log_block_delete_trg before delete on core.plan_audit_log
  for each row execute function core.plan_audit_log_block_mutation();
alter table core.plan_audit_log enable row level security;
revoke all on core.plan_audit_log from public, anon, authenticated;

-- Helper interno (NO expuesto): solo lo invocan, como DUEÑO, las funciones de abajo.
create or replace function core.plan_audit_write(p_event text, p_actor uuid, p_org uuid, p_plan text, p_detail jsonb)
returns void language sql security definer set search_path = core, pg_temp as $$
  insert into core.plan_audit_log (event, actor_user_id, organization_id, plan_id, detail)
  values (p_event, p_actor, p_org, p_plan, coalesce(p_detail, '{}'::jsonb));
$$;
revoke all on function core.plan_audit_write(text, uuid, uuid, text, jsonb) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- Seeds del catalogo: SOLO precios que ya existen en el codigo (packages/billing/src/
-- per-seat.ts: SEAT_HOTELES 89 MXN/habitacion con 5 incluidas, SEAT_RESTAURANTES 799 MXN
-- con 1 incluido, SEAT_CITAS_RESERVACIONES 599 MXN). Las otras tres verticales quedan con
-- precio NULL ("por configurar"): el superadmin lo captura desde la pantalla de Planes.
-- ═══════════════════════════════════════════════════════════════════════════
insert into core.plan (id, nombre, vertical, precio_base_mxn_centavos, precio_asiento_mxn_centavos, asientos_incluidos) values
  ('hoteles-estandar', 'Hoteles - por habitacion', 'hoteles', 0, 8900, 5),
  ('restaurantes-estandar', 'Restaurantes - por agente de voz', 'restaurantes', 0, 79900, 1),
  ('citas-estandar', 'Citas - por doctor/proveedor', 'citas', 0, 59900, 0),
  ('rentas-estandar', 'Rentas vacacionales - por configurar', 'rentas', null, null, 0),
  ('licitaciones-estandar', 'Licitaciones - por configurar', 'licitaciones', null, null, 0),
  ('despachos-estandar', 'Despachos - por configurar', 'despachos', null, null, 0)
on conflict (id) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- Funcion de SOLO-SISTEMA: registrar un evento de costo (idempotente por ref).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.record_usage_cost_event(
  p_organization_id uuid,
  p_property_id uuid,
  p_occurred_at timestamptz,
  p_categoria text,
  p_proveedor text,
  p_unidad text,
  p_cantidad numeric,
  p_costo_micro_usd bigint,
  p_costo_estimado boolean,
  p_ref_tipo text,
  p_ref_id text
) returns boolean
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_vertical text;
  v_inserted integer;
begin
  if auth.uid() is not null then
    raise exception 'record_usage_cost_event: solo sesion de sistema' using errcode = '42501';
  end if;
  select o.vertical into v_vertical from core.organization o where o.id = p_organization_id;
  if v_vertical is null then
    raise exception 'record_usage_cost_event: la organizacion no existe' using errcode = 'P0002';
  end if;
  if p_property_id is not null
     and not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
    raise exception 'record_usage_cost_event: la sucursal no pertenece a la organizacion' using errcode = '22023';
  end if;
  insert into core.usage_cost_event (
    organization_id, property_id, vertical, occurred_at, categoria, proveedor, unidad, cantidad,
    costo_micro_usd, costo_estimado, ref_tipo, ref_id
  ) values (
    p_organization_id, p_property_id, v_vertical, coalesce(p_occurred_at, now()), p_categoria, p_proveedor, p_unidad,
    p_cantidad, p_costo_micro_usd, coalesce(p_costo_estimado, true), p_ref_tipo, p_ref_id
  ) on conflict (ref_tipo, ref_id) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;
revoke all on function core.record_usage_cost_event(uuid, uuid, timestamptz, text, text, text, numeric, bigint, boolean, text, text) from public, anon;
grant execute on function core.record_usage_cost_event(uuid, uuid, timestamptz, text, text, text, numeric, bigint, boolean, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- Tipo de cambio (superadmin)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.superadmin_set_fx_rate(p_caller_id uuid, p_fecha date, p_mxn_por_usd numeric, p_fuente text)
returns void language plpgsql security definer set search_path = core, pg_temp as $$
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_set_fx_rate');
  if p_fecha is null or p_fecha > current_date + 1 then
    raise exception 'superadmin_set_fx_rate: fecha invalida (no puede ser futura)' using errcode = '22023';
  end if;
  if p_mxn_por_usd is null or p_mxn_por_usd <= 0 or p_mxn_por_usd >= 1000 then
    raise exception 'superadmin_set_fx_rate: mxn_por_usd debe estar entre 0 (exclusivo) y 1000' using errcode = '22023';
  end if;
  if p_fuente is null or char_length(btrim(p_fuente)) < 3 or char_length(p_fuente) > 200 then
    raise exception 'superadmin_set_fx_rate: fuente obligatoria (3-200 caracteres)' using errcode = '22023';
  end if;
  insert into core.fx_rate (fecha, mxn_por_usd, fuente, updated_by)
  values (p_fecha, round(p_mxn_por_usd, 4), btrim(p_fuente), p_caller_id)
  on conflict (fecha) do update set mxn_por_usd = excluded.mxn_por_usd, fuente = excluded.fuente, updated_by = excluded.updated_by;
  perform core.plan_audit_write('fx_set', p_caller_id, null, null, jsonb_build_object('fecha', p_fecha, 'mxn_por_usd', round(p_mxn_por_usd, 4), 'fuente', btrim(p_fuente)));
end;
$$;
revoke all on function core.superadmin_set_fx_rate(uuid, date, numeric, text) from public;
grant execute on function core.superadmin_set_fx_rate(uuid, date, numeric, text) to authenticated;

create or replace function core.list_fx_rates_for_superadmin(p_caller_id uuid, p_limit int default 30)
returns table (fecha date, mxn_por_usd numeric, fuente text)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    select f.fecha, f.mxn_por_usd, f.fuente
    from core.fx_rate f
    order by f.fecha desc
    limit greatest(1, least(coalesce(p_limit, 30), 365));
end;
$$;
revoke all on function core.list_fx_rates_for_superadmin(uuid, int) from public;
grant execute on function core.list_fx_rates_for_superadmin(uuid, int) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- Catalogo (superadmin)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.superadmin_upsert_plan(
  p_caller_id uuid, p_id text, p_nombre text, p_vertical text,
  p_precio_base_mxn_centavos bigint, p_precio_asiento_mxn_centavos bigint, p_asientos_incluidos integer, p_activo boolean
) returns void language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_vertical_actual text;
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_upsert_plan');
  if p_id is null or p_id !~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$' then
    raise exception 'superadmin_upsert_plan: id invalido (minusculas, digitos y guiones, 3-60)' using errcode = '22023';
  end if;
  if p_nombre is null or char_length(btrim(p_nombre)) < 2 or char_length(p_nombre) > 80 then
    raise exception 'superadmin_upsert_plan: nombre invalido (2-80 caracteres)' using errcode = '22023';
  end if;
  if p_vertical is null or p_vertical not in ('hoteles','restaurantes','rentas','licitaciones','citas','despachos') then
    raise exception 'superadmin_upsert_plan: vertical invalida' using errcode = '22023';
  end if;
  if (p_precio_base_mxn_centavos is not null and p_precio_base_mxn_centavos < 0)
     or (p_precio_asiento_mxn_centavos is not null and p_precio_asiento_mxn_centavos < 0)
     or coalesce(p_asientos_incluidos, 0) < 0 then
    raise exception 'superadmin_upsert_plan: precios y asientos incluidos no pueden ser negativos' using errcode = '22023';
  end if;

  select pl.vertical into v_vertical_actual from core.plan pl where pl.id = p_id for update;
  if v_vertical_actual is not null and v_vertical_actual <> p_vertical
     and exists (select 1 from core.organization_plan op where op.plan_id = p_id) then
    raise exception 'superadmin_upsert_plan: no se puede cambiar la vertical de un plan con organizaciones asignadas' using errcode = '55006';
  end if;

  insert into core.plan (id, nombre, vertical, precio_base_mxn_centavos, precio_asiento_mxn_centavos, asientos_incluidos, activo, updated_by)
  values (p_id, btrim(p_nombre), p_vertical, p_precio_base_mxn_centavos, p_precio_asiento_mxn_centavos, coalesce(p_asientos_incluidos, 0), coalesce(p_activo, true), p_caller_id)
  on conflict (id) do update set
    nombre = excluded.nombre, vertical = excluded.vertical,
    precio_base_mxn_centavos = excluded.precio_base_mxn_centavos,
    precio_asiento_mxn_centavos = excluded.precio_asiento_mxn_centavos,
    asientos_incluidos = excluded.asientos_incluidos, activo = excluded.activo,
    updated_at = now(), updated_by = excluded.updated_by;

  perform core.plan_audit_write('plan_upserted', p_caller_id, null, p_id, jsonb_build_object(
    'nombre', btrim(p_nombre), 'vertical', p_vertical, 'precio_base_mxn_centavos', p_precio_base_mxn_centavos,
    'precio_asiento_mxn_centavos', p_precio_asiento_mxn_centavos, 'asientos_incluidos', coalesce(p_asientos_incluidos, 0), 'activo', coalesce(p_activo, true)));
end;
$$;
revoke all on function core.superadmin_upsert_plan(uuid, text, text, text, bigint, bigint, integer, boolean) from public;
grant execute on function core.superadmin_upsert_plan(uuid, text, text, text, bigint, bigint, integer, boolean) to authenticated;

create or replace function core.superadmin_set_plan_limit(p_caller_id uuid, p_plan_id text, p_metrica text, p_limite bigint, p_accion text)
returns void language plpgsql security definer set search_path = core, pg_temp as $$
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_set_plan_limit');
  if not exists (select 1 from core.plan pl where pl.id = p_plan_id) then
    raise exception 'superadmin_set_plan_limit: el plan no existe' using errcode = 'P0002';
  end if;
  if p_metrica is null or p_metrica not in ('llm_costo_micro_usd_mes','minutos_voz_mes','mensajes_mes','sucursales','asientos') then
    raise exception 'superadmin_set_plan_limit: metrica invalida' using errcode = '22023';
  end if;
  if p_limite is null or p_limite < 0 then
    raise exception 'superadmin_set_plan_limit: limite debe ser >= 0' using errcode = '22023';
  end if;
  if p_accion is null or p_accion not in ('avisar','cobrar','pausar') then
    raise exception 'superadmin_set_plan_limit: accion invalida' using errcode = '22023';
  end if;
  -- El tope LLM alimenta core.llm_org_budget (monthly_cap_micro_usd > 0): un limite 0 con
  -- 'pausar' dejaria una organizacion sin poder gastar nada y violaria ese CHECK al aplicar.
  if p_metrica = 'llm_costo_micro_usd_mes' and p_accion = 'pausar' and p_limite = 0 then
    raise exception 'superadmin_set_plan_limit: un limite LLM con accion pausar debe ser > 0' using errcode = '22023';
  end if;
  insert into core.plan_limit (plan_id, metrica, limite, accion_al_exceder)
  values (p_plan_id, p_metrica, p_limite, p_accion)
  on conflict (plan_id, metrica) do update set limite = excluded.limite, accion_al_exceder = excluded.accion_al_exceder, updated_at = now();
  perform core.plan_audit_write('plan_limit_set', p_caller_id, null, p_plan_id, jsonb_build_object('metrica', p_metrica, 'limite', p_limite, 'accion', p_accion));
end;
$$;
revoke all on function core.superadmin_set_plan_limit(uuid, text, text, bigint, text) from public;
grant execute on function core.superadmin_set_plan_limit(uuid, text, text, bigint, text) to authenticated;

create or replace function core.superadmin_delete_plan_limit(p_caller_id uuid, p_plan_id text, p_metrica text)
returns void language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_deleted integer;
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_delete_plan_limit');
  delete from core.plan_limit pl where pl.plan_id = p_plan_id and pl.metrica = p_metrica;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'superadmin_delete_plan_limit: el limite no existe' using errcode = 'P0002';
  end if;
  perform core.plan_audit_write('plan_limit_deleted', p_caller_id, null, p_plan_id, jsonb_build_object('metrica', p_metrica));
end;
$$;
revoke all on function core.superadmin_delete_plan_limit(uuid, text, text) from public;
grant execute on function core.superadmin_delete_plan_limit(uuid, text, text) to authenticated;

create or replace function core.list_plans_for_superadmin(p_caller_id uuid)
returns table (
  id text, nombre text, vertical text,
  precio_base_mxn_centavos bigint, precio_asiento_mxn_centavos bigint, asientos_incluidos integer,
  activo boolean, limites jsonb, organizaciones integer, updated_at timestamptz
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    select pl.id, pl.nombre, pl.vertical, pl.precio_base_mxn_centavos, pl.precio_asiento_mxn_centavos, pl.asientos_incluidos, pl.activo,
      coalesce((select jsonb_agg(jsonb_build_object('metrica', l.metrica, 'limite', l.limite, 'accion', l.accion_al_exceder) order by l.metrica)
                from core.plan_limit l where l.plan_id = pl.id), '[]'::jsonb),
      (select count(*)::integer from core.organization_plan op where op.plan_id = pl.id),
      pl.updated_at
    from core.plan pl
    order by pl.vertical, pl.id;
end;
$$;
revoke all on function core.list_plans_for_superadmin(uuid) from public;
grant execute on function core.list_plans_for_superadmin(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- Asignacion en dos pasos
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.superadmin_request_plan_assignment(p_caller_id uuid, p_organization_id uuid, p_plan_id text, p_motivo text)
returns core.plan_assignment_request
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_org record;
  v_plan record;
  v_row core.plan_assignment_request;
  v_expired record;
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_request_plan_assignment');
  if p_motivo is null or char_length(btrim(p_motivo)) < 20 then
    raise exception 'superadmin_request_plan_assignment: motivo obligatorio (minimo 20 caracteres)' using errcode = '22023';
  end if;
  select o.id, o.vertical, o.status into v_org from core.organization o where o.id = p_organization_id;
  if not found then
    raise exception 'superadmin_request_plan_assignment: la organizacion no existe' using errcode = 'P0002';
  end if;
  select pl.id, pl.vertical, pl.activo into v_plan from core.plan pl where pl.id = p_plan_id;
  if not found then
    raise exception 'superadmin_request_plan_assignment: el plan no existe' using errcode = 'P0002';
  end if;
  if not v_plan.activo then
    raise exception 'superadmin_request_plan_assignment: el plan esta inactivo' using errcode = '55006';
  end if;
  if v_plan.vertical <> v_org.vertical then
    raise exception 'superadmin_request_plan_assignment: el plan es de otra vertical (% vs %)', v_plan.vertical, v_org.vertical using errcode = '22023';
  end if;
  if v_org.status = 'suspended' then
    raise exception 'superadmin_request_plan_assignment: reactiva la organizacion antes de cambiar su plan' using errcode = '55006';
  end if;
  if exists (select 1 from core.organization_plan op where op.organization_id = p_organization_id and op.plan_id = p_plan_id) then
    raise exception 'superadmin_request_plan_assignment: la organizacion ya tiene ese plan' using errcode = '55006';
  end if;

  -- Una pendiente VENCIDA no debe bloquear una nueva: se marca expirada (y queda en bitacora).
  for v_expired in
    update core.plan_assignment_request r set estado = 'expired'
    where r.organization_id = p_organization_id and r.estado = 'pending' and r.vence_en <= now()
    returning r.id, r.plan_id
  loop
    perform core.plan_audit_write('assignment_expired', null, p_organization_id, v_expired.plan_id, jsonb_build_object('request_id', v_expired.id));
  end loop;
  if exists (select 1 from core.plan_assignment_request r where r.organization_id = p_organization_id and r.estado = 'pending') then
    raise exception 'superadmin_request_plan_assignment: ya hay una solicitud pendiente para esta organizacion' using errcode = '55006';
  end if;

  insert into core.plan_assignment_request (organization_id, plan_id, motivo, creado_por)
  values (p_organization_id, p_plan_id, btrim(p_motivo), p_caller_id)
  returning * into v_row;
  perform core.plan_audit_write('assignment_requested', p_caller_id, p_organization_id, p_plan_id, jsonb_build_object('request_id', v_row.id, 'motivo', btrim(p_motivo)));
  return v_row;
end;
$$;
revoke all on function core.superadmin_request_plan_assignment(uuid, uuid, text, text) from public;
grant execute on function core.superadmin_request_plan_assignment(uuid, uuid, text, text) to authenticated;

create or replace function core.superadmin_confirm_plan_assignment(p_caller_id uuid, p_request_id uuid)
returns core.plan_assignment_request
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_req core.plan_assignment_request;
  v_org record;
  v_plan record;
  v_plan_previo text;
  v_llm_cap bigint;
  v_resultado jsonb;
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_confirm_plan_assignment');
  select * into v_req from core.plan_assignment_request r where r.id = p_request_id for update;
  if not found then
    raise exception 'superadmin_confirm_plan_assignment: la solicitud no existe' using errcode = 'P0002';
  end if;
  if v_req.creado_por <> p_caller_id then
    raise exception 'superadmin_confirm_plan_assignment: solo quien solicito la accion puede confirmarla' using errcode = '42501';
  end if;
  if v_req.estado <> 'pending' then
    raise exception 'superadmin_confirm_plan_assignment: la solicitud ya no esta pendiente (estado %)', v_req.estado using errcode = '55006';
  end if;
  if v_req.vence_en <= now() then
    update core.plan_assignment_request r set estado = 'expired' where r.id = v_req.id returning * into v_req;
    perform core.plan_audit_write('assignment_expired', p_caller_id, v_req.organization_id, v_req.plan_id, jsonb_build_object('request_id', v_req.id));
    return v_req;
  end if;

  -- Re-validacion del mundo al confirmar (pudo cambiar en los minutos de espera).
  select o.id, o.vertical, o.status into v_org from core.organization o where o.id = v_req.organization_id for update;
  if not found then
    raise exception 'superadmin_confirm_plan_assignment: la organizacion ya no existe' using errcode = 'P0002';
  end if;
  if v_org.status = 'suspended' then
    raise exception 'superadmin_confirm_plan_assignment: la organizacion esta suspendida' using errcode = '55006';
  end if;
  select pl.id, pl.vertical, pl.activo into v_plan from core.plan pl where pl.id = v_req.plan_id;
  if not found or not v_plan.activo or v_plan.vertical <> v_org.vertical then
    raise exception 'superadmin_confirm_plan_assignment: el plan ya no es asignable a esta organizacion' using errcode = '55006';
  end if;

  select op.plan_id into v_plan_previo from core.organization_plan op where op.organization_id = v_req.organization_id;
  insert into core.organization_plan (organization_id, plan_id, assigned_by)
  values (v_req.organization_id, v_req.plan_id, p_caller_id)
  on conflict (organization_id) do update set plan_id = excluded.plan_id, assigned_at = now(), assigned_by = excluded.assigned_by;

  -- Aplicacion del unico limite que hoy se hace cumplir: el tope LLM mensual (ver cabecera).
  select l.limite into v_llm_cap from core.plan_limit l
  where l.plan_id = v_req.plan_id and l.metrica = 'llm_costo_micro_usd_mes' and l.accion_al_exceder = 'pausar' and l.limite > 0;
  if v_llm_cap is not null then
    insert into core.llm_org_budget (organization_id, monthly_cap_micro_usd, updated_by)
    values (v_req.organization_id, v_llm_cap, p_caller_id)
    on conflict (organization_id) do update set monthly_cap_micro_usd = excluded.monthly_cap_micro_usd, updated_at = now(), updated_by = excluded.updated_by;
  end if;

  v_resultado := jsonb_build_object('plan_previo', v_plan_previo, 'plan', v_req.plan_id, 'llm_tope_aplicado_micro_usd', v_llm_cap);
  update core.plan_assignment_request r
    set estado = 'executed', confirmado_por = p_caller_id, confirmado_en = now(), resultado = v_resultado
    where r.id = v_req.id returning * into v_req;
  perform core.plan_audit_write('assignment_executed', p_caller_id, v_req.organization_id, v_req.plan_id, v_resultado || jsonb_build_object('request_id', v_req.id));
  return v_req;
end;
$$;
revoke all on function core.superadmin_confirm_plan_assignment(uuid, uuid) from public;
grant execute on function core.superadmin_confirm_plan_assignment(uuid, uuid) to authenticated;

create or replace function core.superadmin_cancel_plan_assignment(p_caller_id uuid, p_request_id uuid)
returns core.plan_assignment_request
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_req core.plan_assignment_request;
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_cancel_plan_assignment');
  select * into v_req from core.plan_assignment_request r where r.id = p_request_id for update;
  if not found then
    raise exception 'superadmin_cancel_plan_assignment: la solicitud no existe' using errcode = 'P0002';
  end if;
  if v_req.creado_por <> p_caller_id then
    raise exception 'superadmin_cancel_plan_assignment: solo quien solicito la accion puede cancelarla' using errcode = '42501';
  end if;
  if v_req.estado <> 'pending' then
    raise exception 'superadmin_cancel_plan_assignment: la solicitud ya no esta pendiente (estado %)', v_req.estado using errcode = '55006';
  end if;
  update core.plan_assignment_request r set estado = 'cancelled' where r.id = v_req.id returning * into v_req;
  perform core.plan_audit_write('assignment_cancelled', p_caller_id, v_req.organization_id, v_req.plan_id, jsonb_build_object('request_id', v_req.id));
  return v_req;
end;
$$;
revoke all on function core.superadmin_cancel_plan_assignment(uuid, uuid) from public;
grant execute on function core.superadmin_cancel_plan_assignment(uuid, uuid) to authenticated;

create or replace function core.list_plan_assignments_for_superadmin(p_caller_id uuid, p_limit int default 50)
returns table (
  id uuid, organization_id uuid, organization_name text, plan_id text, motivo text, estado text,
  creado_por uuid, creado_en timestamptz, vence_en timestamptz, confirmado_por uuid, confirmado_en timestamptz, resultado jsonb
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    select r.id, r.organization_id, o.name, r.plan_id, r.motivo,
      -- Una pendiente ya vencida se MUESTRA como expirada aunque nadie la haya tocado aun.
      case when r.estado = 'pending' and r.vence_en <= now() then 'expired' else r.estado end,
      r.creado_por, r.creado_en, r.vence_en, r.confirmado_por, r.confirmado_en, r.resultado
    from core.plan_assignment_request r
    join core.organization o on o.id = r.organization_id
    order by r.creado_en desc
    limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;
revoke all on function core.list_plan_assignments_for_superadmin(uuid, int) from public;
grant execute on function core.list_plan_assignments_for_superadmin(uuid, int) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- Reporte de costo por evento por organizacion (UNE LLM + eventos sin duplicar)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.get_cost_margin_report_for_superadmin(p_caller_id uuid, p_month date default null)
returns table (
  organization_id uuid, organization_name text, organization_slug text, vertical text, org_status text,
  plan_id text, plan_nombre text, precio_base_mxn_centavos bigint, precio_asiento_mxn_centavos bigint, asientos_incluidos integer,
  billing_status text, billing_seats integer, sucursales_activas integer,
  llm_micro_usd bigint, voz_micro_usd bigint, whatsapp_micro_usd bigint, telefonia_micro_usd bigint, otros_micro_usd bigint,
  eventos_total bigint, eventos_estimados bigint, minutos_voz numeric, mensajes numeric,
  llm_cap_micro_usd bigint, llm_alert_pct numeric
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
declare
  v_from date;
  v_to date;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  v_from := date_trunc('month', coalesce(p_month, current_date))::date;
  v_to := (v_from + interval '1 month')::date;
  return query
    select o.id, o.name, o.slug, o.vertical, o.status,
      pl.id, pl.nombre, pl.precio_base_mxn_centavos, pl.precio_asiento_mxn_centavos, pl.asientos_incluidos,
      ob.status, ob.seats, coalesce(pc.n, 0)::integer,
      coalesce(l.cost, 0)::bigint,
      coalesce(e.voz, 0)::bigint, coalesce(e.whatsapp, 0)::bigint, coalesce(e.telefonia, 0)::bigint, coalesce(e.otros, 0)::bigint,
      coalesce(e.total, 0)::bigint, coalesce(e.estimados, 0)::bigint,
      coalesce(e.minutos_voz, 0)::numeric, coalesce(e.mensajes, 0)::numeric,
      coalesce(b.monthly_cap_micro_usd, core.default_llm_org_monthly_cap_micro_usd()),
      coalesce(b.alert_threshold_pct, 80)::numeric
    from core.organization o
    left join core.organization_plan op on op.organization_id = o.id
    left join core.plan pl on pl.id = op.plan_id
    left join core.organization_billing ob on ob.organization_id = o.id
    left join core.llm_org_budget b on b.organization_id = o.id
    left join lateral (
      select count(*) as n from core.property p where p.organization_id = o.id and p.status = 'active'
    ) pc on true
    left join lateral (
      select sum(u.cost_micro_usd) as cost
      from core.llm_usage_daily u
      where u.organization_id = o.id and u.usage_date >= v_from and u.usage_date < v_to
    ) l on true
    left join lateral (
      select
        sum(x.costo_micro_usd) filter (where x.categoria = 'voz') as voz,
        sum(x.costo_micro_usd) filter (where x.categoria = 'whatsapp') as whatsapp,
        sum(x.costo_micro_usd) filter (where x.categoria = 'telefonia') as telefonia,
        sum(x.costo_micro_usd) filter (where x.categoria in ('sms', 'email', 'storage')) as otros,
        count(*) as total,
        count(*) filter (where x.costo_estimado) as estimados,
        sum(case x.unidad when 'minuto' then x.cantidad when 'segundo' then x.cantidad / 60 else 0 end) filter (where x.categoria = 'voz') as minutos_voz,
        sum(x.cantidad) filter (where x.categoria = 'whatsapp' and x.unidad = 'mensaje') as mensajes
      from core.usage_cost_event x
      where x.organization_id = o.id and x.occurred_at >= v_from::timestamptz and x.occurred_at < v_to::timestamptz
    ) e on true
    order by o.name, o.id;
end;
$$;
revoke all on function core.get_cost_margin_report_for_superadmin(uuid, date) from public;
grant execute on function core.get_cost_margin_report_for_superadmin(uuid, date) to authenticated;

create or replace function core.list_usage_cost_events_for_superadmin(p_caller_id uuid, p_organization_id uuid, p_limit int default 100)
returns table (
  id uuid, organization_id uuid, property_id uuid, vertical text, occurred_at timestamptz, categoria text, proveedor text,
  unidad text, cantidad numeric, costo_micro_usd bigint, costo_estimado boolean, ref_tipo text, ref_id text
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    select x.id, x.organization_id, x.property_id, x.vertical, x.occurred_at, x.categoria, x.proveedor,
      x.unidad, x.cantidad, x.costo_micro_usd, x.costo_estimado, x.ref_tipo, x.ref_id
    from core.usage_cost_event x
    where x.organization_id = p_organization_id
    order by x.occurred_at desc, x.id
    limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;
revoke all on function core.list_usage_cost_events_for_superadmin(uuid, uuid, int) from public;
grant execute on function core.list_usage_cost_events_for_superadmin(uuid, uuid, int) to authenticated;
