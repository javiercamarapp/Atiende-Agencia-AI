// L-23 (REQ-050) -- regimen legal por fecha de CONVOCATORIA: LAASSP de 2000 (abrogada) vs LAASSP
// nueva (DOF 16-abr-2025, vigor 17-abr-2025). Dominio puro, sin I/O.
//
// POR QUE EXISTE: el motor de plazos aplicaba SIEMPRE el regimen vigente (17 dias habiles de pago,
// 6/10 de inconformidad), de modo que una convocatoria publicada antes del 17-abr-2025 recibia un
// vencimiento del regimen equivocado. Ahora el regimen se decide con la fecha de publicacion de la
// convocatoria que declara el usuario (la base no la guarda: no hay migracion en este cambio).
//
// REGLAS (todas ligadas a fichas de `normas.ts`):
//  - Fecha >= 2025-04-17: regimen nuevo (Art. 73 pago 17 dias habiles; Art. 95 inconformidad 6/10).
//  - Fecha <  2025-04-17: regimen abrogado. El pago se cuenta en 20 dias naturales; el plazo de
//    inconformidad NO se calcula (no hay fuente verificada): se devuelve "validar con abogado".
//  - Fecha no declarada: se aplica el regimen vigente (comportamiento previo) y el resultado lo
//    dice, en vez de fingir que la fecha se conocia.
// Todo plazo es una ayuda determinista; NO es asesoria legal.
import type { DiasInhabilesInput } from "./business-days.ts";
import { computePaymentDueDate } from "./contract-billing.ts";
import type { PaymentDeadlineResult } from "./contract-billing.ts";
import { isValidDateOnly } from "./dias-inhabiles.ts";
import { buildInconformidadContent, computeInconformidadDeadline } from "./inconformidad.ts";
import type { InconformidadContent, InconformidadContentInput, InconformidadDeadlineResult } from "./inconformidad.ts";

/** Primer dia en que rige la LAASSP nueva (DOF 16-abr-2025, vigor 17-abr-2025). */
export const LAASSP_2025_ENTRADA_EN_VIGOR = "2025-04-17";
/** Plazo de pago del regimen abrogado: 20 dias naturales (ficha laassp-2000-pago, sin verificar). */
export const LAASSP_2000_PLAZO_PAGO_DIAS_NATURALES = 20;

export type RegimenLegalId = "laassp_2025" | "laassp_2000_abrogada";
export type RegimenFuente = "fecha_convocatoria" | "no_declarada";

export interface RegimenLegalResolucion {
  readonly regimen: RegimenLegalId;
  readonly fuente: RegimenFuente;
  /** "YYYY-MM-DD" declarada, o `null` si no se declaro. */
  readonly convocatoriaPublicadaEn: string | null;
  /** Fichas de `normas.ts` en que se apoya la decision. */
  readonly fichas: readonly string[];
  /** Siempre `true`: el regimen se decidio con un criterio de producto, no con una verificacion juridica. */
  readonly validarConAbogado: true;
  readonly nota: string;
}

const NOTA_BASE = "Validar con abogado: el regimen se decide solo por la fecha de publicacion de la convocatoria; casos de transicion (bases modificadas, procedimientos reanudados) requieren criterio juridico.";

/** Decide el regimen legal a partir de la fecha de publicacion de la convocatoria. Lanza si la fecha declarada no es una fecha real. */
export function resolveRegimenLegal(convocatoriaPublicadaEn?: string | null): RegimenLegalResolucion {
  if (convocatoriaPublicadaEn === undefined || convocatoriaPublicadaEn === null) {
    return {
      regimen: "laassp_2025",
      fuente: "no_declarada",
      convocatoriaPublicadaEn: null,
      fichas: ["laassp-2025-regimen-transitorio"],
      validarConAbogado: true,
      nota: `No se declaro la fecha de publicacion de la convocatoria: se aplico el regimen vigente (LAASSP nueva). ${NOTA_BASE}`,
    };
  }
  if (!isValidDateOnly(convocatoriaPublicadaEn)) {
    throw new Error(`resolveRegimenLegal: fecha de convocatoria invalida (se esperaba "YYYY-MM-DD"): "${convocatoriaPublicadaEn}".`);
  }
  const nuevo = convocatoriaPublicadaEn >= LAASSP_2025_ENTRADA_EN_VIGOR;
  return {
    regimen: nuevo ? "laassp_2025" : "laassp_2000_abrogada",
    fuente: "fecha_convocatoria",
    convocatoriaPublicadaEn,
    fichas: ["laassp-2025-regimen-transitorio"],
    validarConAbogado: true,
    nota: nuevo
      ? `Convocatoria publicada el ${convocatoriaPublicadaEn} (desde el ${LAASSP_2025_ENTRADA_EN_VIGOR}): rige la LAASSP nueva. ${NOTA_BASE}`
      : `Convocatoria publicada el ${convocatoriaPublicadaEn} (antes del ${LAASSP_2025_ENTRADA_EN_VIGOR}): corresponde la LAASSP de 2000, abrogada. ${NOTA_BASE}`,
  };
}

function addCalendarDays(isoDate: string, days: number): string {
  if (!isValidDateOnly(isoDate)) throw new Error(`addCalendarDays: fecha invalida (se esperaba "YYYY-MM-DD"): "${isoDate}".`);
  const cursor = new Date(`${isoDate}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
}

export interface PaymentDeadlineByRegimeResult {
  readonly dueDate: string;
  /** Cantidad de dias que se contaron. */
  readonly days: number;
  readonly dayType: "habiles" | "naturales";
  readonly legalReference: string;
  readonly calendarNote: string;
  readonly regimen: RegimenLegalResolucion;
}

/** Fecha limite de pago segun el regimen de la convocatoria (Art. 73 LAASSP nueva: 17 dias habiles; regimen abrogado: 20 dias naturales, validar con abogado). */
export function computePaymentDueDateByRegime(invoiceVerifiedOnIsoDate: string, convocatoriaPublicadaEn: string | null | undefined, holidays: DiasInhabilesInput = []): PaymentDeadlineByRegimeResult {
  const regimen = resolveRegimenLegal(convocatoriaPublicadaEn);
  if (regimen.regimen === "laassp_2000_abrogada") {
    return {
      dueDate: addCalendarDays(invoiceVerifiedOnIsoDate, LAASSP_2000_PLAZO_PAGO_DIAS_NATURALES),
      days: LAASSP_2000_PLAZO_PAGO_DIAS_NATURALES,
      dayType: "naturales",
      legalReference: `LAASSP de 2000 (abrogada; convocatoria publicada el ${regimen.convocatoriaPublicadaEn}): pago dentro de ${LAASSP_2000_PLAZO_PAGO_DIAS_NATURALES} dias naturales siguientes a la verificacion de la factura. Articulo, plazo y transicion SIN VERIFICAR: validar con abogado.`,
      calendarNote: "Dias naturales: no se excluyeron sabados, domingos ni dias inhabiles. Validar con abogado.",
      regimen,
    };
  }
  const base: PaymentDeadlineResult = computePaymentDueDate(invoiceVerifiedOnIsoDate, holidays);
  return {
    dueDate: base.dueDate,
    days: base.businessDays,
    dayType: "habiles",
    legalReference: regimen.fuente === "no_declarada" ? `${base.legalReference} Fecha de convocatoria no declarada: se aplico el regimen vigente; validar con abogado.` : base.legalReference,
    calendarNote: base.calendarNote,
    regimen,
  };
}

export type InconformidadDeadlineByRegime =
  | { readonly status: "calculado"; readonly plazo: InconformidadDeadlineResult; readonly regimen: RegimenLegalResolucion }
  | { readonly status: "requiere_validacion_abogado"; readonly plazo: null; readonly regimen: RegimenLegalResolucion; readonly motivo: string };

/** Plazo de inconformidad segun el regimen. Para el regimen abrogado NO se calcula (no hay fuente verificada): devuelve `requiere_validacion_abogado`. */
export function computeInconformidadDeadlineByRegime(falloNotifiedOnIsoDate: string, underTradeAgreements: boolean, convocatoriaPublicadaEn: string | null | undefined, holidays: DiasInhabilesInput = []): InconformidadDeadlineByRegime {
  const regimen = resolveRegimenLegal(convocatoriaPublicadaEn);
  if (regimen.regimen === "laassp_2000_abrogada") {
    return {
      status: "requiere_validacion_abogado",
      plazo: null,
      regimen,
      motivo: `La convocatoria se publico el ${regimen.convocatoriaPublicadaEn}, antes de la LAASSP nueva: el plazo de inconformidad del regimen abrogado no esta verificado y no se calcula. Validar con abogado.`,
    };
  }
  const plazo = computeInconformidadDeadline(falloNotifiedOnIsoDate, underTradeAgreements, holidays);
  const sufijo = regimen.fuente === "no_declarada" ? " Fecha de convocatoria no declarada: se aplico el regimen vigente; validar con abogado." : "";
  return { status: "calculado", plazo: { ...plazo, legalReference: `${plazo.legalReference}${sufijo}` }, regimen };
}

/** Error de dominio: el regimen de la convocatoria no permite calcular el plazo de forma verificable. */
export class PlazoRegimenNoVerificableError extends Error {
  readonly regimen: RegimenLegalResolucion;
  constructor(motivo: string, regimen: RegimenLegalResolucion) {
    super(motivo);
    this.name = "PlazoRegimenNoVerificableError";
    this.regimen = regimen;
  }
}

/**
 * `buildInconformidadContent` con el regimen de la convocatoria: para el regimen abrogado lanza
 * `PlazoRegimenNoVerificableError` (el borrador NO se genera con un plazo no verificado); para el
 * vigente devuelve el contenido con la referencia legal que declara si la fecha no se informo.
 */
export function buildInconformidadContentByRegime(input: InconformidadContentInput & { readonly convocatoriaPublicadaEn?: string | null }): InconformidadContent {
  const plazo = computeInconformidadDeadlineByRegime(input.falloNotifiedOn, input.bajoTratados, input.convocatoriaPublicadaEn, input.holidays ?? []);
  if (plazo.status === "requiere_validacion_abogado") throw new PlazoRegimenNoVerificableError(plazo.motivo, plazo.regimen);
  const content = buildInconformidadContent(input);
  return { ...content, plazo: plazo.plazo };
}
