// Plantilla de correo de escalamiento de vencimientos fiscales, construida
// sobre el marco de layout.ts — mismo patrón que
// packages/domain-citas/src/emails/appointment-templates.ts. Cierra el gap de
// auditoría de `POST .../vencimientos/:deadlineId/escalar`
// (apps/api/src/routes/verticals/despachos/vencimientos.ts), que hasta esta
// fase solo insertaba el escalamiento en BD sin notificar a nadie.
//
// A diferencia de los correos de cobranza (aviso a un tercero externo, el
// deudor), un escalamiento fiscal es un aviso INTERNO al despacho contable
// dueño de la cuenta — el destinatario real se resuelve vía
// `despachos.organization_notification_recipients` (staff owner/admin, ver
// `vencimientos/email-notifications.ts`), nunca aquí.
import { escapeHtml, renderCorreo } from "./layout.ts";
import type { NivelEscalamiento, TipoVencimiento } from "../vencimientos/engine.ts";

export interface EscalamientoVencimientoCorreo {
  readonly tenantNombre: string;
  readonly tipo: TipoVencimiento;
  readonly periodo: string; // "YYYY-MM"
  readonly fechaLimite: string; // "YYYY-MM-DD"
  readonly diasRestantes: number; // negativo = ya vencido
  readonly nivel: NivelEscalamiento;
  readonly notas: string;
}

export interface Correo {
  readonly asunto: string;
  readonly html: string;
  readonly texto: string;
}

const ETIQUETA_POR_NIVEL: Record<NivelEscalamiento, { readonly texto: string; readonly color: string }> = {
  nivel_1: { texto: "Escalamiento nivel 1", color: "#0ea5e9" },
  nivel_2: { texto: "Escalamiento nivel 2", color: "#b45309" },
  nivel_3: { texto: "Escalamiento nivel 3 — vence hoy", color: "#dc2626" },
  nivel_4: { texto: "Escalamiento nivel 4 — vencido", color: "#dc2626" },
};

function textoDiasRestantes(diasRestantes: number): string {
  if (diasRestantes < 0) return `Vencido hace ${Math.abs(diasRestantes)} día(s)`;
  if (diasRestantes === 0) return "Vence hoy";
  return `Faltan ${diasRestantes} día(s)`;
}

/** Genera el correo de aviso interno de un escalamiento de vencimiento fiscal
 * (CFF art. 89: todo escalamiento exige revisión humana — este correo es
 * justamente el aviso que hace posible esa revisión; nunca se autocompleta el
 * vencimiento). */
export function correoEscalamientoVencimiento(c: EscalamientoVencimientoCorreo): Correo {
  const tenant = escapeHtml(c.tenantNombre);
  const etiqueta = ETIQUETA_POR_NIVEL[c.nivel];
  const diasTexto = textoDiasRestantes(c.diasRestantes);
  const html = renderCorreo({
    titulo: `Vencimiento fiscal escalado — ${c.tipo}`,
    preheader: `${c.tipo} de ${c.tenantNombre} (${c.periodo}) — ${diasTexto}`,
    etiqueta,
    parrafosHtml: [
      `Un vencimiento fiscal de <strong>${tenant}</strong> fue escalado y requiere revisión humana de inmediato (CFF art. 89: ningún vencimiento se completa automáticamente).`,
    ],
    tabla: {
      filas: [
        { etiqueta: "Obligación", valor: c.tipo },
        { etiqueta: "Período", valor: c.periodo },
        { etiqueta: "Fecha límite", valor: c.fechaLimite },
        { etiqueta: "Estado", valor: diasTexto },
        { etiqueta: "Nivel de escalamiento", valor: c.nivel.replace("_", " ") },
      ],
    },
    nota: escapeHtml(c.notas),
    piePorQueLlego: `Recibes este correo porque tu cuenta de staff en ${c.tenantNombre} tiene rol owner/admin en atiende.`,
  });
  return {
    asunto: `[${etiqueta.texto}] ${c.tipo} · ${c.tenantNombre} · ${diasTexto}`,
    html,
    texto: `Vencimiento fiscal escalado en ${c.tenantNombre}.\nObligación: ${c.tipo}\nPeríodo: ${c.periodo}\nFecha límite: ${c.fechaLimite}\nEstado: ${diasTexto}\nNivel: ${c.nivel}\n${c.notas}`,
  };
}
