// Plantillas de correo del autopiloto de licitaciones (paridad3 L-P3-08/09/11 + resumen semanal): cambio de bases detectado en
// la ingesta, nuevo match, expediente listo para aprobar, aprobacion invalidada y resumen semanal. Deterministas (sin IA), sobre
// el layout de marca de `layout.ts`. Todo texto que venga de una fuente externa o de un humano (titulos de convocatorias)
// pasa por `escapeHtml` antes de entrar al HTML. El correo va a miembros de la organizacion duena de la convocatoria; la
// campana in-app, en cambio, NUNCA lleva titulos (ver catalogo de notificaciones).
import { escapeHtml, renderCorreo } from "./layout.ts";
import type { Correo } from "./alert-templates.ts";

const ETIQUETA_CAMPO: Readonly<Record<string, string>> = {
  title: "Título",
  submissionDeadline: "Plazo de presentación",
  contractingBody: "Entidad convocante",
  cpvCodes: "Clasificadores",
  budgetAmount: "Monto",
  currency: "Moneda",
  state: "Entidad federativa",
  procedureTypeRaw: "Tipo de procedimiento",
  documents: "Documentos de las bases",
};

/** Nombre legible de un campo versionable; un campo desconocido se muestra tal cual (nunca se oculta un cambio). */
export function etiquetaCampoBases(campo: string): string {
  return ETIQUETA_CAMPO[campo] ?? campo;
}

export interface BasesModificadasCorreoDatos {
  readonly tenderTitle: string;
  readonly version: number;
  readonly camposCambiados: readonly string[];
  readonly aprobacionesInvalidadas: number;
}

export function correoBasesModificadas(d: BasesModificadasCorreoDatos): Correo {
  const campos = d.camposCambiados.map(etiquetaCampoBases);
  const invalidadas = d.aprobacionesInvalidadas > 0 ? ` Se invalidaron ${d.aprobacionesInvalidadas} aprobación(es) vigente(s): hay que volver a aprobarlas.` : "";
  const html = renderCorreo({
    titulo: "La fuente cambió las bases de una convocatoria que ya estás trabajando",
    preheader: `${d.tenderTitle} — cambió: ${campos.join(", ")}`,
    etiqueta: { texto: "Cambio de bases", color: "#b45309" },
    parrafosHtml: [`La fuente publicó cambios en <strong>${escapeHtml(d.tenderTitle)}</strong> (versión ${escapeHtml(String(d.version))}).${escapeHtml(invalidadas)}`],
    tabla: { filas: [{ etiqueta: "Qué cambió", valor: campos.join(", ") }, { etiqueta: "Versión", valor: String(d.version) }] },
    nota: "Abre la convocatoria en Seguimiento para ver el detalle del cambio y revisar las secciones que dependían de él.",
    piePorQueLlego: "Recibes este correo porque tienes rol owner/admin en una organización de atiende con una convocatoria cuyas bases cambiaron.",
  });
  return {
    asunto: `Cambiaron las bases: ${d.tenderTitle}`,
    html,
    texto: `La fuente cambió las bases de "${d.tenderTitle}" (versión ${d.version}). Qué cambió: ${campos.join(", ")}.${invalidadas}`,
  };
}

export interface NuevoMatchItem {
  readonly title: string;
  readonly score: number;
  readonly deadlineLabel: string | null;
}

export interface NuevoMatchCorreoDatos {
  /** Las mejores convocatorias (ya recortadas por quien llama). */
  readonly items: readonly NuevoMatchItem[];
  /** Total de coincidencias de esta corrida (puede ser mayor que `items.length`). */
  readonly total: number;
}

export function correoNuevoMatch(d: NuevoMatchCorreoDatos): Correo {
  const resto = d.total - d.items.length;
  const html = renderCorreo({
    titulo: d.total === 1 ? "Una convocatoria nueva coincide con el perfil de tu empresa" : `${d.total} convocatorias nuevas coinciden con el perfil de tu empresa`,
    preheader: d.items.map((i) => i.title).join(" · "),
    etiqueta: { texto: "Nuevo match", color: "#1D4ED8" },
    parrafosHtml: [
      "El descubrimiento automático encontró convocatorias con plazo vigente que cumplen los criterios de tu perfil:",
      ...d.items.map((i) => `• <strong>${escapeHtml(i.title)}</strong> — afinidad ${escapeHtml(String(i.score))}/100${i.deadlineLabel ? `, plazo ${escapeHtml(i.deadlineLabel)}` : ""}`),
      ...(resto > 0 ? [`Y ${escapeHtml(String(resto))} más en el panel.`] : []),
    ],
    nota: "Abre Convocatorias para revisar cada una y decidir si participas (Go / No-Go). Atiende no envía ofertas por ti.",
    piePorQueLlego: "Recibes este correo porque tienes rol owner/admin en una organización de atiende con el aviso de nuevas convocatorias activo.",
  });
  return {
    asunto: d.total === 1 ? `Nuevo match: ${d.items[0]?.title ?? "convocatoria"}` : `${d.total} convocatorias nuevas coinciden con tu perfil`,
    html,
    texto: `Convocatorias nuevas que coinciden con tu perfil (${d.total}):\n${d.items.map((i) => `- ${i.title} (afinidad ${i.score}/100${i.deadlineLabel ? `, plazo ${i.deadlineLabel}` : ""})`).join("\n")}${resto > 0 ? `\nY ${resto} más en el panel.` : ""}`,
  };
}

export function correoExpedienteListo(d: { readonly tenderTitle: string }): Correo {
  const html = renderCorreo({
    titulo: "Un expediente quedó sin bloqueos y espera la aprobación 1/2",
    preheader: d.tenderTitle,
    etiqueta: { texto: "Listo para aprobar", color: "#15803d" },
    parrafosHtml: [`El checklist de integridad de <strong>${escapeHtml(d.tenderTitle)}</strong> ya no tiene bloqueos.`],
    nota: "La aprobación sigue siendo de una persona con rol de decisión (con confirmación adicional): nada se aprueba automáticamente.",
    piePorQueLlego: "Recibes este correo porque tienes rol owner/admin en una organización de atiende con un expediente listo para su primera aprobación.",
  });
  return { asunto: `Expediente listo para aprobar: ${d.tenderTitle}`, html, texto: `El expediente de "${d.tenderTitle}" quedó sin bloqueos y espera la aprobación 1/2. Nada se aprueba automáticamente.` };
}

export function correoAprobacionInvalidada(d: { readonly tenderTitle: string }): Correo {
  const html = renderCorreo({
    titulo: "Cambió un insumo y se invalidó una aprobación vigente",
    preheader: d.tenderTitle,
    etiqueta: { texto: "Aprobación invalidada", color: "#b91c1c" },
    parrafosHtml: [`Una aprobación del expediente de <strong>${escapeHtml(d.tenderTitle)}</strong> dejó de ser válida porque cambió uno de sus insumos.`],
    nota: "Revisa el expediente y vuelve a solicitar la aprobación cuando los insumos estén correctos.",
    piePorQueLlego: "Recibes este correo porque tienes rol owner/admin en una organización de atiende con un expediente cuya aprobación se invalidó.",
  });
  return { asunto: `Se invalidó una aprobación: ${d.tenderTitle}`, html, texto: `Una aprobación del expediente de "${d.tenderTitle}" se invalidó porque cambió uno de sus insumos. Hay que volver a aprobarla.` };
}

export interface ResumenSemanalCorreoDatos {
  readonly semanaDesde: string; // "YYYY-MM-DD" (lunes)
  readonly matches: readonly NuevoMatchItem[];
  readonly totalMatches: number;
  readonly plazos: readonly { readonly title: string; readonly deadlineLabel: string }[];
  readonly documentosPorVencer: number;
  readonly facturasVencidas: number;
  readonly garantiasPorVencer: number;
}

export function correoResumenSemanal(d: ResumenSemanalCorreoDatos): Correo {
  const filas = [
    { etiqueta: "Convocatorias nuevas con match", valor: String(d.totalMatches) },
    { etiqueta: "Plazos de presentación esta semana", valor: String(d.plazos.length) },
    { etiqueta: "Documentos de la empresa por vencer (30 días)", valor: String(d.documentosPorVencer) },
    { etiqueta: "Facturas de contratos vencidas", valor: String(d.facturasVencidas) },
    { etiqueta: "Garantías por vencer", valor: String(d.garantiasPorVencer) },
  ];
  const html = renderCorreo({
    titulo: "Tu resumen semanal de licitaciones",
    preheader: `Semana del ${d.semanaDesde}: ${d.totalMatches} con match, ${d.plazos.length} plazos`,
    etiqueta: { texto: "Resumen semanal", color: "#1D4ED8" },
    parrafosHtml: [
      ...(d.matches.length > 0 ? ["Mejores convocatorias nuevas:", ...d.matches.map((i) => `• <strong>${escapeHtml(i.title)}</strong> — afinidad ${escapeHtml(String(i.score))}/100`)] : []),
      ...(d.plazos.length > 0 ? ["Plazos de esta semana:", ...d.plazos.map((p) => `• <strong>${escapeHtml(p.title)}</strong> — ${escapeHtml(p.deadlineLabel)}`)] : []),
    ],
    tabla: { filas },
    nota: "Abre el panel de licitaciones para atender cada punto.",
    piePorQueLlego: "Recibes este correo porque tienes rol owner/admin en una organización de atiende; llega los lunes solo cuando hay algo que contar.",
  });
  const texto = [
    `Resumen semanal de licitaciones (semana del ${d.semanaDesde})`,
    ...filas.map((f) => `${f.etiqueta}: ${f.valor}`),
    ...d.plazos.map((p) => `Plazo: ${p.title} — ${p.deadlineLabel}`),
  ].join("\n");
  return { asunto: `Resumen semanal de licitaciones (semana del ${d.semanaDesde})`, html, texto };
}
