-- 200: uso FACTURABLE de un restaurante en un mes (cobro por plan medido, packages/db/migrations/0080).
--
-- Las dos unidades que cobra el plan medido, medidas con las tablas que ya existen (ninguna tabla nueva):
--   * minutos de voz: suma de `duration_s` de las llamadas REALES (`canal = 'llamada'`; los previews del panel no se
--     cobran) que EMPEZARON en el mes, redondeada hacia arriba al minuto (sobre el total del mes, no por llamada).
--     Una llamada en curso (`duration_s` null) no cuenta hasta que cierre.
--   * conversaciones de WhatsApp: clientes distintos (`phone_hash`) con al menos un mensaje entrante PROCESADO, por dia
--     del negocio. Es la misma unidad que la ventana de servicio de 24 h de Meta y no depende de
--     `restaurantes.whatsapp_conversations`, que guarda UNA fila por telefono para siempre.
-- El mes es el calendario de la zona horaria del negocio (`core.organization.timezone`), igual que el medidor de
-- mensajes de 0046.
--
-- Seguridad:
--   * security definer con search_path fijo: lee voice_conversation y whatsapp_inbound_events, que el rol de la app no
--     lee completo (RLS de owner/admin y tabla interna, respectivamente). Solo devuelve AGREGADOS (sin telefonos ni
--     hashes ni ids de llamada).
--   * Sesion de usuario: auth.uid() = p_caller_id y (miembro de la organizacion o superadmin de plataforma); si no ->
--     null (nunca datos de otra organizacion). Sesion de sistema (auth.uid() is null): el calculo del excedente al
--     cerrar el periodo en el webhook de cobro.
--   * Ningun GRANT a anon.
--
-- Rollback: drop function if exists restaurantes.uso_facturable_mes(uuid, uuid, date);
create or replace function restaurantes.uso_facturable_mes(p_caller_id uuid, p_organization_id uuid, p_mes date)
returns jsonb language plpgsql stable security definer set search_path = restaurantes, core, pg_temp as $$
declare
  v_tz text;
  v_vertical text;
  v_desde timestamptz;
  v_hasta timestamptz;
  v_segundos bigint;
  v_llamadas integer;
  v_conversaciones integer;
begin
  if auth.uid() is not null then
    if auth.uid() <> p_caller_id then
      raise exception 'uso_facturable_mes: caller binding invalido' using errcode = '42501';
    end if;
    if not (
      exists (select 1 from core.membership m where m.user_id = p_caller_id and m.organization_id = p_organization_id)
      or core.is_platform_superadmin(p_caller_id)
    ) then
      return null;
    end if;
  end if;
  if p_mes is null then
    raise exception 'uso_facturable_mes: indica el mes' using errcode = '22023';
  end if;
  select o.timezone, o.vertical into v_tz, v_vertical from core.organization o where o.id = p_organization_id;
  if v_tz is null then
    return null;
  end if;
  if v_vertical <> 'restaurantes' then
    raise exception 'uso_facturable_mes: la organizacion no es de restaurantes' using errcode = '22023';
  end if;

  v_desde := (date_trunc('month', p_mes::timestamp)) at time zone v_tz;
  v_hasta := (date_trunc('month', p_mes::timestamp) + interval '1 month') at time zone v_tz;

  select coalesce(sum(vc.duration_s), 0), count(*)::integer
    into v_segundos, v_llamadas
  from restaurantes.voice_conversation vc
  where vc.organization_id = p_organization_id
    and vc.canal = 'llamada'
    and vc.duration_s is not null
    and vc.started_at >= v_desde and vc.started_at < v_hasta;

  select count(*)::integer into v_conversaciones
  from (
    select distinct e.phone_hash, (e.claimed_at at time zone v_tz)::date
    from restaurantes.whatsapp_inbound_events e
    where e.organization_id = p_organization_id
      and e.status = 'processed'
      and e.claimed_at >= v_desde and e.claimed_at < v_hasta
  ) d;

  return jsonb_build_object(
    'organizationId', p_organization_id,
    'mes', to_char(date_trunc('month', p_mes::timestamp), 'YYYY-MM-DD'),
    'zonaHoraria', v_tz,
    'desde', v_desde,
    'hasta', v_hasta,
    'segundosVoz', v_segundos,
    'minutosVoz', ceil(v_segundos / 60.0)::bigint,
    'llamadas', v_llamadas,
    'conversacionesWa', v_conversaciones
  );
end;
$$;
revoke all on function restaurantes.uso_facturable_mes(uuid, uuid, date) from public, anon;
-- authenticated: la autoridad real es el caller binding + membresia/superadmin de arriba.
grant execute on function restaurantes.uso_facturable_mes(uuid, uuid, date) to authenticated;
