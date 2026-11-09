// ds3 «Guía» de restaurantes: qué es cada pantalla, su elemento clave y su acción principal, en español e inglés. El recorrido en sí sale
// del menú real del rol (buildSections de RestaurantesShell): owner/admin ven todo; staff no ve Agente ni Configuración; el repartidor
// tiene su propio panel (guía aparte, ver GUIA_REPARTIDOR). Ningún texto promete algo que la pantalla no hace; ninguna cifra va escrita.
// Fuente de los pasos: rediseno/ONBOARDING-INVESTIGACION-A.md §1.3 (coach-marks por pantalla) y el patrón de copy de Rovaq (§4.12).
import type { ContenidoConsola, SeccionMenu } from "@atiende/ui";

const t = (es: string, en: string) => ({ es, en });

export const GUIA_RESTAURANTES: ContenidoConsola = {
  "": {
    ilu: "barras",
    queT: t("Resumen: tu día en cifras", "Overview: your day in numbers"),
    que: t("Ventas, pedidos y ticket promedio de la sucursal activa. Si una cifra es parcial, la tarjeta lo dice.", "Sales, orders and average ticket for the active branch. If a number is partial, the card says so."),
    clave: {
      titulo: t("Las cifras del día", "Today's numbers"),
      cuerpo: t("Cada tarjeta compara contra el periodo anterior; el detalle vive en Pedidos e Historial.", "Each card compares against the previous period; the detail lives in Orders and History."),
      objetivos: ['#contenido-principal [data-tour="kpis"]', '#contenido-principal [class*="md:grid-cols-4"]', '#contenido-principal [role="region"]'],
    },
  },
  copiloto: {
    ilu: "chat",
    queT: t("Copiloto: pregúntale a tus datos", "Copilot: ask your data"),
    que: t("Escribe una pregunta («¿qué platillo vendió más esta semana?») y te responde con tus pedidos reales, con la fuente.", "Type a question (“which dish sold most this week?”) and it answers from your real orders, with the source."),
    clave: { titulo: t("Escribe aquí", "Type here"), cuerpo: t("Las sugerencias de abajo son buenas para empezar.", "The suggestions below are a good start."), objetivos: ["#contenido-principal textarea", "#contenido-principal input[type='text']"] },
  },
  cfo: {
    ilu: "linea",
    queT: t("CFO: el dinero del restaurante", "CFO: the restaurant's money"),
    que: t("Ingresos, costos y margen por periodo. Lo que falta capturar se marca como pendiente, no se inventa.", "Revenue, costs and margin by period. Anything not yet captured shows as pending, never made up."),
    clave: { titulo: t("Margen y costos", "Margin and costs"), cuerpo: t("Importa tu archivo de SoftRestaurant para llenar los costos reales.", "Import your SoftRestaurant file to fill in real costs.") },
  },
  general: {
    ilu: "barras",
    queT: t("Resumen general: todas tus sucursales", "Organization overview: all your branches"),
    que: t("Las cifras de cada sucursal lado a lado, para comparar ventas y pedidos sin cambiar de sucursal.", "Each branch's numbers side by side, to compare sales and orders without switching branches."),
    clave: { titulo: t("Compara sucursales", "Compare branches"), cuerpo: t("Si a una sucursal le falta un dato, su celda lo dice en vez de mostrar cero.", "If a branch is missing a number, its cell says so instead of showing zero.") },
  },
  "operacion/agregados": {
    ilu: "lista",
    queT: t("Agregados: lo que un cliente pide sumar", "Add-ons: what a customer asks to add"),
    que: t("Cuando un cliente pide agregar algo a un pedido ya enviado, llega aquí para que lo valides antes de cobrarlo.", "When a customer asks to add something to an order already sent, it lands here for you to approve before charging."),
    clave: { titulo: t("Acepta o rechaza con motivo", "Accept or reject with a reason"), cuerpo: t("La más antigua va arriba con su cronómetro; el agente nunca lo confirma por su cuenta.", "The oldest is on top with its timer; the agent never confirms it on its own.") },
  },
  operacion: {
    ilu: "lista",
    queT: t("Cola: pedidos por atender", "Queue: orders to handle"),
    que: t("Los pedidos en orden de llegada, listos para aceptar, preparar y asignar.", "Orders in arrival order, ready to accept, prepare and assign."),
  },
  "operacion/nuevo": {
    ilu: "pedido",
    queT: t("Nuevo pedido: captura a mano", "New order: manual entry"),
    que: t("Para pedidos que llegan por teléfono o en mostrador: los capturas aquí y entran a la misma cola.", "For orders by phone or at the counter: enter them here and they join the same queue."),
  },
  "operacion/viajes": {
    ilu: "mapa",
    queT: t("Viajes: entregas en ruta", "Trips: deliveries on the road"),
    que: t("Qué repartidor lleva qué pedido y en qué estado va cada entrega.", "Which driver carries which order and the status of each delivery."),
  },
  "operacion/turno": {
    ilu: "corte",
    queT: t("Turno: abre y cierra caja", "Shift: open and close"),
    que: t("Resumen del turno en curso y su cierre.", "Summary of the current shift and its close."),
  },
  pedidos: {
    ilu: "pedido",
    queT: t("Pedidos: lo que entra hoy", "Orders: what comes in today"),
    que: t("Todos los pedidos de WhatsApp, llamadas y mostrador de la sucursal activa, con su estado.", "Every order from WhatsApp, calls and counter for the active branch, with its status."),
    clave: { titulo: t("Estados y repartidor", "Statuses and driver"), cuerpo: t("Cambia el estado de cada pedido y asígnale repartidor desde su tarjeta.", "Change each order's status and assign a driver from its card.") },
    accion: { titulo: t("Imprime la comanda", "Print the ticket"), cuerpo: t("Cada pedido trae su ticket de cocina; puedes activar la impresión automática al llegar.", "Each order has a kitchen ticket; you can turn on automatic printing on arrival.") },
  },
  "comandas-pos": {
    ilu: "importar",
    queT: t("Comandas al POS", "Tickets to the POS"),
    que: t("Cola de comandas que alguien teclea en SoftRestaurant mientras no hay conexión directa con tu POS.", "Queue of tickets someone types into SoftRestaurant while there's no direct POS connection."),
    clave: { titulo: t("Marca lo que ya capturaste", "Mark what you already entered"), cuerpo: t("Cuando la comanda ya está en el POS, márcala para que no se teclee dos veces.", "Once the ticket is in the POS, mark it so it isn't typed twice.") },
  },
  conversaciones: {
    ilu: "chat",
    queT: t("Conversaciones: WhatsApp y llamadas", "Conversations: WhatsApp and calls"),
    que: t("Lo que tus clientes platican con el agente. Puedes leer cualquier conversación completa.", "What your customers talk about with the agent. You can read any conversation in full."),
    clave: { titulo: t("Tomar y devolver", "Take over and hand back"), cuerpo: t("«Tomar» una conversación calla al agente para que contestes tú; «Devolver» lo reactiva.", "“Take over” silences the agent so you reply; “Hand back” turns it on again.") },
  },
  turnos: {
    ilu: "agenda",
    queT: t("Turnos del personal", "Staff shifts"),
    que: t("Turnos del personal por sucursal y quién está de guardia ahora.", "Staff shifts per branch and who is on duty right now."),
    clave: { titulo: t("Quién cubre cada turno", "Who covers each shift"), cuerpo: t("Todo el equipo lo ve; solo dueño y gerente lo editan.", "The whole team sees it; only owner and manager edit it.") },
  },
  historial: {
    ilu: "linea",
    queT: t("Historial: pedidos pasados", "History: past orders"),
    que: t("Busca cualquier pedido anterior por fecha, cliente o estado.", "Find any past order by date, customer or status."),
    clave: { titulo: t("Filtra y exporta", "Filter and export"), cuerpo: t("Los filtros de arriba acotan la lista; la tabla muestra el detalle.", "The filters at the top narrow the list; the table shows the detail.") },
  },
  avisos: {
    ilu: "campana",
    queT: t("Avisos: qué te llega y cuándo", "Alerts: what reaches you and when"),
    que: t("Elige qué avisos recibe cada persona del equipo (pedido nuevo, entrega tardía…).", "Choose which alerts each team member gets (new order, late delivery…)."),
    clave: { titulo: t("Uno por persona", "One per person"), cuerpo: t("Prende o apaga cada aviso por persona y ajusta el tiempo de gracia de la entrega tardía por sucursal.", "Turn each alert on or off per person and set the late-delivery grace time per branch.") },
  },
  cierres: {
    ilu: "corte",
    queT: t("Cierre del día", "End of day"),
    que: t("El resumen del día y de la semana para revisar ventas y pendientes antes de cerrar.", "The day and week summary to review sales and loose ends before closing."),
    clave: { titulo: t("Un cierre no cambia", "A close doesn't change"), cuerpo: t("Ventas, canales, cancelaciones y tiempos de entrega quedan congelados al generar el cierre.", "Sales, channels, cancellations and delivery times are frozen when the close is generated.") },
  },
  productos: {
    ilu: "tarjetas",
    queT: t("Productos: tu menú", "Products: your menu"),
    que: t("Categorías, platillos y precios. Lo que el agente ofrece sale de aquí, así que mantenlo al día.", "Categories, dishes and prices. What the agent offers comes from here, so keep it current."),
    clave: { titulo: t("Precio y disponibilidad por sucursal", "Price and availability per branch"), cuerpo: t("Un platillo puede costar distinto o estar agotado solo en una sucursal.", "A dish can cost differently or be sold out in just one branch.") },
    accion: { titulo: t("Agrega platillos", "Add dishes"), cuerpo: t("Crea una categoría y sus platillos desde el botón de arriba.", "Create a category and its dishes from the button at the top.") },
  },
  promociones: {
    ilu: "tarjetas",
    queT: t("Promociones", "Promotions"),
    que: t("Descuentos y combos con vigencia. El agente solo ofrece las que están activas hoy.", "Discounts and combos with dates. The agent only offers the ones active today."),
    accion: { titulo: t("Crea una promoción", "Create a promotion"), cuerpo: t("Define qué incluye, el precio y cuándo vale.", "Set what it includes, the price and when it applies.") },
    clave: { titulo: t("Vigencia de cada promoción", "Each promotion's dates"), cuerpo: t("Una promoción vencida o futura no se ofrece.", "An expired or future promotion isn't offered.") },
  },
  clientes: {
    ilu: "equipo",
    queT: t("Clientes: tu cartera", "Customers: your book"),
    que: t("Quién te compra, cada cuánto y cuánto gasta. Se arma sola con los pedidos.", "Who buys from you, how often and how much. It builds itself from orders."),
    clave: { titulo: t("Ficha del cliente", "Customer profile"), cuerpo: t("Abre un cliente para ver su historial y sus direcciones.", "Open a customer to see their history and addresses.") },
  },
  campanas: {
    ilu: "campana",
    queT: t("Campañas: recupera clientes", "Campaigns: win customers back"),
    que: t("Mensajes para clientes que dejaron de pedir. Revisas y apruebas antes de que salga nada.", "Messages for customers who stopped ordering. You review and approve before anything goes out."),
    clave: { titulo: t("Tú apruebas", "You approve"), cuerpo: t("Cada campaña muestra a quién va y el mensaje; no sale nada sin tu aprobación.", "Each campaign shows who it goes to and the message; nothing goes out without your approval.") },
  },
  sucursales: {
    ilu: "mapa",
    queT: t("Sucursales", "Branches"),
    que: t("Dirección, ubicación en el mapa, horario, pedido mínimo y zonas de entrega de cada sucursal.", "Address, map location, hours, minimum order and delivery zones for each branch."),
    clave: { titulo: t("Reglas de pedido", "Order rules"), cuerpo: t("Horario, doble turno, pedido mínimo y colonias que cubres: el agente los respeta al tomar pedidos.", "Hours, split shifts, minimum order and neighborhoods covered: the agent follows them when taking orders.") },
  },
  "agente-voz": {
    ilu: "voz",
    queT: t("Agente de voz", "Voice agent"),
    que: t("La voz que contesta tus llamadas: voz, mensaje inicial y prueba. Debe presentarse como asistente virtual.", "The voice that answers your calls: voice, greeting and test. It must introduce itself as a virtual assistant."),
    accion: { titulo: t("Haz una llamada de prueba", "Make a test call"), cuerpo: t("Escucha cómo suena antes de prenderlo en una sucursal.", "Hear how it sounds before turning it on for a branch.") },
    clave: { titulo: t("Por sucursal", "Per branch"), cuerpo: t("Prendes o apagas la voz en cada sucursal por separado.", "You turn the voice on or off for each branch separately.") },
  },
  "agente-whatsapp": {
    ilu: "chat",
    queT: t("Agente de WhatsApp", "WhatsApp agent"),
    que: t("Conversaciones, conversión, pase a una persona y costo del agente por día.", "Conversations, conversion, hand-offs and the agent's cost per day."),
    clave: { titulo: t("Pruébalo como cliente", "Try it as a customer"), cuerpo: t("Escribe como si fueras cliente («quiero 3 tacos para llevar»); la prueba no crea pedidos reales.", "Write as a customer (“I want 3 tacos to go”); the test doesn't create real orders.") },
  },
  "agente-ajustes": {
    ilu: "panel",
    queT: t("Ajustes del agente", "Agent settings"),
    que: t("Modelo, temperatura, voz y sonido de fondo del agente.", "The agent's model, temperature, voice and background sound."),
    clave: { titulo: t("Dónde aplica cada ajuste", "Where each setting applies"), cuerpo: t("Cada control dice si aplica ya, en la vista previa o cuando se active el servicio de llamadas.", "Each control says whether it applies now, in the preview, or once the calls service is live.") },
  },
  "primeros-pasos": {
    ilu: "lista",
    queT: t("Primeros pasos", "Getting started"),
    que: t("Lo que falta para operar, calculado con tus datos reales. La primera pendiente es la recomendada.", "What's left before going live, calculated from your real data. The first pending one is the recommended one."),
    clave: { titulo: t("Tu avance", "Your progress"), cuerpo: t("Solo cuenta lo que tú puedes hacer; lo que depende de Meta o de tu distribuidor queda «en espera».", "Only what you can do counts; what depends on Meta or your dealer stays “waiting”.") },
  },
  configuracion: {
    ilu: "panel",
    queT: t("Configuración: WhatsApp y zonas", "Settings: WhatsApp and zones"),
    que: t("El número de WhatsApp de tu negocio, las zonas conocidas y el editor del agente.", "Your business WhatsApp number, known zones and the agent editor."),
    clave: { titulo: t("Número de WhatsApp", "WhatsApp number"), cuerpo: t("El identificador del número lo da Meta al verificar tu cuenta de WhatsApp Business.", "Meta gives the number ID when it verifies your WhatsApp Business account.") },
  },
  staff: {
    ilu: "equipo",
    queT: t("Staff: tu equipo", "Staff: your team"),
    que: t("Invita a tu gerente, a tu personal y a tus repartidores; cada uno ve solo lo de su rol.", "Invite your manager, staff and drivers; each one sees only what their role allows."),
    accion: { titulo: t("Invita a alguien", "Invite someone"), cuerpo: t("Le llega un correo para entrar con su propia cuenta.", "They get an email to sign in with their own account.") },
    clave: { titulo: t("Roles", "Roles"), cuerpo: t("Dueño y gerente administran; el personal opera pedidos; el repartidor solo ve sus entregas.", "Owner and manager administer; staff run orders; drivers only see their deliveries.") },
  },
  auditoria: {
    ilu: "escudo",
    queT: t("Auditoría", "Audit log"),
    que: t("Quién cambió qué y cuándo: precios, configuración, equipo.", "Who changed what and when: prices, settings, team."),
    clave: { titulo: t("Filtra por persona o por tipo", "Filter by person or type"), cuerpo: t("Cada fila dice quién hizo el cambio y cuándo.", "Each row says who made the change and when.") },
  },
  privacidad: {
    ilu: "escudo",
    queT: t("Privacidad", "Privacy"),
    que: t("Tu aviso de privacidad y las solicitudes de tus clientes para ver o borrar sus datos.", "Your privacy notice and customer requests to see or delete their data."),
    clave: { titulo: t("La dirección de tu aviso", "Your notice's address"), cuerpo: t("El agente comparte esta liga cuando un cliente pregunta por sus datos.", "The agent shares this link when a customer asks about their data.") },
  },
  "privacidad-organizacion": {
    ilu: "escudo",
    queT: t("Privacidad de la organización", "Organization privacy"),
    que: t("Retención, purgas y solicitudes de todas tus áreas en un solo lugar.", "Retention, purges and requests across all your areas in one place."),
    clave: { titulo: t("Plazos de cada solicitud", "Each request's deadline"), cuerpo: t("Las solicitudes de tus clientes muestran cuánto falta para responderlas.", "Customer requests show how long you have left to answer them.") },
  },
};

/** Recorrido corto por rol (5 pantallas). Las que el rol no tiene en su menú se omiten solas. */
export const ESENCIALES_RESTAURANTES: Readonly<Record<string, readonly string[]>> = {
  owner: ["", "pedidos", "productos", "conversaciones", "primeros-pasos"],
  admin: ["", "pedidos", "productos", "conversaciones", "primeros-pasos"],
  staff: ["", "pedidos", "historial", "conversaciones", "clientes"],
};

export const esencialesRestaurantes = (rol: string): readonly string[] => ESENCIALES_RESTAURANTES[rol] ?? ESENCIALES_RESTAURANTES.staff!;

/** El repartidor no tiene sidebar: su panel es una sola pantalla. Su guía recorre las tres zonas de esa pantalla. Los rótulos llegan ya
 *  traducidos (restaurantes.repartidor y restaurantes.chofer.titulo) desde quien arma el menú. */
export function menuRepartidor(orgSlug: string, rotulos: { readonly titulo: string; readonly pantalla: string }): SeccionMenu[] {
  return [{ title: rotulos.titulo, items: [{ to: `/restaurantes/${orgSlug}/repartidor`, label: rotulos.pantalla }] }];
}

export const GUIA_REPARTIDOR: ContenidoConsola = {
  repartidor: {
    ilu: "mapa",
    queT: t("Mis entregas", "My deliveries"),
    que: t("Los pedidos que te asignaron. Desde cada uno abres el mapa, llamas al cliente y avanzas su estado.", "The orders assigned to you. From each one you open the map, call the customer and move its status forward."),
    clave: { titulo: t("Avanza el estado al salir y al entregar", "Update the status when you leave and deliver"), cuerpo: t("Así la sucursal sabe dónde va cada pedido sin llamarte.", "That way the branch knows where each order is without calling you.") },
  },
};
