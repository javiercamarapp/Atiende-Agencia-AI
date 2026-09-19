-- Aplica DESPUÉS de las migraciones reales — ver el comentario de cabecera de
-- scripts/verify-flujos-staff/post-migrations.sql (mismo criterio EXACTO, solo
-- cambian los schemas cubiertos: rentas + despachos + licitaciones, las 3
-- verticales de esta Parte 2, más `core` para los helpers de membership que las 3
-- usan).
grant usage on schema rentas, despachos, licitaciones, core to authenticated, anon;
