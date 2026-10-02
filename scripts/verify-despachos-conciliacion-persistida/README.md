# verify-despachos-conciliacion-persistida

Prueba contra Postgres REAL de `packages/domain-despachos/migrations/021_despachos_conciliacion_persistida.sql`
(D-35 conciliacion bancaria persistida y D-02 sugerencias del nivel 4 con aprobacion humana).

- `assertions.sql` (juzgado por `scripts/verify-real-postgres-ci/run-gate.mjs` en CI):
  - crear sesion (movimientos del periodo, acotada a una cuenta, periodo sin movimientos o con formato invalido);
  - confirmar: un solo match vigente por movimiento (indice unico parcial), lote todo-o-nada, pertenencia al cliente y
    al periodo, cuenta de la sesion, periodo cerrado (55000) con su control, sesion cerrada, CHECK origen/nivel;
  - deshacer: motivo obligatorio, idempotente (no pisa el motivo original), libera al movimiento, periodo cerrado;
  - sugerencias del LLM: quedan pendientes y no crean match, una pendiente por movimiento, aprobar crea el match
    `llm_aprobado` nivel 4, rechazar no, no se resuelve dos veces, periodo cerrado bloquea aprobar;
  - roles y tenant en CADA funcion: admin, contador acotado, readonly, admin de otro despacho, sin membresia, sin sub y anon;
  - RLS de lectura entre despachos y entre clientes, escritura directa cerrada, FK compuestas cross-tenant;
  - vista derivada `invoice_conciliacion` (aparece al confirmar, desaparece al deshacer, respeta RLS);
  - postura de catalogo (RLS, sin policies permisivas, sin privilegios para anon/public, search_path fijo, nucleo interno
    sin EXECUTE).
- `run.sh`: lo mismo contra un Postgres efimero local (`initdb`/`pg_ctl`). Todos los datos son ficticios.
