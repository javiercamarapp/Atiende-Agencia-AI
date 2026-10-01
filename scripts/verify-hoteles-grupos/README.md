# verify-hoteles-grupos

Verificación contra Postgres REAL (mismo patrón que `scripts/verify-hoteles-agentes-aprobaciones/`) de
`packages/domain-hoteles/migrations/036_hoteles_grupos.sql` (H-06: cotización de grupo con vigencia, bloqueo de
cuartos con fecha de liberación, pickup, rooming list, anticipos registrados y liberación por cutoff).

```
scripts/verify-hoteles-grupos/run.sh        # manual, Postgres efímero local (incluye la prueba de concurrencia)
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-hoteles-grupos
```

En CI lo ejecuta automáticamente el gate `Postgres real` (auto-descubre `scripts/verify-*`).

## Qué prueba (48 escenarios)

- Cotización: total en centavos enteros, redondeo half-up exacto, rechazo de decimales/negativos/texto, fechas y
  vigencia, tope de descuento (30 % por defecto o el guardrail 035), roles, cross-tenant y anon.
- Bloqueo: retiene cada noche, es atómico (una noche sin cupo no deja nada), nunca sobrevende (ni con la sobreventa
  controlada habilitada), noche sin inventario, dos aceptaciones compitiendo por los últimos cuartos.
- Pickup/rooming: consume cuartos por noche, nunca más que lo bloqueado, vínculo opcional con reserva, cierre en el
  cutoff, devolución al cancelar.
- Liberación: manual, cancelación, barrido por cutoff solo de sistema, borde exacto a medianoche local, Mexico_City vs
  Tijuana, zona inválida, idempotencia, nunca inventario negativo.
- Anticipos: solo registro (no crea pagos ni cargos), borde exacto del total, referencia repetida.
- RLS, inmutabilidad (aun con superusuario), bitácora append-only y helpers internos sin EXECUTE.

## Concurrencia real

El gate de CI ejecuta cada escenario en una sola conexión, así que la prueba con DOS sesiones simultáneas vive en
`run.sh` (solo local): dos aceptaciones con la transacción retenida 2 s deben terminar en 1 éxito, 1
`sin_disponibilidad` y 6 cuartos retenidos (nunca sobrevendido ni negativo).
