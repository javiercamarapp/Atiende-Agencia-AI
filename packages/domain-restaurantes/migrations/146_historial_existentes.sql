-- 146 (revision P-4): el adaptador Postgres del importador ya no hace SELECT directo a tablas revocadas para authenticated.
-- historial_existentes (owner/admin con alcance de organizacion, definer) devuelve, por telefono de 10 digitos, el cliente, la huella del ultimo
-- import y si esta suprimido (HMAC + heredado). No devuelve nombres, domicilios ni datos del historial. Maximo 20000 telefonos.
-- REVERSA: drop function restaurantes.historial_existentes(uuid, text[]);
create or replace function restaurantes.historial_existentes(p_organization_id uuid, p_telefonos text[])
returns table (phone text, customer_id uuid, huella text, suprimido boolean)
language plpgsql
stable
security definer
set search_path = restaurantes, core, extensions, public, pg_temp
as $$
#variable_conflict use_column
begin
  if not restaurantes.cliente_es_admin(p_organization_id) then
    raise exception 'historial_existentes: solo owner/admin' using errcode = '42501';
  end if;
  if p_telefonos is null or array_length(p_telefonos, 1) > 20000 then
    raise exception 'historial_existentes: hasta 20000 telefonos' using errcode = '22023';
  end if;
  return query
  select t.p, c.id, h.huella, restaurantes.historial_suprimido(p_organization_id, t.p)
    from unnest(p_telefonos) as t(p)
    left join restaurantes.customers c on c.organization_id = p_organization_id and c.phone = t.p
    left join restaurantes.customer_historial_resumen h on h.customer_id = c.id
   where t.p ~ '^[0-9]{10}$';
end;
$$;
revoke all on function restaurantes.historial_existentes(uuid, text[]) from public, anon;
grant execute on function restaurantes.historial_existentes(uuid, text[]) to authenticated;
