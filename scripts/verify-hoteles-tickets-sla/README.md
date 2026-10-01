# verify-hoteles-tickets-sla

Verificación contra Postgres REAL (mismo patrón que `scripts/verify-hoteles-housekeeping/`) de
`packages/domain-hoteles/migrations/034_guest_ticket_sla_escalacion.sql` (H-05: tickets de huésped
con SLA, escalación automática, bitácora y creación desde reseñas).

```
scripts/verify-hoteles-tickets-sla/run.sh        # manual, Postgres efímero local
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-hoteles-tickets-sla
```

En CI lo ejecuta automáticamente el gate `Postgres real` (auto-descubre `scripts/verify-*`).

## Qué prueba (50 escenarios)

- Crear: cualquier rol hotelero sí; otro tenant y anon no; `organization_id`, `created_by`, `sla_due_at`,
  `status` y campos de escalación NO se pueden mandar (GRANT de columna); CHECKs de datos.
- SLA: la política (owner/gm) manda sobre el `sla_minutes` del cliente; frontdesk/fnb/accountant no la
  escriben; una por (departamento, prioridad); otro tenant no la ve ni la escribe.
- Visibilidad (RLS): manager ve todo; el departamento, el responsable y quien lo reportó ven el suyo;
  cross-tenant y anon no ven nada; la bitácora hereda la visibilidad y es inmutable (sin INSERT/UPDATE/DELETE).
- Ciclo: transiciones válidas/ inválidas, terminales inmutables, `closed_at` derivado, columnas inmutables,
  reasignar departamento solo manager y sin reiniciar el SLA, responsable debe ser staff de la property,
  escalación manual y retorno desde `escalado`.
- Barrido de sistema `hoteles.sweep_guest_ticket_sla`: solo `auth.uid() is null`; escala vencidos a
  gerente/dueño, avisa al 75%, idempotente, solo la property pedida, ignora cerrados, umbral inválido.
- Desde reseñas: ticket ligado (canal `resena`), uno activo por reseña, FK compuesta contra reseñas y
  habitaciones de otra property, borrar la reseña conserva el ticket.
- Base sin migrar: con la tabla ausente (42P01) un SAVEPOINT recupera la transacción.
