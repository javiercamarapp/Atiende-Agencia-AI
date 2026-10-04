-- R-16 (PM, restaurantes): avisos del staff. Preferencias de notificacion por (organizacion, usuario),
-- umbral de "entrega tardia" por sucursal y el candidato de las dos alertas operativas nuevas
-- (entrega tardia / programado por vencer). Interno 043, prefijo de supabase/migrations 20240101000309.
--
-- Piezas:
--   A) core.notification_preference: que tipos de notificacion in-app (core.notification.tipo) recibe cada
--      usuario en una organizacion y si suenan en el navegador. SIN fila = todo encendido (default de
--      owner/admin/staff). Es generica (tipo = id del catalogo de @atiende/db, p. ej.
--      `restaurantes.pedido.nuevo`), no solo de restaurantes.
--   B) core.list_notification_preferences / core.set_notification_preference: lectura y escritura por
--      funcion (la tabla NO recibe INSERT/UPDATE directo: ver justificacion).
--   C) core.emit_notification: MISMO cuerpo y firma que la 0039 con UN solo cambio: no inserta para quien
--      apago ese tipo (`enabled = false`). Los productores de las 6 verticales no cambian ni una linea.
--   D) restaurantes.sucursal_avisos_config + restaurantes.set_umbral_entrega_tardia: minutos de gracia por
--      sucursal para la alerta de entrega tardia (sin fila = 45, constante documentada en la funcion E).
--   E) restaurantes.avisos_operativos_candidatos: SOLO sistema. Devuelve los pedidos que hoy merecen un aviso
--      (entrega tardia / programado por vencer); la emision (catalogo, dedupe, destinatarios) sigue siendo
--      core.emit_notification desde TypeScript.
--
-- Compatibilidad con la base sin migrar: todo el codigo TypeScript que llama a estas funciones/tablas
-- captura SQLSTATE 42883/42P01/42703 dentro de un SAVEPOINT (runWithSavepointFallback) y degrada a "no
-- disponible aun" / todo encendido. No se elimina ni se cambia ninguna firma existente.
--
-- Justificacion de seguridad (cada tabla, policy, funcion y GRANT trae su razon):
--   * core.notification_preference: RLS habilitada; REVOKE ALL a public/anon; SOLO `grant select` a
--     authenticated con policy `user_id = auth.uid()` (cada usuario ve unicamente las suyas; nunca
--     `using (true)`). NINGUN grant de INSERT/UPDATE/DELETE: las escrituras pasan por la funcion B, porque la
--     autorizacion "owner/admin edita las de su staff" necesita leer core.membership de OTRO usuario y la RLS
--     de core.membership solo deja ver la propia fila (una policy de escritura no podria validarlo).
--     ON DELETE CASCADE por organizacion y usuario (derecho de supresion). CHECK de formato en `tipo`.
--   * core.list_notification_preferences: security definer, search_path fijo, REVOKE a public/anon, GRANT a
--     authenticated. Exige auth.uid() (42501 si es sesion de sistema o anonima) y pertenencia a la
--     organizacion; con `p_todos = true` exige owner/admin y devuelve solo miembros ACTUALES de esa
--     organizacion (cross-tenant: otra organizacion siempre recibe 42501).
--   * core.set_notification_preference: security definer, search_path fijo, REVOKE a public/anon, GRANT a
--     authenticated. auth.uid() es la unica identidad: un usuario edita SOLO las suyas; owner/admin editan
--     las de otro miembro de la MISMA organizacion; un admin no edita las de un owner. El `tipo` debe
--     empezar por el vertical de la organizacion (`restaurantes.`), asi un usuario no siembra filas de otro
--     vertical. Registra updated_by.
--   * core.emit_notification: se conserva EXACTAMENTE la autorizacion de la 0039 (security definer, search_path
--     fijo, REVOKE a public/anon, GRANT a authenticated, sistema o miembro de la organizacion). El filtro
--     nuevo solo REDUCE destinatarios; no ve ni escribe nada que no leyera ya.
--   * restaurantes.sucursal_avisos_config: RLS habilitada; `grant select` a authenticated con policy por
--     membresia en la organizacion de la fila; sin escritura directa (la hace la funcion D, solo owner/admin).
--     `anon` sin ningun acceso.
--   * restaurantes.set_umbral_entrega_tardia: security definer con `set search_path` fijo, REVOKE a
--     public/anon, GRANT a authenticated; exige owner/admin de la organizacion DUENA de la sucursal
--     (derivada de core.property, nunca del llamador) y acota los minutos a 10..240.
--   * restaurantes.avisos_operativos_candidatos: security definer, search_path fijo, REVOKE a public/anon,
--     GRANT a authenticated SOLO por consistencia con el resto de funciones de sistema; la guarda interna
--     `auth.uid() is null` (sesion de sistema) rechaza con 42501 a cualquier usuario, y devuelve un tope de
--     500 filas por llamada. Solo lee; no escribe nada.
--
-- NO escribe datos, NO toca produccion, NO programa ningun cron (reutiliza el tick existente
-- /internal/restaurantes/promover-programados).

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Preferencias por usuario
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists core.notification_preference (
  organization_id uuid not null references core.organization(id) on delete cascade,
  user_id uuid not null references core.staff_user(id) on delete cascade,
  tipo text not null check (tipo ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' and length(tipo) <= 80),
  enabled boolean not null default true,
  sonido boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (organization_id, user_id, tipo)
);

alter table core.notification_preference enable row level security;
revoke all on core.notification_preference from public, anon;
grant select on core.notification_preference to authenticated;

drop policy if exists "usuario ve sus preferencias de notificacion" on core.notification_preference;
create policy "usuario ve sus preferencias de notificacion" on core.notification_preference
  for select to authenticated
  using (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Lectura y escritura por funcion
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.list_notification_preferences(p_organization_id uuid, p_todos boolean default false)
returns table (user_id uuid, tipo text, enabled boolean, sonido boolean)
language plpgsql stable security definer set search_path = core, pg_temp
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'list_notification_preferences: requiere un usuario autenticado' using errcode = '42501';
  end if;
  if not exists (select 1 from core.membership m where m.organization_id = p_organization_id and m.user_id = v_uid) then
    raise exception 'list_notification_preferences: no perteneces a esta organizacion' using errcode = '42501';
  end if;
  if coalesce(p_todos, false) and not exists (
    select 1 from core.membership m where m.organization_id = p_organization_id and m.user_id = v_uid and m.platform_role in ('owner', 'admin')
  ) then
    raise exception 'list_notification_preferences: ver las de todo el equipo requiere owner/admin' using errcode = '42501';
  end if;

  return query
    select np.user_id, np.tipo, np.enabled, np.sonido
    from core.notification_preference np
    where np.organization_id = p_organization_id
      and (np.user_id = v_uid or coalesce(p_todos, false))
      and exists (select 1 from core.membership m where m.organization_id = np.organization_id and m.user_id = np.user_id)
    order by np.user_id, np.tipo;
end;
$$;

revoke all on function core.list_notification_preferences(uuid, boolean) from public, anon;
grant execute on function core.list_notification_preferences(uuid, boolean) to authenticated;

create or replace function core.set_notification_preference(
  p_organization_id uuid,
  p_user_id uuid,
  p_tipo text,
  p_enabled boolean,
  p_sonido boolean
) returns void
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_target uuid := coalesce(p_user_id, auth.uid());
  v_vertical text;
  v_caller_role text;
  v_target_role text;
begin
  if v_uid is null then
    raise exception 'set_notification_preference: requiere un usuario autenticado' using errcode = '42501';
  end if;
  select m.platform_role into v_caller_role from core.membership m where m.organization_id = p_organization_id and m.user_id = v_uid;
  if v_caller_role is null then
    raise exception 'set_notification_preference: no perteneces a esta organizacion' using errcode = '42501';
  end if;
  if v_target <> v_uid then
    if v_caller_role not in ('owner', 'admin') then
      raise exception 'set_notification_preference: editar las de otra persona requiere owner/admin' using errcode = '42501';
    end if;
    select m.platform_role into v_target_role from core.membership m where m.organization_id = p_organization_id and m.user_id = v_target;
    if v_target_role is null then
      raise exception 'set_notification_preference: la persona no pertenece a esta organizacion' using errcode = '42501';
    end if;
    if v_target_role = 'owner' and v_caller_role <> 'owner' then
      raise exception 'set_notification_preference: un admin no edita las de un owner' using errcode = '42501';
    end if;
  end if;
  if p_enabled is null or p_sonido is null then
    raise exception 'set_notification_preference: enabled y sonido son obligatorios' using errcode = '22023';
  end if;
  select o.vertical into v_vertical from core.organization o where o.id = p_organization_id;
  if p_tipo is null or p_tipo !~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' or length(p_tipo) > 80 or v_vertical is null or left(p_tipo, length(v_vertical) + 1) <> v_vertical || '.' then
    raise exception 'set_notification_preference: tipo invalido para esta organizacion' using errcode = '22023';
  end if;

  insert into core.notification_preference (organization_id, user_id, tipo, enabled, sonido, updated_at, updated_by)
  values (p_organization_id, v_target, p_tipo, p_enabled, p_sonido, now(), v_uid)
  on conflict (organization_id, user_id, tipo) do update
    set enabled = excluded.enabled, sonido = excluded.sonido, updated_at = now(), updated_by = v_uid;
end;
$$;

revoke all on function core.set_notification_preference(uuid, uuid, text, boolean, boolean) from public, anon;
grant execute on function core.set_notification_preference(uuid, uuid, text, boolean, boolean) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) core.emit_notification: igual a la 0039 + filtro por preferencia del usuario
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.emit_notification(
  p_organization_id uuid,
  p_property_id uuid,
  p_tipo text,
  p_categoria text,
  p_severidad text,
  p_titulo text,
  p_cuerpo text,
  p_enlace text,
  p_entidad_tipo text,
  p_entidad_id uuid,
  p_dedupe_key text,
  p_roles text[],
  p_expires_in interval
) returns integer
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_vertical text;
  v_slug text;
  v_enlace text := p_enlace;
  v_recipients uuid[];
  v_staff uuid;
  v_inserted integer;
  v_expires interval := coalesce(p_expires_in, interval '90 days');
begin
  if p_dedupe_key is null or length(p_dedupe_key) = 0 then
    raise exception 'emit_notification: la clave de dedupe es obligatoria' using errcode = '22023';
  end if;
  if p_titulo is null or length(p_titulo) = 0 or length(p_titulo) > 160 then
    raise exception 'emit_notification: titulo vacio o de mas de 160 caracteres' using errcode = '22023';
  end if;
  if p_cuerpo is not null and length(p_cuerpo) > 500 then
    raise exception 'emit_notification: cuerpo de mas de 500 caracteres' using errcode = '22023';
  end if;
  -- Misma validacion que los CHECK de la tabla, hecha ANTES de resolver destinatarios: una llamada
  -- invalida falla igual aunque no haya a quien notificar (un productor con bug no pasa desapercibido).
  if p_tipo is null or p_tipo !~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' then
    raise exception 'emit_notification: tipo con formato invalido' using errcode = '22023';
  end if;
  if p_categoria is null or p_categoria !~ '^[a-z][a-z_]{1,39}$' then
    raise exception 'emit_notification: categoria con formato invalido' using errcode = '22023';
  end if;
  if coalesce(p_severidad, 'info') not in ('info', 'atencion', 'critica') then
    raise exception 'emit_notification: severidad fuera de catalogo' using errcode = '22023';
  end if;
  if p_enlace is not null and (p_enlace !~ '^/[A-Za-z0-9_{][A-Za-z0-9_{}/.?&=#%:@+~-]*$' or length(p_enlace) > 300) then
    raise exception 'emit_notification: el enlace debe ser una ruta interna relativa' using errcode = '22023';
  end if;
  if v_expires <= interval '0' or v_expires > interval '365 days' then
    raise exception 'emit_notification: la vigencia debe estar entre 0 y 365 dias' using errcode = '22023';
  end if;

  if p_organization_id is null then
    -- Notificacion de PLATAFORMA: sesion de sistema o superadmin real.
    if v_uid is not null and not exists (select 1 from core.platform_superadmin where staff_user_id = v_uid) then
      raise exception 'emit_notification: solo el sistema o un superadmin emiten notificaciones de plataforma' using errcode = '42501';
    end if;
    select coalesce(array_agg(sa.staff_user_id), '{}') into v_recipients from core.platform_superadmin sa;
  else
    select o.vertical, o.slug into v_vertical, v_slug from core.organization o where o.id = p_organization_id;
    if v_vertical is null then
      raise exception 'emit_notification: organizacion inexistente' using errcode = 'P0002';
    end if;
    if v_uid is not null
       and not exists (select 1 from core.membership m where m.user_id = v_uid and m.organization_id = p_organization_id)
       and not exists (select 1 from core.platform_superadmin where staff_user_id = v_uid) then
      raise exception 'emit_notification: el usuario no pertenece a la organizacion' using errcode = '42501';
    end if;
    if p_property_id is not null
       and not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
      raise exception 'emit_notification: la propiedad no pertenece a la organizacion' using errcode = '22023';
    end if;
    -- El marcador {orgSlug} del enlace se resuelve aqui con el slug real de la organizacion: el
    -- productor no necesita conocerlo y el enlace nunca lleva un dato que no salga de la base.
    v_enlace := replace(p_enlace, '{orgSlug}', v_slug);
    select coalesce(array_agg(m.user_id), '{}') into v_recipients
    from core.membership m
    where m.organization_id = p_organization_id
      and (m.platform_role in ('owner', 'admin') or (p_roles is not null and m.vertical_role = any (p_roles)))
      and (p_property_id is null or m.property_ids is null or p_property_id = any (m.property_ids))
      -- R-16: quien apago este tipo de aviso en sus preferencias no lo recibe (sin fila = encendido).
      and not exists (
        select 1 from core.notification_preference np
        where np.organization_id = m.organization_id and np.user_id = m.user_id and np.tipo = p_tipo and np.enabled = false
      );
  end if;

  v_inserted := 0;
  foreach v_staff in array v_recipients loop
    -- Retencion: vencidas o de mas de 180 dias de ESTE destinatario (acotado, usa el indice).
    delete from core.notification
    where id in (
      select n.id from core.notification n
      where n.staff_user_id = v_staff
        and (n.expires_at < now() or n.created_at < now() - interval '180 days')
      limit 200
    );

    -- Tope de volumen: maximo 100 por destinatario por hora.
    if (select count(*) from core.notification x where x.staff_user_id = v_staff and x.created_at > now() - interval '1 hour') >= 100 then
      continue;
    end if;

    insert into core.notification (
      staff_user_id, organization_id, vertical, tipo, categoria, severidad, titulo, cuerpo, enlace,
      entidad_tipo, entidad_id, dedupe_key, expires_at
    ) values (
      v_staff, p_organization_id, v_vertical, p_tipo, p_categoria, coalesce(p_severidad, 'info'), p_titulo, p_cuerpo, v_enlace,
      p_entidad_tipo, p_entidad_id, p_dedupe_key, now() + v_expires
    )
    on conflict (staff_user_id, dedupe_key) where dedupe_key is not null do nothing;
    if found then
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return v_inserted;
end;
$$;

revoke all on function core.emit_notification(uuid, uuid, text, text, text, text, text, text, text, uuid, text, text[], interval) from public, anon;
grant execute on function core.emit_notification(uuid, uuid, text, text, text, text, text, text, text, uuid, text, text[], interval) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Umbral de entrega tardia por sucursal
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists restaurantes.sucursal_avisos_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  entrega_tardia_min integer not null check (entrega_tardia_min between 10 and 240),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table restaurantes.sucursal_avisos_config enable row level security;
revoke all on restaurantes.sucursal_avisos_config from public, anon;
grant select on restaurantes.sucursal_avisos_config to authenticated;

drop policy if exists "staff ve el umbral de avisos de su organizacion" on restaurantes.sucursal_avisos_config;
create policy "staff ve el umbral de avisos de su organizacion" on restaurantes.sucursal_avisos_config
  for select to authenticated
  using (exists (
    select 1 from core.membership m
    where m.organization_id = sucursal_avisos_config.organization_id and m.user_id = auth.uid()
  ));

create or replace function restaurantes.set_umbral_entrega_tardia(p_property_id uuid, p_minutos integer)
returns void
language plpgsql security definer set search_path = restaurantes, core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
begin
  if v_uid is null then
    raise exception 'set_umbral_entrega_tardia: requiere un usuario autenticado' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'restaurantes';
  if v_org is null or not exists (
    select 1 from core.membership m where m.organization_id = v_org and m.user_id = v_uid and m.platform_role in ('owner', 'admin')
  ) then
    raise exception 'set_umbral_entrega_tardia: requiere owner/admin de la organizacion de la sucursal' using errcode = '42501';
  end if;
  if p_minutos is null or p_minutos < 10 or p_minutos > 240 then
    raise exception 'set_umbral_entrega_tardia: los minutos deben estar entre 10 y 240' using errcode = '22023';
  end if;

  insert into restaurantes.sucursal_avisos_config (property_id, organization_id, entrega_tardia_min, updated_at, updated_by)
  values (p_property_id, v_org, p_minutos, now(), v_uid)
  on conflict (property_id) do update
    set entrega_tardia_min = excluded.entrega_tardia_min, updated_at = now(), updated_by = v_uid;
end;
$$;

revoke all on function restaurantes.set_umbral_entrega_tardia(uuid, integer) from public, anon;
grant execute on function restaurantes.set_umbral_entrega_tardia(uuid, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- E) Candidatos de las alertas operativas (solo sistema)
-- ═══════════════════════════════════════════════════════════════════════════
-- Entrega tardia: pedido en `preparando`/`en_camino` cuya hora prometida ya paso. Hora prometida =
--   estimated_delivery_at (la captura el staff al despachar) o, si no hay, hora_recogida (recoger) o, si no hay,
--   (programado_para o created_at) + umbral de la sucursal (default 45 min). Solo se avisa de pedidos cuya hora
--   prometida cayo en las ultimas 24 h (un pedido olvidado de hace dias no inunda cada barrido).
-- Programado por vencer: (a) sigue en `programado` aunque ya paso la hora de promocion por mas de 10 min (la
--   promocion es 30 min antes de la hora; aqui quedan <= 20) o (b) ya entro a cocina, la hora programada llega
--   en < 30 min (o paso hace menos de 60) y un pedido a domicilio no tiene repartidor asignado.
-- Idempotencia: este candidato NO guarda estado; la clave de dedupe (id del pedido) en core.emit_notification
-- garantiza UNA alerta por pedido por tipo, y la ventana de 24 h acota el reintento.
create or replace function restaurantes.avisos_operativos_candidatos(p_now timestamptz default null)
returns table (tipo text, order_id uuid, organization_id uuid, property_id uuid, order_number bigint)
language plpgsql stable security definer set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_now timestamptz := coalesce(p_now, now());
begin
  if auth.uid() is not null then
    raise exception 'avisos_operativos_candidatos es solo para la sesion de sistema' using errcode = '42501';
  end if;

  return query
  select * from (
    select 'restaurantes.pedido.entrega_tardia'::text as tipo, o.id as order_id, o.organization_id, o.property_id, o.order_number
    from restaurantes.orders o
    left join restaurantes.sucursal_avisos_config c on c.property_id = o.property_id
    where o.status in ('preparando', 'en_camino')
      and coalesce(o.estimated_delivery_at, o.hora_recogida, coalesce(o.programado_para, o.created_at) + make_interval(mins => coalesce(c.entrega_tardia_min, 45))) < v_now
      and coalesce(o.estimated_delivery_at, o.hora_recogida, coalesce(o.programado_para, o.created_at) + make_interval(mins => coalesce(c.entrega_tardia_min, 45))) > v_now - interval '24 hours'
    union all
    select 'restaurantes.pedido.programado_por_vencer'::text, o.id, o.organization_id, o.property_id, o.order_number
    from restaurantes.orders o
    where o.programado_para is not null
      and o.programado_para > v_now - interval '24 hours'
      and (
        (o.status = 'programado' and o.programado_para <= v_now + interval '20 minutes')
        or (
          o.status in ('pending', 'preparando')
          and o.assigned_repartidor_id is null
          and coalesce(o.canal, 'domicilio') <> 'recoger'
          and o.programado_para <= v_now + interval '30 minutes'
          and o.programado_para > v_now - interval '60 minutes'
        )
      )
  ) x
  order by x.order_number
  limit 500;
end;
$$;

revoke all on function restaurantes.avisos_operativos_candidatos(timestamptz) from public, anon;
grant execute on function restaurantes.avisos_operativos_candidatos(timestamptz) to authenticated;
