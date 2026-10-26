-- 098 -- La bitacora de accesos (097) tambien registra INICIOS DE SESION del personal de restaurantes ('sesion.login').
--
-- QUE HACE: `create or replace` de restaurantes.registrar_acceso con el MISMO cuerpo y permisos de 097 (candado, llave de idempotencia, validacion de la
-- entidad) y una accion mas en el catalogo cerrado ('sesion.login'). Para 'sesion.login' NO se cuenta (devuelve 0 sin recorrer la bitacora en cada
-- inicio de sesion) y el parametro `p_llave` es el CANAL de entrada, de un catalogo cerrado (correo/google/enlace/celular/otro), nunca texto libre. El inicio de sesion se registra con el usuario ya autenticado (sesion de aplicacion, auth.uid() = la persona) en su primera
-- organizacion de restaurantes; la fila guarda actor, momento y el canal de entrada (correo, google, enlace, celular), NUNCA IP, dispositivo, correo ni telefono.
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
  p_llave text
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
  v_clave bigint;
  v_replays integer;
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

  if p_action = 'sesion.login' then
    -- Sin texto libre: el canal de entrada es un catalogo cerrado.
    if p_llave is not null and p_llave not in ('correo', 'google', 'enlace', 'celular', 'otro') then
      raise exception 'restaurantes.registrar_acceso: canal de inicio de sesion invalido.' using errcode = '22023';
    end if;
    -- Un login no tiene tope ni idempotencia: se inserta y se sale sin recorrer la bitacora (devuelve 0).
    insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
    values (p_organization_id, v_actor, p_action, 'acceso', null, left(coalesce(p_property_id::text, ''), 200), null, p_llave);
    return 0;
  end if;
  if p_llave is not null and p_llave !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'restaurantes.registrar_acceso: llave de idempotencia invalida.' using errcode = '22023';
  end if;
  -- La entidad debe existir en ESTA organizacion (y, para un pedido, en la sucursal indicada): pedido para llamar/ver telefono, cliente para la ficha.
  -- Una membresia acotada exige indicar la sucursal (no se puede omitir para esquivar el chequeo de alcance).
  if p_property_id is null and v_props is not null then
    raise exception 'restaurantes.registrar_acceso: indica la sucursal.' using errcode = '22023';
  end if;
  if p_action in ('pii.llamar', 'pii.telefono_ver') then
    if p_entity_id is null or p_property_id is null or not exists (
      select 1 from restaurantes.orders o where o.id = p_entity_id and o.organization_id = p_organization_id and o.property_id = p_property_id
    ) then
      raise exception 'restaurantes.registrar_acceso: el pedido no pertenece a la organizacion y sucursal indicadas.' using errcode = '22023';
    end if;
  elsif p_action = 'pii.cliente_ficha' then
    if p_entity_id is null or not exists (select 1 from restaurantes.customers cu where cu.id = p_entity_id and cu.organization_id = p_organization_id) then
      raise exception 'restaurantes.registrar_acceso: el cliente no pertenece a la organizacion.' using errcode = '22023';
    end if;
  end if;

  -- Serializa insertar+contar por actor/accion/entidad: el tope no se puede rebasar con llamadas concurrentes.
  v_clave := hashtextextended(v_actor::text || '|' || p_action || '|' || coalesce(p_entity_id::text, ''), 0);
  perform pg_advisory_xact_lock(v_clave);

  -- Idempotencia ACOTADA (la llave la controla el cliente, asi que no puede dar telefono ilimitado): solo cuenta como reintento si la misma llave
  -- se uso hace menos de 10 min para esta entidad. Cada reintento SI deja fila en la bitacora (despues = llave || ':r') pero no consume cupo,
  -- hasta 3 reintentos por llave; del cuarto en adelante la fila (llave || ':x') cuenta como una llamada normal contra el tope.
  if p_llave is not null and exists (
    select 1 from restaurantes.audit_log a
    where a.organization_id = p_organization_id and a.actor_user_id = v_actor and a.entity_type = 'acceso'
      and a.action = p_action and a.entity_id is not distinct from p_entity_id and a.despues = p_llave
      and a.created_at > now() - interval '10 minutes'
  ) then
    select count(*)::integer into v_replays from restaurantes.audit_log a
    where a.organization_id = p_organization_id and a.actor_user_id = v_actor and a.entity_type = 'acceso'
      and a.action = p_action and a.entity_id is not distinct from p_entity_id and a.despues = p_llave || ':r'
      and a.created_at > now() - interval '10 minutes';
    insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
    values (p_organization_id, v_actor, p_action, 'acceso', p_entity_id, left(coalesce(p_property_id::text, ''), 200), null,
            p_llave || case when v_replays < 3 then ':r' else ':x' end);
  else
    insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
    values (p_organization_id, v_actor, p_action, 'acceso', p_entity_id, left(coalesce(p_property_id::text, ''), 200), null, p_llave);
  end if;

  -- Cupo: todas las filas salvo los reintentos gratuitos (':r'), en las ultimas 24 h.
  select count(*)::integer into v_n
    from restaurantes.audit_log a
    where a.organization_id = p_organization_id
      and a.actor_user_id = v_actor
      and a.entity_type = 'acceso'
      and a.action = p_action
      and a.entity_id is not distinct from p_entity_id
      and a.created_at > now() - interval '24 hours'
      and (a.despues is null or a.despues !~ ':r$');
  return v_n;
end;
$$;

revoke all on function restaurantes.registrar_acceso(uuid, uuid, text, uuid, text) from public, anon;
grant execute on function restaurantes.registrar_acceso(uuid, uuid, text, uuid, text) to authenticated;
