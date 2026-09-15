// tender-resolution.ts — Fase 16 (post-adjudicación, pieza 0): máquina de
// validación PURA (sin IO) para resolver una convocatoria a un estado
// TERMINAL de negocio, "won" (ganada) o "lost" (perdida). Mismo espíritu que
// `contract-lifecycle.ts::checkTransition`: nunca lanza, el llamador decide
// el efecto (409 con `allowedFromStatuses`, ver
// `TenderResolutionRejectedError` en errors.ts).
//
// Hasta esta pieza, `licitaciones.tender.status` podía llegar a "won"/"lost"
// -- el enum (`TENDER_STATUSES`, types.ts) ya los declaraba desde Fase 3 --
// pero NINGÚN endpoint HTTP permitía escribir esa transición: todo el flujo
// de post-adjudicación construido en Fase 6/15 (contrato, cobranza,
// inconformidades) y el de autopsia del fallo (Fase 15/`falloAutopsy.ts`)
// dependen de `tender.status === "won"`/`"lost"` (ver
// `apps/web/.../ConvocatoriaDetalle.tsx`) y eran, en la práctica,
// inalcanzables.
//
// Regla dura (REQ post-adjudicación, ver diseño de esta ronda): nunca se
// puede saltar directo de "discovered"/"in_review" (todavía SIN una decisión
// go/no-go real) a "won"/"lost" -- eso sería declarar ganada una licitación
// en la que la organización ni siquiera decidió participar. Tampoco se
// resuelve desde "no_go" (ya se decidió activamente NO participar) ni desde
// "cancelled", "won" o "lost" (todos terminales). Solo se resuelve desde un
// estado que refleja participación real ya en curso: "go" (decidido
// participar), "in_progress" (expediente en preparación) o "submitted"
// (propuesta ya presentada) -- los tres estados intermedios que el dominio
// ya modela entre la decisión de ir y el resultado final.
import type { TenderStatus } from "./types.ts";

export const TENDER_RESOLUTIONS = ["won", "lost"] as const;
export type TenderResolution = (typeof TENDER_RESOLUTIONS)[number];

export function isTenderResolution(value: unknown): value is TenderResolution {
  return typeof value === "string" && (TENDER_RESOLUTIONS as readonly string[]).includes(value);
}

/**
 * Estados desde los que SÍ se puede resolver won/lost -- lista CERRADA en
 * código (mismo criterio que `CONTRACT_TRANSITIONS`: nunca una tabla
 * editable en runtime), para que ampliarla exija tocar este archivo (y su
 * prueba) antes de poder usarse.
 */
export const TENDER_RESOLVABLE_FROM_STATUSES: readonly TenderStatus[] = ["go", "in_progress", "submitted"];

export interface TenderResolutionCheckResult {
  readonly valid: boolean;
  readonly allowedFromStatuses: readonly TenderStatus[];
}

/** Nunca lanza -- mismo contrato que `contract-lifecycle.ts::checkTransition`. */
export function checkTenderResolution(fromStatus: TenderStatus): TenderResolutionCheckResult {
  return { valid: TENDER_RESOLVABLE_FROM_STATUSES.includes(fromStatus), allowedFromStatuses: TENDER_RESOLVABLE_FROM_STATUSES };
}
