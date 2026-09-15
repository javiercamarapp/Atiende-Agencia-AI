-- Dos hallazgos de auditoría distintos sobre citas, cerrados juntos porque tocan
-- las mismas tablas de catálogo/§conexión de calendario:
--
-- ============================================================================
-- HALLAZGO A (severidad ALTA) — policies "using (true)" sobre catálogo permiten
-- fuga cross-tenant.
-- ============================================================================
-- `001_citas_schema.sql` dejó 3 policies de SELECT genuinamente sin ningún filtro
-- ("cualquiera puede ver provider_services/reglas de disponibilidad/overrides de
-- disponibilidad", las 3 `using (true)`) — a diferencia de
-- `citas.providers`/`citas.services`, que al menos filtran por `is_active`. El
-- comentario original de 001 ("Catálogo de horario/servicios es de lectura
-- pública... un futuro widget de reservación público lo necesitaría") sigue siendo
-- un requisito real (el flujo público de booking, `POST /v1/citas/:orgSlug/
-- appointments`, corre en sesión de sistema -- `withAppSession({ userId: null })`,
-- `auth.uid()` NULL -- y SÍ necesita leer disponibilidad sin JWT), pero
-- `using (true)` es más amplio de lo necesario: como estas 3 tablas también
-- otorgan SELECT a `authenticated` (001, línea 228), CUALQUIER staff autenticado de
-- CUALQUIER organización -- no solo la suya -- puede leer el checkbox
-- proveedor/servicio y el horario COMPLETO de cualquier otro negocio del
-- catálogo, vía una consulta directa (PostgREST) sin pasar por ninguna ruta de la
-- aplicación que ya filtra por `organization_id`. RLS es la última línea de
-- defensa contra exactamente ese escenario y aquí no hacía nada.
--
-- Verificado contra Postgres real (instancia efímera con las 95 migraciones
-- previas + fixtures de 2 organizaciones distintas): con `set role authenticated`
-- y `auth.uid()` de un staff de la organización B, `select * from
-- citas.provider_services where provider_id = '<proveedor de la organización A>'`
-- devolvía la fila -- confirmado el hallazgo antes de escribir el fix.
--
-- Fix: mismo patrón ya usado por `hoteles.night_audit_run`/`citas.enqueue_
-- messaging_outbox` (rentas 094/citas 014) para casos "ambos casos legítimos" --
-- `auth.uid() is null` (sesión de sistema o el propio `anon` público, ambos sin
-- JWT real -- el widget público sigue funcionando exactamente igual) OR staff con
-- membership real de la organización DUEÑA de la fila (join a `citas.providers`,
-- igual criterio que ya usan las policies de escritura "staff gestiona
-- provider_services/reglas de disponibilidad de su organización" de las
-- migraciones 011/013). `citas.providers`/`citas.services` (`using (is_active)`)
-- quedan fuera de este hallazgo -- el auditor lo reportó específicamente sobre
-- `using (true)`, y esas 2 ya filtran por `is_active`; no se tocan aquí para no
-- ampliar el alcance del hallazgo reportado.

drop policy if exists "cualquiera puede ver provider_services" on citas.provider_services;
create policy "público o su organización ve provider_services" on citas.provider_services for select
  using (
    auth.uid() is null
    or exists (
      select 1 from citas.providers p
      join core.membership m on m.organization_id = p.organization_id
      where p.id = provider_services.provider_id and m.user_id = auth.uid()
    )
  );

drop policy if exists "cualquiera puede ver reglas de disponibilidad" on citas.availability_rules;
create policy "público o su organización ve reglas de disponibilidad" on citas.availability_rules for select
  using (
    auth.uid() is null
    or exists (
      select 1 from citas.providers p
      join core.membership m on m.organization_id = p.organization_id
      where p.id = availability_rules.provider_id and m.user_id = auth.uid()
    )
  );

drop policy if exists "cualquiera puede ver overrides de disponibilidad" on citas.availability_overrides;
create policy "público o su organización ve overrides de disponibilidad" on citas.availability_overrides for select
  using (
    auth.uid() is null
    or exists (
      select 1 from citas.providers p
      join core.membership m on m.organization_id = p.organization_id
      where p.id = availability_overrides.provider_id and m.user_id = auth.uid()
    )
  );

-- ============================================================================
-- HALLAZGO B (severidad ALTA) — policies "letra muerta" (definidas pero sin GRANT
-- que las haga alcanzables) en citas.
-- ============================================================================
-- Revisadas TODAS las policies `for all`/`for insert`/`for update`/`for delete` de
-- `packages/domain-citas/migrations/*.sql` cruzándolas contra los GRANT de tabla
-- existentes (`grep -Hn "grant .* on citas\."`). Resultado, caso por caso:
--
-- CIERRA (gap real, staff no puede usar una función ya construida en producción):
--   - citas.provider_calendar_accounts (005_google_calendar_sync.sql): policy
--     "for all" desde el día uno, pero el GRANT de 005 solo cubre SELECT para
--     `authenticated` (INSERT/UPDATE/DELETE únicamente a `service_role`, que nunca
--     se aprovisiona). `connectProviderCalendarAccount`
--     (postgres-repository.ts) hace un INSERT ... ON CONFLICT DO UPDATE real
--     desde `google-calendar-oauth.ts` (staff panel, JWT real,
--     `requirePropertyMembership`) -- sin este GRANT, "conectar mi Google
--     Calendar" está roto de punta a punta en producción real. Además,
--     `setProviderCalendarAccountSyncError` (mismo repositorio) hace un UPDATE
--     desde `google-calendar-sync.ts`, que corre en SESIÓN DE SISTEMA
--     (`withAppSession({ userId: null })`, el cron de sincronización) -- la
--     policy de membership sola NUNCA lo dejaría pasar (auth.uid() null jamás
--     matchea ninguna fila de core.membership), así que además del GRANT hace
--     falta el mismo escape hatch de sesión de sistema que ya usa
--     `hoteles.night_audit_run`/rentas 094.
--   - citas.provider_calcom_accounts / citas.provider_caldav_accounts
--     (008_calendar_provider_accounts.sql): mismo gap exacto (policy "for all",
--     GRANT de 008 solo cubre SELECT) -- `connectProviderCalComAccount`/
--     `connectProviderCalDavAccount` (postgres-repository.ts) hacen el mismo
--     INSERT ... ON CONFLICT DO UPDATE desde `calendar-providers.ts` (staff
--     panel, JWT real). A diferencia de Google, verificado con `grep -rn` que
--     NINGÚN cron/sesión de sistema escribe estas 2 tablas -- sin UPDATE desde
--     sesión de sistema, no hace falta el escape hatch, solo el GRANT.
--
-- SE DEJA SIN TOCAR (revisado, no es un gap real hoy -- documentado para que el
-- próximo auditor no lo vuelva a reportar como pendiente):
--   - citas.tenant_config / citas.providers / citas.services (001): la policy
--     "for all" cubre también DELETE, pero el GRANT de 001/011 solo llega a
--     INSERT/UPDATE. Verificado con `grep -rn "delete from citas\.\(tenant_config\|
--     providers\|services\)" packages/domain-citas/src`: NINGÚN código de este
--     repo borra una fila de estas 3 tablas -- el patrón establecido en todo este
--     vertical (igual que `is_active` en providers/services) es desactivar, nunca
--     borrar. Agregar el GRANT DELETE hoy no destrabaría ninguna funcionalidad
--     rota -- se deja pendiente hasta que exista un caso de uso real de borrado.
--   - citas.property_config (001): la policy "for all" no tiene NINGÚN GRANT de
--     escritura (ni INSERT ni UPDATE ni DELETE). Verificado con `grep -rn
--     "property_config" packages/domain-citas/src`: la única operación real
--     existente es un SELECT (`findPropertyTimezone`) -- ninguna ruta HTTP de
--     este repo escribe esta tabla todavía. El propio comentario de 001 ya
--     documenta el fallback: "Un tenant de una sola ubicación no necesita
--     ninguna fila aquí: el fallback es citas.tenant_config.default_timezone".
--     Cerrar el GRANT sin construir primero la ruta de "configurar timezone por
--     sucursal" sería agregar superficie sin caso de uso -- se deja pendiente
--     para cuando esa ruta se construya.

drop policy if exists "staff gestiona provider_calendar_accounts de su organización" on citas.provider_calendar_accounts;
create policy "staff gestiona provider_calendar_accounts de su organización" on citas.provider_calendar_accounts for all
  using (
    auth.uid() is null
    or exists (select 1 from core.membership m where m.organization_id = provider_calendar_accounts.organization_id and m.user_id = auth.uid())
  )
  with check (
    auth.uid() is null
    or exists (select 1 from core.membership m where m.organization_id = provider_calendar_accounts.organization_id and m.user_id = auth.uid())
  );

grant insert, update on citas.provider_calendar_accounts to authenticated;
grant insert, update on citas.provider_calcom_accounts, citas.provider_caldav_accounts to authenticated;
