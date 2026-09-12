// Fase 6 pieza 1 (REQ-050/REQ-051) — licitacionesContractRoutes: máquina de
// estados del contrato post-adjudicación. `contracts` (una fila por
// convocatoria) + `contract_status_history` (append-only). El catálogo de
// transiciones válidas vive en
// `@atiende/domain-licitaciones::CONTRACT_TRANSITIONS`; una transición
// inválida responde 409 con el detalle de los estados permitidos, nunca
// aplica un cambio parcial.
//
// Transiciones sensibles (rescindir/penalizar/marcar en inconformidad/
// registrar una modificación, `CONTRACT_DECISION_TRANSITIONS`) exigen
// `DECISION_ROLES` (más estricto que `WRITE_ROLES`) -- ver el comentario de
// cabecera de `contract-lifecycle.ts` sobre por qué esto reemplaza al
// step-up/2FA del repo original (esta fase no tiene esa infraestructura).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { WRITE_ROLES, DECISION_ROLES, CONTRACT_DECISION_TRANSITIONS, ContractTransitionRejectedError, isContractStatus } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface ContractMetadataBody {
  readonly endDate?: unknown;
  readonly contractNumber?: unknown;
  readonly hasRenewalOption?: unknown;
  readonly renewalOptionNotes?: unknown;
}

interface ContractTransitionBody {
  readonly toStatus?: unknown;
  readonly reason?: unknown;
  readonly evidenceRef?: unknown;
}

function parseOptionalString(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim().length === 0) throw Errors.validation(`${field}: se esperaba una cadena no vacía o ausente.`);
  return raw;
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function licitacionesContractRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/tenders/:tenderId/contract";
  const historyBase = "/licitaciones/:propertyId/tenders/:tenderId/contract/history";
  const transitionBase = "/licitaciones/:propertyId/tenders/:tenderId/contract/transition";

  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(historyBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(transitionBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const tenderId = c.req.param("tenderId");

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");

    try {
      const contract = await repo.createContract(organizationId, tenderId, actorId);
      return c.json(contract, 201);
    } catch (err) {
      throw Errors.conflict(err instanceof Error ? err.message : "No se pudo registrar el contrato.");
    }
  });

  app.get(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const contract = await repo.findContractByTender(organizationId, tenderId);
    if (!contract) throw Errors.notFound("No existe contrato registrado para esta convocatoria todavía; regístrelo primero con POST .../contract.");
    return c.json(contract);
  });

  // REQ-055: metadatos administrativos (fecha de fin/número de contrato/
  // opción de renovación) -- NO es una transición de estado, no genera fila
  // de historial; es el insumo directo del radar de renovaciones.
  app.patch(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    const raw = await readJsonCapped<ContractMetadataBody>(c.req.raw, 8 * 1024);

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const contract = await repo.findContractByTender(organizationId, tenderId);
    if (!contract) throw Errors.notFound("No existe contrato registrado para esta convocatoria todavía; regístrelo primero con POST .../contract.");

    const input: { endDate?: string | null; contractNumber?: string | null; hasRenewalOption?: boolean; renewalOptionNotes?: string | null } = {};
    if ("endDate" in raw) {
      if (raw.endDate !== null && (typeof raw.endDate !== "string" || !DATE_ONLY_PATTERN.test(raw.endDate))) {
        throw Errors.validation('endDate: se esperaba "YYYY-MM-DD" o null.');
      }
      input.endDate = raw.endDate as string | null;
    }
    if ("contractNumber" in raw) input.contractNumber = parseOptionalString(raw.contractNumber, "contractNumber");
    if ("hasRenewalOption" in raw) {
      if (typeof raw.hasRenewalOption !== "boolean") throw Errors.validation("hasRenewalOption: se esperaba un booleano.");
      input.hasRenewalOption = raw.hasRenewalOption;
    }
    if ("renewalOptionNotes" in raw) input.renewalOptionNotes = parseOptionalString(raw.renewalOptionNotes, "renewalOptionNotes");

    const updated = await repo.updateContractMetadata(organizationId, tenderId, input);
    return c.json(updated);
  });

  app.get(historyBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const contract = await repo.findContractByTender(organizationId, tenderId);
    if (!contract) throw Errors.notFound("No existe contrato registrado para esta convocatoria todavía.");
    const history = await repo.listContractStatusHistory(organizationId, tenderId);
    return c.json({ history });
  });

  app.post(transitionBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    const raw = await readJsonCapped<ContractTransitionBody>(c.req.raw, 16 * 1024);

    if (typeof raw.toStatus !== "string" || !isContractStatus(raw.toStatus)) throw Errors.validation("toStatus: estado de contrato desconocido.");
    if (typeof raw.reason !== "string" || raw.reason.trim().length === 0) throw Errors.validation("reason requerido.");
    const evidenceRef = parseOptionalString(raw.evidenceRef, "evidenceRef");
    const toStatus = raw.toStatus;

    // Enforcement de aplicación, ADEMÁS de RLS: transiciones sensibles
    // exigen DECISION_ROLES, el resto solo WRITE_ROLES.
    assertVerticalRole(c, CONTRACT_DECISION_TRANSITIONS.includes(toStatus) ? DECISION_ROLES : WRITE_ROLES);

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const contract = await repo.findContractByTender(organizationId, tenderId);
    if (!contract) throw Errors.notFound("No existe contrato registrado para esta convocatoria todavía; regístrelo primero con POST .../contract.");

    try {
      const updated = await repo.transitionContract(organizationId, tenderId, { toStatus, reason: raw.reason, evidenceRef, actorId });
      return c.json(updated);
    } catch (err) {
      if (err instanceof ContractTransitionRejectedError) {
        throw Errors.conflict(err.message);
      }
      throw err;
    }
  });

  return app;
}
