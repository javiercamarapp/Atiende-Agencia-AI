-- Port literal de la función SECURITY DEFINER real de
-- hoteles/supabase/migrations/0030_folio_engine.sql (`public.mark_charge_reversed`).
-- Reverso de un cargo (REQ-REC-004): UPDATE restringido a esta función porque
-- `hoteles.charge` solo tiene GRANT de select+insert para `authenticated` (ver
-- 001_hoteles_schema.sql) — la autorización real ya ocurrió en la capa de aplicación
-- (assertVerticalRole(MONEY_ROLES) + SELECT bajo RLS) antes de llamarla.
create or replace function hoteles.mark_charge_reversed(_charge_id uuid, _reversal_charge_id uuid)
returns hoteles.charge
language plpgsql
security definer
set search_path = hoteles
as $$
declare
  v_row hoteles.charge;
begin
  update hoteles.charge
  set reversed_by = _reversal_charge_id
  where id = _charge_id and reversed_by is null
  returning * into v_row;

  if not found then
    raise exception 'reverso_invalido: el cargo % no existe o ya fue reversado', _charge_id
      using errcode = 'P0001';
  end if;

  return v_row;
end;
$$;

revoke all on function hoteles.mark_charge_reversed(uuid, uuid) from public;
grant execute on function hoteles.mark_charge_reversed(uuid, uuid) to authenticated;
