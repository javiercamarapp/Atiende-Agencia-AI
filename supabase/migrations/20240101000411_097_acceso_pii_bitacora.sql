-- 097 -- Bitacora de ACCESOS a datos personales del cliente (telefono): «Llamar» del repartidor y futuras lecturas sensibles.
--
-- QUE HACE (aditivo e idempotente):
--   1. Amplia el catalogo cerrado de `restaurantes.audit_log.entity_type` con 'acceso' (misma tabla append-only, misma RLS: la LEEN solo
--      owner/admin por `GET .../admin/auditoria?tipo=acceso`).
--   2. restaurantes.registrar_acceso(org, sucursal, accion, entidad, detalle) -> integer: escribe una fila 'acceso' y devuelve cuantas filas
--      del mismo actor/accion/entidad existen (incluida esta), para que el backend aplique un tope por pedido (p. ej. 5 llamadas).
--
-- Por que una funcion nueva y no `record_audit_log`: esa exige vertical_role owner/admin/staff y el repartidor (rol disjunto de
-- MANAGER_ROLES) es justo quien debe quedar registrado al pedir el telefono.
--
-- Justificacion de seguridad:
--  * SECURITY DEFINER con `search_path` fijo; revoke de public/anon; grant solo a authenticated. Sin sesion (auth.uid() nulo) -> 28000.
--  * El actor es SIEMPRE auth.uid(), nunca un parametro. Exige membresia en la organizacion con rol de restaurantes
--    (owner/admin/staff/repartidor) y, si la membresia esta acotada (`property_ids`), que la sucursal indicada este en su alcance.
--  * La accion es un catalogo cerrado ('pii.llamar', 'pii.telefono_ver', 'pii.cliente_ficha'): nadie siembra filas arbitrarias.
--  * NUNCA guarda el telefono ni otro dato personal: solo actor, accion, id de la entidad (pedido o cliente) y sucursal en `campo`.
--  * No se concede nada nuevo sobre la tabla: la fila entra por la funcion definer; el trigger append-only de 019 sigue bloqueando UPDATE/DELETE.
--
-- Compatibilidad con la base SIN migrar: el TypeScript captura 42883/42P01/42703 y sigue sin bitacora (el telefono ya viene enmascarado;
--   solo el «Llamar» pierde su registro hasta aplicar esta migracion: aplicarla ANTES de desplegar el codigo).
-- REVERSA:
--     drop function if exists restaurantes.registrar_acceso(uuid, uuid, text, uuid, text);
--     -- (el CHECK ampliado se puede dejar; si se restaura, antes borrar las filas 'acceso' es imposible por el trigger append-only:
--     --  dejar el CHECK ampliado es la reversa segura.)

alter table restaurantes.audit_log drop constraint if exists audit_log_entity_type_check;
alter table restaurantes.audit_log add constraint audit_log_entity_type_check
  check (entity_type in ('producto', 'promocion', 'pedido', 'repartidor', 'staff', 'configuracion', 'exportacion', 'acceso'));

create or replace function restaurantes.registrar_acceso(
  p_organization_id uuid,
  p_property_id uuid,
  p_action text,
  p_entity_id uuid,
  p_detalle text
)
returns integer
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_props uuid[];
  v_n integer;
begin
  if v_actor is null then
    raise exception 'restaurantes.registrar_acceso: requiere un actor autenticado (auth.uid() es NULL).' using errcode = '28000';
  end if;
  if p_action is null or p_action not in ('pii.llamar', 'pii.telefono_ver', 'pii.cliente_ficha') then
    raise exception 'restaurantes.registrar_acceso: accion no permitida.' using errcode = '22023';
  end if;

  select m.vertical_role, m.property_ids into v_role, v_props
    from core.membership m
    where m.organization_id = p_organization_id and m.user_id = v_actor;
  if v_role is null or v_role not in ('owner', 'admin', 'staff', 'repartidor') then
    raise exception 'restaurantes.registrar_acceso: el actor no pertenece a la organizacion con un rol de restaurantes.' using errcode = '42501';
  end if;
  if p_property_id is not null and v_props is not null and not (p_property_id = any (v_props)) then
    raise exception 'restaurantes.registrar_acceso: sucursal fuera del alcance del actor.' using errcode = '42501';
  end if;

  insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
  values (p_organization_id, v_actor, p_action, 'acceso', p_entity_id, left(coalesce(p_property_id::text, ''), 200), null, left(p_detalle, 500));

  select count(*)::integer into v_n
    from restaurantes.audit_log a
    where a.organization_id = p_organization_id
      and a.actor_user_id = v_actor
      and a.entity_type = 'acceso'
      and a.action = p_action
      and a.entity_id is not distinct from p_entity_id;
  return v_n;
end;
$$;

revoke all on function restaurantes.registrar_acceso(uuid, uuid, text, uuid, text) from public, anon;
grant execute on function restaurantes.registrar_acceso(uuid, uuid, text, uuid, text) to authenticated;
