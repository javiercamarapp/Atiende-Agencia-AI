# verify-despachos-catalogo-cuentas-sat

Prueba contra Postgres REAL de `packages/domain-despachos/migrations/028_despachos_catalogo_cuentas_sat.sql`
(D-P3-16 / D-P3-17 / D-P3-44: nivel, cuenta padre y código agrupador del SAT en el catálogo de cuentas por cliente, y ligas de las pólizas de REP).

- `assertions.sql` (juzgado por `scripts/verify-real-postgres-ci/run-gate.mjs` en CI):
  - CHECK del formato del código agrupador (`ddd` o `ddd.d`/`ddd.dd`), llave foránea compuesta del padre (inexistente, de OTRA
    property), consistencia nivel/padre, trigger de jerarquía (el padre debe ser de nivel inmediato superior) y padre protegido contra borrado;
  - `libro_cuenta_guardar`: con y sin jerarquía, compatibilidad de la llamada de 4 argumentos (no borra metadatos), padre de otro rubro,
    cross-tenant, regresión «una cuenta con partidas no cambia de naturaleza», la póliza y la balanza siguen funcionando;
  - `libro_catalogo_sembrar`: trae jerarquía y código para las cuentas NUEVAS, NO modifica (ni completa) las que ya existen, idempotente;
  - `libro_cuenta_agrupador_asignar` (asignación masiva) y `libro_catalogo_importar` (merge no destructivo, REQ-MIG-017): positivos,
    validaciones, tope de 2000 cuentas (borde exacto) y la regla de naturaleza con partidas;
  - `libro_poliza_registrar_rep` + `libro_poliza_rep` (pólizas de cobro/pago de un complemento de pago): liga una póliza vigente por pago, doble registro,
    reversa que libera el pago, amarre de tipo/fecha/total al pago, cuadre, cuenta fuera del catálogo, periodo cerrado, pago de otra property u
    organización, llave foránea compuesta, escritura directa cerrada y RLS;
  - roles y tenant en CADA función de escritura: admin, contador acotado, readonly, admin de otro despacho, admin de un hotel, sin
    membresía, sin sub y anon;
  - escritura directa cerrada, RLS de lectura, EXECUTE de anon/public, `search_path` fijo y ninguna policy permisiva.
- `run.sh`: lo mismo contra un Postgres efímero local (`initdb`/`pg_ctl`), solo imprime; el veredicto automático lo da el gate de CI.
- No llama al SAT ni a ningún PAC: son filas ficticias de la propia verificación.
