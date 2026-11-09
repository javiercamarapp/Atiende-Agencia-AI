// ds3 «Guía» de citas: qué es cada pantalla, su elemento clave y su acción principal, en español e inglés. El recorrido en sí sale
// del menú real del rol (buildSections de CitasShell): owner/admin ven todo; staff ve lo mismo menos Copiloto (varias pantallas de
// gestión —Agente y Mensajes de WhatsApp, Staff, Auditoría, Privacidad, Primeros pasos— están en su menú pero la página le dice
// «sin acceso»: por eso su recorrido corto no pasa por ellas). Ningún texto promete algo que la pantalla no hace; ninguna cifra va escrita.
// Fuente: la cabecera y las etiquetas visibles de cada página en ./pages/ y el patrón de guia-restaurantes.ts.
import type { ContenidoConsola } from "@atiende/ui";

const t = (es: string, en: string) => ({ es, en });

export const GUIA_CITAS: ContenidoConsola = {
  resumen: {
    ilu: "barras",
    queT: t("Resumen: tu semana de citas", "Overview: your week of appointments"),
    que: t("Citas de hoy y de la semana, las que faltan por confirmar, las ausencias y los clientes nuevos de la sucursal activa.", "Today's and this week's appointments, the ones awaiting confirmation, no-shows and new customers for the active branch."),
    clave: {
      titulo: t("Cada cifra lleva a su pantalla", "Each number leads to its screen"),
      cuerpo: t("Toca una tarjeta para ver el detalle. Si un dato no está disponible, la tarjeta lo dice en vez de mostrar un cero.", "Tap a card to see the detail. If a number isn't available, the card says so instead of showing a zero."),
    },
    accion: { titulo: t("Ve a la agenda", "Go to the schedule"), cuerpo: t("El botón «Ver agenda» te lleva directo a las citas.", "The “View schedule” button takes you straight to the appointments.") },
  },
  copiloto: {
    ilu: "chat",
    queT: t("Copiloto: pregúntale a tus datos", "Copilot: ask your data"),
    que: t("Escribe una pregunta sobre tus citas, servicios o profesionales y te responde con los datos reales de tu negocio.", "Ask a question about your appointments, services or providers and it answers from your business's real data."),
    clave: { titulo: t("Escribe aquí", "Type here"), cuerpo: t("Solo dueño y administrador lo usan; las sugerencias son un buen punto de partida.", "Only owner and admin use it; the suggestions are a good starting point."), objetivos: ["#contenido-principal textarea", "#contenido-principal input[type='text']"] },
  },
  agenda: {
    ilu: "agenda",
    queT: t("Agenda: todas tus citas", "Schedule: all your appointments"),
    que: t("Las citas reales por semana o por mes, agrupadas por día, con su profesional, servicio y estado.", "Real appointments by week or month, grouped by day, with their provider, service and status."),
    clave: { titulo: t("Cada cita según su estado", "Each appointment by status"), cuerpo: t("Desde la cita la confirmas, la completas, la marcas como no-show o la cancelas. Reagendar lo hace el agente.", "From the appointment you confirm it, complete it, mark it as a no-show or cancel it. Rescheduling is done by the agent.") },
    accion: { titulo: t("Crea una cita a mano", "Create an appointment by hand"), cuerpo: t("«Nueva cita» registra la misma cita que tomaría el agente; también puedes avisar a la lista de espera cuando se libera un horario.", "“New appointment” records the same booking the agent would; you can also notify the waitlist when a slot frees up.") },
  },
  avisos: {
    ilu: "campana",
    queT: t("Avisos: lo que pide a una persona", "Alerts: what needs a person"),
    que: t("Citas por confirmar, cómo van los recordatorios y las escalaciones que necesitan seguimiento.", "Appointments awaiting confirmation, how reminders are doing and escalations that need follow-up."),
    clave: { titulo: t("Tres bloques", "Three blocks"), cuerpo: t("Por confirmar lo ve todo el equipo; los recordatorios y las escalaciones solo dueño y administrador.", "Awaiting confirmation is visible to the whole team; reminders and escalations only to owner and admin.") },
    accion: { titulo: t("Deja una nota de seguimiento", "Leave a follow-up note"), cuerpo: t("En cada escalación anotas qué se hizo, para que el resto del equipo lo sepa.", "On each escalation you note what was done so the rest of the team knows.") },
  },
  "primeros-pasos": {
    ilu: "lista",
    queT: t("Primeros pasos", "Getting started"),
    que: t("Lo que falta para recibir citas, calculado con tus datos reales.", "What's left before you can take appointments, calculated from your real data."),
    clave: { titulo: t("Listo para recibir citas", "Ready for appointments"), cuerpo: t("La reserva en línea se abre cuando los pasos requeridos están hechos; los opcionales los puedes posponer.", "Online booking opens once the required steps are done; optional ones can be postponed.") },
    accion: { titulo: t("Abre cada paso", "Open each step"), cuerpo: t("Cada paso tiene un enlace a la pantalla donde se resuelve.", "Each step links to the screen where you complete it.") },
  },
  proveedores: {
    ilu: "equipo",
    queT: t("Proveedores: quién atiende", "Providers: who serves"),
    que: t("Las personas que dan las citas, con su rol y los servicios que ofrece cada una.", "The people who take appointments, with their role and the services each one offers."),
    clave: { titulo: t("Calendarios conectados", "Connected calendars"), cuerpo: t("En la ficha conectas Google Calendar, Cal.com o CalDAV y pruebas la conexión.", "In the profile you connect Google Calendar, Cal.com or CalDAV and test the connection.") },
    accion: { titulo: t("Crea un proveedor", "Create a provider"), cuerpo: t("Dale nombre y rol, y marca qué servicios ofrece.", "Give them a name and role, and check which services they offer.") },
  },
  servicios: {
    ilu: "tarjetas",
    queT: t("Servicios: lo que ofreces", "Services: what you offer"),
    que: t("Cada servicio con su duración y su precio. El agente ofrece los que están activos.", "Each service with its duration and price. The agent offers the active ones."),
    clave: { titulo: t("Duración y colchones", "Duration and buffers"), cuerpo: t("Además de la duración puedes dejar un colchón antes y después; el precio es opcional.", "Besides the duration you can leave a buffer before and after; the price is optional.") },
    accion: { titulo: t("Crea un servicio", "Create a service"), cuerpo: t("Ponle nombre y duración; luego asígnalo a sus proveedores.", "Give it a name and duration; then assign it to its providers.") },
  },
  clientes: {
    ilu: "equipo",
    queT: t("Clientes: tu cartera", "Customers: your book"),
    que: t("Quién reserva contigo. Se arma sola con cada cita; aquí no se dan de alta clientes a mano.", "Who books with you. It builds itself from each appointment; customers aren't created by hand here."),
    clave: { titulo: t("Busca y abre la ficha", "Search and open the profile"), cuerpo: t("Busca por nombre o teléfono y abre un cliente para ver sus próximas citas.", "Search by name or phone and open a customer to see their upcoming appointments.") },
    accion: { titulo: t("Agrega su correo", "Add their email"), cuerpo: t("En la ficha puedes guardar el correo del cliente para sincronizar sus citas con Cal.com.", "In the profile you can save the customer's email to sync their appointments with Cal.com.") },
  },
  disponibilidad: {
    ilu: "agenda",
    queT: t("Disponibilidad: cuándo se puede reservar", "Availability: when people can book"),
    que: t("El horario semanal de cada proveedor. Sin horario no hay espacios que ofrecer.", "Each provider's weekly hours. Without hours there are no slots to offer."),
    clave: { titulo: t("Excepciones por día", "Day exceptions"), cuerpo: t("Cierra un día completo o cambia su horario (vacaciones, un festivo) sin tocar el horario semanal.", "Close a whole day or change its hours (vacation, a holiday) without touching the weekly schedule.") },
    accion: { titulo: t("Agrega un horario", "Add hours"), cuerpo: t("Elige el proveedor, el día y el rango de horas.", "Pick the provider, the day and the time range.") },
  },
  conversaciones: {
    ilu: "chat",
    queT: t("Conversaciones: WhatsApp", "Conversations: WhatsApp"),
    que: t("Lo que tus clientes platican con el agente por WhatsApp, con sus mensajes y notas internas.", "What your customers talk about with the agent on WhatsApp, with messages and internal notes."),
    clave: { titulo: t("Tomar y devolver", "Take over and hand back"), cuerpo: t("Al tomar una conversación el agente deja de responder; al devolverla vuelve a contestar él.", "When you take over a conversation the agent stops replying; when you hand it back it answers again.") },
    accion: { titulo: t("Responde por WhatsApp", "Reply on WhatsApp"), cuerpo: t("Fuera de la ventana de WhatsApp necesitas una plantilla aprobada; la pantalla te avisa.", "Outside WhatsApp's window you need an approved template; the screen tells you.") },
  },
  "agente-whatsapp": {
    ilu: "chat",
    queT: t("Agente de WhatsApp", "WhatsApp agent"),
    que: t("El número de tu negocio y la personalidad del agente: nombre, tono, bienvenida y reglas.", "Your business number and the agent's personality: name, tone, greeting and rules."),
    clave: { titulo: t("Reglas de tu negocio", "Your business rules"), cuerpo: t("Escribe lo que el agente nunca debe hacer o siempre debe pedir; puedes volver a los valores por defecto.", "Write what the agent must never do or must always ask; you can go back to the defaults.") },
    accion: { titulo: t("Revisa antes de guardar", "Review before saving"), cuerpo: t("La vista previa te muestra qué cambia; el agente lo usa desde su siguiente mensaje.", "The preview shows what changes; the agent uses it from its next message.") },
  },
  "mensajes-whatsapp": {
    ilu: "campana",
    queT: t("Mensajes de WhatsApp", "WhatsApp messages"),
    que: t("Los textos de recordatorio, confirmación, cancelación y reagendado, con cuánto antes y en qué horario se envían.", "The reminder, confirmation, cancellation and reschedule texts, plus how early and in which hours they're sent."),
    clave: { titulo: t("Historial de cambios", "Change history"), cuerpo: t("Cada cambio queda guardado y puedes volver a los valores por defecto.", "Every change is saved and you can go back to the defaults.") },
    accion: { titulo: t("Registra tus plantillas de Meta", "Register your Meta templates"), cuerpo: t("Anota la plantilla que Meta te aprobó; la aprobación se hace en Meta, aquí solo se registra.", "Enter the template Meta approved; approval happens in Meta, here it's only recorded.") },
  },
  configuracion: {
    ilu: "panel",
    queT: t("Configuración del negocio", "Business settings"),
    que: t("Rubro, zona horaria y teléfono de aviso urgente, más la conexión con Google Calendar de cada proveedor.", "Business type, time zone and urgent-alert phone, plus each provider's Google Calendar connection."),
    clave: { titulo: t("Google Calendar por proveedor", "Google Calendar per provider"), cuerpo: t("Cada proveedor muestra si está conectado o si su conexión tiene error.", "Each provider shows whether it's connected or its connection has an error.") },
    accion: { titulo: t("Guarda los datos del negocio", "Save business details"), cuerpo: t("Cambia el rubro, la zona horaria o el teléfono y guarda.", "Change the business type, time zone or phone and save.") },
  },
  staff: {
    ilu: "equipo",
    queT: t("Staff: tu equipo", "Staff: your team"),
    que: t("Quién tiene acceso al panel y las invitaciones pendientes.", "Who has access to the panel and pending invitations."),
    clave: { titulo: t("Invitaciones pendientes", "Pending invitations"), cuerpo: t("Ves el estado de cada invitación y puedes revocar una que siga pendiente.", "You see each invitation's status and can revoke one that's still pending.") },
    accion: { titulo: t("Invita a alguien", "Invite someone"), cuerpo: t("Solo dueño y administrador invitan; cada quien entra con su propia cuenta.", "Only owner and admin invite; each person signs in with their own account.") },
  },
  auditoria: {
    ilu: "escudo",
    queT: t("Auditoría", "Audit log"),
    que: t("Quién cambió qué y cuándo: servicios, cancelaciones, horarios y staff.", "Who changed what and when: services, cancellations, hours and staff."),
    clave: { titulo: t("Antes y después", "Before and after"), cuerpo: t("Filtra por tipo; cada fila muestra quién, cuándo y el valor anterior y nuevo.", "Filter by type; each row shows who, when and the old and new value.") },
  },
  privacidad: {
    ilu: "escudo",
    queT: t("Privacidad", "Privacy"),
    que: t("Las solicitudes de tus clientes para ver, corregir o borrar sus datos, que abren por WhatsApp.", "Customer requests to see, correct or delete their data, opened via WhatsApp."),
    clave: { titulo: t("Plazos de cada solicitud", "Each request's deadline"), cuerpo: t("Filtra por estado o derecho; los plazos son una referencia operativa, no asesoría legal.", "Filter by status or right; the deadlines are an operational reference, not legal advice.") },
    accion: { titulo: t("Avanza su estado", "Move its status forward"), cuerpo: t("Cambia el estado de cada solicitud conforme la atiendes.", "Change each request's status as you handle it.") },
  },
};

/** Recorrido corto por rol (5 pantallas). Staff no pasa por pantallas que su rol no puede usar. */
export const ESENCIALES_CITAS: Readonly<Record<string, readonly string[]>> = {
  owner: ["resumen", "agenda", "servicios", "disponibilidad", "primeros-pasos"],
  admin: ["resumen", "agenda", "servicios", "disponibilidad", "primeros-pasos"],
  staff: ["resumen", "agenda", "avisos", "clientes", "conversaciones"],
};

export const esencialesCitas = (rol: string): readonly string[] => ESENCIALES_CITAS[rol] ?? ESENCIALES_CITAS.staff!;
