# verify-citas-concurrencia (C-17)

Prueba REAL de concurrencia contra la doble cita: varias conexiones `psql` simultaneas contra un Postgres real con las migraciones reales de
`supabase/migrations/` y las RPC reales de citas (`create_appointment_idempotent`, `cancel_appointment_idempotent`,
`reschedule_appointment_idempotent`). Complementa a los demas `scripts/verify-citas-*`, que corren cada escenario en UNA conexion y por eso no
pueden probar una carrera.

Como asegura que la carrera es real (no suerte de orden):

- "Pistola de salida": un controlador retiene un advisory lock exclusivo; los N trabajadores se bloquean en el y el script comprueba en
  `pg_locks` que TODOS esperan antes de liberarlos juntos.
- Bloqueo determinista del `EXCLUDE`: la sesion A retiene un INSERT sin confirmar y el script comprueba en `pg_stat_activity` que la sesion B
  esta esperando un `Lock` antes de que A haga `rollback` (B obtiene el horario) o `commit` (B recibe `AT423`).

Escenarios: (1) mismo proveedor y horario con llaves distintas, 12 rondas de 2 conexiones; (2) 8 conexiones a la vez; (3) misma llave y misma
huella: ambas reciben la misma cita; (4) misma llave con datos distintos: `AT409`; (5) sin llave, misma huella; (6) control negativo de
sobre-bloqueo (otro proveedor y otra organizacion en el mismo horario no se bloquean); (7) doble cancelacion simultanea; (8) reagendar vs crear al
mismo horario destino; (9) el bloqueo determinista de arriba.

Resultado aceptado para la perdedora de una carrera por horario: `AT423` (rechazo del `EXCLUDE`) o `40P01` (`deadlock_detected`: cada transaccion
espera la fila de la otra y Postgres aborta a una). Esta prueba encontro el segundo caso al reagendar y crear a la vez: el TypeScript lo trataba como
error generico; ahora `esConflictoDeHorario` (`packages/domain-citas/src/postgres-repository.ts`) lo mapea a `conflict_slot_taken`.

Uso local (requiere `initdb`/`pg_ctl`/`psql`): `bash scripts/verify-citas-concurrencia/run.sh`. En CI lo corre el job `citas-concurrencia-gate` de
`.github/workflows/postgres-real-gate.yml` con `VERIFY_USE_EXISTING_PG=1` contra el servicio `postgres:16`.
