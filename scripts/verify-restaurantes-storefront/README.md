# verify-restaurantes-storefront

Verificacion, contra un Postgres **real**, de
`packages/domain-restaurantes/migrations/032_storefront_rastreo_publico.sql`
(funcion `restaurantes.storefront_order_tracking`, el rastreo publico de un pedido por token).

## Que demuestra (14 escenarios)

- **A.** Solo-sistema (`auth.uid() is null`): devuelve estado, canal y renglones del pedido de SU organizacion;
  la misma consulta con otra organizacion, un id inexistente o ids nulos da NULL.
- **B.** Sin datos personales: la respuesta no contiene nombre, telefono, direccion ni notas; sus llaves
  son exactamente `branch, canal, created_at, items, payment_method, status, total`.
- **C.** Un usuario autenticado (aunque sea owner de la organizacion) y `anon` son rechazados.
- **D.** `restaurantes.orders` sigue cerrada: la sesion de sistema ve 0 filas, `anon` es rechazado y el staff
  conserva su lectura por RLS (la migracion no abrio ninguna policy).
- **E.** Base sin migrar: sin la funcion se obtiene 42883; con SAVEPOINT la transaccion se recupera y sin el
  SAVEPOINT queda abortada (25P02).

- Manual: `scripts/verify-restaurantes-storefront/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
