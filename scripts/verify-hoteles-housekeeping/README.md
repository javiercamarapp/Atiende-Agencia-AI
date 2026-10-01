# verify-hoteles-housekeeping

Verificación contra Postgres REAL (mismo patrón que `scripts/verify-hoteles-boveda-identidad/`)
de `packages/domain-hoteles/migrations/033_housekeeping_completo.sql` (H-04: tareas de limpieza,
habitaciones fuera de servicio y estado de habitación).

```
scripts/verify-hoteles-housekeeping/run.sh        # manual, Postgres efímero local
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-hoteles-housekeeping
```

En CI lo ejecuta automáticamente el gate `Postgres real` (auto-descubre `scripts/verify-*`).

## Qué prueba (34 escenarios)

- Tareas: crear (frontdesk/housekeeping sí; fnb/reservations/anon/otro tenant no), `organization_id`
  derivado por trigger y GRANT de columna (no se puede mandar), FK compuesta contra habitaciones de
  otra property, asignar a staff de otra organización, una sola tarea activa por habitación/día/tipo.
- Ciclo: iniciar/terminar/inspeccionar y rechazo con `rejections + 1`; CHECKs de consistencia;
  separación de funciones (quien limpia no inspecciona su propia tarea); columnas inmutables
  (`room_id`, `organization_id`, `work_date`); sin DELETE; fnb y otro tenant filtrados por RLS.
- SQL exacto del repositorio: generar el día (idempotente, salta habitaciones fuera de servicio),
  tablero (una fila por habitación) y reporte diario.
- `hoteles.room`: UPDATE solo de `status` por rol fino; el CHECK de valores sigue mandando.
- Fuera de servicio: solo maintenance/frontdesk/gm/owner; una activa por habitación; cierre exige
  `closed_at`; cross-tenant y anon.
- Compatibilidad con base sin migrar: con la tabla ausente (42P01) un SAVEPOINT recupera la transacción.
