-- Fixtures + assertions que verifican, contra Postgres REAL (RLS + GRANT reales, no el repositorio en
-- memoria), las dos piezas de SQL de "Chatea con tus datos":
--
--  A) Las 10 consultas de SOLO LECTURA del catalogo de restaurantes
--     (packages/domain-restaurantes/src/data-chat/sql.ts -- el texto se copia IDENTICO aqui y
--     tests/data-chat/sql-drift.spec.ts falla si divergen), ejecutadas como el rol `authenticated`
--     con auth.uid() real:
--       1. cross-tenant: un owner de la Org B pidiendo la Org A (y al reves) no ve ni una fila.
--       2. cross-sucursal: un gerente con membership acotada a UNA sucursal solo ve esa -- incluso
--          si la aplicacion se equivocara y pasara `null` (todas) o el id de otra sucursal, el JOIN con
--          core.property (RLS has_property_access) lo impide: defensa en profundidad.
--       3. zona horaria America/Merida: un pedido de las 20:30 locales (02:30 UTC del dia siguiente)
--          cae en el dia local correcto y en la hora 20, no en la 2.
--       4. cancelados fuera de ventas; items jsonb malformados no rompen la consulta; clientes
--          recurrentes sin devolver nombre ni telefono; promociones inactivas de otra org invisibles.
--       5. anon no puede leer nada.
--  B) core.data_chat_query_log / core.record_data_chat_query (migracion 0029): actor = auth.uid(),
--     cross-tenant rechazado, sesion de sistema y anon rechazados, lectura solo owner/admin de la
--     organizacion, deny-by-default de INSERT directo, append-only (UPDATE/DELETE bloqueados),
--     CHECKs de forma, vertical tomada de la organizacion.
--  C) Base SIN migrar (REGLA DURA): con la funcion/tabla eliminada DENTRO de la transaccion, el SQL
--     real falla con 42883/42P01 y SAVEPOINT + ROLLBACK TO SAVEPOINT (el mismo mecanismo que
--     runWithSavepointFallback) deja la transaccion utilizable.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): `as should_fail` = debe
-- terminar en ERROR; alias `..._deberia_ser_N` = esa consulta devuelve N; un bloque DO que lanza
-- excepcion ante una discrepancia = debe completar sin error. Cada escenario va en su `begin; ...
-- rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000d001', 'restaurantes', 'Org A (data chat)', 'org-a-data-chat'),
  ('00000000-0000-0000-0000-00000000d002', 'restaurantes', 'Org B (data chat, ajena)', 'org-b-data-chat')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000041', 'owner-a-datachat@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-000000000042', 'gerente-a-datachat@example.com', 'Gerente Centro A', 'seed'),
  ('00000000-0000-0000-0000-000000000043', 'owner-b-datachat@example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-000000000044', 'admin-a-datachat@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-000000000045', 'member-a-datachat@example.com', 'Member A', 'seed')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000d001', 'restaurantes', 'Centro'),
  ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-00000000d001', 'restaurantes', 'Norte'),
  ('00000000-0000-0000-0000-00000000e003', '00000000-0000-0000-0000-00000000d002', 'restaurantes', 'Centro B')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, slug, organization_id, display_order) values
  ('00000000-0000-0000-0000-00000000e001', 'centro', '00000000-0000-0000-0000-00000000d001', 1),
  ('00000000-0000-0000-0000-00000000e002', 'norte', '00000000-0000-0000-0000-00000000d001', 2),
  ('00000000-0000-0000-0000-00000000e003', 'centro', '00000000-0000-0000-0000-00000000d002', 1)
on conflict do nothing;

-- owner A y admin A: todas las sucursales. gerente: SOLO Centro. member A: platform_role 'member' (no lee la bitacora).
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000041', '00000000-0000-0000-0000-00000000d001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-000000000044', '00000000-0000-0000-0000-00000000d001', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000000042', '00000000-0000-0000-0000-00000000d001', array['00000000-0000-0000-0000-00000000e001']::uuid[], 'member', 'staff'),
  ('00000000-0000-0000-0000-000000000045', '00000000-0000-0000-0000-00000000d001', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-000000000043', '00000000-0000-0000-0000-00000000d002', null, 'owner', 'owner')
on conflict do nothing;

-- Pedidos (ventana de los escenarios: 29-sep-2026 hora de Merida = 2026-09-29T06:00Z .. 2026-09-30T06:00Z):
--  o1 Centro  100 whatsapp 12:00 local   · o2 Centro 200 voice 20:30 local (02:30 UTC del 30!) · o3 Centro 50 CANCELADO
--  o4 Norte   300 web 14:00 local        · o5 Norte  400 whatsapp 15:00 local
--  o6 Norte    80 web, 20-sep (ANTES de la ventana; cliente ...02 vuelve a pedir el 29 => recurrente)
--  o7 Centro B 9999 (otro tenant)
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at) values
  ('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000e001', 'Cliente Uno', '9990000001', 100.00, 'completado', '[{"id":"p1","name":"Taco de cochinita","price":25,"quantity":4}]', 'whatsapp', '2026-09-29T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f0002', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000e001', 'Cliente Uno', '9990000001', 200.00, 'completado', '[{"id":"p2","name":"Panucho","price":20,"quantity":10},{"id":"p9","name":"Raro","price":10,"quantity":"abc"}]', 'voice', '2026-09-30T02:30:00Z'),
  ('00000000-0000-0000-0000-0000000f0003', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000e001', 'Cliente Cuatro', '9990000004', 50.00, 'cancelado', '[{"id":"p1","name":"Taco de cochinita","price":25,"quantity":2}]', 'whatsapp', '2026-09-29T19:00:00Z'),
  ('00000000-0000-0000-0000-0000000f0004', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000e002', 'Cliente Dos', '9990000002', 300.00, 'completado', '[{"id":"p1","name":"Taco de cochinita","price":25,"quantity":8},{"id":"p2","name":"Panucho","price":20,"quantity":5}]', 'web', '2026-09-29T20:00:00Z'),
  ('00000000-0000-0000-0000-0000000f0005', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000e002', 'Cliente Tres', '9990000003', 400.00, 'completado', '[{"id":"p3","name":"Cochinita pibil","price":100,"quantity":4}]', 'whatsapp', '2026-09-29T21:00:00Z'),
  ('00000000-0000-0000-0000-0000000f0006', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000e002', 'Cliente Dos', '9990000002', 80.00, 'completado', '[{"id":"p1","name":"Taco de cochinita","price":25,"quantity":3}]', 'web', '2026-09-20T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f0007', '00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-00000000e003', 'Cliente Nueve', '9990000009', 9999.00, 'completado', '[{"id":"p7","name":"Secreto de B","price":9999,"quantity":1}]', 'whatsapp', '2026-09-29T18:00:00Z')
on conflict do nothing;

insert into restaurantes.promotions (organization_id, code, name, type, value, is_active, times_used) values
  ('00000000-0000-0000-0000-00000000d001', 'BIENVENIDA10', 'Bienvenida', 'percentage', 10, true, 33),
  ('00000000-0000-0000-0000-00000000d001', 'INACTIVA50', 'Inactiva A', 'fixed', 50, false, 4),
  ('00000000-0000-0000-0000-00000000d002', 'BIENVENIDA10', 'Bienvenida B', 'percentage', 15, true, 1)
on conflict do nothing;

-- Fila de bitacora sembrada como superusuario (la funcion exige auth.uid() no nulo).
insert into core.data_chat_query_log (id, organization_id, user_id, vertical, tool, params, outcome, row_count, duration_ms) values
  ('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-000000000041', 'restaurantes', 'ventas_por_dia', '{"periodo":"hoy"}', 'ok', 2, 12)
on conflict do nothing;

\echo ''
\echo '=== A) consultas de solo lectura del catalogo de restaurantes ==='
\echo ''
\echo '--- 1. owner A (todas las sucursales): ventas por dia en Merida -> UN solo dia local (29-sep) con 4 pedidos y $1000; el cancelado NO cuenta y el pedido de las 02:30 UTC del 30 cae el 29 local ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
do $do$
declare r record; n_rows int := 0; tot numeric := 0; ords bigint := 0; b text;
begin
  for r in execute $q$select to_char(date_trunc($7::text, coalesce(o.promovido_at, o.created_at) at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(o.total), 0) as revenue, count(*) as orders
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'day'::text loop
    n_rows := n_rows + 1;
    b := r.bucket; tot := tot + r.revenue; ords := ords + r.orders;
  end loop;
  if not (n_rows = 1 and b = '2026-09-29' and tot = 1000 and ords = 4) then raise exception 'esperaba 1 dia 2026-09-29 / 1000 / 4 pedidos, obtuve % dias, % , %, %', n_rows, b, tot, ords; end if;
end $do$;
rollback;
\echo '--- 2. gerente de Centro con ids correctos: 2 pedidos, $300 (solo su sucursal) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000042', true);
do $do$
declare r record; n_rows int := 0; tot numeric := 0; ords bigint := 0;
begin
  for r in execute $q$select to_char(date_trunc($7::text, coalesce(o.promovido_at, o.created_at) at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(o.total), 0) as revenue, count(*) as orders
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, array['00000000-0000-0000-0000-00000000e001'::uuid]::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'day'::text loop
    n_rows := n_rows + 1;
    tot := tot + r.revenue; ords := ords + r.orders;
  end loop;
  if not (tot = 300 and ords = 2) then raise exception 'esperaba 300 / 2, obtuve % / %', tot, ords; end if;
end $do$;
rollback;
\echo '--- 3. gerente de Centro y la aplicacion se equivoca pasando null (todas): RLS de core.property lo limita igual a Centro (defensa en profundidad) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000042', true);
do $do$
declare r record; n_rows int := 0; tot numeric := 0; ords bigint := 0;
begin
  for r in execute $q$select to_char(date_trunc($7::text, coalesce(o.promovido_at, o.created_at) at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(o.total), 0) as revenue, count(*) as orders
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'day'::text loop
    n_rows := n_rows + 1;
    tot := tot + r.revenue; ords := ords + r.orders;
  end loop;
  if not (tot = 300 and ords = 2) then raise exception 'RLS no limito al gerente: obtuve % / %', tot, ords; end if;
end $do$;
rollback;
\echo '--- 4. gerente de Centro pide el id de Norte (forjado): 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000042', true);
do $do$
declare r record; n_rows int := 0;
begin
  for r in execute $q$select to_char(date_trunc($7::text, coalesce(o.promovido_at, o.created_at) at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(o.total), 0) as revenue, count(*) as orders
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, array['00000000-0000-0000-0000-00000000e002'::uuid]::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'day'::text loop
    n_rows := n_rows + 1;
    null;
  end loop;
  if not (n_rows = 0) then raise exception 'el gerente vio % filas de Norte', n_rows; end if;
end $do$;
rollback;
\echo '--- 5. cross-tenant: owner de la Org B pide la Org A -> 0 filas en TODAS las consultas de pedidos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000043', true);
do $do$
declare r record; n_rows int := 0;
begin
  for r in execute $q$select to_char(date_trunc($7::text, coalesce(o.promovido_at, o.created_at) at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(o.total), 0) as revenue, count(*) as orders
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'day'::text loop
    n_rows := n_rows + 1;
    null;
  end loop;
  if not (n_rows = 0) then raise exception 'SQL_SALES_BY_PERIOD: owner B vio % filas de la Org A', n_rows; end if;
end $do$;
do $do$
declare r record; n_rows int := 0;
begin
  for r in execute $q$select p.name as branch, coalesce(sum(o.total), 0) as revenue, count(*) as orders
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  group by p.id, p.name order by revenue desc, p.name limit $5$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 51::int loop
    n_rows := n_rows + 1;
    null;
  end loop;
  if not (n_rows = 0) then raise exception 'SQL_SALES_BY_BRANCH: owner B vio % filas de la Org A', n_rows; end if;
end $do$;
do $do$
declare r record; n_rows int := 0;
begin
  for r in execute $q$select it->>'name' as product,
    coalesce(sum((it->>'quantity')::numeric), 0) as quantity,
    coalesce(sum((it->>'quantity')::numeric * (it->>'price')::numeric), 0) as revenue
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) as it
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
    and (it->>'quantity') ~ '^[0-9]+(\.[0-9]+)?$' and (it->>'price') ~ '^[0-9]+(\.[0-9]+)?$' and (it->>'name') is not null
  group by 1 order by quantity desc, 1 limit $5$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 51::int loop
    n_rows := n_rows + 1;
    null;
  end loop;
  if not (n_rows = 0) then raise exception 'SQL_TOP_PRODUCTS_BY_QUANTITY: owner B vio % filas de la Org A', n_rows; end if;
end $do$;
do $do$
declare r record; n_rows int := 0;
begin
  for r in execute $q$select o.source as channel, count(*) as orders, coalesce(sum(o.total), 0) as revenue
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  group by o.source order by orders desc, o.source limit $5$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 51::int loop
    n_rows := n_rows + 1;
    null;
  end loop;
  if not (n_rows = 0) then raise exception 'SQL_ORDERS_BY_CHANNEL: owner B vio % filas de la Org A', n_rows; end if;
end $do$;
do $do$
declare r record; n_rows int := 0;
begin
  for r in execute $q$select extract(hour from (coalesce(o.promovido_at, o.created_at) at time zone $5::text))::int as hour, count(*) as orders,
    coalesce(sum(o.total), 0) as revenue
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  group by 1 order by orders desc, hour limit $6$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int loop
    n_rows := n_rows + 1;
    null;
  end loop;
  if not (n_rows = 0) then raise exception 'SQL_PEAK_HOURS: owner B vio % filas de la Org A', n_rows; end if;
end $do$;
do $do$
declare r record; n_rows int := 0; tot bigint := 0;
begin
  for r in execute $q$select count(*) filter (where o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')) as orders,
    coalesce(sum(o.total) filter (where o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')), 0) as revenue,
    count(*) filter (where o.status = 'cancelado') as cancelled
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4
  limit $5$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 51::int loop
    n_rows := n_rows + 1;
    tot := r.orders + r.cancelled;
  end loop;
  if not (tot = 0) then raise exception 'estadisticas de Org A visibles para Org B: %', tot; end if;
end $do$;
do $do$
declare r record; n_rows int := 0; c bigint := 0;
begin
  for r in execute $q$with in_period as (
    select coalesce(o.customer_id::text, o.customer_phone) as ckey, count(*) as n
    from restaurantes.orders o
    join core.property p on p.id = o.property_id
    where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
    group by 1
  ), before_period as (
    select distinct coalesce(o.customer_id::text, o.customer_phone) as ckey
    from restaurantes.orders o
    join core.property p on p.id = o.property_id
    where o.organization_id = $1 and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
      and coalesce(o.promovido_at, o.created_at) < $3 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  )
  select count(*) as customers,
    count(*) filter (where i.n >= 2 or b.ckey is not null) as recurring,
    count(*) filter (where i.n < 2 and b.ckey is null) as new_customers
  from in_period i left join before_period b on b.ckey = i.ckey
  limit $5$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 51::int loop
    n_rows := n_rows + 1;
    c := r.customers;
  end loop;
  if not (c = 0) then raise exception 'clientes de Org A visibles para Org B: %', c; end if;
end $do$;
rollback;
\echo '--- 6. cross-tenant (inverso): owner de la Org A pide la Org B -> 0 filas (y el pedido de $9999 de B jamas aparece) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
do $do$
declare r record; n_rows int := 0;
begin
  for r in execute $q$select to_char(date_trunc($7::text, coalesce(o.promovido_at, o.created_at) at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(o.total), 0) as revenue, count(*) as orders
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d002'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'day'::text loop
    n_rows := n_rows + 1;
    null;
  end loop;
  if not (n_rows = 0) then raise exception 'owner A vio % filas de la Org B', n_rows; end if;
end $do$;
do $do$
declare r record; n_rows int := 0;
begin
  for r in execute $q$select it->>'name' as product,
    coalesce(sum((it->>'quantity')::numeric), 0) as quantity,
    coalesce(sum((it->>'quantity')::numeric * (it->>'price')::numeric), 0) as revenue
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) as it
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
    and (it->>'quantity') ~ '^[0-9]+(\.[0-9]+)?$' and (it->>'price') ~ '^[0-9]+(\.[0-9]+)?$' and (it->>'name') is not null
  group by 1 order by revenue desc, 1 limit $5$q$ using '00000000-0000-0000-0000-00000000d002'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 51::int loop
    n_rows := n_rows + 1;
    null;
  end loop;
  if not (n_rows = 0) then raise exception 'owner A vio productos de B'; end if;
end $do$;
rollback;
\echo '--- 7. owner B SI ve lo suyo (el rechazo de arriba es real, no un bloqueo general): 1 pedido, $9999 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000043', true);
do $do$
declare r record; n_rows int := 0; tot numeric := 0;
begin
  for r in execute $q$select to_char(date_trunc($7::text, coalesce(o.promovido_at, o.created_at) at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(o.total), 0) as revenue, count(*) as orders
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d002'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'day'::text loop
    n_rows := n_rows + 1;
    tot := tot + r.revenue;
  end loop;
  if not (tot = 9999) then raise exception 'owner B esperaba 9999, obtuvo %', tot; end if;
end $do$;
rollback;
\echo '--- 8. sucursales visibles: gerente -> 1, owner A -> 2, owner A pidiendo la Org B -> 0 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000042', true);
do $do$
declare r record; n_rows int := 0; nombre text;
begin
  for r in execute $q$select p.id as property_id, p.name, bd.slug
   from core.property p
   join restaurantes.branch_detail bd on bd.property_id = p.id
   where p.organization_id = $1 and p.status = 'active' and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by bd.display_order asc, p.name asc
   limit 100$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[] loop
    n_rows := n_rows + 1;
    nombre := r.name;
  end loop;
  if not (n_rows = 1 and nombre = 'Centro') then raise exception 'gerente debia ver solo Centro, vio % (%)', n_rows, nombre; end if;
end $do$;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
do $do$
declare r record; n_rows int := 0;
begin
  for r in execute $q$select p.id as property_id, p.name, bd.slug
   from core.property p
   join restaurantes.branch_detail bd on bd.property_id = p.id
   where p.organization_id = $1 and p.status = 'active' and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by bd.display_order asc, p.name asc
   limit 100$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[] loop
    n_rows := n_rows + 1;
    null;
  end loop;
  if not (n_rows = 2) then raise exception 'owner A debia ver 2 sucursales, vio %', n_rows; end if;
end $do$;
do $do$
declare r record; n_rows int := 0;
begin
  for r in execute $q$select p.id as property_id, p.name, bd.slug
   from core.property p
   join restaurantes.branch_detail bd on bd.property_id = p.id
   where p.organization_id = $1 and p.status = 'active' and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by bd.display_order asc, p.name asc
   limit 100$q$ using '00000000-0000-0000-0000-00000000d002'::uuid, null::uuid[] loop
    n_rows := n_rows + 1;
    null;
  end loop;
  if not (n_rows = 0) then raise exception 'owner A vio % sucursales de la Org B', n_rows; end if;
end $do$;
rollback;
\echo '--- 9. ventas por sucursal (owner A): Norte $700 primero, Centro $300 despues ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
do $do$
declare r record; n_rows int := 0; nombres text := '';
begin
  for r in execute $q$select p.name as branch, coalesce(sum(o.total), 0) as revenue, count(*) as orders
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  group by p.id, p.name order by revenue desc, p.name limit $5$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 51::int loop
    n_rows := n_rows + 1;
    nombres := nombres || r.branch || ':' || r.revenue::text || ';';
  end loop;
  if not (nombres = 'Norte:700.00;Centro:300.00;') then raise exception 'ranking de sucursales inesperado: %', nombres; end if;
end $do$;
rollback;
\echo '--- 10. productos mas vendidos (owner A): por cantidad Panucho 15, Taco 12 (el cancelado NO cuenta), Cochinita pibil 4; la fila malformada "Raro" se ignora sin romper la consulta ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
do $do$
declare r record; n_rows int := 0; s text := '';
begin
  for r in execute $q$select it->>'name' as product,
    coalesce(sum((it->>'quantity')::numeric), 0) as quantity,
    coalesce(sum((it->>'quantity')::numeric * (it->>'price')::numeric), 0) as revenue
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) as it
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
    and (it->>'quantity') ~ '^[0-9]+(\.[0-9]+)?$' and (it->>'price') ~ '^[0-9]+(\.[0-9]+)?$' and (it->>'name') is not null
  group by 1 order by quantity desc, 1 limit $5$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 51::int loop
    n_rows := n_rows + 1;
    s := s || r.product || ':' || r.quantity::text || ';';
  end loop;
  if not (s = 'Panucho:15;Taco de cochinita:12;Cochinita pibil:4;') then raise exception 'ranking por cantidad inesperado: %', s; end if;
end $do$;
do $do$
declare r record; n_rows int := 0; first_product text;
begin
  for r in execute $q$select it->>'name' as product,
    coalesce(sum((it->>'quantity')::numeric), 0) as quantity,
    coalesce(sum((it->>'quantity')::numeric * (it->>'price')::numeric), 0) as revenue
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) as it
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
    and (it->>'quantity') ~ '^[0-9]+(\.[0-9]+)?$' and (it->>'price') ~ '^[0-9]+(\.[0-9]+)?$' and (it->>'name') is not null
  group by 1 order by revenue desc, 1 limit $5$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 51::int loop
    n_rows := n_rows + 1;
    if n_rows = 1 then first_product := r.product; end if;
  end loop;
  if not (first_product = 'Cochinita pibil') then raise exception 'el primero por ventas debia ser Cochinita pibil (400), fue %', first_product; end if;
end $do$;
rollback;
\echo '--- 11. ticket medio / estadisticas (owner A): 4 pedidos, $1000, 1 cancelado; gerente de Centro: 2 pedidos, $300, 1 cancelado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
do $do$
declare r record; n_rows int := 0; o bigint; v numeric; c bigint;
begin
  for r in execute $q$select count(*) filter (where o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')) as orders,
    coalesce(sum(o.total) filter (where o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')), 0) as revenue,
    count(*) filter (where o.status = 'cancelado') as cancelled
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4
  limit $5$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 51::int loop
    n_rows := n_rows + 1;
    o := r.orders; v := r.revenue; c := r.cancelled;
  end loop;
  if not (o = 4 and v = 1000 and c = 1) then raise exception 'estadisticas inesperadas: % / % / %', o, v, c; end if;
end $do$;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000042', true);
do $do$
declare r record; n_rows int := 0; o bigint; v numeric; c bigint;
begin
  for r in execute $q$select count(*) filter (where o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')) as orders,
    coalesce(sum(o.total) filter (where o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')), 0) as revenue,
    count(*) filter (where o.status = 'cancelado') as cancelled
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4
  limit $5$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 51::int loop
    n_rows := n_rows + 1;
    o := r.orders; v := r.revenue; c := r.cancelled;
  end loop;
  if not (o = 2 and v = 300 and c = 1) then raise exception 'estadisticas del gerente inesperadas: % / % / %', o, v, c; end if;
end $do$;
rollback;
\echo '--- 12. pedidos por canal (owner A): whatsapp 2 pedidos/$500, voice 1/$200, web 1/$300 (orden: pedidos desc, canal) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
do $do$
declare r record; n_rows int := 0; s text := '';
begin
  for r in execute $q$select o.source as channel, count(*) as orders, coalesce(sum(o.total), 0) as revenue
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  group by o.source order by orders desc, o.source limit $5$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 51::int loop
    n_rows := n_rows + 1;
    s := s || r.channel || ':' || r.orders::text || ':' || r.revenue::text || ';';
  end loop;
  if not (s = 'whatsapp:2:500.00;voice:1:200.00;web:1:300.00;') then raise exception 'canales inesperados: %', s; end if;
end $do$;
rollback;
\echo '--- 13. horas pico en zona America/Merida: 12, 14, 15 y 20 (el pedido de 02:30 UTC es la hora 20 local, NO la 2) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
do $do$
declare r record; n_rows int := 0; s text := '';
begin
  for r in execute $q$select extract(hour from (coalesce(o.promovido_at, o.created_at) at time zone $5::text))::int as hour, count(*) as orders,
    coalesce(sum(o.total), 0) as revenue
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  group by 1 order by orders desc, hour limit $6$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int loop
    n_rows := n_rows + 1;
    s := s || r.hour::text || ',';
  end loop;
  if not (s = '12,14,15,20,') then raise exception 'horas inesperadas (zona horaria mal aplicada?): %', s; end if;
end $do$;
rollback;
\echo '--- 14. clientes recurrentes (owner A): 3 clientes, 2 recurrentes (uno por 2 pedidos en el periodo, otro por pedido previo), 1 nuevo; gerente de Centro: 1 cliente recurrente ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
do $do$
declare r record; n_rows int := 0; c bigint; rc bigint; nw bigint;
begin
  for r in execute $q$with in_period as (
    select coalesce(o.customer_id::text, o.customer_phone) as ckey, count(*) as n
    from restaurantes.orders o
    join core.property p on p.id = o.property_id
    where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
    group by 1
  ), before_period as (
    select distinct coalesce(o.customer_id::text, o.customer_phone) as ckey
    from restaurantes.orders o
    join core.property p on p.id = o.property_id
    where o.organization_id = $1 and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
      and coalesce(o.promovido_at, o.created_at) < $3 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  )
  select count(*) as customers,
    count(*) filter (where i.n >= 2 or b.ckey is not null) as recurring,
    count(*) filter (where i.n < 2 and b.ckey is null) as new_customers
  from in_period i left join before_period b on b.ckey = i.ckey
  limit $5$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 51::int loop
    n_rows := n_rows + 1;
    c := r.customers; rc := r.recurring; nw := r.new_customers;
  end loop;
  if not (c = 3 and rc = 2 and nw = 1) then raise exception 'recurrentes inesperados: % / % / %', c, rc, nw; end if;
end $do$;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000042', true);
do $do$
declare r record; n_rows int := 0; c bigint; rc bigint;
begin
  for r in execute $q$with in_period as (
    select coalesce(o.customer_id::text, o.customer_phone) as ckey, count(*) as n
    from restaurantes.orders o
    join core.property p on p.id = o.property_id
    where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and coalesce(o.promovido_at, o.created_at) >= $3 and coalesce(o.promovido_at, o.created_at) < $4 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
    group by 1
  ), before_period as (
    select distinct coalesce(o.customer_id::text, o.customer_phone) as ckey
    from restaurantes.orders o
    join core.property p on p.id = o.property_id
    where o.organization_id = $1 and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
      and coalesce(o.promovido_at, o.created_at) < $3 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  )
  select count(*) as customers,
    count(*) filter (where i.n >= 2 or b.ckey is not null) as recurring,
    count(*) filter (where i.n < 2 and b.ckey is null) as new_customers
  from in_period i left join before_period b on b.ckey = i.ckey
  limit $5$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 51::int loop
    n_rows := n_rows + 1;
    c := r.customers; rc := r.recurring;
  end loop;
  if not (c = 1 and rc = 1) then raise exception 'recurrentes del gerente inesperados: % / %', c, rc; end if;
end $do$;
rollback;
\echo '--- 15. promociones: owner A ve sus 2; owner B pidiendo la Org A solo ve las ACTIVAS (politica publica del checkout), nunca la inactiva ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
do $do$
declare r record; n_rows int := 0;
begin
  for r in execute $q$select pr.code, pr.name, pr.type, pr.value, pr.is_active, pr.times_used, pr.max_uses, pr.starts_at, pr.ends_at
  from restaurantes.promotions pr
  where pr.organization_id = $1
  order by pr.is_active desc, pr.times_used desc, pr.code
  limit $2$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, 51::int loop
    n_rows := n_rows + 1;
    null;
  end loop;
  if not (n_rows = 2) then raise exception 'owner A debia ver 2 promociones, vio %', n_rows; end if;
end $do$;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000043', true);
do $do$
declare r record; n_rows int := 0; inactivas int := 0;
begin
  for r in execute $q$select pr.code, pr.name, pr.type, pr.value, pr.is_active, pr.times_used, pr.max_uses, pr.starts_at, pr.ends_at
  from restaurantes.promotions pr
  where pr.organization_id = $1
  order by pr.is_active desc, pr.times_used desc, pr.code
  limit $2$q$ using '00000000-0000-0000-0000-00000000d001'::uuid, 51::int loop
    n_rows := n_rows + 1;
    if not r.is_active then inactivas := inactivas + 1; end if;
  end loop;
  if not (inactivas = 0) then raise exception 'owner B vio % promociones inactivas de la Org A', inactivas; end if;
end $do$;
rollback;
\echo '--- 16. anon no puede leer pedidos ni sucursales (sin GRANT) ---'
begin;
set local role anon;
select count(*) as should_fail from restaurantes.orders;
rollback;
begin;
set local role anon;
select count(*) as should_fail from core.property;
rollback;
\echo ''
\echo '=== B) bitacora core.data_chat_query_log ==='
\echo ''
\echo '--- 17. owner A registra una consulta: el actor es SIEMPRE auth.uid() y la vertical sale de la organizacion (no de un parametro) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000d001'::uuid, 'ventas_por_dia', '{"periodo":"hoy"}'::jsonb, 'ok', 2, 15, null) as nuevo_id;
select (user_id = auth.uid() and vertical = 'restaurantes')::int as actor_y_vertical_correctos_deberia_ser_1 from core.data_chat_query_log where organization_id = '00000000-0000-0000-0000-00000000d001' and outcome = 'ok' and row_count = 2 and duration_ms = 15;
rollback;
\echo '--- 18. gerente (member de la Org A) tambien puede registrar sus propias consultas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000042', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000d001'::uuid, 'ventas_por_dia', '{"periodo":"hoy"}'::jsonb, 'ok', 2, 15, null) as nuevo_id;
rollback;
\echo '--- 19. cross-tenant: owner de la Org B intenta sembrar una fila en la bitacora de la Org A -> RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000043', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000d001'::uuid, 'ventas_por_dia', '{}'::jsonb, 'ok', 2, 15, null) as should_fail;
rollback;
\echo '--- 20. sesion de sistema (auth.uid() NULL) -> RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000d001'::uuid, 'ventas_por_dia', '{"periodo":"hoy"}'::jsonb, 'ok', 2, 15, null) as should_fail;
rollback;
\echo '--- 21. anon sin EXECUTE -> RECHAZADO ---'
begin;
set local role anon;
select core.record_data_chat_query('00000000-0000-0000-0000-00000000d001'::uuid, 'ventas_por_dia', '{"periodo":"hoy"}'::jsonb, 'ok', 2, 15, null) as should_fail;
rollback;
\echo '--- 22. lectura: owner A y admin A leen la bitacora de su org (1 fila sembrada); member A NO; owner B NO (cross-tenant) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
select count(*) as filas_visibles_deberia_ser_1 from core.data_chat_query_log where organization_id = '00000000-0000-0000-0000-00000000d001';
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000044', true);
select count(*) as filas_visibles_deberia_ser_1 from core.data_chat_query_log where organization_id = '00000000-0000-0000-0000-00000000d001';
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000045', true);
select count(*) as filas_visibles_deberia_ser_0 from core.data_chat_query_log where organization_id = '00000000-0000-0000-0000-00000000d001';
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000043', true);
select count(*) as filas_visibles_deberia_ser_0 from core.data_chat_query_log where organization_id = '00000000-0000-0000-0000-00000000d001';
rollback;
\echo '--- 23. INSERT directo como authenticated (saltandose la funcion) -> RECHAZADO (sin GRANT ni policy) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
insert into core.data_chat_query_log (organization_id, user_id, vertical, outcome) values ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-000000000041', 'restaurantes', 'ok') returning id as should_fail;
rollback;
\echo '--- 24. append-only: UPDATE y DELETE bloqueados incluso para el superusuario (trigger) ---'
begin;
update core.data_chat_query_log set outcome = 'error' returning id as should_fail;
rollback;
begin;
delete from core.data_chat_query_log returning id as should_fail;
rollback;
\echo '--- 25. CHECKs: outcome fuera de catalogo y params gigantes -> RECHAZADOS; un nombre de herramienta raro se normaliza a [a-z0-9_]; params no-objeto se guardan como {} ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000d001'::uuid, 'ventas_por_dia', '{"periodo":"hoy"}'::jsonb, 'hack', 2, 15, null) as should_fail;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000d001'::uuid, 'ventas_por_dia', jsonb_build_object('x', repeat('a', 2500)), 'ok', 2, 15, null) as should_fail;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000d001'::uuid, 'Ventas Por Día!', '[1,2]'::jsonb, 'ok', 2, 15, null) as nuevo_id;
select count(*)::int as normalizacion_deberia_ser_1 from core.data_chat_query_log where organization_id = '00000000-0000-0000-0000-00000000d001' and tool = 'ventas_por_d_a_' and params = '{}'::jsonb;
rollback;
\echo ''
\echo '=== C) base SIN migrar: SQLSTATE real + SAVEPOINT (mismo mecanismo que runWithSavepointFallback) ==='
\echo ''
\echo '--- 26. la herramienta de promociones con restaurantes.promotions ELIMINADA: 42P01 y la transaccion se recupera (nunca 25P02) ---'
begin;
drop table restaurantes.promotions cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
savepoint sp_verify_data_chat_read;
do $do$
declare v_state text; v_msg text;
begin
  begin
    perform * from restaurantes.promotions where organization_id = '00000000-0000-0000-0000-00000000d001' limit 51;
    raise exception 'se esperaba SQLSTATE 42P01 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42P01' then raise exception 'se esperaba 42P01, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_data_chat_read;
release savepoint sp_verify_data_chat_read;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo '--- 27. la bitacora con core.record_data_chat_query ELIMINADA (migracion 0029 pendiente): 42883 con la forma "function ... does not exist" y la transaccion se recupera ---'
begin;
drop function core.record_data_chat_query(uuid, text, jsonb, text, integer, integer, text);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
savepoint sp_verify_data_chat_log;
do $do$
declare v_state text; v_msg text;
begin
  begin
    perform core.record_data_chat_query('00000000-0000-0000-0000-00000000d001'::uuid, 'ventas_por_dia', '{}'::jsonb, 'ok', 1, 1, null);
    raise exception 'se esperaba SQLSTATE 42883 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42883' then raise exception 'se esperaba 42883, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_data_chat_log;
release savepoint sp_verify_data_chat_log;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo ''
\echo '==> los escenarios marcados should_fail deben terminar en ERROR; los deberia_ser_N en N; los bloques DO sin error = OK (una discrepancia lanza excepcion).'
