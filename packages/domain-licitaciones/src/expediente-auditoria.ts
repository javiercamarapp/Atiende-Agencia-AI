// Auditor determinista del expediente (paridad3 L-P3-11): estado del checklist de integridad por propuesta.
// Funcion PURA que clasifica los resultados persistidos del checklist; el auditor (API) decide cuando correrla y a quien avisar.
// Nada se aprueba solo: avisar que el expediente quedo "sin bloqueos" NO aprueba nada (REQ-044/046).
import type { ComplianceItemRecord } from "./types.ts";

export type ExpedienteAuditoriaEstado = "con_bloqueos" | "sin_bloqueos";

/** Ultimo estado auditado de una propuesta (`licitaciones.expediente_auditoria`, migracion 039). */
export interface ExpedienteAuditoriaRecord {
  readonly proposalId: string;
  readonly estado: ExpedienteAuditoriaEstado;
  readonly bloqueos: number;
  readonly inputsHash: string;
  readonly revisadoEn: string;
}

export interface ExpedienteAuditoriaEstadoCalculado {
  readonly estado: ExpedienteAuditoriaEstado;
  /** Dimensiones en rojo; 1 si el checklist NUNCA se corrio (un checklist ausente nunca es "verde"). */
  readonly bloqueos: number;
}

/**
 * Un expediente esta "sin bloqueos" cuando el checklist se corrio al menos una vez y ninguna dimension esta en rojo. Una
 * dimension en ambar es una advertencia, no un bloqueo (misma regla que `overallStatusOf` del cierre: solo el rojo bloquea).
 */
export function clasificarExpediente(items: readonly Pick<ComplianceItemRecord, "result">[]): ExpedienteAuditoriaEstadoCalculado {
  if (items.length === 0) return { estado: "con_bloqueos", bloqueos: 1 };
  const rojos = items.filter((i) => i.result === "rojo").length;
  return rojos > 0 ? { estado: "con_bloqueos", bloqueos: rojos } : { estado: "sin_bloqueos", bloqueos: 0 };
}

export type ExpedienteTransicion = "listo_para_aprobar" | "sin_cambio";

/** `previo` nulo = nunca auditado: se trata como "con bloqueos" (un expediente sin checklist no esta listo). */
export function transicionDeExpediente(previo: ExpedienteAuditoriaEstado | null, actual: ExpedienteAuditoriaEstado): ExpedienteTransicion {
  return (previo ?? "con_bloqueos") === "con_bloqueos" && actual === "sin_bloqueos" ? "listo_para_aprobar" : "sin_cambio";
}
