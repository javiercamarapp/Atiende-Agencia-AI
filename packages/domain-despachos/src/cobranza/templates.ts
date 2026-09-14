// ═══════════════════════════════════════════════════════════════════════════
// PLANTILLAS DE COBRANZA — port literal (mismo texto en español MX, misma
// escala de tono) de
// ~/Desktop/supabase/despachos/b2b_ai/services/collections_templates.py.
//
// Cada etapa de la secuencia de cobranza tiene una plantilla de correo
// (subject + body) y una de WhatsApp. El tono escala de amigable a
// formal-firme, terminando en escalamiento a gerencia — igual que el origen.
// ═══════════════════════════════════════════════════════════════════════════

/** Orden de la secuencia de cobranza — port literal de `SEQUENCE`. */
export const COBRANZA_REMINDER_SEQUENCE = ["pre_vencimiento", "vencimiento", "recordatorio_formal", "segundo_recordatorio", "escalamiento"] as const;

export type CobranzaReminderStage = (typeof COBRANZA_REMINDER_SEQUENCE)[number];

/** Offset en días respecto al vencimiento de cada etapa — port literal de
 * `STAGE_OFFSET_DAYS`: negativo = antes del vencimiento, positivo = días de
 * atraso. */
export const COBRANZA_STAGE_OFFSET_DAYS: Record<CobranzaReminderStage, number> = {
  pre_vencimiento: -7,
  vencimiento: 0,
  recordatorio_formal: 7,
  segundo_recordatorio: 30,
  escalamiento: 60,
};

export interface CobranzaReminderVars {
  readonly nombreEmpresa: string;
  readonly monto: string;
  readonly diasVencido: string;
  readonly facturaId: string;
}

interface CobranzaTemplateStage {
  readonly label: string;
  readonly tone: string;
  readonly email: { readonly subject: string; readonly body: string };
  readonly whatsapp: string;
}

// Texto EXACTO del origen (traducción 1:1, sin cambios de redacción) — ver
// cabecera del archivo para la referencia.
const COBRANZA_TEMPLATES: Record<CobranzaReminderStage, CobranzaTemplateStage> = {
  pre_vencimiento: {
    label: "Recordatorio amigable (7 días antes)",
    tone: "amigable",
    email: {
      subject: "Recordatorio: factura {facturaId} vence en breve",
      body:
        "Hola {nombreEmpresa},\n\n" +
        "Solo queremos recordarte que la factura {facturaId} por " +
        "{monto} tiene vencimiento próximamente. Si ya realizaste el " +
        "pago, ignora este mensaje.\n\n" +
        "Gracias por tu atención.\n" +
        "Equipo de Administración",
    },
    whatsapp:
      "Hola {nombreEmpresa}! Te recordamos amablemente que la factura " +
      "{facturaId} por {monto} vence en breve. Si ya la pagaste, " +
      "ignora este mensaje. ¡Gracias!",
  },
  vencimiento: {
    label: "Notificación de vencimiento (día 0)",
    tone: "informativo",
    email: {
      subject: "La factura {facturaId} vence hoy",
      body:
        "Hola {nombreEmpresa},\n\n" +
        "Te informamos que la factura {facturaId} por {monto} vence " +
        "el día de hoy. Te agradecemos realizar el pago a la brevedad " +
        "para mantener tu cuenta al corriente.\n\n" +
        "Quedamos a tu disposición para cualquier duda.\n" +
        "Equipo de Administración",
    },
    whatsapp:
      "Hola {nombreEmpresa}, la factura {facturaId} por {monto} vence " +
      "hoy. Te pedimos amablemente realizar el pago a la brevedad. " +
      "¡Gracias!",
  },
  recordatorio_formal: {
    label: "Primer recordatorio formal (7 días vencido)",
    tone: "formal",
    email: {
      subject: "Recordatorio formal — factura {facturaId} vencida",
      body:
        "Estimado {nombreEmpresa},\n\n" +
        "La factura {facturaId} por {monto} presenta un atraso de " +
        "{diasVencido} días. Le solicitamos realizar el pago a la " +
        "brevedad posible.\n\n" +
        "Si ya fue cubierta, le pedimos compartirnos su comprobante de " +
        "pago para actualizar su cuenta.\n\n" +
        "Quedamos atentos.\n" +
        "Departamento de Administración",
    },
    whatsapp:
      "Estimado {nombreEmpresa}, le recordamos que la factura " +
      "{facturaId} por {monto} presenta un atraso de {diasVencido} " +
      "días. Agradecemos su pago a la brevedad.",
  },
  segundo_recordatorio: {
    label: "Segundo recordatorio + aviso de escalamiento (30 días)",
    tone: "firme",
    email: {
      subject: "Aviso importante — factura {facturaId} con {diasVencido} días de atraso",
      body:
        "Estimado {nombreEmpresa},\n\n" +
        "La factura {facturaId} por {monto} acumula {diasVencido} días " +
        "de atraso. Sin el pago o un acuerdo de liquidación a la " +
        "brevedad, procederemos a escalar su cuenta a la gerencia y a " +
        "nuestro departamento jurídico.\n\n" +
        "Le invitamos a contactarnos para regularizar su situación " +
        "antes de tomar esa medida.\n\n" +
        "Departamento de Administración",
    },
    whatsapp:
      "Estimado {nombreEmpresa}, la factura {facturaId} por {monto} " +
      "acumula {diasVencido} días de atraso. Sin pago o acuerdo, su " +
      "cuenta será escalada a gerencia. Contáctenos para regularizarla.",
  },
  escalamiento: {
    label: "Escalamiento a gerencia (60 días)",
    tone: "formal-firme",
    email: {
      subject: "Escalamiento — factura {facturaId}, {diasVencido} días vencidos",
      body:
        "Estimado {nombreEmpresa},\n\n" +
        "Debido a que la factura {facturaId} por {monto} lleva " +
        "{diasVencido} días sin liquidarse, su caso ha sido escalado " +
        "a la gerencia. Esta es la última instancia administrativa " +
        "antes de emprender acciones legales.\n\n" +
        "Para evitar mayores consecuencias, le solicitamos ponerse en " +
        "contacto inmediato con nuestra gerencia para acordar la " +
        "liquidación.\n\n" +
        "Gerencia de Cobranza",
    },
    whatsapp:
      "Estimado {nombreEmpresa}, la factura {facturaId} por {monto} " +
      "lleva {diasVencido} días vencidos y su caso fue escalado a " +
      "gerencia. Contáctenos de inmediato para acordar la liquidación " +
      "antes de acciones legales.",
  },
};

/** Formatea un monto a "$12,500.00 MXN" — port literal de `format_monto`. */
export function formatMontoCobranza(monto: number): string {
  return `$${monto.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MXN`;
}

function fillVars(text: string, vars: CobranzaReminderVars): string {
  return text
    .replaceAll("{nombreEmpresa}", vars.nombreEmpresa)
    .replaceAll("{monto}", vars.monto)
    .replaceAll("{diasVencido}", vars.diasVencido)
    .replaceAll("{facturaId}", vars.facturaId);
}

/** Renderiza el cuerpo (email) o texto (whatsapp) de una etapa — port literal
 * de `render`. */
export function renderRecordatorioCobranza(stage: CobranzaReminderStage, channel: "email" | "whatsapp", vars: CobranzaReminderVars): string {
  const tpl = COBRANZA_TEMPLATES[stage];
  return channel === "email" ? fillVars(tpl.email.body, vars) : fillVars(tpl.whatsapp, vars);
}

/** Renderiza el asunto de correo de una etapa (solo email) — port literal de
 * `render_subject`. */
export function renderAsuntoRecordatorioCobranza(stage: CobranzaReminderStage, vars: CobranzaReminderVars): string {
  return fillVars(COBRANZA_TEMPLATES[stage].email.subject, vars);
}
