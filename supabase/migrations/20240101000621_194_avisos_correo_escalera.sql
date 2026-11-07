-- Avisos del agente sin atender FUERA DEL PANEL (correo) con la escalera del repo suelto, para el cerebro v2 de WhatsApp de restaurantes.
-- Prefijo de supabase/migrations asignado: 20240101000621 (interno 194).
--
-- Contexto: el suelto (alertas-operativas.ts + alertas-ruteo.ts) manda CORREO por cada aviso del agente (callback_requests) sin resolver: nivel 1 a los 10 min
-- (los de alto riesgo de inmediato), repeticion a los 20 (nivel 2) y escalada al dueno a los 30 (nivel 3); niveles 1-2 al personal de la sucursal o de alcance
-- general, con red de seguridad al dueno; nunca a repartidores. El monorrepo solo notificaba en el panel. El barrido corre en el tick EXISTENTE
-- /internal/restaurantes/promover-programados (sin cron nuevo) y encola en el outbox de correo existente (restaurantes.enqueue_messaging_outbox).
--
-- Que agrega (1 columna, 2 funciones, 0 tablas):
--   restaurantes.agent_runtime_settings.avisos_correo_escalera boolean not null default false -- la opcion POR ORGANIZACION (apagada por omision).
--   restaurantes.avisos_para_correo(p_ahora, p_umbral_min) -- SOLO SISTEMA. Avisos SIN resolver de organizaciones con cerebro_v2 Y avisos_correo_escalera,
--     creados en las ultimas 24 h y hace p_umbral_min (1..120) o mas, o URGENTES (marca al inicio) de cualquier edad dentro de las 24 h; a lo mas 100, los mas
--     nuevos primero. Solo id, organizacion, sucursal, hora, urgente y si es aviso de posible baja (solo nivel 1). Sin PII.
--   restaurantes.equipo_para_avisos_correo(p_organization_id) -- SOLO SISTEMA. Correo, rol de la vertical, rol de plataforma y sucursales de los miembros de
--     la organizacion, SOLO si la organizacion tiene cerebro_v2 Y avisos_correo_escalera (si no, cero filas). A lo mas 200.
--
-- Compatibilidad: solo AGREGA (columna con default y dos funciones); aplicarla no cambia nada de lo que ya corre (la opcion nace apagada). El TypeScript llama
-- las funciones en SAVEPOINT y trata 42883 como «no disponible» (no barre).
--
-- Rollback: `drop function if exists restaurantes.equipo_para_avisos_correo(uuid);`, `drop function if exists restaurantes.avisos_para_correo(timestamptz,
-- integer);` y `alter table restaurantes.agent_runtime_settings drop column if exists avisos_correo_escalera;` (nada depende de ellas; el codigo degrada solo).
-- Requiere la 190 (columna cerebro_v2) y la 011 (outbox de correo).
--
-- Justificacion de seguridad:
--   * La columna hereda RLS/policies/revoke de la 055 (como cerebro_v2, 190): SIN GRANT de insert/update a `authenticated`; encenderla es decision de
--     plataforma (service_role). No guarda texto libre ni PII.
--   * Ambas funciones `security definer` con search_path fijo (restaurantes, core, pg_temp): la sesion de sistema no lee core.staff_user ni callback_requests
--     por RLS; estas funciones son la unica puerta y devuelven lo minimo (correo y alcance para rutear; del aviso, solo ids y horas).
--   * Exigen auth.uid() IS NULL (solo la sesion de sistema; un staff autenticado recibe 42501). `revoke` de public y anon; execute a `authenticated` (la
--     sesion de sistema corre con ese rol) y `service_role`.
--   * equipo_para_avisos_correo solo devuelve la organizacion pedida y solo si ESA organizacion encendio la opcion (nunca cruza tenants). Parametro nulo ->
--     22023. avisos_para_correo acota la ventana (24 h), el umbral (1..120) y el resultado (100 filas).

alter table restaurantes.agent_runtime_settings
  add column if not exists avisos_correo_escalera boolean not null default false;

comment on column restaurantes.agent_runtime_settings.avisos_correo_escalera is
  'Cerebro v2: avisos del agente sin atender por correo con la escalera del suelto (sucursal, recordatorio, dueno). Apagado por omision; solo service_role lo enciende.';

create or replace function restaurantes.avisos_para_correo(p_ahora timestamptz, p_umbral_min integer)
returns table (id uuid, organization_id uuid, property_id uuid, created_at timestamptz, urgente boolean, solo_primer_aviso boolean)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'restaurantes.avisos_para_correo: solo la sesion de sistema (auth.uid() es NULL).' using errcode = '42501';
  end if;
  if p_ahora is null or p_umbral_min is null or p_umbral_min < 1 or p_umbral_min > 120 then
    raise exception 'restaurantes.avisos_para_correo: p_ahora requerido y p_umbral_min entre 1 y 120.' using errcode = '22023';
  end if;
  return query
    select c.id, c.organization_id, c.property_id, c.created_at,
           (c.message like 'URGENTE%') as urgente,
           (position('[posible baja' in coalesce(c.message, '')) > 0) as solo_primer_aviso
    from restaurantes.callback_requests c
    where c.resolved = false
      and c.created_at >= p_ahora - interval '24 hours'
      and c.created_at <= p_ahora
      and (c.created_at <= p_ahora - make_interval(mins => p_umbral_min) or c.message like 'URGENTE%')
      and exists (
        select 1 from restaurantes.agent_runtime_settings s
        where s.organization_id = c.organization_id and s.cerebro_v2 and s.avisos_correo_escalera
      )
    order by c.created_at desc
    limit 100;
end;
$$;

revoke all on function restaurantes.avisos_para_correo(timestamptz, integer) from public, anon;
-- authenticated: la sesion de sistema de la API (la funcion rechaza a todo staff con auth.uid() no nulo).
grant execute on function restaurantes.avisos_para_correo(timestamptz, integer) to authenticated, service_role;

create or replace function restaurantes.equipo_para_avisos_correo(p_organization_id uuid)
returns table (email text, vertical_role text, platform_role text, property_ids uuid[])
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'restaurantes.equipo_para_avisos_correo: solo la sesion de sistema (auth.uid() es NULL).' using errcode = '42501';
  end if;
  if p_organization_id is null then
    raise exception 'restaurantes.equipo_para_avisos_correo: organizacion requerida.' using errcode = '22023';
  end if;
  return query
    select su.email::text, m.vertical_role::text, m.platform_role::text, m.property_ids
    from core.membership m
    join core.staff_user su on su.id = m.user_id
    where m.organization_id = p_organization_id
      and exists (
        select 1 from restaurantes.agent_runtime_settings s
        where s.organization_id = p_organization_id and s.cerebro_v2 and s.avisos_correo_escalera
      )
    limit 200;
end;
$$;

revoke all on function restaurantes.equipo_para_avisos_correo(uuid) from public, anon;
-- authenticated: la sesion de sistema de la API (la funcion rechaza a todo staff con auth.uid() no nulo).
grant execute on function restaurantes.equipo_para_avisos_correo(uuid) to authenticated, service_role;
