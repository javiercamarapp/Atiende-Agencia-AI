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
  BovedaRevisionNoDisponibleError,
  detectConflicts,
  sha256OfBytes,
  validateDocumentUpload,
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
  DetectedRequirementConflict,
  RequirementItemDetail,
  RequirementType,
  RequirementUpsertItem,
  TenderDocumentRecord,
  TenderDocumentText,
} from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { avisarCambioDeBases } from "./avisos-campana.ts";
import { avisarConflictosAbiertos } from "./avisos-revision.ts";

// ─────────────────────────────────────────────────────────────────────────
// POST .../requirements/extract
// ─────────────────────────────────────────────────────────────────────────

interface ExtractBody {
  readonly documents?: unknown;
  /** paridad3: ids de documentos YA guardados en la boveda (`POST .../documents`); se extrae su texto guardado, sin volver a subir. */
  readonly documentIds?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseDocumentIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 50) throw Errors.validation("documentIds: se esperaba un arreglo de hasta 50 ids.");
  const ids = raw.map((v, i) => {
    if (typeof v !== "string" || !UUID_RE.test(v)) throw Errors.validation(`documentIds[${i}]: se esperaba el id de un documento de la bóveda.`);
    return v;
  });
  return [...new Set(ids)];
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

/** De donde salio cada documento de esta corrida: `vaultId` si vive en la boveda (su `lineageId` sostiene la clave estable), o solo la referencia que mando el cliente. */
interface DocumentOrigin {
  readonly vaultId: string | null;
  readonly lineageId: string | null;
  readonly ref: string;
  readonly label: string;
}

/**
 * Resuelve cada documento a `TenderDocumentText` (texto por pagina real): los ya extraidos (`pages`) pasan tal cual; los de
 * `contentBase64` se validan por contenido (AE-03/AE-05), se guardan en la boveda (deduplicados por sha256) y se extraen con
 * `extractDocumentText`; los `documentIds` leen el texto ya guardado. Un documento cuyo estado no sea `"extracted"` se EXCLUYE de
 * la matriz y se reporta en `skipped`, nunca se inventa texto vacio para que pase (REQ-166).
 */
async function resolveDocuments(
  inputs: readonly RawDocumentInput[],
  vault: { readonly byId: readonly TenderDocumentRecordWithPages[]; readonly save: (input: RawDocumentContent, extraction: Awaited<ReturnType<typeof extractDocumentText>>) => Promise<TenderDocumentRecord | null> },
): Promise<{ documents: TenderDocumentText[]; skipped: SkippedDocument[]; origins: Map<string, DocumentOrigin> }> {
  const documents: TenderDocumentText[] = [];
  const skipped: SkippedDocument[] = [];
  const origins = new Map<string, DocumentOrigin>();

  for (const doc of vault.byId) {
    const label = doc.title ?? doc.filename ?? "Documento";
    origins.set(doc.id, { vaultId: doc.id, lineageId: doc.lineageId, ref: doc.lineageId, label });
    if (doc.extractionStatus === "extracted" && doc.pages && doc.pages.length > 0) {
      documents.push({ documentId: doc.id, documentLabel: label, publishedAt: doc.createdAt, pages: doc.pages });
    } else {
      skipped.push({ documentId: doc.id, documentLabel: label, status: doc.extractionStatus === "requires_ocr" ? "requires_ocr" : "failed", detail: doc.extractionDetail ?? "El documento de la bóveda no tiene texto extraído." });
    }
  }

  for (const input of inputs) {
    if (input.kind === "pages") {
      origins.set(input.documentId, { vaultId: null, lineageId: null, ref: input.documentId, label: input.documentLabel });
      documents.push({ documentId: input.documentId, documentLabel: input.documentLabel, publishedAt: input.publishedAt, pages: input.pages });
      continue;
    }
    // AE-03/AE-05: se valida el CONTENIDO (magic bytes en todo el buffer) antes de extraer o guardar nada.
    const verdict = validateDocumentUpload(input.buffer);
    if (!verdict.ok) throw Errors.licitacionesDocumentoRechazado(verdict.reason, verdict.message);
    const extraction = await extractDocumentText(input.buffer, { mimeType: input.mimeType, filename: input.filename });
    const saved = await vault.save(input, extraction);
    origins.set(input.documentId, saved ? { vaultId: saved.id, lineageId: saved.lineageId, ref: saved.lineageId, label: input.documentLabel } : { vaultId: null, lineageId: null, ref: input.documentId, label: input.documentLabel });
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
  return { documents, skipped, origins };
}

type TenderDocumentRecordWithPages = TenderDocumentRecord & { readonly pages: readonly { page: number; text: string }[] | null };

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
    // paridad3: la matriz trae los campos de la edicion humana (asignado, causa de desechamiento, retirado). `?includeRetired=1`
    // agrega los requisitos retirados (ya no estan en las bases vigentes; nunca se borran). `migrated:false` = base sin la 037.
    const includeRetired = c.req.query("includeRetired") === "1";
    const { migrated, items } = await repo.listRequirementMatrix(organizationId, tenderId, { includeRetired });
    return c.json({ items, migrated });
  });

  app.post(`${propertyBase}/requirements/extract`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    // Fase 11: el cuerpo puede traer bytes reales de archivo en base64
    // (`contentBase64`) además de (o en vez de) `pages` ya extraído -- mismo
    // límite ~22MB decodificado por archivo que `storage.ts::MAX_BASE64_LENGTH`
    // (este cap acota el REQUEST completo, mismo criterio que
    // `cierre.ts::submission/declare`, que también acepta un archivo en base64).
    // paridad3: ademas puede referirse a documentos ya guardados en la boveda con `documentIds`.
    const raw = await readJsonCapped<ExtractBody>(c.req.raw, 30 * 1024 * 1024);
    const rawDocuments = raw.documents === undefined ? [] : parseDocuments(raw.documents);
    const documentIds = parseDocumentIds(raw.documentIds);
    if (rawDocuments.length === 0 && documentIds.length === 0) throw Errors.validation("documents: se esperaba un arreglo no vacío (o documentIds con documentos de la bóveda).");

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");

    const vaultById: TenderDocumentRecordWithPages[] = [];
    for (const id of documentIds) {
      const doc = await repo.getTenderDocument(organizationId, tenderId, id);
      if (!doc) throw Errors.notFound("Un documento indicado no existe en esta convocatoria.");
      vaultById.push(doc);
    }
    // Los bytes subidos en base64 tambien se guardan en la boveda (deduplicados por sha256 dentro de la convocatoria): es el
    // escritor que le faltaba a `tender_document`. Sin la migracion 037 se sigue como antes, sin guardar nada.
    let vaultAvailable = true;
    const savedBySha = new Map<string, TenderDocumentRecord>();
    const listed = await repo.listTenderDocuments(organizationId, tenderId);
    if (!listed.disponible) vaultAvailable = false;
    for (const d of listed.documents) if (d.sha256 && d.latest && !savedBySha.has(d.sha256)) savedBySha.set(d.sha256, d);

    // Fase 11: resuelve cada documento a texto por página REAL (motor
    // `extractDocumentText`, `@atiende/domain-licitaciones`) ANTES de
    // construir la matriz -- ver `resolveDocuments`. Corre FUERA de
    // `withIdempotency` (determinista, no toca DB salvo guardar el original) para que el cuerpo
    // hasheado por idempotencia siga siendo el payload crudo del cliente, no
    // el resultado de un motor de extracción cuya versión podría cambiar.
    // Un documento sin texto extraíble (PDF escaneado -> "requires_ocr";
    // formato no soportado/corrupto -> "failed") se EXCLUYE de la matriz,
    // nunca se inventa texto vacío para que pase -- si NINGÚN documento
    // produjo texto, se rechaza explícito (REQ-166) sin persistir nada.
    const { documents, skipped, origins } = await resolveDocuments(rawDocuments, {
      byId: vaultById,
      save: async (input, extraction) => {
        if (!vaultAvailable) return null;
        const sha = sha256OfBytes(input.buffer);
        const existing = savedBySha.get(sha);
        if (existing) return existing;
        try {
          const created = await repo.createTenderDocument(organizationId, tenderId, {
            documentType: "bases",
            title: input.documentLabel,
            filename: input.filename,
            mimeType: input.mimeType,
            buffer: input.buffer,
            extractionStatus: extraction.status,
            extractionDetail: extraction.detail ?? null,
            pageCount: extraction.pageCount ?? (extraction.pages ? extraction.pages.length : null),
            pages: extraction.pages ? extraction.pages.map((p) => ({ page: p.page, text: p.text })) : null,
            actorId: userId,
            replacesDocumentId: null,
          });
          savedBySha.set(sha, created);
          return created;
        } catch (err) {
          if (err instanceof BovedaRevisionNoDisponibleError) {
            vaultAvailable = false;
            return null;
          }
          throw err;
        }
      },
    });
    if (documents.length === 0) throw Errors.licitacionesNoExtractableDocuments(skipped);

    try {
      const result = await repo.withIdempotency({ organizationId, scope: "requirements.extract", key: idempotencyKey, body: { tenderId, documents: raw.documents ?? null, documentIds } }, async () => {
        // RuleBasedExtractor SIEMPRE corre. LlmRequirementExtractor se suma SOLO SI
        // `deps.llmGateway` existe (al menos una API key de proveedor configurada,
        // ver nota de cabecera del archivo) -- fail-closed explícito, nunca fingir
        // una integración que no existe.
        const extractors: RequirementExtractor[] = [new RuleBasedExtractor()];
        if (deps.llmGateway) {
          extractors.push(new LlmRequirementExtractor(deps.llmGateway, { tenantId: organizationId }));
        }
        const { items, conflicts } = await new RequirementMatrixBuilder(extractors).build(documents);

        // paridad3 (L-P3-06): upsert por clave estable en vez de borrar y reinsertar. Conserva responsable, estado y asignacion
        // hechos a mano; lo que desaparece de las bases queda "retirado" con la version (nunca se borra en silencio).
        const upsertItems: RequirementUpsertItem[] = items.map((item) => {
          const origin = origins.get(item.source.documentId);
          return { ...toRequirementItemRecord(item), documentId: origin?.vaultId ?? null, documentRef: origin?.ref ?? item.source.documentId };
        });
        const involvedOrigins = documents.map((d) => origins.get(d.documentId)).filter((o): o is DocumentOrigin => o !== undefined);
        const latestVersion = await repo.latestTenderVersion(organizationId, tenderId);
        const upsert = await repo.upsertRequirementItems(organizationId, tenderId, upsertItems, {
          actorId: userId,
          scope: { lineageIds: involvedOrigins.flatMap((o) => (o.lineageId ? [o.lineageId] : [])), includeUnlinked: involvedOrigins.some((o) => o.lineageId === null) },
          retiredInVersion: (latestVersion?.version ?? 0) + 1,
        });

        // Conflictos PERSISTIDOS (regla vs LLM, o entre documentos): se detectan sobre TODA la matriz vigente (no solo los documentos de
        // esta corrida) y se guardan con estado abierto/resuelto. Sin la 037 siguen viajando solo en la respuesta, como antes.
        const labelOf = (record: RequirementItemDetail): string => (record.documentId ? (origins.get(record.documentId)?.label ?? "documento") : "documento");
        const activeItems = upsert.items.map((r) => fromRequirementItemRecord(r, labelOf(r)));
        let responseConflicts: { id: string; kind: string; topicKey: string | null; description: string; status: string; itemIds: readonly string[] }[];
        let conflictsPersisted = false;
        if (upsert.mode === "estable") {
          const stableKeyById = new Map(upsert.items.map((r) => [r.id, r.stableKey ?? r.id]));
          const detected: DetectedRequirementConflict[] = detectConflicts(activeItems).map((conf) => ({
            kind: conf.kind,
            topicKey: conf.topicKey,
            description: conf.description,
            itemIds: conf.items.map((i) => i.id),
            stableKeys: conf.items.map((i) => stableKeyById.get(i.id) ?? i.id),
          }));
          const synced = await repo.syncRequirementConflicts(organizationId, tenderId, detected);
          conflictsPersisted = synced.disponible;
          responseConflicts = synced.disponible
            ? synced.conflicts.map((conf) => ({ id: conf.id, kind: conf.kind, topicKey: conf.topicKey, description: conf.description, status: conf.status, itemIds: conf.itemIds }))
            : detected.map((d, i) => ({ id: `conflict-${i + 1}`, kind: d.kind, topicKey: d.topicKey, description: d.description, status: "abierto", itemIds: d.itemIds }));
        } else {
          responseConflicts = conflicts.map((conf) => ({ id: conf.id, kind: conf.kind, topicKey: conf.topicKey, description: conf.description, status: conf.status, itemIds: conf.items.map((i) => upsert.idByInputId[i.id] ?? i.id) }));
        }
        await repo.recordTenderAuditEvent(organizationId, tenderId, "requirements.extracted", userId);
        // Fase 5 pieza 2 (REQ-041): una re-extracción de requisitos es
        // exactamente el caso de "acta de junta de aclaraciones" que cambia
        // los requisitos de una convocatoria ya versionada -- versiona la
        // convocatoria de nuevo aquí para que el diff/cascada/notificación
        // (ver `recordTenderVersion`) también cubran este camino, no solo el
        // alta manual de `tenders.ts`.
        const nuevaVersion = await repo.recordTenderVersion(organizationId, tenderId, userId);
        // L-30: aviso in-app solo si esta re-extraccion creo una version nueva sobre una convocatoria ya versionada.
        await avisarCambioDeBases(c.get("db"), { organizationId, tenderId, version: nuevaVersion.created && nuevaVersion.version.version > 1 ? nuevaVersion.version.version : null });
        if (conflictsPersisted) await avisarConflictosAbiertos(c.get("db"), { organizationId, tenderId, openConflictIds: responseConflicts.filter((x) => x.status === "abierto").map((x) => x.id) });

        return {
          status: 200,
          body: {
            // Contrato de siempre: los requisitos de ESTA corrida (con su `source` original), ahora con el id persistido.
            items: items.map((item) => ({ ...item, id: upsert.idByInputId[item.id] ?? item.id })),
            conflicts: responseConflicts,
            // Fase 11: documentos subidos como bytes (`contentBase64`) que se
            // excluyeron de esta extracción por no tener texto extraíble --
            // vacío cuando todos los documentos eran `pages` ya extraído o
            // todos se extrajeron con éxito.
            skippedDocuments: skipped,
            // paridad3: que hizo la matriz estable en esta corrida.
            matrix: { mode: upsert.mode, created: upsert.created, updated: upsert.updated, unchanged: upsert.unchanged, retired: upsert.retired },
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
        const resolverSigners: CompanySigner[] = companySigners.map((s) => ({ id: s.id, companyId: organizationId, name: s.name, role: s.role, authorized: s.authorized, approvalStatus: s.approvalStatus }));

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
