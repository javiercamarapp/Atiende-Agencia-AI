-- Alertas del agente de WhatsApp (restaurantes 085): lectura de SOLO SISTEMA de los turnos terminados en una ventana, para medir la tasa de timeouts
-- (>1 % en 10 min) y las rachas de fallos (5 seguidos) sin dar GRANT directo sobre whatsapp_inbound_events.
-- Prefijo de supabase/migrations: 20240101000395 (interno restaurantes 085). Forward-only; no toca ninguna tabla ni funcion existente.
--
-- Justificacion de seguridad:
--   * security definer con search_path fijo (restaurantes, core, pg_temp): el rol de produccion no tiene GRANT sobre whatsapp_inbound_events
--     (migracion 048), asi que la lectura pasa por esta funcion.
--   * SOLO sistema: exige auth.uid() is null (misma guarda que whatsapp_silencio_candidatos, 052); revoke de public y anon; execute solo a authenticated
--     (la sesion de sistema de la API corre con ese rol y auth.uid() null).
--   * Sin PII: devuelve organizacion, instante, estado y la CLASE del error (nombre de la excepcion, <= 120 caracteres); nunca message_id ni phone_hash.
--   * Solo LEE. Excluye la organizacion demo. Ventana acotada a 2 horas y a 5000 filas (las mas recientes) para que no sea un volcado.
create or replace function restaurantes.agente_turnos_recientes(p_desde timestamptz, p_hasta timestamptz)
returns table (organization_id uuid, claimed_at timestamptz, status text, last_error_class text)
language plpgsql stable security definer set search_path = restaurantes, core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'agente_turnos_recientes: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > interval '2 hours' then
    raise exception 'agente_turnos_recientes: ventana invalida (maximo 2 horas)' using errcode = '22023';
  end if;
  return query
    select e.organization_id, e.claimed_at, e.status, e.last_error_class
      from restaurantes.whatsapp_inbound_events e
     where e.claimed_at >= p_desde and e.claimed_at <= p_hasta
       and e.status in ('processed', 'failed')
       and not exists (select 1 from restaurantes.demo_organization d where d.organization_id = e.organization_id)
     order by e.claimed_at desc
     limit 5000;
end;
$$;
revoke all on function restaurantes.agente_turnos_recientes(timestamptz, timestamptz) from public, anon;
grant execute on function restaurantes.agente_turnos_recientes(timestamptz, timestamptz) to authenticated;
