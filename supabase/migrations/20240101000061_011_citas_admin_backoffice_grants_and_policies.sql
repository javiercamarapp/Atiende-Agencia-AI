-- Fase 8 citas — panel admin: crear/editar proveedores, servicios y
-- citas.tenant_config (ver diseño Fase 8 §1-§3, packages/domain-citas/src/repository.ts
-- NewProviderInput/ProviderPatch/NewServiceInput/ServicePatch/TenantConfigPatch).
--
-- Mismo gap real, mismo patrón de arreglo, que
-- 20240101000041_007_admin_backoffice_grants_and_policies.sql (Fase 5 restaurantes):
-- hasta esta migración, `citas.providers`/`citas.services`/`citas.tenant_config` ya
-- traían una policy RLS `for all` desde 001_citas_schema.sql que en la práctica era
-- letra muerta — el GRANT bajo el rol `authenticated` (el rol real que usa una
-- sesión de staff del panel, ver core-tenancy/src/types.ts: "set local role
-- authenticated") solo cubría SELECT; RLS nunca llega a evaluarse si el GRANT ya
-- bloquea la operación primero. `citas.provider_services` (el checkbox real de
-- FichaProveedor.tsx) ni siquiera tenía policy de escritura: solo la policy pública
-- "cualquiera puede ver provider_services" (SELECT). Esta migración es puramente
-- aditiva: ningún GRANT/policy existente se toca ni se reduce.
--
-- Deliberadamente NO se toca `core.organization` (name/slug/status del negocio):
-- ese schema es compartido por las 6 verticales y hoy solo `service_role` tiene
-- GRANT de escritura sobre él (packages/db/migrations/0001_core_schema.sql) —
-- ninguna otra vertical de este monorepo edita esos 3 campos desde una ruta de
-- staff autenticado todavía. Por eso `citas admin.ts` (Fase 8) solo edita
-- `citas.tenant_config` (rubro/default_timezone/owner_notification_phone), nunca
-- `core.organization.name/slug/status` — ver ConfiguracionSection.tsx del origen
-- vs. el alcance real documentado en repository.ts::TenantConfigPatch.

grant insert, update on citas.providers, citas.services to authenticated;
grant insert, update on citas.tenant_config to authenticated;
-- Junction table pura (provider_id, service_id) — el checkbox de
-- FichaProveedor.tsx::toggleServicio solo inserta o borra, nunca actualiza una
-- columna (no hay ninguna columna de datos más allá de la llave compuesta).
grant insert, delete on citas.provider_services to authenticated;

-- `citas.provider_services` no traía ninguna policy de escritura de staff (a
-- diferencia de providers/services/tenant_config, que ya la tenían desde
-- 001_citas_schema.sql) — se agrega aquí, acotada a que el `provider_id` de la fila
-- pertenezca a una organización donde el usuario tiene membership real.
create policy "staff gestiona provider_services de su organización" on citas.provider_services for all
  using (exists (
    select 1 from citas.providers p
    join core.membership m on m.organization_id = p.organization_id
    where p.id = provider_services.provider_id and m.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from citas.providers p
    join core.membership m on m.organization_id = p.organization_id
    where p.id = provider_services.provider_id and m.user_id = auth.uid()
  ));
