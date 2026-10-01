# Superadmin CFO: dashboard ejecutivo, NRR y alertas (SA-01, SA-05, SA-36)

Compone lo que ya existe (costo por evento y catalogo de planes de `0028`, `llm_usage_daily`,
`organization_billing`) en una sola pantalla `/superadmin/cfo`. No duplica tablas de costo ni de plan.

## Que muestra
- **MRR / ARR**: ingreso esperado por el plan asignado (base + asientos facturables x precio por asiento)
  de las organizaciones `active` con suscripcion no `cancelada`. ARR = MRR x 12. Por vertical y por cliente
  (los 5 mayores y la participacion del mayor).
- **Sin precio**: una organizacion activa sin plan o con plan sin precio NO suma al MRR y se cuenta aparte.
- **Margen bruto**: reutiliza `calcularFilaCostoMargen` (`packages/billing/src/cost-margin.ts`); mejores y
  peores clientes por margen %. Sin tipo de cambio, "no disponible".
- **NRR / GRR**: contra la foto mensual del mes anterior (`core.billing_snapshot_monthly`). Sin foto previa,
  "no disponible" (nunca 100 %).
- **Cobranza vencida**: organizaciones activas en `pago_pendiente`.
- **Caja**: sin datos. No existe fuente de saldos, cuentas por cobrar ni pagos; el forecast de caja es otro item.

## Alertas (SA-36)
Cron `/internal/superadmin/alertas-cfo` (diario, 15:15 UTC): toma la foto mensual y evalua cuatro reglas sobre
organizaciones activas, sin LLM:
| Regla | Dispara cuando |
|---|---|
| `margen_bajo` | margen % < umbral (30 por defecto) o margen negativo |
| `voz_sobre_tope` | minutos de voz del mes > limite `minutos_voz_mes` del plan |
| `cobranza_vencida` | `organization_billing.status = 'pago_pendiente'` |
| `cliente_en_riesgo` | dos o mas senales (las tres anteriores o tope de LLM) |

Cada regla sale como UNA alerta con la lista de organizaciones por el despachador de `apps/api/src/alertas`
(correo / webhook / Sentry, redaccion y piso por hora por tipo y destino). El `tipo` es `cfo:<regla>` (sin ids de
organizacion). Nunca cambia un plan ni un tope: solo avisa.

## Base sin migrar
Todo el codigo nuevo degrada a "no disponible" (200, nunca 500) si `0030` no esta aplicada: el repositorio
corre bajo SAVEPOINT (`runWithSavepointFallback`), y el cron responde `ok:false, motivo: migracion_pendiente`
sin ensuciar el latido.

## Seguridad (migracion `0030_superadmin_cfo_dashboard.sql`)
- `billing_snapshot_monthly`: RLS sin policies y sin GRANT a ningun rol de la aplicacion.
- `cfo_org_rows`: cuerpo unico interno, sin GRANT; solo lo ejecutan los envoltorios.
- `get_cfo_dashboard_for_superadmin` y `list_billing_snapshots_for_superadmin`: `auth.uid() = p_caller_id` y
  `core.is_platform_superadmin`; otro llamador recibe cero filas. Sin GRANT a `anon`.
- `get_cfo_alert_inputs_for_system` y `snapshot_billing_monthly_for_system`: solo-sistema (`auth.uid() is null`).
  La foto solo admite el mes en curso: la historia cerrada no se reescribe.
- Verificacion contra Postgres real: `scripts/verify-superadmin-cfo/` (corre en el gate de CI).
