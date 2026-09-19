-- Hallazgo MÁS GRAVE verificado hasta ahora en este repo, documentado primero en
-- `scripts/verify-restaurantes-sql/README.md` (PR #138, sección "Hallazgo conocido,
-- verificado, NO corregido en esta rama"): las policies de SELECT de `core.property`
-- y `core.organization` (`0001_core_schema.sql`, nunca tocadas por ninguna migración
-- posterior salvo la policy ADITIVA de `..._007_owner_portal_core_organization_
-- policy.sql`, que no la reemplaza) exigen `auth.uid()` no nulo — bajo sesión de
-- SISTEMA (`packages/db/src/managed-postgres-engine.ts::withAppSession({ userId:
-- null })`, usada por TODOS los flujos sin usuario: checkout público, Server Tools de
-- voz, webhooks de WhatsApp, crons y dispatchers de las 6 verticales), `auth.uid()`
-- es SIEMPRE NULL, así que CUALQUIER lectura o JOIN directo contra `core.property`/
-- `core.organization` devuelve CERO filas SIEMPRE, en silencio (nunca un error).
--
-- Impacto real, verificado contra Postgres real con `scripts/verify-core-rls-sesion-
-- sistema/run.sh` (ver ese directorio, antes/después) — no solo restaurantes:
--   - restaurantes: `resolveOrganizationOrNotFound` (`apps/api/src/routes/verticals/
--     restaurantes/public.ts`) → `findOrganizationBySlug` (`core.organization`) falla
--     PRIMERO con 404 "Restaurante no encontrado" en TODO checkout público (web/voz) —
--     un paso ANTES de lo que ya documentaba el hallazgo original de `findBranch()`
--     (`core.property`, mismo repositorio). Ambos JOINs rotos por la MISMA causa.
--   - citas: `findOrganizationBySlug`/`listPropertiesForOrganization`/
--     `listActiveOrganizations`/`findOrganizationById` (`postgres-repository.ts`) —
--     booking público, las 3 acciones del agente (cancelar/reagendar/reasignar), las
--     4 Server Tools de voz y el cron de recordatorio de 24h (que recorre 0
--     organizaciones, `ok:true`, sin ningún error visible) rotos por la misma causa.
--   - licitaciones: `listActiveOrganizations` (`select id from core.organization ...`)
--     usada por discovery/deadline-reminders/alert-notifications (3 crons) — los 3
--     recorren SIEMPRE 0 organizaciones, silenciosamente.
--   - rentas: `findOcupacionParaCorreo` (`join core.organization`, usada por
--     `checkin-recordatorio.ts`) — gap ya documentado como pendiente en el propio
--     `..._015_cron_publico_rls_escape_hatch.sql` ("el recordatorio se marca enviado
--     pero el correo real nunca sale"); se cierra aquí como efecto directo de este
--     mismo fix, sin tocar ninguna tabla `rentas.*` de nuevo.
--   - hoteles/despachos: mismo patrón de `findOrganizationBySlug`/enumeración de
--     organizaciones activas contra `core.organization`/`core.property` bajo sesión
--     de sistema — ver auditoría completa en el PR de este cambio.
--
-- ── Decisión de diseño (no todas las tablas `core` reciben el mismo remedio) ──────
--
-- Dos caminos posibles, con riesgo NO equivalente (ver `scripts/verify-superadmin-
-- caller-binding/README.md` y la cabecera de `...000127_0011_superadmin_caller_
-- binding.sql` para el análisis ya hecho de exposición por PostgREST):
--   (A) escape hatch en la policy (`auth.uid() is null or <regla actual>`) — amplía
--       lo que ve CUALQUIER sesión de sistema a TODA la tabla, para TODAS las
--       organizaciones. Ya es el patrón establecido de este repo para datos de
--       catálogo de bajo riesgo (`restaurantes.known_zone` — `..._016_known_zone_
--       authenticated_grant.sql`; `restaurantes.categories/products/branch_products/
--       branch_detail` — `..._014_catalogo_publico_scoped.sql`; 9 tablas de
--       `rentas.*` — `..._015_cron_publico_rls_escape_hatch.sql`).
--   (B) función `security definer` acotada, con guard explícito de solo-sistema —
--       patrón YA usado en este repo exactamente para lo sensible: login
--       (`core.find_staff_by_email`/`find_staff_by_id`/`find_memberships_by_user_id`,
--       `...000113_0011_login_lookup_security_definer.sql`, motivado por el mismo
--       síntoma -- "ningún login funcionaba nunca" -- que este hallazgo, pero sobre
--       `core.staff_user`/`core.membership`) y alta de tenant
--       (`rentas.register_tenant_onboarding`, `domain-rentas/migrations/
--       016_onboarding_security_definer.sql`, que SÍ escribe en `core.organization`/
--       `core.property`/`core.membership` bajo sesión de sistema sin abrir RLS).
--
-- `supabase/config.toml::api.schemas` expone `core` por PostgREST. El análisis ya
-- hecho en `...000127` (verificado de nuevo aquí, sin contradecirlo) concluye: HOY
-- ningún flujo real de este repo emite a un cliente externo un JWT de Supabase Auth
-- con rol `authenticated` (`apps/web` nunca usa Supabase Auth; el único cliente
-- `@supabase/supabase-js` -- `realtime-client.ts` de citas -- sólo abre un WebSocket
-- de Realtime con un JWT PROPIO sin claim `role`, nunca invoca `.rpc()`/REST), así
-- que un cliente externo no puede HOY obtener una sesión `authenticated` con
-- `auth.uid()` NULL vía PostgREST -- pero, como ya advertía esa migración, es "una
-- configuración de distancia" (alineación de "Third-Party Auth" que el código ya
-- prepara activamente para Realtime). Por eso:
--
--   - `core.property`/`core.organization` -> camino (A). Datos de catálogo sin PII
--     (id/organization_id/vertical/name/slug/status) -- el mismo perfil de riesgo que
--     `restaurantes.categories/products` (que además exponen lo mismo a `anon`, sin
--     ni siquiera exigir rol `authenticated`). Coherente con el precedente ya
--     establecido tres veces en este repo para exactamente este perfil de dato.
--     Universal entre las 6 verticales (a diferencia de una tabla de una sola
--     vertical), así que una función `security definer` por vertical sería 6 veces
--     el mismo remedio para el mismo problema -- la policy compartida en `core` es
--     la superficie correcta para arreglarlo una sola vez.
--   - `core.membership`/`core.staff_user` -> SIN CAMBIO en esta migración. Son las
--     dos tablas `core` genuinamente sensibles (membership expone la estructura
--     organizacional completa de la plataforma; staff_user expone `email` +
--     `password_hash` de TODO staff de TODA organización) -- exactamente las que el
--     propio criterio de la tarea marca como "mala idea" para el camino (A). Se
--     auditó cada call site de sesión de sistema de las 6 verticales (ver el PR) y
--     NINGUNO encontrado hoy necesita un SELECT directo nuevo contra estas dos tablas
--     que no esté ya cubierto por una función `security definer` existente
--     (`core.find_staff_by_email`/`find_staff_by_id`/`find_memberships_by_user_id`/
--     `find_staff_by_google_sub`/`accept_staff_invite`, y las funciones
--     `*_for_superadmin` ya atadas a `auth.uid() = p_caller_id`). Si un flujo futuro
--     de sistema necesita un lookup puntual de membership/staff_user, el remedio es
--     una función `security definer` nueva y acotada (camino B), nunca abrir estas
--     dos tablas completas a sesión de sistema.
--
-- ── Fuera de alcance de esta migración (documentado, no disfrazado) ──────────────
-- `licitaciones.can_access_org`/`can_write_org`/`can_decide_org` (`..._002_
-- compliance_and_package.sql`) son funciones `security definer` PROPIAS de esa
-- vertical (no de `core`) que también exigen `auth.uid()` no nulo, sin escape hatch.
-- Con este fix, `listActiveOrganizations()` de licitaciones empieza a recorrer
-- organizaciones reales bajo sesión de sistema, pero el INSERT posterior en
-- `licitaciones.tender` (gateado por `can_write_org`) seguiría fallando -- de
-- "silenciosamente 0 organizaciones" a "ruidosamente roto en el INSERT". Arreglar
-- las 3 funciones de licitaciones es una decisión de esa vertical específica
-- (¿escape hatch total, o acotado a las columnas que discovery necesita escribir?),
-- fuera del alcance "RLS de `core` para sesión de sistema" de esta rama -- reportado
-- como hallazgo de seguimiento en el PR, mismo criterio que el propio
-- `verify-restaurantes-sql` usó para diferir este mismo hallazgo la primera vez.
--
-- ── El fix ─────────────────────────────────────────────────────────────────────
-- Mismo patrón EXACTO que `..._014_catalogo_publico_scoped.sql`/`..._016_known_zone_
-- authenticated_grant.sql`/`..._015_cron_publico_rls_escape_hatch.sql`: se reemplaza
-- SOLO la policy relevante de cada tabla (`drop policy if exists` + `create policy`
-- con el mismo nombre), agregando `auth.uid() is null or` delante de la regla ya
-- existente -- nunca `using (true)`. Sin cambios de GRANT (ya existía `grant select
-- ... to authenticated` desde `0001_core_schema.sql`; ninguna de las dos tablas
-- otorga acceso a `anon`, y este fix no lo agrega). La policy aditiva "propietario ve
-- organizaciones donde tiene presencia" (`..._007_owner_portal_core_organization_
-- policy.sql`) no se toca -- sigue sumando OR, redundante pero inofensiva bajo
-- sesión de sistema tras este fix.
--
-- Compatibilidad de despliegue: código y contrato TypeScript SIN CAMBIOS -- esta
-- migración es SOLO SQL. El código ya desplegado sigue funcionando exactamente
-- igual (con el mismo bug) hasta que esta migración se aplique; después de aplicarla
-- empieza a funcionar sin ningún deploy adicional. Se puede desplegar en cualquier
-- orden respecto al código de `apps/api`.

drop policy if exists "staff ve su propia organización" on core.organization;
create policy "staff ve su propia organización"
  on core.organization for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = core.organization.id and m.user_id = auth.uid()
    )
  );

drop policy if exists "staff ve properties de su organización" on core.property;
create policy "staff ve properties de su organización"
  on core.property for select
  using (auth.uid() is null or core.has_property_access(auth.uid(), core.property.id));
