// Fase 10 hoteles (motor de recomendaciones de tarifa, v1) — calendario de
// festivos federales de México + temporadas de alta demanda turística, para
// alimentar la SEÑAL DE EVENTO del motor de tarifas (ver rateRecommendationEngine.ts).
//
// Dos fuentes, ambas EN CÓDIGO (nunca una tabla que alguien tenga que resembrar cada
// año, y nunca un scrape de ningún sitio de terceros):
//
//   1. Festivos oficiales federales (LFT art. 74): 6 fechas fijas + 3 "N-ésimo
//      lunes de un mes" (dependen del día de la semana del 1º del mes, se
//      recalculan cada año) + 1 fecha que solo aplica en años de "transmisión del
//      Poder Ejecutivo Federal" (cada 6 años).
//   2. Temporadas turísticas de alta demanda conocidas, de fecha movible
//      CALCULABLE — nunca hardcodeada para un año fijo que se pudra el año que
//      viene:
//        - Semana Santa/Pascua: ancla en el Domingo de Pascua, calculado con el
//          algoritmo anónimo gregoriano (Meeus/Jones/Butcher) — NO se hardcodea
//          ningún año.
//        - Día de Muertos (1-2 nov): fecha fija, no movible, se incluye aquí por
//          ser temporada turística (no festivo oficial LFT).
//        - Temporada decembrina: rango fijo (mediados de dic - Día de Reyes).
//        - Puente vacacional de verano: rango aproximado — ver limitación
//          documentada en `SUMMER_BREAK_APPROXIMATION` abajo, esta es la ÚNICA
//          temporada de este módulo que NO tiene una fecha exacta computable sin
//          un feed externo (el calendario escolar SEP varía año con año en +/- unos
//          días y no publica una regla algorítmica pública) — se usa un rango
//          conservador documentado, nunca se inventa precisión que no existe.
//
// Todo esto es dominio puro, determinista, sin persistencia ni I/O — mismo
// principio que `priceRecommendationExplainer.ts`/`revenueEngineGate.ts`: nunca un
// LLM, nunca un feed externo para lo que SÍ es calculable con una fórmula fija.

export type FederalHolidayKind =
  | "fija"
  | "n_esimo_lunes"
  | "transmision_poder_ejecutivo";

export interface FederalHoliday {
  /** Fecha ISO "YYYY-MM-DD". */
  readonly fecha: string;
  readonly nombre: string;
  readonly kind: FederalHolidayKind;
}

export type TemporadaAltaTipo =
  | "semana_santa_pascua"
  | "dia_de_muertos"
  | "temporada_decembrina"
  | "puente_verano";

export interface TemporadaAlta {
  readonly tipo: TemporadaAltaTipo;
  readonly nombre: string;
  /** Fechas ISO "YYYY-MM-DD", inclusive en ambos extremos. */
  readonly inicio: string;
  readonly fin: string;
  /** false únicamente para `puente_verano` — ver comentario de cabecera del
   *  módulo: es la única temporada de este archivo sin una fórmula exacta,
   *  se usa un rango aproximado documentado. Cualquier consumidor de esta señal
   *  debe poder distinguir "calculado con certeza" de "aproximado" antes de usarlo
   *  para justificar un cambio de tarifa fuerte. */
  readonly fechasExactas: boolean;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function toISO(year: number, month1to12: number, day: number): string {
  return `${year}-${pad2(month1to12)}-${pad2(day)}`;
}

/**
 * Domingo de Pascua (calendario gregoriano) para `year`, algoritmo anónimo
 * gregoriano (Meeus/Jones/Butcher) — el mismo que usan las efemérides
 * astronómicas/eclesiásticas estándar, válido para cualquier año del calendario
 * gregoriano (no solo un rango arbitrario "conocido"). Devuelve {month, day} en
 * 1-12/1-31.
 */
export function computeEasterSunday(year: number): { readonly month: number; readonly day: number } {
  if (!Number.isInteger(year)) {
    throw new Error(`anio_invalido: se esperaba un entero, recibido ${year}`);
  }
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = marzo, 4 = abril
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** N-ésima ocurrencia (1-indexed) de `targetWeekday` (0=domingo..6=sábado) en el
 *  mes `month1to12` de `year`. Lanza si ese mes no tiene una N-ésima ocurrencia
 *  (nunca pasa para N<=4 en un mes real, pero se valida por honestidad en vez de
 *  devolver una fecha del mes siguiente silenciosamente). */
export function nthWeekdayOfMonth(year: number, month1to12: number, targetWeekday: number, n: number): number {
  const firstOfMonth = new Date(Date.UTC(year, month1to12 - 1, 1));
  const firstWeekday = firstOfMonth.getUTCDay();
  const offset = (targetWeekday - firstWeekday + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  const daysInMonth = new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
  if (day > daysInMonth) {
    throw new Error(`ocurrencia_invalida: el mes ${month1to12}/${year} no tiene una ${n}ª ocurrencia del día de la semana ${targetWeekday}`);
  }
  return day;
}

const LUNES = 1;

/** Años en los que el 1 de diciembre es "transmisión del Poder Ejecutivo Federal"
 *  (LFT art. 74, fracción VII) — cada 6 años, ancla en 2024 (año de transmisión
 *  real más reciente conocido al escribir este módulo). Nunca se hardcodea la
 *  lista de años: se deriva de `year % 6 === ANCHOR_YEAR % 6`, así que sigue siendo
 *  correcto para cualquier año futuro sin tocar este archivo. */
const TRANSMISION_ANCHOR_YEAR = 2024;

export function isTransmisionPoderEjecutivoYear(year: number): boolean {
  return ((year - TRANSMISION_ANCHOR_YEAR) % 6 + 6) % 6 === 0;
}

/**
 * Festivos oficiales federales de México (LFT art. 74) para `year`, en orden
 * cronológico. No incluye festivos NO oficiales a nivel federal (ej. días
 * conmemorativos sin descanso obligatorio) — ese no es el alcance de esta fase.
 */
export function getFederalHolidays(year: number): readonly FederalHoliday[] {
  const easter = computeEasterSunday(year); // usado solo para getTemporadaAltaRanges, no para festivos LFT.
  void easter;

  const holidays: FederalHoliday[] = [
    { fecha: toISO(year, 1, 1), nombre: "Año Nuevo", kind: "fija" },
    {
      fecha: toISO(year, 2, nthWeekdayOfMonth(year, 2, LUNES, 1)),
      nombre: "Día de la Constitución (primer lunes de febrero, conmemora el 5 de febrero)",
      kind: "n_esimo_lunes",
    },
    {
      fecha: toISO(year, 3, nthWeekdayOfMonth(year, 3, LUNES, 3)),
      nombre: "Natalicio de Benito Juárez (tercer lunes de marzo, conmemora el 21 de marzo)",
      kind: "n_esimo_lunes",
    },
    { fecha: toISO(year, 5, 1), nombre: "Día del Trabajo", kind: "fija" },
    { fecha: toISO(year, 9, 16), nombre: "Día de la Independencia", kind: "fija" },
    {
      fecha: toISO(year, 11, nthWeekdayOfMonth(year, 11, LUNES, 3)),
      nombre: "Aniversario de la Revolución Mexicana (tercer lunes de noviembre, conmemora el 20 de noviembre)",
      kind: "n_esimo_lunes",
    },
    { fecha: toISO(year, 12, 25), nombre: "Navidad", kind: "fija" },
  ];

  if (isTransmisionPoderEjecutivoYear(year)) {
    holidays.push({ fecha: toISO(year, 12, 1), nombre: "Transmisión del Poder Ejecutivo Federal", kind: "transmision_poder_ejecutivo" });
  }

  return holidays.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
}

function addDaysISO(year: number, month1to12: number, day: number, deltaDays: number): string {
  const d = new Date(Date.UTC(year, month1to12 - 1, day + deltaDays));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Ver comentario de cabecera del módulo: única temporada sin fórmula exacta. */
export const SUMMER_BREAK_APPROXIMATION_NOTE =
  "Aproximación conservadora (1 jul - 15 ago) -- el calendario escolar SEP real varía unos días año con año y no publica una regla algorítmica pública; no se scrapea ningún sitio para esto (fuera de alcance de este v1, ver knownGaps).";

/**
 * Temporadas de alta demanda turística conocidas para `year`. `fechasExactas` en
 * cada elemento indica si el rango es una fórmula exacta (Semana Santa/Pascua, Día
 * de Muertos, decembrina) o una aproximación documentada (verano).
 */
export function getTemporadaAltaRanges(year: number): readonly TemporadaAlta[] {
  const easter = computeEasterSunday(year);
  // Semana Santa = domingo de Ramos (7 días antes de Pascua) a sábado de Gloria;
  // "temporada Semana Santa/Pascua" turística real se extiende además la semana
  // SIGUIENTE a Pascua ("semana de Pascua") -- mismo criterio que usan las cadenas
  // hoteleras mexicanas para el bloque completo de alta ocupación de primavera.
  const domingoRamosISO = addDaysISO(year, easter.month, easter.day, -7);
  const easterISO = toISO(year, easter.month, easter.day);
  const finSemanaPascuaISO = addDaysISO(year, easter.month, easter.day, 7);

  const ranges: TemporadaAlta[] = [
    {
      tipo: "semana_santa_pascua",
      nombre: "Semana Santa y Pascua",
      inicio: domingoRamosISO,
      fin: finSemanaPascuaISO,
      fechasExactas: true,
    },
    {
      tipo: "puente_verano",
      nombre: `Puente vacacional de verano (${SUMMER_BREAK_APPROXIMATION_NOTE})`,
      inicio: toISO(year, 7, 1),
      fin: toISO(year, 8, 15),
      fechasExactas: false,
    },
    {
      tipo: "dia_de_muertos",
      nombre: "Día de Muertos",
      inicio: toISO(year, 11, 1),
      fin: toISO(year, 11, 2),
      fechasExactas: true,
    },
    {
      tipo: "temporada_decembrina",
      nombre: "Temporada decembrina (vacaciones de invierno)",
      inicio: toISO(year, 12, 15),
      fin: toISO(year + 1, 1, 6),
      fechasExactas: true,
    },
    // El "easterISO" ya cae dentro de [domingoRamosISO, finSemanaPascuaISO]; se deja
    // fuera de la lista como elemento aparte a propósito (evitar un rango duplicado).
  ];
  return ranges.filter((t) => (t.tipo === "semana_santa_pascua" ? easterISO >= t.inicio && easterISO <= t.fin : true));
}

export interface DemandaFechaEvaluation {
  readonly esAltaDemanda: boolean;
  /** Nombres de festivo/temporada que cubren `fecha` (puede haber más de uno, ej.
   *  un festivo federal que cae dentro de una temporada turística). Vacío si
   *  `esAltaDemanda` es false. */
  readonly eventos: readonly string[];
  /** true si TODOS los eventos que cubren la fecha tienen fecha exacta calculada
   *  (ver `TemporadaAlta.fechasExactas`) -- false si alguno es aproximado
   *  (puente_verano) o si no hay ningún evento. Permite que el motor de tarifas dé
   *  menos peso a una señal basada en una aproximación. */
  readonly fechasExactas: boolean;
}

function parseISODate(fecha: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!m) throw new Error(`fecha_invalida: se esperaba formato YYYY-MM-DD, recibido "${fecha}"`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/**
 * Evalúa si `fecha` (ISO "YYYY-MM-DD") cae en un festivo federal o en una
 * temporada de alta demanda turística conocida — combina ambas fuentes
 * (`getFederalHolidays` + `getTemporadaAltaRanges`) del año correspondiente (y,
 * cerca de fin/inicio de año, también del año adyacente, para no perder la cola de
 * la temporada decembrina que cruza el 1º de enero).
 */
export function evaluateDemandaFecha(fecha: string): DemandaFechaEvaluation {
  const { year } = parseISODate(fecha);
  const eventos: string[] = [];
  let fechasExactas = true;

  for (const y of [year - 1, year, year + 1]) {
    for (const h of getFederalHolidays(y)) {
      if (h.fecha === fecha) eventos.push(h.nombre);
    }
    for (const t of getTemporadaAltaRanges(y)) {
      if (fecha >= t.inicio && fecha <= t.fin) {
        eventos.push(t.nombre);
        if (!t.fechasExactas) fechasExactas = false;
      }
    }
  }

  return { esAltaDemanda: eventos.length > 0, eventos: [...new Set(eventos)], fechasExactas: eventos.length === 0 ? true : fechasExactas };
}
