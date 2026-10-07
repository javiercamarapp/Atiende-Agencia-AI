# Guion de demo: Los Taquitos de PM en T7 García Lavín

Guion para **presentar a Los Taquitos de PM** el producto funcionando **sin credenciales de Meta, Twilio ni SoftRestaurant**. El
agente de WhatsApp **real** (perfil `taqueria_pm`) conversa en una página web, toma pedidos reales contra el menú real de **T7 García Lavín
(Victory Platz)**, la comanda cae en el panel y el panel trae **8 semanas de operación de demostración con el ritmo real de T7**.

- **Fase 1 = T7** (decisión de Javier, 2-oct-2026). Los 10 escenarios salen de los **71 escenarios de eval** que se sacaron de 104 chats reales
  anonimizados de esa sucursal (`packages/domain-restaurantes/src/evals/agente-pm/escenarios-t7.json`); cada uno cita su id.
- Duración: **~35 minutos** (cada escenario trae su tiempo). Cargar la demo en la base: `docs/demo-pm/runbook.md` (un comando).
- Lo que **no** hace la demo está al final («Qué NO se muestra»): dígalo tal cual si preguntan.

## Cómo leer cada escenario

- **Se escribe**: el texto exacto para el chat (una línea; el cuadro del chat no admite saltos).
- **[Servidor]**: lo garantiza el servidor con reglas duras y pruebas; no depende del modelo.
- **[Agente]**: lo decide el modelo guiado por su prompt; la **redacción puede variar**. Si se desvía, la frase de rescate está en la fila.
- Los importes salen del motor de pedidos sobre el catálogo sembrado de T7 (lista T1-2026) y una prueba (`demo-pm-guion.spec.ts`) los compara con el motor:
  si cambia un precio o el guion cita otra cifra, la prueba falla.

## Orden de las conversaciones (dos pestañas)

El chat guarda la conversación solo en la pestaña abierta: **«Nueva conversación» la borra** y el teléfono ficticio del cliente cambia con ella. Por eso se usan **dos pestañas** del chat de la demo:

- **Pestaña A**: se abre para el escenario 1 y **no se pulsa «Nueva conversación» en ella**. Se reutiliza en los escenarios 7, 8 y 10 (necesitan el pedido del 1).
- **Pestaña B**: para los escenarios 2 a 6 y el 9; en ella sí se pulsa **«Nueva conversación»** al empezar cada uno.

Pestaña A no se cierra ni se recarga hasta terminar el escenario 10. El orden de presentación es el numerado; solo se cambia de pestaña.

## Qué es la demo (una frase por pieza)

| Pieza | Qué es de verdad |
| --- | --- |
| Chat `/demo/los-taquitos-de-pm-demo` | El **mismo agente** que atiende el WhatsApp (mismo `turnHandler`, mismas herramientas contra el menú real, misma máquina cotizar → confirmar → crear, mismo presupuesto y *kill switch* del gateway de LLM). Abre **en T7 García Lavín**. Solo cambia el transporte: la respuesta vuelve a la página y **nunca se manda a Meta**. |
| Pedidos del chat | Pedidos reales del motor: precios de T7, mínimo de $200 a domicilio, alcohol solo al recoger, propina solo con tarjeta, horario de la sucursal. Aparecen en **Pedidos** y en el ticket de cocina. |
| Escalaciones | Reales: abren una toma en **Conversaciones** y un contacto en la bandeja. |
| Datos del panel | **139 pedidos en 56 días, solo T7**, creados con el mismo motor de pedidos: 70 clientes de los que 32 son recurrentes y suman **73 %** de los pedidos, 79 % a domicilio, todo por WhatsApp, ticket mediano ≈ **$643**, entregas de **50 a 90 min** (mediana 65) y de 10 a 50 min para recoger, picos de 12 a 16 h y de 19 a 22 h con más peso en sábado y domingo. Son las cifras medidas en los chats reales de T7; los clientes, teléfonos (`0001xxxxxx`) y direcciones son **ficticios**. |
| Voz | **Deshabilitada** a propósito (sin gasto de proveedores). Los saludos y el comportamiento quedan cargados; los KPIs de voz salen en cero. |

## Antes de empezar (30 minutos antes)

1. **Base cargada y verificada**: `npm run demo:pm -- --apply …` (runbook) y luego `npm run demo:verificar -- --api-url=https://<api>`: debe terminar con
   «Demo LISTA en la base» y la línea del widget en **OK**. Si dice **«NO disponible: requiere OPENROUTER_API_KEY»**, falta la llave del proveedor LLM en
   el servidor: **no hay respuestas simuladas**, sin llave no hay chat.
2. **Hora**: T7 toma pedidos de **12:00 a 01:00 (hora de Mérida)**. Fuera de ese horario el agente dice que está cerrada (eso es correcto, pero no sirve para
   mostrar pedidos).
3. **Sesión del dueño** en el panel (`/restaurantes/los-taquitos-de-pm-demo`) con un usuario *owner* (el seed no crea usuarios: se enlaza uno existente con
   `--owner-email`). Pestañas listas: Panel, Pedidos, Conversaciones, Clientes, Auditoría, Primeros pasos.
4. **Limpie ensayos del chat**: `npm run demo:pm` ya borra las sesiones del widget; para repetirlo sin recargar todo:
   `npm run demo:limpiar -- --modo=sesiones_widget --apply --confirm-host=<host>`.
5. **Dos pestañas**: el chat a un lado y **Pedidos** al otro (el panel consulta pedidos nuevos solo, cada ~20 segundos).
6. Nada de esta demo manda mensajes a ningún teléfono.

## Apertura: el panel con datos reales de ritmo (0:00 a 3:00)

- **Se dice**: «Esto es el panel de T7 con ocho semanas de operación de demostración: el ritmo es el real de su WhatsApp, los clientes son ficticios.»
- **Se hace**: abra **Panel (KPIs)** y cambie el periodo (7 / 30 / 90 días); abra **Clientes** y ordene por pedidos; abra **Pedidos → Historial** y un pedido con fracción de kilo.
- **Se ve**: solo la sucursal **T7**; ≈ 139 pedidos en el periodo de 90 días, el 73 % de ellos de clientes recurrentes; en **Clientes**, un cliente con 11
  pedidos y la ficha con «lo de siempre»; en un pedido, renglones como «Bistec de Res — 250 g» o «Extra Salsa».
- **Nota honesta**: las cifras reproducen lo medido en T7, pero cada pedido es sintético. Los KPIs de voz salen en cero (voz apagada).

## Escenario 1: cliente recurrente que pega su mensaje guardado (3:00 a 8:00)

*Origen: T7-020 («mensaje guardado», 12 clientes y ~35 sesiones en la muestra) y T7-015 (recurrente con mensaje corto).*

- **Se dice**: «El 73 % de sus pedidos son de recurrentes y casi todos pegan siempre el mismo mensaje. El agente lo toma completo, sin bienvenida larga.»
- **Se hace**: abra el chat de la demo en la **pestaña A** (la que se conserva hasta el escenario 10).
- **Se escribe**:
  1. `Hola!!! Buenas noches. Un pedido a domicilio porfi. 9990000001 Ana Prueba, Privada Los Almendros casa 13, Vergel. Orden: 2 orden de tacos de bistec tortilla de maíz. 1 guacamole. Pago con tarjeta`
  2. (cuando pida el pin) `[Ubicación compartida por WhatsApp] lat=21.021100 lng=-89.614100`
  3. `No, es todo` y, después de la lista, `Sí, es correcto`
- **Se ve [Agente]**: sin saludo ni bienvenida larga; **no vuelve a preguntar** nombre, dirección, platillos ni pago; la colonia no está en el mapa de colonias (sigue pendiente del dueño), así que **pide el pin una sola vez**;
  con el pin asigna **T7** por kilómetros; pregunta «¿algo más?» una sola vez; repite el pedido **en lista**; pregunta si desea dejar propina **solo porque paga con tarjeta**; promete **60 a 75 minutos** (en hora pico, sábado y domingo de 13 a 16 y de 18 a 22 h, promete 75 a 90).
- **Se ve [Servidor]**: total exacto **$530** (6 tacos de bistec = 2 órdenes × $194 + guacamole $142, sin costo de envío); al confirmar, bajo la burbuja: «Pedido registrado por $530.00»; en **Pedidos** el pedido nuevo (canal WhatsApp, `pending`) y su ticket.
- **Se escribe después** (misma conversación): `Quiero lo mismo que la vez pasada`
- **Se ve [Agente]**: reconoce al cliente por su historial (el sistema ya tiene su pedido) y le ofrece **lo mismo** con **precios de hoy**: vuelve a cotizar **$530**. *Rescate si no lo ofrece: «Mándeme lo mismo de la última vez: 2 órdenes de tacos de bistec y un guacamole».*
- **Se escribe para cerrar** (misma conversación): `No, gracias, era para saber`. Así no queda un carrito abierto: el escenario 7 parte de un pedido ya registrado, sin una cotización pendiente que el agente pudiera ampliar.

## Escenario 2: «todas las salsas» y la salsa extra con costo (8:00 a 11:30)

*Origen: T7-035 (la queja más repetida: faltaron salsas), T7-022 (extra de ajo) y T7-001.*

- **Se dice**: «“Todas las salsas” para el cliente son todas; para la cocina son cuatro. Aquí el agente lo aclara antes de cotizar y no cobra lo que va incluido.»
- **Se hace**: cambie a la **pestaña B** y pulse **Nueva conversación**; elija a **T7** si no está.
- **Se escribe**: `Quiero pasar a recoger una orden de nachos de pastor con todas las salsas, pago en efectivo` → (aclaración) `Sí, también ajo, guacamolera, mexicana y habanero` → `Y una extra de ajo`
- **Se ve [Agente]**: aclara que **roja, verde, cebolla con cilantro y limones** van siempre y pregunta si le agrega crema de ajo, guacamolera, mexicana y habanero (**sin costo**, solo si las pide); la **extra de ajo** la manda como doble porción, **no como producto**.
- **Se ve [Servidor]**: total **$347** (nachos de pastor $328 + extra salsa $19); no cobra ninguna salsa incluida; pregunta la hora de recogida y **no** pregunta propina (efectivo).

## Escenario 3: cuarto y medio kilo (11:30 a 14:00)

*Origen: T7-001 y T7-061: las fracciones de kilo son de lo que más se pide; la regla vieja «solo el kilo completo» era falsa.*

- **Se dice**: «Se venden 1/4, 1/2, 3/4, 1.5 y 2 kilos al precio proporcional, con centavos. El agente no hace cuentas: el precio sale del menú.»
- **Se hace**: **pestaña B**, **Nueva conversación**.
- **Se escribe**: `Me puedes mandar 1/4 de bistec y medio kilo de pastor para recoger, tortilla de maíz, todas las salsas, ajo y guacamole` → `Efectivo`
- **Se ve [Servidor]**: renglones «Bistec de Res — 250 g» ($275) y «Pastor — 500 g» ($450); total **$725**; sin pregunta de propina.
- **Se ve [Agente]**: «ajo y guacamole» los toma como **salsas a petición** (sin costo), no como producto; repite el pedido en lista antes de crear nada.

## Escenario 4: «4 tacos de bistec» (14:00 a 16:00)

*Origen: T7-029: el bistec solo se vende en órdenes de 3; el personal no vende sueltos.*

- **Se hace**: **pestaña B**, **Nueva conversación**.
- **Se escribe**: `Hola, para recoger 4 tacos de bistec, tortilla de maíz` → `Sí, una orden`
- **Se ve [Servidor]**: la herramienta rechaza el múltiplo («solo se vende en órdenes de 3 piezas. Pediste 4; puedes pedir 3 o 6»); el agente **nunca convierte piezas en órdenes por su cuenta**.
- **Se ve [Agente]**: lo explica con calidez y propone **una orden (3 tacos) por $194** o dos órdenes (6 tacos, $388); repite el resumen para confirmar.

## Escenario 5: fuera de zona, la sucursal que le toca (16:00 a 19:00)

*Origen: T7-050 (la zona de T1 con pregunta de precio y tiempo) y T7-049.*

- **Se dice**: «Hoy el cliente de otra zona se queda sin respuesta o recibe una negativa seca. El agente asigna por kilómetros, da el teléfono de la sucursal que le toca y aun así contesta lo que preguntó.»
- **Se hace**: **pestaña B**, **Nueva conversación** en T7.
- **Se escribe**: `Buenas noches, quisiera 4 tacos de pastor a domicilio, efectivo. Mi ubicación: [Ubicación compartida por WhatsApp] lat=21.028200 lng=-89.609800 ¿Cuánto sería y en cuánto tiempo?`
- **Se ve [Servidor]**: la herramienta de zona asigna **Prolongación Montejo** (T1) a ese pin y **no T7**.
- **Se ve [Agente]**: **no toma el pedido para T7**; da el **teléfono de Prolongación Montejo (999 944 0342)** con calidez; **contesta lo que preguntó** (4 tacos de pastor = **$168**) y **ofrece recoger en T7**. Sin mayúsculas ni «por políticas de la empresa».
- **Nota honesta**: el **mapa de colonias** (qué colonias reparte cada sucursal) sigue pendiente del dueño; por eso el agente pide el pin y asigna por kilómetros. La regla de horario entre sucursales (T7-007/T7-010) está en decisión pendiente y no se muestra.

## Escenario 6: pedido a domicilio por debajo del mínimo (19:00 a 21:00)

*Origen: T7-064 y T7-041: un cliente pidió una sola orden de frijol y el personal no explicó el mínimo.*

- **Se hace**: **pestaña B**, **Nueva conversación**.
- **Se escribe**: `Hola, una orden de frijoles con tostadas a domicilio, pago en efectivo` (después de dar nombre y pin) 
- **Se ve [Servidor]**: «El pedido mínimo a domicilio en García Lavín (Victory Platz) es de $200. El pedido suma $93; faltan $107»; **no se crea ningún pedido**.
- **Se ve [Agente]**: invita a **agregar algo** o a **pasar a recoger** (para recoger no hay mínimo).

## Escenario 7: cambio después de confirmar (21:00 a 24:00)

*Origen: T7-019 y T7-043: el pedido sale de cocina en 10 a 25 minutos y a dos clientes ya no les alcanzó el agregado.*

- **Se dice**: «Hoy agregar algo después de confirmar se pierde. Aquí el agente avisa a la sucursal **de inmediato**.»
- **Se hace**: vuelva a la **pestaña A** (la conversación del escenario 1, con su pedido ya registrado).
- **Se escribe**: `Disculpe, ¿le pudiera agregar un guacamole a mi pedido?`
- **Se ve [Agente]**: **no crea otro pedido ni promete**; dice «Lo paso a cocina; si el pedido ya salió, se lo pueden enviar aparte».
- **Se ve [Servidor]**: la escalación abre una toma pendiente con motivo `cancelacion_modificacion` y la nota de qué cambió. **Panel → Conversaciones**: aparece como **pendiente**; pulse **Tomar conversación** y el agente **calla** (escriba otro mensaje en el chat y verá «Una persona del equipo tiene tomada esta conversación»); agregue una nota interna y **Marcar como resuelta**.

## Escenario 8: queja por un faltante (24:00 a 27:00)

*Origen: T7-021 y T7-063: la queja más repetida es «no me mandaron el guacamole / el frijol».*

- **Se hace**: en la **pestaña A** (misma conversación del escenario 1; sin ese pedido previo el agente no tiene a qué referirse).
- **Se escribe**: `Recibí el pedido pero no mandaron el guacamole`
- **Se ve [Agente]**: disculpa breve, pregunta qué faltó y escala con motivo `queja`; dice «la sucursal le confirma en unos minutos»; **no promete reposición, cambio ni descuento** (los autoriza la sucursal).
- **Panel → Conversaciones**: toma **pendiente** con motivo `queja` y la conversación completa; en **Contactos** aparece el contacto.
- **Nota honesta**: en la demo la persona no puede **responder por WhatsApp** desde el panel (no hay número conectado); sí puede tomar, anotar y cerrar.
- **Antes de pasar al 9 y al 10 (obligatorio)**: **Panel → Conversaciones** → abra la toma **pendiente** de la queja → **Tomar conversación** → **Marcar como resuelta**. Mientras la toma siga abierta (pendiente o tomada) el agente **calla** en esa conversación y el escenario 10 no tendría respuesta del agente.

## Escenario 9: factura (27:00 a 29:00)

*Origen: T7-003 y T7-004: un cliente pidió facturar a la 1:10 am con la foto del ticket.*

- **Se hace**: **pestaña B**, **Nueva conversación**.
- **Se escribe**: `Buenas noches, ¿me ayuda a facturar?`
- **Se ve [Agente]**: **no pide ni guarda RFC**; explica que el **ticket trae un código QR** para facturar en línea hasta 24 horas después del consumo; si el ticket es de otra sucursal, da el contacto de esa sucursal; **no escala** salvo que insista.
- **Nota honesta**: el widget no recibe fotos; el cliente real la manda y el agente no la lee.

## Escenario 10: «¿ya salió mi pedido?» (29:00 a 32:00)

*Origen: T7-016: 15 consultas de estado en 8 semanas; la cajera contesta porque ve a los repartidores.*

- **Se dice**: «El agente no ve al repartidor: solo sabe lo que la sucursal marcó en el pedido. Nunca inventa un estado.»
- **Se hace**: confirme que la queja del escenario 8 quedó **resuelta** (sin toma abierta, el agente contesta). Diga: «Ahora el cliente, impaciente, pregunta por su pedido antes de que le llegue; usamos el mismo teléfono de la demo». En **Pedidos**, marque el pedido del escenario 1 como **En preparación** (queda en «pendiente» al crearse); luego vuelva a la **pestaña A**.
- **Se escribe**: `¿Ya salió mi pedido?`; luego, en **Pedidos**, marque el pedido **En camino** y vuelva a escribir `¿Ya salió?`.
- **Se ve [Agente]**: primero «va en preparación, confirmado a las [hora]; el tiempo estimado es de 60 a 75 minutos»; después de marcarlo **en camino**: «ya salió a reparto». Si ya pasó el tiempo prometido lo trata como queja (`tiempos_entrega`).
- **Se ve [Servidor]**: el estado que dice sale de `Pedido reciente` (último pedido de ese teléfono en las últimas 12 h), no de la memoria del modelo.

## Cierre: «Chatea con tus datos» y Primeros pasos (32:00 a 35:00)

- **Chatea con tus datos** (botón del panel). Se escribe: `¿Cuánto vendí esta semana?` y `¿Cuáles son mis productos más vendidos este mes?` y `¿A qué horas tengo más pedidos?`.
  **Se ve**: respuesta con tabla o gráfica sencilla que cita **fuente y periodo**; los números salen de las consultas reales sobre el volumen de demostración (herramientas de solo lectura, con bitácora).
  Requiere la misma llave de LLM; sin ella el botón muestra un aviso honesto de «no disponible». Los datos llegan hasta *ayer*.
- **Primeros pasos** (menú Equipo). **Se ve**: el estado calculado con datos reales; **pendientes visibles** con su responsable: **hora del cambio de turno**, **coordenadas de Pensiones (T3)**, **mapa de colonias**, **número de WhatsApp por sucursal**, **nombre del asistente** y **catálogo de SoftRestaurant**.
  «Esto es lo que necesitamos de ustedes para pasar de demo a operación; nada de esto se inventó.»

## Qué NO se muestra (y por qué)

| Tema | Estado real | Quién lo cierra |
| --- | --- | --- |
| WhatsApp **real** (Meta) | La demo usa el widget; el WhatsApp real exige el número de T7 y las credenciales de Meta | Dueño (número) + Meta |
| **Voz** | Deshabilitada; comportamiento y saludos cargados; KPIs de voz en cero | Credenciales de voz + decisión del dueño |
| **SoftRestaurant** | Las comandas quedan en captura manual; no se inventan códigos | Distribuidor del POS |
| **Mapa de colonias** | No hay «fuera de zona» por colonia: el agente asigna por pin y kilómetros | Dueño |
| **Pedidos programados antes de abrir y cobertura con la zona dueña cerrada** (T7-007, T7-010, T7-018, T7-027, T7-036, T7-053, T7-054, T7-065) | Decisiones abiertas de Javier; los escenarios están listados pero no se prueban | Javier |
| **Fotos, audios, ticket** | El widget solo manda texto | n/a (WhatsApp real) |
| **Respuesta humana por WhatsApp** | Requiere un número conectado | Dueño + Meta |
| **Combo del martes** | Cargado (cortesía, solo recoger, 2 aguas); el agente dice lo que devuelve la cotización. Falta confirmar con el dueño cuáles aguas entran (P13) | Dueño (aguas de cortesía) |
| **Notificaciones in-app** | Conectados los eventos de restaurantes del catálogo (`docs/NOTIFICACIONES.md`): escalación a una persona, pedido nuevo del agente, tope diario del chat, **pedido programado que entra a cocina** y cierres. En la demo los pedidos programados se promueven por el cron o al abrir *Pedidos* | n/a |
| La organización demo en **superadmin/costos** | Aparece como una más (no se filtra por demo) | Pendiente |

## Reinicio entre demos

1. `npm run demo:limpiar -- --modo=sesiones_widget --apply --confirm-host=<host>` borra conversaciones, pedidos y tomas del chat (teléfonos `0009…`).
2. Si cambió algo en vivo (un precio, un horario), restáurelo. Para partir de cero: `npm run demo:pm -- --apply --confirm-host=<host>` (borra y regenera el volumen con la fecha de hoy).

## Cifras citadas (las verifica una prueba contra el motor de pedidos)

```json cifras-guion
{
  "pedidoMinimo": { "renglones": [["Frijol con Tostada", 1]], "suma": 93, "faltan": 107 },
  "pines": [
    { "escenario": 1, "lat": 21.0211, "lng": -89.6141, "sucursal": "garcia-lavin" },
    { "escenario": 5, "lat": 21.0282, "lng": -89.6098, "sucursal": "prol-montejo", "telefono": "999 944 0342" }
  ],
  "escenarios": [
    { "n": 1, "ids": ["T7-020", "T7-015"], "canal": "domicilio", "renglones": [["Tacos de Bistec de Res (orden de 3)", 6, "maiz"], ["Guacamole", 1]], "total": 530 },
    { "n": 2, "ids": ["T7-035", "T7-022", "T7-001"], "canal": "recoger", "renglones": [["Nachos de Pastor", 1]], "dobleSalsas": ["crema_ajo"], "total": 347 },
    { "n": 3, "ids": ["T7-001", "T7-061"], "canal": "recoger", "renglones": [["Bistec de Res — 250 g", 1], ["Pastor — 500 g", 1]], "total": 725 },
    { "n": 4, "ids": ["T7-029"], "canal": "recoger", "renglones": [["Tacos de Bistec de Res (orden de 3)", 3, "maiz"]], "total": 194 },
    { "n": 4, "ids": ["T7-029"], "canal": "recoger", "renglones": [["Tacos de Bistec de Res (orden de 3)", 6, "maiz"]], "total": 388 },
    { "n": 5, "ids": ["T7-050"], "canal": "recoger", "renglones": [["Taco Al Pastor (individual)", 4, "maiz"]], "total": 168 }
  ],
  "conversacionales": [
    { "n": 6, "ids": ["T7-064", "T7-041"] },
    { "n": 7, "ids": ["T7-019", "T7-043"] },
    { "n": 8, "ids": ["T7-021", "T7-063"] },
    { "n": 9, "ids": ["T7-003", "T7-004"] },
    { "n": 10, "ids": ["T7-016"] }
  ],
  "reglasDelPrompt": {
    "7": "CAMBIOS DESPUÉS DE CONFIRMAR",
    "8": "FALTANTE O PRODUCTO EQUIVOCADO",
    "9": "FACTURA",
    "10": "ESTADO DEL PEDIDO"
  }
}
```
