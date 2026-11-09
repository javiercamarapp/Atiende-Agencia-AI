-- Ola 2 (seguridad), arreglo F.1 — revoke explícito de PUBLIC en las funciones SECURITY DEFINER de `hoteles`
-- que nunca lo tuvieron (regla de CLAUDE.md: «toda función security definer con set search_path fijo y revoke
-- de public»). Todas tenían el EXECUTE por omisión de PUBLIC (ACL nula, o `=X` explícito en
-- apply_cfdi_webhook_status): cualquier rol del clúster, `anon` incluido, podía invocarlas. Defensa en
-- profundidad: la app no usa `anon`, pero el privilegio no debe existir.
--
-- Numeración: 051 = siguiente libre de hoteles (main llega a 050; 044 y 046 están en PRs abiertos).
-- Espejo: supabase/migrations/20240101000832_051_hoteles_security_definer_revoke_public.sql.
-- Solo cambia privilegios (ni definiciones ni datos): idempotente y reversible con un grant.
-- Verificación: scripts/verify-security-definer-revoke/ (Postgres real, en el gate de CI).

-- 1) Helpers de autorización por propiedad. Los llaman las policies RLS de hoteles (folio, charge,
--    cfdi_emision, fraud_alert, reputación, revenue, asistencia, catálogo…) y el código de la app. Las policies
--    se evalúan con el rol de quien consulta y la app corre SIEMPRE como `authenticated`
--    (ManagedPostgresEngine.withAppSession), así que `authenticated` conserva EXECUTE explícito. Cada helper
--    solo responde sobre el propio auth.uid() (sin auth.uid() devuelven false).
revoke all on function hoteles.can_access_money(uuid) from public, anon;
revoke all on function hoteles.can_access_pl(uuid) from public, anon;
revoke all on function hoteles.can_approve_revenue_autopilot(uuid) from public, anon;
revoke all on function hoteles.can_manage_attendance(uuid) from public, anon;
revoke all on function hoteles.can_manage_catalog(uuid) from public, anon;
revoke all on function hoteles.can_manage_reservations(uuid) from public, anon;
revoke all on function hoteles.can_manage_revenue_gate(uuid) from public, anon;
revoke all on function hoteles.can_resolve_reputacion_accion(uuid) from public, anon;
revoke all on function hoteles.can_submit_reputacion(uuid) from public, anon;
revoke all on function hoteles.can_view_reputacion(uuid) from public, anon;
grant execute on function
  hoteles.can_access_money(uuid),
  hoteles.can_access_pl(uuid),
  hoteles.can_approve_revenue_autopilot(uuid),
  hoteles.can_manage_attendance(uuid),
  hoteles.can_manage_catalog(uuid),
  hoteles.can_manage_reservations(uuid),
  hoteles.can_manage_revenue_gate(uuid),
  hoteles.can_resolve_reputacion_accion(uuid),
  hoteles.can_submit_reputacion(uuid),
  hoteles.can_view_reputacion(uuid)
to authenticated;

-- 2) hoteles.apply_cfdi_webhook_status(uuid, text): solo la sesión de sistema del webhook de CFDI
--    (authenticated sin auth.uid(); la función rechaza con 42501 si hay auth.uid()). Ya tenía grant explícito a
--    `authenticated`, que se conserva; se quita el `=X` de PUBLIC.
revoke all on function hoteles.apply_cfdi_webhook_status(uuid, text) from public, anon;
grant execute on function hoteles.apply_cfdi_webhook_status(uuid, text) to authenticated;

-- 3) Funciones de trigger (hash encadenado de asistencia, bitácora de estado de reserva y guardas de revenue).
--    Postgres exige EXECUTE solo al CREAR el trigger, no al dispararlo, y una función `returns trigger` no se
--    puede llamar directo: nadie necesita el privilegio. Sin grant.
revoke all on function hoteles.attendance_log_set_hash() from public, anon;
revoke all on function hoteles.competitor_rate_guard() from public, anon;
revoke all on function hoteles.local_event_guard() from public, anon;
revoke all on function hoteles.pricing_rule_guard() from public, anon;
revoke all on function hoteles.property_config_guard() from public, anon;
revoke all on function hoteles.rate_recommendation_status_guard() from public, anon;
revoke all on function hoteles.reservation_log_status_event() from public, anon;
revoke all on function hoteles.reservation_log_status_event_on_insert() from public, anon;
revoke all on function hoteles.revenue_backtest_run_guard() from public, anon;
revoke all on function hoteles.revenue_engine_gate_transition_guard() from public, anon;
