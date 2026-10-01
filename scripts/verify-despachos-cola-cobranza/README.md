# verify-despachos-cola-cobranza

Prueba contra Postgres REAL de `packages/domain-despachos/migrations/017_despachos_cola_cobranza.sql`
(cola de cobranza D-11: tablas `cobranza_gestion`, `cobranza_whatsapp_consentimiento` y
`cobranza_whatsapp_outbox`, 4 funciones de staff y 1 helper interno).

- `assertions.sql` (juzgado por `scripts/verify-real-postgres-ci/run-gate.mjs` en CI, 78 escenarios):
  escritura de staff (positivo) con montos en centavos enteros; roles (auditor/readonly, sin membresia, staff
  de otra vertical, sistema sin sub y anon rechazados); aislamiento cross-tenant y cross-cliente (cuenta de
  otra property, RFC que solo es cliente de otro despacho, consentimiento de B que no habilita a A);
  validacion de forma (monto 0/negativo, fecha, tipo, notas, E.164, RFC, opt-in sin evidencia); topes
  (500 gestiones por cuenta, 200 mensajes pendientes por property); transiciones de estado; opt-out que cancela
  pendientes; idempotencia por `dedupe_key`; acceso directo a tablas cerrado (sin INSERT/UPDATE/DELETE, sin la
  columna `telefono` del outbox) y postura de seguridad (RLS, sin `using (true)`, `search_path` fijo, sin
  privilegios para anon/public).
- `run.sh`: lo mismo contra un Postgres efimero local (`initdb`/`pg_ctl`).
- No envia WhatsApp ni correos: los datos son filas ficticias de la propia verificacion.
