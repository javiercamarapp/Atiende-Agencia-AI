# `@atiende/whatsapp-gateway`

El dispatcher de WhatsApp saliente REAL que faltaba en las 3 verticales con agente
de WhatsApp (citas/hoteles/restaurantes): cada webhook (`apps/api/src/routes/
verticals/{citas,hoteles,restaurantes}/whatsapp.ts`) procesa el mensaje entrante y
decide la respuesta correcta (`outcome.reply`), pero hasta este paquete esa
respuesta nunca se enviaba de verdad — quedaba documentado como "responsabilidad
del dispatcher de apps/worker (messaging_outbox), fuera de esta fase" en los 3
webhooks. `apps/worker` nunca se construyó (ver `apps/worker/README.md`); el
patrón real de trabajo periódico de este monorepo es una ruta interna gateada por
`x-atiende-internal-secret` invocada por un scheduler externo (ver
`apps/api/src/routes/verticals/citas/reminders.ts`) — este paquete sigue ese mismo
patrón vía `apps/api/src/routes/internal/whatsapp-dispatch.ts`.

## Por qué un paquete nuevo (y no extender `agent-core`)

`agent-core` es explícitamente el gateway **LLM** del monorepo (`LlmGateway`,
escalera de proveedores, presupuesto por tokens). Un envío de WhatsApp no tiene
escalera de fallback entre proveedores (solo existe Meta Graph API) ni presupuesto
por tokens — meterlo ahí forzaría un concepto que no aplica. El paralelo
estructural correcto ya existe en el monorepo: `packages/voice-gateway`, un paquete
de canal hermano de `agent-core` que SÍ reutiliza sus primitivas genéricas
(`CircuitBreaker`, que es genérico por `providerId: string`, no atado a LLM). Este
paquete sigue exactamente ese patrón: reutiliza `@atiende/agent-core`'s
`CircuitBreaker` (keyed por `phone_number_id` en vez de LLM provider id), sin
duplicar su lógica.

## Por qué el shape de `messaging_outbox` se unificó en las 3 verticales

Antes de este cambio, solo `domain-citas` tenía una tabla `messaging_outbox` real
(`migrations/003_waitlist_and_rate_limit.sql`, Fase 1). `domain-hoteles` y
`domain-restaurantes` no tenían NINGÚN concepto de outbox — la respuesta del turn
handler solo se persistía en el historial de la conversación (`whatsapp_append_turn`),
nunca se encolaba para envío real. Este cambio agrega la misma tabla/funciones
(`enqueue_messaging_outbox`, `claim_messaging_outbox_batch`,
`complete_messaging_outbox_*`) a los 3 dominios — mismo shape de fila, mismo idioma
de claim-con-lease-reclamable que ya usan `whatsapp_inbound_events`/
`whatsapp_conversation_leases` en las 3 verticales.

El punto de unificación real para este paquete es el puerto TS `MessagingOutboxPort`
(`outbox-port.ts`), NO una tabla compartida entre schemas de Postgres — cada dominio
sigue siendo dueño de su propio schema/clave de partición (`organization_id` en
citas/restaurantes, `property_id` en hoteles, porque 1 número de WhatsApp = 1
property ahí). Cada dominio expone su propio adaptador
(`createXMessagingOutboxPort(repo)`, ver `packages/domain-*/src/whatsapp/outbox-adapter.ts`)
que implementa ese puerto sobre su propio repositorio.

## Garantías

- **Nunca reintento infinito**: `maxAttempts` (default 5) — agotado el tope, o un
  error no reintentable (payload inválido, 4xx de negocio de Graph API), el mensaje
  se marca `dead` de inmediato.
- **Backoff exponencial capado** (`computeBackoffSeconds`): 30s, 60s, 120s, 240s...
  tope 1h.
- **Idempotencia**: un mensaje `sent` nunca vuelve a ser elegible para
  `claimBatch`, sea cual sea el número de corridas futuras del job contra la misma
  tabla — ver `tests/dispatcher.spec.ts::"un mensaje ya enviado nunca se reenvía en
  una segunda corrida"`.
- **Aislamiento por mensaje**: un mensaje/número roto nunca tumba el resto del
  batch ni de las otras verticales (la ruta interna aísla por vertical, igual que
  `reminders.ts` aísla por tenant).
- **Fail-closed sin `WHATSAPP_ACCESS_TOKEN`**: `MetaGraphWhatsAppClient` lanza en
  el constructor si falta — nunca finge un envío.

## Uso

```ts
import { MetaGraphWhatsAppClient, WhatsAppOutboundDispatcher } from "@atiende/whatsapp-gateway";
import { createCitasMessagingOutboxPort } from "@atiende/domain-citas";

const dispatcher = new WhatsAppOutboundDispatcher({
  graphClient: new MetaGraphWhatsAppClient({ accessToken: env.whatsappAccessToken! }),
});

const summary = await dispatcher.dispatchPending(createCitasMessagingOutboxPort(citasRepo), { limit: 25 });
```

En tests, sustituye `MetaGraphWhatsAppClient` por `FakeWhatsAppGraphClient` — nunca
toca la red, deja que el test decida por llamada si falla y con qué error.

## Gap conocido: sin soporte de plantillas HSM (rubro 17 de la auditoría)

`MetaGraphWhatsAppClient` (`providers/meta-graph-client.ts`) solo construye
mensajes `type: "text"` o `type: "interactive"` — nunca `type: "template"`, y
`OutboundWhatsAppMessagePayload` (`types.ts`) no tiene ningún campo de plantilla
(nombre/idioma/parámetros). Eso es correcto para una respuesta DENTRO de la ventana
de 24h que abre un mensaje entrante (el turn-handler de hoteles/restaurantes), pero
la política real de WhatsApp Business Platform exige una plantilla (HSM)
PRE-APROBADA por Meta para cualquier mensaje que el negocio inicia FUERA de esa
ventana. Verificado contra el código real: este monorepo ya encola varios envíos
así —

- `packages/domain-citas/src/reminders.ts` — recordatorio de cita 24h antes
  (`appointment.reminder_24h`) y ofertas/broadcasts de lista de espera
  (`waitlist.slot_offered`/`waitlist.slot_available_broadcast`).
- `packages/domain-restaurantes/src/order-notifications.ts` — notificación de
  cambio de estado de pedido (`order.status.*`), incluso cuando el pedido se
  originó por voz/web/admin (sin ningún WhatsApp previo del cliente).

Contra Meta real, estos envíos proactivos fuera de ventana se rechazan con un 4xx
de negocio (ej. código 131047) — `WhatsAppOutboundDispatcher` ya clasifica eso como
no reintentable y marca el mensaje `dead` de inmediato (nunca finge `sent`), así que
el comportamiento actual ya falla honesto. El hueco real es que ese recordatorio/
notificación simplemente nunca le llega al destinatario por WhatsApp en producción.

**Por qué esto no se resuelve con código en esta pasada**: una plantilla HSM exige
un proceso 100% del lado de Meta (Business Manager + WhatsApp Business Account real,
redactar el texto exacto, enviarlo a revisión de Meta, esperar aprobación — días,
a veces semanas) que ninguna credencial de este entorno habilita
(`WHATSAPP_ACCESS_TOKEN` no configurada). Construir un `type: "template"` sin
ningún nombre de plantilla real que probar sería fingir una capacidad que nadie
puede verificar. **Cuando exista una plantilla real aprobada por Meta**, la
extensión real son 3 pasos, ninguno de los cuales toca el dispatcher ni el schema
de `messaging_outbox` (el payload ya es jsonb libre):

1. Agregar `templateName`/`templateLanguage`/`templateParams` opcionales a
   `OutboundWhatsAppMessagePayload`.
2. Que `buildRequestBody` (meta-graph-client.ts) arme
   `{ type: "template", template: { name, language: { code }, components: [...] } }`
   cuando esos campos vengan poblados.
3. Que cada encolador (`reminders.ts`/`order-notifications.ts`) los pase en vez de
   `body`/`buttons` libres para los eventos proactivos listados arriba.
