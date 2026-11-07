// ds3 «Guía» de despachos: qué es cada pantalla, su elemento clave y su acción principal, en español e inglés. El recorrido en sí sale
// del menú real del rol (buildSidebarSections de DespachosShell): los cuatro roles (admin, contador, auditor, readonly) ven el mismo
// menú; lo que cambia por rol son los botones que el servidor deja usar, por eso los textos dicen «si tu rol lo permite» donde aplica.
// Ningún texto promete algo que la pantalla no hace; ninguna cifra va escrita. Despachos no tiene «Primeros pasos».
import type { ContenidoConsola } from "@atiende/ui";

const t = (es: string, en: string) => ({ es, en });

export const GUIA_DESPACHOS: ContenidoConsola = {
  dashboard: {
    ilu: "barras",
    queT: t("Resumen: el despacho de un vistazo", "Overview: your firm at a glance"),
    que: t("Clientes, cartera vencida, cobranza, pendientes, cierres abiertos, anomalías y CFDI del mes. Si un dato no tiene fuente, se ve «—» con su razón.", "Clients, overdue receivables, collections, pending work, open closes, anomalies and this month's CFDI. A figure without a source shows «—» with its reason."),
    clave: { titulo: t("Cada indicador lleva a su pantalla", "Each indicator opens its screen"), cuerpo: t("Toca una tarjeta para ir al detalle; abajo ves el cliente activo y el ranking de clientes.", "Tap a card to go to the detail; below you see the active client and the client ranking.") },
  },
  copiloto: {
    ilu: "chat",
    queT: t("Copiloto: pregúntale a tus datos", "Copilot: ask your data"),
    que: t("Escribe una pregunta sobre el contribuyente activo y te responde con los datos del despacho, solo de lectura.", "Ask a question about the active taxpayer and it answers from the firm's data, read-only."),
    clave: { titulo: t("Responde del contribuyente activo", "It answers for the active taxpayer"), cuerpo: t("Si cambias de contribuyente arriba, la conversación arranca limpia.", "If you switch taxpayer at the top, the conversation starts fresh.") },
  },
  "cierre-mensual": {
    ilu: "corte",
    queT: t("Cierre mensual: el checklist del mes", "Monthly close: the month's checklist"),
    que: t("Los periodos abiertos del contribuyente con su estatus y avance. Es la tarea que más conviene no atrasar.", "The taxpayer's open periods with their status and progress. It's the task you least want to fall behind on."),
    clave: { titulo: t("Abre un periodo para ver su checklist", "Open a period to see its checklist"), cuerpo: t("Cada periodo trae sus tareas y validaciones; ahí marcas el avance hasta cerrarlo.", "Each period has its tasks and checks; there you track progress until it's closed.") },
    accion: { titulo: t("Abrir periodo", "Open period"), cuerpo: t("Elige el mes y se crea el checklist completo de ese periodo.", "Pick the month and the full checklist for that period is created.") },
  },
  cfdi: {
    ilu: "importar",
    queT: t("CFDI: comprobantes emitidos y recibidos", "CFDI: issued and received invoices"),
    que: t("Los comprobantes del contribuyente ya validados contra las reglas fiscales, con sus hallazgos y las alertas de la lista 69-B del SAT.", "The taxpayer's invoices already checked against tax rules, with their findings and alerts from the SAT 69-B list."),
    clave: { titulo: t("Cola de revisión humana", "Human review queue"), cuerpo: t("Lo que la validación no pudo decidir sola espera aquí; admin y contador lo aprueban o rechazan.", "What validation couldn't decide on its own waits here; admin and accountant approve or reject it.") },
    accion: { titulo: t("Carga XML", "Upload XML"), cuerpo: t("Sube un XML o un lote; se valida al entrar y aparece en la lista.", "Upload one XML or a batch; it's validated on the way in and shows up in the list.") },
  },
  cobranza: {
    ilu: "linea",
    queT: t("Cobranza: lo que te deben", "Collections: what you're owed"),
    que: t("La cartera del contribuyente con antigüedad, probabilidad de cobro y cobro esperado.", "The taxpayer's receivables with aging, likelihood of payment and expected collection."),
    clave: { titulo: t("Cada cuenta, su etapa", "Each account, its stage"), cuerpo: t("Desde la fila marcas una cuenta como pagada o mandas su recordatorio.", "From the row you mark an account as paid or send its reminder.") },
    accion: { titulo: t("Registra una cuenta por cobrar", "Register a receivable"), cuerpo: t("Elige un CFDI de ingreso y su fecha de vencimiento.", "Pick an income CFDI and its due date.") },
  },
  "cola-cobranza": {
    ilu: "lista",
    queT: t("Cola de cobranza: el seguimiento", "Collections queue: the follow-up"),
    que: t("Gestiones por cuenta: promesas de pago, llamadas, recordatorios y notas, con su fecha de seguimiento.", "Actions per account: payment promises, calls, reminders and notes, with their follow-up date."),
    clave: { titulo: t("WhatsApp con consentimiento", "WhatsApp with consent"), cuerpo: t("Los recordatorios por WhatsApp quedan en cola con el permiso de cada cliente; esta pantalla no los envía.", "WhatsApp reminders are queued with each client's permission; this screen doesn't send them.") },
    accion: { titulo: t("Registra una gestión", "Log an action"), cuerpo: t("Elige la cuenta, qué pasó y cuándo darle seguimiento. También puedes bajar el reporte PDF de cartera.", "Pick the account, what happened and when to follow up. You can also download the receivables PDF report.") },
  },
  vencimientos: {
    ilu: "agenda",
    queT: t("Vencimientos fiscales", "Tax deadlines"),
    que: t("Las obligaciones del contribuyente (ISR, IVA, DIOT, nómina, balanza, anual) con su fecha límite en día hábil.", "The taxpayer's obligations (income tax, VAT, DIOT, payroll, trial balance, annual) with their business-day deadline."),
    clave: { titulo: t("Completa o escala", "Complete or escalate"), cuerpo: t("Marca un vencimiento como completado o escala los vencidos y por vencer; el escalamiento avisa por correo.", "Mark a deadline as completed or escalate overdue and upcoming ones; escalation sends an email notice.") },
    accion: { titulo: t("Calcula los vencimientos", "Calculate deadlines"), cuerpo: t("Elige el periodo y el régimen fiscal y se arma el calendario de ese periodo.", "Pick the period and tax regime and that period's calendar is built.") },
  },
  declaraciones: {
    ilu: "panel",
    queT: t("Declaraciones: ISR y DIOT", "Returns: income tax and DIOT"),
    que: t("Calcula el ISR de persona física, moral o RESICO y consulta la DIOT de un periodo armada con los CFDI guardados.", "Calculate income tax for individuals, companies or RESICO and look up a period's DIOT built from saved CFDI."),
    clave: { titulo: t("El cálculo no se guarda", "The calculation isn't saved"), cuerpo: t("Ves el resultado para registrarlo donde corresponda; nada se firma ni se envía al SAT.", "You see the result to record it where it belongs; nothing is signed or sent to the SAT.") },
  },
  "pagos-provisionales": {
    ilu: "corte",
    queT: t("Pagos provisionales de ISR e IVA", "Provisional income tax and VAT payments"),
    que: t("Papel de trabajo por flujo de efectivo: cada cifra con su línea y cada CFDI excluido con su motivo. El servidor hace el cálculo.", "Cash-basis working paper: each figure with its line and each excluded CFDI with its reason. The server does the math."),
    clave: { titulo: t("CFDI no incluidos", "CFDI not included"), cuerpo: t("Ninguno se descarta en silencio: revísalos antes de presentar.", "None is dropped silently: check them before filing.") },
    accion: { titulo: t("Guarda y presenta", "Save and file"), cuerpo: t("Guarda el borrador y, al presentar, captura lo pagado y la fecha; también exporta a PDF o Excel.", "Save the draft and, when filing, enter what was paid and the date; you can also export to PDF or Excel.") },
  },
  "contabilidad-electronica": {
    ilu: "importar",
    queT: t("Contabilidad electrónica", "Electronic accounting"),
    que: t("Genera el catálogo de cuentas y la balanza en XML del mes a partir de los asientos que captures.", "Generate the month's chart of accounts and trial balance XML from the entries you enter."),
    accion: { titulo: t("Genera el paquete completo", "Generate the full package"), cuerpo: t("Descarga cada XML y, si quedó bien, márcalo listo para timbrar. El paquete no se guarda en el servidor.", "Download each XML and, if it's right, mark it ready to stamp. The package isn't stored on the server.") },
  },
  "devolucion-iva": {
    ilu: "lista",
    queT: t("Devolución de IVA", "VAT refund"),
    que: t("Flujo guiado por pasos: facturas, DIOT, conciliación, saldo a favor, congruencia, solicitud, plazo y papel de trabajo.", "Step-by-step flow: invoices, DIOT, reconciliation, credit balance, consistency, request, deadline and working paper."),
    clave: { titulo: t("Cada paso alimenta al siguiente", "Each step feeds the next"), cuerpo: t("La solicitud no se guarda en el servidor: archívala tú cuando la tengas.", "The request isn't stored on the server: file it yourself once you have it.") },
  },
  nomina: {
    ilu: "equipo",
    queT: t("Nómina", "Payroll"),
    que: t("Calcula la nómina de un periodo con una fila por empleado: ISR, IMSS, Infonavit y neto.", "Calculate a period's payroll with one row per employee: income tax, IMSS, Infonavit and net pay."),
    accion: { titulo: t("Genera el XML de nómina", "Generate the payroll XML"), cuerpo: t("Con el periodo calculado, genera el XML del complemento de nómina por empleado. Nada se guarda.", "With the period calculated, generate the payroll complement XML per employee. Nothing is saved.") },
  },
  conciliacion: {
    ilu: "corte",
    queT: t("Conciliación bancaria", "Bank reconciliation"),
    que: t("Cruza los movimientos del banco contra los CFDI del contribuyente y muestra lo conciliado y lo que falta.", "Matches bank movements against the taxpayer's CFDI and shows what's reconciled and what's missing."),
    clave: { titulo: t("Un lote, tres vistas", "One batch, three views"), cuerpo: t("Con el mismo lote corres la conciliación, ves alertas y verificas pagos SPEI o de proveedor.", "With the same batch you run matching, see alerts and verify SPEI or supplier payments.") },
    accion: { titulo: t("Importa el estado de cuenta", "Import the bank statement"), cuerpo: t("Carga el archivo del banco o captura los movimientos en la tabla.", "Load the bank file or type the movements into the table.") },
  },
  "libro-contable": {
    ilu: "lista",
    queT: t("Libro contable", "Ledger"),
    que: t("Pólizas con folio, manuales o armadas desde un CFDI, con su balanza y el catálogo de cuentas.", "Numbered journal entries, manual or built from a CFDI, with the trial balance and chart of accounts."),
    clave: { titulo: t("Una póliza se revierte, no se borra", "An entry is reversed, not deleted"), cuerpo: t("Para corregir, revierte la póliza con su fecha; un periodo cerrado ya no acepta cambios.", "To correct one, reverse the entry with its date; a closed period no longer accepts changes.") },
    accion: { titulo: t("Nueva póliza", "New entry"), cuerpo: t("Captura sus partidas; el servidor revisa que cuadre antes de guardarla.", "Enter its lines; the server checks it balances before saving it.") },
  },
  bookkeeping: {
    ilu: "nodos",
    queT: t("Bookkeeping: clasifica y arma pólizas", "Bookkeeping: classify and build entries"),
    que: t("Clasifica un lote de CFDI en cuentas contables y genera las pólizas a partir de esa clasificación.", "Classifies a batch of CFDI into accounts and generates journal entries from that classification."),
    clave: { titulo: t("Corrige la categoría antes de generar", "Fix the category before generating"), cuerpo: t("Tus correcciones quedan como historial y se usan en la siguiente clasificación.", "Your corrections are kept as history and used in the next classification.") },
  },
  reportes: {
    ilu: "barras",
    queT: t("Reportes de cliente", "Client reports"),
    que: t("Balanza, DIOT, nómina e impuestos del contribuyente activo por periodo. Lo que aún no existe se marca «Sin datos».", "Trial balance, DIOT, payroll and taxes for the active taxpayer by period. What doesn't exist yet shows as «No data»."),
    accion: { titulo: t("Genera y descarga", "Generate and download"), cuerpo: t("Elige el reporte y el periodo; descárgalo en PDF o en Excel.", "Pick the report and period; download it as PDF or Excel.") },
  },
  "migracion-catalogo": {
    ilu: "importar",
    queT: t("Migración de catálogo", "Chart of accounts migration"),
    que: t("Pega el catálogo de origen y el de destino y propone cómo mapear cada cuenta.", "Paste the source and target charts of accounts and it proposes how to map each account."),
    clave: { titulo: t("Tú decides cada mapeo", "You decide each mapping"), cuerpo: t("Aprueba, rechaza o edita cada propuesta; las que el servidor no acepta te dicen por qué.", "Approve, reject or edit each proposal; the ones the server won't accept tell you why.") },
  },
  cartera: {
    ilu: "equipo",
    queT: t("Cartera de clientes", "Client book"),
    que: t("La ficha fiscal de cada contribuyente que atiendes: RFC, razón social, régimen, código postal y responsable.", "The tax profile of each taxpayer you serve: RFC, legal name, regime, postal code and owner."),
    clave: { titulo: t("Clientes sin ficha", "Clients without a profile"), cuerpo: t("Sin RFC no se distingue un CFDI emitido de uno recibido; por eso se señalan.", "Without an RFC an issued CFDI can't be told from a received one; that's why they're flagged.") },
    accion: { titulo: t("Da de alta un cliente", "Add a client"), cuerpo: t("Captura su nombre y completa su ficha fiscal.", "Enter their name and complete their tax profile.") },
  },
  "portal-cliente": {
    ilu: "chat",
    queT: t("Portal del cliente", "Client portal"),
    que: t("Enlaces privados para que tu cliente te mande documentos y mensajes, y la bandeja donde los revisas.", "Private links so your client can send you documents and messages, and the inbox where you review them."),
    clave: { titulo: t("Copia el enlace al crearlo", "Copy the link when you create it"), cuerpo: t("Solo se muestra completo una vez, expira y lo puedes revocar. Esta pantalla no se lo envía al cliente.", "It's shown in full only once, it expires and you can revoke it. This screen doesn't send it to the client.") },
    accion: { titulo: t("Acepta o rechaza documentos", "Accept or reject documents"), cuerpo: t("Aceptar un CFDI lo ingresa igual que cargar su XML.", "Accepting a CFDI brings it in the same way as uploading its XML.") },
  },
  staff: {
    ilu: "equipo",
    queT: t("Staff: tu equipo", "Staff: your team"),
    que: t("Quién trabaja en el despacho, sus roles y las invitaciones pendientes.", "Who works at the firm, their roles and pending invitations."),
    clave: { titulo: t("Roles", "Roles"), cuerpo: t("Admin y contador operan; auditor y solo lectura consultan sin cambiar nada.", "Admin and accountant operate; auditor and read-only look without changing anything.") },
    accion: { titulo: t("Invita a alguien", "Invite someone"), cuerpo: t("Solo el admin invita. La invitación pendiente se puede revocar.", "Only the admin invites. A pending invitation can be revoked.") },
  },
  configuracion: {
    ilu: "panel",
    queT: t("Configuración: zona horaria", "Settings: time zone"),
    que: t("La zona horaria del despacho, que usan las fechas y los vencimientos. Solo el admin la cambia.", "The firm's time zone, used by dates and deadlines. Only the admin changes it."),
  },
};

/** Recorrido corto por rol (5 pantallas). Las que el rol no tiene en su menú se omiten solas. */
export const ESENCIALES_DESPACHOS: Readonly<Record<string, readonly string[]>> = {
  admin: ["dashboard", "cierre-mensual", "cfdi", "cobranza", "cartera"],
  contador: ["dashboard", "cierre-mensual", "cfdi", "vencimientos", "pagos-provisionales"],
  auditor: ["dashboard", "cierre-mensual", "cfdi", "libro-contable", "reportes"],
  readonly: ["dashboard", "cierre-mensual", "cfdi", "vencimientos", "reportes"],
};

export const esencialesDespachos = (rol: string): readonly string[] => ESENCIALES_DESPACHOS[rol] ?? ESENCIALES_DESPACHOS.readonly!;
