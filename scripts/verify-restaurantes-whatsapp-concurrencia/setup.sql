-- Fixtures persistentes (como postgres, bypass RLS) y envoltorios `conc.*` de la verificacion de concurrencia de
-- restaurantes. Los envoltorios son SECURITY INVOKER: corren con el rol `authenticated` y auth.uid() nulo (sesion de
-- sistema), exactamente como los llama el backend, y solo convierten una excepcion en texto `err:<SQLSTATE>` para que el
-- script distinga ganadora y perdedora. No otorgan nada que `authenticated` no tuviera ya sobre las funciones reales.
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000c1801', 'restaurantes', 'Taqueria Concurrencia', 'taqueria-concurrencia')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000c1811', '00000000-0000-0000-0000-0000000c1801', 'restaurantes', 'Sucursal Concurrencia')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug, phone, address, lat, lng, display_order) values
  ('00000000-0000-0000-0000-0000000c1811', '00000000-0000-0000-0000-0000000c1801', 'sucursal-conc', '9990003333', 'Calle Conc 1', 21.0129, -89.6152, 0)
on conflict do nothing;

insert into restaurantes.customers (id, organization_id, phone, name, order_count) values
  ('00000000-0000-0000-0000-0000000c1821', '00000000-0000-0000-0000-0000000c1801', '9990001801', 'Cliente Conc Uno', 0),
  ('00000000-0000-0000-0000-0000000c1822', '00000000-0000-0000-0000-0000000c1801', '9990001802', 'Cliente Conc Dos', 0)
on conflict do nothing;

create schema if not exists conc;
grant usage on schema conc to authenticated;

-- Crea un pedido con la RPC real. Devuelve 'ok:<id>' o 'err:<SQLSTATE>' (PT409 = llave reutilizada con otro contenido).
create or replace function conc.try_order(p_customer uuid, p_total numeric, p_fp_seed text, p_key_seed text)
returns text language plpgsql as $$
declare
  v jsonb;
begin
  v := restaurantes.create_order_idempotent(
    jsonb_build_object(
      'organization_id', '00000000-0000-0000-0000-0000000c1801',
      'property_id', '00000000-0000-0000-0000-0000000c1811',
      'customer_id', p_customer,
      'customer_name', 'Cliente Conc', 'customer_phone', '9990001801',
      'customer_address', null, 'customer_email', null, 'branch', 'Sucursal Concurrencia',
      'total', p_total, 'items', jsonb_build_array(jsonb_build_object('name', 'Taco', 'qty', 2, 'price', p_total / 2)),
      'source', 'whatsapp', 'notes', null, 'payment_method', 'efectivo',
      'call_transcript', null, 'call_recording_url', null
    ),
    md5(p_fp_seed) || md5(p_fp_seed || 'x'),
    case when p_key_seed is null then null else md5(p_key_seed) || md5(p_key_seed || 'x') end
  );
  return 'ok:' || (v->>'id');
exception when others then
  return 'err:' || sqlstate;
end;
$$;

grant execute on all functions in schema conc to authenticated;
