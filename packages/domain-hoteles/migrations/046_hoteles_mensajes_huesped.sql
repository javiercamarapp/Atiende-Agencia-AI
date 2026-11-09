-- 046 -- H-P3-03 (paridad3): el huesped se entera de todo el viaje sin que nadie escriba a mano.
--
-- Contenido (todo nuevo, nada existente se redefine):
--   A) hoteles.mensaje_huesped_config  -- por propiedad y evento: activo, horas de pre-llegada, enlace de resena.
--   B) hoteles.mensaje_huesped_envio   -- bitacora + marca de idempotencia por (referencia, evento): que canal salio o por que no.
--   C) Funciones de SOLO SISTEMA del cron: candidatos del dia, emitir (marca + outbox en UNA sentencia atomica), vincular slug del aviso.
--   D) hoteles.historial_mensajes_huesped -- lectura para el staff (con el estado real del outbox).
--   E) Retencion: clase core.retention_class 'hoteles_whatsapp_conversaciones' y su ejecutor
--      hoteles.system_run_retention_conversaciones. NO se redefine core.system_run_retention_purge (otro PR abierto la reescribe
--      y una segunda copia pisaria sus cambios): el ejecutor de hoteles es una funcion propia que el repositorio de privacidad de
--      plataforma (packages/db) invoca para esta clase, con el mismo bloqueo legal y el mismo registro en core.purge_run_log.
--
-- Eventos: hold.aprobado | hold.rechazado | hold.confirmado | hold.vencido | reserva.confirmada | pre_llegada | post_estancia |
-- lista_espera.ofrecida. Todos se DERIVAN del estado real de la fila origen (hold, reserva, entrada de lista de espera) y de su
-- instante de disparo; no hay cola paralela que pueda desincronizarse. Una referencia recibe a lo mucho UN mensaje por evento
-- (unique de la bitacora) aunque el cron corra dos veces o dos instancias a la vez. Un evento solo es elegible mientras
-- disparo <= ahora < disparo + 24 h: nunca se manda un aviso viejo (p. ej. historial tras activar el modulo).
--
-- Activacion por omision (sin fila de configuracion): ENCENDIDOS los que responden a algo que el propio huesped hizo o espera
-- (hold.*, reserva.confirmada, lista_espera.ofrecida); APAGADOS los proactivos (pre_llegada, post_estancia) hasta que gerencia
-- los configure.
--
-- Requiere: 001 (core.property, hoteles.reservation/guest), 004 (whatsapp_channel_config, whatsapp_inbound_events), 008 (messaging_outbox
-- y su enqueue), 030 (property_config.timezone), 035 (agent_guardrail ventana de envio, can_view_agents/can_manage_agents), 037
-- (booking_hold), 041 (waitlist_entry), core 0036 (retention_class, purge_hold, purge_run_log, _retention_effective).
--
-- ---------------------------------------------------------------------------------------------------------------
-- Justificacion de seguridad (cada tabla, GRANT, policy y funcion trae su razon)
-- ---------------------------------------------------------------------------------------------------------------
--   * mensaje_huesped_config: RLS habilitado. SELECT para quien ve agentes (hoteles.can_view_agents: owner, gm, frontdesk,
--     reservations, accountant); INSERT/UPDATE solo hoteles.can_manage_agents (owner, gm: programar mensajes al huesped es una
--     decision de gerencia, mismo criterio que guardrails y politicas de agentes). Sin policy de DELETE: apagar = activo false.
--     GRANT a `authenticated` a nivel COLUMNA (property_id, evento, activo, horas_antes, resena_url al insertar; activo, horas_antes,
--     resena_url al actualizar): organization_id, actualizado_por y las marcas de tiempo las pone el trigger (security definer), el
--     cliente jamas las manda, de modo que no puede moverse una fila a otra organizacion ni falsear el autor. Nada a anon.
--     El enlace de resena debe ser https (check) y solo existe para post_estancia; las horas solo para pre_llegada.
--   * mensaje_huesped_envio: RLS habilitado, SELECT para can_view_agents. NINGUN GRANT de escritura a authenticated: la escribe
--     solo hoteles.sistema_emitir_mensaje_huesped (solo sistema). No guarda texto ni contacto del huesped: solo evento, referencia,
--     canal, motivo codificado y el id del outbox.
--   * sistema_candidatos_mensajes_huesped / sistema_emitir_mensaje_huesped / sistema_slug_aviso: security definer, search_path fijo,
--     revoke de public y anon, GRANT a authenticated (la sesion de sistema usa ese rol con sub vacio) y guard `auth.uid() is null`
--     -> 42501. Razon: leen y escriben a traves de TODOS los tenants (el cron barre la plataforma) y encolan mensajes; un usuario de
--     staff, aun owner, no debe poder invocarlas con efecto. Devuelven o escriben solo lo que el cron necesita.
--   * historial_mensajes_huesped: security definer, search_path fijo, GRANT a authenticated, guard por hoteles.can_view_agents
--     (sin permiso devuelve CERO filas: no revela si la propiedad existe). Necesita ser definer porque une la bitacora con
--     messaging_outbox, que ningun rol de la aplicacion puede leer; devuelve solo el estado y la clase de error del outbox, nunca
--     su payload (que lleva telefono o correo y el texto).
--   * system_run_retention_conversaciones: security definer, search_path fijo, guard `auth.uid() is null`, GRANT a authenticated.
--     Antes de tocar nada consulta core.purge_hold (retencion legal activa) y deja cada llamada, incluso bloqueada o simulada, en
--     core.purge_run_log (append-only, sin PII). Vacia el texto y conserva la fila y su vinculo al ticket o hold; protege a todo
--     titular con una solicitud ARCO abierta.
--
-- Orden de despliegue: CUALQUIERA. El codigo TypeScript captura 42883/42P01/42703 con SAVEPOINT y cae a un vacio honesto
-- ("mensajes automaticos no disponibles aun") sin romper ningun flujo vigente. Esta migracion no cambia ninguna funcion existente.

-- ---------------------------------------------------------------------------------------------------------------
-- A) Configuracion por propiedad y evento
-- ---------------------------------------------------------------------------------------------------------------
create table hoteles.mensaje_huesped_config (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  evento text not null check (evento in ('hold.aprobado', 'hold.rechazado', 'hold.confirmado', 'hold.vencido', 'reserva.confirmada', 'pre_llegada', 'post_estancia', 'lista_espera.ofrecida')),
  activo boolean not null,
  -- Solo pre_llegada: horas ANTES del check-in (00:00 de la zona de la propiedad). Sin valor rige el defecto de 48 h.
  horas_antes integer check (horas_antes is null or horas_antes between 1 and 336),
  -- Solo post_estancia: enlace https de resena que se agrega al agradecimiento.
  resena_url text check (resena_url is null or (resena_url ~ '^https://[^[:space:]]+$' and char_length(resena_url) <= 500)),
  actualizado_por uuid references core.staff_user(id) on delete set null,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (property_id, evento),
  check (horas_antes is null or evento = 'pre_llegada'),
  check (resena_url is null or evento = 'post_estancia')
);
create index mensaje_huesped_config_org_idx on hoteles.mensaje_huesped_config (organization_id);

-- Deriva organization_id de la propiedad (nunca confia en el cliente) y sella autor y hora. Definer para leer core.property sin
-- depender de las policies de quien escribe; solo toca NEW.
create or replace function hoteles.mensaje_huesped_config_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, core, pg_temp as $$
declare
  v_org uuid;
begin
  select p.organization_id into v_org from core.property p where p.id = new.property_id;
  if v_org is null then
    raise exception 'mensaje_huesped_config: la propiedad no existe' using errcode = '23503';
  end if;
  new.organization_id := v_org;
  new.actualizado_por := auth.uid();
  new.actualizado_en := now();
  if tg_op = 'UPDATE' then
    new.creado_en := old.creado_en;
  end if;
  return new;
end;
$$;
revoke all on function hoteles.mensaje_huesped_config_guard() from public, anon, authenticated;
create trigger mensaje_huesped_config_guard before insert or update on hoteles.mensaje_huesped_config
  for each row execute function hoteles.mensaje_huesped_config_guard();

alter table hoteles.mensaje_huesped_config enable row level security;
create policy "mensajes huesped: staff de agentes ve la configuracion" on hoteles.mensaje_huesped_config for select
  using (hoteles.can_view_agents(property_id));
create policy "mensajes huesped: owner/gm programa" on hoteles.mensaje_huesped_config for insert
  with check (hoteles.can_manage_agents(property_id));
create policy "mensajes huesped: owner/gm edita" on hoteles.mensaje_huesped_config for update
  using (hoteles.can_manage_agents(property_id))
  with check (hoteles.can_manage_agents(property_id));
revoke all on hoteles.mensaje_huesped_config from public, anon, authenticated;
grant select on hoteles.mensaje_huesped_config to authenticated;
grant insert (property_id, evento, activo, horas_antes, resena_url) on hoteles.mensaje_huesped_config to authenticated;
grant update (activo, horas_antes, resena_url) on hoteles.mensaje_huesped_config to authenticated;
grant select, insert, update, delete on hoteles.mensaje_huesped_config to service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- B) Bitacora e idempotencia de envios
-- ---------------------------------------------------------------------------------------------------------------
create table hoteles.mensaje_huesped_envio (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  evento text not null check (evento in ('hold.aprobado', 'hold.rechazado', 'hold.confirmado', 'hold.vencido', 'reserva.confirmada', 'pre_llegada', 'post_estancia', 'lista_espera.ofrecida')),
  ref_tipo text not null check (ref_tipo in ('hold', 'reserva', 'lista_espera')),
  ref_id uuid not null,
  estado text not null check (estado in ('encolado', 'no_enviado')),
  canal text check (canal in ('whatsapp', 'email')),
  -- Por que NO salio: sin_contacto (ni telefono ni correo), baja_whatsapp (el telefono pidio BAJA y no hay correo), sin_plantilla (hay
  -- telefono pero no hay plantilla aprobada en el catalogo ni correo), whatsapp_no_disponible (canal sin configurar o sin credencial de
  -- Meta y sin correo), correo_suprimido (el correo esta en la lista de supresion y no hay otro canal).
  motivo text check (motivo in ('sin_contacto', 'baja_whatsapp', 'sin_plantilla', 'whatsapp_no_disponible', 'correo_suprimido')),
  outbox_id uuid references hoteles.messaging_outbox(id) on delete set null,
  creado_en timestamptz not null default now(),
  -- Idempotencia: UN mensaje por (referencia, evento), aunque dos instancias del cron corran a la vez.
  unique (property_id, ref_tipo, ref_id, evento),
  check ((estado = 'encolado') = (canal is not null)),
  check ((estado = 'no_enviado') = (motivo is not null)),
  check ((evento like 'hold.%' and ref_tipo = 'hold') or (evento in ('reserva.confirmada', 'pre_llegada', 'post_estancia') and ref_tipo = 'reserva') or (evento = 'lista_espera.ofrecida' and ref_tipo = 'lista_espera'))
);
create index mensaje_huesped_envio_property_idx on hoteles.mensaje_huesped_envio (property_id, creado_en desc);

alter table hoteles.mensaje_huesped_envio enable row level security;
create policy "mensajes huesped: staff de agentes ve la bitacora" on hoteles.mensaje_huesped_envio for select
  using (hoteles.can_view_agents(property_id));
revoke all on hoteles.mensaje_huesped_envio from public, anon, authenticated;
grant select on hoteles.mensaje_huesped_envio to authenticated;
grant select, insert, update, delete on hoteles.mensaje_huesped_envio to service_role;

-- Busqueda del ultimo entrante de un telefono (ventana de 24 h de Meta): el cron la hace por (propiedad, hash).
create index if not exists whatsapp_inbound_events_phone_claimed_idx on hoteles.whatsapp_inbound_events (property_id, phone_hash, claimed_at desc);

-- ---------------------------------------------------------------------------------------------------------------
-- C) Funciones de SOLO SISTEMA
-- ---------------------------------------------------------------------------------------------------------------

-- Candidatos: referencias cuyo evento esta ACTIVO, cuyo instante de disparo cae en (ahora - 24 h, ahora] y que aun no tienen marca.
-- p_property_id / p_ref_id acotan la consulta (disparo inmediato tras una decision del staff y revalidacion antes de emitir).
-- El instante de disparo: holds y reserva.confirmada y lista_espera = el instante del cambio de estado; pre_llegada = check-in a las
-- 00:00 de la zona de la propiedad menos horas_antes (48 por omision); post_estancia = check-out a las 12:00 de esa zona.
-- Zona invalida o ausente -> America/Mexico_City (mismo defecto de plataforma). Ventana de envio de agent_guardrail (08:00-21:00 por
-- omision) en las columnas ventana_*: el cron decide con ella si manda ahora o lo deja para la siguiente corrida.
create or replace function hoteles.sistema_candidatos_mensajes_huesped(p_ahora timestamptz, p_limite integer default 100, p_property_id uuid default null, p_ref_id uuid default null)
returns table (
  evento text, ref_tipo text, ref_id uuid, organization_id uuid, property_id uuid,
  propiedad_nombre text, org_slug text, zona_horaria text,
  huesped_nombre text, telefono text, correo text,
  llegada date, salida date, total_centavos bigint, vence_en timestamptz,
  disparo_en timestamptz,
  phone_number_id text, whatsapp_habilitado boolean, ultima_entrada_en timestamptz,
  ventana_inicio text, ventana_fin text,
  resena_url text, horas_antes integer
)
language plpgsql stable security definer
set search_path = pg_catalog, hoteles, core, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is not null then
    raise exception 'sistema_candidatos_mensajes_huesped: solo sesion de sistema' using errcode = '42501';
  end if;
  if p_limite is null or p_limite < 1 then p_limite := 1; end if;
  if p_limite > 500 then p_limite := 500; end if;

  return query
  with zonas as materialized (select n.name from pg_catalog.pg_timezone_names n),
  refs as (
    select 'hold.aprobado'::text as evento, 'hold'::text as ref_tipo, h.id as ref_id, h.organization_id, h.property_id,
           h.guest_name as nombre, h.contact_phone as telefono, null::text as correo,
           h.check_in_date as llegada, h.check_out_date as salida, h.total_cents as total, h.expires_at as vence,
           h.decided_at as base_en, null::date as ancla
      from hoteles.booking_hold h
     where h.status = 'aprobado' and h.decided_at is not null and h.decided_at > p_ahora - interval '25 hours'
       and (p_property_id is null or h.property_id = p_property_id) and (p_ref_id is null or h.id = p_ref_id)
    union all
    select 'hold.rechazado', 'hold', h.id, h.organization_id, h.property_id, h.guest_name, h.contact_phone, null::text,
           h.check_in_date, h.check_out_date, h.total_cents, h.expires_at, h.decided_at, null::date
      from hoteles.booking_hold h
     where h.status = 'rechazado' and h.decided_at is not null and h.decided_at > p_ahora - interval '25 hours'
       and (p_property_id is null or h.property_id = p_property_id) and (p_ref_id is null or h.id = p_ref_id)
    union all
    select 'hold.confirmado', 'hold', h.id, h.organization_id, h.property_id, h.guest_name, h.contact_phone,
           (select g.email from hoteles.reservation r join hoteles.guest g on g.id = r.guest_id where r.id = h.reservation_id),
           h.check_in_date, h.check_out_date, h.total_cents, h.expires_at, h.updated_at, null::date
      from hoteles.booking_hold h
     where h.status = 'confirmado' and h.updated_at > p_ahora - interval '25 hours'
       and (p_property_id is null or h.property_id = p_property_id) and (p_ref_id is null or h.id = p_ref_id)
    union all
    select 'hold.vencido', 'hold', h.id, h.organization_id, h.property_id, h.guest_name, h.contact_phone, null::text,
           h.check_in_date, h.check_out_date, h.total_cents, h.expires_at, h.updated_at, null::date
      from hoteles.booking_hold h
     where h.status = 'expirado' and h.updated_at > p_ahora - interval '25 hours'
       and (p_property_id is null or h.property_id = p_property_id) and (p_ref_id is null or h.id = p_ref_id)
    union all
    -- Una reserva que nace de un hold confirmado se avisa con hold.confirmado: no se duplica.
    select 'reserva.confirmada', 'reserva', r.id, r.organization_id, r.property_id, g.full_name, g.phone, g.email,
           r.check_in_date, r.check_out_date, null::bigint, null::timestamptz, r.created_at, null::date
      from hoteles.reservation r left join hoteles.guest g on g.id = r.guest_id
     where r.status in ('confirmada', 'check_in', 'en_estancia') and r.created_at > p_ahora - interval '25 hours'
       and not exists (select 1 from hoteles.booking_hold h where h.reservation_id = r.id)
       and (p_property_id is null or r.property_id = p_property_id) and (p_ref_id is null or r.id = p_ref_id)
    union all
    select 'pre_llegada', 'reserva', r.id, r.organization_id, r.property_id, g.full_name, g.phone, g.email,
           r.check_in_date, r.check_out_date, null::bigint, null::timestamptz, null::timestamptz, r.check_in_date
      from hoteles.reservation r left join hoteles.guest g on g.id = r.guest_id
     where r.status = 'confirmada' and r.check_in_date between (p_ahora::date - 2) and (p_ahora::date + 16)
       and (p_property_id is null or r.property_id = p_property_id) and (p_ref_id is null or r.id = p_ref_id)
    union all
    select 'post_estancia', 'reserva', r.id, r.organization_id, r.property_id, g.full_name, g.phone, g.email,
           r.check_in_date, r.check_out_date, null::bigint, null::timestamptz, null::timestamptz, r.check_out_date
      from hoteles.reservation r left join hoteles.guest g on g.id = r.guest_id
     where r.status in ('check_out', 'cerrada') and r.check_out_date between (p_ahora::date - 3) and (p_ahora::date + 1)
       and (p_property_id is null or r.property_id = p_property_id) and (p_ref_id is null or r.id = p_ref_id)
    union all
    select 'lista_espera.ofrecida', 'lista_espera', w.id, w.organization_id, w.property_id, w.guest_name, w.contact_phone, w.contact_email,
           w.check_in_date, w.check_out_date, null::bigint, w.offer_expires_at, w.offered_at, null::date
      from hoteles.waitlist_entry w
     where w.status = 'ofrecida' and w.offered_at is not null and w.offered_at > p_ahora - interval '25 hours' and w.offer_expires_at > p_ahora
       and (p_property_id is null or w.property_id = p_property_id) and (p_ref_id is null or w.id = p_ref_id)
  )
  select x.evento, x.ref_tipo, x.ref_id, x.organization_id, x.property_id,
         p.name, o.slug, z.tz,
         x.nombre, x.telefono, x.correo,
         x.llegada, x.salida, x.total, x.vence,
         d.disparo,
         wc.phone_number_id, coalesce(wc.enabled, false),
         case when x.telefono is null then null else (
           select max(ev.claimed_at) from hoteles.whatsapp_inbound_events ev
            where ev.property_id = x.property_id
              and ev.phone_hash = any (array[
                    encode(pg_catalog.sha256(pg_catalog.convert_to(x.telefono, 'UTF8')), 'hex'),
                    encode(pg_catalog.sha256(pg_catalog.convert_to('+' || regexp_replace(x.telefono, '\D', '', 'g'), 'UTF8')), 'hex'),
                    encode(pg_catalog.sha256(pg_catalog.convert_to(regexp_replace(x.telefono, '\D', '', 'g'), 'UTF8')), 'hex')
                  ])
         ) end,
         coalesce(gr.send_window_start, '08:00'::time)::text, coalesce(gr.send_window_end, '21:00'::time)::text,
         c.resena_url, c.horas_antes
    from refs x
    join core.property p on p.id = x.property_id
    join core.organization o on o.id = x.organization_id
    left join hoteles.property_config pc on pc.property_id = x.property_id
    left join zonas zv on zv.name = pc.timezone
    cross join lateral (select coalesce(zv.name, 'America/Mexico_City') as tz) z
    left join hoteles.mensaje_huesped_config c on c.property_id = x.property_id and c.evento = x.evento
    left join hoteles.agent_guardrail gr on gr.property_id = x.property_id
    left join hoteles.whatsapp_channel_config wc on wc.property_id = x.property_id
    cross join lateral (
      select case x.evento
               when 'pre_llegada' then (x.ancla::timestamp - pg_catalog.make_interval(hours => coalesce(c.horas_antes, 48))) at time zone z.tz
               when 'post_estancia' then (x.ancla::timestamp + interval '12 hours') at time zone z.tz
               else x.base_en
             end as disparo
    ) d
   where coalesce(c.activo, x.evento not in ('pre_llegada', 'post_estancia'))
     and d.disparo <= p_ahora and d.disparo > p_ahora - interval '24 hours'
     and not exists (
       select 1 from hoteles.mensaje_huesped_envio e
        where e.property_id = x.property_id and e.ref_tipo = x.ref_tipo and e.ref_id = x.ref_id and e.evento = x.evento
     )
   order by d.disparo asc, x.ref_id asc
   limit p_limite;
end;
$$;
revoke all on function hoteles.sistema_candidatos_mensajes_huesped(timestamptz, integer, uuid, uuid) from public, anon;
grant execute on function hoteles.sistema_candidatos_mensajes_huesped(timestamptz, integer, uuid, uuid) to authenticated;

-- Emite: toma la marca de idempotencia y, si hay canal y payload, encola el mensaje en messaging_outbox, TODO en la misma transaccion. Devuelve el
-- id de la marca, o NULL si la referencia ya tenia marca para ese evento (otra corrida o instancia gano). Una instancia concurrente que
-- intente el mismo (referencia, evento) espera a que la primera confirme y entonces recibe NULL: nunca hay dos envios.
create or replace function hoteles.sistema_emitir_mensaje_huesped(
  p_property_id uuid, p_evento text, p_ref_tipo text, p_ref_id uuid,
  p_canal text, p_motivo text, p_event_type text, p_dedupe_key text, p_payload jsonb
) returns uuid
language plpgsql security definer set search_path = pg_catalog, hoteles, core, pg_temp as $$
declare
  v_org uuid;
  v_id uuid;
  v_outbox uuid;
begin
  if auth.uid() is not null then
    raise exception 'sistema_emitir_mensaje_huesped: solo sesion de sistema' using errcode = '42501';
  end if;
  if p_evento not in ('hold.aprobado', 'hold.rechazado', 'hold.confirmado', 'hold.vencido', 'reserva.confirmada', 'pre_llegada', 'post_estancia', 'lista_espera.ofrecida')
     or p_ref_tipo not in ('hold', 'reserva', 'lista_espera') or p_ref_id is null then
    raise exception 'sistema_emitir_mensaje_huesped: evento o referencia invalidos' using errcode = '22023';
  end if;
  if (p_canal is null) = (p_motivo is null) then
    raise exception 'sistema_emitir_mensaje_huesped: se exige exactamente uno de canal o motivo' using errcode = '22023';
  end if;
  if p_canal is not null then
    if p_canal not in ('whatsapp', 'email') then
      raise exception 'sistema_emitir_mensaje_huesped: canal invalido' using errcode = '22023';
    end if;
    if p_payload is null then
      -- Unica excepcion: el correo de reserva.confirmada lo cubre el correo transaccional de la propia reserva (se marca, no se encola otro).
      if p_canal <> 'email' or p_evento <> 'reserva.confirmada' then
        raise exception 'sistema_emitir_mensaje_huesped: payload requerido' using errcode = '22023';
      end if;
    elsif jsonb_typeof(p_payload) <> 'object' or pg_catalog.octet_length(p_payload::text) > 16384 or p_event_type is null or p_dedupe_key is null then
      raise exception 'sistema_emitir_mensaje_huesped: payload invalido' using errcode = '22023';
    end if;
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id;
  if v_org is null then
    return null;
  end if;

  insert into hoteles.mensaje_huesped_envio (organization_id, property_id, evento, ref_tipo, ref_id, estado, canal, motivo)
  values (v_org, p_property_id, p_evento, p_ref_tipo, p_ref_id, case when p_canal is not null then 'encolado' else 'no_enviado' end, p_canal, p_motivo)
  on conflict (property_id, ref_tipo, ref_id, evento) do nothing
  returning id into v_id;
  if v_id is null then
    return null;
  end if;

  if p_canal is not null and p_payload is not null then
    v_outbox := hoteles.enqueue_messaging_outbox(p_property_id, v_org, p_canal, p_event_type, p_dedupe_key, p_payload);
    update hoteles.mensaje_huesped_envio set outbox_id = v_outbox where id = v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function hoteles.sistema_emitir_mensaje_huesped(uuid, text, text, uuid, text, text, text, text, jsonb) from public, anon;
grant execute on function hoteles.sistema_emitir_mensaje_huesped(uuid, text, text, uuid, text, text, text, text, jsonb) to authenticated;

-- Slug publico de la organizacion de una propiedad de hoteles (para el enlace del aviso de privacidad del primer contacto). Solo sistema.
create or replace function hoteles.sistema_slug_aviso(p_property_id uuid)
returns text language plpgsql stable security definer set search_path = pg_catalog, core, pg_temp as $$
declare
  v_slug text;
begin
  if auth.uid() is not null then
    raise exception 'sistema_slug_aviso: solo sesion de sistema' using errcode = '42501';
  end if;
  select o.slug into v_slug from core.property p join core.organization o on o.id = p.organization_id where p.id = p_property_id and o.vertical = 'hoteles';
  return v_slug;
end;
$$;
revoke all on function hoteles.sistema_slug_aviso(uuid) from public, anon;
grant execute on function hoteles.sistema_slug_aviso(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- D) Historial para el staff
-- ---------------------------------------------------------------------------------------------------------------
create or replace function hoteles.historial_mensajes_huesped(p_property_id uuid, p_limite integer default 50)
returns table (out_id uuid, out_evento text, out_ref_tipo text, out_ref_id uuid, out_estado text, out_canal text, out_motivo text, out_envio text, out_error_clase text, out_creado_en timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, hoteles, core, pg_temp as $$
declare
  v_limite integer := least(greatest(coalesce(p_limite, 50), 1), 200);
begin
  if auth.uid() is null or not hoteles.can_view_agents(p_property_id) then
    return;
  end if;
  return query
    select e.id, e.evento, e.ref_tipo, e.ref_id, e.estado, e.canal, e.motivo, o.status, o.last_error_class, e.creado_en
      from hoteles.mensaje_huesped_envio e
      left join hoteles.messaging_outbox o on o.id = e.outbox_id
     where e.property_id = p_property_id
     order by e.creado_en desc, e.id
     limit v_limite;
end;
$$;
revoke all on function hoteles.historial_mensajes_huesped(uuid, integer) from public, anon;
grant execute on function hoteles.historial_mensajes_huesped(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- E) Retencion de las conversaciones de WhatsApp de hoteles
-- ---------------------------------------------------------------------------------------------------------------
-- Mismos dias por omision y mismos limites que restaurantes_whatsapp_conversaciones (180 / 30 / 1095). Ejecutor 'plataforma': el cron
-- de plataforma (/internal/plataforma/privacidad-retencion) la recorre con la politica de cada organizacion (core.retention_policy).
insert into core.retention_class (data_class, vertical, description, default_days, min_days, max_days, executor) values
  ('hoteles_whatsapp_conversaciones', 'hoteles', 'Mensajes de las conversaciones de WhatsApp de huespedes, eventos entrantes y mensajes enviados del outbox; al vencer se vacia el texto y se conservan la fila y su vinculo al ticket o hold.', 180, 30, 1095, 'plataforma')
on conflict (data_class) do nothing;

-- Ejecutor. Devuelve las mismas columnas que core.system_run_retention_purge para que el repositorio las trate igual.
--   * conversaciones (hoteles.whatsapp_conversations): messages -> '[]' cuando updated_at < corte. Se PROTEGEN (no se vacian) las de un
--     telefono con una solicitud ARCO abierta (recibida, en_revision o procedente) en la misma propiedad.
--   * outbox enviado (hoteles.messaging_outbox con status sent o dead y created_at < corte): payload -> {"purgado": true}. Se conserva
--     la fila (dedupe, estado, intentos). Los pendientes no se tocan.
--   * eventos entrantes (hoteles.whatsapp_inbound_events) solo guardan id, hash del telefono y estado: no hay texto que vaciar; su
--     fila se conserva para que Meta no reentregue un mensaje ya procesado.
create or replace function hoteles.system_run_retention_conversaciones(p_org uuid, p_dry_run boolean default false, p_limit integer default 500)
returns table (out_run_id uuid, out_status text, out_retention_days integer, out_rows_affected integer, out_rows_anonymized integer, out_rows_protected integer)
language plpgsql security definer set search_path = pg_catalog, core, hoteles, pg_temp as $$
declare
  c_class constant text := 'hoteles_whatsapp_conversaciones';
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_dry boolean := coalesce(p_dry_run, false);
  v_days integer;
  v_cutoff timestamptz;
  v_affected integer := 0;
  v_protected integer := 0;
  v_status text;
  v_blocked text;
  v_id uuid;
  v_conv integer := 0;
  v_out integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'system_run_retention_conversaciones: solo para la sesion de sistema' using errcode = '42501';
  end if;
  if not exists (select 1 from core.organization o where o.id = p_org) then
    raise exception 'system_run_retention_conversaciones: la organizacion no existe' using errcode = '22023';
  end if;

  select e.out_days into v_days from core._retention_effective(p_org, c_class) e;
  v_cutoff := now() - make_interval(days => v_days);

  if exists (
    select 1 from core.purge_hold h
     where h.organization_id = p_org and h.released_at is null and (h.data_class is null or h.data_class = c_class)
  ) then
    v_status := 'bloqueada';
    v_blocked := 'retencion_legal_activa';
  else
    select count(*) into v_protected
      from hoteles.whatsapp_conversations w
     where w.organization_id = p_org and w.messages <> '[]'::jsonb and w.updated_at < v_cutoff
       and exists (
         select 1 from hoteles.arco_request r
          where r.property_id = w.property_id and r.status in ('recibida', 'en_revision', 'procedente')
            and length(regexp_replace(coalesce(r.requester_contact, ''), '\D', '', 'g')) >= 7
            and right(regexp_replace(r.requester_contact, '\D', '', 'g'), 10) = right(regexp_replace(w.phone, '\D', '', 'g'), 10)
       );
    if v_dry then
      select count(*) into v_conv from (
        select 1 from hoteles.whatsapp_conversations w
         where w.organization_id = p_org and w.messages <> '[]'::jsonb and w.updated_at < v_cutoff
           and not exists (
             select 1 from hoteles.arco_request r
              where r.property_id = w.property_id and r.status in ('recibida', 'en_revision', 'procedente')
                and length(regexp_replace(coalesce(r.requester_contact, ''), '\D', '', 'g')) >= 7
                and right(regexp_replace(r.requester_contact, '\D', '', 'g'), 10) = right(regexp_replace(w.phone, '\D', '', 'g'), 10)
           )
         order by w.updated_at limit v_limit
      ) s;
      select count(*) into v_out from (
        select 1 from hoteles.messaging_outbox o
         where o.organization_id = p_org and o.status in ('sent', 'dead') and o.created_at < v_cutoff and o.payload <> '{"purgado": true}'::jsonb
         order by o.created_at limit v_limit
      ) s;
    else
      with victims as (
        select w.id from hoteles.whatsapp_conversations w
         where w.organization_id = p_org and w.messages <> '[]'::jsonb and w.updated_at < v_cutoff
           and not exists (
             select 1 from hoteles.arco_request r
              where r.property_id = w.property_id and r.status in ('recibida', 'en_revision', 'procedente')
                and length(regexp_replace(coalesce(r.requester_contact, ''), '\D', '', 'g')) >= 7
                and right(regexp_replace(r.requester_contact, '\D', '', 'g'), 10) = right(regexp_replace(w.phone, '\D', '', 'g'), 10)
           )
         order by w.updated_at limit v_limit
      ), cleared as (
        -- updated_at NO se toca: la fila conserva su fecha real y no vuelve a vencer como "nueva".
        update hoteles.whatsapp_conversations w set messages = '[]'::jsonb from victims v where w.id = v.id returning 1
      )
      select count(*) into v_conv from cleared;
      with victims as (
        select o.id from hoteles.messaging_outbox o
         where o.organization_id = p_org and o.status in ('sent', 'dead') and o.created_at < v_cutoff and o.payload <> '{"purgado": true}'::jsonb
         order by o.created_at limit v_limit
      ), cleared as (
        update hoteles.messaging_outbox o set payload = '{"purgado": true}'::jsonb from victims v where o.id = v.id returning 1
      )
      select count(*) into v_out from cleared;
    end if;
    v_affected := v_conv + v_out;
    v_status := case when v_dry then 'simulacion' else 'ok' end;
  end if;

  insert into core.purge_run_log (organization_id, data_class, status, retention_days, cutoff_at, rows_affected, rows_anonymized, rows_protected, blocked_reason)
  values (p_org, c_class, v_status, v_days, v_cutoff, v_affected, 0, v_protected, v_blocked)
  returning id into v_id;

  return query select v_id, v_status, v_days, v_affected, 0, v_protected;
end;
$$;
revoke all on function hoteles.system_run_retention_conversaciones(uuid, boolean, integer) from public, anon;
grant execute on function hoteles.system_run_retention_conversaciones(uuid, boolean, integer) to authenticated;
