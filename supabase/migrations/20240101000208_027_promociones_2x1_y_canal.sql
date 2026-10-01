-- R-02 (Los Taquitos de PM) -- promociones 2x1 y restriccion por canal.
--
-- Hasta la migracion 010 `restaurantes.promotions` solo sabia descontar un porcentaje o un
-- monto fijo del total. PM necesita: (a) "2x1" (el lunes, 2x1 en tacos al pastor) y (b) que una
-- promocion valga solo en ciertos canales de pedido (las promociones de PM NO aplican a
-- domicilio: solo recoger / comer en sucursal). Esta migracion agrega:
--
--   * type = 'bogo' (compra uno, el segundo va gratis; ver domain-restaurantes/src/promotions.ts
--     para la regla exacta de calculo). `value` se fija en 1 para bogo (la tabla exige value > 0).
--   * channels text[]  -- canales de pedido donde aplica ('domicilio' | 'recoger'); null = todos.
--   * product_ids uuid[] -- productos elegibles (bogo/otros); null = todos los renglones. Es un
--     arreglo sin FK (Postgres no soporta FK por elemento): la API valida que cada id sea un
--     producto de la organizacion y el motor solo compara contra los renglones del MISMO pedido,
--     asi que un id ajeno no puede alterar el pedido de otra organizacion.
--
-- SEGURIDAD (justificacion de cada cambio):
--   * NO se agrega ningun GRANT ni policy nueva. Las columnas nuevas heredan los GRANT de tabla
--     ya existentes de la migracion 010 (select a anon/authenticated; insert/update/delete a
--     authenticated) y las policies RLS por organizacion (staff gestiona solo las suyas). El
--     select publico de promociones ACTIVAS ya existia para resolver un codigo en el checkout;
--     las columnas nuevas (canales y productos elegibles) no son datos sensibles.
--   * Los CHECK nuevos acotan el tamano (<= 50 productos, <= 2 canales) para que un staff no
--     pueda inflar la fila (defensa de disponibilidad).
--   * No hay funciones nuevas ni security definer. `increment_promotion_uses` (010) no cambia.
--
-- COMPATIBILIDAD: el codigo TypeScript lee y escribe estas columnas con SAVEPOINT y cae al SQL
-- anterior (SQLSTATE 42703) si esta migracion todavia no esta aplicada.

alter table restaurantes.promotions drop constraint if exists promotions_type_check;
alter table restaurantes.promotions
  add constraint promotions_type_check check (type in ('percentage', 'fixed', 'bogo'));

alter table restaurantes.promotions
  add constraint promotions_bogo_value_check check (type <> 'bogo' or value = 1);

alter table restaurantes.promotions add column channels text[];
alter table restaurantes.promotions add column product_ids uuid[];

alter table restaurantes.promotions
  add constraint promotions_channels_check
  check (channels is null or (cardinality(channels) between 1 and 2 and channels <@ array['domicilio', 'recoger']::text[]));
alter table restaurantes.promotions
  add constraint promotions_product_ids_check
  check (product_ids is null or cardinality(product_ids) between 1 and 50);
