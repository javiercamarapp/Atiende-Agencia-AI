# Crons de Vercel

Fuente de verdad: `vercel.json::crons` (hoy **40** crons). Todos son rutas `GET|POST /internal/...` que
Vercel invoca por GET con `Authorization: Bearer $CRON_SECRET` (mismo valor que `INTERNAL_SECRET`).

## Reglas

- **Plan Pro obligatorio.** Hobby solo permite 2 crons y uno por día; con crons cada 5 minutos el deploy falla en Hobby.
  Pro permite hasta 40 crons por proyecto (el test `apps/api/tests/vercel-crons-contrato.spec.ts` falla si se pasa de 40)
  y 1 minuto como piso de frecuencia. Verifica el plan y los límites vigentes en el dashboard de Vercel; este repo no puede consultarlos.
- Los horarios de Vercel son **UTC**. Los diarios están escalonados; "0 8" UTC = 02:00 CDMX.
- Cada cron: rechaza con 401 sin secreto, corre dentro de `withHeartbeat` (latido en `/superadmin/salud` + kill switch) y
  está en `SWITCHABLE_CRONS` (`apps/api/src/platform-switches.ts`; sin excepciones desde PL-35). Cadencia esperada del panel se deriva de `vercel.json`.
- Solapamiento: Vercel puede reintentar o solapar corridas. Las rutas son idempotentes (SQL que solo toca filas pendientes,
  `dedupe_key` en el outbox, marcas `*_sent_at`, o lease por feed/comanda). Un cron que lanza deja latido `error`
  y alerta al superadmin; una unidad que falla no revierte a las demás (transacción por unidad).
- Drenadores de correo (`*/email-dispatch`, los 6 verticales con outbox): cada 15 minutos. Cada uno reclama el lote con `claim_email_outbox_batch`
  (`for update skip locked`, `attempts < 5`) y envía con `Idempotency-Key` por job, así que un solapamiento o reintento no duplica correos.
- Kill switch: superadmin → Interruptores → cron `<path>` (o global `crons`). Pausado responde 200 `{"skipped":"kill_switch"}`.
- Verificar a mano: `curl -H "Authorization: Bearer $CRON_SECRET" https://<dominio><path>`; o `vercel crons run <path>`.
  Revisa el latido en `/superadmin/salud/crons` (más señales en [Cómo saber que corren](#cómo-saber-que-corren)). **No lo hagas contra producción con WhatsApp/correo reales sin querer enviar mensajes.**

## Tabla de crons

| Path | Schedule (UTC) | Qué hace |
|---|---|---|
| `/internal/licitaciones/discover-tenders` | `0 5 * * *` | Descubre licitaciones nuevas |
| `/internal/licitaciones/deadline-reminders` | `0 6 * * *` | Avisos de plazos |
| `/internal/licitaciones/alert-notifications` | `0 7 * * *` | Alertas de coincidencias |
| `/internal/licitaciones/email-dispatch` | `*/15 * * * *` | Drena el outbox de correo |
| `/internal/hoteles/identidad-purga` | `0 8 * * *` | Purga de la bóveda de identidad vencida |
| `/internal/hoteles/night-audit` | `0 9 * * *` | Auditoría nocturna |
| `/internal/citas/confirmacion-cita` | `*/30 * * * *` | Recordatorio de cita 24 h antes (ventana ±30 min; marca reminder_24h_sent_at + dedupe_key en el outbox) |
| `/internal/citas/email-dispatch` | `*/15 * * * *` | Drena el outbox de correo (envía los recordatorios de correo) |
| `/internal/citas/google-calendar-sync` | `10 14 * * *` | Sincroniza Google Calendar |
| `/internal/hoteles/email-dispatch` | `*/15 * * * *` | Drena el outbox de correo |
| `/internal/restaurantes/email-dispatch` | `*/15 * * * *` | Drena el outbox de correo |
| `/internal/despachos/cobranza-reminders` | `25 14 * * *` | Recordatorios de cobranza |
| `/internal/despachos/email-dispatch` | `*/15 * * * *` | Drena el outbox de correo |
| `/internal/rentas/email-dispatch` | `*/15 * * * *` | Drena el outbox de correo |
| `/internal/rentas/checkin-recordatorio` | `40 14 * * *` | Recordatorio de check-in |
| `/internal/rentas/ical-sync` | `*/15 * * * *` | Sincroniza feeds iCal (lease por feed, piso de 10 min, backoff) |
| `/internal/rentas/checkout-sweep` | `*/15 * * * *` | Barrido de limpieza por propiedad (red de seguridad de la tarea que nace al confirmar la reserva: crea las faltantes, buffer del día del checkout, cancela/reprograma desfasadas) y avisos in-app de asignación y de mañana sin responsable |
| `/internal/whatsapp/dispatch` | `*/5 * * * *` | Drena el outbox de WhatsApp de citas/hoteles/restaurantes/licitaciones (503 sin WHATSAPP_ACCESS_TOKEN) |
| `/internal/superadmin/resumen-diario` | `0 15 * * *` | Resumen diario al superadmin |
| `/internal/superadmin/mantenimiento` | `5 15 * * *` | Mantenimiento de plataforma |
| `/internal/superadmin/alertas-cfo` | `15 15 * * *` | Alertas del CFO |
| `/internal/hoteles/revenue-recommendations` | `10 15 * * *` | Barrido de recomendaciones de revenue |
| `/internal/restaurantes/promover-programados` | `*/5 * * * *` | Promueve a pending los pedidos programados dentro de su anticipación (SQL solo actualiza filas en estado programado). R-16: el mismo tick barre, en una sesión de sistema independiente, las alertas in-app `restaurantes.pedido.entrega_tardia` y `restaurantes.pedido.programado_por_vencer` (una por pedido, sin cron nuevo). Autopiloto (migración 050, también sin cron nuevo, cada paso en su propia sesión de sistema): escala a owner/admin las aprobaciones sin respuesta (`restaurantes.aprobacion.vencida`, nunca aprueba solas), pasa `entregado` a `completado` y `listo_para_recoger` a `no_recogido` por tiempo, acepta solo `pending` con comanda capturada si la sucursal lo activó, avanza estados desde el POS (solo con adaptador real), devuelve al agente los handoffs sin respuesta humana y repone los «agotado hasta mañana» al cambiar el día de NEGOCIO de la sucursal. QA R2 (migración 076, sin cron nuevo): el día de negocio de PM (12:00-01:00) termina a la 01:00, no a medianoche; `no_recogido` cuenta desde que el pedido quedó listo; avisos `restaurantes.pedido.sin_aceptar` (pending 15 min) y `restaurantes.pedido.estancado` (listo para recoger o en camino 6 h); las alertas de voz (costo del día y tasa de error) se evalúan en este mismo tick; la consulta al POS corre fuera de la transacción con tope de 3 s por consulta y 12 s por paso; un error en cualquier paso del autopiloto, en los avisos operativos o en los avisos de cocina deja el latido y la bitácora en `parcial` (antes solo las comandas) |
| `/internal/restaurantes/softrestaurant-dispatch` | `*/5 * * * *` | Drena el outbox de comandas a SoftRestaurant (503 sin adaptador real, no reclama nada). Antes de revisar el adaptador barre las comandas en `captura_manual` que pasaron el umbral de su sucursal (5 min por omision) y emite `restaurantes.comanda.captura_manual_vencida`; sin la migracion 054 no hace nada |
| `/internal/restaurantes/voz-huerfanas` | `*/30 * * * *` | Cierra como `abandonado` las llamadas de voz abiertas hace más de 2 h (el worker murió antes de /cerrar); sin la migración 060 responde `not_available` y no toca nada |
| `/internal/hoteles/tickets-sla` | `*/10 * * * *` | Escala tickets con SLA vencido y avisa al 75 % del SLA (idempotente en SQL) |
| `/internal/hoteles/aprobaciones-expiracion` | `20 * * * *` | Marca como expiradas las aprobaciones humanas vencidas (idempotente en SQL) |
| `/internal/rentas/acceso-huesped` | `10 * * * *` | Libera instrucciones de acceso (una transacción por reserva, dedupe_key en el outbox, tope de 50) |
| `/internal/rentas/mensajes-automaticos` | `40 * * * *` | Crea borradores `pendiente_aprobacion` (nunca envía) desde plantillas aprobadas por evento: pre-llegada, check-in, check-out, reseña (una transacción por reserva, marca de idempotencia por reserva+evento, ventana de 24 h en la zona de la propiedad, tope de 50) |
| `/internal/hoteles/grupos-liberacion` | `30 9 * * *` | Libera bloqueos de grupos por cutoff (zona de la property) y vence cotizaciones (idempotente en SQL) |
| `/internal/hoteles/holds-vencidos` | `*/15 * * * *` | H-P3-03: libera el inventario de las pre-reservas (holds) del agente de reservas cuyo plazo venció, aunque el agente no se use (una transacción por property, reloj inyectable, idempotente; base sin la migración 037: la property se omite) |
| `/internal/hoteles/housekeeping-dia` | `5 * * * *` | H-P3-04: arranca solo el día de housekeeping de cada property cuya hora local alcanzó la hora de arranque configurada (07:00 por omisión; ventana de recuperación de 3 h): genera las tareas del día (respeta opt-out), asigna con la asignación automática si está encendida y avisa en la campana (`hoteles.housekeeping.dia_generado`). Idempotente por (property, fecha) con un ledger; una transacción por property; base sin la migración 045: la property se omite |
| `/internal/restaurantes/privacidad-retencion` | `30 8 * * *` | Purga por retención de conversaciones de WhatsApp y voz (lotes de 500, máx. 10 por corrida) |
| `/internal/plataforma/privacidad-retencion` | `50 8 * * *` | PL-35: purga por retención de la plataforma (GET con `Authorization: Bearer` ejecuta; otro GET solo simula). Lote acotado: 4 páginas de 25 organizaciones por corrida (sin cursor persistente) |
| `/internal/despachos/vencimientos-barrido` | `45 12 * * *` | D-26: por cada cliente con ficha genera las obligaciones fiscales del periodo en curso y escala las que vencen hoy/mañana o ya vencieron; avisa en la campana (`vencimiento_proximo`/`_vencido`, dedupe diario por property). Una transacción por cliente; idempotente |
| `/internal/despachos/cfdi-estatus-sat` | `20 6 * * 0` | D-27 (semanal, domingo): consulta el estatus de los CFDI ante el servicio **público** del SAT, los más antiguos primero (tope de 60 por corrida y 22 s de presupuesto, 3 consultas en paralelo). Un timeout deja el CFDI como estaba; jamás "vigente" por error. Una cancelación avisa una sola vez (`despachos.cfdi.cancelado`). Una transacción por CFDI |
| `/internal/despachos/efos-69b/descarga` | `40 7 3 * *` | D-28 (mensual, día 3): baja el CSV público de la lista 69-B (URL en `EFOS_69B_URL`), lo ingiere (idempotente por SHA-256 y periodo) y, si la edición es nueva o corregida, emite `despachos.efos.alerta` por cada CFDI ya ingerido que toca (dedupe por CFDI) |
| `/internal/restaurantes/cierres-dia` | `20 8 * * *` | R-42: asegura el cierre del día (y, tras un domingo cerrado, el resumen semanal) de cada sucursal con SU fecha local de negocio; 08:20 UTC = 02:20 en Mérida, después del cierre de la 01:00. Mira los últimos 3 días cerrados (`?dias=N`, 1 a 14, solo a mano), así un día sin corrida se recupera en la siguiente. Una transacción por sucursal; avisa en la campana (`dia_listo`/`semana_lista`, dedupe por sucursal y fecha). Idempotente |
| `/internal/restaurantes/repartidor-licencias` | `35 13 * * *` | R-15: avisa a owner/admin las licencias de repartidor vencidas o a menos de 30 días (dedupe mensual por repartidor). Una transacción por repartidor. Sin la migración correspondiente responde `not_available` |
| `/internal/plataforma/prueba-avisos` | `0 14 * * *` | PL-16: avisos de fin de prueba a 7/3/1 días (campana + correo), cada aviso exactamente una vez, con el día contado en la zona de cada negocio. Sin la migración 0046 responde `disponible:false` |

Todos tienen latido en el panel de salud (verifica el de cada path en `/superadmin/salud/crons`), el interruptor global `crons` y el interruptor por path (`SWITCHABLE_CRONS`; el test de contrato exige que cada cron de `vercel.json` esté ahí).

## Cómo saber que corren

Cuatro señales, de la más barata a la más detallada. Ninguna corre un cron ni toca datos.

1. **`GET /health` (público, sin secreto).** Además de `ok` y `status` trae `crons`, una señal agregada sin nombres ni errores:
   - `ok`: ningún latido atrasado y todos los crons de cadencia de 15 min o menos con al menos un latido (un cron diario que aún no tuvo su primera corrida no cuenta);
   - `sin_latido`: algún cron de cadencia de 15 min o menos (`whatsapp/dispatch`, `promover-programados`, `email-dispatch`...) **nunca** dejó un latido: el scheduler no los invoca (típico: `CRON_SECRET` distinto de `INTERNAL_SECRET`, o plan sin crons frecuentes);
   - `atrasados`: algún latido lleva más de 3 veces la cadencia de su cron sin renovarse;
   - `sin_medir`: no se pudo leer la tabla de latidos (migración 0015 sin aplicar, error o más de 2 s de espera). Nunca se reporta `ok` por no poder medir.
   El código HTTP no cambia (200 si la base responde): un cron sin latido no tumba el smoke del deploy. La lectura usa `core.list_cron_heartbeats_for_system()` y se cachea 5 s junto con el sondeo de la base.
   Un cron que corre pero termina en error **no** vuelve `crons` a `atrasados`: eso lo cubren `/superadmin/salud/crons` y la alerta `superadmin.cron.fallo`.
2. **Sondeo externo (`.github/workflows/prod-health.yml`, cada 15 min, sin cambios de frecuencia).** `scripts/health-check/check.ts` falla si `crons` no es `ok` en **dos sondeos seguidos** (6 s de separación) y el job queda en rojo. Con `PROD_HEALTH_OPEN_ISSUE=true` abre o comenta un issue "Salud de produccion". Sin la variable de repo `PROD_BASE_URL` no sondea y deja un `::warning::` visible.
3. **Alerta en la campana de superadmin.** El cron diario de resumen emite `superadmin.salud.cron_sin_latido` (una por día) si algún cron de cadencia de 15 min o menos no tiene ningún latido.
4. **Panel `/superadmin/salud/crons`:** estado, último latido y error de cada cron, con el kill switch.

## No agendados a propósito

- `/internal/despachos/efos-69b/ingestar`: POST con el listado en el cuerpo y `?periodo=` (tope de 4 MB); no es agendable por Vercel. La descarga automática la hace `/internal/despachos/efos-69b/descarga` (agendada), sin ese tope.
- `/internal/restaurantes/voz/*`: endpoints de la llamada de voz, no son crons.

## Orden de despliegue

1. Confirma que el proyecto de Vercel es Pro y que `CRON_SECRET` está definido (= `INTERNAL_SECRET`).
2. Mergea: el deploy registra los crons y empiezan a correr. Contra una base sin migrar las rutas responden "no disponible"
   (`disponible:false` / `omitida: migracion_pendiente`) sin 500 y sin tocar datos.
3. Aplica las migraciones pendientes (hoteles 034/035/036, rentas 025, restaurantes 024/030/034, despachos 022 para los crons D-26/D-27/D-28) cuando decidas; no son parte de este cambio. Sin la 022 los tres crons de despachos responden `status: "no_disponible"` (200) sin tocar datos.
   `EFOS_69B_URL` (opcional) fija la URL del CSV de la 69-B; sin ella se usa la ruta histórica del SAT, **no verificada**.
4. Si algo se comporta mal: pausa el cron desde superadmin (kill switch) o el global `crons`; revertir el PR quita los crons.

Nota (QA R2): `/internal/restaurantes/cierres-dia` y `/internal/restaurantes/repartidor-licencias` NO están en `vercel.json` (decisión de costo), pero ya van envueltos en `withHeartbeat`: cuando se agenden aparecerán en `/superadmin/salud`, dejarán bitácora de corridas (`parcial` si una sucursal o un repartidor falla) y se podrán pausar con el interruptor por cron.
