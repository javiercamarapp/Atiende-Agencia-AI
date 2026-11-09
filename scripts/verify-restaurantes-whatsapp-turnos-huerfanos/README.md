# verify-restaurantes-whatsapp-turnos-huerfanos

Verificacion contra Postgres REAL (RLS, GRANT y `auth.uid()` reales) de `packages/domain-restaurantes/migrations/192_whatsapp_turnos_huerfanos.sql`:
`restaurantes.reclamar_turnos_whatsapp_huerfanos(p_organization_id, p_todas, p_limite)`, el reclamo atomico de los mensajes de WhatsApp cuyo turno asincrono
murio (processing con lease vencido o failed reintentable) para re-ejecutarlos.

Cubre: positivo (processing > 90 s y failed reintentable de organizaciones con cerebro_v2; marca processing con intentos + 1), negativos (lease vigente, 5
intentos, fallo de la fase A, fuera de 10 min, organizacion sin cerebro_v2 salvo p_todas), limite acotado a 1..10, el telefono y el numero emisor salen de la
MISMA organizacion (cross-tenant), y rechazo de usuarios autenticados (42501) y `anon` (42501).

Se corre en el gate de CI (`scripts/verify-real-postgres-ci/run-gate.mjs` descubre este directorio) o a mano con `./run.sh`.
