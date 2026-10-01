# verify-despachos-cartera-cfdi

Prueba contra Postgres REAL de `packages/domain-despachos/migrations/018_despachos_cartera_cfdi_completo.sql`
(D-21 cartera de clientes con ficha fiscal por property y D-22 modelo CFDI completo persistido).

- `assertions.sql` (juzgado por `scripts/verify-real-postgres-ci/run-gate.mjs` en CI, 88 escenarios):
  - alta de cliente (`cliente_alta`): positiva (moral/física, RFC normalizado, property de vertical despachos),
    negativos por rol (contador acotado, readonly, sin membresía, sin sub, anon), cross-tenant (admin de otro despacho,
    staff de un hotel), organización suspendida y tope de 500 clientes;
  - validación: RFC genérico/mes o día imposibles/corto/caracteres inválidos, régimen, CP, periodicidad, razón social,
    responsable de otra organización, RFC duplicado por organización (y permitido entre organizaciones);
  - `cliente_ficha_guardar`: contador acotado solo su cliente, RFC inmutable, cross-tenant, property de otra vertical;
  - lectura (RLS) y escritura directa cerrada (INSERT/UPDATE/DELETE sobre `cliente_ficha`, anon, helper interno);
  - CFDI completo: fila histórica sigue válida, CHECK de cada columna nueva, desglose de impuestos (Exento, retención,
    catálogo, duplicado, FK compuesta cross-tenant/cross-cliente, RLS de insert y lectura, sin UPDATE/DELETE, cascada);
  - estado SAT (`invoice_estado_sat_registrar`): positivo, cancelado terminal, cross-tenant, readonly, anon, sin UPDATE directo.
- `run.sh`: lo mismo contra un Postgres efímero local (`initdb`/`pg_ctl`).
- No llama al SAT ni a ningún PAC: son filas ficticias de la propia verificación (RFC y correos de ejemplo).
