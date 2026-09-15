-- Fase 10 citas — panel admin: crear/editar/borrar horarios de disponibilidad
-- recurrentes y excepciones puntuales (ver diseño Fase 10 §1/§2,
-- packages/domain-citas/src/repository.ts NewAvailabilityRuleInput/
-- AvailabilityRulePatch/AvailabilityOverrideInput).
--
-- Mismo gap real, mismo patrón de arreglo, que
-- 011_citas_admin_backoffice_grants_and_policies.sql (Fase 8 citas) y
-- 20240101000041_007_admin_backoffice_grants_and_policies.sql (Fase 5
-- restaurantes): `citas.availability_rules`/`citas.availability_overrides` traían,
-- desde 001_citas_schema.sql, SOLO una policy pública de SELECT ("cualquiera puede
-- ver reglas/overrides de disponibilidad") — a diferencia de
-- `citas.providers`/`citas.services`/`citas.tenant_config`, NUNCA tuvieron una
-- policy `for all` de staff, ni un GRANT de escritura bajo `authenticated` (el rol
-- real que usa una sesión de staff del panel, ver core-tenancy/src/types.ts: "set
-- local role authenticated"). Sin esto, un negocio nuevo dado de alta desde el
-- panel no podía recibir ni una cita: `availability.ts::computeAvailableSlots`
-- nunca encuentra una fila de `availability_rules` de dónde calcular slots, y
-- nadie podía insertar una salvo por SQL directo. Esta migración es puramente
-- aditiva: ningún GRANT/policy existente se toca ni se reduce.

grant insert, update, delete on citas.availability_rules to authenticated;
grant insert, update, delete on citas.availability_overrides to authenticated;

-- Ninguna de las 2 tablas tiene `organization_id` propio (son hijas de
-- `citas.providers` vía `provider_id`, ver 001_citas_schema.sql) — la policy
-- resuelve la organización dueña vía join a `citas.providers`, mismo criterio
-- exacto que "staff gestiona provider_services de su organización" de la
-- migración 011.
create policy "staff gestiona reglas de disponibilidad de su organización" on citas.availability_rules for all
  using (exists (
    select 1 from citas.providers p
    join core.membership m on m.organization_id = p.organization_id
    where p.id = availability_rules.provider_id and m.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from citas.providers p
    join core.membership m on m.organization_id = p.organization_id
    where p.id = availability_rules.provider_id and m.user_id = auth.uid()
  ));

create policy "staff gestiona excepciones de disponibilidad de su organización" on citas.availability_overrides for all
  using (exists (
    select 1 from citas.providers p
    join core.membership m on m.organization_id = p.organization_id
    where p.id = availability_overrides.provider_id and m.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from citas.providers p
    join core.membership m on m.organization_id = p.organization_id
    where p.id = availability_overrides.provider_id and m.user_id = auth.uid()
  ));
