-- Aplica DESPUÉS de las migraciones reales (mismo criterio que el resto de
-- scripts/verify-*/ -- ver bootstrap.sql). Solo el schema que este verify
-- ejercita.
grant usage on schema citas, core to authenticated, anon;
