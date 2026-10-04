# verify-restaurantes-storefront

Verificacion, contra un Postgres **real**, de
`packages/domain-restaurantes/migrations/032_storefront_rastreo_publico.sql`
(funcion `restaurantes.storefront_order_tracking`, el rastreo publico de un pedido por token).

## Que demuestra (42 escenarios)

- **A.** Solo-sistema (`auth.uid() is null`): devuelve estado, canal y renglones del pedido de SU organizacion;
  la misma consulta con otra organizacion, un id inexistente o ids nulos da NULL.
- **B.** Sin datos personales: la respuesta no contiene nombre, telefono, direccion ni notas; sus llaves
  son exactamente `branch, canal, created_at, items, payment_method, status, total`.
- **C.** Un usuario autenticado (aunque sea owner de la organizacion) y `anon` son rechazados.
- **D.** `restaurantes.orders` sigue cerrada: la sesion de sistema ve 0 filas, `anon` es rechazado y el staff
  conserva su lectura por RLS (la migracion no abrio ninguna policy).
- **E.** Base sin migrar: sin la funcion se obtiene 42883; con SAVEPOINT la transaccion se recupera y sin el
  SAVEPOINT queda abortada (25P02).

- **F.** (migracion 062, escenarios 15-31) Marca publica `restaurantes.storefront_marca`: lectura de la sesion de sistema y del staff de la
  organizacion; staff de otra organizacion y `anon` sin acceso; solo owner/admin crean/editan (staff y owner ajeno: RLS); sin DELETE; `organization_id`
  y los sellos (`updated_by`) no escribibles; el trigger sella al autor; CHECK de https, dominio de red y longitudes.
- **G.** (escenarios 32-42) Solicitud de evento/catering: **hallazgo** -- el INSERT directo de la sesion de sistema sobre `callback_requests` esta cerrado
  (`authenticated` solo tiene SELECT desde 001), por lo que el registro de contactos de los agentes y del formulario de eventos fallaba contra una base
  migrada. `restaurantes.callback_registrar` (solo-sistema) lo resuelve: registra con motivo `evento` y canal `web`; el staff propio la ve y el ajeno no;
  un usuario con sesion, `anon`, una sucursal de otra organizacion, un canal invalido, datos fuera de rango y una organizacion inexistente se rechazan.

- Manual: `scripts/verify-restaurantes-storefront/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
