// Resuelve un `ValorFechaIcs` a la fecha de calendario local de la UNIDAD/PROPERTY —
// port funcional de rentas/packages/adapters/src/ical/resolverFecha.ts (repo origen,
// REQ-032, RV06-R-08), adaptado para no depender de `@atiende-rv/domain` (paquete que
// no existe en este monorepo): la conversión de hora de pared <-> instante UTC a
// través de una zona horaria IANA arbitraria se implementa aquí mismo con
// `Intl.DateTimeFormat` (Node trae ICU completo desde Node 18+) — sin introducir
// ninguna dependencia nueva al monorepo, mismo criterio que domain-rentas/fechas.ts
// ("domain-hoteles ya sentó el precedente de no introducir dependencias nuevas").
//
// `DATE` ya es una fecha de calendario pura (sin huso) y se usa tal cual. `DATE-TIME`
// con TZID o UTC se convierte a la zona de la propiedad; `DATE-TIME` flotante (sin
// TZID ni `Z`) se interpreta, conservadoramente, como si ya estuviera en la zona de la
// propiedad (RFC 5545 §3.3.5: una fecha flotante "no está atada a ninguna zona en
// particular" — la lectura razonable en un feed de disponibilidad de una sola
// propiedad es que el emisor ya la generó en la hora local del inmueble).
import { IcsParseError } from "./tipos.ts";
import type { ValorFechaIcs } from "./tipos.ts";

interface PartesFechaHora {
  anio: number;
  mes: number; // 1-12
  dia: number;
  hora: number;
  minuto: number;
  segundo: number;
}

const FECHA_HORA_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/** Lanza `IcsParseError("zona_horaria_invalida", ...)` si `zona` no es una zona
 * horaria IANA que el runtime de ICU reconoce — mismo contrato de errores que el
 * resto del parser (siempre `IcsParseError` con un `codigo` reconocible, nunca un
 * `Error` plano). */
function validarZonaIana(zona: string): void {
  try {
    // Construir el formateador es lo que fuerza la validación de `timeZone`; el
    // resultado en sí no se usa aquí (se cachea y reutiliza en `formatoParaZona`).
    void new Intl.DateTimeFormat("en-US", { timeZone: zona });
  } catch {
    throw new IcsParseError("zona_horaria_invalida", `Zona horaria IANA inválida: "${zona}"`);
  }
}

const FORMATO_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatoParaZona(zona: string): Intl.DateTimeFormat {
  let formato = FORMATO_CACHE.get(zona);
  if (!formato) {
    formato = new Intl.DateTimeFormat("en-US", {
      timeZone: zona,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FORMATO_CACHE.set(zona, formato);
  }
  return formato;
}

/** Wall-clock de `zona` en el instante `instanteMs` (epoch ms UTC). */
function partesEnZona(instanteMs: number, zona: string): PartesFechaHora {
  const partes = formatoParaZona(zona).formatToParts(new Date(instanteMs));
  const porTipo = new Map(partes.map((p) => [p.type, p.value]));
  return {
    anio: Number(porTipo.get("year")),
    mes: Number(porTipo.get("month")),
    dia: Number(porTipo.get("day")),
    hora: Number(porTipo.get("hour")) % 24, // "24" a medianoche con hourCycle h23 en algunos motores ICU
    minuto: Number(porTipo.get("minute")),
    segundo: Number(porTipo.get("second")),
  };
}

function comoEpocaMs(p: PartesFechaHora): number {
  return Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
}

/** Offset (ms) de `zona` respecto a UTC, evaluado en el instante `instanteMs`
 * (positivo al este de UTC). */
function offsetMsEnZona(instanteMs: number, zona: string): number {
  return comoEpocaMs(partesEnZona(instanteMs, zona)) - instanteMs;
}

/** Convierte una hora de pared (interpretada en `zona`) a su instante UTC real —
 * método estándar de "adivinar y refinar" con `Intl.DateTimeFormat`, sin ninguna
 * librería de zonas horarias: el offset de una zona solo cambia en transiciones DST
 * (a lo sumo un par de veces al año), así que dos iteraciones bastan para converger
 * incluso cerca de una transición (aproximación suficiente para disponibilidad de
 * calendario — RFC 5545 §3.3.5 documenta que una hora flotante ya es, por diseño, una
 * interpretación aproximada). */
function utcMsDesdeWallTimeEnZona(wallMs: number, zona: string): number {
  let offset = offsetMsEnZona(wallMs, zona);
  let utcMs = wallMs - offset;
  offset = offsetMsEnZona(utcMs, zona);
  utcMs = wallMs - offset;
  return utcMs;
}

function parsearFechaHoraLocal(fechaHoraLocal: string, contexto: string): PartesFechaHora {
  const m = FECHA_HORA_RE.exec(fechaHoraLocal);
  if (!m) throw new IcsParseError("valor_fecha_invalido", `${contexto}: formato de fecha-hora inesperado "${fechaHoraLocal}"`);
  return {
    anio: Number(m[1]),
    mes: Number(m[2]),
    dia: Number(m[3]),
    hora: Number(m[4]),
    minuto: Number(m[5]),
    segundo: Number(m[6]),
  };
}

function comoFechaLocal(p: { anio: number; mes: number; dia: number }): string {
  return `${String(p.anio).padStart(4, "0")}-${String(p.mes).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}`;
}

/** Resuelve un instante UTC (ISO 8601) a la fecha de calendario en `zona`. */
export function fechaLocalDesdeInstante(instanteIso: string, zona: string): string {
  validarZonaIana(zona);
  const ms = Date.parse(instanteIso);
  if (Number.isNaN(ms)) {
    throw new IcsParseError("valor_fecha_invalido", `instante ISO inválido: "${instanteIso}"`);
  }
  return comoFechaLocal(partesEnZona(ms, zona));
}

/** Resuelve una hora de pared SIN offset (`fechaHoraLocal`, tal como viene en el
 * `.ics`) que pertenece a la zona `tzidOrigen`, a la fecha de calendario resultante en
 * `zonaDestino` — nunca reusa `tzidOrigen` como zona destino, aunque coincida con la
 * de la propiedad: la conversión hora-de-pared -> instante -> hora-de-pared-en-otra-
 * zona no es una operación identidad en general (solo lo es si ambas zonas coinciden
 * exactamente). */
export function fechaLocalDesdeFechaHoraConZona(fechaHoraLocal: string, tzidOrigen: string, zonaDestino: string): string {
  validarZonaIana(tzidOrigen);
  validarZonaIana(zonaDestino);
  const wall = parsearFechaHoraLocal(fechaHoraLocal, `DATE-TIME con TZID="${tzidOrigen}"`);
  const wallMs = comoEpocaMs(wall);
  const instanteMs = utcMsDesdeWallTimeEnZona(wallMs, tzidOrigen);
  return comoFechaLocal(partesEnZona(instanteMs, zonaDestino));
}

export function resolverFechaLocal(valor: ValorFechaIcs, zonaHorariaPropiedad: string): string {
  switch (valor.tipo) {
    case "DATE":
      return valor.fecha;
    case "DATE-TIME-UTC":
      return fechaLocalDesdeInstante(valor.instanteIso, zonaHorariaPropiedad);
    case "DATE-TIME-TZID":
      return fechaLocalDesdeFechaHoraConZona(valor.fechaHoraLocal, valor.tzid, zonaHorariaPropiedad);
    case "DATE-TIME-FLOTANTE":
      return valor.fechaHoraLocal.slice(0, 10);
  }
}
