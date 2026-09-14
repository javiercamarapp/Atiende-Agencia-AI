// contract-lifecycle.ts — Fase 6 pieza 1 (REQ-050/REQ-051): máquina de
// estados del contrato adjudicado. Port ~literal del catálogo de
// transiciones real implementado en el repo original
// (`licitaciones/apps/api/src/lib/expediente/contract-lifecycle.ts`) —
// NÓTESE que ese archivo documenta explícitamente que sus estados difieren
// del texto crudo de REQ-051 en `docs/REQUISITOS.md` ("adjudicado→firmado→
// garantía→entrega→aceptado→factura→pagado→liberado"): la tarea que
// despachó esa ronda especificó en su lugar "adjudicado →
// contrato_firmado_declarado → en_ejecución → entregado → facturado →
// pagado → cerrado, con ramas: modificado, penalizado, rescindido,
// en_inconformidad", y ese es el catálogo REALMENTE implementado y probado
// en el origen — se porta ESE (el código real), no la frase de una línea de
// REQUISITOS.md, siguiendo la instrucción de esta fase de "usar los del
// original, no inventar nombres".
//
// Igual precedente que el resto de máquinas de estado de este monorepo
// (p. ej. `licitaciones.tender.status`/REQ-042 de hoteles): el catálogo de
// transiciones válidas vive como una lista CERRADA en código — nunca en una
// tabla editable en runtime — para que una transición nueva exija tocar
// este archivo (y su prueba exhaustiva) antes de poder usarse.
//
// "contrato_firmado_declarado" (no "contrato_firmado"): ni este módulo ni
// ningún otro de este monorepo verifica una firma electrónica real — el
// nombre del estado deja explícito que es una DECLARACIÓN del usuario de
// que el contrato ya fue firmado fuera de este sistema (ver
// `contract-extraction.ts`: el texto del PDF firmado se sube ya extraído,
// nunca se valida criptográficamente ninguna firma).
export const CONTRACT_STATES = [
  "adjudicado",
  "contrato_firmado_declarado",
  "en_ejecucion",
  "entregado",
  "facturado",
  "pagado",
  "cerrado",
  "modificado",
  "penalizado",
  "rescindido",
  "en_inconformidad",
] as const;

export type ContractStatus = (typeof CONTRACT_STATES)[number];

export const CONTRACT_INITIAL_STATUS: ContractStatus = "adjudicado";

/** Estados terminales: ninguna transición sale de ellos. */
export const CONTRACT_TERMINAL_STATES: readonly ContractStatus[] = ["cerrado"];

/**
 * Tabla de transiciones válidas (estado actual -> conjunto de estados
 * siguientes permitidos). Las ramas ("modificado", "penalizado",
 * "rescindido", "en_inconformidad") pueden alcanzarse desde varios puntos
 * del flujo principal y, salvo "rescindido"/"en_inconformidad" resuelto,
 * regresan al flujo principal desde el mismo punto donde se registraron
 * (nunca saltan estados intermedios).
 */
export const CONTRACT_TRANSITIONS: Readonly<Record<ContractStatus, readonly ContractStatus[]>> = {
  adjudicado: ["contrato_firmado_declarado", "en_inconformidad", "rescindido"],
  contrato_firmado_declarado: ["en_ejecucion", "modificado", "rescindido", "en_inconformidad"],
  en_ejecucion: ["entregado", "modificado", "penalizado", "rescindido"],
  entregado: ["facturado", "modificado", "penalizado"],
  facturado: ["pagado", "penalizado"],
  pagado: ["cerrado"],
  modificado: ["en_ejecucion", "entregado", "facturado", "pagado", "penalizado", "rescindido"],
  penalizado: ["en_ejecucion", "entregado", "facturado", "pagado", "rescindido"],
  rescindido: ["cerrado"],
  en_inconformidad: ["adjudicado", "contrato_firmado_declarado", "cerrado"],
  cerrado: [],
};

/**
 * Subconjunto de estados que, al alcanzarse, ameritan atención humana
 * inmediata (rama excepcional o cierre) — expuesto en la respuesta HTTP de
 * la transición (`alert: true`) para que un cliente de negocio (portal/
 * dashboard) lo resalte, sin necesidad de una cola de trabajos real (este
 * monorepo, a diferencia del origen, no tiene un sistema `jobs` genérico —
 * ver README del vertical).
 */
export const CONTRACT_ALERT_STATES: readonly ContractStatus[] = ["penalizado", "rescindido", "en_inconformidad", "cerrado"];

/**
 * Transiciones que representan una decisión económica/legal sensible
 * (rescindir, penalizar, marcar en inconformidad, o registrar una
 * modificación): el origen las protegía con verificación en dos pasos
 * (step-up/2FA, `lib/step-up.ts`); este monorepo fusionado todavía no tiene
 * esa infraestructura para ningún vertical (ver
 * `apps/api/src/routes/verticals/licitaciones/README.md`) — el equivalente
 * de esta fase es exigir `DECISION_ROLES` (más estricto que `WRITE_ROLES`,
 * excluye "writer"/"reviewer") en vez de solo `WRITE_ROLES` para estas
 * transiciones puntuales (ver `contracts.ts`), documentado honestamente como
 * un control más débil que 2FA real hasta que exista step-up en este repo.
 */
export const CONTRACT_DECISION_TRANSITIONS: readonly ContractStatus[] = ["rescindido", "penalizado", "en_inconformidad", "modificado"];

export function isContractStatus(value: unknown): value is ContractStatus {
  return typeof value === "string" && (CONTRACT_STATES as readonly string[]).includes(value);
}

export interface TransitionCheckResult {
  readonly valid: boolean;
  readonly allowedNextStates: readonly ContractStatus[];
}

/** Nunca lanza — el llamador decide el efecto (409 con el detalle de `allowedNextStates`, ver `ContractTransitionRejectedError`). */
export function checkTransition(fromStatus: ContractStatus, toStatus: ContractStatus): TransitionCheckResult {
  const allowed = CONTRACT_TRANSITIONS[fromStatus] ?? [];
  return { valid: allowed.includes(toStatus), allowedNextStates: allowed };
}
