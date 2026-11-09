-- Ola 2 (seguridad), arreglo F.1 — revoke explícito de PUBLIC en las funciones SECURITY DEFINER de `core`
-- que nunca lo tuvieron (regla de CLAUDE.md: «toda función security definer con set search_path fijo y revoke
-- de public»). Ambas tienen ACL nula, es decir, el EXECUTE por omisión de PUBLIC: cualquier rol del clúster,
-- `anon` incluido, podía invocarlas. Defensa en profundidad: la app no usa `anon`, pero el privilegio no debe
-- existir.
--
-- Numeración: 0091 = siguiente libre de packages/db (main llega a 0090; 0078-0083 están en PRs abiertos).
-- Espejo: supabase/migrations/20240101000831_0091_security_definer_revoke_public.sql.
-- Solo cambia privilegios (ni definiciones ni datos): idempotente y reversible con un grant.
-- Verificación: scripts/verify-security-definer-revoke/ (Postgres real, en el gate de CI).

-- core.has_property_access(uuid, uuid): helper de autorización que llaman las policies RLS de core.property
-- y de casi todas las tablas de despachos/hoteles (`using (core.has_property_access(auth.uid(), property_id))`)
-- y el código de la app. Las policies se evalúan con el rol de quien consulta y la app corre SIEMPRE como
-- `authenticated` (ManagedPostgresEngine.withAppSession, con o sin auth.uid()), así que `authenticated`
-- conserva EXECUTE explícito; PUBLIC y `anon` lo pierden. Las únicas tablas con GRANT a `anon` cuya policy lo
-- llamaba (restaurantes.branch_detail/branch_products) ya tienen una policy propia de anon sin el helper
-- (202_restaurantes_catalogo_publico_policy_por_rol, espejo 830, aplicada ANTES que esta).
revoke all on function core.has_property_access(uuid, uuid) from public, anon;
grant execute on function core.has_property_access(uuid, uuid) to authenticated;

-- core.impersonation_log_set_hash(): función de trigger (hash encadenado de core.impersonation_audit_log).
-- Postgres exige EXECUTE solo al CREAR el trigger, no al dispararlo, y una función `returns trigger` no se
-- puede llamar directo: nadie necesita el privilegio. Sin grant.
revoke all on function core.impersonation_log_set_hash() from public, anon;
