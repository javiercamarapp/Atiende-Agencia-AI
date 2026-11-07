-- Onboarding P0: toda organizacion que nace en prueba ('trial') nace con fecha de fin de prueba (14 dias).
--
-- Problema: core.organization.trial_ends_at (0046) solo se fijaba con SQL de soporte (docs/PLANES-TOPES.md). Ni el alta del superadmin
-- (core.confirm_org_admin_action tipo 'alta', 0038) ni el registro autoservicio de rentas (rentas.register_tenant_onboarding) lo fijan, asi
-- que una cuenta nueva no tenia avisos de fin de prueba, ni banner con dias restantes, y la regla "la prueba opera como activa hasta
-- trial_ends_at" (domain-citas / domain-licitaciones) no tenia fecha contra la cual medirse.
--
-- Que agrega (aditivo; ninguna funcion existente se reemplaza):
--   core.organization_trial_ends_at_default() + trigger BEFORE INSERT en core.organization: si la fila nace con status 'trial' y SIN
--   trial_ends_at, la fija en now() + 14 dias. Un INSERT que trae su propia fecha la conserva; los UPDATE no se tocan (soporte puede
--   extender, acortar o quitar la fecha como hoy). Las organizaciones existentes NO cambian (sin backfill: decidir su fecha es de negocio).
--
-- Justificacion de seguridad:
--   * Funcion de trigger (no invocable por RPC: returns trigger), `set search_path = core, pg_temp`, sin SQL dinamico; solo escribe la
--     columna trial_ends_at de la MISMA fila que se esta insertando. No es security definer: corre con los permisos de quien inserta, que
--     ya debia poder insertar en core.organization (las funciones definer de 0038 y de rentas). `revoke all ... from public` por higiene.
--   * No se crea ninguna tabla, policy ni GRANT.

create or replace function core.organization_trial_ends_at_default()
returns trigger
language plpgsql
set search_path = core, pg_temp
as $$
begin
  if new.status = 'trial' and new.trial_ends_at is null then
    new.trial_ends_at := now() + interval '14 days';
  end if;
  return new;
end;
$$;
revoke all on function core.organization_trial_ends_at_default() from public;

drop trigger if exists organization_trial_ends_at_default on core.organization;
create trigger organization_trial_ends_at_default
  before insert on core.organization
  for each row execute function core.organization_trial_ends_at_default();
