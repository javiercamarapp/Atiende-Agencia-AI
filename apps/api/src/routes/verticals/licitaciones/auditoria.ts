// L-P3-17 -- puente de las rutas de licitaciones con la bitacora de escrituras (`licitaciones.audit_trail`, migracion 038).
//
// Cada escritura llama a `auditar(...)` en la MISMA transaccion (sesion `c.get("db")`): si la anotacion falla por algo distinto de "migracion
// pendiente" la escritura se revierte (nada queda sin rastro); con la 038 pendiente la escritura sigue como antes sin renglon (SAVEPOINT, nunca 25P02).
//
// `correlation_id`: nace en la ingesta automatica (uno por corrida) o en la peticion (header `X-Correlation-Id` SANEADO: largo 1..64 y [A-Za-z0-9._:-];
// cualquier otro valor se descarta y se genera uno), se hereda en la convocatoria y sus versiones (renglones `convocatoria.*`) y viaja hasta las
// aprobaciones y el manifiesto: una aprobacion sin header hereda la correlacion de origen de la convocatoria (`findTenderCorrelationId`).
// El actor SIEMPRE sale de la sesion (`c.get("userId")`), nunca del cuerpo.
import { newCorrelationId, pickAuditFields, sanitizeCorrelationId } from "@atiende/domain-licitaciones";
import type { AuditEntity, LicitacionesRepository } from "@atiende/domain-licitaciones";
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../../../deps.ts";

/** Lista CERRADA de campos que entran a antes/despues por entidad (nunca tokens ni secretos; nada que la entidad no guarde ya). */
const CAMPOS: Readonly<Record<AuditEntity, readonly string[]>> = {
  tarifa: ["concept", "unitPrice", "currency", "validFrom", "validUntil", "approvalStatus"],
  documento_empresa: ["type", "label", "expiresAt", "approvalStatus"],
  capacidad: ["name", "description", "evidenceDocId", "approvalStatus"],
  experiencia: ["description", "evidenceDocId", "approvalStatus"],
  firmante: ["name", "role", "authorized", "approvalStatus"],
  configuracion: ["timezone"],
  perfil_matching: ["keywords", "excludedKeywords", "classifierCodes", "entities", "states", "budgetMin", "budgetMax"],
  staff_invitacion: ["verticalRole", "platformRole", "status"],
  staff_miembro: ["verticalRole", "platformRole"],
  convocatoria: ["externalId", "source", "title", "contractingBody", "budgetAmount", "state", "submissionDeadline", "version"],
  expediente: ["stage", "mode", "inputsHash", "proposalId"],
  paquete: ["status", "proposalId", "inputsHash", "manifestHash"],
};

export function correlationDe(c: Context<CoreAuthHonoEnv>): string {
  const desdeHeader = sanitizeCorrelationId(c.req.header("x-correlation-id"));
  const id = desdeHeader ?? sanitizeCorrelationId(c.get("requestId") as string | undefined) ?? newCorrelationId();
  c.header("x-correlation-id", id);
  return id;
}

/** Header saneado si vino; si no, la correlacion de origen de la convocatoria (para heredarla); si no, la de la peticion. */
export async function correlationParaConvocatoria(c: Context<CoreAuthHonoEnv>, repo: LicitacionesRepository, tenderId: string): Promise<string> {
  const desdeHeader = sanitizeCorrelationId(c.req.header("x-correlation-id"));
  if (desdeHeader) {
    c.header("x-correlation-id", desdeHeader);
    return desdeHeader;
  }
  const origen = await repo.findTenderCorrelationId(c.get("organizationId"), tenderId);
  if (origen) {
    c.header("x-correlation-id", origen);
    return origen;
  }
  return correlationDe(c);
}

export interface AuditarInput {
  readonly entity: AuditEntity;
  readonly entityId: string | null;
  readonly action: string;
  readonly before?: object | null;
  readonly after?: object | null;
  /** Si ya se resolvio (herencia de la convocatoria). */
  readonly correlationId?: string;
  /** Rutas que resuelven la organizacion por slug (no por el token) la pasan explicita. */
  readonly organizationId?: string;
}

export async function auditar(deps: AppDeps, c: Context<CoreAuthHonoEnv>, input: AuditarInput): Promise<void> {
  const repo = deps.licitacionesRepo(c.get("db"));
  const campos = CAMPOS[input.entity];
  await repo.appendAuditoria(input.organizationId ?? c.get("organizationId"), {
    entity: input.entity,
    entityId: input.entityId,
    action: input.action,
    before: pickAuditFields(input.before, campos),
    after: pickAuditFields(input.after, campos),
    actorId: c.get("userId"),
    correlationId: input.correlationId ?? correlationDe(c),
  });
}
