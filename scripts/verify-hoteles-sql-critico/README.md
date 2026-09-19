# verify-hoteles-sql-critico

Verificación contra Postgres **real** de las piezas SQL de `hoteles.*` que la
auditoría del 18-sep-2026 señaló como el hueco de confianza más serio de este
vertical: "las piezas SQL más críticas de seguridad (trigger
`revenue_engine_gate_transition_guard`, índice anti-doble-captura de night-audit,
función `mark_charge_reversed()`, RLS de reputación) nunca se han ejercitado contra
un Postgres real; los 690 tests corren contra un mirror en memoria escrito a mano".
Corre a mano vía `run.sh` y automáticamente en cada PR/push vía
`.github/workflows/postgres-real-gate.yml` (ver `scripts/verify-real-postgres-ci/`).

## Qué demuestra (29 escenarios)

1. **Trigger `revenue_engine_gate_transition_guard`**
   (`migrations/011_revenue_engine_gate.sql`) — escenarios 1-12:
   - Toda property nueva debe empezar en `shadow` (INSERT directo a otro estado se
     rechaza), incluso para el propio trigger corriendo bajo un rol sin RLS especial.
   - `shadow -> propone` exige 90+ días reales en shadow (rechazado antes, permitido
     después).
   - Saltar `shadow -> autopilot` directo (sin pasar por `propone`) se rechaza.
   - `propone -> autopilot` exige un backtest walk-forward vigente que pase
     (`hoteles.revenue_backtest_run.passes = true`), corrido durante/después de
     `propone`, Y una aprobación explícita de `owner` YA registrada en un UPDATE
     previo (nunca en el mismo UPDATE que promueve).
   - Solo el rol `owner` puede registrar/revocar `owner_approved_autopilot_at` (`gm`
     se rechaza aunque `can_manage_revenue_gate` sí lo deje tocar el resto del gate).
   - La democión (freno de emergencia) siempre procede, incluso para `gm`, y limpia
     la aprobación de owner vigente.

2. **Anti-doble-captura de night-audit** (`migrations/008_night_audit.sql`, índice
   único `(property_id, business_date)`) y del **cargo nocturno de hospedaje**
   (`migrations/001_hoteles_schema.sql`, índice parcial
   `charge_folio_stay_date_hospedaje_idx`) — escenarios 13-16: la primera
   inserción del día/noche procede, la segunda choca contra el índice único real.

3. **`hoteles.mark_charge_reversed()` + motor de folios**
   (`migrations/002_folio_engine_functions.sql`) — escenarios 17-20: un reverso
   real procede, un cargo YA reversado no puede reversarse una segunda vez
   (`where reversed_by is null` en la función), el cargo original conserva
   trazabilidad real (`reversed_by` apunta al cargo de reverso), y el saldo neto del
   folio cuadra en 0 tras un cargo + su reverso completo.

4. **RLS de reputación** (`migrations/013_reputacion.sql`) y de
   `guest_review_response` (`migrations/021_reputacion_respuestas.sql`) —
   escenarios 21-26: staff con rol/property correctos captura/responde reseñas,
   staff de otra organización no ve ni inserta nada, y staff de la MISMA
   organización pero acotado por `property_ids` a otra property tampoco puede
   capturar una reseña fuera de su alcance (prueba el scoping fino, no solo el de
   organización).

5. **Aislamiento cross-tenant básico de folios/cargos/CFDI** — escenarios 27-29:
   staff de Hotel B no ve ni puede insertar sobre folios/cargos/CFDI de Hotel A.

## Contraste repositorio TypeScript ↔ SQL

Se revisó línea por línea `packages/domain-hoteles/src/postgres-repository.ts`
contra la ÚLTIMA versión de cada función SQL relevante para (1)-(5) arriba
(`mark_charge_reversed`, `revenue_engine_gate`/`revenue_backtest_run` CRUD,
`night_audit_run` claim/finish, `guest_review`/`guest_review_action`/
`guest_review_response` CRUD): nombres de función, número/orden de parámetros y
columnas coinciden en los 3 métodos revisados con mayor superficie
(`markChargeReversed`, `claimNightAuditRun`/`finishNightAuditRun`,
`updateRevenueGateState`/`setRevenueGateOwnerApproval`). Sin descuadres
encontrados en esta pasada.

## Cómo correrlo

```
scripts/verify-hoteles-sql-critico/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH. Levanta un cluster Postgres efímero,
aplica las migraciones reales de `supabase/migrations/`, corre los 29 escenarios de
`assertions.sql`, y apaga/borra el cluster al salir.

## CI

Corre automáticamente en cada PR/push vía `scripts/verify-real-postgres-ci/
run-gate.mjs` + `.github/workflows/postgres-real-gate.yml` — auto-descubierto por
tener `bootstrap.sql`+`post-migrations.sql`+`assertions.sql`, sin tocar el workflow.

## Por qué no es parte de `npm test`

Mismo criterio que `scripts/verify-outbox-grants/README.md`: este monorepo no tiene
todavía un tier de pruebas contra Postgres real dentro de `npm test`/`vitest` — ese
es un cambio de plataforma más amplio, fuera del alcance de este script puntual.
