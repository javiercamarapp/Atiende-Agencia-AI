-- R-09 (storefront publico): rastreo de un pedido por token, sin login y sin datos personales.
--
-- Contexto. La pagina publica de rastreo corre en la sesion de sistema (rol `authenticated` con
-- `auth.uid()` NULL, igual que el checkout web). La unica policy de SELECT de `restaurantes.orders`
-- es la del staff de la organizacion, asi que esa sesion NO puede leer un pedido por SELECT directo
-- (y no se abre una policy nueva: la tabla trae nombre, telefono, direccion y transcripcion de
-- llamada). Se agrega UNA funcion de lectura acotada.
--
-- Justificacion de seguridad de cada objeto nuevo:
--   * restaurantes.storefront_order_tracking(uuid, uuid) -- SECURITY DEFINER con search_path fijo.
--     - Solo-sistema: exige `auth.uid() is null` (un staff autenticado ya tiene su propia lectura por
--       RLS y no debe poder usar la funcion para saltarla; un JWT de usuario recibe 42501).
--     - Devuelve SOLO columnas no personales: estado, sucursal, total, canal, forma de pago, hora de
--       creacion y los renglones (nombre/cantidad/tortilla). NUNCA customer_name, customer_phone,
--       customer_address, customer_email, notes, call_transcript ni call_recording_url.
--     - Acotada por AMBOS ids: el pedido debe pertenecer a `p_organization_id` (un token emitido para
--       otra organizacion no encuentra nada). El token firmado lo verifica la API antes de llamar.
--     - STABLE, sin escrituras. `revoke ... from public, anon`; el GRANT a `authenticated` es porque la
--       sesion de sistema corre con ese rol (mismo patron que verify_voice_branch_secret, 026): el
--       guard `auth.uid() is null` es lo que impide el uso por un usuario.
--   * Ningun GRANT a anon, ninguna policy nueva, ningun `using (true)`.
--
-- Base sin migrar: el codigo TypeScript captura 42883 (funcion inexistente) con SAVEPOINT y responde
-- "rastreo no disponible aun" (ver PostgresRestaurantesRepository.findStorefrontOrderTracking).

create or replace function restaurantes.storefront_order_tracking(p_organization_id uuid, p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_order restaurantes.orders%rowtype;
begin
  if auth.uid() is not null then
    raise exception 'restaurantes.storefront_order_tracking: solo la sesion de sistema (auth.uid() es NULL).'
      using errcode = '42501';
  end if;
  if p_organization_id is null or p_order_id is null then
    return null;
  end if;
  select * into v_order
  from restaurantes.orders o
  where o.id = p_order_id and o.organization_id = p_organization_id;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'status', v_order.status,
    'branch', v_order.branch,
    'total', v_order.total,
    'payment_method', v_order.payment_method,
    'canal', case when coalesce(v_order.notes, '') like '%Canal: recoger en sucursal.%' then 'recoger' else 'domicilio' end,
    'created_at', v_order.created_at,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object('name', i->>'name', 'quantity', i->'quantity', 'tortilla', i->'tortilla')), '[]'::jsonb)
      from jsonb_array_elements(case when jsonb_typeof(v_order.items) = 'array' then v_order.items else '[]'::jsonb end) as i
    )
  );
end;
$$;

revoke all on function restaurantes.storefront_order_tracking(uuid, uuid) from public, anon;
grant execute on function restaurantes.storefront_order_tracking(uuid, uuid) to authenticated;
