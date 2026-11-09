-- Ola 2 (seguridad), arreglo F.1 — revoke explícito de PUBLIC en los helpers SECURITY DEFINER de `licitaciones`
-- que nunca lo tuvieron (regla de CLAUDE.md: «toda función security definer con set search_path fijo y revoke
-- de public»). Tenían ACL nula (EXECUTE por omisión de PUBLIC): cualquier rol del clúster, `anon` incluido,
-- podía invocarlos. Defensa en profundidad: la app no usa `anon`, pero el privilegio no debe existir.
--
-- Numeración: 042 = siguiente libre de licitaciones por encima de los PRs abiertos (main llega a 038; 039 y 041
-- están en PRs abiertos; 040 se deja libre para no intercalar entre ellos).
-- Espejo: supabase/migrations/20240101000833_042_licitaciones_security_definer_revoke_public.sql.
-- Solo cambia privilegios (ni definiciones ni datos): idempotente y reversible con un grant.
-- Verificación: scripts/verify-security-definer-revoke/ (Postgres real, en el gate de CI).

-- Helpers de autorización por organización. Los llaman las policies RLS de licitaciones y el código de la app
-- (repositorio y «Chatea con tus datos»). Las policies se evalúan con el rol de quien consulta y la app corre
-- SIEMPRE como `authenticated` (ManagedPostgresEngine.withAppSession), así que `authenticated` conserva
-- EXECUTE explícito. Cada helper solo responde sobre el propio auth.uid() (sin auth.uid() devuelven false).
revoke all on function licitaciones.can_access_org(uuid) from public, anon;
revoke all on function licitaciones.can_decide_org(uuid) from public, anon;
revoke all on function licitaciones.can_go_no_go_org(uuid) from public, anon;
revoke all on function licitaciones.can_manage_org_settings(uuid) from public, anon;
revoke all on function licitaciones.can_review_inconformidad_org(uuid) from public, anon;
revoke all on function licitaciones.can_write_org(uuid) from public, anon;
grant execute on function
  licitaciones.can_access_org(uuid),
  licitaciones.can_decide_org(uuid),
  licitaciones.can_go_no_go_org(uuid),
  licitaciones.can_manage_org_settings(uuid),
  licitaciones.can_review_inconformidad_org(uuid),
  licitaciones.can_write_org(uuid)
to authenticated;
