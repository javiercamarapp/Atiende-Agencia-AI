// L-22 -- calendario de dias inhabiles de licitaciones. Dominio puro (sin I/O): el almacenamiento
// de los dias que declara cada organizacion o cada convocatoria vive en
// `dias-inhabiles-repository.ts` (migracion 032) y las rutas en
// `apps/api/src/routes/verticals/licitaciones/diasInhabiles.ts`.
//
// POR QUE EXISTE: `business-days.ts` solo excluye sabados y domingos y ninguna ruta le pasaba
// feriados, asi que el plazo de pago (art. 73 LAASSP) y el de inconformidad (art. 95 LAASSP) se
// calculaban sin ningun dia inhabil. Este modulo arma el conjunto de fechas que TODAS las rutas y
// pantallas que calculan plazos pasan a `addBusinessDays`/`businessDaysBetween`.
//
// DE DONDE SALEN LOS DIAS (tres capas, de menos a mas especifica):
//   1. OFICIALES DE PLATAFORMA (codigo, abajo): los dias de descanso obligatorio que fija el
//      articulo 74 de la Ley Federal del Trabajo, verificables fecha por fecha, SOLO para 2026 y
//      2027. No se infieren otros anios: fuera de la cobertura el calendario lo dice (aviso), nunca
//      calla.
//   2. DE LA ORGANIZACION (tabla `licitaciones.dia_inhabil`, `tender_id` nulo): dias que la
//      organizacion declara para todas sus convocatorias (p. ej. un acuerdo publicado en el DOF).
//   3. DE LA CONVOCATORIA (misma tabla, `tender_id` informado): dias inhabiles que publica la
//      dependencia o entidad convocante para ESA contratacion.
//
// LO DUDOSO NO SE APLICA SOLO: Jueves y Viernes Santo son inhabiles segun lo que publique cada
// dependencia, no por la LFT. Se muestran como SUGERIDOS "validar con fiscalista/abogado" y solo
// cuentan en un plazo cuando la organizacion los declara (capa 2 o 3). Asi un plazo de
// inconformidad nunca se alarga por una fecha que nadie confirmo.
//
// Esto NO es asesoria legal: el calculo es una ayuda determinista y cada resultado lo recuerda.

/** Descarga de responsabilidad que viaja con cada plazo calculado y con la pantalla. */
export const DIAS_INHABILES_VALIDACION_NOTE =
  "Validar con fiscalista/abogado: los dias inhabiles oficiales cargados aqui cubren solo 2026-2027 (descanso obligatorio, art. 74 de la Ley Federal del Trabajo); los que publique cada dependencia o entidad los declara la organizacion.";

export type DiaInhabilAlcance = "oficial" | "organizacion" | "convocatoria";
export type DiaInhabilVerificacion = "verificada" | "por_validar";

export interface DiaInhabil {
  /** "YYYY-MM-DD". */
  readonly fecha: string;
  readonly nombre: string;
  readonly alcance: DiaInhabilAlcance;
  /** Solo alcance `convocatoria`. */
  readonly tenderId: string | null;
  /** Dependencia o entidad que lo publica (texto libre; no aplica a los oficiales de plataforma). */
  readonly publicadoPor: string | null;
  /** Referencia de la fuente (p. ej. "DOF 2026-01-15"). */
  readonly fuente: string | null;
  readonly verificacion: DiaInhabilVerificacion;
}

/** Cobertura del calendario oficial de plataforma. Cualquier otro anio se declara sin cobertura. */
export const DIAS_INHABILES_COBERTURA_OFICIAL: readonly number[] = [2026, 2027];

const LFT_74 = "Ley Federal del Trabajo, art. 74 (descanso obligatorio)";

function oficial(fecha: string, nombre: string): DiaInhabil {
  return { fecha, nombre, alcance: "oficial", tenderId: null, publicadoPor: null, fuente: LFT_74, verificacion: "verificada" };
}

/**
 * Dias de descanso obligatorio federal 2026-2027 (LFT art. 74): 1 de enero; primer lunes de febrero
 * (Constitucion); tercer lunes de marzo (Benito Juarez); 1 de mayo; 16 de septiembre; tercer lunes
 * de noviembre (Revolucion); 25 de diciembre. El 1 de diciembre de cada seis anos (cambio de
 * Poder Ejecutivo Federal) no cae en 2026 ni 2027 (el siguiente es 2030, fuera de cobertura).
 * Las fechas son literales y una prueba comprueba que cada una cae en el lunes que dice la ley.
 */
export const DIAS_INHABILES_OFICIALES: readonly DiaInhabil[] = [
  oficial("2026-01-01", "Año Nuevo"),
  oficial("2026-02-02", "Día de la Constitución (primer lunes de febrero)"),
  oficial("2026-03-16", "Natalicio de Benito Juárez (tercer lunes de marzo)"),
  oficial("2026-05-01", "Día del Trabajo"),
  oficial("2026-09-16", "Día de la Independencia"),
  oficial("2026-11-16", "Día de la Revolución (tercer lunes de noviembre)"),
  oficial("2026-12-25", "Navidad"),
  oficial("2027-01-01", "Año Nuevo"),
  oficial("2027-02-01", "Día de la Constitución (primer lunes de febrero)"),
  oficial("2027-03-15", "Natalicio de Benito Juárez (tercer lunes de marzo)"),
  oficial("2027-05-01", "Día del Trabajo"),
  oficial("2027-09-16", "Día de la Independencia"),
  oficial("2027-11-15", "Día de la Revolución (tercer lunes de noviembre)"),
  oficial("2027-12-25", "Navidad"),
];

export interface DiaInhabilSugerido {
  readonly fecha: string;
  readonly nombre: string;
  readonly motivo: string;
}

const MOTIVO_SANTO = "Validar con fiscalista/abogado: se considera inhabil segun el acuerdo que publique cada dependencia o entidad (no esta en el art. 74 de la LFT).";

/** Fechas reales de Jueves y Viernes Santo 2026-2027 (Pascua: 5-abr-2026 y 28-mar-2027). NO cuentan hasta que la organizacion las declare. */
export const DIAS_INHABILES_SUGERIDOS: readonly DiaInhabilSugerido[] = [
  { fecha: "2026-04-02", nombre: "Jueves Santo", motivo: MOTIVO_SANTO },
  { fecha: "2026-04-03", nombre: "Viernes Santo", motivo: MOTIVO_SANTO },
  { fecha: "2027-03-25", nombre: "Jueves Santo", motivo: MOTIVO_SANTO },
  { fecha: "2027-03-26", nombre: "Viernes Santo", motivo: MOTIVO_SANTO },
];

// ---------------------------------------------------------------------------
// Fechas (zona America/Mexico_City)
// ---------------------------------------------------------------------------

export const DIAS_INHABILES_TIME_ZONE = "America/Mexico_City";
export const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const MX_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: DIAS_INHABILES_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** Valida "YYYY-MM-DD" como fecha real de calendario (rechaza 2026-02-30). */
export function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_ONLY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Fecha CIVIL en America/Mexico_City de un instante. Un plazo que vence "2026-12-31T23:00-06:00" es
 * del 31 de diciembre en Mexico aunque en UTC ya sea 2027-01-01 (un inhabil): tomar los primeros 10
 * caracteres del ISO en UTC corre el plazo un dia y lo evalua contra el calendario equivocado.
 */
export function mexicoCityDateKey(instant: string | Date): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) throw new Error(`mexicoCityDateKey: instante invalido: "${String(instant)}".`);
  return MX_DATE_FORMAT.format(date);
}

function toUtcDate(dateOnly: string): Date {
  if (!isValidDateOnly(dateOnly)) throw new Error(`fecha invalida (se esperaba "YYYY-MM-DD"): "${dateOnly}".`);
  return new Date(`${dateOnly}T00:00:00Z`);
}

function key(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isBusinessDay(dateOnly: string, holidays: readonly string[] = []): boolean {
  const d = toUtcDate(dateOnly);
  const dow = d.getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.includes(dateOnly);
}

/** Primer dia habil en o despues de `dateOnly` (un plazo que cae en inhabil se recorre al siguiente dia habil). */
export function nextBusinessDayOnOrAfter(dateOnly: string, holidays: readonly string[] = []): string {
  const holidaySet = new Set(holidays);
  const cursor = toUtcDate(dateOnly);
  for (let i = 0; i < 400; i += 1) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidaySet.has(key(cursor))) return key(cursor);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  throw new Error("nextBusinessDayOnOrAfter: no se encontro un dia habil en 400 dias; calendario invalido.");
}

/**
 * Dias habiles que faltan de `fromDateOnly` (excluido) a `toDateOnly` (incluido). Negativo si `to`
 * es anterior a `from` (plazo vencido). El dia de `from` no cuenta: es el mismo criterio de
 * `addBusinessDays` (el primer dia habil contado es el siguiente al de partida).
 */
export function countBusinessDaysBetween(fromDateOnly: string, toDateOnly: string, holidays: readonly string[] = []): number {
  const from = toUtcDate(fromDateOnly);
  const to = toUtcDate(toDateOnly);
  if (from.getTime() === to.getTime()) return 0;
  const holidaySet = new Set(holidays);
  const forward = to.getTime() > from.getTime();
  const [start, end] = forward ? [from, to] : [to, from];
  const cursor = new Date(start.getTime());
  let count = 0;
  while (cursor.getTime() < end.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidaySet.has(key(cursor))) count += 1;
  }
  return forward ? count : -count;
}

// ---------------------------------------------------------------------------
// Calendario efectivo
// ---------------------------------------------------------------------------

export interface CalendarioPlazos {
  /** Fechas "YYYY-MM-DD" a excluir ademas de sabados y domingos, ordenadas y sin repetidos. */
  readonly holidays: readonly string[];
  readonly entries: readonly DiaInhabil[];
  /** Anios con calendario oficial de plataforma. */
  readonly coberturaOficial: readonly number[];
  /** Nota legal/de alcance que viaja con el plazo calculado. */
  readonly note: string;
}

export interface BuildCalendarioInput {
  /** Dias declarados (organizacion y/o convocatorias). Solo se aplican los de la organizacion y los de `tenderId`. */
  readonly declarados?: readonly DiaInhabil[];
  /** Convocatoria para la que se calcula: sus dias propios se suman a los de la organizacion. */
  readonly tenderId?: string | null;
  /** Solo oficiales de plataforma (sin base): ver `officialOnlyCalendar`. */
  readonly omitirOficiales?: boolean;
}

/** Une oficiales de plataforma + dias de la organizacion + dias de la convocatoria pedida. */
export function buildCalendarioPlazos(input: BuildCalendarioInput = {}): CalendarioPlazos {
  const entries: DiaInhabil[] = input.omitirOficiales ? [] : [...DIAS_INHABILES_OFICIALES];
  for (const d of input.declarados ?? []) {
    if (!isValidDateOnly(d.fecha)) continue;
    if (d.alcance === "oficial") continue;
    if (d.alcance === "convocatoria" && (!input.tenderId || d.tenderId !== input.tenderId)) continue;
    if (d.alcance === "organizacion" && d.tenderId !== null) continue;
    entries.push(d);
  }
  const holidays = [...new Set(entries.map((e) => e.fecha))].sort();
  const declarados = entries.filter((e) => e.alcance !== "oficial").length;
  const oficiales = entries.length - declarados;
  const note =
    declarados === 0
      ? `Se excluyen sábados, domingos y ${oficiales} días inhábiles oficiales de plataforma (2026-2027). ${DIAS_INHABILES_VALIDACION_NOTE}`
      : `Se excluyen sábados, domingos, ${oficiales} días inhábiles oficiales de plataforma y ${declarados} declarados por la organización o la convocatoria. ${DIAS_INHABILES_VALIDACION_NOTE}`;
  return { holidays, entries, coberturaOficial: DIAS_INHABILES_COBERTURA_OFICIAL, note };
}

/** Calendario de respaldo cuando no hay base (o falta la migracion 032): oficiales de plataforma. */
export function officialOnlyCalendar(): CalendarioPlazos {
  return buildCalendarioPlazos();
}

/**
 * Avisos honestos de un calculo entre `fromDateOnly` y `toDateOnly`: anios sin calendario oficial ni
 * dias declarados (el plazo solo excluyo fines de semana) y plazo que cae en un dia inhabil.
 */
export function calendarioAvisos(calendario: CalendarioPlazos, fromDateOnly: string, toDateOnly: string): string[] {
  const avisos: string[] = [];
  const y0 = Number(fromDateOnly.slice(0, 4));
  const y1 = Number(toDateOnly.slice(0, 4));
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 1) {
    const cubierto = calendario.coberturaOficial.includes(y) || calendario.holidays.some((h) => h.startsWith(`${y}-`));
    if (!cubierto) avisos.push(`No hay días inhábiles cargados para ${y}: el plazo solo excluyó sábados y domingos. Declare los días inhábiles de ese año o valide con fiscalista/abogado.`);
  }
  return avisos;
}

/** Valida y normaliza la entrada de un dia inhabil que declara la organizacion (fail-closed, mensajes en espanol). */
export class DiaInhabilValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiaInhabilValidationError";
  }
}

export class DiaInhabilNotAvailableError extends Error {
  constructor(message = "El calendario de días inhábiles por organización aún no está disponible en este ambiente (falta la migración 032 de licitaciones).") {
    super(message);
    this.name = "DiaInhabilNotAvailableError";
  }
}

export class DiaInhabilDuplicateError extends Error {
  constructor(message = "Ya hay un día inhábil vigente para esa fecha en ese alcance.") {
    super(message);
    this.name = "DiaInhabilDuplicateError";
  }
}

export interface DiaInhabilCreateInput {
  readonly fecha: string;
  readonly nombre: string;
  readonly tenderId: string | null;
  readonly publicadoPor: string | null;
  readonly fuente: string | null;
  readonly verificacion: DiaInhabilVerificacion;
}

function parseOptionalText(raw: unknown, field: string, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new DiaInhabilValidationError(`${field}: se esperaba texto.`);
  const v = raw.trim();
  if (v.length === 0) return null;
  if (v.length > max) throw new DiaInhabilValidationError(`${field}: máximo ${max} caracteres.`);
  return v;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function parseDiaInhabilCreate(raw: Record<string, unknown>): DiaInhabilCreateInput {
  if (!isValidDateOnly(raw.fecha)) throw new DiaInhabilValidationError('fecha: se esperaba una fecha real "YYYY-MM-DD".');
  const year = Number(raw.fecha.slice(0, 4));
  if (year < 2000 || year > 2100) throw new DiaInhabilValidationError("fecha: el año debe estar entre 2000 y 2100.");
  if (typeof raw.nombre !== "string") throw new DiaInhabilValidationError("nombre: se esperaba texto.");
  const nombre = raw.nombre.trim();
  if (nombre.length < 3 || nombre.length > 200) throw new DiaInhabilValidationError("nombre: entre 3 y 200 caracteres.");
  let tenderId: string | null = null;
  if (raw.tenderId !== undefined && raw.tenderId !== null) {
    if (typeof raw.tenderId !== "string" || !UUID_RE.test(raw.tenderId)) throw new DiaInhabilValidationError("tenderId: se esperaba un UUID.");
    tenderId = raw.tenderId;
  }
  let verificacion: DiaInhabilVerificacion = "por_validar";
  if (raw.verificacion !== undefined) {
    if (raw.verificacion !== "verificada" && raw.verificacion !== "por_validar") throw new DiaInhabilValidationError('verificacion: "verificada" o "por_validar".');
    verificacion = raw.verificacion;
  }
  return { fecha: raw.fecha, nombre, tenderId, publicadoPor: parseOptionalText(raw.publicadoPor, "publicadoPor", 200), fuente: parseOptionalText(raw.fuente, "fuente", 300), verificacion };
}

/** Un dia inhabil declarado tal como lo devuelve el repositorio (con id y sello de quien lo declaro). */
export interface DiaInhabilRecord extends DiaInhabil {
  readonly id: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Descripcion de un plazo fijo (fecha limite de presentacion, de preguntas de la junta, etc.)
// ---------------------------------------------------------------------------

export interface PlazoDescripcion {
  /** Fecha civil del plazo en America/Mexico_City ("YYYY-MM-DD"). */
  readonly fechaLimite: string;
  /** Hoy en America/Mexico_City ("YYYY-MM-DD"). */
  readonly hoy: string;
  /** Dias habiles que faltan (negativo = ya vencio; 0 = vence hoy). */
  readonly diasHabilesRestantes: number;
  /** El plazo cae en sabado, domingo o dia inhabil: conviene validarlo con la convocante. */
  readonly caeEnInhabil: boolean;
  readonly motivoInhabil: string | null;
  readonly siguienteDiaHabil: string | null;
  readonly avisos: readonly string[];
  readonly nota: string;
}

/**
 * Describe un plazo FIJO (un instante que fija la convocante) contra el calendario efectivo, siempre
 * en la fecha civil de America/Mexico_City. No mueve el plazo: solo avisa si cae en dia inhabil y
 * cuantos dias habiles faltan (la convocante manda; esto es una ayuda para no perder el plazo).
 */
export function describirPlazo(deadlineIso: string, nowIso: string, calendario: CalendarioPlazos): PlazoDescripcion {
  const fechaLimite = mexicoCityDateKey(deadlineIso);
  const hoy = mexicoCityDateKey(nowIso);
  const diaSemana = toUtcDate(fechaLimite).getUTCDay();
  const entrada = calendario.entries.find((e) => e.fecha === fechaLimite);
  const caeEnInhabil = diaSemana === 0 || diaSemana === 6 || calendario.holidays.includes(fechaLimite);
  const motivoInhabil = !caeEnInhabil ? null : entrada ? entrada.nombre : diaSemana === 0 ? "domingo" : "sábado";
  const avisos = calendarioAvisos(calendario, hoy < fechaLimite ? hoy : fechaLimite, hoy < fechaLimite ? fechaLimite : hoy);
  if (caeEnInhabil) avisos.push(`La fecha límite cae en un día inhábil (${motivoInhabil}): confirme con la convocante si el plazo se recorre.`);
  return {
    fechaLimite,
    hoy,
    diasHabilesRestantes: countBusinessDaysBetween(hoy, fechaLimite, calendario.holidays),
    caeEnInhabil,
    motivoInhabil,
    siguienteDiaHabil: caeEnInhabil ? nextBusinessDayOnOrAfter(fechaLimite, calendario.holidays) : null,
    avisos,
    nota: calendario.note,
  };
}

/**
 * Mensaje del recordatorio de plazo de presentacion: el texto de siempre + los DIAS HABILES que
 * quedan segun el calendario efectivo + el aviso si la fecha limite cae en dia inhabil. Si el
 * instante no se puede interpretar devuelve el texto base (el recordatorio nunca se pierde).
 */
export function mensajeRecordatorioPlazo(title: string, submissionDeadline: string, nowIso: string, calendario: CalendarioPlazos): string {
  const base = `La convocatoria "${title}" vence el ${submissionDeadline}.`;
  try {
    const p = describirPlazo(new Date(submissionDeadline).toISOString(), nowIso, calendario);
    // Con 0 habiles restantes solo es "hoy" si la fecha limite ES hoy; un plazo en inhabil futuro tiene 0 habiles y no vence hoy.
    const habiles = p.fechaLimite === p.hoy ? " Vence hoy." : p.diasHabilesRestantes > 0 ? ` Quedan ${p.diasHabilesRestantes} día(s) hábil(es).` : "";
    const inhabil = p.caeEnInhabil ? ` La fecha límite cae en un día inhábil (${p.motivoInhabil}): confirme con la convocante.` : "";
    return `${base}${habiles}${inhabil}`;
  } catch {
    return base;
  }
}
