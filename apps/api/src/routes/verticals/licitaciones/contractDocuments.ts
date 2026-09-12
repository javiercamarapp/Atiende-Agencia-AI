// Fase 6 pieza 2 (REQ-052) — licitacionesContractDocumentsRoutes: subida +
// extracción determinista del contrato firmado.
//
// LÍMITE DOCUMENTADO (ver `@atiende/domain-licitaciones::extractContractFields`
// y el README de este vertical): este monorepo NO tiene, en ningún vertical,
// un pipeline de texto-desde-PDF/OCR -- exactamente el mismo contrato de
// entrada que `POST .../requirements/extract` (technicalProposal.ts): el
// cuerpo del request trae el texto YA EXTRAÍDO por página
// (`{documentLabel, pages:[{page,text}]}`), nunca los bytes de un PDF. Subir
// un PDF real (nativo o escaneado) y obtener ese texto sigue siendo trabajo
// pendiente genuino, fuera de esta fase.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { WRITE_ROLES } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface ContractDocumentUploadBody {
  readonly documentLabel?: unknown;
  readonly pages?: unknown;
}

interface ContractFieldConfirmBody {
  readonly action?: unknown;
  readonly correctedValue?: unknown;
}

function parsePages(raw: unknown): { page: number; text: string }[] {
  if (!Array.isArray(raw) || raw.length === 0) throw Errors.validation("pages: se esperaba un arreglo no vacío de {page, text}.");
  return raw.map((p, i) => {
    if (typeof p !== "object" || p === null) throw Errors.validation(`pages[${i}]: se esperaba un objeto {page, text}.`);
    const o = p as Record<string, unknown>;
    if (typeof o.page !== "number" || !Number.isInteger(o.page) || o.page < 1) throw Errors.validation(`pages[${i}].page: se esperaba un entero >= 1.`);
    if (typeof o.text !== "string") throw Errors.validation(`pages[${i}].text: se esperaba una cadena.`);
    return { page: o.page, text: o.text };
  });
}

export function licitacionesContractDocumentsRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const documentsBase = "/licitaciones/:propertyId/tenders/:tenderId/contract/documents";
  const fieldsBase = "/licitaciones/:propertyId/tenders/:tenderId/contract/documents/:documentId/fields";
  const confirmBase = "/licitaciones/:propertyId/tenders/:tenderId/contract/fields/:fieldId/confirm";

  app.use(documentsBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(fieldsBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(confirmBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  async function requireContract(repo: ReturnType<AppDeps["licitacionesRepo"]>, organizationId: string, tenderId: string) {
    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const contract = await repo.findContractByTender(organizationId, tenderId);
    if (!contract) throw Errors.notFound("No existe contrato registrado para esta convocatoria todavía; regístrelo primero con POST .../contract.");
    return contract;
  }

  app.post(documentsBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    const raw = await readJsonCapped<ContractDocumentUploadBody>(c.req.raw, 2 * 1024 * 1024);

    if (typeof raw.documentLabel !== "string" || raw.documentLabel.trim().length === 0) throw Errors.validation("documentLabel requerido.");
    const pages = parsePages(raw.pages);

    await requireContract(repo, organizationId, tenderId);
    const result = await repo.addContractDocument(organizationId, tenderId, { documentLabel: raw.documentLabel, pages, actorId });
    return c.json(result, 201);
  });

  app.get(documentsBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    await requireContract(repo, organizationId, tenderId);
    const documents = await repo.listContractDocuments(organizationId, tenderId);
    return c.json({ documents });
  });

  app.get(fieldsBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    const documentId = c.req.param("documentId");
    await requireContract(repo, organizationId, tenderId);
    try {
      const fields = await repo.listContractExtractedFields(organizationId, tenderId, documentId);
      return c.json({ fields });
    } catch {
      throw Errors.notFound("Documento de contrato no encontrado.");
    }
  });

  app.post(confirmBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    const fieldId = c.req.param("fieldId");
    const raw = await readJsonCapped<ContractFieldConfirmBody>(c.req.raw, 8 * 1024);

    if (raw.action !== "confirm" && raw.action !== "correct") throw Errors.validation('action: se esperaba "confirm" | "correct".');
    if (raw.action === "correct" && (typeof raw.correctedValue !== "string" || raw.correctedValue.trim().length === 0)) {
      throw Errors.validation('correctedValue: obligatorio y no vacío cuando action="correct".');
    }
    const correctedValue = typeof raw.correctedValue === "string" ? raw.correctedValue : null;

    await requireContract(repo, organizationId, tenderId);
    try {
      const field = await repo.confirmContractExtractedField(organizationId, tenderId, fieldId, { action: raw.action, correctedValue, actorId });
      return c.json(field);
    } catch (err) {
      throw Errors.notFound(err instanceof Error ? err.message : "Campo extraído no encontrado.");
    }
  });

  return app;
}
