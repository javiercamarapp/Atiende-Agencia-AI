-- 143 (revision P-8): cliente_es_admin exige alcance de TODA la organizacion (membership.property_ids is null).
-- Antes un admin acotado a UNA sucursal podia importar, exportar, borrar y fusionar clientes de toda la organizacion (derechos ARCO incluidos).
-- Mismo criterio que 052 y 100 (owner/admin con property_ids nulo). Afecta a las funciones que ya usan este helper (049 ARCO, 140-142).
-- REVERSA: volver a la definicion de 049 (sin la condicion de property_ids).
create or replace function restaurantes.cliente_es_admin(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from core.membership m
     where m.user_id = auth.uid()
       and m.organization_id = p_organization_id
       and m.vertical_role in ('owner', 'admin')
       and m.property_ids is null
  );
$$;
revoke all on function restaurantes.cliente_es_admin(uuid) from public, anon;
grant execute on function restaurantes.cliente_es_admin(uuid) to authenticated;
