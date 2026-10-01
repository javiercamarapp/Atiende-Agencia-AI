# Demo completa de Los Taquitos de PM (guion)

Guion para **presentar a Los Taquitos de PM** el producto de punta a punta **sin credenciales de Meta, Twilio, ElevenLabs ni
SoftRestaurant**: el agente de WhatsApp real conversa en una página web, toma pedidos reales contra el menú real de PM, la comanda
aparece en el panel de cocina, y el panel (KPIs, historial, clientes, auditoría) trae 3 meses de datos de demostración.

- Duración total: **~40 minutos** (cada escenario trae su tiempo; los marcados *(opcional)* se pueden saltar).
- Todo lo que el guion promete está respaldado por código y pruebas de este repositorio. Lo que **no** hace la demo está en la
  sección «Qué NO se muestra (y por qué)» al final: dígalo tal cual si preguntan.
- Cargar la demo en la base: `docs/DEMO-PM-CARGA.md` (runbook con dry-run, `--confirm-host`, verificación y borrado).

## Qué es la demo (en una frase por pieza)

| Pieza | Qué es de verdad |
| --- | --- |
| Chat `/demo/<slug>` | El **mismo agente** que atiende el WhatsApp de cada sucursal (mismo `turnHandler`, las mismas herramientas contra el menú real, la misma máquina cotizar → confirmar → crear, el mismo presupuesto y *kill switch* del gateway de LLM). Solo cambia el transporte: la respuesta se devuelve a la página y **nunca se encola hacia Meta**. |
| Pedidos del chat | Pedidos reales (motor de pedidos real): precios del menú, mínimo de $200 a domicilio, alcohol solo al recoger, propina solo con tarjeta, horario de la sucursal, promoción 2x1 del lunes. Aparecen en el panel de Pedidos y en el ticket de cocina. |
| Escalaciones | Reales: abren una toma de handoff en **Conversaciones** y un contacto en la bandeja de contactos. |
| Datos del panel | Volumen sintético (`seed-volumen`) creado con el **mismo motor de pedidos** (totales coherentes por construcción), con teléfonos ficticios del rango reservado `0001xxxxxx` (no existe en México). No hay PII real. |
| Voz | **Deshabilitada** a propósito (sin gasto de proveedores). Los saludos y el comportamiento de voz quedan cargados; los KPIs de voz salen en cero. |

## Checklist previo (30 minutos antes)

1. **Base cargada**: `docs/DEMO-PM-CARGA.md` ejecutado (seed `--demo` + volumen). Verifique con la sección «Cómo verificar».
2. **El agente está disponible**: abra `https://<su-dominio>/demo/los-taquitos-de-pm-demo`. Debe verse el chat. Si dice
   **«Agente no disponible: requiere OPENROUTER_API_KEY…»**, falta configurar la llave de un proveedor LLM en el servidor
   (variable `OPENROUTER_API_KEY` o la de otro proveedor soportado). **No hay respuestas simuladas**: sin llave, no hay demo del chat.
3. **Hora y día**: el negocio abre de **12:00 a 01:00 (hora de Mérida)**. El escenario 7 (fuera de horario) solo se ve entre 01:00 y 12:00
   o con el truco descrito ahí. El escenario 9 (2x1) solo funciona **en lunes**.
4. **Sesión del dueño** iniciada en el panel (`/restaurantes/los-taquitos-de-pm-demo`) con un usuario *owner* (el seed **no crea
   usuarios**: se enlaza uno existente con `--owner-email`). Pestañas listas: Pedidos, Conversaciones, Historial, Clientes, Auditoría,
   Primeros pasos.
5. **Limpie las sesiones de pruebas anteriores del chat**: `npm run demo:limpiar -- --modo=sesiones_widget --apply --confirm-host=<host>`
   (con `SEED_DATABASE_URL`). Así no aparecen pedidos de ensayos en el panel.
6. **Dos pestañas en paralelo**: el chat a un lado y el panel de Pedidos al otro (el panel consulta pedidos nuevos solo, cada ~20 segundos, o pulse actualizar).
7. Tenga a la mano el **teléfono de la sala** apagado: nada de esta demo manda mensajes a ningún teléfono.

## Guion cronometrado

> En cada fila: **Se dice** = lo que usted comenta; **Se hace** = lo que escribe o pulsa; **Se ve / resultado esperado** = lo que debe
> aparecer. Los importes salen del menú sembrado (menú provisional hasta tener el catálogo de SoftRestaurant).

### 1. Apertura: el panel con datos (0:00 – 3:00)

- **Se dice**: «Esto es el panel de su negocio con tres meses de operación de demostración, de las cinco sucursales activas.»
- **Se hace**: abra **Panel (KPIs)**; cambie el periodo (7 / 30 / 90 días); abra el selector de sucursal.
- **Se ve**: ventas netas, número de órdenes y valor promedio con tendencia; «Impacto de tus agentes» con los pedidos por WhatsApp
  (los de voz en 0: la voz está deshabilitada); clientes totales, recurrentes y tiers. Las sucursales **T1, T2, T3, T7 y T8** tienen
  pedidos; **T4 no aparece** (registrada, inactiva y sin menú hasta que el dueño confirme su identidad).
- **Nota honesta**: las proporciones por sucursal y canal son ilustrativas, no sus cifras reales.

### 2. Pedido normal a domicilio (3:00 – 7:00)

- **Se dice**: «Un cliente le escribe al WhatsApp de Victory Altabrisa. Aquí lo hacemos desde el navegador, pero es el mismo agente.»
- **Se hace**: en el chat elija la sucursal **Victory Altabrisa** y escriba, uno por uno:
  1. `Hola`
  2. `A domicilio, por favor`
  3. `Me llamo Ana Prueba, mi teléfono es 9995550101`
  4. `Quiero 8 tacos al pastor y 2 Coca-Cola`
  5. `Todos de maíz`
  6. `Calle 7 número 270 entre 4 y 6, colonia Vista Alegre, frente a la plaza`
  7. `Pago con tarjeta` → (si pregunta propina) `No, gracias`
  8. `Sí, confirmo`
- **Se ve**: saludo con el **aviso de privacidad** y «asistente virtual» (siempre de *usted*); el agente pregunta por la tortilla de
  cada renglón de tacos; cotiza con la herramienta y repite el total exacto: **$442** (8 × $42 + 2 × $53, sin costo de envío);
  pregunta propina solo porque paga con tarjeta; al confirmar, bajo la burbuja del agente aparece **«Pedido registrado por $442.00: ya
  aparece en el panel de pedidos y en el ticket de cocina»**.
- **Panel**: en **Pedidos** aparece el pedido nuevo (canal WhatsApp, estado *pending*). Pulse **Imprimir ticket**: ticket de
  cocina con la sucursal, los renglones, la tortilla y las salsas incluidas.
- **Si el modelo se desvía**: las reglas duras no dependen del modelo; si no cotiza, pídale «cotice mi pedido».

### 3. Pedido para recoger (7:00 – 9:00)

- **Se hace** (nueva conversación con «Nueva conversación», sucursal **Prolongación Montejo**): `Hola, quiero pasar a recoger 6
  tacos al pastor y una horchata, a nombre de Luis Demo, teléfono 9995550102, tortilla de harina, pago en efectivo, paso a las 8 de la noche`.
- **Se ve**: no pide dirección; **no pregunta propina** (la propina solo existe con tarjeta); total **$312** (6 × $42 + $60); anota la
  hora de recogida; al confirmar, el pedido aparece en Pedidos con canal *recoger*.

### 4. «3 de bistec» (9:00 – 11:00)

- **Se hace**: `Quiero 3 de bistec`.
- **Se ve**: el sistema antepone siempre el aviso de que **los tacos de bistec se venden únicamente en órdenes de 3** y que el precio del menú
  es el de la orden completa; el agente pide la tortilla, cotiza **3 piezas = 1 orden = $194** y **repite el resumen para que el cliente
  confirme** antes de crear nada. (El agente nunca convierte piezas en órdenes por su cuenta: lo hace el servidor.) Pruebe `Quiero 4 de
  bistec`: el servidor rechaza el múltiplo y el agente ofrece 3 o 6.

### 5. Reglas duras de domicilio: alcohol y mínimo (11:00 – 14:00)

- **Alcohol a domicilio** — **Se hace**: `Quiero 6 Heineken y 4 tacos al pastor a domicilio`.
  **Se ve**: el servidor rechaza con «*Heineken no se vende a domicilio. Quítelo del pedido o cambie el pedido a recoger en sucursal.*»; el
  agente lo explica con sus palabras, **no se crea ningún pedido**, y ofrece recoger. Si acepta recoger, pregunta con claridad si quien
  recibe es mayor de edad antes de cotizar.
- **Pedido mínimo** — **Se hace**: nueva conversación, `A domicilio, 3 tacos al pastor`.
  **Se ve**: «*El pedido mínimo a domicilio es de $200. El pedido suma $126; faltan $74…*» y la invitación a agregar algo o pasar a recoger.

### 6. Cambio de precio en vivo (14:00 – 16:00)

- **Se dice**: «El precio lo manda el panel, no el agente. Lo cambio y el siguiente pedido ya lo cobra distinto.»
- **Se hace**: en **Productos** cambie el precio de **Taco Al Pastor (individual)** de $42 a $45; vuelva al chat y pida `8 tacos al pastor para recoger`.
- **Se ve**: el agente cotiza con el precio nuevo (8 × $45 = $360; en lunes ver el escenario 9). En **Auditoría** aparece la acción
  `producto.precio_actualizado` con usuario y hora. **Restaure el precio a $42 al terminar.**

### 7. Fuera de horario (16:00 – 17:30)

- **Se dice**: «Abre de 12 del día a 1 de la madrugada.»
- **Se hace**: **entre 01:00 y 12:00 (hora de Mérida)** pida cualquier pedido. **Si presenta en horario abierto**: en **Sucursales →
  Reglas de pedido** ponga a una sucursal un horario que no incluya la hora actual (p. ej. 06:00–08:00), pida un pedido en el chat y **restaure el horario**.
- **Se ve**: «*La sucursal … está cerrada en este momento; abre hoy a las 12:00…*»; no se crea pedido. (No se informa nada que el horario
  no diga: la hora exacta del cambio de turno del dueño sigue pendiente.)

### 8. Escalación por queja (17:30 – 20:00)

- **Se hace**: `Mi pedido anterior llegó frío y quiero poner una queja`.
- **Se ve**: respuesta fija del sistema (**no depende del modelo**): lamenta el inconveniente y avisa que el equipo se comunicará; bajo
  la burbuja: «*Se avisó a una persona del equipo: la conversación aparece en Conversaciones del panel.*»
- **Panel → Conversaciones**: toma **pendiente** con el motivo `queja`, la conversación completa, el teléfono ficticio y el contacto con su
  SLA. Pulse **Tomar conversación**: desde ese momento el agente **calla**; escriba otro mensaje en el chat y verá «*Una persona del equipo tiene tomada
  esta conversación; su mensaje quedó guardado para ella.*» Agregue una **nota interna** y pulse **Marcar como resuelta**.
- **Nota honesta**: en la demo la persona no puede **responder por WhatsApp** desde el panel (no hay un número de WhatsApp conectado a la
  sucursal); sí puede tomar, anotar y cerrar. Con el número de Meta conectado, la respuesta sale por WhatsApp.

### 9. Promoción 2x1 de los lunes — solo recoger (20:00 – 22:30) *(solo en lunes)*

- **Se hace**: `Quiero pasar a recoger 8 tacos al pastor` (tortilla de maíz, efectivo) y, aparte, el mismo pedido **a domicilio**.
- **Se ve**: para recoger la cotización trae **$168** (el motor aplica el 2x1 solo, sin código; la nota del pedido dice «Promoción aplicada:
  LUNES2X1PM (-$168.00)»); a domicilio **$336**, sin promoción (las promociones de PM no aplican a domicilio). **Cualquier otro día**
  el agente no la aplica ni la promete; si le preguntan, responde que es solo lunes y solo para recoger.
- **Nota honesta**: el combo del **martes** (nachos + 2 aguas de cortesía) **no está cargado** (falta definir cuáles aguas): el agente no lo promete.

### 10. Pedido grande → persona (22:30 – 24:30)

- **Se hace**: `Quiero pasar a recoger 60 tacos al pastor para una reunión`.
- **Se ve**: el agente avisa que un pedido de ese tamaño lo revisa el equipo y **escala** (criterio del prompt de PM: 40 o más piezas, o
  $1,500 o más); aparece la toma de handoff en Conversaciones con el motivo `pedido_grande`.
- **Nota honesta**: esta escalación la decide el agente según su prompt (no es una regla dura del servidor como la queja). Si no
  escalara, repita con una cantidad mayor.

### 11. Pregunta de menú, salsas y alergias (24:30 – 27:00)

- **Se hace**: `¿Qué salsas incluye?`, luego `¿Tienen sopa de lima?` (en **Francisco de Montejo**, menú chico) y después `Soy alérgico al cacahuate, ¿qué me recomienda?`.
- **Se ve**: las **9 salsas incluidas sin costo** (roja, verde, mexicana, guacamolera, limones, crema de ajo, cebolla con cilantro, piña y chile
  habanero); la **comida regional solo existe en las sucursales de menú grande** (T1, T7, T8): en T2 el agente dice que no está en el menú
  (no inventa); ante la **alergia** el agente **no da información de alérgenos** (no tiene ese dato) y **escala a una persona**
  (regla dura del servidor).

### 12. Pedido programado (27:00 – 29:00) *(opcional; requiere la migración 034)*

- **Se dice**: «El cliente también puede dejar el pedido para otra hora. Hoy entra por el canal web o de voz; el agente de WhatsApp todavía no lo toma.»
- **Se hace**: desde una terminal (sustituya la fecha por mañana a las 14:00 de Mérida):
  `curl -sS -X POST https://<su-dominio>/v1/restaurantes/los-taquitos-de-pm-demo/orders -H 'content-type: application/json' -d '{"branch_slug":"altabrisa","customer_name":"Marta Demo","customer_phone":"9995550103","canal":"recoger","payment_method":"efectivo","items":[{"product_name":"Taco Al Pastor (individual)","requested_quantity":4,"tortilla":"maiz"}],"programado_para":"2026-10-06T14:00:00-06:00"}'`
- **Se ve**: el pedido nace en estado `programado`, **no** entra a cocina; aparece en **Pedidos → Programados** con la hora elegida.
- **Nota honesta**: pasar un programado a cocina a la hora lo hace un endpoint interno que **todavía no está programado como tarea
  automática** (ver «Qué NO se muestra»).

### 13. Historial, clientes y auditoría (29:00 – 33:00)

- **Historial**: filtre por sucursal y estado; hay pedidos *completado*, *cancelado*, *no_recogido* y *problema* (≈ 91 % completados); abra uno:
  renglones, tortilla, salsas incluidas, método de pago, propina (solo tarjeta) y, si aplica, la promoción del lunes. Los totales **suman
  exactamente** sus renglones menos el descuento del motor.
- **Clientes**: ranking, recurrencia y tiers (BLACK/PLATINUM/GOLD/BLUE); abra la ficha: pedidos, dirección y el «lo de siempre» (los
  más pedidos). Todos los teléfonos son del rango ficticio `0001…`.
- **Auditoría**: los cambios de catálogo y configuración hechos durante la demo (precio, horario) con usuario y hora; la bitácora no se puede editar.

### 14. «Chatea con tus datos» (33:00 – 37:00)

- **Se dice**: «Aquí el dueño le pregunta a su negocio en español.»
- **Se hace**: pulse el botón **Chatea con tus datos** del panel; pregunte `¿Cuánto vendí esta semana?`, `¿Cuáles son mis productos más vendidos este mes?`,
  `¿A qué horas tengo más pedidos en los últimos 30 días?` y `¿Qué canal me trae más pedidos este mes?`.
- **Se ve**: respuesta con tabla o gráfica sencilla, **citando la fuente y el periodo**; los números salen de las consultas reales del volumen
  de demostración (catálogo cerrado de 8 herramientas de solo lectura, con bitácora). El día de la demo los datos llegan hasta *ayer*.
- **Requiere** la misma llave de LLM que el chat; sin ella el botón muestra un aviso honesto de «no disponible».

### 15. Primeros pasos: lo que falta (37:00 – 40:00)

- **Se dice**: «Esto es lo que necesitamos de ustedes para pasar de demo a operación; nada de esto se inventó.»
- **Se hace**: abra **Primeros pasos** (menú Equipo, owner/admin).
- **Se ve**: el estado **calculado con datos reales**: sucursales, menú, horarios, pedido mínimo y agente **listos**; **pendientes visibles** con
  su responsable y enlace a la pantalla: **hora del cambio de turno**, **coordenadas de Pensiones (T3)**, **mapa de colonias** (cobertura de entrega),
  **número de WhatsApp por sucursal**, **nombre del asistente**, **catálogo de SoftRestaurant** (depende del distribuidor del POS) y un **pedido de prueba**.

## Qué NO se muestra (y por qué)

| Tema | Estado real | Quién lo cierra |
| --- | --- | --- |
| WhatsApp **real** (Meta) | La demo usa el widget; el WhatsApp real exige el número de cada sucursal y las credenciales de Meta | Dueño (números) + Meta |
| **Voz** | Deshabilitada; comportamiento y saludos cargados; KPIs de voz en cero | Credenciales de voz + decisión del dueño |
| **SoftRestaurant** | Las comandas quedan en captura manual; no se inventan códigos de producto | Distribuidor del POS (export del catálogo y API) |
| **Hora del cambio de turno** | El horario es una sola franja 12:00–01:00 | Dueño |
| **Coordenadas de T3** y **mapa de colonias** | T3 no entra a la asignación por distancia; no hay «fuera de zona» configurado | Dueño |
| **Combo del martes** | No cargado; el agente no lo promete | Dueño (definir las aguas de cortesía) |
| **Promoción de programados a cocina** | Existe el endpoint interno, pero ningún *cron* lo llama todavía | Pendiente de agendar (R-28) |
| **Respuesta humana por WhatsApp** | Requiere un número conectado | Dueño + Meta |
| **Notificaciones in-app** | Conectados por esta demo: la escalación a una persona (`restaurantes.handoff.solicitado`, también para el WhatsApp real) y el tope diario del chat (`restaurantes.demo.tope_diario_alcanzado`) emiten su notificación con el productor compartido. La **campana con punto rojo y la página de notificaciones** son la parte B de las notificaciones (otro PR, ver `docs/NOTIFICACIONES.md`): hoy la campana sigue mostrando un número. Pendientes de conectar de esta demo: pedido nuevo del agente, contacto nuevo y el cierre del checklist de Primeros pasos. | Parte B de notificaciones |
| La organización demo en **superadmin/costos** | Aparece como una organización más (no se filtra por demo) | Pendiente |

## Reinicio entre demos

1. `npm run demo:limpiar -- --modo=sesiones_widget --apply --confirm-host=<host>` borra las conversaciones, pedidos y handoffs del chat
   (teléfonos `0009…`).
2. Restaure lo que cambió en vivo (precio del escenario 6, horario del 7).
3. Si quiere partir de cero: `--modo=volumen` borra el volumen y `seed-volumen` lo vuelve a crear (determinista: mismos datos).
