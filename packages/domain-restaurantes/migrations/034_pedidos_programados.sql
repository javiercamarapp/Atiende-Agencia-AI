-- R-11 (PM, Los Taquitos de PM): pedidos PROGRAMADOS. Un cliente deja el pedido hoy para una fecha y hora
-- futuras ("para el sabado a las 14:00"); el pedido queda en el estado nuevo `programado` (fuera de cocina,
-- fuera de KPIs, visible en la pestana "Programados" del panel) y pasa solo a `pending` cuando falta poco
-- para la hora indicada. Sin crons nuevos (decision de costo): la promocion corre cuando el panel consulta
-- los pedidos y por un endpoint interno documentado (apps/api, /internal/restaurantes/promover-programados).
--
-- Piezas (interno 034, prefijo de supabase/migrations 20240101000239):
--
--   1. `restaurantes.orders`: columnas `programado_para` (hora para la que se pidio, timestamptz: el instante
--      absoluto, la zona del negocio solo importa al validar horario y al mostrarlo) y `promovido_at`
--      (cuando se promovio a `pending`); estado nuevo `programado` en `orders_status_check`; indice parcial.
--   2. `create_order_idempotent`: crea el pedido en `programado` cuando llega `programado_para`.
--   3. `promover_pedidos_programados`: promueve a `pending` los programados vencidos. Idempotente.
--
-- Decision de diseno: solo se AGREGAN columnas y funciones y se amplia un CHECK; nada se elimina. El codigo
-- TypeScript degrada contra la base SIN migrar (SQLSTATE 42703/42883/42P01 dentro de SAVEPOINT) y nunca crea
-- un pedido "programado" contra una base vieja (la funcion vieja lo crearia inmediato): lo rechaza con 503.
--
-- Justificacion de seguridad de cada cambio (uno por uno):
--
--  * orders.programado_para / promovido_at -- columnas informativas nuevas. NO se agrega ningun GRANT ni
--    policy: heredan el GRANT de UPDATE de tabla de la migracion 007 y las policies RLS por organizacion
--    (el staff solo toca pedidos de SU organizacion; mismo nivel de confianza que ya tiene sobre `status`).
--    `anon` sigue sin ningun acceso a `orders`. Los dos CHECK nuevos acotan el dominio: un pedido
--    `programado` exige `programado_para`, y `promovido_at` solo existe si hubo programacion.
--  * orders_status_check -- se reemplaza ampliando la lista con `programado`. No cambia permisos. La maquina
--    de estados real (programado -> pending | cancelado) vive en `order-lifecycle.ts`; el CHECK solo acota
--    el dominio de valores.
--  * create_order_idempotent -- `create or replace` con la MISMA firma, `security definer`, el MISMO
--    `set search_path = restaurantes` y la MISMA guarda `auth.uid() is not null -> 42501` (solo la sesion de
--    sistema la llama). Diferencias: el INSERT incluye `programado_para`, el estado inicial es `programado`
--    cuando viene, el dedupe sin llave tambien mira pedidos `programado`, y se rechaza (22023) una hora que
--    ya paso (defensa en profundidad: la capa de aplicacion ya valida horario y rango). Los GRANT existentes
--    se conservan y se vuelve a revocar de public/anon por claridad.
--  * promover_pedidos_programados -- `security definer` con `set search_path = restaurantes, core, pg_temp`
--    y revoke de public/anon; GRANT EXECUTE solo a authenticated (el panel) y service_role. NO se otorga
--    UPDATE de columna a nadie: la unica escritura es esta funcion y solo toca `status` y `promovido_at` de
--    filas que YA estan en `programado` y vencidas. Guardas:
--      - sesion de staff (`auth.uid()` no nulo): exige membresia en `p_organization_id` (si no, 42501) y
--        NUNCA puede pasar `p_organization_id` nulo (barrido de toda la plataforma = solo sistema); ademas
--        ignora `p_now` y usa `now()` del servidor, asi un staff no puede adelantar a mano la promocion de
--        pedidos que aun no vencen (el mismo staff si puede mover un pedido a `pending` por la ruta normal).
--      - sesion de sistema (`auth.uid() is null`): `p_organization_id` nulo = todas las organizaciones (para
--        el endpoint interno con secreto); `p_now` se respeta (pruebas y reintentos deterministas).
--      - cross-tenant: el UPDATE siempre filtra por organizacion cuando viene; el barrido global solo lo
--        alcanza el sistema. Un pedido cancelado u otro estado nunca se promueve (WHERE status = 'programado').
--      - idempotencia: el WHERE exige `status = 'programado'`; dos ejecuciones (o dos requests concurrentes:
--        la segunda espera el bloqueo de fila y re-evalua el WHERE) promueven cada pedido UNA sola vez.
--      - `p_anticipacion_min` se acota a 0..1440 y el barrido de sistema a 1..1000 pedidos por llamada.

-- ---------------------------------------------------------------------------
-- 1) orders: programado_para, promovido_at y estado `programado`
-- ---------------------------------------------------------------------------
alter table restaurantes.orders
  add column if not exists programado_para timestamptz,
  add column if not exists promovido_at timestamptz;

alter table restaurantes.orders drop constraint if exists orders_status_check;
alter table restaurantes.orders
  add constraint orders_status_check
  check (status in ('pending', 'preparando', 'en_camino', 'entregado', 'cancelado', 'completado', 'problema', 'listo_para_recoger', 'no_recogido', 'programado'));

alter table restaurantes.orders drop constraint if exists orders_programado_para_check;
alter table restaurantes.orders
  add constraint orders_programado_para_check check (status <> 'programado' or programado_para is not null);
alter table restaurantes.orders drop constraint if exists orders_promovido_at_check;
alter table restaurantes.orders
  add constraint orders_promovido_at_check check (promovido_at is null or programado_para is not null);

-- Solo los programados pendientes de promover (pocos): listado de la pestana y barrido de promocion.
create index if not exists orders_programados_idx on restaurantes.orders (organization_id, programado_para) where status = 'programado';

-- ---------------------------------------------------------------------------
-- 2) create_order_idempotent: estado inicial `programado`
-- ---------------------------------------------------------------------------
create or replace function restaurantes.create_order_idempotent(
  p_order jsonb,
  p_dedupe_fingerprint text,
  p_idempotency_key text default null
) returns jsonb
language plpgsql
security definer
set search_path = restaurantes
as $$
declare
  v_order restaurantes.orders;
  v_organization_id uuid := (p_order->>'organization_id')::uuid;
  v_customer_id uuid := (p_order->>'customer_id')::uuid;
  v_programado_para timestamptz := nullif(p_order->>'programado_para', '')::timestamptz;
begin
  if auth.uid() is not null then
    raise exception 'create_order_idempotent es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_dedupe_fingerprint !~ '^[0-9a-f]{64}$'
     or (p_idempotency_key is not null and p_idempotency_key !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid idempotency input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    v_organization_id::text || ':' || coalesce(p_idempotency_key, p_dedupe_fingerprint),
    0
  ));

  if p_idempotency_key is not null then
    select * into v_order from restaurantes.orders
    where organization_id = v_organization_id and idempotency_key = p_idempotency_key
    limit 1;
    if v_order.id is not null and v_order.dedupe_fingerprint is distinct from p_dedupe_fingerprint then
      raise sqlstate 'PT409' using message = 'idempotency key was already used with a different order payload';
    end if;
  else
    select * into v_order from restaurantes.orders
    where organization_id = v_organization_id
      and dedupe_fingerprint = p_dedupe_fingerprint
      and status in ('pending', 'programado')
      and created_at >= now() - interval '5 minutes'
    order by created_at desc
    limit 1;
  end if;

  if v_order.id is not null then return to_jsonb(v_order); end if;

  if v_programado_para is not null and v_programado_para <= now() then
    raise exception 'programado_para debe ser una hora futura' using errcode = '22023';
  end if;

  insert into restaurantes.orders(
    customer_name, customer_phone, customer_address, customer_email, customer_id,
    organization_id, branch, property_id, total, status, items, source,
    call_transcript, call_recording_url, notes, payment_method,
    dedupe_fingerprint, idempotency_key, canal, propina, hora_recogida, programado_para
  ) values (
    p_order->>'customer_name', p_order->>'customer_phone', nullif(p_order->>'customer_address', ''), nullif(p_order->>'customer_email', ''), v_customer_id,
    v_organization_id, p_order->>'branch', (p_order->>'property_id')::uuid,
    (p_order->>'total')::numeric, case when v_programado_para is not null then 'programado' else 'pending' end, p_order->'items', p_order->>'source',
    nullif(p_order->>'call_transcript', ''), nullif(p_order->>'call_recording_url', ''),
    nullif(p_order->>'notes', ''), nullif(p_order->>'payment_method', ''),
    p_dedupe_fingerprint, p_idempotency_key,
    nullif(p_order->>'canal', ''), nullif(p_order->>'propina', '')::numeric, nullif(p_order->>'hora_recogida', '')::timestamptz, v_programado_para
  ) returning * into v_order;

  update restaurantes.customers
  set order_count = order_count + 1, last_order_at = now()
  where id = v_customer_id and organization_id = v_organization_id;

  return to_jsonb(v_order);
end;
$$;

revoke all on function restaurantes.create_order_idempotent(jsonb, text, text) from public, anon;

-- ---------------------------------------------------------------------------
-- 3) promover_pedidos_programados
-- ---------------------------------------------------------------------------
create or replace function restaurantes.promover_pedidos_programados(
  p_organization_id uuid,
  p_now timestamptz default null,
  p_anticipacion_min integer default 30,
  p_property_ids uuid[] default null
) returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_es_sistema boolean := auth.uid() is null;
  v_now timestamptz;
  v_anticipacion integer := least(greatest(coalesce(p_anticipacion_min, 30), 0), 1440);
  v_promovidos jsonb;
begin
  if not v_es_sistema then
    if p_organization_id is null
       or not exists (
         select 1 from core.membership m
         where m.organization_id = p_organization_id and m.user_id = auth.uid()
       ) then
      raise exception 'promover_pedidos_programados: sin acceso a esta organización' using errcode = '42501';
    end if;
    v_now := now();
  else
    v_now := coalesce(p_now, now());
  end if;

  with candidatos as (
    select o.id
    from restaurantes.orders o
    where o.status = 'programado'
      and (p_organization_id is null or o.organization_id = p_organization_id)
      and (p_property_ids is null or o.property_id = any (p_property_ids))
      and o.programado_para <= v_now + make_interval(mins => v_anticipacion)
    order by o.programado_para
    limit 1000
    for update skip locked
  ),
  promovidos as (
    update restaurantes.orders o
    set status = 'pending', promovido_at = v_now
    from candidatos c
    where o.id = c.id and o.status = 'programado'
    returning o.*
  )
  select coalesce(jsonb_agg(to_jsonb(p) order by p.programado_para), '[]'::jsonb) into v_promovidos from promovidos p;

  return v_promovidos;
end;
$$;

revoke all on function restaurantes.promover_pedidos_programados(uuid, timestamptz, integer, uuid[]) from public, anon;
grant execute on function restaurantes.promover_pedidos_programados(uuid, timestamptz, integer, uuid[]) to authenticated, service_role;
