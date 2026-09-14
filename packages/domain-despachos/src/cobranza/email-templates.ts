// Versión HTML real (marco de marca "atiende", ver ../emails/layout.ts) de las
// 5 plantillas de recordatorio de cobranza de ./templates.ts — cierra la parte
// del gap de auditoría (severidad ALTA) que templates.ts documentaba
// honestamente: "5 plantillas de recordatorio en texto plano, subject+body,
// sin HTML ni layout". El TEXTO de cada etapa (asunto + cuerpo) es el MISMO
// texto ya verificado 1:1 contra el origen Python
// (`renderAsuntoRecordatorioCobranza`/`renderRecordatorioCobranza` de
// ./templates.ts, sin cambios de redacción) — este archivo solo lo envuelve
// en el layout HTML compartido del monorepo, mismo criterio que
// `domain-citas::emails/appointment-templates.ts` envuelve el texto de sus
// propios eventos.
//
// El cuerpo de texto plano de cada etapa usa saltos de línea reales
// (`\n\n`/`\n`, ver ./templates.ts) — para el HTML se separan en párrafos
// individuales (uno por línea no vacía) en vez de un solo bloque con <br>,
// mismo criterio de legibilidad que el resto de las plantillas del monorepo.
import { escapeHtml, renderCorreo } from "../emails/layout.ts";
import { renderAsuntoRecordatorioCobranza, renderRecordatorioCobranza, type CobranzaReminderStage, type CobranzaReminderVars } from "./templates.ts";

export interface Correo {
  readonly asunto: string;
  readonly html: string;
  readonly texto: string;
}

const ETIQUETA_POR_ETAPA: Record<CobranzaReminderStage, { readonly texto: string; readonly color: string }> = {
  pre_vencimiento: { texto: "Recordatorio", color: "#1D4ED8" },
  vencimiento: { texto: "Vence hoy", color: "#b45309" },
  recordatorio_formal: { texto: "Recordatorio formal", color: "#b45309" },
  segundo_recordatorio: { texto: "Aviso de escalamiento", color: "#dc2626" },
  escalamiento: { texto: "Escalado a gerencia", color: "#dc2626" },
};

function parrafosDesdeTexto(texto: string): readonly string[] {
  return texto
    .split("\n")
    .map((linea) => linea.trim())
    .filter((linea) => linea.length > 0)
    .map((linea) => escapeHtml(linea));
}

/** Construye el correo HTML real de una etapa de cobranza — port del
 * contenido de `construirRecordatorioCobranza` (../cobranza/engine.ts) sobre
 * el layout compartido. `vars` es el MISMO shape que ya usa
 * `renderRecordatorioCobranza`/`renderAsuntoRecordatorioCobranza` -- ver
 * `./email-notifications.ts`, que arma `vars` a partir de un
 * `ReceivableRecord` + su `InvoiceRecord`. */
export function construirCorreoCobranza(stage: CobranzaReminderStage, vars: CobranzaReminderVars): Correo {
  const asunto = renderAsuntoRecordatorioCobranza(stage, vars);
  const cuerpoTexto = renderRecordatorioCobranza(stage, "email", vars);
  const etiqueta = ETIQUETA_POR_ETAPA[stage];

  const html = renderCorreo({
    titulo: asunto,
    preheader: `Factura ${vars.facturaId} · ${vars.monto}`,
    etiqueta,
    parrafosHtml: parrafosDesdeTexto(cuerpoTexto),
    tabla: {
      filas: [
        { etiqueta: "Factura", valor: vars.facturaId },
        { etiqueta: "Monto", valor: vars.monto },
        { etiqueta: "Días de atraso", valor: vars.diasVencido },
      ],
    },
    piePorQueLlego: `Recibes este correo porque tienes una factura pendiente de pago (${vars.facturaId}) gestionada a través de atiende.`,
  });

  return { asunto, html, texto: cuerpoTexto };
}
