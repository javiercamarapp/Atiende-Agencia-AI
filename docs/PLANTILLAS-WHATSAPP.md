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
| Base sin la migracion 0050 | Comportamiento anterior (texto libre). |

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

Restaurantes, autopiloto del ciclo del pedido (`PLANTILLAS_AUTOPILOTO`, `packages/domain-restaurantes/src/autopiloto/servicio.ts`): todas con `{{1}}` nombre del
cliente, `{{2}}` sucursal y `{{3}}` detalle. `pedido_aprobado` (detalle = total), `pedido_no_confirmado` (rechazo de un pedido grande), `cancelacion_no_posible`
(el pedido ya esta en proceso), `compensacion_sin_costo_extra`, `compensacion_reposicion`, `compensacion_descuento` (detalle = codigo de un solo uso) y
`pedido_recibido` (detalle = folio y tiempo estimado; confirmacion inmediata de voz y web). Sin la plantilla declarada el aviso solo sale dentro de la ventana
de 24 h; `pedido_recibido` es la excepcion: sin plantilla aprobada NO se envia (estado `plantilla_no_aprobada`, visible en "Reglas del autopiloto").

## Huecos declarados

- La aprobacion en Meta Business Manager es un paso externo (credencial de Javier): el panel solo registra el estado que el dueno confirma.
  Marcar `aprobada` una plantilla que Meta no aprobo hace que el envio fracase con un 4xx de negocio (`dead`, nunca `sent` fingido).
- Hoteles: hoy no encola ningun aviso proactivo de WhatsApp al huesped (solo respuestas dentro de la conversacion y correo), asi que no hay productor que convertir.
  Restaurantes conserva sus plantillas por variable de entorno (el catalogo por organizacion tambien se consulta al despachar, pero no hay pantalla).
- Un recordatorio con plantilla pierde los botones Confirmar/Cancelar/Reagendar (la plantilla registrada no los define).

## Estados de entrega (restaurantes)

Meta acepta un envio con 200 y un `wamid`, pero muchos fallos llegan DESPUES por el webhook como `entry[].changes[].value.statuses[]`. Restaurantes los
procesa en `POST /v1/restaurantes/whatsapp/webhook` (migracion `066_whatsapp_estados_entrega.sql`):

- **Al enviar**: el despachador guarda el `wamid` y como salio el mensaje (texto, plantilla, botones o ubicacion) en `restaurantes.messaging_outbox`
  (`provider_message_id`, `enviado_como`), con indice unico parcial por organizacion y wamid. Citas, hoteles y licitaciones siguen sin guardarlo (huecos
  declarados: su puerto ignora el wamid).
- **Al recibir un status**: la organizacion sale del `phone_number_id` firmado y la funcion de solo-sistema `restaurantes.registrar_estado_entrega_whatsapp`
  avanza el estado por wamid: `sent` -> `delivered` -> `read`, nunca hacia atras, `failed` gana y conserva su PRIMER error, y repetir un status no cambia
  nada (Meta reintenta). Un webhook que solo trae statuses responde 200 sin tocar el ledger de mensajes entrantes ni el turno del agente.
- **`failed`**: guarda el codigo y el titulo de Meta (nunca el telefono ni el texto) y un motivo:

  | Codigo de Meta | Motivo guardado |
  | --- | --- |
  | 131047 (mas de 24 h desde el ultimo mensaje del cliente) | `fuera_de_ventana`; si el mensaje salio como texto libre pero el payload traia una plantilla, `fuera_de_ventana_plantilla_sin_usar` (la plantilla no estaba declarada aprobada) |
  | 131026 (numero no entregable) | `numero_no_entregable` |
  | 132000-132999 (plantilla pausada, inexistente o con parametros mal) | `plantilla` |
  | 131049 (limite de marketing) | `limite_marketing` |
  | cualquier otro | `otro` |

  Emite la notificacion in-app `restaurantes.whatsapp.entrega_fallida_pedido` (aviso de estado de pedido, enlace a Pedidos) o
  `restaurantes.whatsapp.entrega_fallida` (otro mensaje, enlace a Conversaciones), con dedupe por mensaje y sin PII. Con mas de 5 entregas fallidas en la
  ultima hora de la misma organizacion emite UN aviso agrupado por hora (`restaurantes.whatsapp.entregas_fallidas_varias`, enlace a Agente de WhatsApp).
  Si era el aviso de estado de un pedido y el cliente dejo correo al hacerlo, encola el respaldo por correo (`order.status.whatsapp_fallido.email`,
  una vez por pedido y estado). **No reintenta** el WhatsApp fallido: 131047 y 131026 son errores de negocio, solo se avisa.
- **KPI**: `GET /v1/restaurantes/:propertyId/admin/whatsapp/kpi` trae el bloque `entrega` (enviados, entregados, leidos, fallidos, sin confirmacion y fallos
  por motivo, por dia local de la sucursal del pedido) y la pantalla Agente de WhatsApp lo muestra. Tasa de entrega = entregados / enviados; tasa de
  lectura = leidos / entregados (quien desactivo la confirmacion de lectura nunca cuenta como leido). Solo conteos.
- **Retencion**: el estado de entrega no vive mas que el payload. Cuando la purga de privacidad reemplaza el payload de una fila (180 dias por defecto), el
  mismo UPDATE borra su wamid y su estado de entrega (trigger de la 066); pasada la retencion ese aviso deja de contar en el KPI.

Huecos conocidos: (1) un status que llega ANTES de que el despachador confirme el envio (el commit del cierre del mensaje) no encuentra el wamid y se
ignora con 200 (queda como `desconocido`); la ventana es de milisegundos pero existe. (2) Sin la migracion 066 el wamid no se guarda y los statuses se
ignoran con 200. (3) El respaldo por correo solo cubre avisos de estado de pedido de clientes con correo (hoy solo el canal web lo captura).

