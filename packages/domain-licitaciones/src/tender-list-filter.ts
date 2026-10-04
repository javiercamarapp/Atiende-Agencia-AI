// Filtros, resumen y pagina de convocatorias (paridad3 L-P3-13). Un solo contrato para el repositorio en memoria y el de Postgres: el
// filtro SIEMPRE se aplica en el servidor (nada de filtrar en memoria sobre una pagina ya cortada) y el resumen cuenta sobre TODA la
// organizacion, no sobre la primera pagina.
import type { TenderRecord } from "./types.ts";

/** Estados que ya no piden accion: coinciden con `convocatoriasAbiertas` del Resumen web (apps/web .../lib/resumen.ts). */
export const TENDER_CLOSED_STATUSES: readonly string[] = ["won", "lost", "cancelled", "no_go"];

export const TENDER_IDS_MAX = 200;

export interface TenderListFilter {
  /** Texto libre: coincide (sin distinguir mayusculas) con titulo, folio (externalId) o convocante. */
  readonly q?: string;
  readonly status?: string;
  readonly source?: string;
  /** Plazo de presentacion >= este instante (ISO con offset). Excluye convocatorias sin plazo. */
  readonly deadlineFrom?: string;
  /** Plazo de presentacion <= este instante (ISO con offset). Excluye convocatorias sin plazo. */
  readonly deadlineTo?: string;
  /** Solo estas convocatorias (maximo `TENDER_IDS_MAX`). */
  readonly ids?: readonly string[];
  /** Solo convocatorias sin resolver (ni ganadas, perdidas, canceladas ni no-go). */
  readonly openOnly?: boolean;
}

export interface TenderPageOptions extends TenderListFilter {
  readonly limit: number;
  readonly offset: number;
}

export interface TenderSummaryCounts {
  /** Todas las convocatorias de la organizacion. */
  readonly total: number;
  /** Sin resolver (ni ganadas, perdidas, canceladas ni no-go). */
  readonly open: number;
  /** Abiertas, no presentadas, con plazo entre `now` y `now + windowDays`. */
  readonly closingSoon: number;
  readonly windowDays: number;
  readonly byStatus: Readonly<Record<string, number>>;
}

const DIA_MS = 24 * 60 * 60 * 1000;

/** Escapa los comodines de LIKE/ILIKE para que el texto del usuario se busque literal. */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function matchesTenderFilter(tender: TenderRecord, filter: TenderListFilter): boolean {
  if (filter.status !== undefined && tender.status !== filter.status) return false;
  if (filter.source !== undefined && tender.source !== filter.source) return false;
  if (filter.openOnly && tender.status !== undefined && tender.status !== null && TENDER_CLOSED_STATUSES.includes(tender.status)) return false;
  if (filter.ids !== undefined && !filter.ids.includes(tender.id)) return false;
  if (filter.q !== undefined && filter.q.trim().length > 0) {
    const needle = filter.q.trim().toLowerCase();
    const hay = [tender.title, tender.externalId ?? "", tender.contractingBody ?? ""].some((s) => s.toLowerCase().includes(needle));
    if (!hay) return false;
  }
  if (filter.deadlineFrom !== undefined || filter.deadlineTo !== undefined) {
    if (tender.submissionDeadline === null) return false;
    const ms = new Date(tender.submissionDeadline).getTime();
    if (filter.deadlineFrom !== undefined && ms < new Date(filter.deadlineFrom).getTime()) return false;
    if (filter.deadlineTo !== undefined && ms > new Date(filter.deadlineTo).getTime()) return false;
  }
  return true;
}

/** Orden total y estable de la lista: recientes primero y el id desempata (sin desempate, dos filas con el mismo `updated_at` saltan o se repiten entre paginas). */
export function compareTendersForList(a: TenderRecord, b: TenderRecord): number {
  const ta = new Date(a.updatedAt).getTime();
  const tb = new Date(b.updatedAt).getTime();
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function summarizeTenderRecords(tenders: readonly TenderRecord[], nowMs: number, windowDays: number): TenderSummaryCounts {
  const byStatus: Record<string, number> = {};
  let open = 0;
  let closingSoon = 0;
  for (const t of tenders) {
    const status = t.status ?? "discovered";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (TENDER_CLOSED_STATUSES.includes(status)) continue;
    open += 1;
    if (status !== "submitted" && t.submissionDeadline !== null) {
      const ms = new Date(t.submissionDeadline).getTime() - nowMs;
      if (ms >= 0 && ms <= windowDays * DIA_MS) closingSoon += 1;
    }
  }
  return { total: tenders.length, open, closingSoon, windowDays, byStatus };
}
