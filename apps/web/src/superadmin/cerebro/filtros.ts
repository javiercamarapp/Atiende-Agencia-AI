// Filtros, orden, plazas y CSV del Cerebro (portados de cerebro.tsx de Likida y adaptados a Atiende): giro -> VERTICAL/subtipo,
// fuentes -> las fuentes que de verdad hay en la cartera, tamano -> rangos de la taxonomia de la vertical. Funciones puras (se
// prueban sin React). Un score `null` ("sin calificar") NO pasa un minimo mayor que 0: no se le adivina un numero para que pase.
import type { ProspectoMapa } from "./datos.ts";
import { tieneCoordenadas } from "./datos.ts";
import { nombreEtapa } from "./embudo.ts";
import { haversineKm } from "./geo.ts";
import { nombreVertical } from "./verticales.ts";

export type OrdenCerebro = "cierre" | "urgencia" | "ajuste" | "completos" | "recientes";

export interface Filtros {
  /** null = todas. Un clic AGREGA el chip, otro lo quita; el conjunto vacio vuelve a null (aditivo, como Likida). */
  readonly verticales: ReadonlySet<string> | null;
  readonly etapas: ReadonlySet<string> | null;
  readonly subtipos: ReadonlySet<string> | null;
  readonly tamanos: ReadonlySet<string> | null;
  readonly fuentes: ReadonlySet<string> | null;
  readonly minUrgencia: 0 | 50 | 70;
  readonly minAjuste: 0 | 40 | 65 | 85;
  readonly minCierre: 0 | 40 | 65 | 85;
  readonly minCompletitud: 0 | 50 | 75;
  readonly sinToqueDias: 0 | 7 | 14 | 30;
  readonly soloTel: boolean;
  readonly soloDecisor: boolean;
  /** Solo los que SI se pueden contactar hoy: con base de licitud registrada y sin el destino en la lista de supresion. */
  readonly soloContactable: boolean;
  readonly busqueda: string;
  readonly orden: OrdenCerebro;
  /** Centro elegido de la lista de plazas + radio (0 = apagado). Con radio activo solo pasan los que TIENEN coordenadas. */
  readonly centro: { readonly lat: number; readonly lng: number; readonly nombre: string } | null;
  readonly radioKm: number;
}

export const SIN_FILTROS: Filtros = {
  verticales: null,
  etapas: null,
  subtipos: null,
  tamanos: null,
  fuentes: null,
  minUrgencia: 0,
  minAjuste: 0,
  minCierre: 0,
  minCompletitud: 0,
  sinToqueDias: 0,
  soloTel: false,
  soloDecisor: false,
  soloContactable: false,
  busqueda: "",
  orden: "cierre",
  centro: null,
  radioKm: 0,
};

/** Aditivo: agrega o quita `valor`; el conjunto vacio vuelve a `null` (sin filtro, chips apagados). */
export function alternarEnSet<T>(actual: ReadonlySet<T> | null, valor: T): ReadonlySet<T> | null {
  const s = new Set(actual ?? []);
  if (s.has(valor)) s.delete(valor);
  else s.add(valor);
  return s.size === 0 ? null : s;
}

/** Cuantos filtros hay activos (el numero del boton "Filtros · N"). El orden no cuenta. */
export function contarFiltrosActivos(f: Filtros): number {
  return (
    (f.verticales ? 1 : 0) + (f.etapas ? 1 : 0) + (f.subtipos ? 1 : 0) + (f.tamanos ? 1 : 0) + (f.fuentes ? 1 : 0) +
    (f.minUrgencia ? 1 : 0) + (f.minAjuste ? 1 : 0) + (f.minCierre ? 1 : 0) + (f.minCompletitud ? 1 : 0) + (f.sinToqueDias ? 1 : 0) +
    (f.soloTel ? 1 : 0) + (f.soloDecisor ? 1 : 0) + (f.soloContactable ? 1 : 0) + (f.busqueda.trim() ? 1 : 0) +
    (f.centro && f.radioKm ? 1 : 0)
  );
}

/** Clave de filtro de tamano: el rango es de la TAXONOMIA de cada vertical ("1" sucursales no es "1" habitaciones), asi que va con su vertical. */
export function claveTamano(p: Pick<ProspectoMapa, "vertical" | "tamano">): string {
  return p.tamano === null ? "n/d" : `${p.vertical}:${p.tamano}`;
}

function quitarAcentos(t: string): string {
  return t.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** Contactable hoy: base de licitud registrada (no es contacto legado) y ningun destino suprimido. */
export function esContactable(p: ProspectoMapa): boolean {
  if (p.contactoLegado || p.baseLicitud === null) return false;
  if (p.suprimidoTelefono || p.suprimidoCorreo) return false;
  return p.telefono !== null || p.correo !== null;
}

export function pasaFiltros(p: ProspectoMapa, f: Filtros, ahoraMs: number): boolean {
  if (f.verticales && !f.verticales.has(p.vertical)) return false;
  if (f.etapas && !f.etapas.has(p.estado)) return false;
  if (f.subtipos && !f.subtipos.has(`${p.vertical}:${p.subtipo ?? ""}`)) return false;
  if (f.tamanos && !f.tamanos.has(claveTamano(p))) return false;
  if (f.fuentes && !f.fuentes.has(p.fuente ?? "sin-fuente")) return false;
  if (f.minUrgencia > 0 && (p.urgencia === null || p.urgencia < f.minUrgencia)) return false;
  if (f.minAjuste > 0 && (p.ajuste === null || p.ajuste < f.minAjuste)) return false;
  if (f.minCierre > 0 && (p.cierre === null || p.cierre < f.minCierre)) return false;
  if (f.minCompletitud > 0 && (p.completitud === null || p.completitud < f.minCompletitud)) return false;
  if (f.soloTel && p.telefono === null) return false;
  if (f.soloDecisor && p.contacto === null) return false;
  if (f.soloContactable && !esContactable(p)) return false;
  if (f.sinToqueDias > 0 && p.ultimoToque !== null && ahoraMs - new Date(p.ultimoToque).getTime() < f.sinToqueDias * 86_400_000) return false;
  const q = quitarAcentos(f.busqueda.trim());
  if (q !== "") {
    const pajar = quitarAcentos([p.empresa, p.ciudad, p.municipio, p.entidad, p.contacto, nombreVertical(p.vertical)].filter(Boolean).join(" "));
    if (!pajar.includes(q)) return false;
  }
  if (f.centro && f.radioKm > 0) {
    if (!tieneCoordenadas(p)) return false;
    if (haversineKm(f.centro, { lat: p.lat, lng: p.lng }) > f.radioKm) return false;
  }
  return true;
}

export function filtrar(lista: readonly ProspectoMapa[], f: Filtros, ahoraMs: number): ProspectoMapa[] {
  return lista.filter((p) => pasaFiltros(p, f, ahoraMs));
}

const n = (v: number | null): number => v ?? -1;

/** Orden estable. "recientes" = por fecha de alta descendente; los sin calificar van al final de los ordenes por score. */
export function ordenar(lista: readonly ProspectoMapa[], orden: OrdenCerebro): ProspectoMapa[] {
  const copia = [...lista];
  const porFechaDesc = (a: ProspectoMapa, b: ProspectoMapa) => b.creadoEn.localeCompare(a.creadoEn);
  switch (orden) {
    case "urgencia":
      return copia.sort((a, b) => n(b.urgencia) - n(a.urgencia) || n(b.cierre) - n(a.cierre));
    case "ajuste":
      return copia.sort((a, b) => n(b.ajuste) - n(a.ajuste) || n(b.cierre) - n(a.cierre));
    case "completos":
      return copia.sort((a, b) => n(b.completitud) - n(a.completitud) || n(b.cierre) - n(a.cierre));
    case "recientes":
      return copia.sort(porFechaDesc);
    case "cierre":
    default:
      return copia.sort((a, b) => n(b.cierre) - n(a.cierre) || n(b.urgencia) - n(a.urgencia));
  }
}

export interface Plaza {
  readonly nombre: string;
  readonly lat: number;
  readonly lng: number;
  readonly n: number;
}

/** Las plazas con coordenadas (centro del radio): promedio por ciudad, las 250 con mas prospectos. */
export function calcularPlazas(lista: readonly ProspectoMapa[]): Plaza[] {
  const acc = new Map<string, { lat: number; lng: number; n: number }>();
  for (const p of lista) {
    if (!tieneCoordenadas(p) || !p.ciudad) continue;
    const k = p.entidad ? `${p.ciudad}, ${p.entidad}` : p.ciudad;
    const a = acc.get(k) ?? { lat: 0, lng: 0, n: 0 };
    acc.set(k, { lat: a.lat + p.lat, lng: a.lng + p.lng, n: a.n + 1 });
  }
  return [...acc.entries()]
    .map(([nombre, a]) => ({ nombre, lat: a.lat / a.n, lng: a.lng / a.n, n: a.n }))
    .sort((x, y) => y.n - x.n || x.nombre.localeCompare(y.nombre))
    .slice(0, 250);
}

/** Conteo por vertical sobre la lista dada (para la leyenda filtrable con su numero). */
export function contarPorVertical(lista: readonly ProspectoMapa[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of lista) m.set(p.vertical, (m.get(p.vertical) ?? 0) + 1);
  return m;
}

// ---- CSV ----

export const CABECERA_CSV = [
  "empresa", "vertical", "subtipo", "etapa", "urgencia_pct", "cierre_pct", "ajuste_icp_pct", "completitud_pct",
  "contacto", "telefono", "correo", "ciudad", "municipio", "entidad", "fuente", "base_licitud", "lat", "lng", "notas",
] as const;

/** Neutraliza la inyeccion de formulas de hoja de calculo (=, +, -, @, tab, retorno) al abrir el CSV en Excel. */
function celdaSegura(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** El CSV de la vista actual: columnas fijas, comillas escapadas, BOM para que Excel en español lo abra con acentos. `sin calificar` = celda vacia. */
export function csvDe(lista: readonly ProspectoMapa[]): string {
  const esc = (v: unknown) => `"${celdaSegura(String(v ?? "")).replace(/"/g, '""')}"`;
  const filas = lista.map((p) =>
    [
      p.empresa, nombreVertical(p.vertical), p.subtipo, nombreEtapa(p.estado), p.urgencia, p.cierre, p.ajuste, p.completitud,
      p.contacto, p.telefono, p.correo, p.ciudad, p.municipio, p.entidad, p.fuente, p.baseLicitud, p.lat, p.lng, p.notas,
    ].map(esc).join(","),
  );
  return `\ufeff${[CABECERA_CSV.join(","), ...filas].join("\n")}`;
}

/** Tope de la bitacora: filtros::text <= 2000 en el SQL de 0034. Se recorta con margen para que una combinacion amplia nunca la rebase. */
const TOPE_FILTROS_BITACORA = 1900;

/** Los filtros como los registra la bitacora: solo la FORMA de la consulta, nunca datos de prospectos. Cabe siempre en 2000 caracteres. */
export function filtrosParaBitacora(f: Filtros): Record<string, unknown> {
  const armar = (max: number): Record<string, unknown> => {
    const lista = (s: ReadonlySet<string> | null) => (s ? [...s].slice(0, max).map((x) => x.slice(0, 80)) : null);
    return {
      verticales: lista(f.verticales),
      etapas: lista(f.etapas),
      subtipos: lista(f.subtipos),
      tamanos: lista(f.tamanos),
      fuentes: lista(f.fuentes),
      minUrgencia: f.minUrgencia,
      minAjuste: f.minAjuste,
      minCierre: f.minCierre,
      minCompletitud: f.minCompletitud,
      sinToqueDias: f.sinToqueDias,
      soloTel: f.soloTel,
      soloDecisor: f.soloDecisor,
      soloContactable: f.soloContactable,
      orden: f.orden,
      radioKm: f.radioKm,
      conBusqueda: f.busqueda.trim() !== "",
    };
  };
  for (const max of [40, 20, 10, 5, 2, 1, 0]) {
    const r = armar(max);
    if (JSON.stringify(r).length <= TOPE_FILTROS_BITACORA) return r;
  }
  return armar(0);
}
