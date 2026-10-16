# System prompt del agente de restaurantes (WhatsApp y voz)

El prompt **no es un archivo que se pega a mano en un proveedor**: lo genera el código en cada turno (WhatsApp) o se guarda como comportamiento de la
sucursal (voz). Este documento explica qué contiene, de dónde sale y qué parte la hace cumplir el servidor aunque el modelo se equivoque.

- **Código**: `packages/domain-restaurantes/src/whatsapp/perfil-pm.ts` (`buildPmSystemPrompt`, perfil `taqueria_pm`). Nació del prompt de producción del repo
  suelto, adaptado al registro único de tools (`packages/domain-restaurantes/src/agent-tools/registry.ts`): no se duplica ni se renombra ninguna herramienta.
- **Dónde se carga**: el seed de la demo (`packages/domain-restaurantes/src/seed/pm-demo.ts`) lo deja configurado para la organización de demostración;
  en una organización real lo resuelve `resolveAgentConfig` con la configuración del panel *Agente de WhatsApp* (`pages/AgenteWhatsappSeccion.tsx`).
- **Modelo**: el que defina la tabla por rol del gateway (`docs/LLM-GATEWAY.md`) vía OpenRouter; `OPENROUTER_API_KEY` es la única llave obligatoria.

## Estructura (WhatsApp)

El prompt se arma con nueve bloques, en este orden: `ROL` (canal, fecha y hora local, sucursal de este chat y sucursales reales), `VOZ Y TRATO` (español de
México, siempre de usted), `REGLAS DURAS` (H1 a H18), `FLUJO DE TOMA DE PEDIDO` (16 pasos), `ESCALACIÓN A HUMANO`, `SEGURIDAD`, `DATOS DEL NEGOCIO`,
`EJEMPLOS BREVES` y `CONTEXTO DEL CLIENTE` (sin la dirección completa guardada).

Reglas duras que el prompt enuncia (resumen; el texto completo está en el código):

| Regla | Qué dice |
|---|---|
| H1 | Domicilio con mínimo de $200 y sin costo de envío; recoger sin mínimo |
| H2 | Nada de alcohol a domicilio (nunca se manda `adult_confirmed`); para recoger se compra en la sucursal |
| H3, H13 | Promociones solo para recoger; nunca calcula descuentos, dice el total que devuelve `cotizar_pedido` |
| H4 | Ajustes por resta (sin cebolla, poco queso...) van en `notes`; sustituir o cambiar receta no se hace |
| H5, H10 | La zona la deciden las herramientas; fuera de zona se ofrece recoger y no se cambia la sucursal |
| H6, H14 | Nunca inventa productos, precios, horarios, tiempos, folios ni "ya está en cocina" |
| H7 | Nunca pide ni repite datos de tarjeta |
| H8 | Quejas, reposiciones, cancelaciones de un pedido confirmado, transferencia, tiempos fuera de lo normal y alergias se escalan con `escalar_a_humano` |
| H9, H12 | Nunca registra sin repetir el pedido y recibir un sí; `crear_pedido` una sola vez por pedido |
| H16 | Solo toma pedidos dentro del horario para tomar pedidos de la sucursal |
| H17, H18 | Pedido de otra sucursal: se da el teléfono de la que le toca; el cliente no elige repartidor |

## Qué hace cumplir el servidor aunque el prompt falle

El prompt es la primera línea, nunca la única. Las herramientas del registro validan en el servidor, para WhatsApp, voz y checkout web por igual: mínimo a
domicilio, alcohol, zona, horario (incluido el horario en la hora **elegida** de un pedido programado), múltiplos de "orden de N", propina solo con tarjeta
y la máquina de estados **cotizar -> confirmar -> crear** (`agent-tools/order-flow.ts`): `crear_pedido` exige una cotización vigente (20 minutos) y un
`confirmar_resumen` posterior, en un mensaje **distinto** del cliente; el pedido creado debe ser el mismo que se cotizó.

### Pedidos programados por el agente (R-11)

`cotizar_pedido` y `crear_pedido` aceptan `programado_para` (ISO 8601 **con zona**, por ejemplo `2026-10-03T14:00:00-06:00`). Reglas, las mismas del checkout
público: al menos 30 minutos de anticipación y máximo 7 días; la sucursal debe estar abierta a esa hora, evaluada en **su** zona horaria (un pedido para la
01:00 del sábado con turno de viernes cruza la medianoche y es válido). La hora entra a la huella de lo cotizado: el agente **no puede** agregar una hora
programada, ni cambiarla, después de que el cliente confirmó; tiene que volver a cotizar y a pedir confirmación. Base sin la migración 034: el agente recibe
un mensaje de negocio (no un error interno) y nunca se crea un pedido inmediato en su lugar. El pedido queda en estado `programado` y se promueve a cocina
30 minutos antes (cron `promover-programados`); al promoverlo el staff recibe el aviso (ver `runbook-operacion.md`).

## Qué se puede editar sin tocar código

Desde el panel del agente (`agent-config-editor.ts`): saludo propio del negocio, salsas incluidas, promociones para recoger, motivos de escalación que se
apagan, umbral de "pedido grande" y los tiempos de entrega. Sin personalizar, el prompt resultante es idéntico al de siempre.

## Versión de voz

`buildPmVozPrompt` genera la versión compacta (mismas reglas H1 a H18, mismo orden de flujo, mismos motivos de escalación) para que, junto con `APENDICE_VOZ`,
quepa en el tope de 8,000 caracteres de `branch_voice_config.comportamiento` (migración 025). Una prueba ata ambas versiones. Detalle de la voz en
`docs/VOZ-PM.md`.

## Cómo probar un cambio de prompt

1. `npx vitest run packages/domain-restaurantes/tests --maxWorkers=2` (incluye las pruebas del perfil y del registro de tools).
2. Evals del agente: `packages/domain-restaurantes/src/evals/agente-pm/` (casos y escenarios de T7 sacados de chats reales anonimizados; los chats reales nunca
   se suben al repo).
3. Ensayo en el widget de la demo (`docs/demo-pm/guion.md`), sin Meta.
