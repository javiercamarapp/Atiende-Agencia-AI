# Runbook de operación de restaurantes

Qué vigilar y qué hacer cuando algo falla en el ciclo de restaurantes (WhatsApp, voz, checkout web, cocina, POS, correo). Complementa
`docs/runbooks/INCIDENTES.md` (severidades, quién decide, contención), `docs/ROLLBACK.md`, `docs/RESPALDO-Y-RESTAURACION.md` y `docs/CRONS.md`.

> Regla de oro: **nada de aquí lo ejecuta solo un agente**. Aplicar migraciones, rotar secretos, tocar Vercel o la base real lo decide y lo hace Javier.
> Nunca pegues teléfonos, nombres, direcciones, tokens ni cuerpos de mensajes en tickets, issues o PRs (el repo es público).

## 1. Qué corre solo (crons de `vercel.json`)

| Ruta | Cadencia | Qué hace | Si se detiene |
|---|---|---|---|
| `/internal/restaurantes/promover-programados` | cada 5 min | Promueve a `pending` los pedidos programados dentro de los 30 minutos previos; encola su comanda al POS y avisa al staff (bandeja y campana) | Un programado no entra a cocina hasta que alguien abre *Pedidos* (el panel también promueve al consultar) |
| `/internal/restaurantes/softrestaurant-dispatch` | cada 5 min | Drena el outbox de comandas al POS (503 sin adaptador real: no reclama nada) | Las comandas quedan `pendiente`; el gerente las captura a mano |
| `/internal/whatsapp/dispatch` | cada 5 min | Drena el outbox de WhatsApp (avisos de estado al cliente) | Los clientes no reciben avisos de estado |
| `/internal/restaurantes/email-dispatch` | cada 15 min | Drena el outbox de correo (confirmación de pedido) | No salen correos de confirmación |
| `/internal/restaurantes/privacidad-retencion` | diario 08:30 | Purga conversaciones y transcripciones vencidas por la política de retención | Se acumulan datos más allá de la retención configurada |

El cierre del día (`/internal/restaurantes/cierres-dia`) corre a diario desde `vercel.json` (08:20 UTC = 02:20 en Mérida) y recupera hasta 3 días sin corrida; el botón de
*Cierre del día* sigue generándolo a demanda. Estado y latido de cada cron: `/superadmin/salud/crons`. Cada cron se puede pausar con el interruptor de superadmin (responde 200
`skipped: kill_switch`).

## 2. Señales que hay que mirar

- **Campana del panel**: pedido nuevo del agente, cliente que pide una persona, llamada escalada, **pedido programado que entró a cocina**, costo de voz, cierre
  del día. El punto rojo se apaga al leer. Catálogo completo: `docs/NOTIFICACIONES.md`.
- **Bandeja del staff** (`order-notifications`): `order.created`, `order.problema`, `order.assigned_repartidor` y `order.programado_promovido`.
- **Indicadores de WhatsApp y de voz** (panel): volumen, errores, costo y latencia por día.
- `/superadmin/salud` y `/superadmin/salud/crons`: latido de los crons y estado de proveedores.
- Comandas del POS: **todavía no hay pantalla en el panel** (hueco conocido); se consultan por API (`GET /v1/restaurantes/:propertyId/admin/softrestaurant/comandas`, owner/admin): filas `pendiente`, `fallida` o en captura manual.

## 3. Incidentes

### Pedidos duplicados

- Congela los reintentos manuales y conserva los identificadores externos.
- El mismo envío no duplica: el pedido lleva una clave de idempotencia y una huella de deduplicación (`orders.idempotency_key`, `orders.dedupe_fingerprint`); el
  checkout web usa `storefront:<sesión>:<huella de la cotización>` y un doble clic devuelve el mismo rastreo.
- No borres filas: reconcilia con un procedimiento aprobado. Verifica que la misma intención produjo un solo pedido y una sola comanda (la comanda tiene llave
  `sr:<organización>:<pedido>`).

### WhatsApp atrasado o fallando

- Revisa el outbox: filas `pending`/`failed` viejas, `processing` con lease vencido y `dead`.
- `dead` con código **131047** = el aviso salió fuera de la ventana de 24 horas y no hay plantilla aprobada: aprueba la plantilla y decláralo en
  `WHATSAPP_APPROVED_TEMPLATES` (`docs/PLANTILLAS-WHATSAPP.md`).
- Token de acceso vencido o sin permisos: rótalo (`docs/runbooks/ROTACION-DE-LLAVES.md`). Un `processed` no se reabre; un `failed` es reclamable.
- Meta no ofrece una clave de idempotencia equivalente a la de Resend: una caída entre el 2xx del proveedor y el acuse local puede duplicar un aviso; reconcilia por
  el id del mensaje.

### El agente no responde o responde "problema técnico"

- Revisa el estado del proveedor de modelos (OpenRouter) y el interruptor global `llm` de superadmin. Con el modelo caído el agente contesta un texto fijo de
  disculpa (nunca promete un pedido que no existe) y el turno puede reintentarse.
- Si el cliente quedó a medias, el pedido **no existe** hasta que `crear_pedido` responde con éxito; en caso de duda consulta *Pedidos* antes de volver a tomarlo.
- Si hay un humano atendiendo (handoff abierto), el agente calla a propósito.

### Pedido programado que no entró a cocina

- Mira el latido de `promover-programados`. Mientras tanto, abrir *Pedidos* promueve los programados que ya cumplieron su anticipación.
- La promoción es idempotente (solo toca filas en `programado`; uno cancelado nunca se promueve). Al promover se encola la comanda y se avisa al staff
  (bandeja y campana, un solo aviso por pedido). Los avisos son best-effort: un fallo al avisar no revierte la promoción y se registra en el log
  (`restaurantes_programados_aviso_*`); el pedido ya está en cocina y visible en *Pedidos* aunque el aviso falle.
- Base sin la migración 034: la lista de programados responde "no disponible todavía"; no se pierde ningún pedido.

### POS (SoftRestaurant) caído o sin códigos

- El pedido existe siempre; la comanda queda `pendiente_de_confirmar`/`fallida`. El gerente la consulta por API (no hay pantalla todavía) y la captura a mano en el POS;
  la marca como capturada con `POST .../admin/softrestaurant/comandas/:id/capturada` (queda en el log del servidor). Al volver el POS, el despachador no reenvía lo capturado a mano.
- Si el pedido se **cancela** mientras su comanda sigue `pendiente`/`fallida`, el servidor la corta (`capturada_manual`, nota "Pedido cancelado antes de llegar al POS") y el
  despachador ya no la manda al volver el POS. Si la comanda ya estaba en el POS (`confirmada`), cancélala también en el POS: Atiende no puede retirarla.
- Un producto o sucursal sin código del POS **no se inventa**: la comanda va a captura manual y el motivo no incluye datos personales.
- Modo de la integración por organización: `apagado`, `sombra` o `activo`.

### Checkout web o aviso de privacidad

- El checkout exige aceptar el aviso de privacidad **en el servidor** (400 `aviso_privacidad_requerido`); la evidencia (versión del aviso, fecha, canal `web`) se
  guarda por pedido y la ven owner y admin. Si la base no tiene la migración 063 el pedido se crea igual y no se guarda la evidencia (declarado como hueco hasta aplicarla).
- Derechos ARCO: el cliente escribe "mis datos personales"; el panel *Privacidad* lleva la solicitud con sus plazos.

### Voz

Ver `docs/VOZ-PM.md` (llamada de prueba, métricas, rollback, huecos): el worker de telefonía y las credenciales siguen pendientes.

## 4. Antes y después de un despliegue

1. Mergear a `main` despliega el código al instante; **las migraciones no se aplican solas**. Todo el código nuevo está escrito para convivir con la base sin migrar
   (estados "no disponible aun", nunca un 500), pero una función nueva no funciona hasta aplicar su migración. El orden de cada PR está en su descripción.
2. Aplica las migraciones pendientes en orden y verifica con `scripts/verify-restaurantes-*` contra un Postgres efímero (nunca la base real).
3. Verifica el CI de `main` tras cada merge (los PR verdes por separado pueden romper `main` juntos).
4. Para volver atrás: `docs/ROLLBACK.md`.

## 5. Secretos y rotación

Frontend solo con valores públicos. Secretos del servidor en Vercel. Rota de inmediato ante exposición: invalida primero, reemplaza después y verifica con una
solicitud sintética sin efecto (`docs/runbooks/ROTACION-DE-LLAVES.md`). Caducidades a vigilar: token de Meta, llaves de Resend y OpenRouter, secreto de las
herramientas de voz.
