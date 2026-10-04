# verify-restaurantes-canales-escritura

Verificación, contra un Postgres **real**, de
`packages/domain-restaurantes/migrations/043_sistema_escritura_clientes_avisos_y_eventos.sql`
(P0 de la cuenta real de PM: la sesión de sistema no podía crear clientes, direcciones ni avisos de contacto,
y por tanto ningún pedido nuevo por ningún canal). El repositorio en memoria nunca aplica RLS ni GRANT, así que
no podía detectar este hueco.

## Rol y sesión exactos de producción

`ManagedPostgresEngine.withAppSession({ userId: null })` abre cada transacción con `set local role authenticated`
y `request.jwt.claim.sub = ''` (`auth.uid()` NULL). Todos los escenarios usan ese par. El webhook de WhatsApp,
las herramientas de voz y el checkout web abren esa misma sesión.

## Qué demuestra (38 escenarios)

- **A. `upsert_customer`:** cliente nuevo; cliente existente (no pisa el nombre); mismo teléfono en otra
  organización = otro cliente; dos llamadas seguidas = una fila; organización de otro vertical, teléfono vacío,
  staff autenticado y `anon` rechazados; el INSERT/UPDATE directo sigue denegado (no se amplió ningún GRANT de tabla).
- **B. `add_customer_address_if_new`:** primera dirección predeterminada, idempotente; cliente de OTRA organización
  rechazado; staff, `anon`, dirección vacía e INSERT directo rechazados.
- **C. `create_callback_request`:** aviso creado y visible solo para el staff de SU organización; sucursal de otra
  organización, otro vertical, origen inválido, nombre vacío, staff, `anon` e INSERT directo rechazados.
- **D. `mark_whatsapp_inbound_failed`:** marca solo `processing` de SU organización, no degrada `processed`;
  staff, `anon` y UPDATE directo rechazados.
- **E. Pedido de punta a punta por canal (`whatsapp`, `voice`, `web`):** cliente nuevo y cliente existente, domicilio,
  aviso y conversación: cliente → dirección → `create_order_idempotent` → `whatsapp_append_turn` → aviso.
- **F. Base sin migrar:** sin la función (42883) un SAVEPOINT recupera la transacción (lo que hace `runWithSavepointFallback`);
  sin SAVEPOINT queda abortada.

## Cómo correrlo

- Local: `scripts/verify-restaurantes-canales-escritura/run.sh` (requiere `initdb`/`pg_ctl`/`psql`).
- CI: lo descubre solo `scripts/verify-real-postgres-ci/run-gate.mjs` (job `postgres-real-gate`).
