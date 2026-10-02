# verify-licitaciones-kyc-retamizado

Verificacion contra Postgres REAL (RLS, GRANT, funciones `security definer` y `auth.uid()` reales) de
`packages/domain-licitaciones/migrations/034_licitaciones_retamizado_kyc_y_avisos.sql` (L-32 re-tamizado de la
cartera KYC 69-B por edicion de la lista; L-30 conteo de sistema de documentos de empresa por vencer).

Cubre: sin lista cargada (0 filas), linea base (la primera evaluacion no alerta) y solo organizaciones de
licitaciones activas, empeoramiento entre ediciones (conteos por organizacion y por proveedores),
idempotencia (repetir no devuelve filas), sin cambio o con mejora no alerta, correccion de una edicion por el
SAT (SHA distinto) que se reevalua, RLS cross-tenant del historial, usuario con sub rechazado (42501), anon,
escritura/borrado directo denegados y el conteo de documentos por vencer (solo aprobados, dentro de la ventana,
por organizacion, parametros invalidos).

- Gate de CI (automatico, lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs`): sin pasos extra.
- A mano contra un Postgres local efimero: `scripts/verify-licitaciones-kyc-retamizado/run.sh`.
