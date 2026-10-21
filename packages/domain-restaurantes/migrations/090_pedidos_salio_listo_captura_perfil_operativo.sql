-- 090 -- Panel movil del operador (PLAN-PANEL-OPERADOR §3), parte 1: columnas de tiempos, captura y cobro + perfil operativo del staff.
--
-- QUE HACE (todo aditivo e idempotente; ninguna columna existente cambia de tipo ni de regla):
--   1. restaurantes.orders: `salio_at` (cuando el pedido salio con el chofer), `listo_at` (cuando cocina lo marco listo), `capturado_por`
--      (usuario de staff que lo capturo por llamada/mostrador, sin PII), `canal_captura` (llamada | mostrador | whatsapp_manual),
--      `indicaciones_entrega` (<= 240; reemplaza exponer `notes` libre al chofer), `paga_con` y `cobrado_monto` (efectivo; >= 0).
--      La forma de pago YA existe (`payment_method`), no se duplica. `source = 'admin'` ya es un valor valido del CHECK de `source`.
--   2. Relleno unico de `salio_at` desde el primer evento `-> en_camino` de `order_status_events` (idempotente: solo filas con `salio_at` nulo).
--   3. core.membership.perfil_operativo (nullable; 'encargado' | 'cajero'). Decision de Javier: el CAJERO captura, acepta y marca preparando pero NO
--      cancela ni despacha; el ENCARGADO hace todo. Nulo = encargado (asi la base nueva se comporta como hoy hasta que alguien marque a un cajero).
--      Solo aplica a vertical_role = 'staff'; owner y admin ignoran el perfil.
--   4. restaurantes.operador_puede(org, sucursal, accion): UNICA fuente SQL de "quien puede operar", usada por las funciones de 092.
--   5. restaurantes.staff_perfil_operativo_guardar(org, usuario, perfil): unico camino para cambiar el perfil (owner/admin de alcance organizacional).
--
-- Justificacion de seguridad:
--  * Columnas de orders: heredan el GRANT UPDATE de tabla completa de la migracion 007 (no se concede nada nuevo) y ningun GRANT a anon. Las
--    escribe el backend por las funciones de 092; la restriccion fina del chofer (093) va en un PR aparte, despues del codigo.
--  * capturado_por referencia core.staff_user con ON DELETE SET NULL: guarda un id, nunca nombre ni telefono.
--  * perfil_operativo vive en core.membership porque ahi vive el rol; no cambia el CHECK de roles ni agrega policies: nadie lo escribe directo
--    (el authenticated no tiene UPDATE sobre core.membership), solo la funcion definer de abajo.
--  * operador_puede: SECURITY DEFINER con search_path fijo, STABLE, revoke de public/anon, grant a authenticated/service_role. Sin usuario
--    (auth.uid() nulo) devuelve false: la sesion de sistema no "opera" desde un panel. No devuelve datos, solo un booleano.
--  * staff_perfil_operativo_guardar: definer, search_path fijo, revoke de public/anon, grant a authenticated. Exige owner/admin con membresia de
--    alcance organizacional (property_ids nulo); el objetivo debe ser 'staff' de la MISMA organizacion; sesion de sistema => 42501.
--
-- Compatibilidad con la base SIN migrar: el TypeScript captura 42703 (columna) / 42883 (funcion) en SAVEPOINT y cae al comportamiento anterior
-- (staff = encargado acotado, tiempos nulos). Orden de despliegue: aplicar ANTES o DESPUES del codigo; no cambia nada visible por si sola.
-- REVERSA (ORDEN OBLIGATORIO 092 -> 091 -> 090: las funciones plpgsql NO registran dependencias de columnas ni de funciones, asi que revertir una base
--   antes que quienes la usan NO falla al revertir pero rompe en tiempo de ejecucion). Esta migracion solo pierde DATOS NUEVOS (tiempos, captura, cobro,
--   perfiles) y nada historico:
--     drop function if exists restaurantes.staff_perfil_operativo_guardar(uuid, uuid, text);
--     drop function if exists restaurantes.operador_puede(uuid, uuid, text);
--     alter table core.membership drop column if exists perfil_operativo;
--     drop index if exists restaurantes.orders_org_prop_status_created_idx;
--     alter table restaurantes.orders drop column if exists salio_at, drop column if exists listo_at, drop column if exists capturado_por,
--       drop column if exists canal_captura, drop column if exists indicaciones_entrega, drop column if exists paga_con, drop column if exists cobrado_monto;

alter table restaurantes.orders
  add column if not exists salio_at timestamptz,
  add column if not exists listo_at timestamptz,
  add column if not exists capturado_por uuid references core.staff_user(id) on delete set null,
  add column if not exists canal_captura text check (canal_captura is null or canal_captura in ('llamada', 'mostrador', 'whatsapp_manual')),
  add column if not exists indicaciones_entrega text check (indicaciones_entrega is null or char_length(indicaciones_entrega) <= 240),
  add column if not exists paga_con numeric(10, 2) check (paga_con is null or (paga_con >= 0 and paga_con <= 100000)),
  add column if not exists cobrado_monto numeric(10, 2) check (cobrado_monto is null or (cobrado_monto >= 0 and cobrado_monto <= 100000));

-- Panel «Hoy» y semaforo: pedidos recientes de una sucursal por estado.
create index if not exists orders_org_prop_status_created_idx on restaurantes.orders (organization_id, property_id, status, created_at desc);

-- Relleno unico: primer evento a en_camino. Idempotente (solo filas sin salio_at) y acotado a estados donde el pedido ya salio.
update restaurantes.orders o
set salio_at = e.primero
from (
  select order_id, min(at) as primero
  from restaurantes.order_status_events
  where to_status = 'en_camino'
  group by order_id
) e
where e.order_id = o.id
  and o.salio_at is null
  and o.status in ('en_camino', 'entregado', 'completado', 'problema');

-- Perfil operativo del staff.
alter table core.membership
  add column if not exists perfil_operativo text check (perfil_operativo is null or perfil_operativo in ('encargado', 'cajero'));

create or replace function restaurantes.operador_puede(p_organization_id uuid, p_property_id uuid, p_accion text)
returns boolean
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select auth.uid() is not null
    and p_accion in ('capturar', 'gestionar', 'despachar', 'cancelar')
    and exists (
      select 1
      from core.membership m
      join core.property p on p.id = p_property_id and p.organization_id = p_organization_id
      where m.user_id = auth.uid()
        and m.organization_id = p_organization_id
        and m.vertical_role in ('owner', 'admin', 'staff')
        and (m.property_ids is null or p_property_id = any (m.property_ids))
        and (
          p_accion in ('capturar', 'gestionar')
          or m.vertical_role in ('owner', 'admin')
          or coalesce(m.perfil_operativo, 'encargado') = 'encargado'
        )
    );
$$;
revoke all on function restaurantes.operador_puede(uuid, uuid, text) from public, anon;
grant execute on function restaurantes.operador_puede(uuid, uuid, text) to authenticated, service_role;

create or replace function restaurantes.staff_perfil_operativo_guardar(p_organization_id uuid, p_user_id uuid, p_perfil text)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'staff_perfil_operativo_guardar no es para la sesion de sistema' using errcode = '42501';
  end if;
  if not exists (
    select 1 from core.membership m
    where m.user_id = auth.uid()
      and m.organization_id = p_organization_id
      and m.vertical_role in ('owner', 'admin')
      and m.property_ids is null
  ) then
    raise exception 'solo owner/admin de alcance organizacional cambian el perfil operativo' using errcode = '42501';
  end if;
  if p_perfil is not null and p_perfil not in ('encargado', 'cajero') then
    raise exception 'perfil operativo invalido' using errcode = '22023';
  end if;
  update core.membership m
  set perfil_operativo = p_perfil
  where m.user_id = p_user_id
    and m.organization_id = p_organization_id
    and m.vertical_role = 'staff';
  if not found then
    raise exception 'el usuario no es staff de la organizacion' using errcode = 'P0404';
  end if;
end;
$$;
revoke all on function restaurantes.staff_perfil_operativo_guardar(uuid, uuid, text) from public, anon;
grant execute on function restaurantes.staff_perfil_operativo_guardar(uuid, uuid, text) to authenticated;
