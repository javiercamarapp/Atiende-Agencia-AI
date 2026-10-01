# verify-restaurantes-voz-kpi

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/035_voz_kpi_alertas_costo.sql`
(espejo: `supabase/migrations/20240101000246_035_restaurantes_voz_kpi_alertas_costo.sql`): KPI de voz por dia
local de la sucursal (`voz_kpis_diarios`), costo en centavos MXN, umbrales (`voice_alert_config`), alertas internas
(`voice_alert`, `voz_evaluar_alertas`) y eventos del servicio de voz (`voice_event`, `voz_registrar_evento`).

Cubre: agregados, llamada que cruza la medianoche (cuenta un solo dia), llamada justo a las 00:00 local, dia sin
datos (fila en 0 y p95 NULL), zona horaria distinta de la de Mexico y zona invalida, preview excluido, centavos con
y sin tipo de cambio, telefonia de otra sucursal/organizacion y categoria `voz` sin doble conteo, LLM solo con alcance
de toda la organizacion, rol insuficiente, sucursal fuera de alcance, cross-tenant, anon, sesion de sistema, rango
invalido, GRANT por columna, firma de `updated_by`, idempotencia de alertas y de la bitacora, y base sin migrar (42883).
Los rechazos usan el ayudante `public.t_esperar_error`, que exige el SQLSTATE exacto.

- Manual: `scripts/verify-restaurantes-voz-kpi/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
- Nota: los escenarios D1-D4 usan datos de "hoy"; solo fallarian si el reloj cruza la medianoche de Mexico entre los fixtures y el escenario.
