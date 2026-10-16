// L-29 -- bitacora visible por convocatoria: une, en orden temporal, eventos que YA existen en
// tablas distintas (auditoria de alta/edicion manual, anotaciones de la sala de guerra, decisiones
// go/no-go, aprobaciones del expediente y declaracion de presentacion). Solo lectura: no crea tablas
// ni escribe nada. Funcion PURA (sin I/O): la ruta lee cada fuente y esta funcion mezcla, filtra y pagina.
//
// Aprobaciones: solo las VIGENTES (el repositorio no expone las invalidadas; no se agregan tablas ni metodos nuevos).
//
// Privacidad: el evento NUNCA lleva el id ni el correo de otra persona; solo `esTuyo` (si el actor es
// quien consulta) y, si se conoce, su rol. El texto de las anotaciones de la sala es contenido que la
// organizacion ya ve en la sala de guerra.
import type { Approval } from "./approval-workflow.ts";
import type { GoNoGoDecisionRecord, SubmissionRecord } from "./types.ts";
import type { WarRoomEntryRecord } from "./sala-guerra.ts";

export const BITACORA_FUENTES = ["auditoria", "sala_guerra", "go_no_go", "aprobacion", "presentacion"] as const;
export type BitacoraFuente = (typeof BITACORA_FUENTES)[number];

export function isBitacoraFuente(value: unknown): value is BitacoraFuente {
  return typeof value === "string" && (BITACORA_FUENTES as readonly string[]).includes(value);
}

export const BITACORA_DEFAULT_LIMIT = 25;
export const BITACORA_MAX_LIMIT = 100;

export interface BitacoraEvento {
  /** Estable y unico entre fuentes (`<fuente>:<id>[:sufijo]`). */
  readonly id: string;
  readonly fuente: BitacoraFuente;
  /** Codigo corto de la accion (para filtrar o pintar un icono). */
  readonly accion: string;
  readonly descripcion: string;
  readonly at: string;
  readonly actor: { readonly esTuyo: boolean | null; readonly rol: string | null };
}

export interface BitacoraFuentes {
  readonly auditoria: readonly { readonly id: string; readonly action: string; readonly actorId: string; readonly createdAt: string }[];
  readonly salaGuerra: readonly WarRoomEntryRecord[];
  readonly goNoGo: readonly GoNoGoDecisionRecord[];
  readonly aprobaciones: readonly Approval[];
  readonly presentacion: SubmissionRecord | null;
}

export interface BitacoraFiltros {
  readonly fuente?: BitacoraFuente;
  /** ISO inclusivo. */
  readonly desde?: string;
  /** ISO inclusivo. */
  readonly hasta?: string;
}

export interface BitacoraPagina {
  readonly items: readonly BitacoraEvento[];
  readonly total: number;
  readonly nextOffset: number | null;
  readonly limit: number;
  readonly offset: number;
}

const AUDIT_TEXT: Readonly<Record<string, string>> = {
  "tender.manual_upsert.created": "Se dio de alta la convocatoria de forma manual.",
  "tender.manual_upsert.updated": "Se actualizaron las bases de la convocatoria de forma manual.",
  "document.uploaded": "Se subió un documento de la convocatoria a la bóveda.",
  "requirements.extracted": "Se extrajeron los requisitos de las bases.",
  "requirement.edited": "Se editó un requisito de la matriz (responsable, estado o causa de desechamiento).",
  "requirement.conflict_resolved": "Se resolvió un conflicto entre requisitos.",
  "section.edited": "Se editó una sección de la propuesta (las aprobaciones vigentes de esa sección se invalidaron).",
};

const SALA_KIND_TEXT = { decision: "Decisión", comentario: "Comentario", evento: "Evento" } as const;
const STAGE_TEXT = { tecnica_legal: "técnico-legal (1/2)", economica: "económica (2/2)" } as const;

function ts(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

export function buildBitacoraEventos(fuentes: BitacoraFuentes, viewerUserId: string): BitacoraEvento[] {
  const out: BitacoraEvento[] = [];
  const quien = (id: string | null | undefined) => (id ? id === viewerUserId : null);

  for (const a of fuentes.auditoria) {
    out.push({ id: `auditoria:${a.id}`, fuente: "auditoria", accion: a.action, descripcion: AUDIT_TEXT[a.action] ?? `Acción de auditoría: ${a.action}.`, at: a.createdAt, actor: { esTuyo: quien(a.actorId), rol: null } });
  }
  for (const e of fuentes.salaGuerra) {
    out.push({ id: `sala_guerra:${e.id}`, fuente: "sala_guerra", accion: e.entryKind, descripcion: `${SALA_KIND_TEXT[e.entryKind]} en la sala de guerra: ${e.body}`, at: e.createdAt, actor: { esTuyo: e.entryKind === "evento" ? null : quien(e.authorId), rol: null } });
  }
  for (const d of fuentes.goNoGo) {
    out.push({ id: `go_no_go:${d.id}`, fuente: "go_no_go", accion: d.decision, descripcion: `Decisión ${d.decision === "go" ? "Go" : "No-go"} registrada${d.reasons.length ? ` (${d.reasons.length} motivo(s))` : ""}.`, at: d.decidedAt, actor: { esTuyo: quien(d.decidedBy), rol: null } });
  }
  for (const ap of fuentes.aprobaciones) {
    if (ap.scope !== "expediente") continue;
    const etapa = ap.stage ? `Aprobación ${STAGE_TEXT[ap.stage]} del expediente` : "Aprobación del expediente";
    out.push({ id: `aprobacion:${ap.id}`, fuente: "aprobacion", accion: ap.stage ? `aprobada_${ap.stage}` : "aprobada", descripcion: `${etapa}.`, at: ap.approvedAt, actor: { esTuyo: quien(ap.approvedBy), rol: ap.approvedByRole } });
  }
  if (fuentes.presentacion) {
    out.push({ id: `presentacion:${fuentes.presentacion.id}`, fuente: "presentacion", accion: "declarada", descripcion: `Se declaró la presentación del expediente (fecha declarada ${fuentes.presentacion.submittedAt}).`, at: fuentes.presentacion.createdAt, actor: { esTuyo: null, rol: null } });
  }
  return out;
}

/** Mezcla ya construida: filtra, ordena (mas reciente primero, `id` desc como desempate total) y pagina. */
export function paginarBitacora(eventos: readonly BitacoraEvento[], filtros: BitacoraFiltros, opts: { limit?: number; offset?: number } = {}): BitacoraPagina {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? BITACORA_DEFAULT_LIMIT), 1), BITACORA_MAX_LIMIT);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const desde = filtros.desde ? ts(filtros.desde) : null;
  const hasta = filtros.hasta ? ts(filtros.hasta) : null;
  const filtrados = eventos
    .filter((e) => (filtros.fuente ? e.fuente === filtros.fuente : true))
    .filter((e) => (desde === null ? true : ts(e.at) >= desde))
    .filter((e) => (hasta === null ? true : ts(e.at) <= hasta))
    .sort((a, b) => ts(b.at) - ts(a.at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const items = filtrados.slice(offset, offset + limit);
  const next = offset + limit;
  return { items, total: filtrados.length, nextOffset: next < filtrados.length ? next : null, limit, offset };
}
