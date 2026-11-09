-- Aplica DESPUÉS de las migraciones reales. En Supabase real el USAGE de schema lo
-- pone la plataforma; `mcp_cfdi` ya trae su propio `grant usage ... to authenticated`
-- en 001_folio_stamp_reservation.sql, aquí solo se repite el de los schemas core.
grant usage on schema citas, hoteles, restaurantes, despachos, licitaciones, rentas, core to authenticated, anon;
