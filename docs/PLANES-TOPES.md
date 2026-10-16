# Planes: tope de mensajes, fin de prueba y portal de facturación (PL-16)

Migración `packages/db/migrations/0046_planes_topes_prueba_portal.sql` (espejo `supabase/migrations/20240101000275_...`).
Verificación contra Postgres real: `scripts/verify-planes-topes-prueba/` (45 escenarios, lo corre el gate de CI).

## Medidor mensual de mensajes

- **Qué cuenta**: cada mensaje saliente de WhatsApp **enviado** por el outbox (`WhatsAppOutboundDispatcher`), por organización y mes.
  Las respuestas del agente salen por el mismo outbox, así que no se cuentan aparte (contarlas dos veces duplicaría el consumo).
  Hoy mide **citas, hoteles y restaurantes** (sus puertos de outbox ya devuelven `organizationId`); licitaciones, rentas y
  despachos no tienen ese outbox de WhatsApp genérico y quedan fuera hasta que lo tengan.
- **Corte de mes**: en la zona horaria del negocio (`core.organization.timezone`, por omisión `America/Mexico_City`), no en UTC. Un
  mensaje a las 23:30 de `America/Merida` del último día cuenta en ese mes.
- **Libro mayor**: `core.message_usage_event`, idempotente por (`ref_tipo`, `ref_id`): reintentar un registro no cuenta dos veces.
- **Tope**: `core.plan_limit` con métrica `mensajes_mes` y acción `avisar | cobrar | pausar`. Sin plan o sin tope no hay límite.

## Qué pasa al acercarse y al llegar al tope

| Situación | Comportamiento |
|---|---|
| Pasa del 80 % (801 de 1000) | Una notificación in-app a owner/admin y otra a superadmin (dedupe por organización y mes). |
| Pasa del 100 % (1001 de 1000) | El mensaje **sale igual** y se registra como excedente; aviso crítico una sola vez por mes. |
| Plan con acción `pausar` y tope consumido | Se omiten solo los avisos **proactivos no críticos** (quedan `dead` con motivo `tope_mensajes_plan` y registrados como omitidos). |
| Respuesta a un cliente que escribió (`transaccional`) | **Siempre sale**, con cualquier plan. |
| Proactivo marcado `critico: true` en el payload | Siempre sale. |
| Base sin la 0046 o medidor con error | Se envía igual y no se mide nada (nunca un cliente sin respuesta por facturación). |

## Fin de prueba (7 / 3 / 1 días)

- `core.organization.trial_ends_at` (nullable). **Sin fecha no se avisa nunca.** Hoy la fecha se fija por SQL de soporte: no hay
  todavía un control de superadmin para editarla (hueco declarado en el PR).
- Cron `/internal/plataforma/prueba-avisos` (secreto interno; agendado una vez al día en `vercel.json`, `0 14 * * *` = 08:00 en
  Mérida, con latido y kill switch). `core.trial_notice_claim` reclama cada aviso una sola vez por (organización, días, fecha de fin); el día se
  cuenta en la zona del negocio. Cada aviso emite la notificación in-app y manda un correo (Resend, con clave de idempotencia) a
  owner/admin; un correo fallido o sin `RESEND_API_KEY` se reintenta hasta 3 veces (cada 30 min como mínimo).
- El correo sale directo por Resend y no por el outbox de correo de una vertical: esos outboxes son por vertical y por sucursal y este
  aviso es de plataforma (uno por organización).

## API

- `GET /billing/uso[?organizationId=]` (miembro de la organización o superadmin; otra organización = 403): consumo del mes, tope y
  acción del plan, estado de la prueba y estado del portal. Es la misma lectura para la consola del cliente y para SA-10.
- `GET /superadmin/costos/uso-mensajes[?limite=]` (superadmin): consumo del mes de todas las organizaciones contra su tope (solo el
  dato; la pantalla es SA-10).
- `POST /billing/portal` (owner/admin o superadmin): crea la sesión del Billing Portal de Stripe con el customer de la organización.
  Sin `STRIPE_SECRET_KEY` o sin customer responde **503** con el motivo (nunca una URL inventada); si Stripe falla, 502.
  Requiere que alguien configure el portal una vez en el dashboard de Stripe.

## UI

Pantalla compartida **Plan y uso** (`/<vertical>/:orgSlug/plan`) y banner en `VerticalShellConectado` (fin de prueba a 7 días o menos,
80 % y tope superado). El botón de facturación queda deshabilitado con la explicación cuando el servidor dice que no está
disponible. La pantalla no está en el menú lateral de las verticales (se llega desde el banner y desde las notificaciones).

## Orden de despliegue

1. Desplegar el código (funciona contra la base vieja: medidor, avisos y lecturas degradan a "no disponible", sin 500).
2. Aplicar la migración 0046 (`supabase/migrations/20240101000275_0046_...`). Es solo aditiva.
3. Fijar `core.organization.trial_ends_at` de las organizaciones en prueba (el cron `/internal/plataforma/prueba-avisos` ya corre a diario desde `vercel.json`).
4. Con `STRIPE_SECRET_KEY` configurada y el portal configurado en Stripe, el botón de facturación queda operativo.
