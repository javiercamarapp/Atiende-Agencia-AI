-- QA R1 (citas, automatizacion): tres piezas de Postgres que acompanan los arreglos de TypeScript del mismo PR.
-- Prefijo de supabase/migrations asignado: 20240101000335 (interno 033).
-- Ningun GRANT a anon. Todo lo nuevo es aditivo o reemplaza una funcion existente SIN cambiar su firma ni su forma de retorno.
--
-- Compatibilidad con la base sin migrar: el codigo TypeScript del PR no depende de nada de este archivo para seguir funcionando
-- (la clave nueva del recordatorio es solo texto; el aviso de agotados y el chat de datos leen las mismas funciones de antes).
-- Unica excepcion: la purga por retencion (seccion 3) la llama una ruta nueva que, si la funcion todavia no existe (SQLSTATE
-- 42883), responde "no disponible aun" dentro de un SAVEPOINT y no toca nada.

-- ============================================================================
-- 1. citas.data_chat_reminder_delivery reconoce la clave nueva del recordatorio (QA-citas-R1-automatizacion-01)
-- ============================================================================
-- El recordatorio de 24 h ahora se encola con la clave `reminder-24h:<cita>:<starts_at>` (antes `reminder-24h:<cita>`): al
-- reagendar, la cita necesita un recordatorio NUEVO con la hora nueva y la clave anterior no hacia nada sobre la fila ya `sent`.
-- La funcion de solo lectura del chat de datos unia por igualdad exacta con la clave vieja; ahora une por prefijo (`<cita>` mide
-- siempre 36 caracteres, asi que un prefijo no puede confundir dos citas) y sigue contando tanto las filas viejas como las nuevas.
-- Seguridad: MISMA funcion de 027, sin cambios de privilegio -- security definer, search_path fijo, revoke de public/anon, EXECUTE
-- solo para authenticated; exige auth.uid() no nulo, membership owner/admin, la RLS de citas por sucursal y devuelve solo conteos
-- (canal, estado, total): nunca destinatarios, cuerpos ni ids. Una cita reagendada cuenta un recordatorio por cada horario que tuvo.
create or replace function citas.data_chat_reminder_delivery(
  p_organization_id uuid,
  p_property_ids uuid[],
  p_start timestamptz,
  p_end timestamptz
) returns table (channel text, status text, total bigint)
language sql
stable
security definer
set search_path = citas, core, pg_temp
as $$
  select o.channel, o.status, count(*)::bigint as total
  from citas.messaging_outbox o
  join citas.appointments a
    on a.organization_id = o.organization_id
   and starts_with(o.dedupe_key, 'reminder-24h:' || a.id::text)
  where auth.uid() is not null
    and p_organization_id is not null
    and o.organization_id = p_organization_id
    and o.event_type = 'appointment.reminder_24h'
    and exists (
      select 1 from core.membership m
      where m.organization_id = p_organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
    and citas.membership_covers_property(a.organization_id, a.property_id)
    and (p_property_ids is null or a.property_id = any(p_property_ids))
    and a.starts_at >= p_start and a.starts_at < p_end
  group by o.channel, o.status
  order by o.channel, o.status
$$;

revoke all on function citas.data_chat_reminder_delivery(uuid, uuid[], timestamptz, timestamptz) from public, anon;
grant execute on function citas.data_chat_reminder_delivery(uuid, uuid[], timestamptz, timestamptz) to authenticated;

-- ============================================================================
-- 2. Instante en que un mensaje pasa a `dead` (QA-citas-R1-automatizacion-09)
-- ============================================================================
-- El aviso "recordatorios agotados" usaba como clave de dedupe el created_at del agotado mas reciente: un recordatorio creado
-- ANTES pero agotado DESPUES no cambiaba la clave y el productor deduplicaba el aviso. `dead_at` guarda el instante real del paso
-- a `dead`; las filas que ya eran `dead` quedan con dead_at nulo y siguen contando por created_at (coalesce).
-- El trigger corre con los privilegios de quien actualiza (security invoker, ya son las funciones definer de 007/009/014/017) y
-- solo asigna una columna de la propia fila: no abre ningun acceso nuevo. La columna hereda los privilegios de tabla existentes
-- (authenticated no tiene ninguno sobre messaging_outbox; solo las funciones definer la tocan).
alter table citas.messaging_outbox add column if not exists dead_at timestamptz;

create or replace function citas.messaging_outbox_stamp_dead_at() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.status = 'dead' and old.status is distinct from 'dead' then
    new.dead_at := now();
  end if;
  return new;
end;
$$;
revoke all on function citas.messaging_outbox_stamp_dead_at() from public, anon, authenticated;

drop trigger if exists messaging_outbox_stamp_dead_at on citas.messaging_outbox;
create trigger messaging_outbox_stamp_dead_at
  before update of status on citas.messaging_outbox
  for each row execute function citas.messaging_outbox_stamp_dead_at();

-- Misma funcion de 029 (firma, forma de retorno y privilegios intactos): solo cambia el instante que usa para "agotado".
-- Seguridad: security definer, search_path fijo, revoke de public/anon, EXECUTE para authenticated con guard auth.uid() is null
-- (solo sesion de sistema; la sesion de sistema de la app corre con el rol authenticated y sub vacio).
create or replace function citas.system_avisos_resumen(p_organization_id uuid)
returns table (
  por_confirmar bigint,
  recordatorios_agotados bigint,
  ultimo_agotado_epoch bigint,
  escalaciones_sin_seguimiento bigint
)
language plpgsql
stable
security definer
set search_path = citas, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'system_avisos_resumen es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
  select
    -- Citas pendientes (sin confirmar) que empiezan en las proximas 48 h.
    (select count(*) from citas.appointments a
      where a.organization_id = p_organization_id and a.status = 'pending'
        and a.starts_at > now() and a.starts_at <= now() + interval '48 hours'),
    -- Recordatorios de 24 h que agotaron sus reintentos (estado 'dead') en las ultimas 48 h (desde que pasaron a dead).
    (select count(*) from citas.messaging_outbox o
      where o.organization_id = p_organization_id and o.event_type = 'appointment.reminder_24h' and o.status = 'dead'
        and coalesce(o.dead_at, o.created_at) > now() - interval '48 hours'),
    -- Instante en que el ultimo se agoto: el productor lo usa como clave de dedupe para avisar solo cuando aparece uno NUEVO.
    (select floor(extract(epoch from max(coalesce(o.dead_at, o.created_at))))::bigint from citas.messaging_outbox o
      where o.organization_id = p_organization_id and o.event_type = 'appointment.reminder_24h' and o.status = 'dead'
        and coalesce(o.dead_at, o.created_at) > now() - interval '48 hours'),
    -- Escalaciones de crisis que llevan mas de 1 hora sin que nadie las tome.
    (select count(*) from citas.emergency_escalations e
      where e.organization_id = p_organization_id and e.follow_up_status = 'pending'
        and e.created_at < now() - interval '1 hour');
end;
$$;

revoke all on function citas.system_avisos_resumen(uuid) from public, anon;
grant execute on function citas.system_avisos_resumen(uuid) to authenticated;

-- ============================================================================
-- 3. Retencion y purga de datos de salud de citas (QA-citas-R1-automatizacion-07)
-- ============================================================================
-- Hallazgo: el historial de chat de WhatsApp (jsonb completo), las escalaciones de crisis (telefono, canal y etiqueta de la senal;
-- el extracto se guarda vacio) y las notas internas de conversaciones transferidas se conservaban indefinidamente y no habia
-- clase de retencion de citas en el catalogo.
-- Plazos: 365 dias por defecto (minimo 30, maximo 1825) para las tres clases. SON PROVISIONALES: el plazo definitivo lo decide el
-- asesor juridico (ver docs/PRIVACIDAD-PLATAFORMA.md); el ejecutor es 'vertical' (la purga la corre citas con ESTOS defectos y
-- ninguna organizacion puede acortarlos o alargarlos desde core.org_set_retention_policy, que solo acepta clases de plataforma).
insert into core.retention_class (data_class, vertical, description, default_days, min_days, max_days, executor) values
  ('citas_whatsapp_conversaciones', 'citas', 'Mensajes de las conversaciones de WhatsApp de pacientes (datos de salud); al vencer se vacia el historial y se conserva la fila y su vinculo a la cita. La purga la corre el vertical (citas.system_purge_retencion).', 365, 30, 1825, 'vertical'),
  ('citas_escalaciones_crisis', 'citas', 'Escalaciones de crisis (telefono, canal y etiqueta de la senal; el extracto se guarda vacio); al vencer se eliminan. La purga la corre el vertical (citas.system_purge_retencion).', 365, 30, 1825, 'vertical'),
  ('citas_notas_conversacion', 'citas', 'Notas internas del staff sobre conversaciones transferidas a una persona; al vencer se eliminan. La purga la corre el vertical (citas.system_purge_retencion).', 365, 30, 1825, 'vertical')
on conflict (data_class) do nothing;

-- Purga del vertical. Seguridad:
--  * security definer + search_path fijo (pg_catalog, citas, core, pg_temp); revoke de public/anon;
--  * EXECUTE para authenticated (la sesion de sistema de la app usa ese rol con sub vacio) y service_role, con guard interno
--    `auth.uid() is null`: un usuario de staff, aun owner, NO puede dispararla (42501);
--  * respeta el bloqueo de retencion legal (core.purge_hold activo para la organizacion y la clase, o para todas): lo bloqueado
--    no se toca y se cuenta como protegido;
--  * nunca purga a un titular con una solicitud ARCO abierta (recibida, en_proceso, bloqueada) para su telefono;
--  * lote acotado (p_limit 1..5000 POR CLASE, por defecto 500), orden por antiguedad, y p_dry cuenta sin tocar nada;
--  * devuelve solo conteos, nunca contenido ni telefonos.
create or replace function citas.system_purge_retencion(p_limit integer default 500, p_dry boolean default false)
returns table (out_conversaciones integer, out_escalaciones integer, out_notas integer, out_protegidas integer)
language plpgsql
security definer
set search_path = pg_catalog, citas, core, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_dry boolean := coalesce(p_dry, false);
  v_corte_conv timestamptz;
  v_corte_esc timestamptz;
  v_corte_nota timestamptz;
  v_conv integer := 0;
  v_esc integer := 0;
  v_nota integer := 0;
  v_prot integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'citas.system_purge_retencion: solo la sesion de sistema (auth.uid() es NULL).' using errcode = '42501';
  end if;

  select now() - make_interval(days => c.default_days) into v_corte_conv from core.retention_class c where c.data_class = 'citas_whatsapp_conversaciones';
  select now() - make_interval(days => c.default_days) into v_corte_esc from core.retention_class c where c.data_class = 'citas_escalaciones_crisis';
  select now() - make_interval(days => c.default_days) into v_corte_nota from core.retention_class c where c.data_class = 'citas_notas_conversacion';
  if v_corte_conv is null or v_corte_esc is null or v_corte_nota is null then
    raise exception 'citas.system_purge_retencion: faltan las clases de retencion de citas en core.retention_class.' using errcode = '22023';
  end if;

  -- Protegidos: vencidos que NO se tocan por retencion legal o por una solicitud ARCO abierta.
  select
    (select count(*) from citas.whatsapp_conversations w
      where w.messages <> '[]'::jsonb and w.updated_at < v_corte_conv
        and (exists (select 1 from core.purge_hold h where h.organization_id = w.organization_id and h.released_at is null and (h.data_class is null or h.data_class = 'citas_whatsapp_conversaciones'))
             or exists (select 1 from citas.data_rights_requests r where r.organization_id = w.organization_id and r.customer_phone = w.phone and r.status in ('recibida', 'en_proceso', 'bloqueada'))))
    + (select count(*) from citas.emergency_escalations e
      where e.created_at < v_corte_esc
        and (exists (select 1 from core.purge_hold h where h.organization_id = e.organization_id and h.released_at is null and (h.data_class is null or h.data_class = 'citas_escalaciones_crisis'))
             or exists (select 1 from citas.data_rights_requests r where r.organization_id = e.organization_id and r.customer_phone = e.customer_phone and r.status in ('recibida', 'en_proceso', 'bloqueada'))))
    + (select count(*) from citas.conversation_note n
      where n.created_at < v_corte_nota
        and exists (select 1 from core.purge_hold h where h.organization_id = n.organization_id and h.released_at is null and (h.data_class is null or h.data_class = 'citas_notas_conversacion')))
  into v_prot;

  if v_dry then
    select count(*) into v_conv from (
      select 1 from citas.whatsapp_conversations w
       where w.messages <> '[]'::jsonb and w.updated_at < v_corte_conv
         and not exists (select 1 from core.purge_hold h where h.organization_id = w.organization_id and h.released_at is null and (h.data_class is null or h.data_class = 'citas_whatsapp_conversaciones'))
         and not exists (select 1 from citas.data_rights_requests r where r.organization_id = w.organization_id and r.customer_phone = w.phone and r.status in ('recibida', 'en_proceso', 'bloqueada'))
       order by w.updated_at limit v_limit) s;
    select count(*) into v_esc from (
      select 1 from citas.emergency_escalations e
       where e.created_at < v_corte_esc
         and not exists (select 1 from core.purge_hold h where h.organization_id = e.organization_id and h.released_at is null and (h.data_class is null or h.data_class = 'citas_escalaciones_crisis'))
         and not exists (select 1 from citas.data_rights_requests r where r.organization_id = e.organization_id and r.customer_phone = e.customer_phone and r.status in ('recibida', 'en_proceso', 'bloqueada'))
       order by e.created_at limit v_limit) s;
    select count(*) into v_nota from (
      select 1 from citas.conversation_note n
       where n.created_at < v_corte_nota
         and not exists (select 1 from core.purge_hold h where h.organization_id = n.organization_id and h.released_at is null and (h.data_class is null or h.data_class = 'citas_notas_conversacion'))
       order by n.created_at limit v_limit) s;
  else
    with victimas as (
      select w.id from citas.whatsapp_conversations w
       where w.messages <> '[]'::jsonb and w.updated_at < v_corte_conv
         and not exists (select 1 from core.purge_hold h where h.organization_id = w.organization_id and h.released_at is null and (h.data_class is null or h.data_class = 'citas_whatsapp_conversaciones'))
         and not exists (select 1 from citas.data_rights_requests r where r.organization_id = w.organization_id and r.customer_phone = w.phone and r.status in ('recibida', 'en_proceso', 'bloqueada'))
       order by w.updated_at limit v_limit
    ), vaciadas as (
      update citas.whatsapp_conversations w set messages = '[]'::jsonb from victimas v where w.id = v.id returning 1
    )
    select count(*) into v_conv from vaciadas;

    with victimas as (
      select e.id from citas.emergency_escalations e
       where e.created_at < v_corte_esc
         and not exists (select 1 from core.purge_hold h where h.organization_id = e.organization_id and h.released_at is null and (h.data_class is null or h.data_class = 'citas_escalaciones_crisis'))
         and not exists (select 1 from citas.data_rights_requests r where r.organization_id = e.organization_id and r.customer_phone = e.customer_phone and r.status in ('recibida', 'en_proceso', 'bloqueada'))
       order by e.created_at limit v_limit
    ), borradas as (
      delete from citas.emergency_escalations e using victimas v where e.id = v.id returning 1
    )
    select count(*) into v_esc from borradas;

    with victimas as (
      select n.id from citas.conversation_note n
       where n.created_at < v_corte_nota
         and not exists (select 1 from core.purge_hold h where h.organization_id = n.organization_id and h.released_at is null and (h.data_class is null or h.data_class = 'citas_notas_conversacion'))
       order by n.created_at limit v_limit
    ), borradas as (
      delete from citas.conversation_note n using victimas v where n.id = v.id returning 1
    )
    select count(*) into v_nota from borradas;
  end if;

  return query select v_conv, v_esc, v_nota, v_prot;
end;
$$;

revoke all on function citas.system_purge_retencion(integer, boolean) from public, anon;
grant execute on function citas.system_purge_retencion(integer, boolean) to authenticated, service_role;
