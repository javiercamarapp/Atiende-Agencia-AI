// CFO-07 · estado de los filtros del CFO en la URL (`?desde&hasta&sucursales&comparar[&vista]`), para que un enlace comparta la vista.
// Lógica pura (sin React ni reloj propio: recibe `hoy`): atajos de rango, validación (máx. 400 días, igual que el API) y serialización.
// Sin `toLocale*`: las fechas son de calendario `YYYY-MM-DD` y se formatean a mano.
import { COMPARAR_CFO } from "@atiende/domain-restaurantes/cfo";
import type { CompararCfo, Granularidad } from "@atiende/domain-restaurantes/cfo";
import { etiquetasTraducidas, idiomaActivo, traductorActivo } from "@atiende/ui";
import { restaurantesCfo } from "@atiende/ui/i18n/restaurantes/cfo";

const tr = traductorActivo(restaurantesCfo);

export const MAX_DIAS_CFO = 400;
export type VistaCfo = "total" | "sucursal";

export interface FiltrosCfo {
  readonly desde: string;
  readonly hasta: string;
  /** null = «Todas» (las permitidas del actor; para el dueño incluye «No asignado»). */
  readonly sucursales: readonly string[] | null;
  readonly comparar: CompararCfo;
  readonly vista: VistaCfo;
}

/** Etiqueta en el idioma activo (i18n): cada lectura traduce; en espanol, los textos de siempre. */
export const ETIQUETA_COMPARAR: Readonly<Record<CompararCfo, string>> = etiquetasTraducidas<CompararCfo>(
  ["periodo_anterior", "anio_anterior", "mismo_dia_semana_4"],
  (c) => `restaurantes.cfo.comparar.${c}` as const,
  restaurantesCfo,
);

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"] as const;
// Ingles: «Oct 7, 2026» (a mano, como el espanol: sin toLocale ni Intl en el CFO).
const MESES_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const aMs = (f: string): number => Date.parse(`${f}T00:00:00Z`);
const aFecha = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function fechaValida(f: string): boolean {
  if (!FECHA_RE.test(f)) return false;
  // Mismo rango de años que el API (2000..2100): fuera de él el API responde 422.
  const anio = Number(f.slice(0, 4));
  if (anio < 2000 || anio > 2100) return false;
  const ms = aMs(f);
  return !Number.isNaN(ms) && aFecha(ms) === f;
}

export function sumarDias(f: string, dias: number): string {
  return aFecha(aMs(f) + dias * 86_400_000);
}

export function diasEntre(desde: string, hasta: string): number {
  return Math.round((aMs(hasta) - aMs(desde)) / 86_400_000) + 1;
}

/** Fecha local del navegador como `YYYY-MM-DD` (sin toLocale). */
export function hoyLocal(ahora: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${ahora.getFullYear()}-${p(ahora.getMonth() + 1)}-${p(ahora.getDate())}`;
}

/** «2026-10-07» -> «7 oct 2026» («Oct 7, 2026» en ingles); solo día y mes si `conAnio` es false. */
export function etiquetaFecha(f: string, conAnio = true): string {
  if (!fechaValida(f)) return f;
  const [a, m, d] = f.split("-");
  if (idiomaActivo() === "en") return `${MESES_EN[Number(m) - 1]} ${Number(d)}${conAnio ? `, ${a}` : ""}`;

  return `${Number(d)} ${MESES[Number(m) - 1]}${conAnio ? ` ${a}` : ""}`;
}

export function etiquetaRango(desde: string, hasta: string): string {
  return desde === hasta ? etiquetaFecha(desde) : tr("restaurantes.cfo.rango.entre", { desde: etiquetaFecha(desde, false), hasta: etiquetaFecha(hasta) });
}

const primeroDelMes = (f: string): string => `${f.slice(0, 7)}-01`;
const mesAnterior = (f: string): { desde: string; hasta: string } => {
  const ultimo = sumarDias(primeroDelMes(f), -1);
  return { desde: primeroDelMes(ultimo), hasta: ultimo };
};
const primeroDelTrimestre = (f: string): string => {
  const m = Number(f.slice(5, 7));
  const inicio = Math.floor((m - 1) / 3) * 3 + 1;
  return `${f.slice(0, 4)}-${String(inicio).padStart(2, "0")}-01`;
};

export interface AtajoRango {
  readonly id: string;
  readonly etiqueta: string;
  readonly rango: (hoy: string) => { readonly desde: string; readonly hasta: string };
}

type IdAtajo = "hoy" | "ayer" | "7d" | "30d" | "mes" | "mes_anterior" | "trimestre" | "12m";
const ETIQUETA_ATAJO = etiquetasTraducidas<IdAtajo>(["hoy", "ayer", "7d", "30d", "mes", "mes_anterior", "trimestre", "12m"], (id) => `restaurantes.cfo.rango.${id}` as const, restaurantesCfo);
/** `etiqueta` se traduce en cada lectura al idioma activo. */
const atajo = (id: IdAtajo, rango: AtajoRango["rango"]): AtajoRango => ({
  id,
  get etiqueta() {
    return ETIQUETA_ATAJO[id];
  },
  rango,
});

export const ATAJOS_RANGO: readonly AtajoRango[] = [
  atajo("hoy", (h) => ({ desde: h, hasta: h })),
  atajo("ayer", (h) => ({ desde: sumarDias(h, -1), hasta: sumarDias(h, -1) })),
  atajo("7d", (h) => ({ desde: sumarDias(h, -6), hasta: h })),
  atajo("30d", (h) => ({ desde: sumarDias(h, -29), hasta: h })),
  atajo("mes", (h) => ({ desde: primeroDelMes(h), hasta: h })),
  atajo("mes_anterior", (h) => mesAnterior(h)),
  atajo("trimestre", (h) => ({ desde: primeroDelTrimestre(h), hasta: h })),
  atajo("12m", (h) => ({ desde: sumarDias(h, -364), hasta: h })),
];

/** El atajo que produce exactamente este rango, o `personalizado`. */
export function atajoActivo(desde: string, hasta: string, hoy: string): string {
  return ATAJOS_RANGO.find((a) => {
    const r = a.rango(hoy);
    return r.desde === desde && r.hasta === hasta;
  })?.id ?? "personalizado";
}

export function filtrosPorDefecto(hoy: string): FiltrosCfo {
  const r = ATAJOS_RANGO.find((a) => a.id === "7d")!.rango(hoy);
  return { desde: r.desde, hasta: r.hasta, sucursales: null, comparar: "periodo_anterior", vista: "total" };
}

/** Valida un rango como lo hace el API (fechas reales, desde <= hasta, máx. 400 días). Devuelve el mensaje de error o null. */
export function errorDeRango(desde: string, hasta: string): string | null {
  if (!fechaValida(desde) || !fechaValida(hasta)) return tr("restaurantes.cfo.rango.fechasInvalidas");
  if (desde > hasta) return tr("restaurantes.cfo.rango.inicioPosterior");
  if (diasEntre(desde, hasta) > MAX_DIAS_CFO) return tr("restaurantes.cfo.rango.maximo", { n: MAX_DIAS_CFO });

  return null;
}

/** Lee los filtros de la URL; lo que falte o no sea válido cae al valor por defecto (nunca lanza). */
export function leerFiltros(sp: URLSearchParams, hoy: string): FiltrosCfo {
  const base = filtrosPorDefecto(hoy);
  const desde = sp.get("desde") ?? "";
  const hasta = sp.get("hasta") ?? "";
  const rangoOk = errorDeRango(desde, hasta) === null;
  const crudo = sp.get("sucursales");
  let sucursales: string[] | null = null;
  if (crudo && crudo !== "todas") {
    const ids = [...new Set(crudo.split(",").map((x) => x.trim().toLowerCase()))].filter((x) => UUID_RE.test(x));
    if (ids.length > 0 && ids.length <= 20) sucursales = ids;
  }
  const comparar = sp.get("comparar");
  return {
    desde: rangoOk ? desde : base.desde,
    hasta: rangoOk ? hasta : base.hasta,
    sucursales,
    comparar: (COMPARAR_CFO as readonly string[]).includes(comparar ?? "") ? (comparar as CompararCfo) : base.comparar,
    vista: sp.get("vista") === "sucursal" ? "sucursal" : "total",
  };
}

/** Escribe los filtros sobre una copia de los parámetros actuales (conserva los que no son de filtro). */
export function escribirFiltros(sp: URLSearchParams, f: FiltrosCfo): URLSearchParams {
  const out = new URLSearchParams(sp);
  out.set("desde", f.desde);
  out.set("hasta", f.hasta);
  out.set("comparar", f.comparar);
  if (f.sucursales === null) out.delete("sucursales");
  else out.set("sucursales", f.sucursales.join(","));
  if (f.vista === "sucursal") out.set("vista", "sucursal");
  else out.delete("vista");
  return out;
}

/** Granularidad de las series según el largo del rango (el API la acepta como `granularidad`). */
export function granularidadAuto(f: Pick<FiltrosCfo, "desde" | "hasta">): Granularidad {
  const dias = diasEntre(f.desde, f.hasta);
  if (dias <= 45) return "dia";
  if (dias <= 180) return "semana";
  return "mes";
}

/** Query común de las lecturas del API. */
export function consultaApi(f: FiltrosCfo, extra: Readonly<Record<string, string | undefined>> = {}): URLSearchParams {
  const p = new URLSearchParams({ desde: f.desde, hasta: f.hasta, comparar: f.comparar });
  if (f.sucursales !== null) p.set("sucursales", f.sucursales.join(","));
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== "") p.set(k, v);
  return p;
}

