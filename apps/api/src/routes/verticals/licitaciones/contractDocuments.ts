// Fase 6 pieza 2 (REQ-052) — licitacionesContractDocumentsRoutes: subida +
// extracción determinista del contrato firmado.
//
// Fase 11 cerró el límite que este archivo documentaba ("este monorepo NO
// tiene, en ningún vertical, un pipeline de texto-desde-PDF/OCR"): el cuerpo
// de `POST .../contract/documents` ahora admite DOS formas de entrada,
// resueltas por `resolveContractDocumentPages` --
//  (a) `pages:[{page,text}]` — texto YA EXTRAÍDO (el contrato original de
//      esta ruta, sin cambios de comportamiento para quien ya lo usa).
//  (b) `contentBase64` (+ `mimeType`/`filename` opcionales) — los BYTES
//      reales del contrato firmado subido (PDF o texto plano), resueltos vía
//      `@atiende/domain-licitaciones::extractDocumentText` (motor real
//      `pdfjs-dist`, ver `text-extraction.ts`). Un documento cuyo estado no
//      sea `"extracted"` (PDF escaneado sin capa de texto -> `"requires_ocr"`;
//      formato no soportado o corrupto -> `"failed"`) se rechaza explícito
//      (422) -- nunca se inventa texto vacío para que `extractContractFields`
//      corra sobre nada. Sigue sin haber OCR real de imagen en este
//      monorepo -- ninguna librería/servicio está disponible.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { WRITE_ROLES, extractDocumentText, decodeBase64Content, InvalidFileContentError } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface ContractDocumentUploadBody {
  readonly documentLabel?: unknown;
  readonly pages?: unknown;
  readonly contentBase64?: unknown;
  readonly mimeType?: unknown;
  readonly filename?: unknown;
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

/**
 * Fase 11: resuelve el cuerpo de subida a `{page,text}[]` -- `pages` ya
 * extraído pasa tal cual; `contentBase64` corre por `extractDocumentText`
 * (bytes reales del contrato firmado). Nunca ambos a la vez: `pages` tiene
 * prioridad si el caller manda los dos por error (compatibilidad hacia
 * atrás explícita, no ambigua).
 */
async function resolveContractDocumentPages(raw: ContractDocumentUploadBody): Promise<{ page: number; text: string }[]> {
  if (raw.pages !== undefined) return parsePages(raw.pages);

  if (raw.contentBase64 === undefined) throw Errors.validation('Se esperaba "pages" (texto ya extraído) o "contentBase64" (bytes del archivo, Fase 11).');
  if (typeof raw.contentBase64 !== "string" || raw.contentBase64.length === 0) throw Errors.validation("contentBase64: se esperaba texto base64 no vacío.");
  if (raw.mimeType !== undefined && raw.mimeType !== null && typeof raw.mimeType !== "string") throw Errors.validation("mimeType: se esperaba texto.");
  if (raw.filename !== undefined && raw.filename !== null && typeof raw.filename !== "string") throw Errors.validation("filename: se esperaba texto.");

  let buffer: Buffer;
  try {
    buffer = decodeBase64Content(raw.contentBase64);
  } catch (err) {
    if (err instanceof InvalidFileContentError) throw Errors.validation(`contentBase64: ${err.message}`);
    throw err;
  }

  const extraction = await extractDocumentText(buffer, {
    mimeType: typeof raw.mimeType === "string" ? raw.mimeType : null,
    filename: typeof raw.filename === "string" ? raw.filename : null,
  });
  if (extraction.status !== "extracted" || !extraction.pages) {
    throw Errors.licitacionesNoExtractableDocuments([{ documentLabel: typeof raw.documentLabel === "string" ? raw.documentLabel : "contrato firmado", status: extraction.status === "extracted" ? "failed" : extraction.status }]);
  }
  return extraction.pages.map((p) => ({ page: p.page, text: p.text }));
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
    // Fase 11: 30MB (antes 2MB) -- el cuerpo puede traer los bytes reales del
    // PDF firmado en base64 (`contentBase64`), mismo cap que
    // `technicalProposal.ts::requirements/extract`/`cierre.ts::submission/declare`.
    const raw = await readJsonCapped<ContractDocumentUploadBody>(c.req.raw, 30 * 1024 * 1024);

    if (typeof raw.documentLabel !== "string" || raw.documentLabel.trim().length === 0) throw Errors.validation("documentLabel requerido.");
    const pages = await resolveContractDocumentPages(raw);

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
