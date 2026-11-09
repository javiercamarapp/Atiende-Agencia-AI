// ds3 «Guía» de rentas: qué es cada pantalla, su elemento clave y su acción principal, en español e inglés. El recorrido en sí sale
// del menú real del rol (buildSections de RentasShell): todos los roles ven el mismo menú salvo Copiloto (admin_gestora y contador) y
// las dos de Privacidad (solo admin_gestora); cada página gatea su propio contenido por rol, así que el recorrido corto de cada rol
// pasa solo por las pantallas que su rol de verdad usa. El rol `limpieza` no tiene Resumen (la página lo manda a «Mis tareas»), por eso
// su recorrido excluye la raíz (`excluirRentas`). Ningún texto promete algo que la pantalla no hace; ninguna cifra va escrita.
// Fuente: la cabecera y las etiquetas visibles de cada página en ./pages/ y el patrón de guia-restaurantes.ts.
import type { ContenidoConsola } from "@atiende/ui";

const t = (es: string, en: string) => ({ es, en });

export const GUIA_RENTAS: ContenidoConsola = {
  "": {
    ilu: "barras",
    queT: t("Resumen: tu operación de hoy", "Overview: today's operation"),
    que: t("Llegadas y salidas del día, ocupación del mes, borradores por aprobar, tareas y conflictos de calendario de la propiedad activa.", "Today's arrivals and departures, monthly occupancy, drafts to approve, tasks and calendar conflicts for the active property."),
    clave: {
      titulo: t("Cada cifra lleva a su pantalla", "Each number leads to its screen"),
      cuerpo: t("Toca una tarjeta para ver el detalle. Si un dato no está disponible, la tarjeta lo dice en vez de inventarlo.", "Tap a card to see the detail. If a number isn't available, the card says so instead of making it up."),
    },
    accion: { titulo: t("Atajos de arriba", "Shortcuts at the top"), cuerpo: t("«Ver aprobaciones», «Ver calendario» y «Ver reportes» te llevan directo a lo que pide atención.", "“View approvals”, “View calendar” and “View reports” take you straight to what needs attention.") },
  },
  copiloto: {
    ilu: "chat",
    queT: t("Copiloto: pregúntale a tus datos", "Copilot: ask your data"),
    que: t("Escribe una pregunta sobre tus reservas, ocupación o ingresos y te responde con los datos reales de la propiedad.", "Ask about your bookings, occupancy or revenue and it answers from the property's real data."),
    clave: { titulo: t("Escribe aquí", "Type here"), cuerpo: t("Lo usan la administración y el contador; las sugerencias son un buen punto de partida.", "Management and the accountant use it; the suggestions are a good starting point."), objetivos: ["#contenido-principal textarea", "#contenido-principal input[type='text']"] },
  },
  calendario: {
    ilu: "agenda",
    queT: t("Calendario: reservas y bloqueos", "Calendar: bookings and blocks"),
    que: t("Las reservas de cada canal y los bloqueos de cada unidad, en vista de calendario o de lista.", "Each channel's bookings and each unit's blocks, in calendar or list view."),
    clave: { titulo: t("Elige la unidad", "Pick the unit"), cuerpo: t("Todo lo que ves es de la unidad seleccionada: sus reservas, sus bloqueos y sus fechas.", "Everything shown belongs to the selected unit: its bookings, blocks and dates.") },
    accion: { titulo: t("Crea una reserva directa o un bloqueo", "Create a direct booking or a block"), cuerpo: t("Las reservas directas se pueden mover de fecha o cancelar; cancelar pide confirmación y no se deshace.", "Direct bookings can be moved or cancelled; cancelling asks for confirmation and can't be undone.") },
  },
  aprobaciones: {
    ilu: "chat",
    queT: t("Aprobaciones: nada sale sin ti", "Approvals: nothing goes out without you"),
    que: t("Los borradores que el agente redactó para tus huéspedes esperan aquí a que alguien los revise.", "Drafts the agent wrote for your guests wait here for someone to review them."),
    clave: { titulo: t("Primero lo pendiente", "Pending first"), cuerpo: t("Las conversaciones con algo por revisar van arriba; filtra por canal o busca.", "Conversations with something to review go on top; filter by channel or search.") },
    accion: { titulo: t("Aprueba o rechaza", "Approve or reject"), cuerpo: t("Aprobar envía el texto tal como lo ves; rechazar pide un motivo.", "Approving sends the text as you see it; rejecting asks for a reason.") },
  },
  "mis-tareas": {
    ilu: "lista",
    queT: t("Mis tareas: limpieza y mantenimiento", "My tasks: cleaning and maintenance"),
    que: t("Tus tareas asignadas y la cola sin asignar, con el checklist de cada una.", "Your assigned tasks and the unassigned queue, with each one's checklist."),
    clave: { titulo: t("Checklist de la tarea", "Task checklist"), cuerpo: t("Marca cada punto al hacerlo y completa la tarea; si usaste insumos, regístralos al completar.", "Check off each item as you do it and complete the task; if you used supplies, record them on completion.") },
    accion: { titulo: t("Asígnate o reporta una incidencia", "Take a task or report an issue"), cuerpo: t("«Asignarme» toma una tarea de la cola; «Reportar incidencia» deja constancia de un problema en la unidad.", "“Assign to me” takes a task from the queue; “Report issue” records a problem in the unit.") },
  },
  plantillas: {
    ilu: "tarjetas",
    queT: t("Plantillas y automatizaciones", "Templates and automations"),
    que: t("Los mensajes para tus huéspedes y qué plantilla se usa en cada evento: antes de llegar, entrada, salida y reseña.", "Messages for your guests and which template is used at each event: pre-arrival, check-in, check-out and review."),
    clave: { titulo: t("Aprobada para programarse", "Approved before scheduling"), cuerpo: t("Una plantilla solo se puede programar si está aprobada; si cambias el texto, deja de estarlo.", "A template can only be scheduled once approved; editing the text removes the approval.") },
    accion: { titulo: t("Crea una plantilla", "Create a template"), cuerpo: t("Los mensajes automáticos no se envían solos: quedan como borradores en Aprobaciones.", "Automatic messages aren't sent on their own: they become drafts in Approvals.") },
  },
  "acceso-huesped": {
    ilu: "escudo",
    queT: t("Acceso al huésped", "Guest access"),
    que: t("Cuándo se le mandan al huésped las instrucciones de acceso, como el código de la cerradura y la dirección exacta.", "When the guest gets the access instructions, like the lock code and exact address."),
    clave: { titulo: t("Política de liberación", "Release policy"), cuerpo: t("Decide si se liberan solas y si exigen pago confirmado; apagada, no se envía nada.", "Decide whether they're released automatically and whether they require confirmed payment; off, nothing is sent.") },
    accion: { titulo: t("Instrucciones por unidad", "Instructions per unit"), cuerpo: t("Escribe las instrucciones de cada unidad y marca como pagadas las reservas directas; la bitácora muestra cada envío.", "Write each unit's instructions and mark direct bookings as paid; the log shows every send.") },
  },
  "ical-sync": {
    ilu: "importar",
    queT: t("Sincronización iCal", "iCal sync"),
    que: t("Conecta el calendario de Airbnb, Booking o Vrbo de cada unidad para evitar dobles reservas entre canales.", "Connect each unit's Airbnb, Booking or Vrbo calendar to avoid double bookings across channels."),
    clave: { titulo: t("Tu propio feed", "Your own feed"), cuerpo: t("Copia la dirección del calendario de la unidad para pegarla en cada canal.", "Copy the unit's calendar address to paste into each channel.") },
    accion: { titulo: t("Conecta un canal", "Connect a channel"), cuerpo: t("Pega la dirección del calendario que te da el canal; desconectar pide confirmación.", "Paste the calendar address the channel gives you; disconnecting asks for confirmation.") },
  },
  "monitor-sync": {
    ilu: "campana",
    queT: t("Monitor de conflictos", "Conflict monitor"),
    que: t("De un vistazo, el estado de cada canal conectado, las alertas abiertas y las reservas que se cruzan.", "At a glance, each connected channel's status, open alerts and overlapping bookings."),
    clave: { titulo: t("Tú decides cada conflicto", "You decide each conflict"), cuerpo: t("El sistema nunca cancela una reserva por su cuenta; cada conflicto guarda su historial.", "The system never cancels a booking on its own; each conflict keeps its history.") },
    accion: { titulo: t("Resuelve o ignora con motivo", "Resolve or ignore with a reason"), cuerpo: t("«Marcar resuelto» solo procede si el cruce ya no existe; si no, ignóralo explicando por qué.", "“Mark resolved” only works if the overlap is gone; otherwise ignore it and explain why.") },
  },
  precios: {
    ilu: "linea",
    queT: t("Precios", "Pricing"),
    que: t("Cotiza una estancia por fechas y canal, y revisa la configuración de precios de cada unidad.", "Quote a stay by dates and channel, and review each unit's pricing setup."),
    clave: { titulo: t("Cotizador", "Quote tool"), cuerpo: t("Cualquier persona del equipo puede cotizar; elige la unidad y las fechas.", "Anyone on the team can get a quote; pick the unit and the dates.") },
    accion: { titulo: t("Ajusta la configuración", "Adjust the setup"), cuerpo: t("Solo la administración de la gestora edita o borra la configuración; los demás la ven en solo lectura.", "Only the property manager's admin edits or deletes the setup; others see it read-only.") },
  },
  finanzas: {
    ilu: "corte",
    queT: t("Finanzas", "Finances"),
    que: t("El movimiento de cada reserva, los estados de cuenta de tus propietarios y la conciliación de lo que pagan los canales.", "Each booking's transactions, your owners' statements and reconciliation of what channels pay out."),
    clave: { titulo: t("Estados de cuenta por propietario", "Statements per owner"), cuerpo: t("Ingresos, comisiones, gastos e impuestos de cada propietario en un solo documento.", "Each owner's revenue, commissions, expenses and taxes in one document.") },
    accion: { titulo: t("Genera un estado de cuenta o importa un pago", "Generate a statement or import a payout"), cuerpo: t("El contador consulta; registrar y generar es de la administración de la gestora.", "The accountant reviews; recording and generating is for the property manager's admin.") },
  },
  reportes: {
    ilu: "barras",
    queT: t("Reportes de ocupación e ingresos", "Occupancy and revenue reports"),
    que: t("Ocupación, noches, llegadas e ingresos por unidad, propietario, canal y mes. Sin periodo, muestra el mes en curso.", "Occupancy, nights, arrivals and revenue by unit, owner, channel and month. With no period, it shows the current month."),
    clave: { titulo: t("Nada se cuenta dos veces", "Nothing is counted twice"), cuerpo: t("Las reservas que cruzan meses se reparten por noche.", "Bookings that span months are split by night.") },
    accion: { titulo: t("Exporta", "Export"), cuerpo: t("Descarga el reporte en CSV para Excel o en PDF.", "Download the report as CSV for Excel or as PDF.") },
  },
  catalogo: {
    ilu: "mapa",
    queT: t("Catálogo: propiedades y unidades", "Catalog: properties and units"),
    que: t("Tus propiedades, sus unidades y sus propietarios, con zona horaria, moneda y estancia mínima.", "Your properties, their units and owners, with time zone, currency and minimum stay."),
    clave: { titulo: t("Moneda de la propiedad", "Property currency"), cuerpo: t("Si la propiedad ya tiene movimientos, no se puede cambiar su moneda: mezclaría sus reportes.", "If the property already has transactions, its currency can't change: it would mix its reports.") },
    accion: { titulo: t("Agrega una unidad o un propietario", "Add a unit or an owner"), cuerpo: t("Solo la administración de la gestora edita; los demás roles ven el catálogo en solo lectura.", "Only the property manager's admin edits; other roles see the catalog read-only.") },
  },
  equipo: {
    ilu: "equipo",
    queT: t("Equipo", "Team"),
    que: t("Quién trabaja en la gestora, con qué rol, y las invitaciones pendientes.", "Who works at the property manager, with which role, and pending invitations."),
    clave: { titulo: t("Roles", "Roles"), cuerpo: t("Administración, operadores, contador y limpieza: cada quien ve y hace solo lo de su rol.", "Admin, operators, accountant and cleaning: each one sees and does only what their role allows.") },
    accion: { titulo: t("Invita a alguien", "Invite someone"), cuerpo: t("Cambiar un rol, revocar o dar de baja siempre pide confirmación.", "Changing a role, revoking or removing someone always asks for confirmation.") },
  },
  auditoria: {
    ilu: "escudo",
    queT: t("Auditoría", "Audit log"),
    que: t("Quién cambió qué y cuándo: precios, reservas, pagos, estados de cuenta y canales.", "Who changed what and when: prices, bookings, payouts, statements and channels."),
    clave: { titulo: t("Antes y después", "Before and after"), cuerpo: t("Filtra por tipo; cada fila muestra quién, cuándo y el valor anterior y nuevo.", "Filter by type; each row shows who, when and the old and new value.") },
  },
  privacidad: {
    ilu: "escudo",
    queT: t("Privacidad", "Privacy"),
    que: t("Las solicitudes de huéspedes y propietarios para ver, corregir o borrar sus datos.", "Guest and owner requests to see, correct or delete their data."),
    clave: { titulo: t("Plazos de cada solicitud", "Each request's deadline"), cuerpo: t("Filtra por estado; los plazos son una referencia operativa, no asesoría legal.", "Filter by status; the deadlines are an operational reference, not legal advice.") },
    accion: { titulo: t("Registra una solicitud", "Record a request"), cuerpo: t("Llegan por correo, teléfono o en persona: regístrala aquí y avanza su estado.", "They come by email, phone or in person: record it here and move its status forward.") },
  },
  "privacidad-organizacion": {
    ilu: "escudo",
    queT: t("Privacidad de la organización", "Organization privacy"),
    que: t("Retención, purgas, aviso de privacidad y solicitudes de todas tus áreas en un solo lugar.", "Retention, purges, privacy notice and requests across all your areas in one place."),
    clave: { titulo: t("Plazos de cada solicitud", "Each request's deadline"), cuerpo: t("Las solicitudes muestran cuánto falta para responderlas.", "Requests show how long you have left to answer them.") },
  },
};

/** Recorrido corto por rol (hasta 5 pantallas): solo las que ese rol de verdad usa. */
export const ESENCIALES_RENTAS: Readonly<Record<string, readonly string[]>> = {
  admin_gestora: ["", "calendario", "aprobaciones", "finanzas", "catalogo"],
  "operador:acceso_total": ["", "calendario", "aprobaciones", "acceso-huesped", "mis-tareas"],
  "operador:calendario_mensajeria": ["", "calendario", "aprobaciones", "plantillas", "monitor-sync"],
  "operador:solo_calendario": ["", "calendario", "monitor-sync", "ical-sync", "precios"],
  contador: ["", "finanzas", "reportes", "copiloto", "precios"],
  // Limpieza solo opera «Mis tareas» y lee el Calendario: su recorrido corto son esas dos pantallas (4 pasos con el cierre).
  limpieza: ["mis-tareas", "calendario"],
};

export const esencialesRentas = (rol: string): readonly string[] => ESENCIALES_RENTAS[rol] ?? ESENCIALES_RENTAS["operador:solo_calendario"]!;

/** Limpieza no tiene Resumen (la página la redirige a «Mis tareas»): un paso «ir» a la raíz nunca llegaría. */
export const excluirRentas = (rol: string): readonly string[] | undefined => (rol === "limpieza" ? [""] : undefined);
