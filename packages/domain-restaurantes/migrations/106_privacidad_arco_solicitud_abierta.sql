-- Seguimiento de una solicitud ARCO (revision del PR #757, 7-nov-2026).
--
-- Problema: «¿me avisan cuando pueda ver mis datos?» abria una solicitud de ACCESO falsa (por «ver») y pedia CONFIRMO de algo
-- que el cliente no pidio. El primer arreglo descartaba todo mensaje con «me avisan / me confirman / me dicen», pero eso se
-- tragaba solicitudes reales en imperativo («Borren mis datos personales y me avisan») y su plazo legal nunca empezaba.
--
-- Arreglo: el fast-path ARCO (`runArcoFastPath`) trata un mensaje como seguimiento SOLO si ese telefono ya tiene una solicitud
-- abierta, y entonces contesta con su estado y fecha limite reales. Para saberlo necesita leer la solicitud abierta mas
-- reciente de ESE telefono, de cualquier derecho; la sesion de sistema no tiene policy de lectura sobre
-- `restaurantes.data_rights_requests`, de ahi esta funcion.
--
--   restaurantes.system_find_open_data_rights_request(organizacion, telefono) -> 0 o 1 fila
--     (id, derecho, estado, fecha limite de respuesta). Abierta = pendiente_confirmacion de menos de 24 h, recibida,
--     en_proceso o bloqueada (los mismos estados que deduplica `system_register_data_rights_request` de la 030).
--
-- Justificacion de seguridad (mismo patron que las funciones de sistema de la 030):
--  * security definer porque la sesion de sistema no tiene policy de lectura; search_path fijo.
--  * Guard `auth.uid() is null`: un usuario autenticado (staff o cliente) no puede usarla para sondear solicitudes de un
--    telefono ajeno; el staff ya tiene su propia lectura por RLS desde el panel.
--  * Solo lectura (stable): no expira ni modifica filas; no devuelve el telefono, el detalle ni notas.
--  * revoke de public/anon; grant a `authenticated` porque la sesion de sistema del motor corre con ese rol y auth.uid() NULL.
--
-- Aditiva: el codigo degrada con SAVEPOINT cuando la base todavia no la tiene (42883) y entonces cae al detector normal.
-- Nada se aplica al mergear.

create or replace function restaurantes.system_find_open_data_rights_request(
  p_organization_id uuid,
  p_customer_phone text
)
returns table (out_id uuid, out_right_type text, out_status text, out_response_due_at timestamptz)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'system_find_open_data_rights_request es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_customer_phone is null or btrim(p_customer_phone) = '' then
    return;
  end if;

  return query
    select r.id, r.right_type, r.status, r.response_due_at
      from restaurantes.data_rights_requests r
     where r.organization_id = p_organization_id
       and r.customer_phone = p_customer_phone
       and (
         r.status in ('recibida', 'en_proceso', 'bloqueada')
         or (r.status = 'pendiente_confirmacion' and r.created_at >= now() - interval '24 hours')
       )
     order by r.created_at desc, r.seq desc
     limit 1;
end;
$$;

revoke all on function restaurantes.system_find_open_data_rights_request(uuid, text) from public, anon;
grant execute on function restaurantes.system_find_open_data_rights_request(uuid, text) to authenticated;
