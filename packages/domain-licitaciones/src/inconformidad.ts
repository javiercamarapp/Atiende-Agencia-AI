// inconformidad.ts — Fase 6 pieza 3 (REQ-053): construcción del contenido
// estructurado de un BORRADOR de inconformidad (recurso administrativo
// contra el fallo). Port ~literal del repo original
// (`licitaciones/apps/api/src/lib/expediente/inconformidad.ts`), que es
// PURAMENTE basado en plantillas/reglas -- confirmado leyendo el código
// real del origen: no hay ningún cliente HTTP saliente ni ninguna llamada a
// LLM en todo ese módulo, así que se porta COMPLETO (no aplica el criterio
// de "fail-closed estilo LlmRequirementExtractor" para esta pieza -- eso
// solo aplicaría si el redactor dependiera de un LLM, y no depende).
//
// Este módulo JAMÁS presenta nada ante ninguna autoridad: no hay ningún
// cliente HTTP saliente en todo este archivo. El plazo se calcula con el
// motor determinista de `business-days.ts` (Art. 95 LAASSP, 6/10 días
// hábiles), nunca con un LLM ni a mano por el usuario.
//
// Fundamentos legales citados (jurisdicción + fecha DOF), verificados
// puntualmente en el repo original (`docs/legal/verificacion-legal.md`):
//  - Art. 49 LAASSP nueva (REQ-103): el fallo es el acto típicamente
//    impugnado; frac. I exige listar razones de desechamiento.
//  - Art. 95 LAASSP nueva (REQ-104): plazo de 6/10 días hábiles.
// Ambos artículos son de la misma reforma (DOF 16-abr-2025).
import { addBusinessDays, CALENDAR_LIMITATION_NOTE } from "./business-days.ts";
import { sha256Hex } from "./types.ts";

export interface InconformidadFundamento {
  readonly articulo: string;
  readonly ley: string;
  readonly jurisdiccion: string;
  readonly fechaDof: string | null;
  readonly texto: string;
}

export type InconformidadViability = "alta" | "media" | "baja";

export const INCONFORMIDAD_DISCLAIMER =
  "BORRADOR — requiere revisión de abogado. Este documento es un insumo generado automáticamente a partir de datos capturados por el usuario; NO se presenta ante ninguna autoridad por este sistema, NO constituye asesoría legal, y NO debe presentarse sin que un abogado lo revise y, en su caso, lo corrija.";

export const LAASSP_ART_95_INCONFORMIDAD_BUSINESS_DAYS = 6;
export const LAASSP_ART_95_INCONFORMIDAD_TRATADOS_BUSINESS_DAYS = 10;
export const LAASSP_ART_95_LEGAL_REFERENCE =
  "LAASSP nueva, Art. 95 (DOF 16-abr-2025, vigor 17-abr-2025): la inconformidad debe presentarse dentro de los 6 días hábiles siguientes a la notificación del acto impugnado (10 días hábiles tratándose de licitaciones públicas internacionales bajo la cobertura de tratados).";

export interface InconformidadDeadlineResult {
  readonly dueDate: string;
  readonly businessDays: number;
  readonly legalReference: string;
  readonly calendarNote: string;
}

/** Calcula la fecha límite para presentar una inconformidad, contada en días hábiles desde la fecha de NOTIFICACIÓN del fallo (nunca desde "hoy"). `underTradeAgreements` decide 6 vs. 10 días hábiles (Art. 95). */
export function computeInconformidadDeadline(falloNotifiedOnIsoDate: string, underTradeAgreements: boolean, holidays: readonly string[] = []): InconformidadDeadlineResult {
  const businessDays = underTradeAgreements ? LAASSP_ART_95_INCONFORMIDAD_TRATADOS_BUSINESS_DAYS : LAASSP_ART_95_INCONFORMIDAD_BUSINESS_DAYS;
  const dueDate = addBusinessDays(falloNotifiedOnIsoDate, businessDays, holidays);
  return { dueDate, businessDays, legalReference: LAASSP_ART_95_LEGAL_REFERENCE, calendarNote: CALENDAR_LIMITATION_NOTE };
}

function buildFundamentos(deadline: InconformidadDeadlineResult, bajoTratados: boolean): InconformidadFundamento[] {
  return [
    {
      articulo: "Art. 49",
      ley: "LAASSP nueva",
      jurisdiccion: "Federal",
      fechaDof: "2025-04-16",
      texto:
        'Fracción I exige que el fallo liste a los proveedores desechados "expresando todas las razones legales, técnicas o económicas" que sustentan la determinación; "Contra el fallo no procederá recurso alguno; sin embargo, procederá la inconformidad que se interpondrá...".',
    },
    {
      articulo: "Art. 95",
      ley: "LAASSP nueva",
      jurisdiccion: "Federal",
      fechaDof: "2025-04-16",
      texto: `Plazo para presentar la inconformidad: ${deadline.businessDays} días hábiles siguientes a la notificación del acto impugnado${
        bajoTratados
          ? " (licitación pública internacional bajo cobertura de tratados: 10 días hábiles, en vez del plazo general de 6)"
          : " (plazo general de 6 días hábiles; 10 días hábiles tratándose de licitaciones públicas internacionales bajo cobertura de tratados)"
      }.`,
    },
  ];
}

/**
 * Guardrail anti-frivolidad DETERMINISTA (REQ-053): compara el número de
 * agravios contra el número de elementos de prueba registrados. NUNCA
 * bloquea la generación del borrador -- solo advierte, y la clasificación
 * es una heurística de forma (cantidad de evidencia declarada), no una
 * opinión legal sobre el fondo del caso.
 */
function assessViability(agravios: readonly string[], pruebas: readonly string[]): { viability: InconformidadViability; recommendation: string } {
  if (pruebas.length === 0) {
    return {
      viability: "baja",
      recommendation:
        "No se registró ninguna prueba que sustente los agravios planteados. Recomendación (heurística determinista, NO opinión legal): reunir evidencia documental concreta antes de presentar; presentar sin pruebas suele debilitar la inconformidad.",
    };
  }
  if (pruebas.length < agravios.length) {
    return {
      viability: "media",
      recommendation: `Se registraron ${pruebas.length} prueba(s) para ${agravios.length} agravio(s): no todos los agravios tienen soporte documental explícito. Revise que cada agravio cuente con al menos una prueba antes de presentar.`,
    };
  }
  return {
    viability: "alta",
    recommendation:
      "Se registró al menos una prueba por cada agravio planteado. Esta clasificación es una heurística determinista sobre la cantidad de evidencia declarada, NO una opinión legal sobre el fondo del caso -- requiere de cualquier forma revisión de un abogado antes de presentar.",
  };
}

export interface InconformidadContentInput {
  readonly falloNotifiedOn: string;
  readonly bajoTratados: boolean;
  readonly hechos: readonly string[];
  readonly agravios: readonly string[];
  readonly pruebas: readonly string[];
  /** Días inhábiles oficiales adicionales a sábado/domingo, si el llamador los declara explícitamente (ver `business-days.ts`). */
  readonly holidays?: readonly string[];
}

export interface InconformidadContent {
  readonly fundamentos: readonly InconformidadFundamento[];
  readonly plazo: InconformidadDeadlineResult;
  readonly viability: InconformidadViability;
  readonly viabilityRecommendation: string;
  readonly contentHash: string;
}

export function buildInconformidadContent(input: InconformidadContentInput): InconformidadContent {
  const deadline = computeInconformidadDeadline(input.falloNotifiedOn, input.bajoTratados, input.holidays ?? []);
  const fundamentos = buildFundamentos(deadline, input.bajoTratados);
  const { viability, recommendation } = assessViability(input.agravios, input.pruebas);

  // Hash determinista del contenido (REQ-053 "versionado con hash") --
  // mismo orden de claves siempre, para que el hash sea reproducible
  // (`sha256Hex` ya ordena claves de forma estable, ver types.ts).
  const contentHash = sha256Hex({
    hechos: input.hechos,
    agravios: input.agravios,
    pruebas: input.pruebas,
    fundamentos,
    falloNotifiedOn: input.falloNotifiedOn,
    bajoTratados: input.bajoTratados,
    dueDate: deadline.dueDate,
  });

  return { fundamentos, plazo: deadline, viability, viabilityRecommendation: recommendation, contentHash };
}
