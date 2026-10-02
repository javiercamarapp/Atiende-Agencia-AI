-- PM-C2 (Los Taquitos de PM): promociones con alcance por SUCURSAL. Prefijo de supabase/migrations asignado
-- para esta tarea: 20240101000284 (interno 038).
--
-- Problema: `restaurantes.promotions` no tiene sucursal (010; 027 y 031 solo agregan canales, productos,
-- auto_apply y cortesia). El 2x1 del lunes de PM vale en Francisco de Montejo (T2), Pensiones (T3) y Galerias
-- (T4), pero el motor lo aplicaba en TODAS las sucursales (T1, T7 y T8 incluidas), contra el menu impreso y la web.
--
-- Cambio (solo ADITIVO; nada se elimina ni se reemplaza):
--   * `restaurantes.promotions.property_ids uuid[]` -- sucursales (`core.property.id`) donde vale la promocion.
--     `null` = todas las sucursales (conducta de hoy: las filas existentes no cambian). Lista = solo esas.
--   * CHECK `promotions_property_ids_check`: de 1 a 50 elementos (el arreglo vacio se rechaza: no significa
--     "todas", significaria "ninguna", y esa ambiguedad es justo la que se evita; para "todas" se usa null).
--
-- El codigo TypeScript que lo consume degrada contra la base SIN migrar (SQLSTATE 42703) dentro de
-- SAVEPOINT: sin la columna no hay alcance que leer y las promociones valen en todas las sucursales, que es la
-- conducta anterior. Por eso el seed de PM NO carga el 2x1 si la columna no existe (su preflight de esquema lo
-- exige): sin la columna regalaria el 2x1 en T1, T7 y T8.
--
-- Justificacion de seguridad (uno por uno):
--
--  * promotions.property_ids -- columna informativa nueva. NO se agrega ningun GRANT, policy ni funcion: hereda
--    los GRANT de TABLA y las policies RLS de la migracion 010 (el staff solo escribe promociones de SU
--    organizacion; `anon` solo SELECT de las ACTIVAS, que ya existia para resolver un codigo, y la columna
--    nueva es una lista de ids de sucursal que el catalogo publico ya expone). Los GRANT a nivel de tabla de
--    010 cubren la columna nueva sin ampliar a quien puede escribir nada mas.
--  * Sin FK por elemento (Postgres no soporta FK sobre elementos de arreglo, mismo criterio que
--    `product_ids` y `courtesy_product_ids` de 027/031). Un id ajeno NO puede alterar el pedido de otra
--    organizacion: el motor solo compara la lista contra el `property_id` de la sucursal del PROPIO pedido,
--    resuelta dentro de la organizacion del pedido; un id de otra organizacion nunca coincide.
--  * CHECK de tamano (1..50): defensa en profundidad para que un staff no infle la fila.
--  * Sin trigger ni security definer: la regla de alcance vive en `promotions.ts::assertPromotionApplicable`
--    (misma capa que dia, hora y canal), nunca en una funcion privilegiada.

alter table restaurantes.promotions
  add column if not exists property_ids uuid[];

alter table restaurantes.promotions
  add constraint promotions_property_ids_check
  check (property_ids is null or cardinality(property_ids) between 1 and 50);
