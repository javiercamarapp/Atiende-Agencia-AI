# verify-restaurantes-aviso-whatsapp-operador

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/091_consentimiento_aviso_whatsapp_operador.sql`
(espejo `supabase/migrations/20240101000404_091_consentimiento_aviso_whatsapp_operador.sql`): consentimiento de avisos por WhatsApp de los
pedidos capturados por personal y envio diferido en la outbox.

Cubre: registro por gestor con alcance (SI y NO explicitos, idempotente, solo huella del telefono, quien y cuando), vigencia y reactivacion,
rechazos (chofer, otra sucursal, anon, telefono o via invalidos, sucursal o pedido de otra organizacion), lectura solo para gestores de la
organizacion y ninguna escritura directa, revocacion solo de sistema, y `enqueue_messaging_outbox_diferido` (fecha futura que el claim respeta,
tope de 10 minutos, cross-tenant, anon, idempotencia).

- Manual: `scripts/verify-restaurantes-aviso-whatsapp-operador/run.sh`.
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs`.
