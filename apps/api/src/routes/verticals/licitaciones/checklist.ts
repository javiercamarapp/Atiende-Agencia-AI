// L1 · Flujo 1 — licitacionesChecklistRoutes: `IntegrityChecklist` real
// persistida en `licitaciones.compliance_item`. Port ~directo de
// licitaciones/apps/api/src/modules/expediente/checklist.routes.ts (ver
// diseño Fase 1 licitaciones §4.1). El guardia anti-manipulación de fecha
// (AE-01/REQ-LIC-001) vive en `resolveExpedienteAsOfIso` — el body de
// POST .../checklist/run NUNCA acepta un campo `asOfIso`, y si lo manda se
// ignora por completo (ni siquiera se lee del body).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { IdempotencyConflictError, IntegrityChecklist, resolveExpedienteAsOfIso, SubmissionDeadlineUnknownError, WRITE_ROLES } from "@atiende/domain-licitaciones";
import type { ChecklistItemResult, EconomicProposalResult, FileArtifact, FormatLimitsConfig, SignatureRequirement } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface ChecklistRunBody {
  readonly files?: unknown;
  readonly formatLimits?: unknown;
  readonly requiredSignatures?: unknown;
  readonly presentAnnexRefs?: unknown;
  // Deliberadamente NO se declara `asOfIso` aquí: aunque el cliente lo mande,
  // este tipo no lo expone y el código de abajo nunca lo lee del body crudo.
}

function parseFiles(raw: unknown): FileArtifact[] {
  if (!Array.isArray(raw)) throw Errors.validation("files: se esperaba un arreglo.");
  return raw.map((f, i) => {
    if (typeof f !== "object" || f === null) throw Errors.validation(`files[${i}]: se esperaba un objeto.`);
    const o = f as Record<string, unknown>;
    if (typeof o.filename !== "string" || o.filename.length === 0) throw Errors.validation(`files[${i}].filename requerido.`);
    if (typeof o.extension !== "string" || o.extension.length === 0) throw Errors.validation(`files[${i}].extension requerido.`);
    if (typeof o.sizeBytes !== "number" || o.sizeBytes < 0) throw Errors.validation(`files[${i}].sizeBytes: se esperaba un número >= 0.`);
    const pages = o.pages === undefined ? undefined : typeof o.pages === "number" ? o.pages : (() => { throw Errors.validation(`files[${i}].pages: se esperaba un número.`); })();
    return { filename: o.filename, extension: o.extension, sizeBytes: o.sizeBytes, pages };
  });
}

function parseFormatLimits(raw: unknown): FormatLimitsConfig {
  if (typeof raw !== "object" || raw === null) throw Errors.validation("formatLimits: se esperaba un objeto.");
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.allowedExtensions) || !o.allowedExtensions.every((e) => typeof e === "string")) {
    throw Errors.validation("formatLimits.allowedExtensions: se esperaba un arreglo de strings.");
  }
  if (typeof o.maxFileSizeBytes !== "number" || o.maxFileSizeBytes <= 0) throw Errors.validation("formatLimits.maxFileSizeBytes: se esperaba un número positivo.");
  if (typeof o.maxUploadSlots !== "number" || o.maxUploadSlots <= 0) throw Errors.validation("formatLimits.maxUploadSlots: se esperaba un número positivo.");
  const maxPagesPerFile = o.maxPagesPerFile === undefined ? undefined : typeof o.maxPagesPerFile === "number" ? o.maxPagesPerFile : (() => { throw Errors.validation("formatLimits.maxPagesPerFile: se esperaba un número."); })();
  return { allowedExtensions: o.allowedExtensions as string[], maxFileSizeBytes: o.maxFileSizeBytes, maxUploadSlots: o.maxUploadSlots, maxPagesPerFile };
}

function parseRequiredSignatures(raw: unknown): SignatureRequirement[] {
  if (!Array.isArray(raw)) throw Errors.validation("requiredSignatures: se esperaba un arreglo.");
  return raw.map((s, i) => {
    if (typeof s !== "object" || s === null) throw Errors.validation(`requiredSignatures[${i}]: se esperaba un objeto.`);
    const o = s as Record<string, unknown>;
    if (typeof o.role !== "string" || o.role.length === 0) throw Errors.validation(`requiredSignatures[${i}].role requerido.`);
    if (typeof o.userConfirmedSigned !== "boolean") throw Errors.validation(`requiredSignatures[${i}].userConfirmedSigned: se esperaba boolean.`);
    return { role: o.role, userConfirmedSigned: o.userConfirmedSigned };
  });
}

function parsePresentAnnexRefs(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.every((r) => typeof r === "string")) throw Errors.validation("presentAnnexRefs: se esperaba un arreglo de strings.");
  return raw;
}

/** Reconstruye un `EconomicProposalResult` mínimo desde lo que dejó el Flujo 2 en `generationReport.economic` — usado SOLO para alimentar la dimensión "calculos_economicos" del checklist, nunca para recalcular montos aquí. */
function reconstructEconomicResult(generationReport: { economic?: { usedRateConcepts?: string[]; blockedLineItems?: unknown[]; totals?: unknown } } | null): EconomicProposalResult | null {
  const economic = generationReport?.economic;
  if (!economic) return null;
  if (economic.totals) {
    const totals = economic.totals as EconomicProposalResult["totals"];
    return {
      lineItems: (economic.usedRateConcepts ?? []).map((concept) => ({ concept, quantity: 0, unitPriceCents: 0n, subtotalCents: 0n, sourceRef: { kind: "company_data" as const, refId: concept, capturedAt: "" } })),
      blockedLineItems: (economic.blockedLineItems ?? []) as EconomicProposalResult["blockedLineItems"],
      totals,
      cartaText: null,
      anexoText: null,
    };
  }
  return { lineItems: [], blockedLineItems: (economic.blockedLineItems ?? []) as EconomicProposalResult["blockedLineItems"], totals: null, cartaText: null, anexoText: null };
}

function overallStatusOf(items: readonly { result: "verde" | "ambar" | "rojo" }[]): "verde" | "ambar" | "rojo" {
  if (items.some((i) => i.result === "rojo")) return "rojo";
  if (items.some((i) => i.result === "ambar")) return "ambar";
  return "verde";
}

function toComplianceRecord(item: ChecklistItemResult) {
  return {
    id: randomUUID(),
    dimension: item.dimension,
    result: item.status,
    notes: item.detail,
    evidenceRef: item.evidence.length > 0 ? item.evidence.join(", ").slice(0, 2000) : null,
    checkedAt: new Date().toISOString(),
  };
}

export function licitacionesChecklistRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/tenders/:tenderId/checklist";

  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${base}/run`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");

    const proposal = await repo.findProposal(organizationId, tenderId);
    const items = proposal ? await repo.listComplianceItems(organizationId, proposal.id) : [];
    return c.json({ overallStatus: overallStatusOf(items), items });
  });

  app.post(`${base}/run`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    const raw = await readJsonCapped<ChecklistRunBody>(c.req.raw, 256 * 1024);

    const files = parseFiles(raw.files);
    const formatLimits = parseFormatLimits(raw.formatLimits);
    const requiredSignatures = parseRequiredSignatures(raw.requiredSignatures);
    const presentAnnexRefs = parsePresentAnnexRefs(raw.presentAnnexRefs);

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");

    let asOfIso: string;
    try {
      // REQ-LIC-001/AE-01: asOfIso SIEMPRE se deriva de la convocatoria ya
      // resuelta arriba -- nunca de un valor que el cliente pudiera mandar.
      asOfIso = resolveExpedienteAsOfIso(tender);
    } catch (err) {
      if (err instanceof SubmissionDeadlineUnknownError) throw Errors.submissionDeadlineUnknown(err.message);
      throw err;
    }

    const proposal = await repo.findProposal(organizationId, tenderId);
    if (!proposal) throw Errors.notFound("Genere primero la propuesta (GET /proposal) antes de ejecutar el checklist.");

    try {
      const result = await repo.withIdempotency({ organizationId, scope: "checklist.run", key: idempotencyKey, body: { files, formatLimits, requiredSignatures, presentAnnexRefs } }, async () => {
        const requiredAnnexes = await repo.listRequiredAnnexes(organizationId, tenderId);
        const documents = await repo.listCompanyDocuments(organizationId, asOfIso);
        // Limitación conocida de Fase 1 (no un bug): sin TechnicalProposalBuilder
        // portado, `generationReport.technical` nunca existe todavía -- esta
        // dimensión sale "verde" trivialmente (0 documentos que validar), documentado
        // explícitamente en el diseño §4.1.
        const usedCompanyDocumentIds = new Set(proposal.generationReport?.technical?.usedCompanyDocumentIds ?? []);
        const documentsToValidate = documents.filter((d) => usedCompanyDocumentIds.has(d.id)).map((document) => ({ document, asOfIso }));

        const economicResult = reconstructEconomicResult(proposal.generationReport);
        const crossDocumentTotals: { documentLabel: string; total: string }[] = [];
        if (economicResult?.totals) {
          crossDocumentTotals.push({ documentLabel: "carta", total: economicResult.totals.total }, { documentLabel: "anexo", total: economicResult.totals.total });
        }

        const checklistResult = new IntegrityChecklist().run({ files, formatLimits, requiredSignatures, requiredAnnexes, presentAnnexRefs, documentsToValidate, economicResult, crossDocumentTotals });

        const records = checklistResult.items.map(toComplianceRecord);
        await repo.replaceComplianceItems(organizationId, tenderId, proposal.id, records);

        return { status: 200, body: { overallStatus: checklistResult.overallStatus, items: records } };
      });
      return c.json(result.body, result.status as 200);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      throw err;
    }
  });

  return app;
}
