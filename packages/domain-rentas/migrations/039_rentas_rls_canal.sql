-- Ola 2 (seguridad), arreglo F.3 — RLS en rentas.canal, una de las dos únicas tablas de los schemas del repo sin
-- RLS habilitado.
--
-- Qué es: catálogo GLOBAL de los 4 canales de reserva (001_rentas_schema: airbnb, vrbo, booking, manual). Sin
-- organization_id/property_id: no es dato de tenant. La leen packages/domain-rentas/src/postgres-repository.ts y
-- «Chatea con tus datos» (data-chat/sql.ts) bajo `authenticated` (staff y sesión de sistema); 001 le dio SELECT a
-- `authenticated` y escritura solo a `service_role`. Nadie la escribe fuera de migraciones.
--
-- Hasta hoy su único control era el GRANT. Con RLS:
--   * SELECT para `authenticated` con un predicado que enumera el dominio cerrado del catálogo (no `using (true)`):
--     la app sigue viendo exactamente los 4 canales, y un canal agregado fuera de una migración revisada no lo ve
--     (no aparece en reportes ni en la sincronización iCal hasta que una migración lo apruebe).
--   * Sin policy de INSERT/UPDATE/DELETE: aunque un GRANT futuro abriera escritura a `authenticated`, la RLS la
--     niega. `anon` no tiene GRANT (sin cambio). El dueño y `service_role` (BYPASSRLS) no cambian.
-- Al agregar un canal en una migración futura, amplía esta policy en la MISMA migración
-- (scripts/verify-rls-catalogos-globales, escenario 7, se pone rojo si una fila sembrada queda oculta).
--
-- Numeración: 039 = siguiente libre de rentas (main llega a 034; 035-037 en PRs abiertos; 038 la usa el PR de
-- revoke de security definer de esta misma ola). Espejo: supabase/migrations/20240101000836_039_rentas_rls_canal.sql.
-- Compatibilidad: no cambia columnas ni filas; el código no cambia.

alter table rentas.canal enable row level security;

drop policy if exists "catálogo de canales: lectura de la app" on rentas.canal;
create policy "catálogo de canales: lectura de la app" on rentas.canal
  for select to authenticated
  using (codigo in ('airbnb', 'vrbo', 'booking', 'manual'));
