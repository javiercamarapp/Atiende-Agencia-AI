// paridad3 (L-P3-05/06/07) -- productores de la campana (core.notification) de la boveda de bases, la matriz de requisitos y
// la revision del expediente. SIEMPRE en el punto de ESCRITURA (nunca en un GET), con clave de dedupe de ids (sin PII):
//
//   * licitaciones.revision.solicitada: al registrar la solicitud de revision (POST .../proposal/request-review).
//   * licitaciones.requisitos.conflicto_abierto: al extraer requisitos, cuando quedan conflictos abiertos (clave = convocatoria + huella de ids).
//   * licitaciones.documentos.sin_texto: al subir un documento cuyo texto no se pudo extraer (requires_ocr o failed).
//   * licitaciones.expediente.aprobacion_invalidada: al editar una seccion cuyo cambio invalido aprobaciones vigentes.
//
// Contrato: `emitirNotificacion` nunca lanza y corre en SAVEPOINT; un aviso fallido (o la base sin la campana) jamas cambia
// la respuesta ni la escritura de negocio.
import { createHash } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion } from "@atiende/db";

export async function avisarRevisionSolicitada(db: TenantDbSession, input: { organizationId: string; proposalId: string; requestId: string; tenderId: string }): Promise<void> {
  await emitirNotificacion(db, { evento: "licitaciones.revision.solicitada", organizationId: input.organizationId, clave: `${input.proposalId}:${input.requestId}`, entidadTipo: "expediente", entidadId: input.tenderId });
}

export async function avisarConflictosAbiertos(db: TenantDbSession, input: { organizationId: string; tenderId: string; openConflictIds: readonly string[] }): Promise<void> {
  if (input.openConflictIds.length === 0) return;
  const huella = createHash("sha256").update([...input.openConflictIds].sort().join(",")).digest("hex").slice(0, 16);
  await emitirNotificacion(db, {
    evento: "licitaciones.requisitos.conflicto_abierto",
    organizationId: input.organizationId,
    clave: `${input.tenderId}:${huella}`,
    entidadTipo: "convocatoria",
    entidadId: input.tenderId,
    parametros: { cantidad: input.openConflictIds.length },
  });
}

export async function avisarDocumentoSinTexto(db: TenantDbSession, input: { organizationId: string; tenderId: string; documentId: string }): Promise<void> {
  await emitirNotificacion(db, { evento: "licitaciones.documentos.sin_texto", organizationId: input.organizationId, clave: input.documentId, entidadTipo: "convocatoria", entidadId: input.tenderId });
}

export async function avisarAprobacionInvalidada(db: TenantDbSession, input: { organizationId: string; proposalId: string; tenderId: string; sectionKey: string; version: number }): Promise<void> {
  await emitirNotificacion(db, {
    evento: "licitaciones.expediente.aprobacion_invalidada",
    organizationId: input.organizationId,
    clave: `${input.proposalId}:${input.sectionKey}:v${input.version}`,
    entidadTipo: "expediente",
    entidadId: input.tenderId,
  });
}
