-- F4c (paridad menor) -- BORRAR UN PRODUCTO DEL MENU con soft-delete cuando ya tiene historial. Prefijo de supabase/migrations asignado: 20240101000480 (interno 180).
--
-- Decision de diseno: UNA columna nueva y nullable en `restaurantes.products`. Un producto SIN pedidos se borra de verdad (DELETE, ya concedido a `authenticated` desde la
-- migracion 007; `branch_products` cae en cascada). Un producto CON pedidos en su historial (los pedidos guardan el id y el nombre del producto en `orders.items`) no se borra:
-- se ARCHIVA (`archived_at`), se apaga su disponibilidad en todas las sucursales y el panel deja de listarlo; el historial, los reportes y los pedidos viejos siguen leyendo su nombre.
-- Una base sin esta migracion sigue funcionando: el TypeScript que la usa captura 42703 y trata el menu como "sin archivados" (nada se oculta, nada se rompe).
--
-- Justificacion de seguridad:
--  * Ningun GRANT, policy ni funcion nuevos: `products` ya tiene `grant insert, update, delete ... to authenticated` (007) con la policy "staff gestiona productos de su organizacion"
--    (membership de la organizacion); la API ademas exige owner/admin con alcance a toda la organizacion antes de borrar o archivar. Sin cambio para `anon`.
--  * `anon` ya tiene `select` de `products` (catalogo publico, 001). La columna nueva es solo una marca de tiempo: no guarda PII ni al actor. QUIEN archivo queda en la bitacora de auditoria
--    (`restaurantes.audit_log`), nunca en esta tabla, justo para no exponer un id de staff a una lectura publica.
--  * El indice parcial solo acelera el filtro "archivados de una organizacion"; no cambia ninguna restriccion existente, asi que las filas actuales siguen validas (archived_at = null).
alter table restaurantes.products add column archived_at timestamptz;

create index products_archived_idx on restaurantes.products (organization_id) where archived_at is not null;
