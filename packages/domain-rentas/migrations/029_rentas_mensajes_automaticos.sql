-- Rn-24 / Rn-25 -- plantillas de mensajes de rentas con aprobacion explicita del tenant y
-- mensajes automaticos por evento (pre_llegada, check_in, check_out, resena).
-- Requiere 009_rentas_mensajeria_schema.sql (plantilla_mensaje, conversacion,
-- borrador_mensaje) y 001 (ocupacion, canal, property_config, guest_minimo).
--
-- Modelo (D-006 / H-056 / H-059): una automatizacion NUNCA envia. Para cada reserva en
-- ventana el cron renderiza la plantilla aprobada y deja un BORRADOR en
-- rentas.borrador_mensaje con estado 'pendiente_aprobacion'; la unica salida real sigue
-- siendo la aprobacion humana de mensajeria-borradores.ts.
--
-- Objetos nuevos:
--   * rentas.mensaje_automatico_config  -- programacion por propiedad y evento: plantilla,
--                                          offset en horas respecto al ancla, activo.
--   * rentas.mensaje_automatico_envio   -- marca de idempotencia por reserva + evento. La
--                                          escribe SOLO la sesion de sistema (funciones de
--                                          abajo); el staff solo la lee.
--   * rentas.puede_gestionar_mensajes_automaticos(property) -- guard de rol para la RLS.
--   * rentas.sistema_listar_mensajes_automaticos / sistema_crear_borrador_automatico /
--     sistema_registrar_mensaje_omitido -- funciones de SOLO SISTEMA (auth.uid() is null).
--   * trigger plantilla_mensaje_reset_aprobacion -- editar el cuerpo de una plantilla le
--     quita la aprobacion (defensa en profundidad de la regla de la API).
--
-- Anclas: pre_llegada y check_in usan la fecha de check-in (lower(rango)); check_out y
-- resena usan la de check-out (upper(rango)). El disparo es ancla a las 00:00 en la zona
-- horaria de la propiedad + offset_horas (negativo = antes). Solo se genera mientras
-- disparo <= ahora < disparo + 24 h (ventana de gracia): una reserva creada tarde no
-- recibe un mensaje "pre-llegada" ya obsoleto.

-- ---------------------------------------------------------------------------
-- Integridad referencial: una programacion solo puede apuntar a una plantilla de SU
-- organizacion y de SU evento. La llave compuesta lo garantiza en la base (no solo en la
-- API): no hay forma de programar la plantilla de otro tenant ni de otro evento.
-- ---------------------------------------------------------------------------
alter table rentas.plantilla_mensaje
  add constraint plantilla_mensaje_id_org_evento_unique unique (id, organization_id, evento);

create table rentas.mensaje_automatico_config (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  evento text not null check (evento in ('pre_llegada', 'check_in', 'check_out', 'resena')),
  plantilla_id uuid not null,
  -- Horas respecto al ancla (ver cabecera). Rango +-30 dias.
  offset_horas integer not null check (offset_horas between -720 and 720),
  activo boolean not null default false,
  actualizado_por uuid references core.staff_user(id) on delete set null,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (property_id, evento),
  foreign key (plantilla_id, organization_id, evento) references rentas.plantilla_mensaje (id, organization_id, evento) on delete restrict
);
create index mensaje_automatico_config_organization_idx on rentas.mensaje_automatico_config (organization_id);

create table rentas.mensaje_automatico_envio (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  ocupacion_id uuid not null references rentas.ocupacion(id) on delete cascade,
  evento text not null check (evento in ('pre_llegada', 'check_in', 'check_out', 'resena')),
  resultado text not null check (resultado in ('borrador_creado', 'omitido_variable_faltante')),
  borrador_id uuid references rentas.borrador_mensaje(id) on delete set null,
  plantilla_id uuid references rentas.plantilla_mensaje(id) on delete set null,
  creado_en timestamptz not null default now(),
  -- Idempotencia: el cron puede correr dos veces (o dos instancias a la vez) y la reserva
  -- recibe como maximo UN borrador por evento.
  unique (ocupacion_id, evento)
);
create index mensaje_automatico_envio_property_idx on rentas.mensaje_automatico_envio (property_id);

-- ---------------------------------------------------------------------------
-- Guard de rol. Solo admin_gestora con acceso a la propiedad programa automatizaciones
-- (mismo criterio que MENSAJERIA_PLANTILLA_APROBACION_ROLES: programar envios es una
-- decision de negocio mas estricta que redactar). security definer porque lee
-- core.membership sin depender de las policies de quien llama; search_path fijo; se
-- revoca de public/anon y se concede a authenticated (la policy corre con ese rol).
-- ---------------------------------------------------------------------------
create function rentas.puede_gestionar_mensajes_automaticos(p_property_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, core, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1
    from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid()
      and p.id = p_property_id
      and (m.property_ids is null or p_property_id = any(m.property_ids))
      and m.vertical_role = 'admin_gestora'
  )
$$;
revoke all on function rentas.puede_gestionar_mensajes_automaticos(uuid) from public, anon;
grant execute on function rentas.puede_gestionar_mensajes_automaticos(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS + GRANT.
--   config: lectura para todo el staff con acceso a la propiedad; insert/update solo
--   admin_gestora (guard de arriba) y con organization_id coherente con la propiedad.
--   Sin policy de delete (apagar = activo false, queda el historial). GRANT a nivel
--   columna: el API solo escribe estas columnas (upsert).
--   envio: solo lectura para el staff (la UI muestra "ya se genero"); ningun GRANT de
--   escritura a authenticated: lo escriben las funciones sistema_* (security definer).
-- ---------------------------------------------------------------------------
alter table rentas.mensaje_automatico_config enable row level security;
alter table rentas.mensaje_automatico_envio enable row level security;

create policy "staff ve programaciones de su property" on rentas.mensaje_automatico_config for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "admin_gestora programa mensajes de su property" on rentas.mensaje_automatico_config for insert
  with check (
    rentas.puede_gestionar_mensajes_automaticos(property_id)
    and exists (select 1 from core.property p where p.id = mensaje_automatico_config.property_id and p.organization_id = mensaje_automatico_config.organization_id)
  );
create policy "admin_gestora edita mensajes programados de su property" on rentas.mensaje_automatico_config for update
  using (rentas.puede_gestionar_mensajes_automaticos(property_id))
  with check (
    rentas.puede_gestionar_mensajes_automaticos(property_id)
    and exists (select 1 from core.property p where p.id = mensaje_automatico_config.property_id and p.organization_id = mensaje_automatico_config.organization_id)
  );

create policy "staff ve marcas de mensajes automaticos de su property" on rentas.mensaje_automatico_envio for select
  using (core.has_property_access(auth.uid(), property_id));

revoke all on rentas.mensaje_automatico_config, rentas.mensaje_automatico_envio from public, anon, authenticated;
grant select on rentas.mensaje_automatico_config to authenticated;
grant insert (organization_id, property_id, evento, plantilla_id, offset_horas, activo, actualizado_por) on rentas.mensaje_automatico_config to authenticated;
grant update (plantilla_id, offset_horas, activo, actualizado_por, actualizado_en) on rentas.mensaje_automatico_config to authenticated;
grant select on rentas.mensaje_automatico_envio to authenticated;
grant select, insert, update, delete on rentas.mensaje_automatico_config, rentas.mensaje_automatico_envio to service_role;

-- ---------------------------------------------------------------------------
-- Editar el cuerpo le quita la aprobacion. Sin esto, un operador podria cambiar el texto
-- de una plantilla ya aprobada y las automatizaciones seguirian usandolo sin que el
-- tenant lo revisara (H-056). Trigger de invoker (no definer): solo toca NEW.
-- ---------------------------------------------------------------------------
create function rentas.plantilla_mensaje_reset_aprobacion()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.cuerpo is distinct from old.cuerpo then
    new.aprobada_por_tenant := false;
  end if;
  return new;
end;
$$;
create trigger plantilla_mensaje_reset_aprobacion
  before update on rentas.plantilla_mensaje
  for each row execute function rentas.plantilla_mensaje_reset_aprobacion();

-- ---------------------------------------------------------------------------
-- Funciones de SOLO SISTEMA (el cron corre con auth.uid() NULL; ver 015). Todas:
-- security definer + search_path fijo + revoke de public/anon + guard
-- `auth.uid() is not null -> 42501`. Ningun staff real puede invocarlas con efecto.
-- ---------------------------------------------------------------------------

-- Candidatas: reservas OTA confirmadas cuyo instante de disparo cae en
-- (p_ahora - 24 h, p_ahora], con programacion activa, plantilla aprobada+activa (y de ese
-- canal o sin canal) y sin marca previa. Solo reservas de canal con mensajeria real
-- (airbnb/vrbo/booking): una reserva directa no tiene hilo de mensajeria al que colgar el
-- borrador. Zona invalida o ausente -> America/Mexico_City (mismo default de plataforma).
create function rentas.sistema_listar_mensajes_automaticos(p_ahora timestamptz, p_limite integer default 100)
returns table (
  ocupacion_id uuid,
  organization_id uuid,
  property_id uuid,
  unidad_id uuid,
  evento text,
  offset_horas integer,
  plantilla_id uuid,
  plantilla_cuerpo text,
  plantilla_aprobada boolean,
  plantilla_activa boolean,
  canal_codigo text,
  check_in date,
  check_out date,
  huesped_nombre text,
  propiedad_nombre text,
  unidad_nombre text,
  zona_horaria text,
  disparo_en timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'sistema_listar_mensajes_automaticos: solo sesion de sistema' using errcode = '42501';
  end if;
  if p_limite is null or p_limite < 1 then p_limite := 1; end if;
  if p_limite > 500 then p_limite := 500; end if;

  return query
  with zonas as materialized (select n.name from pg_catalog.pg_timezone_names n)
  select * from (
    select
      o.id,
      o.organization_id,
      o.property_id,
      o.unidad_id,
      c.evento,
      c.offset_horas,
      pl.id,
      pl.cuerpo,
      pl.aprobada_por_tenant,
      pl.activa,
      ca.codigo,
      lower(o.rango),
      upper(o.rango),
      g.nombre,
      p.name,
      u.name,
      z.tz,
      ((case when c.evento in ('pre_llegada', 'check_in') then lower(o.rango) else upper(o.rango) end)::timestamp + pg_catalog.make_interval(hours => c.offset_horas)) at time zone z.tz as disparo
    from rentas.mensaje_automatico_config c
    join rentas.plantilla_mensaje pl
      on pl.id = c.plantilla_id and pl.organization_id = c.organization_id and pl.evento = c.evento
     and pl.aprobada_por_tenant and pl.activa
    join rentas.ocupacion o
      on o.property_id = c.property_id and o.organization_id = c.organization_id
     and o.capa = 'reserva' and o.estado = 'confirmado'
    join rentas.canal ca on ca.id = o.canal_origen_id and ca.codigo in ('airbnb', 'vrbo', 'booking')
    join core.property p on p.id = o.property_id
    join rentas.unidad u on u.id = o.unidad_id
    left join rentas.property_config pc on pc.property_id = o.property_id
    left join zonas zv on zv.name = pc.zona_horaria
    left join rentas.guest_minimo g on g.id = o.huesped_minimo_id
    cross join lateral (select coalesce(zv.name, 'America/Mexico_City') as tz) z
    where c.activo
      and (pl.canal_codigo is null or pl.canal_codigo = ca.codigo)
      and lower(o.rango) between (p_ahora::date - 40) and (p_ahora::date + 40)
      and not exists (select 1 from rentas.mensaje_automatico_envio e where e.ocupacion_id = o.id and e.evento = c.evento)
  ) t(ocupacion_id, organization_id, property_id, unidad_id, evento, offset_horas, plantilla_id, plantilla_cuerpo, plantilla_aprobada, plantilla_activa, canal_codigo, check_in, check_out, huesped_nombre, propiedad_nombre, unidad_nombre, zona_horaria, disparo_en)
  where t.disparo_en <= p_ahora and t.disparo_en > p_ahora - interval '24 hours'
  order by t.disparo_en asc, t.ocupacion_id asc
  limit p_limite;
end;
$$;
revoke all on function rentas.sistema_listar_mensajes_automaticos(timestamptz, integer) from public, anon;
grant execute on function rentas.sistema_listar_mensajes_automaticos(timestamptz, integer) to authenticated;

-- Crea el borrador (siempre 'pendiente_aprobacion', generado_por 'motor_borrador') y la
-- marca de idempotencia en UNA sola transaccion. Revalida en la base todo lo que la
-- candidata afirmaba (programacion activa, plantilla aprobada/activa/de la organizacion,
-- reserva OTA confirmada): si algo cambio entre listar y crear, devuelve NULL y no escribe.
-- Devuelve NULL tambien si la marca ya existia (la reserva ya recibio ese evento).
create function rentas.sistema_crear_borrador_automatico(p_ocupacion_id uuid, p_evento text, p_plantilla_id uuid, p_texto text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_oc record;
  v_conversacion uuid;
  v_borrador uuid;
  v_marca uuid;
begin
  if auth.uid() is not null then
    raise exception 'sistema_crear_borrador_automatico: solo sesion de sistema' using errcode = '42501';
  end if;
  if p_evento not in ('pre_llegada', 'check_in', 'check_out', 'resena') then
    raise exception 'sistema_crear_borrador_automatico: evento invalido' using errcode = '22023';
  end if;
  if p_texto is null or length(btrim(p_texto)) = 0 or length(p_texto) > 4000 then
    raise exception 'sistema_crear_borrador_automatico: texto fuera de 1-4000 caracteres' using errcode = '22023';
  end if;

  select o.id, o.organization_id, o.property_id, o.unidad_id, o.huesped_minimo_id, lower(o.rango) as check_in, upper(o.rango) as check_out,
         ca.codigo as canal, p.name as propiedad_nombre, g.nombre as huesped_nombre
    into v_oc
    from rentas.ocupacion o
    join rentas.canal ca on ca.id = o.canal_origen_id and ca.codigo in ('airbnb', 'vrbo', 'booking')
    join core.property p on p.id = o.property_id
    left join rentas.guest_minimo g on g.id = o.huesped_minimo_id
   where o.id = p_ocupacion_id and o.capa = 'reserva' and o.estado = 'confirmado';
  if not found then return null; end if;

  perform 1
    from rentas.mensaje_automatico_config c
    join rentas.plantilla_mensaje pl
      on pl.id = c.plantilla_id and pl.organization_id = c.organization_id and pl.evento = c.evento
     and pl.aprobada_por_tenant and pl.activa
   where c.property_id = v_oc.property_id and c.organization_id = v_oc.organization_id
     and c.evento = p_evento and c.plantilla_id = p_plantilla_id and c.activo
     and (pl.canal_codigo is null or pl.canal_codigo = v_oc.canal);
  if not found then return null; end if;

  insert into rentas.mensaje_automatico_envio (organization_id, property_id, ocupacion_id, evento, resultado, plantilla_id)
  values (v_oc.organization_id, v_oc.property_id, v_oc.id, p_evento, 'borrador_creado', p_plantilla_id)
  on conflict (ocupacion_id, evento) do nothing
  returning id into v_marca;
  if v_marca is null then return null; end if;

  select cv.id into v_conversacion
    from rentas.conversacion cv
   where cv.ocupacion_id = v_oc.id and cv.canal_codigo = v_oc.canal
   order by cv.creado_en asc
   limit 1;
  if v_conversacion is null then
    insert into rentas.conversacion (organization_id, property_id, unidad_id, canal_codigo, ocupacion_id, huesped_minimo_id, propiedad_nombre, huesped_nombre, fecha_check_in, fecha_check_out, reserva_confirmada)
    values (v_oc.organization_id, v_oc.property_id, v_oc.unidad_id, v_oc.canal, v_oc.id, v_oc.huesped_minimo_id, v_oc.propiedad_nombre, v_oc.huesped_nombre, v_oc.check_in, v_oc.check_out, true)
    returning id into v_conversacion;
  end if;

  insert into rentas.borrador_mensaje (conversacion_id, canal_codigo, texto, estado, generado_por)
  values (v_conversacion, v_oc.canal, p_texto, 'pendiente_aprobacion', 'motor_borrador')
  returning id into v_borrador;

  update rentas.mensaje_automatico_envio set borrador_id = v_borrador where id = v_marca;
  return v_borrador;
end;
$$;
revoke all on function rentas.sistema_crear_borrador_automatico(uuid, text, uuid, text) from public, anon;
grant execute on function rentas.sistema_crear_borrador_automatico(uuid, text, uuid, text) to authenticated;

-- Marca una reserva+evento como omitida cuando la plantilla no se pudo renderizar (falta
-- una variable): evita reintentar cada hora un mensaje que no puede salir bien. No crea
-- borrador. Misma revalidacion de reserva OTA confirmada; devuelve false si ya habia marca.
create function rentas.sistema_registrar_mensaje_omitido(p_ocupacion_id uuid, p_evento text, p_plantilla_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_insertada integer;
begin
  if auth.uid() is not null then
    raise exception 'sistema_registrar_mensaje_omitido: solo sesion de sistema' using errcode = '42501';
  end if;
  if p_evento not in ('pre_llegada', 'check_in', 'check_out', 'resena') then
    raise exception 'sistema_registrar_mensaje_omitido: evento invalido' using errcode = '22023';
  end if;
  insert into rentas.mensaje_automatico_envio (organization_id, property_id, ocupacion_id, evento, resultado, plantilla_id)
  select o.organization_id, o.property_id, o.id, p_evento, 'omitido_variable_faltante', p_plantilla_id
    from rentas.ocupacion o
    join rentas.canal ca on ca.id = o.canal_origen_id and ca.codigo in ('airbnb', 'vrbo', 'booking')
   where o.id = p_ocupacion_id and o.capa = 'reserva' and o.estado = 'confirmado'
  on conflict (ocupacion_id, evento) do nothing;
  get diagnostics v_insertada = row_count;
  return v_insertada > 0;
end;
$$;
revoke all on function rentas.sistema_registrar_mensaje_omitido(uuid, text, uuid) from public, anon;
grant execute on function rentas.sistema_registrar_mensaje_omitido(uuid, text, uuid) to authenticated;
