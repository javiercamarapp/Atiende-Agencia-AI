# Superadmin CFO: costo por evento, margen y planes (SA-02 / SA-03)

Migración: `packages/db/migrations/0028_superadmin_costos_planes.sql` (espejo
`supabase/migrations/20240101000209_0028_superadmin_costos_planes.sql`).
Verificación contra Postgres real: `scripts/verify-superadmin-costos-planes/` (lo corre el gate de CI).
Pantallas: `/superadmin/costos-margen` y `/superadmin/planes`.

## Qué resuelve

- **Costo por evento por organización** (SA-02): une, por organización y mes, el LLM
  (`core.llm_usage_daily`, que ya tiene tope y reserva) con los eventos de voz, WhatsApp,
  telefonía, SMS, correo y storage (`core.usage_cost_event`). Un evento LLM nunca se escribe en la
  tabla nueva (la columna `categoria` no admite `llm`), así que no hay doble conteo.
- **Margen y alertas**: ingreso esperado del plan asignado contra costo en MXN; alerta de margen
  bajo (umbral 30 % por defecto, configurable en la consulta), margen negativo, tope LLM mensual
  (usa `alert_threshold_pct` de `core.llm_org_budget`) y límites del plan.
- **Catálogo de planes** (SA-03): `core.plan` por vertical, `core.plan_limit` y
  `core.organization_plan`. Seeds: solo los precios que ya existían en
  `packages/billing/src/per-seat.ts` (hoteles, restaurantes, citas); rentas, licitaciones y
  despachos quedan con precio `NULL` («por configurar») hasta que producto los capture en la pantalla.
- **Asignación en dos pasos**: solicitar (motivo >= 20 caracteres) y confirmar (step-up MFA), solo
  el solicitante confirma, una pendiente por organización, vence en 10 minutos, bitácora append-only
  (`core.plan_audit_log`).

## Regla de la casa: nunca inventar una cifra

- Sin tipo de cambio (`core.fx_rate`, capturado desde la pantalla con fecha y fuente) el costo en
  MXN y el margen son `null`; el costo en USD siempre se muestra.
- Sin plan, o con plan sin precio, el ingreso es `null` con su razón (`sin_plan`,
  `precio_no_configurado`).
- Los costos de voz, WhatsApp y telefonía son estimados (`costo_estimado = true`) hasta
  conciliarlos con la factura del proveedor.
- Ingreso esperado = base + asientos facturables x precio por asiento. Con suscripción `activa` y
  `seats > 0` se usan esos seats (Stripe ya cobra la cantidad neta de incluidos); si no, sucursales
  activas menos asientos incluidos. No es lo cobrado por Stripe.

## Qué se hace cumplir y qué solo se muestra

Asignar un plan **no toca Stripe** ni `core.organization_billing`. El único límite que corta de
verdad es el tope LLM: si el plan trae `llm_costo_micro_usd_mes` con acción `pausar`, al confirmar
la asignación se escribe `core.llm_org_budget.monthly_cap_micro_usd` y lo hace cumplir la reserva
mensual que ya existía. Minutos de voz, mensajes, sucursales y asientos se evalúan y se muestran
(ok / aviso / excedido) pero hoy no cortan nada por sí solos; la pantalla lo dice.

## Seguridad (resumen; el detalle está en el comentario de la migración)

- Tablas sin GRANT a `anon`/`authenticated`/`public`, RLS habilitada sin policies: todo pasa por
  funciones `security definer` con `search_path` fijo y `revoke ... from public`.
- Funciones de superadmin: `auth.uid() = p_caller_id` y `core.platform_superadmin` verificados
  dentro de la función (`core.superadmin_require_caller`); las lecturas devuelven cero filas a quien no
  es superadmin.
- `core.record_usage_cost_event` es solo-sistema (`auth.uid() is null`): un tenant no puede inflar
  el costo de otra organización por RPC directo. El vertical se deriva de la organización, no del
  llamador.
- Step-up MFA en: tipo de cambio, editar plan, fijar/quitar límite y confirmar asignación.

## Compatibilidad con la base sin migrar

Cada método del repositorio corre bajo `runWithSavepointFallback`: ante 42883/42P01/42703
devuelve `availability: "not_migrated"` con datos vacíos (las lecturas responden
`disponible: false`, las escrituras 503) y la transacción de la sesión sigue viva. Nada de esto
afecta flujos que hoy funcionan.

## Qué falta (no inventado)

- **Quién escribe los eventos de costo**: la función `core.record_usage_cost_event` y
  `CostosPlanesRepository.recordEvent` existen y están probadas, pero ningún flujo de voz, WhatsApp o
  telefonía las invoca todavía. La voz enchufa cuando exista el cierre de llamada con costo
  (`restaurantes.voice_conversation.costo_estimado_micro_usd`); hasta entonces el reporte muestra
  solo el LLM y los eventos vacíos son honestos.
- Precios de rentas, licitaciones y despachos, y el tipo de cambio: captura del superadmin.
- Aplicación automática de límites distintos al tope LLM (pausar por minutos/mensajes).
