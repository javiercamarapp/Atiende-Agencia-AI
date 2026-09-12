// Fase 2 pieza 3 — licitacionesTechnicalProposalRoutes: cierra el hueco que
// Fase 1 dejó documentado en `001_licitaciones_schema.sql`
// ("licitaciones.requirement_item... la extracción real vía LLM/reglas... no
// se porta en esta fase") y en `checklist.ts` ("sin TechnicalProposalBuilder
// portado, generationReport.technical nunca existe todavía"). Dos rutas:
//
//  - POST .../requirements/extract (WRITE_ROLES): corre `RuleBasedExtractor`
//    sobre el texto YA EXTRAÍDO de los documentos de bases que el cliente
//    manda (esta fase no incluye un pipeline de OCR/parseo de PDF — el
//    cuerpo del request trae `{documentId, documentLabel, pages:[{page,text}]}`,
//    mismo espíritu que `checklist.ts` recibiendo METADATOS de archivos, no
//    bytes). Persiste `RequirementItem[]` reales por primera vez.
//
//    Límite honesto de alcance (deliberado, no un olvido): `LlmRequirementExtractor`
//    (domain-licitaciones) está completo y probado, pero esta ruta NO lo
//    invoca todavía -- hacerlo requeriría registrar una escalera de
//    proveedores real (`LlmGateway.registerLadder`) para el rol
//    "licitaciones:requirement_extractor", que ninguna configuración de
//    producción de este monorepo declara hoy. Wirearlo con un gateway sin
//    proveedores reales detrás sería fingir una integración que no existe
//    (mismo principio que `production/not-ready.ts`) -- se deja el extractor
//    listo para conectarse en cuanto exista esa configuración.
//
//  - POST .../proposal/technical/generate (WRITE_ROLES): corre
//    `TechnicalProposalBuilder` sobre los requisitos ya extraídos +
//    `licitaciones.company_document` + el mapeo configurado en
//    `licitaciones.requirement_fulfillment_mapping`, agrupa las secciones
//    finas por `SECTION_KEY_BY_REQUIREMENT_TYPE` en un documento por
//    categoría, y las persiste vía `saveTechnicalSections` (dispara
//    `section_author`/AE-11 automáticamente, como `saveEconomicGeneration`).
//    Una categoría con CUALQUIER bloqueo se renderiza con el prefijo
//    "PENDIENTE:" -- `cierre.ts::buildAssembleInput` YA trata cualquier
//    sección así como "documento no presente" (ver ese archivo), así que
//    esta pieza no requiere tocar esa lógica en absoluto.
//
//  - PUT .../requirement-mappings/:topicKey (DECISION_ROLES): configura de
//    qué dato de empresa se redacta un requisito de cierto tema -- decisión
//    editorial/de riesgo (afecta qué se afirma ante un ente público), nunca
//    redacción libre.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  DECISION_ROLES,
  IdempotencyConflictError,
  RuleBasedExtractor,
  RequirementMatrixBuilder,
  SECTION_KEY_BY_REQUIREMENT_TYPE,
  TechnicalProposalBuilder,
  CompanyDataService,
  InMemoryCompanyDataResolver,
  extractNotApplicableRequirements,
  resolveExpedienteAsOfIso,
  SubmissionDeadlineUnknownError,
  WRITE_ROLES,
} from "@atiende/domain-licitaciones";
import type {
  CompanyDocument,
  ProposalSection,
  RequirementFulfillmentMapping,
  RequirementFulfillmentMappingRecord,
  RequirementItem,
  RequirementItemRecord,
  RequirementType,
  TenderDocumentText,
} from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

// ─────────────────────────────────────────────────────────────────────────
// POST .../requirements/extract
// ─────────────────────────────────────────────────────────────────────────

interface ExtractBody {
  readonly documents?: unknown;
}

function parseDocuments(raw: unknown): TenderDocumentText[] {
  if (!Array.isArray(raw) || raw.length === 0) throw Errors.validation("documents: se esperaba un arreglo no vacío.");
  return raw.map((d, i) => {
    if (typeof d !== "object" || d === null) throw Errors.validation(`documents[${i}]: se esperaba un objeto.`);
    const o = d as Record<string, unknown>;
    if (typeof o.documentId !== "string" || o.documentId.length === 0) throw Errors.validation(`documents[${i}].documentId requerido.`);
    if (typeof o.documentLabel !== "string" || o.documentLabel.length === 0) throw Errors.validation(`documents[${i}].documentLabel requerido.`);
    if (typeof o.publishedAt !== "string" || Number.isNaN(new Date(o.publishedAt).getTime())) throw Errors.validation(`documents[${i}].publishedAt: se esperaba una fecha ISO válida.`);
    if (!Array.isArray(o.pages) || o.pages.length === 0) throw Errors.validation(`documents[${i}].pages: se esperaba un arreglo no vacío.`);
    const pages = o.pages.map((p, j) => {
      if (typeof p !== "object" || p === null) throw Errors.validation(`documents[${i}].pages[${j}]: se esperaba un objeto.`);
      const po = p as Record<string, unknown>;
      if (typeof po.page !== "number" || po.page < 1) throw Errors.validation(`documents[${i}].pages[${j}].page: se esperaba un número >= 1.`);
      if (typeof po.text !== "string") throw Errors.validation(`documents[${i}].pages[${j}].text: se esperaba texto.`);
      return { page: po.page, text: po.text };
    });
    return { documentId: o.documentId, documentLabel: o.documentLabel, publishedAt: o.publishedAt, pages };
  });
}

function toRequirementItemRecord(item: RequirementItem): RequirementItemRecord {
  return {
    id: item.id,
    documentId: item.source.documentId,
    text: item.text,
    requirementKind: item.type,
    obligatoriedad: item.obligatoriedad,
    topicKey: item.topicKey ?? null,
    requiredEvidence: item.requiredEvidence,
    extractedBy: item.extractedBy,
    page: item.source.page,
    clause: item.source.clause ?? null,
    responsibleRole: item.responsibleRole,
    deadline: item.deadline,
    status: item.status,
    confidence: item.confidence ?? null,
  };
}

function fromRequirementItemRecord(record: RequirementItemRecord, documentLabel: string): RequirementItem {
  return {
    id: record.id,
    text: record.text,
    source: { documentId: record.documentId ?? "desconocido", documentLabel, page: record.page ?? 0, clause: record.clause ?? undefined },
    obligatoriedad: record.obligatoriedad,
    type: record.requirementKind,
    responsibleRole: record.responsibleRole,
    deadline: record.deadline,
    requiredEvidence: record.requiredEvidence,
    status: record.status,
    extractedBy: record.extractedBy,
    confidence: record.confidence ?? undefined,
    topicKey: record.topicKey ?? undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// POST .../proposal/technical/generate
// ─────────────────────────────────────────────────────────────────────────

interface TechnicalGenerateBody {
  readonly conditionEvaluations?: unknown;
}

function parseConditionEvaluations(raw: unknown): Record<string, boolean> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object") throw Errors.validation("conditionEvaluations: se esperaba un objeto {requirementId: boolean}.");
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "boolean") throw Errors.validation(`conditionEvaluations["${key}"]: se esperaba boolean.`);
    out[key] = value;
  }
  return out;
}

function buildFulfillmentMapping(record: RequirementFulfillmentMappingRecord, requirementId: string): RequirementFulfillmentMapping {
  return {
    requirementId,
    kind: record.kind,
    refKey: record.refKey,
    // Interpolación DELIBERADAMENTE simple (reemplazo literal de "{value}",
    // nunca un motor de plantillas) -- ver migración 006.
    statementText: (value: unknown) => record.statementTemplate.replace("{value}", typeof value === "object" && value !== null && "label" in value ? String((value as { label: unknown }).label) : String(value)),
  };
}

/** Renderiza el contenido de UNA sección amplia (p. ej. "tecnica") a partir de sus `ProposalSection` finas: cualquier bloqueo hace que TODO el documento se marque "PENDIENTE:" -- `buildAssembleInput` (cierre.ts) ya trata ese prefijo como "documento no presente", sin cambios adicionales. */
function renderTechnicalSectionContent(sections: readonly ProposalSection[]): string {
  const blockers = sections.flatMap((s) => s.blockers);
  if (blockers.length > 0) {
    const lines = blockers.map((b) => `- [${b.status}] requisito ${b.requirementId} (${b.field}): ${b.detail}`);
    return `PENDIENTE: faltan ${blockers.length} elemento(s) por resolver antes de poder redactar esta sección.\n${lines.join("\n")}`;
  }
  const statementLines = sections.flatMap((s) => s.statements.map((st) => st.text));
  if (statementLines.length === 0) return "PENDIENTE: sin contenido generado para esta sección todavía.";
  return statementLines.join("\n\n");
}

const SECTION_LABEL_BY_KEY: Record<string, string> = {
  tecnica: "Propuesta técnica",
  legal: "Cumplimiento legal",
  administrativa: "Cumplimiento administrativo",
  anexos: "Anexos",
};

export function licitacionesTechnicalProposalRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const repo = deps.licitacionesRepo;
  const propertyBase = "/licitaciones/:propertyId/tenders/:tenderId";

  app.use(`${propertyBase}/requirements/extract`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${propertyBase}/requirements`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${propertyBase}/proposal/technical/generate`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/licitaciones/:propertyId/requirement-mappings/:topicKey", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(`${propertyBase}/requirements`, async (c) => {
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const items = await repo.listRequirementItems(organizationId, tenderId);
    return c.json({ items });
  });

  app.post(`${propertyBase}/requirements/extract`, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    const raw = await readJsonCapped<ExtractBody>(c.req.raw, 8 * 1024 * 1024);
    const documents = parseDocuments(raw.documents);

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");

    try {
      const result = await repo.withIdempotency({ organizationId, scope: "requirements.extract", key: idempotencyKey, body: { tenderId, documents } }, async () => {
        // Solo RuleBasedExtractor en esta ruta -- ver nota de alcance en la
        // cabecera del archivo (LlmRequirementExtractor existe y está
        // probado, pero requiere una escalera de proveedores real que hoy no
        // está configurada para licitaciones).
        const { items, conflicts } = await new RequirementMatrixBuilder([new RuleBasedExtractor()]).build(documents);
        await repo.replaceRequirementItems(organizationId, tenderId, items.map(toRequirementItemRecord));

        return {
          status: 200,
          body: {
            items,
            conflicts: conflicts.map((conf) => ({ id: conf.id, kind: conf.kind, topicKey: conf.topicKey, description: conf.description, status: conf.status, itemIds: conf.items.map((i) => i.id) })),
          },
        };
      });
      return c.json(result.body, result.status as 200);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      throw err;
    }
  });

  app.post(`${propertyBase}/proposal/technical/generate`, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const requestId = c.get("requestId");
    const tenderId = c.req.param("tenderId");
    const raw = await readJsonCapped<TechnicalGenerateBody>(c.req.raw, 32 * 1024);
    const conditionEvaluations = parseConditionEvaluations(raw.conditionEvaluations);

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");

    let asOfIso: string;
    try {
      asOfIso = resolveExpedienteAsOfIso(tender);
    } catch (err) {
      if (err instanceof SubmissionDeadlineUnknownError) throw Errors.submissionDeadlineUnknown(err.message);
      throw err;
    }

    const proposal = await repo.findProposal(organizationId, tenderId);
    if (!proposal) throw Errors.notFound("Genere primero la propuesta antes de redactar la propuesta técnica.");

    try {
      const result = await repo.withIdempotency({ organizationId, scope: "proposal.technical.generate", key: idempotencyKey, body: { tenderId, conditionEvaluations } }, async () => {
        const itemRecords = await repo.listRequirementItems(organizationId, tenderId);
        if (itemRecords.length === 0) throw Errors.validation("No hay requisitos extraídos todavía -- ejecute POST .../requirements/extract primero.");
        const items = itemRecords.map((r) => fromRequirementItemRecord(r, tender.title));

        const mappingRecords = await repo.listFulfillmentMappings(organizationId);
        const mappingByTopic = new Map(mappingRecords.map((m) => [m.topicKey, m]));
        const mappings: RequirementFulfillmentMapping[] = [];
        for (const item of items) {
          if (!item.topicKey) continue;
          const mappingRecord = mappingByTopic.get(item.topicKey);
          if (mappingRecord) mappings.push(buildFulfillmentMapping(mappingRecord, item.id));
        }

        const companyDocuments = await repo.listCompanyDocuments(organizationId, asOfIso);
        const resolverDocuments: CompanyDocument[] = companyDocuments.map((d) => ({ id: d.id, companyId: organizationId, type: d.type, label: d.label, issuedAt: asOfIso, expiresAt: d.expiresAt, approvalStatus: d.approvalStatus }));
        const companyData = new CompanyDataService(new InMemoryCompanyDataResolver({ documents: resolverDocuments }));

        const technicalProposal = new TechnicalProposalBuilder(companyData).build(organizationId, items, mappings, asOfIso, conditionEvaluations);

        // Agrupa las secciones FINAS (una por requisito) en un documento por
        // categoría amplia (SECTION_KEY_BY_REQUIREMENT_TYPE) -- cada fila de
        // `licitaciones.proposal_section` es UN documento del expediente
        // final, no un requisito individual.
        const itemTypeById = new Map(items.map((i) => [i.id, i.type]));
        const sectionsByCategory = new Map<string, ProposalSection[]>();
        for (const section of technicalProposal.sections) {
          const type = itemTypeById.get(section.requirementId) as RequirementType | undefined;
          if (!type) continue;
          const categoryKey = SECTION_KEY_BY_REQUIREMENT_TYPE[type];
          const list = sectionsByCategory.get(categoryKey) ?? [];
          list.push(section);
          sectionsByCategory.set(categoryKey, list);
        }

        const sectionsToSave = [...sectionsByCategory.entries()].map(([sectionKey, sections]) => ({
          sectionKey: `technical:${sectionKey}`,
          label: SECTION_LABEL_BY_KEY[sectionKey] ?? sectionKey,
          content: renderTechnicalSectionContent(sections),
        }));

        const usedCompanyDocumentIds = [...new Set(technicalProposal.sections.flatMap((s) => s.statements.map((st) => st.sourceRef)).filter((r) => r.kind === "company_data").map((r) => r.refId))];
        const notApplicableRequirements = extractNotApplicableRequirements(technicalProposal);

        await repo.saveTechnicalSections(organizationId, proposal.id, { actorId: userId, sections: sectionsToSave, usedCompanyDocumentIds, notApplicableRequirements });

        return {
          status: 200,
          body: {
            sections: sectionsToSave.map((s) => ({ sectionKey: s.sectionKey, label: s.label })),
            blockers: technicalProposal.blockers.length,
            notApplicableRequirements,
            correlationId: requestId ?? null,
          },
        };
      });
      return c.json(result.body, result.status as 200);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      throw err;
    }
  });

  app.put("/licitaciones/:propertyId/requirement-mappings/:topicKey", async (c) => {
    assertVerticalRole(c, DECISION_ROLES);
    const organizationId = c.get("organizationId");
    const topicKey = c.req.param("topicKey");
    const raw = await readJsonCapped<{ kind?: unknown; refKey?: unknown; statementTemplate?: unknown }>(c.req.raw, 16 * 1024);

    if (raw.kind !== "capability" && raw.kind !== "experience" && raw.kind !== "document" && raw.kind !== "signer") {
      throw Errors.validation('kind: se esperaba "capability" | "experience" | "document" | "signer".');
    }
    if (typeof raw.refKey !== "string" || raw.refKey.length === 0) throw Errors.validation("refKey requerido.");
    if (typeof raw.statementTemplate !== "string" || raw.statementTemplate.length === 0) throw Errors.validation("statementTemplate requerido.");

    const mapping = await repo.upsertFulfillmentMapping(organizationId, { topicKey, kind: raw.kind, refKey: raw.refKey, statementTemplate: raw.statementTemplate });
    return c.json(mapping, 200);
  });

  return app;
}
