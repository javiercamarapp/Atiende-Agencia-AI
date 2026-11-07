-- Analitica del dueno (F7): PRODUCTOS, MARGEN y COMBOS, mas el gancho determinista de sugerencia de combo para el agente.
-- Prefijo de supabase/migrations: 20240101000461 (interno restaurantes 161).
-- Requiere: 081 (cfo_resolver_sucursales, cfo_validar_rango, cfo_pedidos_base, cfo_renglones), 083 (cfo_cap_escritura), 027/031/038 (promotions) y 160.
--
-- Que agrega:
--   1. restaurantes.producto_costo (TABLA) -- costo unitario por producto, capturado por owner/admin de toda la organizacion. Sin costo no hay margen (nunca se estima).
--   2. restaurantes.analitica_costo_producto_guardar(...) -- unica puerta de escritura (upsert / borrar con costo nulo).
--   3. restaurantes.analitica_combos_vigentes(...)       -- INTERNA. Promociones de cortesia (el «combo» del menu) vigentes en una sucursal, canal y momento.
--   4. restaurantes.analitica_productos(...)             -- PUBLICA. jsonb: mas vendidos con margen (si hay costo) y pares frecuentes con soporte, confianza, lift
--                                                            y bandera `en_menu` (existe una promocion de cortesia vigente que los une) o «no existe como combo».
--   5. restaurantes.analitica_combo_sugerir(...)         -- SOLO SISTEMA. Dado el borrador (ids de producto), devuelve la UNICA sugerencia permitida o null.
--
-- SEGURIDAD:
--   * producto_costo: RLS activado SIN politicas para authenticated y revoke total => la tabla solo se toca por las funciones definer. Cross-tenant: cada
--     funcion filtra por organization_id y valida que el producto sea de esa organizacion.
--   * analitica_costo_producto_guardar: solo usuario (auth.uid() no nulo) owner/admin SIN acotar a sucursales (cfo_cap_escritura con sucursal nula);
--     un admin acotado, staff, repartidor, anon y sistema reciben 42501.
--   * analitica_productos: misma doble puerta que el CFO (cfo_resolver_sucursales). Sin PII: solo ids de producto, nombres de menu y agregados.
--   * analitica_combo_sugerir: auth.uid() debe ser nulo (42501 si no); valida que la sucursal sea de la organizacion declarada.
--   * analitica_combos_vigentes: sin GRANT (la llaman las dos funciones de arriba, que ya validaron el alcance).
--
-- DEFINICIONES:
--   * Margen = ingreso (precio x cantidad del renglon) - unidades x costo unitario. Solo cuando el producto tiene costo; si no, margen nulo ("sin costo registrado").
--     El ingreso es antes de descuentos de pedido (igual que cfo_productos).
--   * Par = dos productos distintos en el MISMO pedido de venta (un producto repetido cuenta una vez). soporte = juntos / pedidos de la sucursal;
--     confianza A->B = juntos / pedidos con A; lift = juntos x pedidos / (pedidos con A x pedidos con B). Un par con menos de p_min_juntos pedidos no se lista.
--   * COMBO (lo que el agente puede ofrecer) = promocion tipo 'cortesia' activa y vigente (fechas, dia de la semana, ventana horaria en la hora local de la
--     sucursal, canal, sucursal, tope de usos) con producto disparador (product_ids) y producto de cortesia (courtesy_product_ids). Nada mas es un combo:
--     una afinidad alta SIN promocion se reporta como oportunidad, jamas se sugiere en la conversacion.
--
-- Compatibilidad con la base SIN migrar: todo es nuevo (42883 / 42P01 los degrada el TypeScript con SAVEPOINT). Idempotente.
-- REVERSA: drop function if exists restaurantes.analitica_combo_sugerir(uuid, uuid, text[], text, timestamptz);
--          drop function if exists restaurantes.analitica_productos(uuid, uuid[], date, date, integer, integer);
--          drop function if exists restaurantes.analitica_combos_vigentes(uuid, uuid, text, timestamptz);
--          drop function if exists restaurantes.analitica_costo_producto_guardar(uuid, uuid, numeric);
--          drop table if exists restaurantes.producto_costo;

-- ---------------------------------------------------------------------------
-- 1) producto_costo
-- ---------------------------------------------------------------------------
create table if not exists restaurantes.producto_costo (
  organization_id uuid not null references core.organization(id) on delete cascade,
  product_id uuid not null references restaurantes.products(id) on delete cascade,
  costo numeric(10, 2) not null check (costo >= 0 and costo <= 100000),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, product_id)
);
alter table restaurantes.producto_costo enable row level security;
-- Sin politicas y sin GRANT: ningun rol de la API lee ni escribe la tabla directo (las funciones definer son la unica puerta).
revoke all on restaurantes.producto_costo from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) analitica_costo_producto_guardar
-- ---------------------------------------------------------------------------
create or replace function restaurantes.analitica_costo_producto_guardar(p_org uuid, p_product_id uuid, p_costo numeric)
returns void
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  perform restaurantes.cfo_cap_escritura(p_org, null);
  if p_product_id is null or not exists (select 1 from restaurantes.products pr where pr.id = p_product_id and pr.organization_id = p_org) then
    raise exception 'analitica_costo_producto_guardar: producto invalido' using errcode = '22023';
  end if;
  if p_costo is null then
    delete from restaurantes.producto_costo c where c.organization_id = p_org and c.product_id = p_product_id;
    return;
  end if;
  if p_costo < 0 or p_costo > 100000 then
    raise exception 'analitica_costo_producto_guardar: costo fuera de rango' using errcode = '22023';
  end if;
  insert into restaurantes.producto_costo (organization_id, product_id, costo, updated_by, updated_at)
  values (p_org, p_product_id, round(p_costo, 2), auth.uid(), now())
  on conflict (organization_id, product_id) do update set costo = excluded.costo, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end;
$$;
revoke all on function restaurantes.analitica_costo_producto_guardar(uuid, uuid, numeric) from public, anon;
grant execute on function restaurantes.analitica_costo_producto_guardar(uuid, uuid, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) analitica_combos_vigentes (interna)
-- ---------------------------------------------------------------------------
-- p_canal: 'domicilio' | 'recoger' | null (null = sin filtrar canal). La hora local es la de la sucursal (voz_zona_horaria). days_of_week: 0 = domingo.
create or replace function restaurantes.analitica_combos_vigentes(p_org uuid, p_prop uuid, p_canal text, p_ahora timestamptz)
returns table (promotion_id uuid, code text, name text, product_ids uuid[], courtesy_product_ids uuid[], auto_apply boolean)
language sql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
  with loc as (
    select (p_ahora at time zone restaurantes.voz_zona_horaria(p_prop)) as t
  )
  select pm.id, pm.code, pm.name, pm.product_ids, pm.courtesy_product_ids, pm.auto_apply
    from restaurantes.promotions pm, loc
   where pm.organization_id = p_org
     and pm.type = 'cortesia'
     and pm.is_active
     and pm.product_ids is not null
     and pm.courtesy_product_ids is not null
     and (pm.starts_at is null or pm.starts_at <= p_ahora)
     and (pm.ends_at is null or pm.ends_at >= p_ahora)
     and (pm.days_of_week is null or extract(dow from loc.t)::smallint = any (pm.days_of_week))
     and (pm.start_time is null or pm.end_time is null
          or (pm.start_time <= pm.end_time and loc.t::time >= pm.start_time and loc.t::time <= pm.end_time)
          or (pm.start_time > pm.end_time and (loc.t::time >= pm.start_time or loc.t::time <= pm.end_time)))
     and (pm.max_uses is null or pm.times_used < pm.max_uses)
     and (pm.property_ids is null or p_prop = any (pm.property_ids))
     and (pm.channels is null or p_canal is null or p_canal = any (pm.channels));
$$;
revoke all on function restaurantes.analitica_combos_vigentes(uuid, uuid, text, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) analitica_productos
-- ---------------------------------------------------------------------------
-- jsonb:
--   { "productos": [ {property_id, producto_ref, nombre, categoria, unidades, ingreso_centavos, pedidos, costo_unitario_centavos|null, margen_centavos|null} ],
--     "pares":     [ {property_id, producto_a, producto_b, nombre_a, nombre_b, juntos, pedidos_a, pedidos_b, pedidos_total, en_menu, promocion_codigo|null} ],
--     "costos_cargados": n }
-- productos: top p_limite POR SUCURSAL por unidades (empate por ingreso y ref). pares: top p_limite_pares POR SUCURSAL con juntos >= p_min_juntos.
create or replace function restaurantes.analitica_productos(p_org uuid, p_props uuid[], p_desde date, p_hasta date, p_limite integer default 30, p_min_juntos integer default 5)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_props uuid[];
  v_out jsonb;
  v_ahora timestamptz := now();
begin
  v_props := restaurantes.cfo_resolver_sucursales(p_org, p_props);
  perform restaurantes.cfo_validar_rango(p_desde, p_hasta);
  if p_limite is null or p_limite < 1 or p_limite > 200 or p_min_juntos is null or p_min_juntos < 1 or p_min_juntos > 1000 then
    raise exception 'analitica_productos: limite o minimo invalido' using errcode = '22023';
  end if;

  with b as materialized (
    select x.order_id, x.property_id from restaurantes.cfo_pedidos_base(p_org, v_props, p_desde, p_hasta) x where x.es_venta
  ),
  r as materialized (
    select b.order_id, b.property_id, y.producto_ref, y.nombre, y.precio, y.cantidad
      from b
      join restaurantes.orders o on o.id = b.order_id and o.organization_id = p_org
      cross join lateral restaurantes.cfo_renglones(o.items) y
     where y.producto_ref is not null
  ),
  prod as (
    select r.property_id, r.producto_ref, coalesce(max(pr.name), max(r.nombre)) as nombre, coalesce(max(c.name), '(sin categoría)') as categoria,
           sum(r.cantidad)::bigint as unidades, sum(round(r.precio * r.cantidad * 100))::bigint as ingreso, count(distinct r.order_id) as pedidos,
           max(round(pc.costo * 100))::bigint as costo_unit
      from r
      left join restaurantes.products pr on pr.organization_id = p_org and lower(pr.id::text) = lower(r.producto_ref)
      left join restaurantes.categories c on c.id = pr.category_id
      left join restaurantes.producto_costo pc on pc.organization_id = p_org and pc.product_id = pr.id
     group by r.property_id, r.producto_ref
  ),
  prod_top as (
    select * from (
      select p.*, row_number() over (partition by p.property_id order by p.unidades desc, p.ingreso desc, p.producto_ref) as rn from prod p
    ) t where t.rn <= p_limite
  ),
  ped as (
    select r.order_id, r.property_id, array_agg(distinct r.producto_ref order by r.producto_ref) as refs from r group by 1, 2
  ),
  tot as (select p.property_id, count(*) as n from ped p group by 1),
  cnt as (
    select p.property_id, u.ref, count(*) as n from ped p cross join lateral unnest(p.refs) as u(ref) group by 1, 2
  ),
  pares_all as (
    select p.property_id, a.ref as ref_a, c.ref as ref_b, count(*) as juntos
      from ped p
      cross join lateral unnest(p.refs) with ordinality as a(ref, ia)
      cross join lateral unnest(p.refs) with ordinality as c(ref, ic)
     where a.ia < c.ic
     group by 1, 2, 3
    having count(*) >= p_min_juntos
  ),
  pares_top as (
    select * from (
      select pa.*, row_number() over (partition by pa.property_id order by pa.juntos desc, pa.ref_a, pa.ref_b) as rn from pares_all pa
    ) t where t.rn <= p_limite
  ),
  pares as (
    select pt.property_id, pt.ref_a, pt.ref_b, pt.juntos, ca.n as na, cb.n as nb, tt.n as total,
           (select coalesce(max(pr.name), pt.ref_a) from restaurantes.products pr where pr.organization_id = p_org and lower(pr.id::text) = lower(pt.ref_a)) as nombre_a,
           (select coalesce(max(pr.name), pt.ref_b) from restaurantes.products pr where pr.organization_id = p_org and lower(pr.id::text) = lower(pt.ref_b)) as nombre_b,
           (select cv.code from restaurantes.analitica_combos_vigentes(p_org, pt.property_id, null, v_ahora) cv
             where (lower(pt.ref_a) = any (select lower(u::text) from unnest(cv.product_ids) u) and lower(pt.ref_b) = any (select lower(u::text) from unnest(cv.courtesy_product_ids) u))
                or (lower(pt.ref_b) = any (select lower(u::text) from unnest(cv.product_ids) u) and lower(pt.ref_a) = any (select lower(u::text) from unnest(cv.courtesy_product_ids) u))
             order by cv.code limit 1) as promocion
      from pares_top pt
      join cnt ca on ca.property_id = pt.property_id and ca.ref = pt.ref_a
      join cnt cb on cb.property_id = pt.property_id and cb.ref = pt.ref_b
      join tot tt on tt.property_id = pt.property_id
  )
  select jsonb_build_object(
    'productos', coalesce((select jsonb_agg(jsonb_build_object('property_id', t.property_id, 'producto_ref', t.producto_ref, 'nombre', t.nombre, 'categoria', t.categoria,
                                                             'unidades', t.unidades, 'ingreso_centavos', t.ingreso, 'pedidos', t.pedidos,
                                                             'costo_unitario_centavos', t.costo_unit,
                                                             'margen_centavos', case when t.costo_unit is null then null else t.ingreso - t.unidades * t.costo_unit end)
                                            order by t.property_id, t.rn) from prod_top t), '[]'::jsonb),
    'pares', coalesce((select jsonb_agg(jsonb_build_object('property_id', q.property_id, 'producto_a', q.ref_a, 'producto_b', q.ref_b, 'nombre_a', q.nombre_a, 'nombre_b', q.nombre_b,
                                                         'juntos', q.juntos, 'pedidos_a', q.na, 'pedidos_b', q.nb, 'pedidos_total', q.total,
                                                         'en_menu', (q.promocion is not null), 'promocion_codigo', q.promocion)
                                        order by q.property_id, q.juntos desc, q.ref_a, q.ref_b) from pares q), '[]'::jsonb),
    'costos_cargados', (select count(*) from restaurantes.producto_costo pc where pc.organization_id = p_org)
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function restaurantes.analitica_productos(uuid, uuid[], date, date, integer, integer) from public, anon;
grant execute on function restaurantes.analitica_productos(uuid, uuid[], date, date, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) analitica_combo_sugerir (solo sistema)
-- ---------------------------------------------------------------------------
-- Entrada: ids de producto del borrador (texto, uuid). Salida jsonb:
--   { "sugerencia": null | {promocion_codigo, promocion_nombre, producto_id, producto_nombre}, "motivo": 'ok'|'sin_borrador'|'sin_combo_vigente'|'ya_incluido'|'agotado' }
-- Regla: solo una promocion de cortesia VIGENTE cuyo disparador este en el borrador; el producto sugerido es el de cortesia que no este ya en el borrador y que
-- este disponible en la sucursal (branch_products y products). Orden determinista: codigo de promocion, luego id de producto. NO devuelve precios ni descuentos:
-- el monto lo da cotizar_pedido y el agente no lo menciona sin esa respuesta.
create or replace function restaurantes.analitica_combo_sugerir(p_org uuid, p_prop uuid, p_refs text[], p_canal text, p_ahora timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_refs text[];
  v_ahora timestamptz := coalesce(p_ahora, now());
  v_hay_combo boolean := false;
  v_hay_incluido boolean := false;
  r record;
begin
  if auth.uid() is not null then
    raise exception 'analitica_combo_sugerir es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if not exists (select 1 from core.property p where p.id = p_prop and p.organization_id = p_org) then
    raise exception 'analitica_combo_sugerir: sucursal ajena a la organizacion' using errcode = '42501';
  end if;
  if p_canal is not null and p_canal not in ('domicilio', 'recoger') then
    raise exception 'analitica_combo_sugerir: canal invalido' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct lower(btrim(x))), '{}'::text[]) into v_refs from unnest(coalesce(p_refs, '{}'::text[])) as x where x is not null and btrim(x) <> '';
  if cardinality(v_refs) = 0 then
    return jsonb_build_object('sugerencia', null, 'motivo', 'sin_borrador');
  end if;

  for r in
    select cv.code, cv.name, u.pid as courtesy_id
      from restaurantes.analitica_combos_vigentes(p_org, p_prop, p_canal, v_ahora) cv
      cross join lateral unnest(cv.courtesy_product_ids) as u(pid)
     where exists (select 1 from unnest(cv.product_ids) d where lower(d::text) = any (v_refs))
     order by cv.code, u.pid
  loop
    v_hay_combo := true;
    if lower(r.courtesy_id::text) = any (v_refs) then
      v_hay_incluido := true;
      continue;
    end if;
    if exists (
      select 1 from restaurantes.products pr
        join restaurantes.branch_products bp on bp.product_id = pr.id and bp.property_id = p_prop
       where pr.id = r.courtesy_id and pr.organization_id = p_org and pr.is_available and bp.is_available
    ) then
      return jsonb_build_object(
        'sugerencia', jsonb_build_object('promocion_codigo', r.code, 'promocion_nombre', r.name, 'producto_id', r.courtesy_id,
                                         'producto_nombre', (select pr.name from restaurantes.products pr where pr.id = r.courtesy_id)),
        'motivo', 'ok');
    end if;
  end loop;

  return jsonb_build_object('sugerencia', null, 'motivo',
    case when not v_hay_combo then 'sin_combo_vigente' when v_hay_incluido then 'ya_incluido' else 'agotado' end);
end;
$$;
revoke all on function restaurantes.analitica_combo_sugerir(uuid, uuid, text[], text, timestamptz) from public, anon;
grant execute on function restaurantes.analitica_combo_sugerir(uuid, uuid, text[], text, timestamptz) to authenticated;
