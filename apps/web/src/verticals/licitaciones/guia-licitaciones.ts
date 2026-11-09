// ds3 «Guía» de licitaciones: qué es cada pantalla, su elemento clave y su acción principal, en español e inglés. El recorrido en sí
// sale del menú real del rol (buildSidebarSections de LicitacionesShell): owner/admin ven además Staff, Bitácora y Privacidad; analyst,
// writer, reviewer y viewer ven el resto. El Resumen vive en «panel» (no en la raíz). Ningún texto promete algo que la pantalla no hace
// (cada uno se escribió leyendo la cabecera y las etiquetas de su página en ./pages); ninguna cifra va escrita.
import type { ContenidoConsola } from "@atiende/ui";

const t = (es: string, en: string) => ({ es, en });

export const GUIA_LICITACIONES: ContenidoConsola = {
  panel: {
    ilu: "barras",
    queT: t("Resumen: tus licitaciones de un vistazo", "Overview: your tenders at a glance"),
    que: t("Convocatorias abiertas, alertas, renovaciones y la última corrida de cada agente, con datos reales de tu organización.", "Open tenders, alerts, renewals and each agent's last run, from your organization's real data."),
    clave: {
      titulo: t("Si no se pudo leer, lo dice", "If it couldn't be read, it says so"),
      cuerpo: t("Cada tarjeta lleva a su pantalla; una lectura que falla muestra «No se pudo leer», nunca un cero inventado.", "Each card leads to its screen; a failed reading shows “Couldn't read”, never a made-up zero."),
    },
  },
  copiloto: {
    ilu: "chat",
    queT: t("Copiloto: pregúntale a tus datos", "Copilot: ask your data"),
    que: t("Escribe una pregunta sobre tus convocatorias y te responde con los datos de tu organización, solo de lectura.", "Type a question about your tenders and it answers from your organization's data, read-only."),
    clave: { titulo: t("Escribe aquí", "Type here"), cuerpo: t("Las sugerencias son un buen punto de partida.", "The suggestions are a good starting point."), objetivos: ["#contenido-principal textarea", "#contenido-principal input[type='text']"] },
  },
  convocatorias: {
    ilu: "lista",
    queT: t("Convocatorias: qué hay y qué conviene", "Tenders: what's out there and what's worth it"),
    que: t("Todas las convocatorias con su entidad, fecha límite y score de afinidad con tu empresa. Abre una para ver su detalle.", "Every tender with its agency, deadline and fit score for your company. Open one to see its detail."),
    clave: { titulo: t("El score sale de tu perfil", "The score comes from your profile"), cuerpo: t("La lista se ordena por score; sin perfil de matching configurado no se puede evaluar.", "The list is sorted by score; without a matching profile it can't be evaluated.") },
    accion: { titulo: t("Nueva convocatoria", "New tender"), cuerpo: t("Da de alta una convocatoria a mano mientras la ingesta automática siga bloqueada.", "Add a tender by hand while automatic ingestion remains blocked.") },
  },
  seguimiento: {
    ilu: "campana",
    queT: t("Seguimiento: lo que vence o cambió", "Follow-up: what's due or changed"),
    que: t("Recordatorios del plazo para presentar propuestas y cambios detectados en bases, junta de aclaraciones o anexos.", "Reminders of the proposal deadline and changes detected in bases, clarification meeting or annexes."),
    clave: { titulo: t("Reconoce lo que ya viste", "Acknowledge what you've seen"), cuerpo: t("«Reconocer» marca el aviso como visto; lo hacen los roles que pueden escribir. Las horas van en hora del centro de México.", "“Acknowledge” marks the notice as seen; roles that can write do it. Times are in central Mexico time.") },
  },
  "radar-renovaciones": {
    ilu: "linea",
    queT: t("Radar de renovaciones", "Renewal radar"),
    que: t("Revisa todos tus contratos con fecha de término y avisa cuáles se acercan a renovarse.", "Reviews all your contracts with an end date and flags which are nearing renewal."),
    clave: { titulo: t("Alertas por contrato", "Alerts per contract"), cuerpo: t("Cada alerta trae su convocatoria y entidad; «Reconocer» la marca como vista.", "Each alert shows its tender and agency; “Acknowledge” marks it as seen.") },
    accion: { titulo: t("Escanear renovaciones", "Scan renewals"), cuerpo: t("Vuelve a revisar los contratos; reescanear no duplica alertas ya emitidas.", "Checks the contracts again; rescanning doesn't duplicate alerts already issued.") },
  },
  fuentes: {
    ilu: "importar",
    queT: t("Fuentes y frescura", "Sources and freshness"),
    que: t("El estado de cada fuente de convocatorias: qué tan reciente es su último dato y sus corridas recientes. Solo lectura.", "The status of each tender source: how recent its last data is and its recent runs. Read-only."),
    clave: { titulo: t("Una falla no es «cero resultados»", "A failure isn't “zero results”"), cuerpo: t("Lo obsoleto siempre se marca y una corrida fallida se muestra como falla.", "Stale data is always flagged and a failed run shows as a failure.") },
  },
  "kyc-69b": {
    ilu: "escudo",
    queT: t("KYC de proveedores (69-B)", "Supplier KYC (69-B)"),
    que: t("Consulta uno o varios RFC contra el listado 69-B del SAT y lleva tu cartera de proveedores y competidores.", "Check one or several RFCs against the SAT 69-B list and keep your book of suppliers and competitors."),
    clave: { titulo: t("Cómo leer el resultado", "How to read the result"), cuerpo: t("El semáforo indica la situación publicada por el SAT. Que un RFC no aparezca no es una constancia oficial.", "The traffic light shows the status published by the SAT. An RFC not appearing isn't an official certificate.") },
    accion: { titulo: t("Consulta un RFC", "Check an RFC"), cuerpo: t("La consulta queda en la bitácora de tu organización; ninguna otra organización la ve.", "The check is logged in your organization's log; no other organization sees it.") },
  },
  "perfil-matching": {
    ilu: "panel",
    queT: t("Perfil de matching", "Matching profile"),
    que: t("Palabras clave, exclusiones, entidades, estados y rango de presupuesto que definen qué convocatorias te convienen.", "Keywords, exclusions, agencies, states and budget range that define which tenders suit you."),
    clave: { titulo: t("Alimenta el score", "It feeds the score"), cuerpo: t("Lo que guardes aquí es lo único que usa el score de Convocatorias.", "What you save here is the only thing the Tenders score uses.") },
    accion: { titulo: t("Guarda tu perfil", "Save your profile"), cuerpo: t("Escribe una palabra clave por línea y guarda; lo editan los roles que pueden escribir.", "Write one keyword per line and save; roles that can write edit it.") },
  },
  "datos-empresa": {
    ilu: "tarjetas",
    queT: t("Datos de la empresa", "Company data"),
    que: t("Documentos, tarifas, capacidades, experiencia y firmantes que usan tus propuestas técnica y económica.", "Documents, rates, capabilities, experience and signers your technical and economic proposals use."),
    clave: { titulo: t("Solo cuenta lo aprobado", "Only approved data counts"), cuerpo: t("Cada dato se aprueba por alguien distinto de quien lo editó; editar uno aprobado lo regresa a pendiente.", "Each item is approved by someone other than whoever edited it; editing an approved one sends it back to pending.") },
    accion: { titulo: t("Captura por pestaña", "Enter it by tab"), cuerpo: t("Cada pestaña tiene su alta; al guardar queda pendiente de aprobación.", "Each tab has its own entry form; on save it waits for approval.") },
  },
  "dias-inhabiles": {
    ilu: "agenda",
    queT: t("Días inhábiles", "Non-working days"),
    que: t("Feriados oficiales, días que dependen de cada dependencia y los que declara tu organización. Con ellos se cuentan los plazos.", "Official holidays, days that depend on each agency and those your organization declares. Deadlines are counted with them."),
    clave: { titulo: t("Lo dudoso no se aplica solo", "Doubtful days don't apply on their own"), cuerpo: t("Un día marcado para validar con fiscalista o abogado solo cuenta si tu organización lo declara.", "A day marked to check with a tax advisor or lawyer only counts if your organization declares it.") },
    accion: { titulo: t("Declara un día", "Declare a day"), cuerpo: t("Para todas tus convocatorias o para una en particular.", "For all your tenders or for one in particular.") },
  },
  aprobaciones: {
    ilu: "lista",
    queT: t("Aprobaciones", "Approvals"),
    que: t("Los datos de empresa que esperan aprobación. Sin ella, las propuestas no pueden usarlos.", "Company data waiting for approval. Without it, proposals can't use them."),
    clave: { titulo: t("Nadie aprueba lo suyo", "Nobody approves their own"), cuerpo: t("Aprobar o rechazar es una decisión: nunca de quien propuso o editó el dato.", "Approving or rejecting is a decision: never by whoever proposed or edited the item.") },
    accion: { titulo: t("Aprueba o rechaza", "Approve or reject"), cuerpo: t("Desde cada fila. Las tarifas solo las decide owner o admin, con una verificación adicional.", "From each row. Only owner or admin decide rates, with an extra verification step.") },
  },
  staff: {
    ilu: "equipo",
    queT: t("Staff: tu equipo", "Staff: your team"),
    que: t("Invita a tu equipo, revisa las invitaciones pendientes y cambia el rol de quien ya entró.", "Invite your team, review pending invitations and change the role of anyone already in."),
    clave: { titulo: t("Cada rol ve lo suyo", "Each role sees its own"), cuerpo: t("Owner y admin administran; los demás roles escriben, revisan o solo consultan según su rol.", "Owner and admin administer; the other roles write, review or only view depending on their role.") },
    accion: { titulo: t("Invita a alguien", "Invite someone"), cuerpo: t("Escribe su correo, elige su rol y envía la invitación; una pendiente se puede revocar.", "Enter their email, choose their role and send the invitation; a pending one can be revoked.") },
  },
  bitacora: {
    ilu: "escudo",
    queT: t("Bitácora", "Audit log"),
    que: t("Quién cambió qué y cuándo, con el antes y el después. Solo lectura.", "Who changed what and when, with before and after. Read-only."),
    clave: { titulo: t("Filtra y sigue la traza", "Filter and follow the trail"), cuerpo: t("Filtra por entidad, persona o fecha y sigue una convocatoria de punta a punta.", "Filter by entity, person or date and follow a tender end to end.") },
  },
  whatsapp: {
    ilu: "chat",
    queT: t("WhatsApp: tus avisos", "WhatsApp: your alerts"),
    que: t("Tu teléfono, los temas de aviso (plazos, convocatorias, fallos, decisiones) y tu consentimiento para recibirlos.", "Your phone, the alert topics (deadlines, tenders, awards, decisions) and your consent to receive them."),
    clave: { titulo: t("Se activa con tu «SÍ»", "It turns on with your “YES”"), cuerpo: t("Los avisos solo quedan activos cuando contestas SÍ desde tu propio número.", "Alerts only turn on when you reply YES from your own number.") },
    accion: { titulo: t("Pide una decisión", "Request a decision"), cuerpo: t("Si tu rol decide ir o no ir, puedes pedir la decisión de una convocatoria por WhatsApp.", "If your role decides go or no-go, you can request a tender's decision over WhatsApp.") },
  },
  seguridad: {
    ilu: "escudo",
    queT: t("Seguridad de tu cuenta", "Your account security"),
    que: t("Verificación en dos pasos, correo, contraseña, Google y tus sesiones activas.", "Two-step verification, email, password, Google and your active sessions."),
    clave: { titulo: t("Activa la verificación en dos pasos", "Turn on two-step verification"), cuerpo: t("Captura la clave en tu app de autenticación y guarda tus códigos de respaldo.", "Enter the key in your authenticator app and keep your backup codes.") },
    accion: { titulo: t("Revisa tus sesiones", "Review your sessions"), cuerpo: t("Cierra cualquier sesión activa que no reconozcas.", "Sign out of any active session you don't recognize.") },
  },
  privacidad: {
    ilu: "escudo",
    queT: t("Privacidad de la organización", "Organization privacy"),
    que: t("Solicitudes ARCO, retención y aviso de privacidad de tu organización.", "ARCO requests, retention and privacy notice for your organization."),
    clave: { titulo: t("Viene de tus otras áreas", "It comes from your other areas"), cuerpo: t("Licitaciones aún no registra solicitudes propias: lo que ves sale de los demás verticales de tu organización.", "Tenders doesn't log its own requests yet: what you see comes from your organization's other verticals.") },
  },
};

/** Recorrido corto por rol (5 pantallas; la primera, con su elemento clave). Las que el rol no tiene en su menú se omiten solas. */
export const ESENCIALES_LICITACIONES: Readonly<Record<string, readonly string[]>> = {
  owner: ["panel", "convocatorias", "perfil-matching", "datos-empresa", "aprobaciones"],
  admin: ["panel", "convocatorias", "perfil-matching", "datos-empresa", "aprobaciones"],
  analyst: ["panel", "convocatorias", "seguimiento", "perfil-matching", "datos-empresa"],
  writer: ["panel", "convocatorias", "seguimiento", "datos-empresa", "radar-renovaciones"],
  reviewer: ["panel", "convocatorias", "seguimiento", "aprobaciones", "datos-empresa"],
  viewer: ["panel", "convocatorias", "seguimiento", "radar-renovaciones", "fuentes"],
};

export const esencialesLicitaciones = (rol: string): readonly string[] => ESENCIALES_LICITACIONES[rol] ?? ESENCIALES_LICITACIONES.viewer!;
