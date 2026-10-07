# verify-restaurantes-qa-r2-automatizacion-caos

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/076_qa_r2_automatizacion_dia_de_negocio_y_estados.sql`
(espejo: `supabase/migrations/20240101000376_076_qa_r2_automatizacion_dia_de_negocio_y_estados.sql`): QA R2 de Restaurantes,
lentes automatizacion y caos.

Cubre: dia de negocio de PM (turno 12:00-01:00) en agotados, muestras del tiempo prometido y cierre del dia; saturacion con ventana de 8 h;
estados sin clic con referencia de respaldo (no_recogido cuenta desde que el pedido quedo listo, re-marcar listo reinicia el plazo, recoger sin
hora); alertas operativas nuevas (pedido sin aceptar, pedido estancado); muestras para recoger sin la hora elegida por el cliente; regreso del
handoff con el agente de WhatsApp apagado; alertas de voz evaluadas por el sistema (idempotentes, sin audit_log, solo sistema, cross-tenant, anon).

- Manual: `scripts/verify-restaurantes-qa-r2-automatizacion-caos/run.sh` (levanta un Postgres efimero con `initdb` y corre el gate).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (contrato de 3 archivos: bootstrap, post-migrations, assertions).
