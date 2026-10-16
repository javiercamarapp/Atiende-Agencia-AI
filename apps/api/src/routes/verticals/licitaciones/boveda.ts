// paridad3 (L-P3-05/06) -- boveda de documentos de la convocatoria, edicion humana de la matriz de requisitos y conflictos
// persistidos. Rutas (todas bajo /licitaciones/:propertyId/tenders/:tenderId):
//
//   GET   documents                          lista (todas las versiones; `latest` marca la vigente). `disponible:false` = base sin la 037.
//   POST  documents            (WRITE_ROLES) sube bases/anexo/acta/modificacion/fallo. Valida el CONTENIDO (magic bytes en todo el buffer:
//                                            ZIP, ejecutables y PDF sin %%EOF -> 422), guarda el archivo con sha256 y deja el estado de
//                                            extraccion (extracted / requires_ocr / failed, con motivo). `replacesDocumentId` = version nueva.
//   GET   documents/:documentId              metadatos; con ?page=N agrega el texto de esa pagina (visor de la cita).
//   GET   requirement-assignees              personas a las que se puede asignar un requisito.
//   PATCH requirements/:itemId (WRITE_ROLES) responsable, estado, asignado y causa de desechamiento (REQ-101), con bitacora.
//   GET   requirements/conflicts             conflictos persistidos.
//   POST  requirements/conflicts/:id/resolve (WRITE_ROLES) cierra un conflicto; las notas son obligatorias; queda quien lo resolvio.
//
// Cada ruta registra su middleware SOLO para su metodo (`app.on`): `requirements/:itemId` tambien casaria con
// `requirements/extract` y `requirements/conflicts`, y un middleware por patron abriria dos transacciones.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  BovedaRevisionNoDisponibleError,
  IdempotencyConflictError,
  InvalidFileContentError,
  RequirementAssigneeNotFoundError,
  TENDER_DOCUMENT_TYPES,
  WRITE_ROLES,
  decodeBase64Content,
  extractDocumentText,
  isTenderDocumentType,
  sha256OfBytes,
  validateDocumentUpload,
} from "@atiende/domain-licitaciones";
import type { RequirementItemPatch, TenderDocumentType } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { avisarDocumentoSinTexto } from "./avisos-revision.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UPLOAD_BODY_BYTES = 30 * 1024 * 1024;
const REQUIREMENT_STATUSES = ["pendiente", "en_progreso", "cumplido", "no_evaluable"] as const;

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw Errors.validation(`${field}: se esperaba texto.`);
  const t = value.trim();
  if (t.length === 0) return null;
  if (t.length > max) throw Errors.validation(`${field}: máximo ${max} caracteres.`);
  return t;
}

export function parseRequirementPatch(raw: unknown): RequirementItemPatch {
  if (typeof raw !== "object" || raw === null) throw Errors.validation("Se esperaba un objeto.");
  const o = raw as Record<string, unknown>;
  const patch: { -readonly [K in keyof RequirementItemPatch]: RequirementItemPatch[K] } = {};
  if (o.responsibleRole !== undefined) {
    if (typeof o.responsibleRole !== "string" || o.responsibleRole.trim().length === 0 || o.responsibleRole.trim().length > 60) throw Errors.validation("responsibleRole: se esperaba texto de 1 a 60 caracteres.");
    patch.responsibleRole = o.responsibleRole.trim();
  }
  if (o.status !== undefined) {
    if (typeof o.status !== "string" || !(REQUIREMENT_STATUSES as readonly string[]).includes(o.status)) throw Errors.validation(`status: se esperaba ${REQUIREMENT_STATUSES.join(" | ")} ("bloqueado" lo pone el sistema por un conflicto abierto).`);
    patch.status = o.status as RequirementItemPatch["status"];
  }
  if (o.assignedTo !== undefined) {
    if (o.assignedTo !== null && (typeof o.assignedTo !== "string" || !UUID_RE.test(o.assignedTo))) throw Errors.validation("assignedTo: se esperaba el id de una persona del equipo o null.");
    patch.assignedTo = o.assignedTo as string | null;
  }
  if (o.disqualifying !== undefined) {
    if (typeof o.disqualifying !== "boolean") throw Errors.validation("disqualifying: se esperaba boolean.");
    patch.disqualifying = o.disqualifying;
  }
  if (Object.keys(patch).length === 0) throw Errors.validation("Indica al menos un campo a cambiar (responsibleRole, status, assignedTo, disqualifying).");
  return patch;
}

export function licitacionesBovedaRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/tenders/:tenderId";
  const mw = [authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId")] as const;
  app.on(["GET", "POST"], `${base}/documents`, ...mw);
  app.on("GET", `${base}/documents/:documentId`, ...mw);
  app.on("GET", `${base}/requirement-assignees`, ...mw);
  app.on("PATCH", `${base}/requirements/:itemId`, ...mw);
  app.on("GET", `${base}/requirements/conflicts`, ...mw);
  app.on("POST", `${base}/requirements/conflicts/:conflictId/resolve`, ...mw);

  app.get(`${base}/documents`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    if (!(await repo.findTender(organizationId, tenderId))) throw Errors.notFound("Convocatoria no encontrada.");
    const { disponible, documents } = await repo.listTenderDocuments(organizationId, tenderId);
    return c.json({ disponible, documents, tipos: TENDER_DOCUMENT_TYPES });
  });

  app.post(`${base}/documents`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, MAX_UPLOAD_BODY_BYTES);

    const documentType: TenderDocumentType = raw.documentType === undefined ? "bases" : isTenderDocumentType(raw.documentType) ? raw.documentType : (() => { throw Errors.validation(`documentType: se esperaba ${TENDER_DOCUMENT_TYPES.join(" | ")}.`); })();
    const filename = optionalText(raw.filename, "filename", 200);
    const title = optionalText(raw.title, "title", 200);
    const mimeType = optionalText(raw.mimeType, "mimeType", 100);
    if (typeof raw.contentBase64 !== "string" || raw.contentBase64.length === 0) throw Errors.validation("contentBase64: se esperaba el archivo en base64.");
    const replacesDocumentId = raw.replacesDocumentId === undefined || raw.replacesDocumentId === null ? null : typeof raw.replacesDocumentId === "string" && UUID_RE.test(raw.replacesDocumentId) ? raw.replacesDocumentId : (() => { throw Errors.validation("replacesDocumentId: se esperaba el id de un documento."); })();

    if (!(await repo.findTender(organizationId, tenderId))) throw Errors.notFound("Convocatoria no encontrada.");
    if (replacesDocumentId && !(await repo.getTenderDocument(organizationId, tenderId, replacesDocumentId))) throw Errors.notFound("El documento que se reemplaza no existe en esta convocatoria.");

    let buffer: Buffer;
    try {
      buffer = decodeBase64Content(raw.contentBase64);
    } catch (err) {
      if (err instanceof InvalidFileContentError) throw Errors.validation(`contentBase64: ${err.message}`);
      throw err;
    }
    // AE-03/AE-05: el contenido manda (magic bytes en todo el buffer), nunca el nombre ni el mime declarados.
    const verdict = validateDocumentUpload(buffer);
    if (!verdict.ok) throw Errors.licitacionesDocumentoRechazado(verdict.reason, verdict.message);

    const extraction = await extractDocumentText(buffer, { mimeType, filename });
    const extractionStatus = extraction.status;
    const pages = extraction.pages ? extraction.pages.map((p) => ({ page: p.page, text: p.text })) : null;

    try {
      const result = await repo.withIdempotency({ organizationId, scope: "documents.upload", key: idempotencyKey, body: { tenderId, documentType, filename, title, sha256: sha256OfBytes(buffer), replacesDocumentId } }, async () => {
        const document = await repo.createTenderDocument(organizationId, tenderId, {
          documentType,
          title,
          filename,
          mimeType,
          buffer,
          extractionStatus,
          extractionDetail: extraction.detail ?? null,
          pageCount: extraction.pageCount ?? (pages ? pages.length : null),
          pages,
          actorId: userId,
          replacesDocumentId,
        });
        await repo.recordTenderAuditEvent(organizationId, tenderId, "document.uploaded", userId);
        // REQ-166: un documento sin texto extraible se guarda (es el original) pero se avisa; nunca se inventa su contenido.
        if (extractionStatus !== "extracted") await avisarDocumentoSinTexto(c.get("db"), { organizationId, tenderId, documentId: document.id });
        return { status: 201, body: { document } };
      });
      return c.json(result.body, result.status as 201);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      if (err instanceof BovedaRevisionNoDisponibleError) throw Errors.licitacionesBovedaNoDisponible(err.funcion);
      throw err;
    }
  });

  app.get(`${base}/documents/:documentId`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    const documentId = c.req.param("documentId");
    if (!UUID_RE.test(documentId)) throw Errors.notFound("Documento no encontrado.");
    const doc = await repo.getTenderDocument(organizationId, tenderId, documentId);
    if (!doc) throw Errors.notFound("Documento no encontrado.");
    const { pages, ...document } = doc;
    const pageParam = c.req.query("page");
    if (pageParam === undefined) return c.json({ document });
    const n = Number(pageParam);
    if (!Number.isInteger(n) || n < 1) throw Errors.validation("page: se esperaba un entero >= 1.");
    // Visor de la cita: solo el texto de la pagina pedida, nunca el documento completo.
    return c.json({ document, page: pages?.find((p) => p.page === n) ?? null });
  });

  app.get(`${base}/requirement-assignees`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    return c.json({ assignees: await repo.listRequirementAssignees(c.get("organizationId")) });
  });

  app.patch(`${base}/requirements/:itemId`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    const itemId = c.req.param("itemId");
    const patch = parseRequirementPatch(await readJsonCapped<unknown>(c.req.raw, 8 * 1024));
    if (!UUID_RE.test(itemId)) throw Errors.notFound("Requisito no encontrado.");
    if (!(await repo.findTender(organizationId, tenderId))) throw Errors.notFound("Convocatoria no encontrada.");
    try {
      const item = await repo.updateRequirementItem(organizationId, tenderId, itemId, patch, userId);
      if (!item) throw Errors.notFound("Requisito no encontrado.");
      await repo.recordTenderAuditEvent(organizationId, tenderId, "requirement.edited", userId);
      return c.json({ item });
    } catch (err) {
      if (err instanceof RequirementAssigneeNotFoundError) throw Errors.validation(err.message);
      if (err instanceof BovedaRevisionNoDisponibleError) throw Errors.licitacionesBovedaNoDisponible(err.funcion);
      throw err;
    }
  });

  app.get(`${base}/requirements/conflicts`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    if (!(await repo.findTender(organizationId, tenderId))) throw Errors.notFound("Convocatoria no encontrada.");
    const { disponible, conflicts } = await repo.listRequirementConflicts(organizationId, tenderId);
    return c.json({ disponible, conflicts });
  });

  app.post(`${base}/requirements/conflicts/:conflictId/resolve`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    const conflictId = c.req.param("conflictId");
    const raw = await readJsonCapped<{ notes?: unknown }>(c.req.raw, 8 * 1024);
    if (typeof raw.notes !== "string" || raw.notes.trim().length === 0) throw Errors.validation("notes: las notas de resolución son obligatorias.");
    const notes = raw.notes.trim();
    if (notes.length > 2000) throw Errors.validation("notes: máximo 2000 caracteres.");
    if (!UUID_RE.test(conflictId)) throw Errors.notFound("Conflicto no encontrado.");
    if (!(await repo.findTender(organizationId, tenderId))) throw Errors.notFound("Convocatoria no encontrada.");
    try {
      const { conflicts } = await repo.listRequirementConflicts(organizationId, tenderId);
      const existing = conflicts.find((x) => x.id === conflictId);
      if (!existing) throw Errors.notFound("Conflicto no encontrado.");
      if (existing.status === "resuelto") throw Errors.conflict("Este conflicto ya estaba resuelto.");
      const conflict = await repo.resolveRequirementConflict(organizationId, tenderId, conflictId, { actorId: userId, notes });
      if (!conflict) throw Errors.conflict("Este conflicto ya estaba resuelto.");
      await repo.recordTenderAuditEvent(organizationId, tenderId, "requirement.conflict_resolved", userId);
      return c.json({ conflict });
    } catch (err) {
      if (err instanceof BovedaRevisionNoDisponibleError) throw Errors.licitacionesBovedaNoDisponible(err.funcion);
      throw err;
    }
  });

  return app;
}
