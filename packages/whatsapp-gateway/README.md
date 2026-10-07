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
estructural que motivó este diseño fue `packages/voice-gateway` (**retirado del
árbol después, por falta de consumidor real — ver docs/CREDENCIALES.md §"Voz"**,
pero la razón estructural sigue vigente): un paquete de canal hermano de
`agent-core` que reutilizaba sus primitivas genéricas (`CircuitBreaker`, que es
genérico por `providerId: string`, no atado a LLM) sin meterse dentro de
`agent-core`. Este paquete sigue ese mismo patrón: reutiliza `@atiende/agent-core`'s
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

## Plantillas HSM de WhatsApp (rubro 17 de la auditoría, R-27)

La política de WhatsApp Business Platform exige una plantilla (HSM) PRE-APROBADA por
Meta para cualquier mensaje que el negocio inicia FUERA de la ventana de 24 h que abre un
mensaje entrante. Este monorepo encola varios envíos así (aviso de estado de un pedido de
voz/web en `packages/domain-restaurantes/src/order-notifications.ts`; recordatorios y
listas de espera de citas en `packages/domain-citas/src/reminders.ts`, que todavía NO
declaran plantilla).

Soporte en el gateway:

- `OutboundWhatsAppMessagePayload.template` (`types.ts`): `{ name, language, params }`. El payload
  del outbox (`jsonb`) puede traer `template` además de `body`; `body` sigue siendo obligatorio y es
  el texto libre de respaldo. El dispatcher valida la plantilla (nombre, idioma, máximo 10 variables
  de 1-1024 caracteres sin saltos de línea) y un payload mal formado va a `dead`, nunca a Meta.
- `MetaGraphWhatsAppClient` arma `{ type: "template", template: { name, language: { code },
  components: [{ type: "body", parameters: [...] }] } }` SOLO si `template.name` está en
  `approvedTemplates` (en `apps/api`: variable de entorno `WHATSAPP_APPROVED_TEMPLATES`, lista separada
  por comas). Sin esa declaración (default) todo sale como antes: texto libre, que dentro de la ventana
  de 24 h se entrega y fuera de ella Meta rechaza con un 4xx de negocio que el dispatcher marca `dead`
  (nunca `sent` fingido).
- Ninguna prueba ni build de este paquete envía algo real: los tests usan `FakeWhatsAppGraphClient` o un
  `fetchImpl` falso.

PL-31: el despachador acepta ademas un catalogo por organizacion (`dispatchPending(port, { plantillas })`, ver
`docs/PLANTILLAS-WHATSAPP.md`): si la organizacion dueña del mensaje tiene esa plantilla en estado aprobada, el cliente la envia como
`type: "template"` aunque no este en la lista global (`OutboundWhatsAppMessagePayload.templateApproved`). Una consulta fallida cae a la lista global.
La deteccion determinista de BAJA/ALTA esta en `src/opt-out.ts` (`detectarOptOut`).

Lo que sigue siendo un paso EXTERNO (no resoluble con código): crear cada plantilla en el Business
Manager de Meta, enviarla a revisión y esperar la aprobación; después agregar su nombre a
`WHATSAPP_APPROVED_TEMPLATES`. Las plantillas de estado de pedido (nombre, idioma `es_MX`, variables
`{{1}}` nombre, `{{2}}` sucursal, `{{3}}` total) están en `PLANTILLAS_ESTADO_PEDIDO` de
`packages/domain-restaurantes/src/order-notifications.ts`.

## wamid y estados de entrega

`WhatsAppSendResult.providerMessageId` (el `messages[0].id` que devuelve Graph API) ya no se descarta: el despachador lo entrega a
`MessagingOutboxPort.markSent(id, { providerMessageId, enviadoComo })`. Un puerto que no lo guarda (citas, hoteles y licitaciones hoy) lo ignora; restaurantes lo
persiste (migracion 066) para que los `statuses` del webhook encuentren el mensaje. `extractMetaStatuses` (puro, `src/statuses.ts`) extrae esos `statuses` sin texto
de mensaje, y `avanzarEstadoEntrega`/`motivoFalloEntrega` fijan el orden de los estados y la clasificacion de los codigos de error de Meta.

