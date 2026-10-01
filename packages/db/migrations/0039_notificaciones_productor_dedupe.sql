-- Notificaciones in-app de punta a punta (parte A, backend): productor compartido, dedupe,
-- severidad/categoria/enlace, expiracion y lectura con filtros.
--
-- Hallazgo de auditoria: la infraestructura de 0013 (core.notification + core.notification_read +
-- 4 funciones de lectura) existe, pero NINGUN codigo escribe en core.notification, asi que la
-- campana esta vacia en las 6 verticales y en superadmin. Esta migracion agrega la pieza que faltaba
-- (un unico punto de escritura) SIN romper nada de 0013:
--
--   A) Columnas nuevas, TODAS opcionales o con default, en core.notification: organization_id, tipo,
--      categoria, severidad (info | atencion | critica), enlace (ruta interna relativa), dedupe_key y
--      expires_at. Las filas ya existentes (si las hubiera) siguen validas.
--   B) core.emit_notification: UNICO productor. Resuelve los destinatarios en la base (nunca los
--      recibe del caller), inserta una fila por destinatario con clave de dedupe (reintentar es no-op),
--      aplica tope de volumen por destinatario y depura filas vencidas de esos mismos destinatarios.
--   C) core.list_notifications_v2_for_staff / core.count_unread_notifications_v2_for_staff: lectura con
--      limite, paginacion por fecha, filtro de no leidas y de categoria; excluyen lo vencido; el
--      contador se resuelve en SQL con el indice (staff_user_id, created_at), sin N+1.
--
-- Las funciones de 0013 (list/count/mark/mark_all) NO se tocan: el estado "leido" sigue siendo
-- core.notification_read por usuario y las dos funciones de marcar siguen siendo las de 0012.
-- Una base sin esta migracion sigue sirviendo la campana como hoy: el API cae a las funciones de 0013
-- y los productores caen a "no disponible" (ver packages/db/src/notificaciones/).
--
-- Justificacion de seguridad (cada columna, indice, funcion y GRANT trae su razon):
--   * Columnas nuevas: la tabla conserva RLS habilitada SIN policy y REVOKE ALL a public/anon/
--     authenticated (0013); nadie escribe ni lee columnas directo, por eso NO hay GRANT a nivel
--     columna que otorgar y nada se otorga a anon. Los CHECK viven en la base (no dependen de
--     TypeScript): formato de tipo/categoria, severidad cerrada, enlace SOLO ruta interna relativa
--     (empieza con '/' seguida de letra, digito o '_'; solo admite letras, digitos y / . ? & = # % : @ + ~ -;
--     sin esquema, sin '//', sin barra invertida, espacios ni comillas: no puede apuntar a otro
--     dominio; el marcador {orgSlug} se sustituye en la base por el slug real), longitudes maximas de titulo/cuerpo/clave. Los dos de longitud de titulo/cuerpo son
--     NOT VALID: se aplican a toda fila nueva sin revalidar historicos.
--   * organization_id con ON DELETE CASCADE: al borrar una organizacion se van sus notificaciones
--     (derecho de supresion); sin FK cruzada de dominio.
--   * Indice unico (staff_user_id, dedupe_key) parcial: la idempotencia la garantiza la base, no un
--     "select y luego insert" con carrera.
--   * core.emit_notification: security definer, set search_path fijo, REVOKE ALL a public y anon, GRANT
--     EXECUTE solo a authenticated; la autorizacion real esta DENTRO: una sesion de sistema
--     (auth.uid() null: crons, agentes, webhooks) puede emitir a cualquier organizacion o a la
--     plataforma; un usuario autenticado SOLO a una organizacion de la que es miembro (o, para
--     notificaciones de plataforma, siendo superadmin); jamas a otra organizacion. El vertical se
--     deriva de la organizacion (no se acepta del caller). Los destinatarios son miembros owner/admin
--     de la organizacion mas los roles de vertical que pida el evento y, si se indica propiedad, solo
--     quienes tienen acceso a ella; la plataforma notifica a core.platform_superadmin. Tope de 100
--     notificaciones por destinatario por hora (anti-inundacion, tambien ante un productor con bug) y
--     retencion: se borran (hasta 200 por destinatario por llamada) las vencidas o de mas de 180 dias.
--   * Las dos funciones v2 de lectura: security definer, search_path fijo, REVOKE ALL a public y anon,
--     GRANT a authenticated; mismo binding que 0012: solo devuelven filas si auth.uid() = p_staff_id
--     (otro usuario recibe cero filas / cero, nunca las de un tercero).
--
-- NO escribe datos, NO toca produccion, NO programa ningun cron.

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Columnas, CHECK e indices
-- ═══════════════════════════════════════════════════════════════════════════
alter table core.notification
  add column organization_id uuid references core.organization(id) on delete cascade,
  add column tipo text,
  add column categoria text,
  add column severidad text not null default 'info',
  add column enlace text,
  add column dedupe_key text,
  add column expires_at timestamptz;

alter table core.notification
  add constraint notification_severidad_chk check (severidad in ('info', 'atencion', 'critica')),
  add constraint notification_tipo_chk check (tipo is null or tipo ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  add constraint notification_categoria_chk check (categoria is null or categoria ~ '^[a-z][a-z_]{1,39}$'),
  add constraint notification_enlace_chk check (enlace is null or (enlace ~ '^/[A-Za-z0-9_][A-Za-z0-9_/.?&=#%:@+~-]*$' and length(enlace) <= 300)),
  add constraint notification_dedupe_key_chk check (dedupe_key is null or length(dedupe_key) between 1 and 200),
  add constraint notification_titulo_len_chk check (length(titulo) <= 160) not valid,
  add constraint notification_cuerpo_len_chk check (cuerpo is null or length(cuerpo) <= 500) not valid;

create unique index notification_dedupe_uidx
  on core.notification (staff_user_id, dedupe_key)
  where dedupe_key is not null;

-- Lectura por no leidas/categoria sin recorrer toda la historia del usuario.
create index notification_staff_categoria_created_idx
  on core.notification (staff_user_id, categoria, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Productor unico
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
      and (p_property_id is null or m.property_ids is null or p_property_id = any (m.property_ids));
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
-- C) Lectura v2
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.list_notifications_v2_for_staff(
  p_staff_id uuid,
  p_limit integer default 50,
  p_before timestamptz default null,
  p_solo_no_leidas boolean default false,
  p_categoria text default null
) returns table (
  id uuid,
  organization_id uuid,
  vertical text,
  tipo text,
  categoria text,
  severidad text,
  titulo text,
  cuerpo text,
  enlace text,
  entidad_tipo text,
  entidad_id uuid,
  created_at timestamptz,
  read_at timestamptz
)
language sql stable security definer set search_path = core, pg_temp
as $$
  select n.id, n.organization_id, n.vertical, n.tipo, n.categoria, n.severidad, n.titulo, n.cuerpo, n.enlace,
         n.entidad_tipo, n.entidad_id, n.created_at, nr.read_at
  from core.notification n
  left join core.notification_read nr on nr.notification_id = n.id and nr.staff_user_id = p_staff_id
  where auth.uid() is not null and auth.uid() = p_staff_id
    and n.staff_user_id = p_staff_id
    and (n.expires_at is null or n.expires_at > now())
    and (p_before is null or n.created_at < p_before)
    and (p_categoria is null or n.categoria = p_categoria)
    and (not coalesce(p_solo_no_leidas, false) or nr.notification_id is null)
  order by n.created_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

revoke all on function core.list_notifications_v2_for_staff(uuid, integer, timestamptz, boolean, text) from public, anon;
grant execute on function core.list_notifications_v2_for_staff(uuid, integer, timestamptz, boolean, text) to authenticated;

create or replace function core.count_unread_notifications_v2_for_staff(p_staff_id uuid)
returns integer
language sql stable security definer set search_path = core, pg_temp
as $$
  select count(*)::integer
  from core.notification n
  where auth.uid() is not null and auth.uid() = p_staff_id
    and n.staff_user_id = p_staff_id
    and (n.expires_at is null or n.expires_at > now())
    and not exists (
      select 1 from core.notification_read nr
      where nr.notification_id = n.id and nr.staff_user_id = p_staff_id
    );
$$;

revoke all on function core.count_unread_notifications_v2_for_staff(uuid) from public, anon;
grant execute on function core.count_unread_notifications_v2_for_staff(uuid) to authenticated;
