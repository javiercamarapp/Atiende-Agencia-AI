// ds3 «Guía» de la consola de plataforma (superadmin): qué es cada pantalla, su elemento clave y su acción principal, en español e
// inglés. El recorrido sale del menú real (`SECTIONS` de SuperAdminShell, que a su vez sale de rutas.ts); el contenido va por ruta
// relativa a `/superadmin` ("" = el Resumen). Ningún texto promete algo que la pantalla no hace; ninguna cifra va escrita.
import type { ContenidoConsola } from "@atiende/ui";

const t = (es: string, en: string) => ({ es, en });

export const GUIA_SUPERADMIN: ContenidoConsola = {
  "": {
    ilu: "barras",
    queT: t("Resumen: la plataforma hoy", "Overview: the platform today"),
    que: t("MRR, operaciones y costo de IA por día, conversaciones por vertical, actividad de los agentes y la lista de organizaciones.", "MRR, operations and AI cost per day, conversations by vertical, agent activity and the list of organizations."),
    clave: { titulo: t("Cada bloque carga por separado", "Each block loads on its own"), cuerpo: t("Si una fuente falla, solo ese bloque muestra el error; un dato sin medir se ve «—» con su motivo.", "If a source fails, only that block shows the error; an unmeasured figure shows «—» with its reason.") },
  },
  copiloto: {
    ilu: "chat",
    queT: t("Copiloto: pregúntale a la plataforma", "Copilot: ask the platform"),
    que: t("El chat con los datos de la plataforma en pantalla completa. También lo abres desde cualquier pantalla con Cmd+J.", "The chat with the platform's data in full screen. You can also open it from any screen with Cmd+J."),
  },
  agentes: {
    ilu: "nodos",
    queT: t("Panel de agentes", "Agents panel"),
    que: t("Cada agente de la plataforma con su estado, disparador, éxito y costo reciente, más la bitácora de corridas.", "Every platform agent with its status, trigger, recent success and cost, plus the run log."),
    clave: { titulo: t("Abre una corrida", "Open a run"), cuerpo: t("Cada corrida reciente abre su traza para ver qué hizo y dónde falló.", "Each recent run opens its trace to see what it did and where it failed.") },
    accion: { titulo: t("Detén un agente", "Stop an agent"), cuerpo: t("Pide un motivo, tu código MFA y una confirmación; cancelar nunca ejecuta nada.", "It asks for a reason, your MFA code and a confirmation; cancelling never runs anything.") },
  },
  "agente-extractor": {
    ilu: "importar",
    queT: t("Agente extractor", "Extractor agent"),
    que: t("Ficha de solo lectura: documentos extraídos, llamadas al modelo, costo y desglose por vertical.", "Read-only profile: extracted documents, model calls, cost and breakdown by vertical."),
  },
  "agente-conciliacion": {
    ilu: "corte",
    queT: t("Agente de conciliación", "Reconciliation agent"),
    que: t("Ficha de solo lectura del agente de conciliación: actividad, llamadas al modelo y costo.", "Read-only profile of the reconciliation agent: activity, model calls and cost."),
  },
  "agente-whatsapp": {
    ilu: "voz",
    queT: t("Agente de WhatsApp y voz", "WhatsApp and voice agent"),
    que: t("Ficha de solo lectura: conversaciones, escaladas, minutos y costo de voz, y costo por modelo.", "Read-only profile: conversations, escalations, voice minutes and cost, and cost per model."),
    clave: { titulo: t("Para detenerlo, ve a Interruptores", "To stop it, go to Kill switches"), cuerpo: t("Las fichas no cambian nada; la palanca de cada agente vive en el Panel de agentes y en Interruptores.", "Profiles don't change anything; each agent's switch lives in the Agents panel and in Kill switches.") },
  },
  "model-ops": {
    ilu: "panel",
    queT: t("Model Ops", "Model Ops"),
    que: t("Una ficha por rol del gateway de modelos: modelo, proveedores, llamadas, costo y respaldo.", "One profile per model gateway role: model, providers, calls, cost and fallback."),
    clave: { titulo: t("Solo lectura", "Read-only"), cuerpo: t("Aquí no se cambian modelos: eso se hace con la configuración y un despliegue.", "Models aren't changed here: that's done through configuration and a deploy.") },
  },
  acciones: {
    ilu: "lista",
    queT: t("Acciones: con confirmación", "Actions: with confirmation"),
    que: t("Acciones sugeridas y automatizaciones de la plataforma. Nada con efecto real corre sin un segundo clic.", "Suggested actions and platform automations. Nothing with a real effect runs without a second click."),
    clave: { titulo: t("Pendientes de confirmar", "Waiting for confirmation"), cuerpo: t("Cada acción creada espera aquí; al confirmar ves el texto real de su efecto.", "Each created action waits here; when confirming you see the real text of its effect.") },
    accion: { titulo: t("Crea una acción", "Create an action"), cuerpo: t("Primero se crea y después se confirma o se cancela.", "First it's created, then confirmed or cancelled.") },
  },
  cerebro: {
    ilu: "tarjetas",
    queT: t("Cerebro de ventas", "Sales brain"),
    que: t("Prospectos con su score y el porqué punto por punto. El cerebro propone; esta pantalla no contacta a nadie.", "Prospects with their score and the reason point by point. The brain proposes; this screen doesn't contact anyone."),
    clave: { titulo: t("Abre el detalle", "Open the detail"), cuerpo: t("Cada fila despliega sus barras de score, la evidencia con fuente y fecha, y lo que falta si hay poca señal.", "Each row expands its score bars, the evidence with source and date, and what's missing if signal is thin.") },
    accion: { titulo: t("Da de alta un prospecto", "Add a prospect"), cuerpo: t("Captura el negocio; después cambias su etapa y cada cambio queda en su línea de tiempo.", "Enter the business; then change its stage and each change is kept on its timeline.") },
  },
  "mapa-prospectos": {
    ilu: "mapa",
    queT: t("Mapa de prospectos", "Prospects map"),
    que: t("Tu cartera de prospectos sobre el mapa de México, cada uno del color de su vertical.", "Your prospect book on the map of Mexico, each one in its vertical's color."),
    clave: { titulo: t("Filtra y acércate", "Filter and zoom in"), cuerpo: t("Filtra por vertical o etapa y toca un estado para bajar hasta el nivel de calle.", "Filter by vertical or stage and tap a state to go down to street level.") },
  },
  organizaciones: {
    ilu: "equipo",
    queT: t("Organizaciones", "Organizations"),
    que: t("Cada cliente con su vertical, estado, plan, operaciones, costo de IA, margen y avance de onboarding.", "Every client with its vertical, status, plan, operations, AI cost, margin and onboarding progress."),
    clave: { titulo: t("Entrar y Ficha", "Enter and Profile"), cuerpo: t("«Ficha» abre la vista completa de la organización; «Entrar» abre una impersonación de solo lectura con motivo.", "«Profile» opens the organization's full view; «Enter» opens a read-only impersonation with a reason.") },
    accion: { titulo: t("Pestaña Gestión", "Management tab"), cuerpo: t("Alta, suspensión, reactivación y cambio de plan, con doble control y código MFA.", "Create, suspend, reactivate and change plan, with dual control and an MFA code.") },
  },
  "costos-facturacion": {
    ilu: "linea",
    queT: t("Costos y facturación", "Costs and billing"),
    que: t("Gasto histórico de IA y costo por operación arriba; abajo, pestañas de facturación, costos y margen, P&L por vertical y contratos.", "Historical AI spend and cost per operation on top; below, tabs for billing, costs and margin, P&L by vertical and contracts."),
  },
  "consumo-ia": {
    ilu: "barras",
    queT: t("Consumo de IA", "AI usage"),
    que: t("Gasto por día, topes, organizaciones y el gasto de hoy de cada rol o agente contra su techo diario.", "Spend per day, caps, organizations and today's spend of each role or agent against its daily ceiling."),
    clave: { titulo: t("Alertas de consumo", "Usage alerts"), cuerpo: t("Señala roles sin techo, roles que caen mucho al respaldo y organizaciones cerca de su tope.", "Flags roles without a ceiling, roles that fall back often and organizations close to their cap.") },
  },
  ejecutivo: {
    ilu: "linea",
    queT: t("Ejecutivo / Board", "Executive / Board"),
    que: t("El MRR contra la meta, gasto de IA, organizaciones, operaciones y el tablero CFO.", "MRR against the goal, AI spend, organizations, operations and the CFO dashboard."),
    clave: { titulo: t("Lo que aún no puede mostrar", "What it can't show yet"), cuerpo: t("Al final, cada hueco dice qué falta y qué lo cierra; nada se maqueta.", "At the end, each gap says what's missing and what closes it; nothing is mocked up.") },
  },
  integraciones: {
    ilu: "nodos",
    queT: t("Integraciones", "Integrations"),
    que: t("Qué integraciones externas están configuradas y qué variables de entorno les faltan. Nunca muestra un secreto.", "Which external integrations are configured and which environment variables they're missing. It never shows a secret."),
  },
  seguridad: {
    ilu: "escudo",
    queT: t("Seguridad (MFA)", "Security (MFA)"),
    que: t("Tu autenticador, el restablecimiento del factor de otro superadmin y la bitácora de seguridad.", "Your authenticator, resetting another superadmin's factor and the security log."),
    accion: { titulo: t("Enrola y activa tu MFA", "Enroll and turn on MFA"), cuerpo: t("Las acciones sensibles de la consola te piden este código.", "The console's sensitive actions ask you for this code.") },
  },
  impersonacion: {
    ilu: "escudo",
    queT: t("Impersonación", "Impersonation"),
    que: t("Entra a una organización en solo lectura, con motivo y bitácora; ves las sesiones activas y su historial.", "Enter an organization read-only, with a reason and a log; you see active sessions and their history."),
    accion: { titulo: t("Inicia y termina la sesión", "Start and end the session"), cuerpo: t("Indica la organización y el motivo; termínala en cuanto acabes.", "Enter the organization and the reason; end it as soon as you're done.") },
  },
  "break-glass": {
    ilu: "escudo",
    queT: t("Romper cristal", "Break glass"),
    que: t("Acceso de emergencia a los datos de una organización de rentas, con motivo obligatorio y registro de cada lectura.", "Emergency access to a rentals organization's data, with a required reason and a record of every read."),
    clave: { titulo: t("Solo en emergencias", "Emergencies only"), cuerpo: t("El motivo debe ser una justificación real; los accesos activos y su historial quedan a la vista.", "The reason must be a real justification; active accesses and their history stay visible.") },
  },
  "auditoria-denegaciones": {
    ilu: "escudo",
    queT: t("Auditoría de denegaciones", "Denials audit"),
    que: t("Los intentos de entrar a la consola que se negaron, los más recientes primero, con su motivo. Solo lectura.", "Attempts to enter the console that were denied, most recent first, with their reason. Read-only."),
  },
  privacidad: {
    ilu: "escudo",
    queT: t("Privacidad de plataforma", "Platform privacy"),
    que: t("Por organización: solicitudes ARCO abiertas y vencidas, aviso vigente, bloqueos y purgas. Solo lectura.", "Per organization: open and overdue ARCO requests, current notice, holds and purges. Read-only."),
    clave: { titulo: t("Solicitudes con plazo", "Requests with a deadline"), cuerpo: t("Cada solicitud muestra su estado y su plazo, sin datos personales del titular.", "Each request shows its status and deadline, with no personal data of the requester.") },
  },
  supresion: {
    ilu: "campana",
    queT: t("Supresión de contactos", "Contact suppression"),
    que: t("Quién no debe recibir mensajes, contado por motivo y origen; nunca se ven los teléfonos ni correos.", "Who must not receive messages, counted by reason and source; phones and emails are never shown."),
    accion: { titulo: t("Agrega «no contactar»", "Add «do not contact»"), cuerpo: t("Escribe el teléfono o correo y tu código MFA; se guarda solo su huella.", "Type the phone or email and your MFA code; only its fingerprint is stored.") },
  },
  "zona-cfo": {
    ilu: "escudo",
    queT: t("Zona CFO segura", "Secure CFO zone"),
    que: t("Quién ve las pantallas financieras y la bitácora de cada consulta financiera.", "Who sees the financial screens and the log of every financial query."),
    accion: { titulo: t("Asigna o retira el rol finanzas", "Assign or remove the finance role"), cuerpo: t("Es de solo lectura; cada cambio pide motivo y queda en la bitácora.", "It's read-only; each change asks for a reason and goes into the log.") },
  },
  planes: {
    ilu: "tarjetas",
    queT: t("Planes y precios", "Plans and pricing"),
    que: t("El catálogo de planes por vertical, sus límites y qué plan tiene cada organización. Un plan no cobra nada por sí solo.", "The plan catalog per vertical, its limits and which plan each organization has. A plan doesn't charge anything by itself."),
    clave: { titulo: t("Precio vacío = por configurar", "Empty price = to be set"), cuerpo: t("Un precio sin capturar se ve «—», nunca como cero.", "A price not yet entered shows «—», never as zero.") },
    accion: { titulo: t("Asigna un plan", "Assign a plan"), cuerpo: t("Son dos pasos: lo solicitas con motivo y lo confirmas con tu código MFA.", "Two steps: you request it with a reason and confirm it with your MFA code.") },
  },
  interruptores: {
    ilu: "panel",
    queT: t("Interruptores", "Kill switches"),
    que: t("Detén un agente, un cron, todo el LLM o todos los crons, con motivo obligatorio.", "Stop an agent, a cron, all LLM or all crons, with a required reason."),
    clave: { titulo: t("No es instantáneo", "It's not instant"), cuerpo: t("El cambio puede tardar unos segundos en llegar a todas las instancias; la pantalla lo avisa.", "The change can take a few seconds to reach every instance; the screen warns you.") },
    accion: { titulo: t("Detener y reactivar", "Stop and reactivate"), cuerpo: t("Cada interruptor muestra su estado y el último motivo.", "Each switch shows its status and the last reason.") },
  },
  salud: {
    ilu: "campana",
    queT: t("Salud operativa", "Operational health"),
    que: t("Si los crons corrieron, si una cola tiene mensajes muertos y si una fuente de licitaciones está caída.", "Whether crons ran, whether a queue has dead messages and whether a tenders source is down."),
    clave: { titulo: t("Alertas accionables", "Actionable alerts"), cuerpo: t("Arriba van solo las que piden algo de ti; si no hay, lo dice.", "Only the ones that need something from you go on top; if there are none, it says so.") },
  },
};

/** Recorrido corto (5 pantallas). */
export const ESENCIALES_SUPERADMIN: readonly string[] = ["", "organizaciones", "salud", "acciones", "interruptores"];
