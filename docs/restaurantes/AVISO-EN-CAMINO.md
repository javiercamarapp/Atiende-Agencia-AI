# Aviso «su pedido va en camino» por WhatsApp

Decisión del dueño (Los Taquitos de PM, 9-nov-2026): cuando un pedido **a domicilio** pasa a **en camino** (salió con el repartidor), se avisa al
cliente por WhatsApp **una sola vez por pedido**, también si el pedido se hizo por **llamada** (agente de voz) o en el **panel**. Solo ese estado:
«preparando», «entregado» y «cancelado» siguen con el aviso de siempre.

Código: `packages/domain-restaurantes/src/aviso-en-camino.ts` (lo llama `notifyCustomerOnOrderStatusChangeCore`, el único punto por el que pasan el
panel, el chofer y el autopiloto). Base: `packages/domain-restaurantes/migrations/107_aviso_en_camino.sql`.

## Cómo decide

| Situación | Qué pasa | Estado que queda en el pedido (`orders.aviso_en_camino`) |
| --- | --- | --- |
| El cliente escribió por WhatsApp a la organización hace menos de 23 h (ventana de 24 h con 1 h de margen) | Texto libre: «Hola Ana, su pedido #1234 de Francisco de Montejo va en camino. Tiempo estimado de llegada: 40 a 50 minutos.» | `texto` |
| Fuera de la ventana (siempre en pedidos por llamada) y la organización tiene la plantilla **aprobada** | Solo la plantilla (nunca se degrada a texto, Meta lo rechazaría) | `plantilla` |
| Fuera de la ventana y **sin** plantilla aprobada | No se envía nada. El dueño recibe **una** notificación in-app por organización: «El aviso «su pedido va en camino» no se está enviando: falta la plantilla de WhatsApp» | `omitido_falta_plantilla` |
| El dueño apagó el aviso | No se envía | `omitido_desactivado` |
| El cliente se dio de baja (BAJA/STOP o un «no» registrado, migración 091) | No se envía | `omitido_baja` |
| Pedido capturado por el personal (llamada o mostrador) sin consentimiento registrado | No se envía (hay que avisarle por llamada) | `omitido_sin_consentimiento` |
| Pedido para recoger, sucursal solo venta local (Galerías), sin teléfono o sin WhatsApp conectado | No aplica | sin marca |

- **Una sola vez**: el outbox deduplica por pedido (`order-status:<pedido>:en_camino`) y un pedido con `texto`/`plantilla` no se vuelve a avisar aunque
  regrese a en camino. Un «omitido» sí se reintenta en la siguiente salida (por ejemplo, cuando ya hay plantilla).
- **Tiempo estimado**: es el «tiempo de entrega» que la sucursal tiene en Ajustes del agente (PM: «40 a 50 minutos»). Si no hay dato, la variable va
  como «unos minutos» (Meta rechaza variables vacías).
- **Número que envía**: el de la sucursal del pedido (o el de la organización); el despachador usa el token de la app dueña de ese número
  (credenciales por organización, `docs/WHATSAPP-CREDENCIALES-POR-ORGANIZACION.md`).
- **Base sin la migración 107**: se conserva el aviso anterior (texto + plantilla `pedido_en_camino` declarada en el payload; el gateway decide con
  `WHATSAPP_APPROVED_TEMPLATES`).

## Plantilla para dar de alta en el Administrador de WhatsApp

Business Manager de Meta → Administrador de WhatsApp → Plantillas de mensajes → Crear plantilla.

- **Categoría**: Utilidad (utility)
- **Nombre**: `pedido_en_camino`
- **Idioma**: Español (México) — `es_MX`
- **Encabezado, pie y botones**: ninguno
- **Cuerpo** (texto exacto):

```
Su pedido #{{2}} de {{1}} ya va en camino. Tiempo estimado de llegada: {{3}}. Si tiene alguna duda, responda a este mensaje.
```

- **Ejemplos de las variables** (Meta los pide para revisar): `{{1}}` = `Francisco de Montejo`, `{{2}}` = `1234`, `{{3}}` = `40 a 50 minutos`.

Las variables significan: `{{1}}` nombre de la sucursal, `{{2}}` número corto del pedido, `{{3}}` tiempo estimado. El texto no lleva promociones
(si Meta la reclasifica como marketing, cuesta más y se puede bloquear: no agregar ofertas).

### Registrarla como aprobada en la plataforma

Restaurantes no tiene pantalla de plantillas. Cuando Meta la apruebe, regístrala en el catálogo de la organización (SQL Editor, con el visto bueno
del dueño). El orden de `variables` debe coincidir con `{{1}}`, `{{2}}`, `{{3}}`:

```sql
insert into core.whatsapp_plantilla (organization_id, vertical, evento, nombre, idioma, variables, estado)
values ('<id de la organizacion>', 'restaurantes', 'order.en_camino', 'pedido_en_camino', 'es_MX', '{sucursal,folio,tiempo}', 'aprobada')
on conflict (organization_id, vertical, evento) do update set nombre = excluded.nombre, idioma = excluded.idioma, variables = excluded.variables, estado = excluded.estado;
```

Variables disponibles (en cualquier orden): `sucursal`, `folio`, `tiempo`, `nombre`, `total`. Una plantilla que pida otra variable se trata como
faltante (no se envía y se avisa al dueño). Marcar `aprobada` una plantilla que Meta no aprobó hace que el envío falle con un error de Meta
(`dead`, con la notificación de entrega fallida), nunca un «enviado» fingido.

## Encender o apagar

Encendido por omisión. Solo owner/admin con acceso a toda la organización:

- `GET /v1/restaurantes/:propertyId/admin/whatsapp/aviso-en-camino` → `{ disponible, activo, plantilla }`
- `PUT /v1/restaurantes/:propertyId/admin/whatsapp/aviso-en-camino` con `{ "activo": false }` (queda en la bitácora con antes y después)

No hay pantalla nueva: hoy lo cambia soporte con la API.

## Costo aproximado por aviso

- **Dentro de la ventana** (el cliente escribió en las últimas 24 h): es un mensaje de servicio. Según `docs/VOZ-ACTIVACION.md`, desde el
  1-oct-2026 Meta cobra los mensajes de servicio en México a partir del mensaje 1,001 de cada número al mes (≈ US$0.0085 cada uno); los primeros mil son gratis.
- **Fuera de la ventana** (plantilla utility): Meta cobra por plantilla entregada; la tarifa de referencia de utilidad para México es de
  **≈ US$0.0085 por aviso (≈ MX$0.16)**. Ejemplo: 60 pedidos a domicilio por llamada al día ≈ 1,800 avisos al mes ≈ US$15 al mes.
- Meta cambia sus tarifas por país y trimestre: confirma la cifra en la tabla de precios vigente de WhatsApp Business antes de presupuestar. El aviso
  no usa el modelo de lenguaje (no hay costo de LLM).

## Huecos conocidos

- La ventana se calcula por organización (mensajes entrantes de ese teléfono a cualquier número de la organización); Meta la cuenta por par
  número-cliente. Si el cliente escribió a otra sucursal y el pedido sale del número de una sucursal distinta, el texto libre podría rechazarse con
  131047: el webhook lo reporta y se emite `restaurantes.whatsapp.entrega_fallida_pedido`.
- La aprobación en Meta y el registro en el catálogo son pasos externos (sin pantalla en restaurantes).
- Sin pantalla para el interruptor: solo API.
