# verify-rentas-concurrencia

Rn-P3-12. Concurrencia REAL de rentas: N conexiones `psql` simultaneas contra un Postgres real con todas las migraciones de
`supabase/migrations/`. Los demas `scripts/verify-rentas-*/` corren cada escenario en una sola conexion; este cierra el hueco que admitia
`verify-rentas-ical-sync-lease/README.md` ("la concurrencia real de dos conexiones ... se comprobo a mano").

La carrera es real, no suerte de orden: un controlador retiene un advisory lock exclusivo, los N trabajadores se bloquean en el (se
comprueba en `pg_locks` que TODOS esperan) y se liberan juntos. Los resultados se comparan por SQLSTATE.

## Escenarios

| | Escenario | Garantia |
|---|---|---|
| a | 30 reservas simultaneas, misma unidad y fechas (3 rondas) | exactamente 1 `confirmado`, 29 `conflicto_pendiente` con su fila de conflicto, 0 deadlocks (40P01) |
| b | back-to-back concurrente (salida de A = llegada de B), 6 rondas | las dos se aceptan, sin conflicto; control negativo con un dia de solape |
| c | statements concurrentes del mismo propietario y periodo | una sola version con la misma huella; con huellas distintas, versiones consecutivas 1,2,3; nunca 23505 |
| d | lote iCal: `rentas.claim_ical_feeds` (024) desde 4 conexiones | ningun feed se entrega dos veces; con todos los leases vigentes no se entrega nada |
| e | 5 aceptaciones de la misma invitacion (`core.accept_staff_invite`) | 1 gana, 4 P0001, un solo `staff_user` y una membresia |

## Alcance honesto

- (a)-(c): la logica de reserva y de statement vive en TypeScript (`aplicacion/reservas.ts`, `finanzas-statements.ts`). `setup.sql` reproduce
  literalmente su secuencia SQL en ayudantes `conc.*` (mismo `hashtextextended`, mismos INSERT, mismo manejo de 23P01) para probar las
  garantias de BASE DE DATOS (EXCLUDE `ocupacion_sin_solape`, UNIQUE de versiones, advisory lock por clave). No prueba el TypeScript.
- (d) y (e) llaman a las funciones REALES de las migraciones.
- Los ayudantes son `security definer` a proposito: RLS y GRANT ya los cubren los verify de una sola conexion.
- **Hueco conocido (e):** `core.accept_staff_invite` (migracion 0002) responde 42702 (columna ambigua) en cada llamada contra Postgres real,
  asi que hoy ninguna invitacion de staff se puede aceptar. La correccion esta en la PR #436 (migracion 0053). Mientras no este en
  `supabase/migrations/`, el escenario (e) imprime `[HUECO CONOCIDO]` y se OMITE (no se da por aprobado); en cuanto se aplique la
  correccion corre completo (comprobado con la funcion parchada: 15/15).

## Correr

```
bash scripts/verify-rentas-concurrencia/run.sh                       # cluster efimero con initdb/pg_ctl (requiere Postgres local)
VERIFY_USE_EXISTING_PG=1 PGHOST=... PGPORT=... bash scripts/verify-rentas-concurrencia/run.sh   # servidor ya corriendo
```

En CI corre en el job `rentas-concurrencia-gate` de `.github/workflows/postgres-real-gate.yml`. Sin `assertions.sql` a proposito, para que
`run-gate.mjs` no lo auto-descubra como un verify de una sola conexion.
