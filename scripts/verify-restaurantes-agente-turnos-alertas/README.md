# verify-restaurantes-agente-turnos-alertas

Acompaña a `packages/domain-restaurantes/migrations/085_agente_turnos_recientes_alertas.sql`.

`restaurantes.agente_turnos_recientes(desde, hasta)` es la lectura de SOLO SISTEMA (`authenticated` con `auth.uid()` NULL) de los turnos terminados del agente de WhatsApp
(`whatsapp_inbound_events` en `processed` o `failed`), sin teléfono ni texto, que alimenta las alertas de timeouts (>1 % en 10 min) y de 5 fallos seguidos. El rol de producción no
tiene GRANT directo sobre la tabla. Se prueba con el rol y la sesión exactos de producción: solo-sistema, ventana acotada, sin `processing`, sin la organización demo, sin
columnas de identidad, y `anon`/staff rechazados.

Uso: `bash scripts/verify-restaurantes-agente-turnos-alertas/run.sh` (Postgres local efímero en el puerto 55531). En CI lo corre el gate automático
(`scripts/verify-real-postgres-ci/run-gate.mjs`), que descubre este directorio por su `assertions.sql`.
