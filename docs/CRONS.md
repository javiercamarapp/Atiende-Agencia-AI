# Crons de Vercel

Fuente de verdad: `vercel.json::crons` (hoy **33** crons). Todos son rutas `GET|POST /internal/...` que
Vercel invoca por GET con `Authorization: Bearer $CRON_SECRET` (mismo valor que `INTERNAL_SECRET`).

## Reglas

- **Plan Pro obligatorio.** Hobby solo permite 2 crons y uno por día; con crons cada 5 minutos el deploy falla en Hobby.
  Pro permite hasta 40 crons por proyecto (el test `apps/api/tests/vercel-crons-contrato.spec.ts` falla si se pasa de 40)
  y 1 minuto como piso de frecuencia. Verifica el plan y los límites vigentes en el dashboard de Vercel; este repo no puede consultarlos.
- Los horarios de Vercel son **UTC**. Los diarios están escalonados; "0 8" UTC = 02:00 CDMX.
- Cada cron: rechaza con 401 sin secreto, corre dentro de `withHeartbeat` (latido en `/superadmin/salud` + kill switch) y
  está en `SWITCHABLE_CRONS` (salvo las 4 excepciones de abajo) (`apps/api/src/platform-switches.ts`). Cadencia esperada del panel se deriva de `vercel.json`.
- Solapamiento: Vercel puede reintentar o solapar corridas. Las rutas son idempotentes (SQL que solo toca filas pendientes,
  `dedupe_key` en el outbox, marcas `*_sent_at`, o lease por feed/comanda). Un cron que lanza deja latido `error`
  y alerta al superadmin; una unidad que falla no revierte a las demás (transacción por unidad).
- Drenadores de correo (`*/email-dispatch`, los 6 verticales con outbox): cada 15 minutos. Cada uno reclama el lote con `claim_email_outbox_batch`
  (`for update skip locked`, `attempts < 5`) y envía con `Idempotency-Key` por job, así que un solapamiento o reintento no duplica correos.
- Kill switch: superadmin → Interruptores → cron `<path>` (o global `crons`). Pausado responde 200 `{"skipped":"kill_switch"}`.
- Verificar a mano: `curl -H "Authorization: Bearer $CRON_SECRET" https://<dominio><path>`; o `vercel crons run <path>`.
  Revisa el latido en `/superadmin/salud/crons`. **No lo hagas contra producción con WhatsApp/correo reales sin querer enviar mensajes.**

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
| `/internal/rentas/checkout-sweep` | `50 14 * * *` | Barrido de check-out |
| `/internal/whatsapp/dispatch` | `*/5 * * * *` | Drena el outbox de WhatsApp de citas/hoteles/restaurantes/licitaciones (503 sin WHATSAPP_ACCESS_TOKEN) |
| `/internal/superadmin/resumen-diario` | `0 15 * * *` | Resumen diario al superadmin |
| `/internal/superadmin/mantenimiento` | `5 15 * * *` | Mantenimiento de plataforma |
| `/internal/superadmin/alertas-cfo` | `15 15 * * *` | Alertas del CFO |
| `/internal/hoteles/revenue-recommendations` | `10 15 * * *` | Barrido de recomendaciones de revenue |
| `/internal/restaurantes/promover-programados` | `*/5 * * * *` | Promueve a pending los pedidos programados dentro de su anticipación (SQL solo actualiza filas en estado programado) |
| `/internal/restaurantes/softrestaurant-dispatch` | `*/5 * * * *` | Drena el outbox de comandas a SoftRestaurant (503 sin adaptador real, no reclama nada) |
| `/internal/hoteles/tickets-sla` | `*/10 * * * *` | Escala tickets con SLA vencido y avisa al 75 % del SLA (idempotente en SQL) |
| `/internal/hoteles/aprobaciones-expiracion` | `20 * * * *` | Marca como expiradas las aprobaciones humanas vencidas (idempotente en SQL) |
| `/internal/rentas/acceso-huesped` | `10 * * * *` | Libera instrucciones de acceso (una transacción por reserva, dedupe_key en el outbox, tope de 50) |
| `/internal/rentas/mensajes-automaticos` | `40 * * * *` | Crea borradores `pendiente_aprobacion` (nunca envía) desde plantillas aprobadas por evento: pre-llegada, check-in, check-out, reseña (una transacción por reserva, marca de idempotencia por reserva+evento, ventana de 24 h en la zona de la propiedad, tope de 50) |
| `/internal/hoteles/grupos-liberacion` | `30 9 * * *` | Libera bloqueos de grupos por cutoff (zona de la property) y vence cotizaciones (idempotente en SQL) |
| `/internal/restaurantes/privacidad-retencion` | `30 8 * * *` | Purga por retención de conversaciones de WhatsApp y voz (lotes de 500, máx. 10 por corrida) |
| `/internal/despachos/vencimientos-barrido` | `45 12 * * *` | D-26: por cada cliente con ficha genera las obligaciones fiscales del periodo en curso y escala las que vencen hoy/mañana o ya vencieron; avisa en la campana (`vencimiento_proximo`/`_vencido`, dedupe diario por property). Una transacción por cliente; idempotente |
| `/internal/despachos/cfdi-estatus-sat` | `20 6 * * 0` | D-27 (semanal, domingo): consulta el estatus de los CFDI ante el servicio **público** del SAT, los más antiguos primero (tope de 60 por corrida y 22 s de presupuesto, 3 consultas en paralelo). Un timeout deja el CFDI como estaba; jamás "vigente" por error. Una cancelación avisa una sola vez (`despachos.cfdi.cancelado`). Una transacción por CFDI |
| `/internal/despachos/efos-69b/descarga` | `40 7 3 * *` | D-28 (mensual, día 3): baja el CSV público de la lista 69-B (URL en `EFOS_69B_URL`), lo ingiere (idempotente por SHA-256 y periodo) y, si la edición es nueva o corregida, emite `despachos.efos.alerta` por cada CFDI ya ingerido que toca (dedupe por CFDI) |

Todos tienen latido en el panel de salud (verifica el de cada path en `/superadmin/salud/crons`) y el interruptor global `crons`. Tienen además interruptor por path todos salvo 4 anteriores a este documento: `hoteles/identidad-purga`, `superadmin/resumen-diario`, `superadmin/mantenimiento` y `superadmin/alertas-cfo` (lista cerrada en el test de contrato; un cron nuevo debe ir en `SWITCHABLE_CRONS`).

## No agendados a propósito

- `/internal/plataforma/privacidad-retencion`: Vercel solo invoca por GET y la ruta solo **simula** con GET (la purga real exige
  `POST ?ejecutar=1`). Agendarla no purgaría nada. Se dispara a mano o desde un scheduler externo que haga POST.
- `/internal/despachos/efos-69b/ingestar`: POST con el listado en el cuerpo y `?periodo=` (tope de 4 MB); no es agendable por Vercel. La descarga automática la hace `/internal/despachos/efos-69b/descarga` (agendada), sin ese tope.
- `/internal/restaurantes/voz/*`: endpoints de la llamada de voz, no son crons.

## Orden de despliegue

1. Confirma que el proyecto de Vercel es Pro y que `CRON_SECRET` está definido (= `INTERNAL_SECRET`).
2. Mergea: el deploy registra los crons y empiezan a correr. Contra una base sin migrar las rutas responden "no disponible"
   (`disponible:false` / `omitida: migracion_pendiente`) sin 500 y sin tocar datos.
3. Aplica las migraciones pendientes (hoteles 034/035/036, rentas 025, restaurantes 024/030/034, despachos 022 para los crons D-26/D-27/D-28) cuando decidas; no son parte de este cambio. Sin la 022 los tres crons de despachos responden `status: "no_disponible"` (200) sin tocar datos.
   `EFOS_69B_URL` (opcional) fija la URL del CSV de la 69-B; sin ella se usa la ruta histórica del SAT, **no verificada**.
4. Si algo se comporta mal: pausa el cron desde superadmin (kill switch) o el global `crons`; revertir el PR quita los crons.
