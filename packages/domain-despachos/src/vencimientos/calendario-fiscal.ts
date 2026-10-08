// ═══════════════════════════════════════════════════════════════════════════
// CALENDARIO FISCAL DE DESPACHOS (D-26) — día hábil real y plazos por obligación y régimen.
// Puro y determinista: sin base de datos, sin red, sin LLM, sin `Date.now()`.
//
// Qué corrige respecto del motor anterior (`engine.ts`, port literal del origen): las 4 obligaciones vencían
// el día 17 sin importar fin de semana ni feriado, y faltaban DIOT al último día del mes siguiente, la
// contabilidad electrónica (balanza) y la declaración anual.
//
// FUNDAMENTO (cada fila lleva el suyo en `PLAZOS`; las dudosas llevan `porValidar: true`):
// - Día hábil: art. 12 CFF. Si el último día del plazo es inhábil, se prorroga al siguiente hábil. Son inhábiles
//   sábado y domingo, y los días que listan la LFT art. 74 y la resolución anual del SAT.
// - Feriados: SOLO los que se calculan por regla de la LFT art. 74 (1-ene, primer lunes de feb, tercer lunes de
//   mar, 1-may, 16-sep, tercer lunes de nov, 25-dic; 1-dic cada 6 años: 2024, 2030). La resolución del SAT puede
//   declarar inhábiles otros días (periodos vacacionales); NO se inventan fechas: cuando una fecha límite cae en
//   Semana Santa o en un periodo vacacional habitual del SAT el resultado trae `validarConFiscalista: true`.
// - ISR/IVA/retenciones mensuales: día 17 del mes siguiente (LISR 14 y 106, LIVA 5-D).
// - DIOT: último día del mes siguiente (RMF 4.5.1) — POR VALIDAR con fiscalista.
// - Balanza de comprobación: día 3 del segundo mes siguiente (PM) o día 5 (PF) — RMF 2.8.1.6, POR VALIDAR.
// - Declaración anual: 31 de marzo PM (LISR 76) y 30 de abril PF (LISR 150).
// - D-P3-33 (migración 024): retenciones de ISR/IVA (honorarios y arrendamiento) día 17 (LISR 106, 116 y 126; LIVA 1-A y 5-D);
//   cuotas obrero-patronales del IMSS mensuales día 17 del mes siguiente y RCV/Infonavit bimestrales día 17 del mes siguiente al
//   bimestre (LSS art. 39 C); impuesto sobre nómina estatal (varía por entidad: se asume día 17, POR VALIDAR); informativa anual de
//   retenciones el 15 de febrero (LISR art. 76 fracc. X y 99 fracc. VII, POR VALIDAR). El sistema NO sabe si el cliente tiene
//   trabajadores, paga honorarios o arrienda: la ficha de cartera no captura "obligaciones" (hueco declarado), así que estas filas
//   se generan con una nota "aplica si ..." igual que la de Nómina, y el contador marca como completada o ignora la que no aplique.
// Ningún plazo se desplaza por el sexto dígito del RFC: no se modela (riesgo declarado, ver PR).
// ═══════════════════════════════════════════════════════════════════════════

export type TipoVencimientoFiscal = "ISR" | "IVA" | "DIOT" | "Nómina" | "Balanza" | "Anual" | "Retenciones" | "IMSS" | "IMSS-bimestral" | "ISN" | "Informativa";

/** Cobertura verificada de la tabla de feriados (ver `feriadosDelAnio`). Fuera de estos años la regla de la LFT
 * se sigue aplicando pero el resultado se marca por validar. */
export const ANIOS_CALENDARIO_VERIFICADOS: readonly number[] = [2026, 2027];

export type TipoPersona = "moral" | "fisica";

export interface FeriadoFiscal {
  readonly fecha: string; // YYYY-MM-DD
  readonly nombre: string;
  readonly fundamento: string;
  /** true = día inhábil que depende de la resolución del SAT, no de la LFT: validar con fiscalista. */
  readonly porValidar: boolean;
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseIso(fecha: string): { y: number; m: number; d: number } {
  const [y, m, d] = fecha.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

/** Suma `dias` (puede ser negativo) a una fecha YYYY-MM-DD sin tocar zonas horarias. */
export function sumarDias(fecha: string, dias: number): string {
  const { y, m, d } = parseIso(fecha);
  const t = new Date(Date.UTC(y, m - 1, d + dias));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** 0 = domingo ... 6 = sábado. */
export function diaDeLaSemana(fecha: string): number {
  const { y, m, d } = parseIso(fecha);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function enesimoDiaDeSemana(y: number, m: number, diaSemana: number, n: number): string {
  const primero = diaDeLaSemana(iso(y, m, 1));
  const delta = (diaSemana - primero + 7) % 7;
  return iso(y, m, 1 + delta + (n - 1) * 7);
}

/** Domingo de Pascua (algoritmo anónimo gregoriano / Meeus-Jones-Butcher). */
function domingoDePascua(y: number): string {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, mes, dia);
}

/** Días inhábiles no sabatinos/dominicales de un año. Orden ascendente. */
export function feriadosDelAnio(y: number): readonly FeriadoFiscal[] {
  const lft = "LFT art. 74";
  const lista: FeriadoFiscal[] = [
    { fecha: iso(y, 1, 1), nombre: "Año Nuevo", fundamento: lft, porValidar: false },
    { fecha: enesimoDiaDeSemana(y, 2, 1, 1), nombre: "Día de la Constitución (primer lunes de febrero)", fundamento: lft, porValidar: false },
    { fecha: enesimoDiaDeSemana(y, 3, 1, 3), nombre: "Natalicio de Benito Juárez (tercer lunes de marzo)", fundamento: lft, porValidar: false },
    { fecha: iso(y, 5, 1), nombre: "Día del Trabajo", fundamento: lft, porValidar: false },
    { fecha: iso(y, 9, 16), nombre: "Independencia de México", fundamento: lft, porValidar: false },
    { fecha: enesimoDiaDeSemana(y, 11, 1, 3), nombre: "Revolución Mexicana (tercer lunes de noviembre)", fundamento: lft, porValidar: false },
    { fecha: iso(y, 12, 25), nombre: "Navidad", fundamento: lft, porValidar: false },
  ];
  if ((y - 2024) % 6 === 0) {
    lista.push({ fecha: iso(y, 12, 1), nombre: "Transmisión del Poder Ejecutivo Federal", fundamento: lft, porValidar: false });
  }
  const pascua = domingoDePascua(y);
  lista.push(
    { fecha: sumarDias(pascua, -3), nombre: "Jueves Santo", fundamento: "Resolución del SAT de días inhábiles (validar con fiscalista)", porValidar: true },
    { fecha: sumarDias(pascua, -2), nombre: "Viernes Santo", fundamento: "Resolución del SAT de días inhábiles (validar con fiscalista)", porValidar: true },
  );
  return lista.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

export interface InfoDiaInhabil {
  readonly inhabil: boolean;
  readonly motivo: string | null;
  readonly porValidar: boolean;
}

export function infoDiaInhabil(fecha: string): InfoDiaInhabil {
  const dia = diaDeLaSemana(fecha);
  if (dia === 0 || dia === 6) return { inhabil: true, motivo: dia === 0 ? "domingo" : "sábado", porValidar: false };
  const feriado = feriadosDelAnio(parseIso(fecha).y).find((f) => f.fecha === fecha);
  if (feriado) return { inhabil: true, motivo: feriado.nombre, porValidar: feriado.porValidar };
  return { inhabil: false, motivo: null, porValidar: false };
}

/** Días HÁBILES entre `hoy` y `fechaLimite` (ambas YYYY-MM-DD): cuenta los días hábiles posteriores a `hoy` hasta la fecha límite
 * inclusive (art. 12 CFF). 0 = vence hoy; -1 = ya venció. Usa el mismo calendario fiscal que las fechas límite (feriados por regla de la
 * LFT y Jueves/Viernes Santo por validar), de modo que "faltan 3 días hábiles" coincide con lo que ve el contador en el calendario. */
export function diasHabilesHasta(hoy: string, fechaLimite: string): number {
  if (fechaLimite < hoy) return -1;
  let n = 0;
  let d = hoy;
  // Tope defensivo (fechas límite absurdamente lejanas): 5 años.
  for (let i = 0; i < 1830 && d < fechaLimite; i += 1) {
    d = sumarDias(d, 1);
    if (!infoDiaInhabil(d).inhabil) n += 1;
  }
  return n;
}

/** Periodos en los que el SAT suele declarar días inhábiles por vacaciones (segunda quincena de julio y de
 * diciembre). No son inhábiles aquí: solo disparan la advertencia "validar con fiscalista". */
function enVentanaVacacionalSat(fecha: string): boolean {
  const { m, d } = parseIso(fecha);
  return (m === 7 && d >= 16) || (m === 12 && d >= 15);
}

export interface FechaLimiteHabil {
  /** Fecha límite ya ajustada a día hábil. */
  readonly fecha: string;
  /** Fecha del plazo antes del ajuste del art. 12 CFF. */
  readonly fechaNominal: string;
  readonly ajustada: boolean;
  /** true si el ajuste dependió de un día inhábil por validar, o la fecha cae en una ventana vacacional del SAT
   * o fuera de los años verificados. */
  readonly validarConFiscalista: boolean;
}

/** Art. 12 CFF: si `fechaNominal` es inhábil, se corre al siguiente día hábil. */
export function siguienteDiaHabil(fechaNominal: string): FechaLimiteHabil {
  let fecha = fechaNominal;
  let porValidar = false;
  let guardia = 0;
  for (;;) {
    const info = infoDiaInhabil(fecha);
    if (!info.inhabil) break;
    if (info.porValidar) porValidar = true;
    fecha = sumarDias(fecha, 1);
    if (++guardia > 20) throw new Error(`siguienteDiaHabil: no se halló día hábil a partir de ${fechaNominal}.`);
  }
  const anio = parseIso(fecha).y;
  const fueraDeCobertura = !ANIOS_CALENDARIO_VERIFICADOS.includes(anio);
  return {
    fecha,
    fechaNominal,
    ajustada: fecha !== fechaNominal,
    validarConFiscalista: porValidar || enVentanaVacacionalSat(fecha) || fueraDeCobertura,
  };
}

export function ultimoDiaDelMes(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function mesMasN(year: number, month: number, n: number): { y: number; m: number } {
  const idx = year * 12 + (month - 1) + n;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

// ---------------------------------------------------------------------------------------------------------------
// Regímenes (catálogo c_RegimenFiscal del SAT, CFDI 4.0) y qué obligaciones modela cada uno.
// ---------------------------------------------------------------------------------------------------------------

const REGIMENES_PERSONA_MORAL = new Set(["601", "603", "620", "622", "623", "624"]);
// Persona física CON obligaciones periódicas modeladas (pagos provisionales ISR e IVA).
const REGIMENES_PF_CON_PROVISIONALES = new Set(["606", "612", "621", "625", "626"]);
// Persona física cuya obligación modelada es solo la declaración anual.
const REGIMENES_PF_SOLO_ANUAL = new Set(["605", "607", "608", "611", "614", "615"]);
// Sin obligaciones periódicas de este calendario.
const REGIMENES_SIN_OBLIGACIONES = new Set(["616", "610"]);

export function tipoPersonaDeRegimen(regimen: string): TipoPersona | null {
  if (REGIMENES_PERSONA_MORAL.has(regimen)) return "moral";
  if (REGIMENES_PF_CON_PROVISIONALES.has(regimen) || REGIMENES_PF_SOLO_ANUAL.has(regimen)) return "fisica";
  return null;
}

export function regimenSoportado(regimen: string): boolean {
  return tipoPersonaDeRegimen(regimen) !== null || REGIMENES_SIN_OBLIGACIONES.has(regimen);
}

export interface ObligacionFiscalPeriodo {
  readonly tipo: TipoVencimientoFiscal;
  /** Periodo en formato YYYY-MM (mes de la obligación; en `Anual`, el cierre del ejercicio: YYYY-12). */
  readonly periodo: string;
  readonly fechaNominal: string;
  readonly fechaLimite: string;
  readonly ajustadaPorDiaInhabil: boolean;
  readonly descripcion: string;
  readonly fundamento: string;
  /** El plazo o el día hábil dependen de una fuente que debe confirmar un fiscalista. */
  readonly validarConFiscalista: boolean;
  /** Nota opcional (p. ej. condición de aplicación). */
  readonly nota: string | null;
}

export interface OpcionesCalendarioFiscal {
  readonly regimenFiscal: string;
}

function armar(
  tipo: TipoVencimientoFiscal,
  periodo: string,
  nominal: string,
  descripcion: string,
  fundamento: string,
  plazoPorValidar: boolean,
  nota: string | null = null,
): ObligacionFiscalPeriodo {
  const h = siguienteDiaHabil(nominal);
  return {
    tipo,
    periodo,
    fechaNominal: nominal,
    fechaLimite: h.fecha,
    ajustadaPorDiaInhabil: h.ajustada,
    descripcion,
    fundamento,
    validarConFiscalista: plazoPorValidar || h.validarConFiscalista,
    nota,
  };
}

/** Obligaciones cuyo periodo es (year, month), con fecha límite en día hábil. `month` es 1-12.
 * Lanza si el régimen no está soportado: nunca se adivina un calendario. */
export function calcularCalendarioFiscal(year: number, month: number, opciones: OpcionesCalendarioFiscal): readonly ObligacionFiscalPeriodo[] {
  const { regimenFiscal } = opciones;
  if (!regimenSoportado(regimenFiscal)) throw new RegimenNoSoportadoError(regimenFiscal);
  const persona = tipoPersonaDeRegimen(regimenFiscal);
  const mm = String(month).padStart(2, "0");
  const periodo = `${year}-${mm}`;
  const siguiente = mesMasN(year, month, 1);
  const segundo = mesMasN(year, month, 2);
  const out: ObligacionFiscalPeriodo[] = [];

  const mensuales = persona === "moral" || REGIMENES_PF_CON_PROVISIONALES.has(regimenFiscal);
  if (mensuales) {
    const d17 = iso(siguiente.y, siguiente.m, 17);
    // 603 (personas morales con fines no lucrativos) no hace pagos provisionales de ISR: ver nota en el PR.
    if (regimenFiscal !== "603") {
      out.push(armar("ISR", periodo, d17, `Pago provisional mensual de ISR - ${mm}/${year}`, "LISR art. 14 (PM) / art. 106 (PF); art. 12 CFF", false));
    }
    out.push(armar("IVA", periodo, d17, `Declaración mensual de IVA - ${mm}/${year}`, "LIVA art. 5-D; art. 12 CFF", false));
    out.push(
      armar(
        "DIOT",
        periodo,
        iso(siguiente.y, siguiente.m, ultimoDiaDelMes(siguiente.y, siguiente.m)),
        `DIOT mensual - ${mm}/${year}`,
        "RMF regla 4.5.1 (último día del mes siguiente); art. 12 CFF",
        true,
      ),
    );
    out.push(armar("Nómina", periodo, d17, `Retenciones de ISR de nómina y asimilados - ${mm}/${year}`, "LISR art. 96 y 106; art. 12 CFF", false, "Aplica si el contribuyente tiene trabajadores o paga asimilados."));
  }

  if (mensuales) {
    const d17 = iso(siguiente.y, siguiente.m, 17);
    out.push(
      armar("Retenciones", periodo, d17, `Retenciones de ISR/IVA por honorarios y arrendamiento - ${mm}/${year}`, "LISR art. 106, 116 y 126; LIVA art. 1-A y 5-D; art. 12 CFF", false, "Aplica si el contribuyente pagó honorarios o arrendamiento a personas físicas o recibió servicios sujetos a retención de IVA."),
    );
    out.push(armar("IMSS", periodo, d17, `Cuotas obrero-patronales del IMSS - ${mm}/${year}`, "LSS art. 39 C (a más tardar el día 17 del mes siguiente); art. 12 CFF", false, "Aplica si el contribuyente tiene trabajadores registrados en el IMSS."));
    if (month % 2 === 0) {
      out.push(
        armar(
          "IMSS-bimestral",
          periodo,
          d17,
          `Cuotas bimestrales del IMSS (RCV) y aportaciones Infonavit - bimestre que cierra en ${mm}/${year}`,
          "LSS art. 39 C y LINFONAVIT art. 29 (día 17 del mes siguiente al bimestre); art. 12 CFF",
          false,
          "Aplica si el contribuyente tiene trabajadores registrados en el IMSS.",
        ),
      );
    }
    out.push(
      armar(
        "ISN",
        periodo,
        d17,
        `Impuesto sobre nómina estatal - ${mm}/${year}`,
        "Ley de Hacienda de la entidad federativa (varía por estado); art. 12 CFF",
        true,
        "El plazo y la tasa dependen de la entidad federativa del contribuyente; el sistema asume el día 17 del mes siguiente: valida con el fiscalista. Aplica si paga nómina.",
      ),
    );
  }

  const llevaBalanza = persona === "moral" && regimenFiscal !== "603" ? true : regimenFiscal === "612";
  if (llevaBalanza) {
    const dia = persona === "moral" ? 3 : 5;
    out.push(
      armar(
        "Balanza",
        periodo,
        iso(segundo.y, segundo.m, dia),
        `Balanza de comprobación (contabilidad electrónica) - ${mm}/${year}`,
        `RMF regla 2.8.1.6 (día ${dia} del segundo mes siguiente); art. 12 CFF`,
        true,
        persona === "fisica" ? "Aplica a persona física solo si sus ingresos del ejercicio anterior fueron de 4 millones de pesos o más: validar." : null,
      ),
    );
  }

  // La informativa anual de retenciones se genera con el periodo de diciembre (cierre del ejercicio) y vence el 15 de febrero.
  if (month === 12 && mensuales) {
    out.push(
      armar(
        "Informativa",
        periodo,
        iso(year + 1, 2, 15),
        `Declaración informativa anual de retenciones - ejercicio ${year}`,
        "LISR art. 76 fracción X y art. 99 fracción VII (15 de febrero); art. 12 CFF",
        true,
        "Aplica si el contribuyente pagó sueldos, honorarios o arrendamiento con retención durante el ejercicio: valida el plazo con el fiscalista.",
      ),
    );
  }

  // La anual se genera con el periodo de diciembre (cierre del ejercicio).
  if (month === 12 && persona !== null && !REGIMENES_SIN_OBLIGACIONES.has(regimenFiscal)) {
    if (persona === "moral") {
      out.push(armar("Anual", periodo, iso(year + 1, 3, 31), `Declaración anual de ISR (persona moral) - ejercicio ${year}`, "LISR art. 76 fracción IX; art. 12 CFF", false));
    } else {
      out.push(armar("Anual", periodo, iso(year + 1, 4, 30), `Declaración anual de ISR (persona física) - ejercicio ${year}`, "LISR art. 150; art. 12 CFF", false));
    }
  }
  return out;
}

const FUNDAMENTO_POR_TIPO: Record<TipoVencimientoFiscal, string> = {
  ISR: "LISR art. 14 (PM) / art. 106 (PF); art. 12 CFF",
  IVA: "LIVA art. 5-D; art. 12 CFF",
  DIOT: "RMF regla 4.5.1 (último día del mes siguiente); art. 12 CFF",
  Nómina: "LISR art. 96 y 106; art. 12 CFF",
  Balanza: "RMF regla 2.8.1.6 (día 3 PM / día 5 PF del segundo mes siguiente); art. 12 CFF",
  Anual: "LISR art. 76 fracción IX (PM, 31 de marzo) / art. 150 (PF, 30 de abril); art. 12 CFF",
  Retenciones: "LISR art. 106, 116 y 126; LIVA art. 1-A y 5-D; art. 12 CFF",
  IMSS: "LSS art. 39 C (a más tardar el día 17 del mes siguiente); art. 12 CFF",
  "IMSS-bimestral": "LSS art. 39 C y LINFONAVIT art. 29 (día 17 del mes siguiente al bimestre); art. 12 CFF",
  ISN: "Ley de Hacienda de la entidad federativa (varía por estado); art. 12 CFF",
  Informativa: "LISR art. 76 fracción X y art. 99 fracción VII (15 de febrero); art. 12 CFF",
};

/** Tipos cuyo plazo (o su existencia) depende de una fuente que un fiscalista debe confirmar, sin importar la fecha. */
const TIPOS_POR_VALIDAR: ReadonlySet<TipoVencimientoFiscal> = new Set<TipoVencimientoFiscal>(["DIOT", "Balanza", "ISN", "Informativa"]);

/** Fundamento y bandera de validación de un vencimiento YA persistido, derivados solo de su tipo y fecha límite
 * (la tabla no guarda el régimen). `validarConFiscalista` es true para DIOT, balanza, ISN e informativa (plazo por validar), para
 * fechas en ventana vacacional del SAT y para años fuera de la cobertura verificada. */
export function metadatosVencimiento(tipo: TipoVencimientoFiscal, fechaLimite: string): { readonly fundamento: string; readonly validarConFiscalista: boolean } {
  const anio = parseIso(fechaLimite).y;
  return {
    fundamento: FUNDAMENTO_POR_TIPO[tipo],
    validarConFiscalista: TIPOS_POR_VALIDAR.has(tipo) || enVentanaVacacionalSat(fechaLimite) || !ANIOS_CALENDARIO_VERIFICADOS.includes(anio),
  };
}

export class RegimenNoSoportadoError extends Error {
  constructor(readonly regimen: string) {
    super(`Régimen fiscal '${regimen}' sin calendario modelado (catálogo c_RegimenFiscal): confirma el régimen del contribuyente.`);
  }
}
