# Plantillas de WhatsApp (HSM) por organizacion (PL-31)

Meta solo entrega fuera de la ventana de 24 h (contada desde el ultimo mensaje del cliente) una plantilla PRE-APROBADA. Este documento
describe como la plataforma decide entre texto libre, plantilla o correo, y la lista exacta de plantillas que hay que crear en el Business
Manager de Meta (paso externo, con credenciales: ver `docs/CREDENCIALES.md`).

## Como decide la plataforma (citas)

Antes de encolar un aviso PROACTIVO (el negocio escribe primero), `decidirEnvioProactivo`
(`packages/domain-citas/src/whatsapp/proactivo.ts`) revisa cuando escribio el cliente por ultima vez a esa organizacion
(`citas.ultimo_mensaje_entrante`, sobre el ledger `citas.whatsapp_inbound_events`):

| Situacion | Resultado |
| --- | --- |
| Escribio hace menos de 23 h (1 h de margen para la demora del despachador) | Texto libre, con botones (recordatorio). Sin plantilla. |
| Fuera de la ventana y la organizacion tiene la plantilla del evento en estado `aprobada` | Se encola con `template` (nombre, idioma, variables en el orden del catalogo) ademas del texto de respaldo. Sin botones: la plantilla no los lleva. |
| Fuera de la ventana y sin plantilla aprobada (o que pide una variable que el evento no calcula) | NO se encola WhatsApp (Meta lo rechazaria y quedaria `dead`). El correo cubre si el cliente dejo uno. El cron emite el aviso in-app `citas.whatsapp.sin_plantilla` (una por organizacion, evento y dia, solo el conteo). |
| Base sin la migracion 0049 | Comportamiento anterior (texto libre). |

Eventos cubiertos hoy: recordatorio de 24 h, oferta de lista de espera y aviso manual a la lista de espera. En la oferta y el aviso de lista
de espera el correo sale como `waitlist.slot_offered` / `waitlist.slot_available_broadcast` solo si el cliente tiene correo; sin correo no se
avisa ni se gasta un intento del cliente (el cupo de notificacion no se reclama).

Al despachar, el despachador vuelve a consultar el catalogo (`core.whatsapp_plantilla_aprobada(organizacion, nombre)`): una plantilla
aprobada de la organizacion A nunca sirve a la organizacion B. Si la consulta falla decide la lista global `WHATSAPP_APPROVED_TEMPLATES`
(compatibilidad con restaurantes, que declara sus plantillas de estado de pedido ahi).

## Donde se registran

`Citas > Mensajes de WhatsApp > Plantillas de WhatsApp` (solo owner/admin): nombre en Meta, idioma, variables en el orden de `{{1}}`, `{{2}}`...
y estado (`borrador`, `enviada`, `aprobada`, `rechazada`). Solo `aprobada` se usa para enviar. API:
`GET|PUT|DELETE /v1/citas/properties/:propertyId/admin/whatsapp-plantillas[/:evento]`.

## Lista exacta de plantillas a crear en Meta (categoria Utilidad, idioma es_MX)

Los nombres son sugeridos: la plataforma usa el que se registre en el catalogo. Lo que importa es el ORDEN de las variables.

| Evento | Nombre sugerido | Cuerpo | Variables a registrar, en orden |
| --- | --- | --- | --- |
| `appointment.reminder_24h` | `recordatorio_cita_24h` | `Hola {{1}}, te recordamos tu cita en {{2}} el {{3}} a las {{4}}. Si no puedes asistir, responde a este mensaje para reagendar o cancelar.` | `nombre`, `negocio`, `fecha`, `hora` |
| `waitlist.slot_offered` | `hueco_lista_espera` | `Hola {{1}}, se liberó un espacio en {{2}} que coincide con lo que buscabas. Responde SÍ para que te lo agendemos o NO si ya no te interesa.` | `nombre`, `negocio` |
| `waitlist.slot_available_broadcast` | `aviso_lista_espera` | `Hola {{1}}, se acaba de liberar un espacio en {{2}}. Responde SÍ si todavía te interesa.` | `nombre`, `negocio` |

Variables disponibles por evento: recordatorio = `nombre`, `negocio`, `servicio`, `profesional`, `fecha`, `hora`, `fecha_hora`; listas de espera =
`nombre`, `negocio`. Cada valor sale sin saltos de linea ni tabuladores, recortado a 1024 caracteres y nunca vacio (si faltara, no se manda la plantilla).

Restaurantes (aviso de estado de pedido, ya existente): `pedido_confirmado`, `pedido_en_camino`, `pedido_listo_para_recoger`, `pedido_entregado`,
`pedido_cancelado`, con `{{1}}` nombre, `{{2}}` sucursal y `{{3}}` total (ver `PLANTILLAS_ESTADO_PEDIDO`). Se declaran en `WHATSAPP_APPROVED_TEMPLATES`;
este PR no agrega pantalla para ellas.

## Huecos declarados

- La aprobacion en Meta Business Manager es un paso externo (credencial de Javier): el panel solo registra el estado que el dueno confirma.
  Marcar `aprobada` una plantilla que Meta no aprobo hace que el envio fracase con un 4xx de negocio (`dead`, nunca `sent` fingido).
- Hoteles: hoy no encola ningun aviso proactivo de WhatsApp al huesped (solo respuestas dentro de la conversacion y correo), asi que no hay productor que convertir.
  Restaurantes conserva sus plantillas por variable de entorno (el catalogo por organizacion tambien se consulta al despachar, pero no hay pantalla).
- Un recordatorio con plantilla pierde los botones Confirmar/Cancelar/Reagendar (la plantilla registrada no los define).
