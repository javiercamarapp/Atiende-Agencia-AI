// ds3 «Guía» de hoteles: qué es cada pantalla, su elemento clave y su acción principal, en español e inglés. El recorrido en sí sale
// del menú real del rol (buildSections de HotelesShell): owner/gm ven todo; recepción, reservas, contabilidad, housekeeping,
// mantenimiento y F&B ven solo lo suyo (ver los *_NAV_ROLES del shell). Ningún texto promete algo que la pantalla no hace (cada uno
// se escribió leyendo la cabecera y las etiquetas de su página en ./pages); ninguna cifra va escrita.
import type { ContenidoConsola } from "@atiende/ui";

const t = (es: string, en: string) => ({ es, en });

export const GUIA_HOTELES: ContenidoConsola = {
  "": {
    ilu: "barras",
    queT: t("Resumen: el hotel de un vistazo", "Overview: the hotel at a glance"),
    que: t("Las cifras del hotel activo que tu rol puede ver. Si una lectura falla, su tarjeta lo dice en vez de mostrar un cero.", "The active hotel's numbers your role can see. If a reading fails, its card says so instead of showing a zero."),
    clave: {
      titulo: t("Cada tarjeta lleva a su pantalla", "Each card leads to its screen"),
      cuerpo: t("Llegadas, tickets vencidos, aprobaciones pendientes: toca una tarjeta para ir al detalle.", "Arrivals, overdue tickets, pending approvals: tap a card to go to the detail."),
    },
  },
  copiloto: {
    ilu: "chat",
    queT: t("Copiloto: pregúntale a tus datos", "Copilot: ask your data"),
    que: t("Escribe una pregunta sobre tu hotel y te responde con tus datos reales del hotel activo.", "Type a question about your hotel and it answers from the active hotel's real data."),
    clave: { titulo: t("Escribe aquí", "Type here"), cuerpo: t("Las sugerencias son un buen punto de partida.", "The suggestions are a good starting point."), objetivos: ["#contenido-principal textarea", "#contenido-principal input[type='text']"] },
  },
  recepcion: {
    ilu: "agenda",
    queT: t("Recepción: el día en el mostrador", "Front desk: the day at the counter"),
    que: t("Llegadas, salidas, huéspedes en casa y el rack de habitaciones con su estado de limpieza.", "Arrivals, departures, in-house guests and the room rack with its cleaning status."),
    clave: { titulo: t("Llegadas, salidas, en casa y rack", "Arrivals, departures, in-house and rack"), cuerpo: t("Cada pestaña es una lista del día; el rack muestra todas las habitaciones.", "Each tab is a list for the day; the rack shows every room.") },
    accion: { titulo: t("Check-in y check-out de un clic", "One-click check-in and check-out"), cuerpo: t("Desde cada llegada o salida; si falta registrar la identidad del huésped, la pantalla te avisa.", "From each arrival or departure; if the guest's ID isn't registered yet, the screen tells you.") },
  },
  reservas: {
    ilu: "agenda",
    queT: t("Reservas", "Reservations"),
    que: t("Las reservas del hotel con su estado, el cotizador y la lista de espera.", "The hotel's reservations with their status, the quote tool and the waitlist."),
    clave: { titulo: t("Solo los pasos válidos", "Only valid steps"), cuerpo: t("Cada reserva ofrece únicamente los cambios de estado que le tocan; cancelar pide confirmación.", "Each reservation only offers the status changes that apply to it; cancelling asks for confirmation.") },
    accion: { titulo: t("Nueva reserva", "New reservation"), cuerpo: t("Elige tipo de habitación, fechas y, si ya lo conoces, al huésped.", "Pick the room type, the dates and, if you know them, the guest.") },
  },
  conversaciones: {
    ilu: "chat",
    queT: t("Conversaciones: WhatsApp del hotel", "Conversations: the hotel's WhatsApp"),
    que: t("Lo que tus huéspedes platican con el agente por WhatsApp, con el hilo completo.", "What your guests talk about with the agent on WhatsApp, with the full thread."),
    clave: { titulo: t("Tomar y devolver", "Take over and hand back"), cuerpo: t("Mientras tengas una conversación, el agente no responde; «Devolver al agente» lo reactiva.", "While you hold a conversation the agent doesn't reply; “Hand back to agent” turns it on again.") },
  },
  housekeeping: {
    ilu: "tarjetas",
    queT: t("Housekeeping: limpieza por habitación", "Housekeeping: cleaning by room"),
    que: t("Tablero de limpieza, inspección, habitaciones fuera de servicio, turnos y reporte diario.", "Cleaning board, inspection, out-of-service rooms, shifts and daily report."),
    clave: { titulo: t("El tablero", "The board"), cuerpo: t("Cada habitación con su tarea: iniciar, terminar e inspeccionar según tu rol.", "Each room with its task: start, finish and inspect depending on your role.") },
  },
  mantenimiento: {
    ilu: "lista",
    queT: t("Mantenimiento: tickets correctivos", "Maintenance: repair tickets"),
    que: t("Los desperfectos reportados en el hotel: se crean, se siguen y se cierran con su costo real.", "Reported faults in the hotel: create, follow and close them with their real cost."),
    accion: { titulo: t("Nuevo ticket", "New ticket"), cuerpo: t("Reporta un desperfecto para que mantenimiento lo atienda.", "Report a fault so maintenance can handle it.") },
  },
  tickets: {
    ilu: "campana",
    queT: t("Tickets de huésped", "Guest tickets"),
    que: t("Peticiones y quejas de huéspedes con plazo de atención.", "Guest requests and complaints with a response deadline."),
    clave: { titulo: t("Activos, escalados y SLA", "Active, escalated and SLA"), cuerpo: t("Toma un ticket, ciérralo o escálalo a gerencia; las pestañas separan lo que urge.", "Take a ticket, close it or escalate it to management; the tabs separate what's urgent.") },
  },
  asistencia: {
    ilu: "agenda",
    queT: t("Asistencia: tu checador", "Attendance: your time clock"),
    que: t("Registra tu entrada y tu salida y revisa tus últimos registros.", "Clock in and out and review your latest records."),
    clave: { titulo: t("Administración de asistencia", "Attendance admin"), cuerpo: t("Dueño y gerente programan horarios, los cruzan contra lo trabajado y exportan el CSV para la STPS.", "Owner and manager schedule shifts, compare them with time worked and export the CSV for the STPS.") },
  },
  huespedes: {
    ilu: "equipo",
    queT: t("Huéspedes", "Guests"),
    que: t("Busca a cualquier huésped del hotel y abre su ficha.", "Search any guest of the hotel and open their profile."),
    clave: { titulo: t("La ficha del huésped", "The guest profile"), cuerpo: t("Historial de estancias, notas y preferencias, y consentimientos de privacidad.", "Stay history, notes and preferences, and privacy consents.") },
  },
  "pedidos-fnb": {
    ilu: "pedido",
    queT: t("Pedidos F&B con guardia de alergias", "F&B orders with allergy guard"),
    que: t("Pedidos de alimentos y bebidas de los huéspedes, con las alergias o restricciones que declaren.", "Guests' food and beverage orders, with any allergies or restrictions they declare."),
    clave: { titulo: t("Cocina confirma", "The kitchen confirms"), cuerpo: t("Con una alergia declarada, nadie le asegura al huésped que el platillo es seguro hasta que cocina lo confirma.", "With a declared allergy, nobody tells the guest a dish is safe until the kitchen confirms it.") },
    accion: { titulo: t("Toma un pedido", "Take an order"), cuerpo: t("Captura los platillos y declara cualquier alergia o restricción.", "Enter the dishes and declare any allergy or restriction.") },
  },
  reputacion: {
    ilu: "linea",
    queT: t("Reputación: reseñas y encuestas", "Reputation: reviews and surveys"),
    que: t("Reseñas y encuestas que capturas a mano; el texto se clasifica solo por sentimiento y temas. No se conecta a sitios de reseñas.", "Reviews and surveys you enter by hand; the text is classified by sentiment and topics. It doesn't connect to review sites."),
    clave: { titulo: t("Acciones sugeridas", "Suggested actions"), cuerpo: t("Una queja puede sugerir una acción, como abrir un ticket de mantenimiento; tú la ejecutas o la descartas.", "A complaint can suggest an action, like opening a maintenance ticket; you run it or dismiss it.") },
    accion: { titulo: t("Captura una reseña", "Enter a review"), cuerpo: t("Pega el texto de la reseña o encuesta y se clasifica al guardarla.", "Paste the review or survey text and it's classified on save.") },
  },
  identidad: {
    ilu: "escudo",
    queT: t("Identidad y registro migratorio", "Identity and immigration record"),
    que: t("Bóveda cifrada de documentos de huéspedes, purgas, registro migratorio y privacidad.", "Encrypted vault of guest documents, purges, immigration record and privacy."),
    clave: { titulo: t("Ver un documento deja rastro", "Viewing a document leaves a trail"), cuerpo: t("La lista solo muestra datos parciales; «Revelar» pide un motivo que queda en la bitácora.", "The list only shows partial data; “Reveal” asks for a reason that's logged.") },
  },
  grupos: {
    ilu: "equipo",
    queT: t("Grupos", "Groups"),
    que: t("Cotizaciones de grupo, bloqueo de cuartos con fecha de liberación, pickup y rooming list. Los anticipos se registran, aquí no se cobra.", "Group quotes, room blocks with release date, pickup and rooming list. Deposits are recorded; nothing is charged here."),
    clave: { titulo: t("Aceptar bloquea cuartos", "Accepting blocks rooms"), cuerpo: t("Si alguna noche no alcanza, no se retiene nada: sin sobreventa.", "If any night falls short, nothing is held: no overbooking.") },
  },
  pl: {
    ilu: "linea",
    queT: t("P&L: estado de resultados", "P&L: income statement"),
    que: t("Ingresos y gastos por departamento del periodo, hasta la utilidad, en formato USALI.", "Revenue and expenses by department for the period, down to profit, in USALI format."),
    clave: { titulo: t("Elige el periodo", "Pick the period"), cuerpo: t("El selector de arriba cambia el periodo de todo el estado de resultados.", "The selector at the top changes the period for the whole statement.") },
    accion: { titulo: t("Registra un gasto", "Record an expense"), cuerpo: t("Se suma al P&L del periodo en el departamento y la categoría que elijas.", "It's added to the period's P&L in the department and category you choose.") },
  },
  revenue: {
    ilu: "linea",
    queT: t("Revenue management", "Revenue management"),
    que: t("Cómo opera el motor de tarifas del hotel, sus backtests, recomendaciones y reglas de precio.", "How the hotel's rate engine runs, its backtests, recommendations and price rules."),
    clave: { titulo: t("Tú decides el modo", "You decide the mode"), cuerpo: t("El piloto automático pleno exige la aprobación explícita del dueño; aprobar una recomendación pide confirmación.", "Full autopilot requires the owner's explicit approval; approving a recommendation asks for confirmation.") },
  },
  cfdi: {
    ilu: "corte",
    queT: t("CFDI de hospedaje", "Lodging invoices (CFDI)"),
    que: t("Todos los comprobantes fiscales timbrados en este hotel, de cualquier folio.", "Every tax invoice stamped at this hotel, from any folio."),
    clave: { titulo: t("Timbrar va por folio", "Stamping is per folio"), cuerpo: t("Aquí consultas y cancelas; para timbrar, «Ir al folio» te lleva al folio correspondiente.", "Here you look up and cancel; to stamp, “Go to folio” takes you to the matching folio.") },
  },
  fraude: {
    ilu: "escudo",
    queT: t("Fraude interno", "Internal fraud"),
    que: t("Alertas sobre folios y cargos del hotel, generadas con reglas fijas, sin IA.", "Alerts on the hotel's folios and charges, generated with fixed rules, no AI."),
    clave: { titulo: t("Confirma o descarta", "Confirm or dismiss"), cuerpo: t("Cada alerta se resuelve con confirmación; confirmar un fraude no se deshace.", "Each alert is resolved with a confirmation; confirming fraud can't be undone.") },
    accion: { titulo: t("Ejecuta un escaneo", "Run a scan"), cuerpo: t("Revisa los folios y cargos en busca de patrones y deja las alertas en la cola.", "Checks folios and charges for patterns and leaves the alerts in the queue.") },
  },
  agentes: {
    ilu: "nodos",
    queT: t("Agentes del hotel", "The hotel's agents"),
    que: t("Cada agente con su estado, presupuesto y costo acumulado, más sus límites y plantillas de WhatsApp.", "Each agent with its status, budget and accumulated cost, plus its limits and WhatsApp templates."),
    clave: { titulo: t("Guardrails y políticas", "Guardrails and policies"), cuerpo: t("Topes de monto, palabras bloqueadas, horario de envío y qué acciones piden aprobación humana.", "Amount caps, blocked words, sending hours and which actions need human approval.") },
    accion: { titulo: t("Plantillas versionadas", "Versioned templates"), cuerpo: t("Una plantilla no se edita: corregirla crea una versión nueva que también se aprueba.", "A template isn't edited: correcting it creates a new version that's approved too.") },
  },
  aprobaciones: {
    ilu: "lista",
    queT: t("Aprobaciones", "Approvals"),
    que: t("Acciones sensibles que propone el agente, como descuentos, reembolsos o respuestas a reseñas, esperando a una persona.", "Sensitive actions the agent proposes, like discounts, refunds or review replies, waiting for a person."),
    clave: { titulo: t("Decide con motivo", "Decide with a reason"), cuerpo: t("Apruebas o rechazas con motivo; nadie aprueba lo que propuso y cada aprobación se usa una sola vez.", "You approve or reject with a reason; nobody approves what they proposed and each approval is used once.") },
  },
  catalogo: {
    ilu: "tarjetas",
    queT: t("Catálogo: habitaciones y tarifas", "Catalog: rooms and rates"),
    que: t("Tipos de habitación, habitaciones físicas, tarifas por rango de fechas y zona horaria del hotel.", "Room types, physical rooms, rates by date range and the hotel's time zone."),
    clave: { titulo: t("Sin tarifa no hay reserva", "No rate, no reservation"), cuerpo: t("Las reservas usan estas tarifas: da de alta tipo, habitaciones y tarifa antes de reservar.", "Reservations use these rates: add the type, rooms and rate before booking.") },
    accion: { titulo: t("Crea un tipo de habitación", "Create a room type"), cuerpo: t("Empieza por el tipo; luego sus habitaciones y su tarifa.", "Start with the type; then its rooms and its rate.") },
  },
  mensajeria: {
    ilu: "voz",
    queT: t("Mensajería: WhatsApp y voz", "Messaging: WhatsApp and voice"),
    que: t("El número de WhatsApp del hotel y la configuración del agente de voz.", "The hotel's WhatsApp number and the voice agent settings."),
    clave: { titulo: t("El secreto se muestra una vez", "The secret is shown once"), cuerpo: t("Al generar el secreto de voz guárdalo en ese momento: la pantalla no lo vuelve a mostrar.", "When you generate the voice secret, save it right away: the screen won't show it again.") },
  },
};

/** Recorrido corto por rol (5 pantallas; la primera, con su elemento clave). Las que el rol no tiene en su menú se omiten solas. */
export const ESENCIALES_HOTELES: Readonly<Record<string, readonly string[]>> = {
  owner: ["", "recepcion", "reservas", "pl", "aprobaciones"],
  gm: ["", "recepcion", "reservas", "pl", "aprobaciones"],
  frontdesk: ["", "recepcion", "reservas", "conversaciones", "tickets"],
  reservations: ["", "reservas", "conversaciones", "huespedes", "grupos"],
  housekeeping: ["", "housekeeping", "mantenimiento", "tickets", "asistencia"],
  maintenance: ["", "mantenimiento", "housekeeping", "tickets", "asistencia"],
  fnb: ["", "pedidos-fnb", "tickets", "mantenimiento", "asistencia"],
  accountant: ["", "pl", "cfdi", "revenue", "fraude"],
};

/** Respaldo: pantallas que todo rol de hoteles tiene en su menú. */
const ESENCIALES_COMUNES: readonly string[] = ["", "reservas", "tickets", "mantenimiento", "asistencia"];

export const esencialesHoteles = (rol: string): readonly string[] => ESENCIALES_HOTELES[rol] ?? ESENCIALES_COMUNES;
