-- paridad3 rentas -- limpieza en piloto automatico:
--
--   A) Responsable de limpieza por omision de cada unidad (`rentas.unidad.responsable_limpieza_default`):
--      la tarea de limpieza que nace al confirmarse una reserva nace ya asignada a esa persona.
--   B) Validacion de quien recibe una tarea (miembro operativo con acceso a la propiedad) y lista de
--      personas asignables, para que la API responda 422 en vez de confiar solo en el FK a core.staff_user.
--   C) Aviso al asignado: `rentas.notificacion_tarea` pasa a ser la cola de avisos in-app (columna
--      `notificada_in_app_en`) y sus politicas aceptan la sesion de sistema del barrido (como ya hacen
--      ocupacion/tarea_operativa desde 015).
--   D) Indices del barrido de checkouts por propiedad y del tablero de turnos.
--
-- Requiere: 001, 010, 015, 027 (rentas.unidad, tarea_operativa, notificacion_tarea, politicas de sistema).
--
-- BASE SIN MIGRAR: todo el codigo TypeScript que depende de esta migracion captura 42883/42P01/42703 dentro de un
-- SAVEPOINT y cae al comportamiento anterior (tarea sin responsable, sin aviso, 503 honesto al configurar).
--
-- JUSTIFICACION DE SEGURIDAD (cada GRANT, politica y funcion nueva)
--   * `rentas.unidad.responsable_limpieza_default`: la tabla conserva el GRANT solo-SELECT para `authenticated`
--     (001). NO se agrega ningun GRANT de escritura: la columna se escribe unicamente con la funcion definer
--     `rentas.fijar_responsable_limpieza_unidad`, que valida rol y pertenencia. El FK es `on delete set null`: dar de
--     baja a la persona deja la unidad sin responsable, nunca con una referencia colgante.
--   * `rentas.rol_limpieza_en_propiedad` y `rentas.es_miembro_operativo_limpieza`: helpers internos `security definer`
--     (leen core.membership sin depender de sus politicas). EXECUTE revocado a public, anon y authenticated: solo las
--     funciones definer de abajo (mismo duenio) las invocan.
--   * `rentas.responsable_limpieza_vigente(unidad)`: devuelve el responsable por omision SOLO si sigue siendo miembro
--     operativo con acceso a la propiedad. Guard: sesion de sistema (auth.uid() null, el barrido) o un usuario con
--     acceso a la propiedad de la unidad; cualquier otro (otra organizacion, anon) recibe null, igual que una unidad
--     inexistente, sin revelar su existencia. Solo lee; search_path fijo; EXECUTE solo para authenticated.
--   * `rentas.puede_operar_limpieza(propiedad, usuario)`: booleano para que la API valide al asignado. Exige que quien
--     pregunta tenga acceso a la propiedad (si no, false): no sirve para sondear membresias de otras organizaciones.
--   * `rentas.listar_asignables_limpieza(propiedad)`: solo admin_gestora y los dos operadores con alcance a la
--     propiedad (espejo de LIMPIEZA_CREACION_MANUAL_ROLES). Devuelve unicamente id, nombre y rol de miembros operativos
--     de ESA propiedad. Quien no cumple recibe 42501, igual para propiedad ajena o inexistente.
--   * `rentas.fijar_responsable_limpieza_unidad`: exige auth.uid() (42501 para el sistema), unidad de una propiedad a la
--     que el llamador tiene acceso (P0002 si no: no revela unidades ajenas) y rol admin_gestora u
--     operador:acceso_total (42501); el responsable debe ser miembro operativo de la propiedad (22023).
--   * `rentas.notificacion_tarea`: se ensanchan SELECT/INSERT a `auth.uid() is null` (sesion de sistema del barrido,
--     que ya crea y lee tareas desde 015) y se agrega UPDATE solo para la columna `notificada_in_app_en`. El rol anon
--     no tiene ningun GRANT sobre la tabla; la columna no contiene datos personales.
--   * Indices: sin cambios de acceso.
--
-- Codigos: 42501 sin permiso, 22023 argumento invalido, P0002 no encontrado.

-- ---------------------------------------------------------------------------
-- A) Columna del responsable por omision.
-- ---------------------------------------------------------------------------
alter table rentas.unidad
  add column responsable_limpieza_default uuid references core.staff_user(id) on delete set null;

-- El FK `on delete set null` recorre esta columna al dar de baja a un staff: indice parcial (la mayoria es null).
create index unidad_responsable_limpieza_idx on rentas.unidad (responsable_limpieza_default) where responsable_limpieza_default is not null;

-- ---------------------------------------------------------------------------
-- B) Helpers internos y funciones de validacion/lista.
-- ---------------------------------------------------------------------------
create function rentas.rol_limpieza_en_propiedad(p_organization_id uuid, p_property_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, core, pg_temp
as $$
  select m.vertical_role
  from core.membership m
  where m.user_id = auth.uid()
    and m.organization_id = p_organization_id
    and (m.property_ids is null or p_property_id = any(m.property_ids))
  limit 1
$$;
revoke all on function rentas.rol_limpieza_en_propiedad(uuid, uuid) from public, anon, authenticated;

create function rentas.es_miembro_operativo_limpieza(p_user_id uuid, p_organization_id uuid, p_property_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, core, pg_temp
as $$
  select exists (
    select 1
    from core.membership m
    where m.user_id = p_user_id
      and m.organization_id = p_organization_id
      and m.vertical_role in ('admin_gestora', 'operador:acceso_total', 'operador:calendario_mensajeria', 'limpieza')
      and (m.property_ids is null or p_property_id = any(m.property_ids))
  )
$$;
revoke all on function rentas.es_miembro_operativo_limpieza(uuid, uuid, uuid) from public, anon, authenticated;

create function rentas.responsable_limpieza_vigente(p_unidad_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_unidad rentas.unidad%rowtype;
begin
  select u.* into v_unidad from rentas.unidad u where u.id = p_unidad_id;
  if not found or v_unidad.responsable_limpieza_default is null then
    return null;
  end if;
  if auth.uid() is not null and not core.has_property_access(auth.uid(), v_unidad.property_id) then
    return null;
  end if;
  if rentas.es_miembro_operativo_limpieza(v_unidad.responsable_limpieza_default, v_unidad.organization_id, v_unidad.property_id) then
    return v_unidad.responsable_limpieza_default;
  end if;
  return null;
end;
$$;
revoke all on function rentas.responsable_limpieza_vigente(uuid) from public, anon;
grant execute on function rentas.responsable_limpieza_vigente(uuid) to authenticated;

create function rentas.puede_operar_limpieza(p_property_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_org uuid;
begin
  if auth.uid() is null or p_user_id is null then
    return false;
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id;
  if v_org is null or not core.has_property_access(auth.uid(), p_property_id) then
    return false;
  end if;
  return rentas.es_miembro_operativo_limpieza(p_user_id, v_org, p_property_id);
end;
$$;
revoke all on function rentas.puede_operar_limpieza(uuid, uuid) from public, anon;
grant execute on function rentas.puede_operar_limpieza(uuid, uuid) to authenticated;

create function rentas.listar_asignables_limpieza(p_property_id uuid)
returns table (user_id uuid, full_name text, vertical_role text)
language plpgsql
stable
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'rentas.listar_asignables_limpieza: solo staff autenticado.' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id;
  if v_org is null
     or coalesce(rentas.rol_limpieza_en_propiedad(v_org, p_property_id), '') not in ('admin_gestora', 'operador:acceso_total', 'operador:calendario_mensajeria') then
    raise exception 'rentas.listar_asignables_limpieza: sin permiso para esta propiedad.' using errcode = '42501';
  end if;
  return query
    select m.user_id, su.full_name, m.vertical_role
    from core.membership m
    join core.staff_user su on su.id = m.user_id
    where m.organization_id = v_org
      and m.vertical_role in ('admin_gestora', 'operador:acceso_total', 'operador:calendario_mensajeria', 'limpieza')
      and (m.property_ids is null or p_property_id = any(m.property_ids))
    order by su.full_name, m.user_id;
end;
$$;
revoke all on function rentas.listar_asignables_limpieza(uuid) from public, anon;
grant execute on function rentas.listar_asignables_limpieza(uuid) to authenticated;

create function rentas.fijar_responsable_limpieza_unidad(p_unidad_id uuid, p_responsable_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_unidad rentas.unidad%rowtype;
  v_rol text;
begin
  if auth.uid() is null then
    raise exception 'rentas.fijar_responsable_limpieza_unidad: solo staff autenticado.' using errcode = '42501';
  end if;
  select u.* into v_unidad from rentas.unidad u where u.id = p_unidad_id for update;
  if not found or not core.has_property_access(auth.uid(), v_unidad.property_id) then
    raise exception 'rentas.fijar_responsable_limpieza_unidad: unidad no encontrada.' using errcode = 'P0002';
  end if;
  v_rol := rentas.rol_limpieza_en_propiedad(v_unidad.organization_id, v_unidad.property_id);
  if coalesce(v_rol, '') not in ('admin_gestora', 'operador:acceso_total') then
    raise exception 'rentas.fijar_responsable_limpieza_unidad: solo el administrador o un operador con acceso total.' using errcode = '42501';
  end if;
  if p_responsable_id is not null
     and not rentas.es_miembro_operativo_limpieza(p_responsable_id, v_unidad.organization_id, v_unidad.property_id) then
    raise exception 'rentas.fijar_responsable_limpieza_unidad: la persona no es miembro con acceso a esta propiedad.' using errcode = '22023';
  end if;
  update rentas.unidad set responsable_limpieza_default = p_responsable_id where id = v_unidad.id;
  return v_unidad.id;
end;
$$;
revoke all on function rentas.fijar_responsable_limpieza_unidad(uuid, uuid) from public, anon;
grant execute on function rentas.fijar_responsable_limpieza_unidad(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- C) rentas.notificacion_tarea como cola de avisos in-app.
-- ---------------------------------------------------------------------------
alter table rentas.notificacion_tarea add column notificada_in_app_en timestamptz;
-- Las filas anteriores a esta migracion ya no son "por avisar": evita una avalancha de avisos viejos al desplegar.
update rentas.notificacion_tarea set notificada_in_app_en = now() where notificada_in_app_en is null;
create index notificacion_tarea_por_avisar_idx on rentas.notificacion_tarea (creado_en) where notificada_in_app_en is null;

alter policy "staff ve notificaciones de tareas de su property" on rentas.notificacion_tarea
  using (
    auth.uid() is null
    or exists (select 1 from rentas.tarea_operativa t where t.id = notificacion_tarea.tarea_id and core.has_property_access(auth.uid(), t.property_id))
  );
alter policy "staff inserta notificaciones de tareas de su property" on rentas.notificacion_tarea
  with check (
    auth.uid() is null
    or exists (select 1 from rentas.tarea_operativa t where t.id = notificacion_tarea.tarea_id and core.has_property_access(auth.uid(), t.property_id))
  );
create policy "staff marca avisos de tareas de su property" on rentas.notificacion_tarea for update
  using (
    auth.uid() is null
    or exists (select 1 from rentas.tarea_operativa t where t.id = notificacion_tarea.tarea_id and core.has_property_access(auth.uid(), t.property_id))
  )
  with check (
    auth.uid() is null
    or exists (select 1 from rentas.tarea_operativa t where t.id = notificacion_tarea.tarea_id and core.has_property_access(auth.uid(), t.property_id))
  );
grant update (notificada_in_app_en) on rentas.notificacion_tarea to authenticated;

-- ---------------------------------------------------------------------------
-- D) Indices: barrido de checkouts por propiedad y tablero de turnos por propiedad y dia.
-- ---------------------------------------------------------------------------
create index ocupacion_checkout_barrido_idx on rentas.ocupacion (property_id, (upper(rango)))
  where capa = 'reserva' and estado = 'confirmado' and bloqueante;
create index tarea_operativa_property_programada_idx on rentas.tarea_operativa (property_id, programada_para);
