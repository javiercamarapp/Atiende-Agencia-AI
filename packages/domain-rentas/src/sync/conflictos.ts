// Rn-02 -- funciones PURAS del monitor de conflictos de calendario: validación de la
// decisión del staff (resuelto / ignorado con motivo), solape de las dos ocupaciones,
// vigencia del solape respecto de "hoy" en la zona horaria de la PROPERTY y resumen de salud
// de sync por canal. Sin I/O: el estado real vive en Postgres (migrations/026) y el acceso
// en ./postgres-repository.ts.
//
// Zona horaria: las fechas de una reserva (`daterange`) son fechas de calendario sin zona,
// pero "hoy" no lo es: el mismo instante es 31-dic 23:30 en CDMX (UTC-6) y 1-ene 00:30 en
// Cancún (UTC-5). Clasificar un conflicto como "ya pasó" o "en curso" con el día UTC o el del
// servidor da un resultado distinto según la property; aquí siempre se usa la zona de la
// property (rentas.property_config.zona_horaria) con CDMX como respaldo.
import { ZONA_HORARIA_NEGOCIO_DEFAULT } from "@atiende/core-tenancy";
import { rangosSeSuperponen } from "../fechas.ts";
import type { FechaLocal, RangoFechas } from "../tipos.ts";
import { clasificarSaludFeed } from "./monitor.ts";
import type { EstadoSaludFeed, FeedMonitorRecord } from "./monitor.ts";

export const MOTIVO_CONFLICTO_MIN = 3;
export const MOTIVO_CONFLICTO_MAX = 500;

export type AccionConflicto = "resuelto" | "ignorado";

export type DecisionConflictoNormalizada = { readonly ok: true; readonly accion: AccionConflicto; readonly motivo: string | null } | { readonly ok: false; readonly error: string };

/** Normaliza lo que manda el cliente. Misma regla que `rentas.resolver_conflicto_calendario`
 * (migración 026): acción en el catálogo, motivo recortado de 3 a 500 caracteres y OBLIGATORIO
 * al ignorar; al resolver es una nota opcional. Validar aquí evita un viaje a la base solo para
 * recibir un 22023. */
export function normalizarDecisionConflicto(accion: unknown, motivo: unknown): DecisionConflictoNormalizada {
  if (accion !== "resuelto" && accion !== "ignorado") return { ok: false, error: 'accion: se esperaba "resuelto" o "ignorado".' };
  if (motivo !== undefined && motivo !== null && typeof motivo !== "string") return { ok: false, error: "motivo: se esperaba texto." };
  const limpio = typeof motivo === "string" ? motivo.trim() : "";
  if (limpio.length > MOTIVO_CONFLICTO_MAX) return { ok: false, error: `motivo: máximo ${MOTIVO_CONFLICTO_MAX} caracteres.` };
  if (accion === "ignorado" && limpio.length < MOTIVO_CONFLICTO_MIN) return { ok: false, error: `motivo: ignorar un conflicto exige un motivo de al menos ${MOTIVO_CONFLICTO_MIN} caracteres.` };
  return { ok: true, accion, motivo: limpio === "" ? null : limpio };
}

/** Zona IANA utilizable: la de la property si el runtime la reconoce, si no la de la plataforma. */
export function resolverZonaHoraria(zona: string | null | undefined): string {
  if (!zona) return ZONA_HORARIA_NEGOCIO_DEFAULT;
  try {
    void new Intl.DateTimeFormat("en-CA", { timeZone: zona });
    return zona;
  } catch {
    return ZONA_HORARIA_NEGOCIO_DEFAULT;
  }
}

/** Fecha de calendario (`YYYY-MM-DD`) que marca el reloj de `zona` en el instante `instanteMs`.
 * Nunca usa `toISOString()` (día UTC) ni la zona del proceso. */
export function fechaLocalEnZona(instanteMs: number, zona: string): FechaLocal {
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: resolverZonaHoraria(zona), year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instanteMs));
  const get = (t: string) => partes.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** `YYYY-MM-DD HH:mm` del reloj de `zona` para un instante ISO; `null` si el instante no es válido. */
export function formatearInstanteEnZona(iso: string | null, zona: string): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: resolverZonaHoraria(zona), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const get = (t: string) => partes.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** Intersección `[inicio, fin)` de dos rangos semiabiertos; `null` si no se cruzan (estancias
 * contiguas -- check-out de una = check-in de la otra -- NO se cruzan). Un rango con fechas
 * inválidas se trata como "sin cruce" en vez de lanzar: el monitor nunca debe romperse por un
 * dato raro. */
export function calcularSolape(a: RangoFechas, b: RangoFechas): RangoFechas | null {
  try {
    if (!rangosSeSuperponen(a, b)) return null;
  } catch {
    return null;
  }
  return { inicio: a.inicio > b.inicio ? a.inicio : b.inicio, fin: a.fin < b.fin ? a.fin : b.fin };
}

export type VigenciaSolape = "pasado" | "en_curso" | "futuro";

/** ¿Las noches en conflicto ya pasaron, están ocurriendo o son futuras, vistas desde "hoy" en la
 * zona de la property? Las noches del solape son `[inicio, fin)`: si hoy >= fin ninguna noche
 * está por venir (el día de `fin` es de check-out); si hoy < inicio todas están por venir. */
export function clasificarVigenciaSolape(solape: RangoFechas, ahoraMs: number, zona: string): VigenciaSolape {
  const hoy = fechaLocalEnZona(ahoraMs, zona);
  if (hoy >= solape.fin) return "pasado";
  if (hoy < solape.inicio) return "futuro";
  return "en_curso";
}

const ORDEN_GRAVEDAD_SALUD: readonly EstadoSaludFeed[] = ["en_cuarentena", "en_backoff", "desactualizado", "sin_sincronizar", "ok", "inactivo"];

export interface ResumenSyncCanal {
  readonly canal: string;
  readonly totalFeeds: number;
  readonly porSalud: Readonly<Record<EstadoSaludFeed, number>>;
  /** El estado más grave entre los feeds ACTIVOS del canal (`inactivo` si ninguno está activo). */
  readonly peor: EstadoSaludFeed;
  /** Unidades distintas con al menos un feed fuera de "ok" (los desconectados no cuentan). */
  readonly unidadesConProblema: number;
  /** Sincronización exitosa más antigua entre los feeds activos con alguna; `null` si ninguno la tiene. */
  readonly sincronizacionMasAntiguaEn: string | null;
}

function porSaludVacio(): Record<EstadoSaludFeed, number> {
  return { ok: 0, desactualizado: 0, en_backoff: 0, en_cuarentena: 0, sin_sincronizar: 0, inactivo: 0 };
}

/** Resumen de salud por canal (Airbnb, Booking, ...), para ver de un vistazo qué canal está
 * fallando sin recorrer feed por feed. Ordenado por gravedad y luego por nombre de canal. */
export function resumirSyncPorCanal(feeds: readonly FeedMonitorRecord[], ahoraMs: number): ResumenSyncCanal[] {
  const porCanal = new Map<string, { salud: Record<EstadoSaludFeed, number>; total: number; unidadesProblema: Set<string>; masAntigua: string | null }>();
  for (const f of feeds) {
    let acc = porCanal.get(f.canalCodigo);
    if (!acc) {
      acc = { salud: porSaludVacio(), total: 0, unidadesProblema: new Set(), masAntigua: null };
      porCanal.set(f.canalCodigo, acc);
    }
    const estado = clasificarSaludFeed(f, ahoraMs);
    acc.salud[estado] += 1;
    acc.total += 1;
    if (estado !== "ok" && estado !== "inactivo") acc.unidadesProblema.add(f.unidadId);
    if (f.activo && f.ultimaSincronizacionExitosaEn && (acc.masAntigua === null || Date.parse(f.ultimaSincronizacionExitosaEn) < Date.parse(acc.masAntigua))) acc.masAntigua = f.ultimaSincronizacionExitosaEn;
  }
  return [...porCanal.entries()]
    .map(([canal, acc]): ResumenSyncCanal => ({
      canal,
      totalFeeds: acc.total,
      porSalud: acc.salud,
      peor: ORDEN_GRAVEDAD_SALUD.find((e) => acc.salud[e] > 0) ?? "inactivo",
      unidadesConProblema: acc.unidadesProblema.size,
      sincronizacionMasAntiguaEn: acc.masAntigua,
    }))
    .sort((a, b) => ORDEN_GRAVEDAD_SALUD.indexOf(a.peor) - ORDEN_GRAVEDAD_SALUD.indexOf(b.peor) || a.canal.localeCompare(b.canal));
}
