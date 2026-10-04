# verify-restaurantes-voz-worker

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/067_voz_modo_entrada_gasto_mes_y_latencia.sql`
(espejo: `supabase/migrations/20240101000328_067_voz_modo_entrada_gasto_mes_y_latencia.sql`), la parte SQL del worker de
telefonia de voz (`apps/voice-worker`):

- `voz_marcar_modo_entrada` (solo sistema): marca como llego la llamada (`desborde` | `total` | `prueba`) y la franja del dia.
- `voz_gasto_mes_micro_usd` (solo sistema): gasto de voz del mes calendario en la zona de Merida, desde `core.usage_cost_event`.
- `voz_modo_entrada_kpi` (owner/admin con alcance de la sucursal): llamadas y pedidos en desborde, ventas recuperadas (sin
  cancelados) y latencia de voz a voz p50/p95 por dia local.

Cubre: positivo, negativo, cross-tenant, anon, sesion de staff en funciones de sistema, listas cerradas de modo/franja, frontera de mes
en la zona de Merida (el 31 a las 20:00 locales es del mes que cierra), categorias que no se suman (telefonia, otra organizacion),
pedidos cancelados fuera de las ventas, ciclo completo de una llamada tal como lo escribe el worker (iniciar, marcar, turnos con
latencia, costo por escalon idempotente, cerrar) y base sin migrar (42883 recuperable con subtransaccion).
Los rechazos usan `public.t_esperar_error`, que exige el SQLSTATE exacto.

- Manual: `scripts/verify-restaurantes-voz-worker/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
