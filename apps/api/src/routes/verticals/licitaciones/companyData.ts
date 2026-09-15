// Fase 16 (post-adjudicación, pieza 0) — licitacionesCompanyDataRoutes:
// endpoints de ESCRITURA para los "datos de empresa" que
// `CompanyDataService` (domain-licitaciones/src/company-data.ts) resuelve
// para las propuestas técnica y económica. Hasta esta pieza,
// `LicitacionesRepository` solo exponía lectura
// (`listCompanyDocuments`/`listApprovedRates`/`listCompanyCapabilities`/
// `listCompanyExperience`/`listCompanySigners`) -- sin ningún camino real
// para CAPTURAR el dato, cualquier requisito que dependiera de él resolvía
// "missing" para siempre (fail-closed correcto del dominio, pero un callejón
// sin salida en producción): la propuesta económica nunca podía generar un
// total (`proposalEconomic.ts` responde `totals: null` sin ninguna tarifa
// aprobada) y toda sección de la propuesta técnica que dependiera de un
// documento/capacidad/experiencia/firmante quedaba con el prefijo
// "PENDIENTE:" (`technicalProposal.ts::renderTechnicalSectionContent`).
//
// Cinco sub-recursos, mismo patrón REST en los cinco (WRITE_ROLES,
// mismo criterio EXACTO que el resto de captura de datos de este vertical --
// aprobar/rechazar un dato de empresa es corrección de captura, no una
// decisión de riesgo; la decisión de riesgo real es a qué requisito se
// mapea ese dato, que sigue viviendo en `requirement-mappings`,
// DECISION_ROLES, `technicalProposal.ts`):
//   POST   .../company/<recurso>            crea uno nuevo
//   GET    .../company/<recurso>            lista TODOS (sin filtrar por
//                                            vigencia/aprobación -- a
//                                            diferencia de los métodos que
//                                            consume el motor de propuestas,
//                                            la vista de administración
//                                            necesita ver/corregir también
//                                            lo pendiente/rechazado/vencido)
//   PATCH  .../company/<recurso>/:id        actualiza (incluida
//                                            `approvalStatus`) un registro
//                                            existente por id
//
// `concept` (tarifa), `name` (capacidad) y `role` (firmante) tienen un
// índice único (organization_id, <clave>) desde su migración original
// (001/009) -- crear un duplicado nunca actualiza en silencio, responde 409
// con instrucción explícita de usar PATCH.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { CompanyDataDuplicateKeyError, WRITE_ROLES, assertExplicitOffset, assertValidDecimalString, isoNow } from "@atiende/domain-licitaciones";
import type { CompanyDataApprovalStatus } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const APPROVAL_STATUSES: readonly CompanyDataApprovalStatus[] = ["aprobado", "pendiente_aprobacion", "rechazado"];

function parseOptionalApprovalStatus(raw: unknown): CompanyDataApprovalStatus | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !(APPROVAL_STATUSES as readonly string[]).includes(raw)) {
    throw Errors.validation(`approvalStatus: se esperaba uno de ${APPROVAL_STATUSES.join(", ")}.`);
  }
  return raw as CompanyDataApprovalStatus;
}

function parseRequiredString(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) throw Errors.validation(`${field} requerido.`);
  return raw;
}

/** `undefined` = campo ausente del body (no tocar); `null`/string = valor explícito (incluye "borrar" con `null` donde el campo lo admite). */
function parseOptionalNullableString(raw: unknown, field: string): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string" || raw.trim().length === 0) throw Errors.validation(`${field}: se esperaba una cadena no vacía o null.`);
  return raw;
}

/**
 * `expiresAt`/`validFrom`/`validUntil` siguen la MISMA convención que el
 * resto del vertical (`submissionDeadline` en tenders.ts, `issuedAt` en los
 * fixtures de `company-data.ts`): ISO 8601 con offset horario EXPLÍCITO,
 * nunca una fecha "naive" -- `CompanyDataService`/`isPast` (company-data.ts)
 * exigen ese offset vía `assertExplicitOffset` para evaluar vigencia contra
 * la fecha del acto, y lo hacen incondicionalmente en cuanto el valor no es
 * `null`. Aceptar aquí un formato distinto (p. ej. "YYYY-MM-DD" pelón)
 * produciría un dato que la propia `CompanyDataService` no podría evaluar
 * sin lanzar en tiempo de generación de la propuesta -- exactamente el
 * fallo silencioso que esta pieza busca cerrar, no reintroducirlo por otro
 * lado.
 */
function parseOptionalExplicitOffsetDate(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw Errors.validation(`${field}: se esperaba una cadena ISO 8601 con offset horario explícito.`);
  try {
    assertExplicitOffset(raw, field);
  } catch (err) {
    throw Errors.validation(err instanceof Error ? err.message : `${field} inválido.`);
  }
  return raw;
}

function mapDuplicateOrThrow(err: unknown): never {
  if (err instanceof CompanyDataDuplicateKeyError) throw Errors.conflict(err.message);
  throw err instanceof Error ? Errors.notFound(err.message) : err;
}

export function licitacionesCompanyDataRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const propertyBase = "/licitaciones/:propertyId";

  const documentsBase = `${propertyBase}/company/documents`;
  const documentBase = `${propertyBase}/company/documents/:documentId`;
  const ratesBase = `${propertyBase}/company/rates`;
  const rateBase = `${propertyBase}/company/rates/:rateId`;
  const capabilitiesBase = `${propertyBase}/company/capabilities`;
  const capabilityBase = `${propertyBase}/company/capabilities/:capabilityId`;
  const experienceBase = `${propertyBase}/company/experience`;
  const experienceItemBase = `${propertyBase}/company/experience/:experienceId`;
  const signersBase = `${propertyBase}/company/signers`;
  const signerBase = `${propertyBase}/company/signers/:signerId`;

  for (const path of [documentsBase, documentBase, ratesBase, rateBase, capabilitiesBase, capabilityBase, experienceBase, experienceItemBase, signersBase, signerBase]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  // ---- Documentos de empresa ----

  app.get(documentsBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const documents = await repo.listCompanyDocuments(c.get("organizationId"), isoNow());
    return c.json({ documents });
  });

  app.post(documentsBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ type?: unknown; label?: unknown; expiresAt?: unknown; approvalStatus?: unknown }>(c.req.raw, 16 * 1024);
    const type = parseRequiredString(raw.type, "type");
    const label = parseRequiredString(raw.label, "label");
    const expiresAt = raw.expiresAt === null || raw.expiresAt === undefined ? null : parseOptionalExplicitOffsetDate(raw.expiresAt, "expiresAt")!;
    const approvalStatus = parseOptionalApprovalStatus(raw.approvalStatus);
    const document = await repo.createCompanyDocument(c.get("organizationId"), { type, label, expiresAt, approvalStatus });
    return c.json(document, 201);
  });

  app.patch(documentBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ label?: unknown; expiresAt?: unknown; approvalStatus?: unknown }>(c.req.raw, 16 * 1024);
    const input: { label?: string; expiresAt?: string | null; approvalStatus?: CompanyDataApprovalStatus } = {};
    if (raw.label !== undefined) input.label = parseRequiredString(raw.label, "label");
    if (raw.expiresAt !== undefined) input.expiresAt = raw.expiresAt === null ? null : parseOptionalExplicitOffsetDate(raw.expiresAt, "expiresAt")!;
    const approvalStatus = parseOptionalApprovalStatus(raw.approvalStatus);
    if (approvalStatus !== undefined) input.approvalStatus = approvalStatus;
    try {
      const document = await repo.updateCompanyDocument(c.get("organizationId"), c.req.param("documentId"), input);
      return c.json(document, 200);
    } catch (err) {
      mapDuplicateOrThrow(err);
    }
  });

  // ---- Tarifas aprobadas ----

  app.get(ratesBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const rates = await repo.listAllApprovedRates(c.get("organizationId"));
    return c.json({ rates });
  });

  app.post(ratesBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ concept?: unknown; unitPrice?: unknown; validFrom?: unknown; validUntil?: unknown; approvalStatus?: unknown }>(c.req.raw, 16 * 1024);
    const concept = parseRequiredString(raw.concept, "concept");
    const unitPrice = parseRequiredString(raw.unitPrice, "unitPrice");
    try {
      assertValidDecimalString(unitPrice);
    } catch (err) {
      throw Errors.validation(err instanceof Error ? err.message : "unitPrice inválido.");
    }
    const validFrom = parseOptionalExplicitOffsetDate(raw.validFrom, "validFrom");
    const validUntil = raw.validUntil === undefined ? undefined : raw.validUntil === null ? null : parseOptionalExplicitOffsetDate(raw.validUntil, "validUntil");
    const approvalStatus = parseOptionalApprovalStatus(raw.approvalStatus);
    try {
      const rate = await repo.createApprovedRate(c.get("organizationId"), { concept, unitPrice, validFrom, validUntil, approvalStatus });
      return c.json(rate, 201);
    } catch (err) {
      mapDuplicateOrThrow(err);
    }
  });

  app.patch(rateBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ unitPrice?: unknown; validFrom?: unknown; validUntil?: unknown; approvalStatus?: unknown }>(c.req.raw, 16 * 1024);
    const input: { unitPrice?: string; validFrom?: string; validUntil?: string | null; approvalStatus?: CompanyDataApprovalStatus } = {};
    if (raw.unitPrice !== undefined) {
      const unitPrice = parseRequiredString(raw.unitPrice, "unitPrice");
      try {
        assertValidDecimalString(unitPrice);
      } catch (err) {
        throw Errors.validation(err instanceof Error ? err.message : "unitPrice inválido.");
      }
      input.unitPrice = unitPrice;
    }
    const validFrom = parseOptionalExplicitOffsetDate(raw.validFrom, "validFrom");
    if (validFrom !== undefined) input.validFrom = validFrom;
    if (raw.validUntil !== undefined) input.validUntil = raw.validUntil === null ? null : parseOptionalExplicitOffsetDate(raw.validUntil, "validUntil")!;
    const approvalStatus = parseOptionalApprovalStatus(raw.approvalStatus);
    if (approvalStatus !== undefined) input.approvalStatus = approvalStatus;
    try {
      const rate = await repo.updateApprovedRate(c.get("organizationId"), c.req.param("rateId"), input);
      return c.json(rate, 200);
    } catch (err) {
      mapDuplicateOrThrow(err);
    }
  });

  // ---- Capacidades ----

  app.get(capabilitiesBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const capabilities = await repo.listCompanyCapabilities(c.get("organizationId"));
    return c.json({ capabilities });
  });

  app.post(capabilitiesBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ name?: unknown; description?: unknown; evidenceDocId?: unknown; approvalStatus?: unknown }>(c.req.raw, 16 * 1024);
    const name = parseRequiredString(raw.name, "name");
    const description = parseRequiredString(raw.description, "description");
    const evidenceDocId = parseOptionalNullableString(raw.evidenceDocId, "evidenceDocId") ?? null;
    const approvalStatus = parseOptionalApprovalStatus(raw.approvalStatus);
    try {
      const capability = await repo.createCompanyCapability(c.get("organizationId"), { name, description, evidenceDocId, approvalStatus });
      return c.json(capability, 201);
    } catch (err) {
      mapDuplicateOrThrow(err);
    }
  });

  app.patch(capabilityBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ description?: unknown; evidenceDocId?: unknown; approvalStatus?: unknown }>(c.req.raw, 16 * 1024);
    const input: { description?: string; evidenceDocId?: string | null; approvalStatus?: CompanyDataApprovalStatus } = {};
    if (raw.description !== undefined) input.description = parseRequiredString(raw.description, "description");
    if (raw.evidenceDocId !== undefined) input.evidenceDocId = parseOptionalNullableString(raw.evidenceDocId, "evidenceDocId") ?? null;
    const approvalStatus = parseOptionalApprovalStatus(raw.approvalStatus);
    if (approvalStatus !== undefined) input.approvalStatus = approvalStatus;
    try {
      const capability = await repo.updateCompanyCapability(c.get("organizationId"), c.req.param("capabilityId"), input);
      return c.json(capability, 200);
    } catch (err) {
      mapDuplicateOrThrow(err);
    }
  });

  // ---- Experiencia ----

  app.get(experienceBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const experience = await repo.listCompanyExperience(c.get("organizationId"));
    return c.json({ experience });
  });

  app.post(experienceBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ description?: unknown; evidenceDocId?: unknown; approvalStatus?: unknown }>(c.req.raw, 16 * 1024);
    const description = parseRequiredString(raw.description, "description");
    // A diferencia de `capability`/`document`, `evidenceDocId` es OBLIGATORIO
    // aquí -- mismo criterio de dominio que `CompanyDataService.resolveExperience`
    // (bloquea con "evidencia_no_verificable" si está vacío) y que la propia
    // migración 009 (`company_experience.evidence_doc_id not null`).
    const evidenceDocId = parseRequiredString(raw.evidenceDocId, "evidenceDocId");
    const approvalStatus = parseOptionalApprovalStatus(raw.approvalStatus);
    const experience = await repo.createCompanyExperience(c.get("organizationId"), { description, evidenceDocId, approvalStatus });
    return c.json(experience, 201);
  });

  app.patch(experienceItemBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ description?: unknown; evidenceDocId?: unknown; approvalStatus?: unknown }>(c.req.raw, 16 * 1024);
    const input: { description?: string; evidenceDocId?: string; approvalStatus?: CompanyDataApprovalStatus } = {};
    if (raw.description !== undefined) input.description = parseRequiredString(raw.description, "description");
    if (raw.evidenceDocId !== undefined) input.evidenceDocId = parseRequiredString(raw.evidenceDocId, "evidenceDocId");
    const approvalStatus = parseOptionalApprovalStatus(raw.approvalStatus);
    if (approvalStatus !== undefined) input.approvalStatus = approvalStatus;
    try {
      const experience = await repo.updateCompanyExperience(c.get("organizationId"), c.req.param("experienceId"), input);
      return c.json(experience, 200);
    } catch (err) {
      mapDuplicateOrThrow(err);
    }
  });

  // ---- Firmantes autorizados ----

  app.get(signersBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const signers = await repo.listCompanySigners(c.get("organizationId"));
    return c.json({ signers });
  });

  app.post(signersBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ name?: unknown; role?: unknown; authorized?: unknown }>(c.req.raw, 16 * 1024);
    const name = parseRequiredString(raw.name, "name");
    const role = parseRequiredString(raw.role, "role");
    if (raw.authorized !== undefined && typeof raw.authorized !== "boolean") throw Errors.validation("authorized: se esperaba un booleano.");
    try {
      const signer = await repo.createCompanySigner(c.get("organizationId"), { name, role, authorized: raw.authorized as boolean | undefined });
      return c.json(signer, 201);
    } catch (err) {
      mapDuplicateOrThrow(err);
    }
  });

  app.patch(signerBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ name?: unknown; authorized?: unknown }>(c.req.raw, 16 * 1024);
    const input: { name?: string; authorized?: boolean } = {};
    if (raw.name !== undefined) input.name = parseRequiredString(raw.name, "name");
    if (raw.authorized !== undefined) {
      if (typeof raw.authorized !== "boolean") throw Errors.validation("authorized: se esperaba un booleano.");
      input.authorized = raw.authorized;
    }
    try {
      const signer = await repo.updateCompanySigner(c.get("organizationId"), c.req.param("signerId"), input);
      return c.json(signer, 200);
    } catch (err) {
      mapDuplicateOrThrow(err);
    }
  });

  return app;
}
