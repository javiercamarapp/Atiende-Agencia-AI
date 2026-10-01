# verify-despachos-portal-cliente

Prueba contra Postgres REAL de `packages/domain-despachos/migrations/016_despachos_portal_cliente.sql`
(portal del cliente final del despacho: tablas `portal_cliente_enlace`/`_documento`/`_mensaje` 8 funciones públicas y 1 helper interno).

- `assertions.sql` (juzgado por `scripts/verify-real-postgres-ci/run-gate.mjs` en CI, 81 escenarios):
  acceso por token de solo sistema (positivo), aislamiento cross-cliente y cross-tenant, token
  expirado/revocado/inexistente/mal formado (mismo error: sin oráculo de estado), revocación efectiva,
  staff con sub real y anon rechazados en las funciones del cliente, subida de archivos (firma, tamaño, DTD/entidades,
  tipo/mime, nombre, replay idempotente, topes por hora), mensajes (límites y tope), funciones de staff
  (crear/revocar/contenido/resolver/responder; negativos cross-tenant, sin membresía, anon, property de otra vertical),
  y acceso directo a tablas cerrado (GRANT por columna sin `token_hash` ni `contenido`, sin escritura directa).
- `run.sh`: lo mismo contra un Postgres efímero local (`initdb`/`pg_ctl`).
- No envía correos ni WhatsApp: los datos son filas ficticias de la propia verificación.
