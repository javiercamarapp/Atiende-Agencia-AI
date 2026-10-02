# verify-despachos-libro-pagos-provisionales

Prueba contra Postgres REAL de `packages/domain-despachos/migrations/020_despachos_libro_pagos_provisionales.sql`
(D-24 libro contable persistido y D-25 pagos provisionales de ISR/IVA).

- `assertions.sql` (juzgado por `scripts/verify-real-postgres-ci/run-gate.mjs` en CI, 144 escenarios):
  - catálogo de cuentas por cliente: siembra idempotente, alta de cuenta, naturaleza inmutable con partidas;
  - pólizas: cuadre (debe = haber en centavos enteros), una sola partida, partida con debe y haber, cuenta fuera del
    catálogo, montos con decimales, folio consecutivo por (cliente, mes, tipo), periodo cerrado (y los controles con
    periodo abierto / otro mes cerrado), póliza ligada a un CFDI (no dos vigentes, no cancelado, no de otra property u
    organización) y reversa (no doble, no sobre una reversa, libera al CFDI, respeta el periodo cerrado);
  - roles y tenant en CADA función de escritura: admin, contador acotado, readonly, admin de otro despacho, staff de un
    hotel, sin membresía, sin sub y anon;
  - escritura directa cerrada (INSERT/UPDATE/DELETE para `authenticated`), RLS de lectura entre despachos y entre clientes,
    llaves foráneas compuestas, CHECK de fecha/ejercicio/mes, UNIQUE del folio;
  - balanza derivada: cuadra, saldos por naturaleza, saldo inicial de cuentas de balance entre meses y ejercicios,
    reinicio de cuentas de resultados en enero, aislamiento cross-tenant;
  - pagos de CFDI PPD (REP): idempotencia, parcialidades, sobrepago, PUE/cancelado/moneda/flujo/base, otra property,
    roles, anon, escritura directa y RLS;
  - papel de trabajo del pago provisional: guardar/actualizar, validaciones, presentar (cierra el vencimiento del
    calendario fiscal), no recalcular lo presentado, roles, anon, escritura directa y RLS;
  - núcleo interno `libro_poliza_insertar` sin EXECUTE para public/anon/authenticated (comportamiento y `has_function_privilege`), postura de
    catálogo (RLS habilitado en las 5 tablas, `search_path` fijo en las funciones definer, balanza invoker, ninguna policy permisiva, anon/public
    sin privilegios sobre las tablas y `authenticated` solo lee), reversa con property (otra property, otro despacho, inexistente, anon) y tope de
    2000 cuentas en la siembra (borde exacto y re-siembra);
  - `system_pagos_provisionales_por_vencer`: solo sistema (con sub falla), ventana, completadas, presentadas, DIOT, por
    organización, anon y argumentos inválidos.
- `run.sh`: lo mismo contra un Postgres efímero local (`initdb`/`pg_ctl`).
- No llama al SAT ni a ningún PAC: son filas ficticias de la propia verificación (RFC, folios y correos de ejemplo).
