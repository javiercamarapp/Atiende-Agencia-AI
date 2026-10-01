# Superadmin CFO: P&L por vertical y por cliente (SA-29) y movimiento de MRR por vertical (SA-05)

Extiende el dashboard CFO (`SUPERADMIN_CFO.md`) y el costo por evento (`SUPERADMIN_COSTOS_PLANES.md`); no duplica
sus formulas. Pantalla: `/superadmin/pyl` ("P&L por vertical"). Formulas puras: `packages/billing/src/pyl.ts`.
Rutas: `apps/api/src/routes/superadmin-pyl.ts`.

## Rutas
| Ruta | Que hace |
|---|---|
| `GET /superadmin/pyl?mes=YYYY-MM` | P&L del mes por vertical y por cliente, comparativo contra el mes anterior y movimiento de MRR por vertical |
| `GET /superadmin/pyl/export.csv?mes=YYYY-MM&nivel=vertical\|cliente` | El mismo P&L en CSV (UTF-8 con BOM; celdas que parecen formula van neutralizadas) |
| `PUT /superadmin/pyl/infra` | Captura o corrige un concepto de infraestructura compartida del mes (en pesos). Exige step-up MFA |

## Definiciones
- **Ingreso reconocido** = ingreso esperado del mes segun el plan asignado (el mismo criterio del MRR del dashboard
  CFO). Mes en curso: plan vigente. Mes cerrado: la foto mensual guardada (`core.billing_snapshot_monthly`); sin foto,
  el ingreso es "sin foto del mes" (null), nunca 0. Una organizacion inactiva o con suscripcion cancelada reconoce 0.
  No es lo cobrado por Stripe.
- **COGS directo** = LLM + voz + WhatsApp + telefonia + otros (SMS, correo, storage), en pesos con el tipo de cambio
  vigente de cada mes. Voz, WhatsApp y telefonia son estimados hasta conciliar con la factura del proveedor.
- **Infra prorrateada** = infraestructura compartida capturada para el mes, repartida entre las organizaciones en
  proporcion a su COGS directo (micro-USD), en centavos exactos (resto mayor). Sin COGS que prorratear queda "sin asignar".
- **Margen de contribucion** = ingreso - COGS directo. **Margen bruto** = ingreso - COGS directo - infra prorrateada.
- Los margenes de un agregado solo cuentan organizaciones con ingreso conocido; el costo de las demas se informa aparte.
- **Movimiento de MRR por vertical**: la misma NRR/expansion/contraccion/churn del dashboard CFO, filtrada por vertical.

## Fuentes que faltan (se muestran como "sin dato", jamas como 0)
- Infraestructura del mes sin capturar: hay margen de contribucion, no margen bruto.
- Sin tipo de cambio del mes: no hay COGS en pesos ni margenes.
- Mes cerrado sin foto de ingreso, organizacion sin plan o con plan sin precio: ingreso null con su razon.
- Sin foto del mes anterior: movimiento de MRR "no disponible".
- Caja, cuentas por cobrar y pagos reales: no hay fuente en el modelo. El P&L es de devengo esperado.

## Base sin migrar
- `0030` sin aplicar: `GET /superadmin/pyl` responde 200 `disponible: false` con mensaje; el CSV, 503.
- `0032` sin aplicar: el P&L se calcula sin infra (`sin_infra_capturada`); la captura responde 503.
- Las lecturas corren bajo SAVEPOINT (`runWithSavepointFallback`): un SQLSTATE de migracion pendiente no aborta la
  transaccion de la sesion.

## Seguridad (migracion `0032_superadmin_pyl_infra.sql`)
- `core.infra_cost_monthly`: RLS sin policies y sin GRANT a ningun rol de la aplicacion.
- `core.superadmin_set_infra_cost`: `superadmin_require_caller` (`auth.uid() = p_caller_id` y superadmin real);
  mes futuro, monto negativo y concepto vacio se rechazan; queda en la bitacora append-only `core.plan_audit_log`
  (`infra_set`). Sin GRANT a `anon`.
- `core.list_infra_costs_for_superadmin`: caller-bound; otro llamador recibe cero filas.
- Verificacion contra Postgres real: `scripts/verify-superadmin-pyl/` (corre en el gate de CI).
