# verify-despachos-facturacion-honorarios

Prueba contra Postgres REAL de `packages/domain-despachos/migrations/023_despachos_facturacion_honorarios_igualas.sql`
(D-32: igualas y prefacturas de honorarios del despacho a sus clientes).

- `assertions.sql` (juzgado por `scripts/verify-real-postgres-ci/run-gate.mjs` en CI, 135 escenarios):
  - igualas: alta, edición, validaciones (monto, tasa, día, concepto, claves SAT, uso CFDI, tope de retención), tope de 50 por cliente
    (borde exacto), eliminación solo sin prefacturas;
  - prefacturas: generación con desglose recalculado por la base (simple y con retenciones de ISR y de IVA 2/3), receptor tomado de la ficha,
    idempotencia (generar dos veces no duplica), desglose que no coincide, iguala inactiva, cliente sin ficha, periodo inválido;
  - máquina de estados: aprobar (una sola vez), reserva compare-and-set (la segunda no gana, la reserva vieja se reclama, la reciente no),
    registrar timbre (UUID único por organización) y fallo (texto truncado), ciclo aprobada -> fallida -> reintento -> timbrada;
  - cancelación con guardas: motivo 01-04, el 01 exige folio de sustitución distinto del propio, una timbrada solo con acuse del PAC,
    nunca durante un timbrado en curso ni dos veces;
  - roles y tenant en CADA función de escritura: admin, contador acotado, readonly, admin de otro despacho, staff de un hotel, sin membresía,
    sin sub y anon;
  - escritura directa cerrada para `authenticated`, RLS de lectura entre despachos y entre clientes, CHECK / UNIQUE / FK compuesta y cascada;
  - postura de catálogo: RLS en las 2 tablas, sin policies permisivas, anon sin privilegios, funciones definer con `search_path` fijo y sin
    EXECUTE para public/anon, y guards internos no ejecutables por `authenticated`.
- `run.sh`: lo mismo contra un Postgres efímero local (`initdb`/`pg_ctl`).
- No llama al SAT ni a ningún PAC: son filas ficticias de la propia verificación (RFC, UUID y correos de ejemplo).
