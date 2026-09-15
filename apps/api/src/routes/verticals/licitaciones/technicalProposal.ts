// Fase 2 pieza 3 — licitacionesTechnicalProposalRoutes: cierra el hueco que
// Fase 1 dejó documentado en `001_licitaciones_schema.sql`
// ("licitaciones.requirement_item... la extracción real vía LLM/reglas... no
// se porta en esta fase") y en `checklist.ts` ("sin TechnicalProposalBuilder
// portado, generationReport.technical nunca existe todavía"). Dos rutas:
//
//  - POST .../requirements/extract (WRITE_ROLES): corre `RuleBasedExtractor`
//    sobre el texto de los documentos de bases que el cliente manda. Cada
//    documento admite DOS formas de entrada, resueltas por
//    `resolveDocumentText` antes de tocar `RequirementMatrixBuilder`:
//     (a) `pages:[{page,text}]` — texto YA EXTRAÍDO (el contrato original de
//         esta ruta, sin cambios de comportamiento para quien ya lo usa).
//     (b) `contentBase64` (+ `mimeType`/`filename` opcionales) — los BYTES
//         reales del archivo subido (PDF o texto plano). Fase 11 cierra
//         aquí el hueco que `contract-extraction.ts`/el README de este
//         vertical documentaban ("este monorepo NO tiene, en NINGÚN
//         vertical, un pipeline de texto-desde-PDF/OCR"): se corren por
//         `@atiende/domain-licitaciones::extractDocumentText` (motor real
//         `pdfjs-dist`, port del origen) ANTES de construir la matriz. Un
//         documento cuyo estado no sea `"extracted"` (PDF escaneado sin
//         capa de texto -> `"requires_ocr"`; formato no soportado o
//         corrupto -> `"failed"`) NUNCA se inventa como texto vacío -- se
//         excluye de la matriz y se reporta explícito en
//         `skippedDocuments` de la respuesta (REQ-166: ausencia de dato
//         nunca se traduce en "cumple"/"sin requisitos"). Sigue sin haber
//         OCR real de imagen en este monorepo -- ninguna librería/servicio
//         está disponible; ver `extractDocumentText` para el detalle.
//
//    `LlmRequirementExtractor` (domain-licitaciones) SÍ se suma a
//    `RuleBasedExtractor` en cuanto `AppDeps.llmGateway` exista -- es decir, en
//    cuanto al menos un proveedor LLM (Anthropic/OpenAI/OpenRouter) tenga API
//    key configurada, ver `production/llm-gateway.ts::buildProductionLlmGateway`
//    (registra la escalera real para el rol "licitaciones:requirement_extractor",
//    el mismo que `LlmRequirementExtractorOptions.role` usa por defecto). Sin
//    NINGUNA API key configurada, `deps.llmGateway` es `undefined` y esta ruta
//    sigue corriendo SOLO `RuleBasedExtractor`, exactamente como antes --
//    fail-closed explícito, nunca fingir una integración que no existe (mismo
//    principio que `production/not-ready.ts`).
//
//    HALLAZGO DE AUDITORÍA CONOCIDO Y SIN CERRAR (rubro 10, performance):
//    `POST .../requirements/extract` corre bajo `dbSession` (ver el `app.use`
//    de abajo), que abre UNA transacción para toda la ruta -- incluida la
//    llamada real a `LlmRequirementExtractor` cuando hay proveedor
//    configurado, sosteniendo una conexión de Postgres del pool mientras
//    dura esa llamada. El fix completo requiere sacar esta ruta del
//    middleware de auth/transacción compartido (dos sesiones cortas propias:
//    lectura -> LLM fuera de sesión -> escritura) -- un intento de hacerlo
//    fue bloqueado por el clasificador de seguridad de auto-mode como
//    "Security Weaken" al tocar el wiring de `app.use`, y no se forzó.
//    Mitigación real aplicada mientras tanto, sin tocar ningún middleware:
//    `llm-requirement-extractor.ts` acota cada llamada por página a 15s
//    (`AbortSignal.timeout`), así que el peor caso ya no es indefinido.
//    Queda pendiente de una decisión explícita sobre cómo reestructurar el
//    wiring de auth de esta ruta sin debilitar el chequeo de autorización.
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
  LlmRequirementExtractor,
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
  extractDocumentText,
  decodeBase64Content,
  InvalidFileContentError,
} from "@atiende/domain-licitaciones";
import type {
  CompanyCapability,
  CompanyDocument,
  CompanyExperienceRecord,
  CompanySigner,
  ProposalSection,
  RequirementExtractor,
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

/** `pages` ya extraído (contrato original de esta ruta) O `contentBase64` (bytes reales del archivo, Fase 11) -- nunca ambos requeridos, `parseDocuments` acepta cualquiera de los dos por documento. */
interface RawDocumentPages {
  readonly kind: "pages";
  readonly documentId: string;
  readonly documentLabel: string;
  readonly publishedAt: string;
  readonly pages: { page: number; text: string }[];
}

interface RawDocumentContent {
  readonly kind: "content";
  readonly documentId: string;
  readonly documentLabel: string;
  readonly publishedAt: string;
  readonly buffer: Buffer;
  readonly mimeType: string | null;
  readonly filename: string | null;
}

type RawDocumentInput = RawDocumentPages | RawDocumentContent;

function parseDocuments(raw: unknown): RawDocumentInput[] {
  if (!Array.isArray(raw) || raw.length === 0) throw Errors.validation("documents: se esperaba un arreglo no vacío.");
  return raw.map((d, i) => {
    if (typeof d !== "object" || d === null) throw Errors.validation(`documents[${i}]: se esperaba un objeto.`);
    const o = d as Record<string, unknown>;
    if (typeof o.documentId !== "string" || o.documentId.length === 0) throw Errors.validation(`documents[${i}].documentId requerido.`);
    if (typeof o.documentLabel !== "string" || o.documentLabel.length === 0) throw Errors.validation(`documents[${i}].documentLabel requerido.`);
    if (typeof o.publishedAt !== "string" || Number.isNaN(new Date(o.publishedAt).getTime())) throw Errors.validation(`documents[${i}].publishedAt: se esperaba una fecha ISO válida.`);

    if (o.contentBase64 !== undefined) {
      // Fase 11: bytes reales del archivo (PDF o texto plano) -- se resuelve a
      // `pages` vía `extractDocumentText` en `resolveDocuments`, DESPUÉS de
      // validar el resto del cuerpo (nunca antes: decodificar/parsear un PDF
      // completo antes de validar el resto del payload sería trabajo
      // desperdiciado en una request malformada).
      if (typeof o.contentBase64 !== "string" || o.contentBase64.length === 0) throw Errors.validation(`documents[${i}].contentBase64: se esperaba texto base64 no vacío.`);
      if (o.mimeType !== undefined && o.mimeType !== null && typeof o.mimeType !== "string") throw Errors.validation(`documents[${i}].mimeType: se esperaba texto.`);
      if (o.filename !== undefined && o.filename !== null && typeof o.filename !== "string") throw Errors.validation(`documents[${i}].filename: se esperaba texto.`);
      let buffer: Buffer;
      try {
        buffer = decodeBase64Content(o.contentBase64);
      } catch (err) {
        if (err instanceof InvalidFileContentError) throw Errors.validation(`documents[${i}].contentBase64: ${err.message}`);
        throw err;
      }
      return {
        kind: "content",
        documentId: o.documentId,
        documentLabel: o.documentLabel,
        publishedAt: o.publishedAt,
        buffer,
        mimeType: typeof o.mimeType === "string" ? o.mimeType : null,
        filename: typeof o.filename === "string" ? o.filename : null,
      };
    }

    if (!Array.isArray(o.pages) || o.pages.length === 0) throw Errors.validation(`documents[${i}]: se esperaba "pages" (texto ya extraído) o "contentBase64" (bytes del archivo, Fase 11).`);
    const pages = o.pages.map((p, j) => {
      if (typeof p !== "object" || p === null) throw Errors.validation(`documents[${i}].pages[${j}]: se esperaba un objeto.`);
      const po = p as Record<string, unknown>;
      if (typeof po.page !== "number" || po.page < 1) throw Errors.validation(`documents[${i}].pages[${j}].page: se esperaba un número >= 1.`);
      if (typeof po.text !== "string") throw Errors.validation(`documents[${i}].pages[${j}].text: se esperaba texto.`);
      return { page: po.page, text: po.text };
    });
    return { kind: "pages", documentId: o.documentId, documentLabel: o.documentLabel, publishedAt: o.publishedAt, pages };
  });
}

/** Documento excluido de la matriz porque su texto no se pudo extraer -- nunca se inventa contenido; el caller ve exactamente cuál documento y por qué (REQ-166). */
export interface SkippedDocument {
  readonly documentId: string;
  readonly documentLabel: string;
  readonly status: "requires_ocr" | "failed";
  readonly detail: string | null;
}

/**
 * Resuelve cada documento crudo a `TenderDocumentText` (texto por página
 * real): los de `kind:"pages"` pasan tal cual; los de `kind:"content"`
 * corren por `extractDocumentText` (Fase 11, `@atiende/domain-licitaciones`)
 * -- un documento cuyo estado no sea `"extracted"` se EXCLUYE de la matriz y
 * se reporta en `skipped`, nunca se inventa texto vacío para que pase.
 */
async function resolveDocuments(inputs: readonly RawDocumentInput[]): Promise<{ documents: TenderDocumentText[]; skipped: SkippedDocument[] }> {
  const documents: TenderDocumentText[] = [];
  const skipped: SkippedDocument[] = [];
  for (const input of inputs) {
    if (input.kind === "pages") {
      documents.push({ documentId: input.documentId, documentLabel: input.documentLabel, publishedAt: input.publishedAt, pages: input.pages });
      continue;
    }
    const extraction = await extractDocumentText(input.buffer, { mimeType: input.mimeType, filename: input.filename });
    if (extraction.status !== "extracted" || !extraction.pages) {
      skipped.push({
        documentId: input.documentId,
        documentLabel: input.documentLabel,
        status: extraction.status === "extracted" ? "failed" : extraction.status,
        detail: extraction.detail ?? null,
      });
      continue;
    }
    documents.push({ documentId: input.documentId, documentLabel: input.documentLabel, publishedAt: input.publishedAt, pages: extraction.pages });
  }
  return { documents, skipped };
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
  const propertyBase = "/licitaciones/:propertyId/tenders/:tenderId";

  app.use(`${propertyBase}/requirements/extract`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${propertyBase}/requirements`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${propertyBase}/proposal/technical/generate`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/licitaciones/:propertyId/requirement-mappings/:topicKey", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(`${propertyBase}/requirements`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const items = await repo.listRequirementItems(organizationId, tenderId);
    return c.json({ items });
  });

  app.post(`${propertyBase}/requirements/extract`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    // Fase 11: el cuerpo puede traer bytes reales de archivo en base64
    // (`contentBase64`) además de (o en vez de) `pages` ya extraído -- mismo
    // límite ~22MB decodificado por archivo que `storage.ts::MAX_BASE64_LENGTH`
    // (este cap acota el REQUEST completo, mismo criterio que
    // `cierre.ts::submission/declare`, que también acepta un archivo en base64).
    const raw = await readJsonCapped<ExtractBody>(c.req.raw, 30 * 1024 * 1024);
    const rawDocuments = parseDocuments(raw.documents);

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");

    // Fase 11: resuelve cada documento a texto por página REAL (motor
    // `extractDocumentText`, `@atiende/domain-licitaciones`) ANTES de
    // construir la matriz -- ver `resolveDocuments`. Corre FUERA de
    // `withIdempotency` (determinista, no toca DB) para que el cuerpo
    // hasheado por idempotencia siga siendo el payload crudo del cliente, no
    // el resultado de un motor de extracción cuya versión podría cambiar.
    // Un documento sin texto extraíble (PDF escaneado -> "requires_ocr";
    // formato no soportado/corrupto -> "failed") se EXCLUYE de la matriz,
    // nunca se inventa texto vacío para que pase -- si NINGÚN documento
    // produjo texto, se rechaza explícito (REQ-166) sin persistir nada.
    const { documents, skipped } = await resolveDocuments(rawDocuments);
    if (documents.length === 0) throw Errors.licitacionesNoExtractableDocuments(skipped);

    try {
      const result = await repo.withIdempotency({ organizationId, scope: "requirements.extract", key: idempotencyKey, body: { tenderId, documents: raw.documents } }, async () => {
        // RuleBasedExtractor SIEMPRE corre. LlmRequirementExtractor se suma SOLO SI
        // `deps.llmGateway` existe (al menos una API key de proveedor configurada,
        // ver nota de cabecera del archivo) -- fail-closed explícito, nunca fingir
        // una integración que no existe.
        const extractors: RequirementExtractor[] = [new RuleBasedExtractor()];
        if (deps.llmGateway) {
          extractors.push(new LlmRequirementExtractor(deps.llmGateway, { tenantId: organizationId }));
        }
        const { items, conflicts } = await new RequirementMatrixBuilder(extractors).build(documents);
        await repo.replaceRequirementItems(organizationId, tenderId, items.map(toRequirementItemRecord));
        // Fase 5 pieza 2 (REQ-041): una re-extracción de requisitos es
        // exactamente el caso de "acta de junta de aclaraciones" que cambia
        // los requisitos de una convocatoria ya versionada -- versiona la
        // convocatoria de nuevo aquí para que el diff/cascada/notificación
        // (ver `recordTenderVersion`) también cubran este camino, no solo el
        // alta manual de `tenders.ts`.
        await repo.recordTenderVersion(organizationId, tenderId, c.get("userId"));

        return {
          status: 200,
          body: {
            items,
            conflicts: conflicts.map((conf) => ({ id: conf.id, kind: conf.kind, topicKey: conf.topicKey, description: conf.description, status: conf.status, itemIds: conf.items.map((i) => i.id) })),
            // Fase 11: documentos subidos como bytes (`contentBase64`) que se
            // excluyeron de esta extracción por no tener texto extraíble --
            // vacío cuando todos los documentos eran `pages` ya extraído o
            // todos se extrajeron con éxito.
            skippedDocuments: skipped,
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
    const repo = deps.licitacionesRepo(c.get("db"));
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

        const companyCapabilities = await repo.listCompanyCapabilities(organizationId);
        const resolverCapabilities: CompanyCapability[] = companyCapabilities.map((c) => ({ id: c.id, companyId: organizationId, name: c.name, description: c.description, evidenceDocId: c.evidenceDocId ?? undefined, approvalStatus: c.approvalStatus }));

        const companyExperience = await repo.listCompanyExperience(organizationId);
        const resolverExperience: CompanyExperienceRecord[] = companyExperience.map((e) => ({ id: e.id, companyId: organizationId, description: e.description, evidenceDocId: e.evidenceDocId, approvalStatus: e.approvalStatus }));

        const companySigners = await repo.listCompanySigners(organizationId);
        const resolverSigners: CompanySigner[] = companySigners.map((s) => ({ id: s.id, companyId: organizationId, name: s.name, role: s.role, authorized: s.authorized }));

        const companyData = new CompanyDataService(
          new InMemoryCompanyDataResolver({ documents: resolverDocuments, capabilities: resolverCapabilities, experience: resolverExperience, signers: resolverSigners }),
        );

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
    const repo = deps.licitacionesRepo(c.get("db"));
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
