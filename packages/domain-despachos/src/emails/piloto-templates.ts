// paridad3 D-31 / D-P3-21 -- correos al CLIENTE del despacho (no al staff): solicitud de documentos del mes, recordatorios y entrega de reportes
// al cerrar el periodo. Construidos sobre el marco de layout.ts. El enlace lleva el token del portal en el FRAGMENTO (`#t=...`): el navegador nunca lo
// envia al servidor ni lo deja en Referer. Ningun correo lleva montos, RFC ni datos fiscales: solo el nombre del cliente, el periodo y lo que falta.
import { escapeHtml, renderCorreo } from "./layout.ts";
import type { Correo } from "./vencimiento-templates.ts";

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

export function nombrePeriodo(ejercicio: number, mes: number): string {
  return `${MESES[mes - 1] ?? String(mes)} de ${ejercicio}`;
}

function enlaceHtml(enlace: string, texto: string): string {
  return `<a href="${escapeHtml(enlace)}" style="color:#1D4ED8;font-weight:600;text-decoration:underline;">${escapeHtml(texto)}</a>`;
}

export interface SolicitudDocumentosCorreo {
  readonly clienteNombre: string;
  readonly ejercicio: number;
  readonly mes: number;
  /** Etiquetas de los renglones que se piden (ya sin datos sensibles: las cuentas van enmascaradas). */
  readonly renglones: readonly string[];
  readonly enlace: string | null;
}

export function correoSolicitudDocumentos(c: SolicitudDocumentosCorreo): Correo {
  const periodo = nombrePeriodo(c.ejercicio, c.mes);
  const html = renderCorreo({
    titulo: `Documentos de ${periodo}`,
    preheader: `Tu despacho necesita estos documentos de ${periodo} para cerrar el mes.`,
    etiqueta: { texto: "Solicitud de documentos", color: "#1D4ED8" },
    parrafosHtml: [
      `Hola, para cerrar <strong>${escapeHtml(periodo)}</strong> de <strong>${escapeHtml(c.clienteNombre)}</strong> tu despacho necesita que le compartas lo siguiente:`,
      `<ul style="margin:0 0 4px 18px;padding:0;">${c.renglones.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>`,
      c.enlace ? `Súbelos desde tu portal seguro: ${enlaceHtml(c.enlace, "abrir mi portal")}.` : "Compártelos con tu despacho por el canal de siempre.",
    ],
    nota: c.enlace ? "El enlace es personal y tiene una vigencia limitada. No lo compartas." : undefined,
    piePorQueLlego: `Recibes este correo porque tu despacho contable te pidió documentos de ${periodo} a través de atiende.`,
  });
  return {
    asunto: `Documentos de ${periodo} para tu contabilidad`,
    html,
    texto: `Para cerrar ${periodo} de ${c.clienteNombre} tu despacho necesita:\n${c.renglones.map((r) => `- ${r}`).join("\n")}\n${c.enlace ? `\nSúbelos aquí: ${c.enlace}` : ""}`,
  };
}

export interface RecordatorioDocumentosCorreo extends Omit<SolicitudDocumentosCorreo, "renglones"> {
  readonly pendientes: number;
  readonly dias: number;
}

export function correoRecordatorioDocumentos(c: RecordatorioDocumentosCorreo): Correo {
  const periodo = nombrePeriodo(c.ejercicio, c.mes);
  const urgente = c.dias >= 10;
  const html = renderCorreo({
    titulo: `Aún faltan documentos de ${periodo}`,
    preheader: `Faltan ${c.pendientes} documento(s) para cerrar ${periodo}.`,
    etiqueta: { texto: urgente ? "Recordatorio urgente" : "Recordatorio", color: urgente ? "#dc2626" : "#b45309" },
    parrafosHtml: [
      `Hace ${c.dias} días tu despacho te pidió documentos de <strong>${escapeHtml(periodo)}</strong> para <strong>${escapeHtml(c.clienteNombre)}</strong> y todavía faltan <strong>${c.pendientes}</strong>.`,
      c.enlace ? `Puedes subirlos en cualquier momento desde tu portal: ${enlaceHtml(c.enlace, "abrir mi portal")}.` : "Compártelos con tu despacho por el canal de siempre.",
      "Sin ellos tu despacho no puede cerrar el mes ni preparar tus declaraciones a tiempo.",
    ],
    piePorQueLlego: `Recibes este correo porque tu despacho contable te pidió documentos de ${periodo} a través de atiende.`,
  });
  return {
    asunto: `${urgente ? "Urgente: " : ""}Faltan ${c.pendientes} documento(s) de ${periodo}`,
    html,
    texto: `Faltan ${c.pendientes} documento(s) de ${periodo} para ${c.clienteNombre} (pedidos hace ${c.dias} días).${c.enlace ? `\nSúbelos aquí: ${c.enlace}` : ""}`,
  };
}

export interface EntregaReportesCorreo {
  readonly clienteNombre: string;
  readonly ejercicio: number;
  readonly mes: number;
  readonly archivos: readonly string[];
  readonly enlace: string;
}

export function correoEntregaReportes(c: EntregaReportesCorreo): Correo {
  const periodo = nombrePeriodo(c.ejercicio, c.mes);
  const html = renderCorreo({
    titulo: `Tus reportes de ${periodo}`,
    preheader: `Tu despacho cerró ${periodo}: ya puedes descargar tus reportes.`,
    etiqueta: { texto: "Cierre de periodo", color: "#15803d" },
    parrafosHtml: [
      `Tu despacho cerró <strong>${escapeHtml(periodo)}</strong> de <strong>${escapeHtml(c.clienteNombre)}</strong>. Ya puedes descargar:`,
      `<ul style="margin:0 0 4px 18px;padding:0;">${c.archivos.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`,
      `Descárgalos desde tu portal seguro: ${enlaceHtml(c.enlace, "abrir mi portal")}.`,
    ],
    nota: "El enlace es personal y tiene una vigencia limitada. No lo compartas. Si no quieres recibir estos reportes, pídele a tu despacho que desactive el envío.",
    piePorQueLlego: `Recibes este correo porque tu despacho contable activó el envío de reportes al cerrar cada periodo a través de atiende.`,
  });
  return {
    asunto: `Tus reportes de ${periodo} están listos`,
    html,
    texto: `Tu despacho cerró ${periodo} de ${c.clienteNombre}. Reportes disponibles:\n${c.archivos.map((a) => `- ${a}`).join("\n")}\nDescárgalos aquí: ${c.enlace}`,
  };
}
