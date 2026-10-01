# verify-restaurantes-demo

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/037_demo_organization.sql`
(`restaurantes.demo_organization`, la marca `is_demo`, y `restaurantes.demo_limpiar`).

Cubre: lectura de la marca por la sesion de sistema y por el staff de la propia organizacion (y NO por el de otra ni por
`anon`); que ningun rol de la aplicacion pueda insertar, actualizar ni borrar la marca (ni el owner de la propia
organizacion); y la funcion de limpieza: se niega sobre una organizacion no demo, se niega con un usuario autenticado
(guarda `auth.uid()`), rechaza modos invalidos, borra solo los telefonos ficticios del modo pedido (`volumen` = `0001`,
`sesiones_widget` = `0009`) sin tocar pedidos reales de la misma organizacion ni datos de otra, y `todo` borra la
organizacion demo completa por cascada.

- Manual: `scripts/verify-restaurantes-demo/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs`.
