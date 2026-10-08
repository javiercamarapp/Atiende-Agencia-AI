# verify-despachos-conciliacion-integridad

Prueba contra Postgres REAL de `packages/domain-despachos/migrations/025_despachos_conciliacion_integridad_y_piloto.sql`
(paridad3 D-P3-10/11/12: integridad del CFDI en la conciliacion y piloto automatico).

- `assertions.sql` (juzgado por `scripts/verify-real-postgres-ci/run-gate.mjs` en CI, lo descubre solo):
  - tope de monto: un CFDI no se concilia dos veces por el total; pagos parciales hasta el total si; deshacer libera el cupo;
    tambien aplica a una sugerencia de IA aprobada;
  - CFDI cancelado rechazado; signo invertido rechazado (abono vs recibido, cargo vs emitido), con su control positivo;
  - SQLSTATE propios por codigo exacto: CF001 cancelado, CF002 tope, CF003 signo, CF004 piloto apagado;
  - propuestas guardadas en la sesion: roles, tenant, sesion cerrada, payload, sin UPDATE directo;
  - sesion idempotente (`conciliacion_sesion_asegurar`): una sola sesion, otra cuenta crea otra, validaciones, roles y tenant;
  - piloto automatico: bandera apagada por omision, solo nivel 1 (monto igual, direccion explicita), nunca contra cancelado ni con
    signo invertido, respeta el tope, origen `autopiloto` solo por su funcion, actor real en `confirmado_por`, deshacer con motivo,
    la bandera solo la enciende el admin del despacho (RLS);
  - postura de catalogo (definer + search_path fijo, sin EXECUTE para anon/public, nucleo interno sin EXECUTE).
- `run.sh`: lo mismo contra un Postgres efimero local (`initdb`/`pg_ctl`). Todos los datos son ficticios.
