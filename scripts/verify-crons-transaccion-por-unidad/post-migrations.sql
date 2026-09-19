-- Aplica DESPUÉS de las migraciones reales -- MISMO criterio que el resto de
-- scripts/verify-*/post-migrations.sql (ver bootstrap.sql para el porqué). El
-- schema `demo` de este script existe desde bootstrap.sql (no depende de ninguna
-- migración real), así que solo hace falta el GRANT que la plataforma real haría
-- al exponerlo -- aquí, a la sesión de `authenticated` que usa
-- `managed-postgres-engine.ts::withAppSession` (nunca a `anon`).
grant usage on schema demo to authenticated;
grant select, insert on demo.unit_result to authenticated;
