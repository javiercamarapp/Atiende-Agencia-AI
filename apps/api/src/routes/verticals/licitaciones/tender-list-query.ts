// Parseo de los filtros de listado de convocatorias (GET .../tenders y GET .../tenders/matching). Un valor invalido es un 400 con el
// nombre del parametro: nunca se ignora en silencio, porque un filtro ignorado devuelve MAS de lo pedido y el usuario no lo nota.
import { TENDER_IDS_MAX, TENDER_STATUSES } from "@atiende/domain-licitaciones";
import type { TenderListFilter } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_RE = /^[a-z0-9_-]{1,64}$/;
const Q_MAX = 200;

export const DEFAULT_TENDERS_LIMIT = 50;
export const MAX_TENDERS_LIMIT = 200;

export function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

export function parseOffset(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function parseInstant(raw: string, field: string): string {
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(raw) || Number.isNaN(new Date(raw).getTime())) {
    throw Errors.validation(`${field}: se esperaba una fecha ISO 8601 con zona horaria explícita.`);
  }
  return raw;
}

export function parseTenderListFilter(query: (name: string) => string | undefined): TenderListFilter {
  const filter: { -readonly [K in keyof TenderListFilter]: TenderListFilter[K] } = {};
  const q = query("q");
  if (q !== undefined && q.trim().length > 0) {
    if (q.length > Q_MAX) throw Errors.validation(`q: máximo ${Q_MAX} caracteres.`);
    filter.q = q.trim();
  }
  const status = query("status");
  if (status !== undefined && status !== "") {
    if (!(TENDER_STATUSES as readonly string[]).includes(status)) throw Errors.validation(`status: valor no válido (${TENDER_STATUSES.join(", ")}).`);
    filter.status = status;
  }
  const source = query("source");
  if (source !== undefined && source !== "") {
    if (!SOURCE_RE.test(source)) throw Errors.validation("source: valor no válido.");
    filter.source = source;
  }
  const from = query("deadlineFrom");
  if (from !== undefined && from !== "") filter.deadlineFrom = parseInstant(from, "deadlineFrom");
  const to = query("deadlineTo");
  if (to !== undefined && to !== "") filter.deadlineTo = parseInstant(to, "deadlineTo");
  const ids = query("ids");
  if (ids !== undefined && ids !== "") {
    const list = [...new Set(ids.split(",").map((x) => x.trim()).filter((x) => x.length > 0))];
    if (list.length > TENDER_IDS_MAX) throw Errors.validation(`ids: máximo ${TENDER_IDS_MAX} identificadores por petición.`);
    if (!list.every((x) => UUID_RE.test(x))) throw Errors.validation("ids: se esperaba una lista de UUID separados por coma.");
    filter.ids = list;
  }
  const open = query("open");
  if (open === "true" || open === "1") filter.openOnly = true;
  return filter;
}
