-- 098 -- La bitacora de accesos (097) tambien registra INICIOS DE SESION del personal de restaurantes ('sesion.login').
--
-- QUE HACE: `create or replace` de restaurantes.registrar_acceso con el MISMO cuerpo y permisos de 097 y una accion mas en el catalogo cerrado
-- ('sesion.login'). El inicio de sesion se registra con el usuario ya autenticado (sesion de aplicacion, auth.uid() = la persona) en su primera
-- organizacion de restaurantes; la fila guarda actor, momento y la ruta de entrada (correo, celular...), NUNCA IP, dispositivo, correo ni telefono.
-- Quien la lee: owner/admin en `GET .../admin/auditoria?tipo=acceso` (RLS de 019).
--
-- Justificacion de seguridad: identica a 097 (definer, search_path fijo, revoke public/anon, grant authenticated, actor = auth.uid(), membresia
-- y alcance validados, catalogo cerrado). Compatibilidad base sin migrar: si 098 falta, 'sesion.login' falla con 22023 DENTRO de un SAVEPOINT y el
-- login sigue (best-effort); 097 sigue funcionando.
-- REVERSA: volver a ejecutar el `create or replace` de 097.

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
  if p_action is null or p_action not in ('pii.llamar', 'pii.telefono_ver', 'pii.cliente_ficha', 'sesion.login') then
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
