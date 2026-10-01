# verify-licitaciones-whatsapp

Verificacion contra Postgres REAL (RLS, GRANT por columna, triggers y `auth.uid()` reales) de
`packages/domain-licitaciones/migrations/030_whatsapp_avisos_y_decisiones.sql` (L-05: avisos y
decisiones go/no-go por WhatsApp).

Cubre: contactos (propia fila, GRANT por columna, trigger de re-verificacion al cambiar de telefono),
tokens de un solo uso (consumo, replay con otro mensaje, mismo mensaje idempotente, otro usuario,
expirado, telefono distinto, baja, rol revocado, hash unico, expiracion maxima, convocatoria ajena),
opt-in / opt-out, outbox (idempotencia, claim, borrado de botones al cerrar), bitacora append-only,
anon y cross-tenant.

- Gate de CI (automatico, lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs`): sin pasos extra.
- A mano contra un Postgres local efimero: `scripts/verify-licitaciones-whatsapp/run.sh`.
