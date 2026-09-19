-- Aplica DESPUÉS de las migraciones reales (los schemas de vertical no existen
-- todavía cuando corre bootstrap.sql). Ver el comentario de cabecera de
-- bootstrap.sql: en Supabase real esto lo hace la plataforma al exponer un schema
-- vía PostgREST, no una migración de este repo. A diferencia de los `verify-*/`
-- anteriores (una sola vertical), este cubre las 3 verticales ejercitadas por
-- assertions.sql (hoteles + restaurantes + citas) más `core` (helpers de
-- membership que todas usan).
grant usage on schema hoteles, restaurantes, citas, core to authenticated, anon;
