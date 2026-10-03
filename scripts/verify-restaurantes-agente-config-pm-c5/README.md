# verify-restaurantes-agente-config-pm-c5

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/039_agente_config_umbral_y_rafagas.sql`
(espejo: `supabase/migrations/20240101000300_039_agente_config_umbral_y_rafagas.sql`).

Dos columnas opcionales de `restaurantes.whatsapp_agent_config`, editables por owner/admin: `large_order_text` (umbral de pedido
grande, texto corto que llega al prompt) y `reply_debounce_seconds` (espera de rafagas, 0 a 10 s).

- Positivos: filas previas con NULL (= valores por omision), el SELECT anterior de 033 sigue funcionando, el upsert exacto del
  repositorio guarda ambos valores, 0/10/NULL entran, el lector del webhook (sistema sin usuario) los ve.
- Negativos: CHECK de rango (31 y -1) y de longitud (201 y vacio), staff sin permiso (0 filas), cross-tenant (0 filas y `with check`),
  `anon` sin lectura ni escritura.
- Base sin migrar: sin las columnas el SELECT nuevo falla con 42703 y `SAVEPOINT` recupera la transaccion para leer con el de 033.

- Manual: `scripts/verify-restaurantes-agente-config-pm-c5/run.sh`.
- CI: lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de archivos que los demas `verify-*`).
