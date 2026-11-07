-- Avisos al equipo (callback_requests) de UN telefono, para el cerebro v2 de WhatsApp de restaurantes.
-- Prefijo de supabase/migrations asignado: 20240101000614 (interno 193).
--
-- Contexto: el cerebro medido del repo suelto decide con los avisos del telefono: la guarda de alergia de crear_pedido (el pedido espera mientras el
-- aviso de alergia siga abierto, hasta 120 min; resuelto, se toma con la nota «ALERGIA declarada») y el dedupe por categoria (un aviso abierto de la
-- misma categoria recibe el texto nuevo en vez de crear otro). La sesion de sistema del agente NO ve callback_requests por RLS (solo el staff), asi
-- que hoy el turno no puede saber si la sucursal ya resolvio el aviso.
--
-- Que agrega (1 funcion, 0 tablas):
--   restaurantes.avisos_del_telefono(p_organization_id, p_phone, p_horas) -- SOLO SISTEMA. Los avisos del telefono en la organizacion de las ultimas
--   p_horas (1..48), del mas reciente al mas viejo, a lo mas 20 filas: id, property_id, reason, message, resolved, created_at.
--
-- Compatibilidad: solo AGREGA una funcion; aplicarla no cambia nada de lo que ya corre. El TypeScript la llama en SAVEPOINT y trata 42883 como «no
-- disponible» (la guarda decide con el hilo, como el suelto con la base caida).
--
-- Rollback: `drop function if exists restaurantes.avisos_del_telefono(uuid, text, integer);` (nada depende de ella en la base; el codigo degrada solo).
--
-- Justificacion de seguridad:
--   * `security definer` con search_path fijo (restaurantes, core, pg_temp): la sesion de sistema de la API no tiene policy de SELECT sobre
--     callback_requests; esta funcion es la unica puerta y solo devuelve las filas de la organizacion y el telefono pedidos (nunca cruza tenants).
--   * Exige auth.uid() IS NULL (solo la sesion de sistema; un staff autenticado ya lee la tabla por su policy y aqui recibe 42501). `revoke` de public
--     y anon; execute a `authenticated` (la sesion de sistema corre con ese rol) y `service_role`.
--   * p_horas se acota a 1..48 y el resultado a 20 filas: una consulta nunca recorre el historial completo del telefono. Parametros nulos -> 22023.

create or replace function restaurantes.avisos_del_telefono(p_organization_id uuid, p_phone text, p_horas integer)
returns table (id uuid, property_id uuid, reason text, message text, resolved boolean, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'restaurantes.avisos_del_telefono: solo la sesion de sistema (auth.uid() es NULL).' using errcode = '42501';
  end if;
  if p_organization_id is null or p_phone is null or btrim(p_phone) = '' or p_horas is null then
    raise exception 'restaurantes.avisos_del_telefono: organizacion, telefono y horas son requeridos.' using errcode = '22023';
  end if;
  return query
    select c.id, c.property_id, c.reason, c.message, c.resolved, c.created_at
    from restaurantes.callback_requests c
    where c.organization_id = p_organization_id
      and c.customer_phone = p_phone
      and c.created_at >= now() - make_interval(hours => least(48, greatest(1, p_horas)))
    order by c.created_at desc
    limit 20;
end;
$$;

revoke all on function restaurantes.avisos_del_telefono(uuid, text, integer) from public, anon;
grant execute on function restaurantes.avisos_del_telefono(uuid, text, integer) to authenticated, service_role;
