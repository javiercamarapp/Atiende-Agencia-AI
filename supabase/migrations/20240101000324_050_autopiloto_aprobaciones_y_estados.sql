-- Autopiloto de restaurantes (autopiloto-restaurantes-1): ciclo del pedido sin manos. Interno 050, prefijo de
-- supabase/migrations 20240101000324.
-- Requiere: 001 (orders, branch_products), 022 (branch_detail.zona_horaria), 028 (handoff_actor_en_sucursal, conversation_handoff,
-- conversation_note), 031 (orders.canal, hora_recogida), 034 (programado), 035 (voz_zona_horaria), 010 (promotions), 024 (pos_comanda_outbox),
-- 007/012 (enqueue_messaging_outbox).
--
-- Regla de producto: lo que mueve dinero, cancela algo que ya esta en cocina o es un pedido grande NO se automatiza sin humano. El
-- sistema prepara todo y pide UNA aprobacion con un clic; al aprobar, sigue solo. NUNCA se autoaprueba nada.
--
-- Que agrega (todo NUEVO salvo el CHECK de estados y una columna de branch_products):
--   A) orders.status admite `por_aprobar` (pedido grande retenido: sin comanda ni cocina hasta que una persona lo apruebe).
--   B) restaurantes.order_status_events: historial append-only de TODA transicion de estado (trigger en orders, misma transaccion).
--   C) restaurantes.autopiloto_config: banderas y minutos por sucursal (todo apagado/seguro por omision) + lectura/guardado por funcion.
--   D) restaurantes.solicitud_aprobacion: pedido grande, cancelacion, compensacion y pausa por saturacion. Crear, resolver (idempotente,
--      atomica ante dos clics) y escalar las que llevan N minutos sin respuesta.
--   E) Barrido de estados sin clic (solo sistema): candidatos + aplicar transicion (entregado->completado, listo_para_recoger->no_recogido,
--      pending->preparando con comanda impresa/capturada, avance desde el POS).
--   F) Regreso automatico del handoff (solo sistema) tras N minutos sin respuesta humana.
--   G) Agotado "solo por hoy": branch_products.agotado_hasta + marcar + reponer al cambiar el dia de negocio de la sucursal.
--   H) Muestras de tiempo de entrega y carga de cola para el tiempo prometido aprendido y la saturacion.
--   I) Bandera POR ORGANIZACION para que el agente de WhatsApp gestione las cancelaciones (apagada por omision).
--
-- Compatibilidad con la base sin migrar: TODO el TypeScript que llama estas funciones/tablas captura SQLSTATE 42883/42P01/42703 en un
-- SAVEPOINT (runWithSavepointFallback) y degrada a "no disponible aun" / comportamiento anterior. No se cambia ninguna firma existente.
--
-- Justificacion de seguridad (cada tabla, policy, funcion y GRANT trae su razon):
--  * order_status_events -- RLS activa; `revoke all` de public/anon/authenticated; solo `grant select` a authenticated con policy
--    handoff_actor_en_sucursal(org, sucursal, false) (owner/admin/staff con alcance; nunca using(true); cross-tenant = 0 filas). SIN
--    INSERT/UPDATE/DELETE para nadie salvo el trigger SECURITY DEFINER: append-only por privilegios (el borrado en cascada por
--    privacidad ARCO de la orden si procede). `actor` y `motivo` estan acotados por CHECK; sin PII (solo id de staff o rol de sistema).
--  * orders_registrar_evento_estado (trigger) -- SECURITY DEFINER con search_path fijo, revoke de public/anon/authenticated (no es
--    invocable; solo lo dispara orders). El actor sale de auth.uid() y, sin usuario, de un setting local validado contra una lista
--    cerrada (agente|pos|sistema): un valor arbitrario NUNCA llega al historial ni puede romper la actualizacion del pedido.
--  * autopiloto_config -- RLS activa y SIN grants ni policies para authenticated: toda lectura/escritura pasa por funciones definer.
--  * autopiloto_config_leer -- definer, search_path fijo, revoke public/anon, grant authenticated. Sesion de sistema (auth.uid() nulo)
--    solo si la sucursal pertenece a la organizacion declarada; usuario solo con alcance a la sucursal (42501 si no).
--  * autopiloto_config_guardar -- definer; SOLO owner/admin con alcance a la sucursal (cambia reglas de dinero y cancelacion);
--    sesion de sistema => 42501. Valida rangos (22023). Organizacion derivada de core.property, nunca del llamador.
--  * solicitud_aprobacion -- RLS activa; `grant select` a authenticated con policy handoff_actor_en_sucursal(...,false); sin escritura
--    directa. `detalle` solo guarda codigos y cifras (el TypeScript no mete nombres ni telefonos); CHECK de forma y tamano.
--  * solicitud_crear -- definer; sistema (agente) o staff con alcance; valida que sucursal y pedido pertenezcan a la organizacion
--    (nunca mezcla tenants); idempotente por el indice unico parcial (un pendiente por pedido y tipo).
--  * solicitud_pedido_grande_retener -- SOLO sistema (auth.uid() nulo): convierte un pedido recien creado (pending/programado) en
--    `por_aprobar` y crea su solicitud en la misma transaccion; sin esto el pedido ya estaria en cocina. Compare-and-set en el estado.
--  * solicitud_resolver -- definer; SOLO usuario con alcance a la sucursal (nunca el sistema: aprobar es una decision humana). Bloquea la
--    fila (FOR UPDATE): dos clics simultaneos aplican UNA vez y el segundo recibe el mismo resultado con aplicado=false. La transicion
--    del pedido es compare-and-set; la compensacion "descuento" crea un codigo de un solo uso (promotions.max_uses = 1) con tope por
--    sucursal; "reponer" crea un pedido de $0 con llave de idempotencia derivada de la solicitud. El dinero NUNCA se ejecuta aqui.
--  * solicitudes_por_escalar -- SOLO sistema; marca escalada_at al reclamarlas (una sola notificacion aunque corran dos ticks).
--  * autopiloto_candidatos_estados / autopiloto_aplicar_transicion -- SOLO sistema. La segunda solo permite una lista cerrada de pares
--    (de, a) y compare-and-set; fija el actor en el historial. Nunca toca por_aprobar ni cancela.
--  * handoffs_devolver_vencidos -- SOLO sistema; FOR UPDATE SKIP LOCKED (dos ticks no devuelven la misma toma); no devuelve conversaciones
--    con un pedido por aprobar; el texto fijo solo sale si el cliente escribio dentro de las ultimas 24 h.
--  * pedido_cancelar_cliente -- SOLO sistema; cancela un pedido pending/programado SOLO si la bandera de la sucursal esta encendida (por omision apagada) y
--    no hay comanda en el outbox del POS; compare-and-set con bloqueo de fila; motivo de lista cerrada; actor `agente` en el historial.
--  * autopiloto_org_config -- RLS activa, sin grants ni policies para authenticated (solo funciones). autopiloto_org_config_leer: sistema con organizacion existente o miembro de
--    ESA organizacion (42501 si no). autopiloto_org_config_guardar: solo owner/admin de alcance organizacional (membresia sin restriccion de sucursales); sistema => 42501.
--  * agotado_marcar -- definer; staff con alcance a la sucursal. agotados_reponer -- SOLO sistema, usa la zona horaria de la sucursal.
--  * tiempo_entrega_muestras -- lectura sin PII (solo minutos y conteos); sistema con sucursal de su organizacion, o staff con alcance.
--  Todas: `revoke ... from public, anon`; `grant execute ... to authenticated` (la sesion de sistema corre con ese rol sin usuario);
--  search_path fijo `restaurantes, core, pg_temp`. NINGUN grant a anon. Nada de using(true).

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Estado `por_aprobar`
-- ═══════════════════════════════════════════════════════════════════════════
alter table restaurantes.orders drop constraint if exists orders_status_check;
alter table restaurantes.orders
  add constraint orders_status_check
  check (status in ('pending', 'preparando', 'en_camino', 'entregado', 'cancelado', 'completado', 'problema', 'listo_para_recoger', 'no_recogido', 'programado', 'por_aprobar'));

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Historial de transiciones (append-only)
-- ═══════════════════════════════════════════════════════════════════════════
create table restaurantes.order_status_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references restaurantes.orders(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor text not null check (actor ~ '^(staff:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|agente|pos|sistema)$'),
  motivo text check (motivo is null or char_length(motivo) <= 200),
  at timestamptz not null default now()
);
create index order_status_events_order_idx on restaurantes.order_status_events (order_id, at);
create index order_status_events_org_prop_at_idx on restaurantes.order_status_events (organization_id, property_id, at desc);

alter table restaurantes.order_status_events enable row level security;
create policy "staff lee el historial de estados de sus sucursales" on restaurantes.order_status_events for select
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, false));
revoke all on restaurantes.order_status_events from public, anon, authenticated;
grant select on restaurantes.order_status_events to authenticated;
grant select on restaurantes.order_status_events to service_role;

create or replace function restaurantes.orders_registrar_evento_estado()
returns trigger
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_actor text;
  v_motivo text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;
  if auth.uid() is not null then
    v_actor := 'staff:' || auth.uid()::text;
  else
    v_actor := coalesce(nullif(current_setting('app.actor', true), ''), 'sistema');
    if v_actor not in ('agente', 'pos', 'sistema') then
      v_actor := 'sistema';
    end if;
  end if;
  v_motivo := left(nullif(current_setting('app.motivo', true), ''), 200);
  insert into restaurantes.order_status_events (order_id, organization_id, property_id, from_status, to_status, actor, motivo)
  values (new.id, new.organization_id, new.property_id, case when tg_op = 'UPDATE' then old.status else null end, new.status, v_actor, v_motivo);
  return new;
end;
$$;
revoke all on function restaurantes.orders_registrar_evento_estado() from public, anon, authenticated;

drop trigger if exists orders_registrar_evento_estado_trg on restaurantes.orders;
create trigger orders_registrar_evento_estado_trg
  after insert or update of status on restaurantes.orders
  for each row execute function restaurantes.orders_registrar_evento_estado();

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Configuracion por sucursal
-- ═══════════════════════════════════════════════════════════════════════════
create table restaurantes.autopiloto_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- Decision de PM (por omision NO): cancelar solo antes de cocina sin pedir aprobacion.
  cancelacion_auto boolean not null default false,
  -- Sin POS: pending -> preparando en cuanto la comanda se imprime o se marca capturada (por omision NO).
  aceptacion_auto boolean not null default false,
  aprobacion_minutos smallint not null default 10 check (aprobacion_minutos between 1 and 240),
  handoff_regreso_minutos smallint not null default 15 check (handoff_regreso_minutos between 1 and 240),
  no_recogido_minutos smallint not null default 60 check (no_recogido_minutos between 5 and 720),
  completado_horas smallint not null default 6 check (completado_horas between 1 and 72),
  -- Tope del descuento de una compensacion (porcentaje).
  compensacion_tope_pct smallint not null default 20 check (compensacion_tope_pct between 1 and 100),
  -- Saturacion: pedidos abiertos que disparan +extra minutos y la propuesta de pausa. null = apagado.
  saturacion_umbral_1 smallint check (saturacion_umbral_1 is null or saturacion_umbral_1 between 1 and 500),
  saturacion_umbral_2 smallint check (saturacion_umbral_2 is null or saturacion_umbral_2 between 1 and 500),
  saturacion_extra_minutos smallint not null default 15 check (saturacion_extra_minutos between 5 and 120),
  updated_at timestamptz not null default now(),
  updated_by uuid references core.staff_user(id) on delete set null,
  check (saturacion_umbral_2 is null or (saturacion_umbral_1 is not null and saturacion_umbral_2 > saturacion_umbral_1))
);
alter table restaurantes.autopiloto_config enable row level security;
revoke all on restaurantes.autopiloto_config from public, anon, authenticated;
grant select, insert, update, delete on restaurantes.autopiloto_config to service_role;

create or replace function restaurantes.autopiloto_config_leer(p_organization_id uuid, p_property_id uuid)
returns table (
  cancelacion_auto boolean, aceptacion_auto boolean, aprobacion_minutos integer, handoff_regreso_minutos integer,
  no_recogido_minutos integer, completado_horas integer, compensacion_tope_pct integer,
  saturacion_umbral_1 integer, saturacion_umbral_2 integer, saturacion_extra_minutos integer, configurada boolean
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is null then
    if not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
      raise exception 'autopiloto_config_leer: sucursal ajena' using errcode = '42501';
    end if;
  elsif not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'autopiloto_config_leer: sin acceso a la sucursal' using errcode = '42501';
  end if;
  return query
    select c.cancelacion_auto, c.aceptacion_auto, c.aprobacion_minutos::integer, c.handoff_regreso_minutos::integer,
           c.no_recogido_minutos::integer, c.completado_horas::integer, c.compensacion_tope_pct::integer,
           c.saturacion_umbral_1::integer, c.saturacion_umbral_2::integer, c.saturacion_extra_minutos::integer, true
      from restaurantes.autopiloto_config c
     where c.property_id = p_property_id and c.organization_id = p_organization_id;
  if not found then
    return query select false, false, 10, 15, 60, 6, 20, null::integer, null::integer, 15, false;
  end if;
end;
$$;

create or replace function restaurantes.autopiloto_config_guardar(
  p_organization_id uuid,
  p_property_id uuid,
  p_cancelacion_auto boolean,
  p_aceptacion_auto boolean,
  p_aprobacion_minutos integer,
  p_handoff_regreso_minutos integer,
  p_no_recogido_minutos integer,
  p_completado_horas integer,
  p_compensacion_tope_pct integer,
  p_saturacion_umbral_1 integer,
  p_saturacion_umbral_2 integer,
  p_saturacion_extra_minutos integer
) returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then
    raise exception 'autopiloto_config_guardar: requiere owner/admin con alcance a la sucursal' using errcode = '42501';
  end if;
  if p_aprobacion_minutos not between 1 and 240 or p_handoff_regreso_minutos not between 1 and 240
     or p_no_recogido_minutos not between 5 and 720 or p_completado_horas not between 1 and 72
     or p_compensacion_tope_pct not between 1 and 100 or p_saturacion_extra_minutos not between 5 and 120
     or (p_saturacion_umbral_1 is not null and p_saturacion_umbral_1 not between 1 and 500)
     or (p_saturacion_umbral_2 is not null and (p_saturacion_umbral_1 is null or p_saturacion_umbral_2 <= p_saturacion_umbral_1 or p_saturacion_umbral_2 > 500)) then
    raise exception 'autopiloto_config_guardar: valor fuera de rango' using errcode = '22023';
  end if;
  insert into restaurantes.autopiloto_config as c (
    property_id, organization_id, cancelacion_auto, aceptacion_auto, aprobacion_minutos, handoff_regreso_minutos, no_recogido_minutos,
    completado_horas, compensacion_tope_pct, saturacion_umbral_1, saturacion_umbral_2, saturacion_extra_minutos, updated_by
  ) values (
    p_property_id, p_organization_id, coalesce(p_cancelacion_auto, false), coalesce(p_aceptacion_auto, false), p_aprobacion_minutos,
    p_handoff_regreso_minutos, p_no_recogido_minutos, p_completado_horas, p_compensacion_tope_pct, p_saturacion_umbral_1,
    p_saturacion_umbral_2, p_saturacion_extra_minutos, auth.uid()
  )
  on conflict (property_id) do update set
    cancelacion_auto = excluded.cancelacion_auto, aceptacion_auto = excluded.aceptacion_auto,
    aprobacion_minutos = excluded.aprobacion_minutos, handoff_regreso_minutos = excluded.handoff_regreso_minutos,
    no_recogido_minutos = excluded.no_recogido_minutos, completado_horas = excluded.completado_horas,
    compensacion_tope_pct = excluded.compensacion_tope_pct, saturacion_umbral_1 = excluded.saturacion_umbral_1,
    saturacion_umbral_2 = excluded.saturacion_umbral_2, saturacion_extra_minutos = excluded.saturacion_extra_minutos,
    updated_at = now(), updated_by = auth.uid();
  return true;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Solicitudes de aprobacion
-- ═══════════════════════════════════════════════════════════════════════════
create table restaurantes.solicitud_aprobacion (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  tipo text not null check (tipo in ('pedido_grande', 'cancelacion', 'compensacion', 'pausa_sucursal')),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'resuelta')),
  order_id uuid references restaurantes.orders(id) on delete cascade,
  -- Solo codigos y cifras (sin nombres ni telefonos): motivo/subtipo de lista cerrada, total, peso.
  detalle jsonb not null default '{}'::jsonb check (jsonb_typeof(detalle) = 'object' and octet_length(detalle::text) <= 2000),
  decision text check (decision is null or decision in ('aprobar', 'rechazar', 'cancelar', 'mantener', 'sin_compensacion', 'reponer_producto', 'descuento_proximo', 'pausar', 'descartar')),
  motivo_resolucion text check (motivo_resolucion is null or char_length(motivo_resolucion) <= 200),
  codigo_descuento text check (codigo_descuento is null or codigo_descuento ~ '^[A-Z0-9_-]{3,40}$'),
  reposicion_order_id uuid references restaurantes.orders(id) on delete set null,
  solicitada_at timestamptz not null default now(),
  escalada_at timestamptz,
  resuelta_at timestamptz,
  resuelta_por uuid references core.staff_user(id) on delete set null,
  check ((estado = 'resuelta') = (decision is not null and resuelta_at is not null)),
  check (tipo = 'pausa_sucursal' or order_id is not null)
);
create unique index solicitud_aprobacion_pendiente_pedido_uidx
  on restaurantes.solicitud_aprobacion (order_id, tipo) where estado = 'pendiente' and order_id is not null;
create unique index solicitud_aprobacion_pendiente_pausa_uidx
  on restaurantes.solicitud_aprobacion (property_id) where estado = 'pendiente' and tipo = 'pausa_sucursal';
create index solicitud_aprobacion_org_prop_idx on restaurantes.solicitud_aprobacion (organization_id, property_id, estado, solicitada_at desc);

alter table restaurantes.solicitud_aprobacion enable row level security;
create policy "staff lee las solicitudes de aprobacion de sus sucursales" on restaurantes.solicitud_aprobacion for select
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, false));
revoke all on restaurantes.solicitud_aprobacion from public, anon, authenticated;
grant select on restaurantes.solicitud_aprobacion to authenticated;
grant select on restaurantes.solicitud_aprobacion to service_role;

-- Crear (sistema o staff). Devuelve (id, creada).
create or replace function restaurantes.solicitud_crear(
  p_organization_id uuid,
  p_property_id uuid,
  p_tipo text,
  p_order_id uuid,
  p_detalle jsonb
) returns table (id uuid, creada boolean)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_id uuid;
begin
  if p_tipo not in ('cancelacion', 'compensacion', 'pausa_sucursal') then
    raise exception 'solicitud_crear: tipo invalido (el pedido grande se crea con solicitud_pedido_grande_retener)' using errcode = '22023';
  end if;
  if not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
    raise exception 'solicitud_crear: sucursal ajena' using errcode = '42501';
  end if;
  if auth.uid() is not null and not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'solicitud_crear: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if p_order_id is not null and not exists (
    select 1 from restaurantes.orders o where o.id = p_order_id and o.organization_id = p_organization_id and o.property_id = p_property_id
  ) then
    raise exception 'solicitud_crear: pedido ajeno' using errcode = '42501';
  end if;
  insert into restaurantes.solicitud_aprobacion (organization_id, property_id, tipo, order_id, detalle)
  values (p_organization_id, p_property_id, p_tipo, p_order_id, coalesce(p_detalle, '{}'::jsonb))
  on conflict do nothing
  returning solicitud_aprobacion.id into v_id;
  if v_id is not null then
    return query select v_id, true;
    return;
  end if;
  return query
    select s.id, false from restaurantes.solicitud_aprobacion s
     where s.organization_id = p_organization_id and s.estado = 'pendiente' and s.tipo = p_tipo
       and ((p_order_id is not null and s.order_id = p_order_id) or (p_order_id is null and s.property_id = p_property_id))
     limit 1;
end;
$$;

-- Retener un pedido grande recien creado (solo sistema).
create or replace function restaurantes.solicitud_pedido_grande_retener(
  p_organization_id uuid,
  p_order_id uuid,
  p_detalle jsonb
) returns table (id uuid, creada boolean, property_id uuid)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_o restaurantes.orders;
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'solicitud_pedido_grande_retener: solo la sesion de sistema' using errcode = '42501';
  end if;
  select * into v_o from restaurantes.orders o where o.id = p_order_id and o.organization_id = p_organization_id for update;
  if not found then
    raise exception 'solicitud_pedido_grande_retener: pedido inexistente o ajeno' using errcode = '42501';
  end if;
  if v_o.status = 'por_aprobar' then
    return query select s.id, false, s.property_id from restaurantes.solicitud_aprobacion s
      where s.order_id = p_order_id and s.tipo = 'pedido_grande' and s.estado = 'pendiente' limit 1;
    return;
  end if;
  if v_o.status not in ('pending', 'programado') then
    raise exception 'solicitud_pedido_grande_retener: el pedido ya avanzo (%)', v_o.status using errcode = '22023';
  end if;
  perform set_config('app.actor', 'agente', true);
  perform set_config('app.motivo', 'pedido_grande', true);
  update restaurantes.orders set status = 'por_aprobar' where orders.id = p_order_id;
  perform set_config('app.actor', '', true);
  perform set_config('app.motivo', '', true);
  insert into restaurantes.solicitud_aprobacion (organization_id, property_id, tipo, order_id, detalle)
  values (p_organization_id, v_o.property_id, 'pedido_grande', p_order_id, coalesce(p_detalle, '{}'::jsonb))
  returning solicitud_aprobacion.id into v_id;
  return query select v_id, true, v_o.property_id;
end;
$$;

-- Resolver una solicitud (solo una persona con alcance). Idempotente y atomica.
create or replace function restaurantes.solicitud_resolver(
  p_organization_id uuid,
  p_solicitud_id uuid,
  p_decision text,
  p_motivo text,
  p_valor integer default null,
  p_item_indices integer[] default null
) returns table (
  aplicado boolean, estado text, decision text, tipo text, order_id uuid, property_id uuid,
  estado_pedido text, codigo_descuento text, reposicion_order_id uuid
)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_s restaurantes.solicitud_aprobacion;
  v_o restaurantes.orders;
  v_to text;
  v_codigo text;
  v_tope integer;
  v_repo uuid;
  v_items jsonb;
  v_uid uuid := auth.uid();
  v_motivo text := nullif(btrim(coalesce(p_motivo, '')), '');
begin
  select * into v_s from restaurantes.solicitud_aprobacion s where s.id = p_solicitud_id and s.organization_id = p_organization_id for update;
  if not found or v_uid is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, v_s.property_id, false) then
    raise exception 'solicitud_resolver: inexistente o sin acceso' using errcode = '42501';
  end if;
  if v_s.estado = 'resuelta' then
    return query select false, v_s.estado, v_s.decision, v_s.tipo, v_s.order_id, v_s.property_id,
      (select o.status from restaurantes.orders o where o.id = v_s.order_id), v_s.codigo_descuento, v_s.reposicion_order_id;
    return;
  end if;
  if (v_s.tipo = 'pedido_grande' and p_decision not in ('aprobar', 'rechazar'))
     or (v_s.tipo = 'cancelacion' and p_decision not in ('cancelar', 'mantener'))
     or (v_s.tipo = 'compensacion' and p_decision not in ('sin_compensacion', 'reponer_producto', 'descuento_proximo'))
     or (v_s.tipo = 'pausa_sucursal' and p_decision not in ('pausar', 'descartar')) then
    raise exception 'solicitud_resolver: decision invalida para %', v_s.tipo using errcode = '22023';
  end if;
  if v_motivo is not null and char_length(v_motivo) > 200 then
    raise exception 'solicitud_resolver: motivo demasiado largo' using errcode = '22023';
  end if;

  if v_s.order_id is not null then
    select * into v_o from restaurantes.orders o where o.id = v_s.order_id and o.organization_id = p_organization_id for update;
  end if;

  if v_s.tipo = 'pedido_grande' then
    if v_o.status <> 'por_aprobar' then
      -- Ya no esta por aprobar (alguien lo cancelo o lo movio): se cierra la solicitud sin tocar el pedido.
      update restaurantes.solicitud_aprobacion s set estado = 'resuelta', decision = case when p_decision = 'aprobar' then 'aprobar' else 'rechazar' end,
        motivo_resolucion = 'pedido_ya_no_estaba_por_aprobar', resuelta_at = now(), resuelta_por = v_uid where s.id = v_s.id;
      return query select false, 'resuelta'::text, p_decision, v_s.tipo, v_s.order_id, v_s.property_id, v_o.status, null::text, null::uuid;
      return;
    end if;
    if p_decision = 'aprobar' then
      v_to := case when v_o.programado_para is not null and v_o.programado_para > now() then 'programado' else 'pending' end;
      perform set_config('app.motivo', 'aprobado', true);
    else
      if v_motivo is null or v_motivo not in ('cliente_desistio', 'sin_producto', 'fuera_de_zona', 'duplicado', 'error_agente', 'otro') then
        raise exception 'solicitud_resolver: rechazar exige un motivo de la lista cerrada' using errcode = '22023';
      end if;
      v_to := 'cancelado';
      perform set_config('app.motivo', v_motivo, true);
    end if;
    update restaurantes.orders set status = v_to where orders.id = v_o.id and orders.status = 'por_aprobar';
    perform set_config('app.motivo', '', true);
    v_o.status := v_to;
  elsif v_s.tipo = 'cancelacion' and p_decision = 'cancelar' then
    if v_motivo is null or v_motivo not in ('cliente_desistio', 'sin_producto', 'fuera_de_zona', 'duplicado', 'error_agente', 'otro') then
      raise exception 'solicitud_resolver: cancelar exige un motivo de la lista cerrada' using errcode = '22023';
    end if;
    if v_o.status not in ('pending', 'programado', 'preparando', 'listo_para_recoger', 'no_recogido', 'problema', 'por_aprobar') then
      -- Ya salio o ya cerro: no se puede cancelar; la decision queda como mantener.
      update restaurantes.solicitud_aprobacion s set estado = 'resuelta', decision = 'mantener', motivo_resolucion = 'no_cancelable_' || v_o.status,
        resuelta_at = now(), resuelta_por = v_uid where s.id = v_s.id;
      return query select false, 'resuelta'::text, 'mantener'::text, v_s.tipo, v_s.order_id, v_s.property_id, v_o.status, null::text, null::uuid;
      return;
    end if;
    perform set_config('app.motivo', v_motivo, true);
    update restaurantes.orders set status = 'cancelado' where orders.id = v_o.id;
    perform set_config('app.motivo', '', true);
    v_o.status := 'cancelado';
  elsif v_s.tipo = 'compensacion' and p_decision = 'descuento_proximo' then
    select c.compensacion_tope_pct into v_tope from restaurantes.autopiloto_config_leer(p_organization_id, v_s.property_id) c;
    if p_valor is null or p_valor < 1 or p_valor > coalesce(v_tope, 20) then
      raise exception 'solicitud_resolver: el descuento debe ser de 1 a % por ciento', coalesce(v_tope, 20) using errcode = '22023';
    end if;
    v_codigo := 'GRACIAS-' || upper(substr(md5(random()::text || clock_timestamp()::text || v_s.id::text), 1, 8));
    insert into restaurantes.promotions (organization_id, code, name, description, type, value, starts_at, ends_at, max_uses, is_active)
    values (p_organization_id, v_codigo, 'Compensacion de un solo uso', 'Compensacion por una queja; un solo uso.', 'percentage', p_valor,
            now(), now() + interval '30 days', 1, true);
  elsif v_s.tipo = 'compensacion' and p_decision = 'reponer_producto' then
    if v_o.id is null then
      raise exception 'solicitud_resolver: la compensacion no tiene pedido' using errcode = '22023';
    end if;
    if p_item_indices is null or cardinality(p_item_indices) = 0 or cardinality(p_item_indices) > 20 then
      raise exception 'solicitud_resolver: elija al menos un renglon a reponer' using errcode = '22023';
    end if;
    select coalesce(jsonb_agg(jsonb_set(it.elem, '{price}', '0'::jsonb)), '[]'::jsonb) into v_items
      from jsonb_array_elements(v_o.items) with ordinality as it(elem, ord)
     where (it.ord - 1)::integer = any (p_item_indices);
    if jsonb_array_length(v_items) = 0 then
      raise exception 'solicitud_resolver: renglones a reponer invalidos' using errcode = '22023';
    end if;
    insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, customer_address, branch, total,
                                     status, items, source, notes, payment_method, canal, idempotency_key)
    values (p_organization_id, v_o.property_id, v_o.customer_id, v_o.customer_name, v_o.customer_phone, v_o.customer_address, v_o.branch, 0,
            'pending', v_items, 'admin', 'Reposicion sin costo del pedido #' || v_o.order_number::text || '.', null, v_o.canal,
            encode(sha256(convert_to('reposicion:' || v_s.id::text, 'utf8')), 'hex'))
    on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing
    returning orders.id into v_repo;
    if v_repo is null then
      select o2.id into v_repo from restaurantes.orders o2
       where o2.organization_id = p_organization_id and o2.idempotency_key = encode(sha256(convert_to('reposicion:' || v_s.id::text, 'utf8')), 'hex');
    end if;
  end if;

  update restaurantes.solicitud_aprobacion s set
    estado = 'resuelta', decision = p_decision,
    -- Seguridad (defensa en profundidad de datos personales): el motivo solo se conserva si pertenece a la lista cerrada; un texto libre del staff
    -- (que podria incluir nombres o telefonos) en aprobar/mantener/sin_compensacion/etc. NO se guarda. Cancelar y rechazar ya lo exigen de la lista.
    motivo_resolucion = case when v_motivo in ('cliente_desistio', 'sin_producto', 'fuera_de_zona', 'duplicado', 'error_agente', 'otro') then v_motivo else null end,
    codigo_descuento = v_codigo,
    reposicion_order_id = v_repo, resuelta_at = now(), resuelta_por = v_uid
  where s.id = v_s.id;
  return query select true, 'resuelta'::text, p_decision, v_s.tipo, v_s.order_id, v_s.property_id, v_o.status, v_codigo, v_repo;
end;
$$;

-- Escalar las que llevan N minutos sin respuesta (solo sistema). Reclama escalada_at: una sola notificacion.
create or replace function restaurantes.solicitudes_por_escalar(p_ahora timestamptz, p_limite integer default 100)
returns table (id uuid, organization_id uuid, property_id uuid, tipo text, order_id uuid, minutos integer)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is not null then
    raise exception 'solicitudes_por_escalar: solo la sesion de sistema' using errcode = '42501';
  end if;
  return query
    with cand as (
      select s.id as sid
        from restaurantes.solicitud_aprobacion s
        left join restaurantes.autopiloto_config c on c.property_id = s.property_id
       where s.estado = 'pendiente' and s.escalada_at is null
         and s.solicitada_at <= p_ahora - make_interval(mins => coalesce(c.aprobacion_minutos, 10))
       order by s.solicitada_at
       limit least(greatest(coalesce(p_limite, 100), 1), 500)
       for update of s skip locked
    ), marc as (
      update restaurantes.solicitud_aprobacion s set escalada_at = p_ahora
        from cand where s.id = cand.sid
      returning s.id, s.organization_id, s.property_id, s.tipo, s.order_id, s.solicitada_at
    )
    select m.id, m.organization_id, m.property_id, m.tipo, m.order_id,
           greatest(0, floor(extract(epoch from (p_ahora - m.solicitada_at)) / 60))::integer
      from marc m;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- E) Barrido de estados sin clic (solo sistema)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function restaurantes.autopiloto_candidatos_estados(p_ahora timestamptz, p_limite integer default 200)
returns table (order_id uuid, organization_id uuid, property_id uuid, from_status text, to_status text, motivo text)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is not null then
    raise exception 'autopiloto_candidatos_estados: solo la sesion de sistema' using errcode = '42501';
  end if;
  return query
    select * from (
      -- entregado -> completado a las N horas (por sucursal; por omision 6)
      select o.id, o.organization_id, o.property_id, o.status, 'completado'::text, 'limpieza_entregado'::text
        from restaurantes.orders o
        left join restaurantes.autopiloto_config c on c.property_id = o.property_id
       where o.status = 'entregado' and o.delivered_at is not null
         and o.delivered_at <= p_ahora - make_interval(hours => coalesce(c.completado_horas, 6))
      union all
      -- listo_para_recoger -> no_recogido a los X minutos de la hora de recogida (por omision 60)
      select o.id, o.organization_id, o.property_id, o.status, 'no_recogido'::text, 'limpieza_no_recogido'::text
        from restaurantes.orders o
        left join restaurantes.autopiloto_config c on c.property_id = o.property_id
       where o.status = 'listo_para_recoger' and o.hora_recogida is not null
         and o.hora_recogida <= p_ahora - make_interval(mins => coalesce(c.no_recogido_minutos, 60))
      union all
      -- pending -> preparando (aceptacion automatica, sin POS): la comanda ya se imprimio o se marco capturada
      select o.id, o.organization_id, o.property_id, o.status, 'preparando'::text, 'aceptacion_automatica'::text
        from restaurantes.orders o
        join restaurantes.autopiloto_config c on c.property_id = o.property_id and c.aceptacion_auto
       where o.status = 'pending'
         and exists (select 1 from restaurantes.pos_comanda_outbox pc
                      where pc.order_id = o.id and pc.organization_id = o.organization_id and pc.estado in ('confirmada', 'capturada_manual'))
    ) x(order_id, organization_id, property_id, from_status, to_status, motivo)
    limit least(greatest(coalesce(p_limite, 200), 1), 1000);
end;
$$;

create or replace function restaurantes.autopiloto_aplicar_transicion(
  p_organization_id uuid,
  p_order_id uuid,
  p_from text,
  p_to text,
  p_actor text,
  p_motivo text
) returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_n integer;
begin
  if auth.uid() is not null then
    raise exception 'autopiloto_aplicar_transicion: solo la sesion de sistema' using errcode = '42501';
  end if;
  if not ((p_from, p_to) in (
    ('entregado', 'completado'), ('listo_para_recoger', 'no_recogido'), ('pending', 'preparando'),
    ('preparando', 'en_camino'), ('preparando', 'listo_para_recoger')
  )) then
    raise exception 'autopiloto_aplicar_transicion: transicion no permitida (% -> %)', p_from, p_to using errcode = '22023';
  end if;
  if p_actor not in ('agente', 'pos', 'sistema') then
    raise exception 'autopiloto_aplicar_transicion: actor invalido' using errcode = '22023';
  end if;
  perform set_config('app.actor', p_actor, true);
  perform set_config('app.motivo', coalesce(left(p_motivo, 200), ''), true);
  update restaurantes.orders set
    status = p_to,
    delivered_at = case when p_to = 'entregado' then now() else delivered_at end
  where orders.id = p_order_id and orders.organization_id = p_organization_id and orders.status = p_from;
  get diagnostics v_n = row_count;
  perform set_config('app.actor', '', true);
  perform set_config('app.motivo', '', true);
  return v_n = 1;
end;
$$;

-- Comandas confirmadas de pedidos que siguen en cocina, para consultar su estado en el POS (solo sistema).
create or replace function restaurantes.autopiloto_comandas_para_avance(p_limite integer default 50)
returns table (order_id uuid, organization_id uuid, property_id uuid, folio text, status text, canal text)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is not null then
    raise exception 'autopiloto_comandas_para_avance: solo la sesion de sistema' using errcode = '42501';
  end if;
  return query
    select o.id, o.organization_id, o.property_id, pc.folio, o.status, o.canal
      from restaurantes.pos_comanda_outbox pc
      join restaurantes.orders o on o.id = pc.order_id and o.organization_id = pc.organization_id
     where pc.estado = 'confirmada' and pc.folio is not null and pc.modo = 'activo' and o.status in ('pending', 'preparando')
     order by pc.actualizado_en
     limit least(greatest(coalesce(p_limite, 50), 1), 200);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- F) Regreso automatico del handoff (solo sistema)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function restaurantes.handoffs_devolver_vencidos(p_ahora timestamptz, p_limite integer default 50)
returns table (handoff_id uuid, organization_id uuid, property_id uuid, conversation_id uuid, minutos integer, avisado boolean)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  r record;
  v_pnid text;
  v_texto constant text := 'Gracias por esperar; le sigo atendiendo yo.';
  v_avisado boolean;
begin
  if auth.uid() is not null then
    raise exception 'handoffs_devolver_vencidos: solo la sesion de sistema' using errcode = '42501';
  end if;
  for r in
    select h.id as hid, h.organization_id as org, h.property_id as prop, h.conversation_id as conv, h.ultimo_cliente_at,
           c.phone, coalesce(cfg.handoff_regreso_minutos, 15) as mins,
           greatest(h.tomada_at, coalesce((
             select max(m.created_at) from restaurantes.messaging_outbox m
              where m.organization_id = h.organization_id and m.event_type = 'whatsapp.handoff_reply'
                and m.dedupe_key like 'handoff-reply:' || h.id::text || ':%'
           ), h.tomada_at)) as ultima_humana
      from restaurantes.conversation_handoff h
      join restaurantes.whatsapp_conversations c on c.id = h.conversation_id and c.organization_id = h.organization_id
      left join restaurantes.autopiloto_config cfg on cfg.property_id = h.property_id
     where h.canal = 'whatsapp' and h.estado = 'tomada' and h.tomada_at is not null
       and not exists (
         select 1 from restaurantes.solicitud_aprobacion s
           join restaurantes.orders o on o.id = s.order_id
          where s.organization_id = h.organization_id and s.estado = 'pendiente' and s.tipo = 'pedido_grande'
            and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) = right(regexp_replace(c.phone, '\D', '', 'g'), 10)
       )
     order by h.tomada_at
     limit least(greatest(coalesce(p_limite, 50), 1), 200)
     for update of h skip locked
  loop
    if r.ultima_humana > p_ahora - make_interval(mins => r.mins) then
      continue;
    end if;
    update restaurantes.conversation_handoff set estado = 'devuelta', devuelta_at = p_ahora, updated_at = p_ahora
     where id = r.hid and estado = 'tomada';
    insert into restaurantes.conversation_note (organization_id, property_id, handoff_id, autor_id, texto)
    values (r.org, r.prop, r.hid, null, 'Devuelta al agente automaticamente: sin respuesta humana en ' || r.mins::text || ' minutos.');
    v_avisado := false;
    -- La frase fija solo sale dentro de la ventana de 24 h del cliente (fuera de ella haria falta plantilla).
    if r.ultimo_cliente_at is not null and r.ultimo_cliente_at > p_ahora - interval '24 hours' then
      select b.phone_number_id into v_pnid from restaurantes.whatsapp_branch_channel b where b.property_id = r.prop;
      if v_pnid is null then
        select o.phone_number_id into v_pnid from restaurantes.whatsapp_channel_config o where o.organization_id = r.org;
      end if;
      if v_pnid is not null then
        update restaurantes.whatsapp_conversations
           set messages = messages || jsonb_build_array(jsonb_build_object('role', 'assistant', 'content', v_texto, 'autor', 'agente')),
               updated_at = p_ahora
         where id = r.conv and organization_id = r.org;
        perform restaurantes.enqueue_messaging_outbox(
          r.org, 'whatsapp', 'whatsapp.handoff_reply', 'handoff-regreso:' || r.hid::text,
          jsonb_build_object('to', r.phone, 'phone_number_id', v_pnid, 'body', v_texto)
        );
        v_avisado := true;
      end if;
    end if;
    return query select r.hid, r.org, r.prop, r.conv, r.mins, v_avisado;
  end loop;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- G) Agotado "solo por hoy"
-- ═══════════════════════════════════════════════════════════════════════════
alter table restaurantes.branch_products add column if not exists agotado_hasta date;

create or replace function restaurantes.branch_products_limpiar_agotado_hasta()
returns trigger
language plpgsql
set search_path = restaurantes, pg_temp
as $$
begin
  -- Un cambio manual de disponibilidad (sin tocar agotado_hasta) cancela el restablecimiento programado.
  if new.is_available is distinct from old.is_available and new.agotado_hasta is not distinct from old.agotado_hasta then
    new.agotado_hasta := null;
  end if;
  return new;
end;
$$;
drop trigger if exists branch_products_limpiar_agotado_hasta_trg on restaurantes.branch_products;
create trigger branch_products_limpiar_agotado_hasta_trg
  before update of is_available on restaurantes.branch_products
  for each row execute function restaurantes.branch_products_limpiar_agotado_hasta();
revoke all on function restaurantes.branch_products_limpiar_agotado_hasta() from public, anon, authenticated;

create or replace function restaurantes.agotado_marcar(p_organization_id uuid, p_property_id uuid, p_product_id uuid, p_hasta date)
returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_hoy date;
  v_n integer;
begin
  if auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'agotado_marcar: sin acceso a la sucursal' using errcode = '42501';
  end if;
  v_hoy := (now() at time zone restaurantes.voz_zona_horaria(p_property_id))::date;
  if p_hasta is null or p_hasta <= v_hoy or p_hasta > v_hoy + 7 then
    raise exception 'agotado_marcar: la fecha de reposicion debe ser posterior a hoy y a lo mucho en 7 dias' using errcode = '22023';
  end if;
  update restaurantes.branch_products bp set is_available = false, agotado_hasta = p_hasta, updated_at = now()
   where bp.property_id = p_property_id and bp.product_id = p_product_id
     and exists (select 1 from restaurantes.products p where p.id = bp.product_id and p.organization_id = p_organization_id);
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

create or replace function restaurantes.agotados_reponer(p_ahora timestamptz)
returns table (property_id uuid, product_id uuid, organization_id uuid, agotado_hasta date)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is not null then
    raise exception 'agotados_reponer: solo la sesion de sistema' using errcode = '42501';
  end if;
  return query
    with cand as (
      select bp.id as bid, bp.agotado_hasta as hasta
        from restaurantes.branch_products bp
       where bp.agotado_hasta is not null and bp.is_available = false
         and (p_ahora at time zone restaurantes.voz_zona_horaria(bp.property_id))::date >= bp.agotado_hasta
       for update of bp skip locked
    ), upd as (
      update restaurantes.branch_products bp set is_available = true, agotado_hasta = null, updated_at = p_ahora
        from cand where bp.id = cand.bid
      returning bp.property_id as pid, bp.product_id as prid, cand.hasta
    )
    select u.pid, u.prid, (select p.organization_id from core.property p where p.id = u.pid), u.hasta from upd u;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- H) Muestras de tiempo de entrega y carga de cola (sin PII)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function restaurantes.tiempo_entrega_muestras(
  p_organization_id uuid,
  p_property_id uuid,
  p_canal text,
  p_ahora timestamptz,
  p_limite integer default 30
) returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_tz text;
  v_local timestamp;
  v_muestras jsonb;
  v_abiertos integer;
begin
  if auth.uid() is null then
    if not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
      raise exception 'tiempo_entrega_muestras: sucursal ajena' using errcode = '42501';
    end if;
  elsif not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'tiempo_entrega_muestras: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if p_canal not in ('domicilio', 'recoger') then
    raise exception 'tiempo_entrega_muestras: canal invalido' using errcode = '22023';
  end if;
  v_tz := restaurantes.voz_zona_horaria(p_property_id);
  v_local := p_ahora at time zone v_tz;
  select coalesce(jsonb_agg(m.minutos order by m.fin desc), '[]'::jsonb) into v_muestras from (
    select round((extract(epoch from (o.delivered_at - coalesce(o.promovido_at, o.created_at))) / 60.0)::numeric, 1) as minutos, o.delivered_at as fin
      from restaurantes.orders o
     where o.organization_id = p_organization_id and o.property_id = p_property_id
       and o.status in ('entregado', 'completado') and o.delivered_at is not null
       and o.delivered_at >= p_ahora - interval '60 days' and o.delivered_at < p_ahora
       and coalesce(o.canal, 'domicilio') = p_canal
       and extract(dow from (coalesce(o.promovido_at, o.created_at) at time zone v_tz)) = extract(dow from v_local)
       and abs(extract(hour from (coalesce(o.promovido_at, o.created_at) at time zone v_tz)) - extract(hour from v_local)) <= 1
       and o.delivered_at >= coalesce(o.promovido_at, o.created_at)
     order by o.delivered_at desc
     limit least(greatest(coalesce(p_limite, 30), 1), 100)
  ) m;
  select count(*)::integer into v_abiertos from restaurantes.orders o
   where o.organization_id = p_organization_id and o.property_id = p_property_id and o.status in ('pending', 'preparando', 'en_camino', 'listo_para_recoger');
  return jsonb_build_object('muestras', v_muestras, 'abiertos', v_abiertos);
end;
$$;

-- Cancelacion automatica pedida por el cliente (solo sistema): SOLO si la bandera de la sucursal esta encendida (por omision apagada, la
-- decide PM), el pedido sigue en pending/programado y NO tiene comanda en el outbox del POS (no hay nada en cocina que cancelar).
create or replace function restaurantes.pedido_cancelar_cliente(p_organization_id uuid, p_order_id uuid, p_motivo text)
returns table (aplicado boolean, estado text)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_o restaurantes.orders;
  v_auto boolean;
begin
  if auth.uid() is not null then
    raise exception 'pedido_cancelar_cliente: solo la sesion de sistema' using errcode = '42501';
  end if;
  if p_motivo is null or p_motivo not in ('cliente_desistio', 'sin_producto', 'fuera_de_zona', 'duplicado', 'error_agente', 'otro') then
    raise exception 'pedido_cancelar_cliente: motivo fuera de la lista cerrada' using errcode = '22023';
  end if;
  select * into v_o from restaurantes.orders o where o.id = p_order_id and o.organization_id = p_organization_id for update;
  if not found then
    raise exception 'pedido_cancelar_cliente: pedido inexistente o ajeno' using errcode = '42501';
  end if;
  select c.cancelacion_auto into v_auto from restaurantes.autopiloto_config c where c.property_id = v_o.property_id and c.organization_id = p_organization_id;
  if coalesce(v_auto, false) is not true then
    return query select false, 'politica_apagada'::text;
    return;
  end if;
  if v_o.status not in ('pending', 'programado') then
    return query select false, v_o.status;
    return;
  end if;
  if exists (select 1 from restaurantes.pos_comanda_outbox pc where pc.order_id = v_o.id and pc.organization_id = p_organization_id) then
    return query select false, 'ya_en_cocina'::text;
    return;
  end if;
  perform set_config('app.actor', 'agente', true);
  perform set_config('app.motivo', p_motivo, true);
  update restaurantes.orders set status = 'cancelado' where orders.id = v_o.id and orders.status in ('pending', 'programado');
  perform set_config('app.actor', '', true);
  perform set_config('app.motivo', '', true);
  return query select true, 'cancelado'::text;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- I) Bandera por organizacion: el agente gestiona las cancelaciones (apagada por omision)
-- ═══════════════════════════════════════════════════════════════════════════
-- Seguridad: tabla con RLS y SIN grants ni policies (solo funciones). `autopiloto_org_config_leer`: sistema (auth.uid() nulo) con la organizacion
-- existente, o usuario miembro de ESA organizacion. `autopiloto_org_config_guardar`: solo owner/admin de alcance organizacional (membresia sin
-- restriccion de sucursales: es una regla de TODA la organizacion, un admin acotado a una sucursal no la cambia); sistema => 42501.
create table restaurantes.autopiloto_org_config (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  cancelacion_agente boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references core.staff_user(id) on delete set null
);
alter table restaurantes.autopiloto_org_config enable row level security;
revoke all on restaurantes.autopiloto_org_config from public, anon, authenticated;
grant select, insert, update, delete on restaurantes.autopiloto_org_config to service_role;

create or replace function restaurantes.autopiloto_org_config_leer(p_organization_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v boolean;
begin
  if auth.uid() is null then
    if not exists (select 1 from core.organization o where o.id = p_organization_id) then
      raise exception 'autopiloto_org_config_leer: organizacion inexistente' using errcode = '42501';
    end if;
  elsif not exists (
    select 1 from core.membership m
     where m.user_id = auth.uid() and m.organization_id = p_organization_id and m.vertical_role in ('owner', 'admin', 'staff')
  ) then
    raise exception 'autopiloto_org_config_leer: sin acceso a la organizacion' using errcode = '42501';
  end if;
  select c.cancelacion_agente into v from restaurantes.autopiloto_org_config c where c.organization_id = p_organization_id;
  return coalesce(v, false);
end;
$$;

create or replace function restaurantes.autopiloto_org_config_guardar(p_organization_id uuid, p_cancelacion_agente boolean)
returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, null, true) then
    raise exception 'autopiloto_org_config_guardar: requiere owner/admin de toda la organizacion' using errcode = '42501';
  end if;
  insert into restaurantes.autopiloto_org_config as c (organization_id, cancelacion_agente, updated_by)
  values (p_organization_id, coalesce(p_cancelacion_agente, false), auth.uid())
  on conflict (organization_id) do update set cancelacion_agente = excluded.cancelacion_agente, updated_at = now(), updated_by = auth.uid();
  return true;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Permisos de ejecucion de todas las funciones publicas de esta migracion
-- ═══════════════════════════════════════════════════════════════════════════
revoke all on function restaurantes.autopiloto_config_leer(uuid, uuid) from public, anon;
revoke all on function restaurantes.autopiloto_config_guardar(uuid, uuid, boolean, boolean, integer, integer, integer, integer, integer, integer, integer, integer) from public, anon;
revoke all on function restaurantes.solicitud_crear(uuid, uuid, text, uuid, jsonb) from public, anon;
revoke all on function restaurantes.solicitud_pedido_grande_retener(uuid, uuid, jsonb) from public, anon;
revoke all on function restaurantes.solicitud_resolver(uuid, uuid, text, text, integer, integer[]) from public, anon;
revoke all on function restaurantes.solicitudes_por_escalar(timestamptz, integer) from public, anon;
revoke all on function restaurantes.autopiloto_candidatos_estados(timestamptz, integer) from public, anon;
revoke all on function restaurantes.autopiloto_aplicar_transicion(uuid, uuid, text, text, text, text) from public, anon;
revoke all on function restaurantes.autopiloto_comandas_para_avance(integer) from public, anon;
revoke all on function restaurantes.handoffs_devolver_vencidos(timestamptz, integer) from public, anon;
revoke all on function restaurantes.autopiloto_org_config_leer(uuid) from public, anon;
revoke all on function restaurantes.autopiloto_org_config_guardar(uuid, boolean) from public, anon;
revoke all on function restaurantes.pedido_cancelar_cliente(uuid, uuid, text) from public, anon;
revoke all on function restaurantes.agotado_marcar(uuid, uuid, uuid, date) from public, anon;
revoke all on function restaurantes.agotados_reponer(timestamptz) from public, anon;
revoke all on function restaurantes.tiempo_entrega_muestras(uuid, uuid, text, timestamptz, integer) from public, anon;

grant execute on function restaurantes.autopiloto_config_leer(uuid, uuid) to authenticated;
grant execute on function restaurantes.autopiloto_config_guardar(uuid, uuid, boolean, boolean, integer, integer, integer, integer, integer, integer, integer, integer) to authenticated;
grant execute on function restaurantes.solicitud_crear(uuid, uuid, text, uuid, jsonb) to authenticated;
grant execute on function restaurantes.solicitud_pedido_grande_retener(uuid, uuid, jsonb) to authenticated;
grant execute on function restaurantes.solicitud_resolver(uuid, uuid, text, text, integer, integer[]) to authenticated;
grant execute on function restaurantes.solicitudes_por_escalar(timestamptz, integer) to authenticated;
grant execute on function restaurantes.autopiloto_candidatos_estados(timestamptz, integer) to authenticated;
grant execute on function restaurantes.autopiloto_aplicar_transicion(uuid, uuid, text, text, text, text) to authenticated;
grant execute on function restaurantes.autopiloto_comandas_para_avance(integer) to authenticated;
grant execute on function restaurantes.handoffs_devolver_vencidos(timestamptz, integer) to authenticated;
grant execute on function restaurantes.autopiloto_org_config_leer(uuid) to authenticated;
grant execute on function restaurantes.autopiloto_org_config_guardar(uuid, boolean) to authenticated;
grant execute on function restaurantes.pedido_cancelar_cliente(uuid, uuid, text) to authenticated;
grant execute on function restaurantes.agotado_marcar(uuid, uuid, uuid, date) to authenticated;
grant execute on function restaurantes.agotados_reponer(timestamptz) to authenticated;
grant execute on function restaurantes.tiempo_entrega_muestras(uuid, uuid, text, timestamptz, integer) to authenticated;
