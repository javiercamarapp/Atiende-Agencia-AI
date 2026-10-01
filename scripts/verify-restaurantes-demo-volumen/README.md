# verify-restaurantes-demo-volumen

Verificacion contra Postgres real del seed de VOLUMEN de la cuenta demo (R-20): `packages/domain-restaurantes/src/seed/demo-volume.ts`
(generador sobre el motor real de pedidos), `demo-volume-sql.ts` (el SQL idempotente que ejecuta `scripts/seed-pm-demo/seed-volumen.ts`)
y la limpieza `restaurantes.demo_limpiar` (migracion 036).

`assertions.sql` es **generado**: crea funciones con el cuerpo plpgsql REAL del seed de la cuenta demo y del seed de volumen (con un
volumen pequeno, 10 dias x 12 pedidos, producido por el motor real) y las ejecuta dentro de cada escenario contra TODAS las migraciones
reales. Regenerar: `node scripts/seed-pm-demo/ejecutar.mjs verify-demo-volumen` (un test de vitest falla si el archivo commiteado se
desincroniza).

Cubre: coherencia (el total de cada pedido = suma de renglones menos el descuento del motor; renglones con nombre y precio del menu
sembrado), reglas duras (minimo $200 a domicilio, sin alcohol a domicilio, propina solo con tarjeta, promocion solo al recoger), T4
sin pedidos, contadores de cliente coherentes, rango de telefonos ficticio, handoffs/contactos/conversaciones ligados, idempotencia
(dos corridas), rechazo de una organizacion NO demo y de telefonos fuera del rango, aislamiento entre organizaciones (cross-tenant, RLS y
`anon`) y la limpieza (volumen y total) sin tocar el menu ni la configuracion del agente.

- Manual: `scripts/verify-restaurantes-demo-volumen/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs`.
