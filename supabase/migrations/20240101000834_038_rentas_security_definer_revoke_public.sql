-- Ola 2 (seguridad), arreglo F.1 — revoke explícito de PUBLIC en las funciones SECURITY DEFINER de `rentas`
-- que nunca lo tuvieron (regla de CLAUDE.md: «toda función security definer con set search_path fijo y revoke
-- de public»). Tenían ACL nula (EXECUTE por omisión de PUBLIC): cualquier rol del clúster, `anon` incluido,
-- podía invocarlas. Defensa en profundidad: la app no usa `anon`, pero el privilegio no debe existir.
--
-- Numeración: 038 = siguiente libre de rentas (main llega a 034; 035-037 están en PRs abiertos).
-- Espejo: supabase/migrations/20240101000834_038_rentas_security_definer_revoke_public.sql.
-- Solo cambia privilegios (ni definiciones ni datos): idempotente y reversible con un grant.
-- Verificación: scripts/verify-security-definer-revoke/ (Postgres real, en el gate de CI).

-- 1) Helpers de autorización de finanzas y pricing. Los llaman las policies RLS de rentas y el código de la app
--    (reportes, «Chatea con tus datos», pricing). Las policies se evalúan con el rol de quien consulta y la app
--    corre SIEMPRE como `authenticated` (ManagedPostgresEngine.withAppSession), así que `authenticated`
--    conserva EXECUTE explícito. Cada helper solo responde sobre el propio auth.uid().
revoke all on function rentas.can_read_finanzas(uuid) from public, anon;
revoke all on function rentas.can_write_finanzas(uuid) from public, anon;
revoke all on function rentas.can_write_pricing(uuid) from public, anon;
grant execute on function
  rentas.can_read_finanzas(uuid),
  rentas.can_write_finanzas(uuid),
  rentas.can_write_pricing(uuid)
to authenticated;

-- 2) rentas.break_glass_log_set_hash(): función de trigger (hash encadenado de rentas.break_glass_access_log).
--    Postgres exige EXECUTE solo al CREAR el trigger, no al dispararlo, y una función `returns trigger` no se
--    puede llamar directo: nadie necesita el privilegio. Sin grant.
revoke all on function rentas.break_glass_log_set_hash() from public, anon;
