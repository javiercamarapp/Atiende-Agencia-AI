# verify-restaurantes-cfo-huecos

Verificacion contra Postgres real (rol REAL `authenticated`, RLS, GRANT y `auth.uid()`) de
`packages/domain-restaurantes/migrations/084_cfo_huecos_frecuentes_p90_es_venta_forma_pago.sql`
(espejo: `supabase/migrations/20240101000394_084_cfo_huecos_frecuentes_p90_es_venta_forma_pago.sql`), CFO-02b.

La 084 cierra cuatro huecos del CFO de restaurantes:

1. `restaurantes.cfo_clientes_frecuentes_dormidos` (NUEVA): clientes frecuentes (N pedidos en X dias, de `cfo_config` o parametros) con >= M dias sin pedir,
   por sucursal y del conjunto (no aditivo), con muestra opcional de alias hash.
2. `restaurantes.cfo_descuento_p90` (NUEVA): percentil 90 del descuento % diario por sucursal y del conjunto; NULL con menos de 14 dias con venta.
3. `restaurantes.cfo_pedidos_detalle` (DROP + CREATE): agrega `es_venta` AL FINAL.
4. `restaurantes.sr_resumen_leer` (DROP + CREATE): agrega `forma_pago` AL FINAL; el renglon se parte por forma de pago.

Cubre (61 escenarios, valores calculados a mano):

- Frecuentes dormidos: bordes de ventana (dia 90 si, dia 91 no), de dormido (30 dias exactos si), cliente repartido entre sucursales (frecuente solo en el
  conjunto, `Σ sucursales != conjunto`), ruido que NO cuenta (cancelado, programado, por_aprobar, sin cliente) y `completado` que SI cuenta, umbrales de
  `cfo_config` y su sobreescritura por parametros, coincidencia con `cfo_clientes_resumen.frecuentes` (082), muestra sin PII (solo `alias`, `pedidos`,
  `dias_sin_pedir`, `neta_centavos`), organizacion vacia.
- Descuento p90: interpolacion lineal (18.10 y 29.05), minimo de 14 dias, ruido fuera (cancelado, falso, por_aprobar, programado, bruta 0, fuera de ventana),
  ventana de 60 dias, organizacion vacia.
- `es_venta` en el detalle: contrato de 20 columnas (las 19 de la 081 en su orden), `entregado` y `completado` venta, cancelado/falso/por_aprobar no, filtro y cursor intactos.
- `forma_pago` en SR: contrato de 11 columnas (las 10 de la 083 en su orden), minusculas, NULL sin forma, Σ identica a la 083, aditividad contra la tabla, orden,
  reemplazo por reimportacion.
- Seguridad: owner, admin acotado, staff, owner de otra organizacion, owner multi-organizacion pidiendo sucursales de otra (42501), anon (42501), sistema
  cruzando organizaciones (42501); limites de parametros iguales a los de `cfo_config` (22023) y sus extremos exactos.
- Volumen: 6 000 pedidos, 1 500 clientes, 3 sucursales; cada llamada < 3 s.
- Postura acotada a las 4 funciones (nunca `like 'cfo\_%'`): grants, DEFINER, `search_path` fijo (0 sin fijar), STABLE, COMMENT, READ ONLY, sin PII, idempotencia,
  helpers de la 081/082/083 sin abrir, base sin migrar (42883 recuperable).

- Manual: `scripts/verify-restaurantes-cfo-huecos/run.sh` (levanta un Postgres efimero con `initdb`; `VERIFY_PGPORT` fija el puerto, por omision 55684).
- CI: lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs` (contrato de 3 archivos). Con un Postgres propio:
  `PGPORT=<puerto> node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-restaurantes-cfo-huecos`.

## Contrato para el TypeScript

- `bigint` y `numeric` llegan como string desde el driver: convertir.
- `cfo_clientes_frecuentes_dormidos`: `property_id`, `alcance` (`sucursal`|`conjunto`), `frecuente_n`, `frecuente_dias`, `dormido_dias` (los efectivos),
  `frecuentes`, `frecuentes_dormidos`, `pedidos_ventana`, `neta_ventana_centavos`, `muestra` (jsonb).
- `cfo_descuento_p90`: `property_id`, `alcance`, `dias`, `desde`, `hasta`, `dias_con_venta`, `p90_pct` (NULL = sin historia suficiente, nunca 0).
- `cfo_pedidos_detalle`: igual que antes mas `es_venta`.
- `sr_resumen_leer`: igual que antes mas `forma_pago` (NULL = el archivo no la traia); sumar los renglones de un mismo (sucursal, dia, servicio) da lo de antes.
