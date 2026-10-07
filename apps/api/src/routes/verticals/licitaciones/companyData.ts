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
// Cinco sub-recursos, mismo patrón REST en los cinco:
//   POST   .../company/<recurso>            crea uno nuevo (WRITE_ROLES) SIEMPRE pendiente de aprobación
//   GET    .../company/<recurso>            lista TODOS (sin filtrar por vigencia/aprobación) con quién propuso y quién decidió
//   PATCH  .../company/<recurso>/:id        edita los datos (WRITE_ROLES); si el registro estaba aprobado vuelve a pendiente
//   POST   .../company/<recurso>/:id/approve|reject   decisión (REQ-044/064, WI-04):
//            tarifas = owner/admin + step-up `company_rate_approval`; el resto = DECISION_ROLES sin step-up (no son
//            económicos). Nunca decide quien propuso o editó por última vez; la transición es atómica y condicional
//            (404 inexistente, 409 ya decidido). `roles.ts` es la única fuente de verdad de los roles de decisión.
// `approvalStatus` ya NO se acepta en POST/PATCH (422): aprobar no es "corregir captura", es una decisión.
//
// `concept` (tarifa), `name` (capacidad) y `role` (firmante) tienen un
// índice único (organization_id, <clave>) desde su migración original
// (001/009) -- crear un duplicado nunca actualiza en silencio, responde 409
// con instrucción explícita de usar PATCH.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { CompanyDataDuplicateKeyError, CompanyDataNotFoundError, DECISION_ROLES, WRITE_ROLES, assertExplicitOffset, assertValidDecimalString, isoNow } from "@atiende/domain-licitaciones";
import type { CompanyItemDecision, CompanyItemKind, CompanyItemDecisionOutcome, LicitacionesRole } from "@atiende/domain-licitaciones";
import { emitirNotificacion, runWithSavepointFallback } from "@atiende/db";
import { requireStepUp } from "../../../second-factor.ts";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { auditar } from "./auditoria.ts";
import type { AuditEntity } from "@atiende/domain-licitaciones";
import type { AppDeps } from "../../../deps.ts";

/** `approvalStatus` en el cuerpo de un alta/edición es un intento de auto-aprobación: se rechaza (422), nunca se ignora en silencio. */
function rejectApprovalStatusInBody(raw: { approvalStatus?: unknown }): void {
  if (raw.approvalStatus !== undefined) throw Errors.companyDataApprovalNotWritable();
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

/**
 * Hallazgo de auditoría (severidad ALTA): antes convertía CUALQUIER `Error`
 * no reconocido en un 404 con el mensaje crudo de Postgres filtrado tal cual
 * al cliente (`err.message`) -- incluido, por ejemplo, un "permission denied
 * for table ..." por un GRANT faltante (ver migración 020), o un `id` con
 * formato de UUID inválido que Postgres rechaza con su propio mensaje
 * interno. Ahora solo `CompanyDataNotFoundError` (lanzado explícitamente por
 * los 5 métodos `update*` de `LicitacionesRepository` cuando el `id` no
 * corresponde a ningún registro) se mapea a 404 -- cualquier otro error se
 * propaga sin envolver, para que `apps/api/src/app.ts::onError` lo trate
 * como 500 genérico ("Error interno") sin filtrar el mensaje interno de la
 * base de datos.
 */
function mapDuplicateOrThrow(err: unknown): never {
  if (err instanceof CompanyDataDuplicateKeyError) throw Errors.conflict(err.message);
  if (err instanceof CompanyDataNotFoundError) throw Errors.notFound(err.message);
  throw err;
}

/** Roles que deciden por recurso: las tarifas (decisión económica) solo owner/admin; el resto, `DECISION_ROLES` (roles.ts, única fuente de verdad). */
const RATE_DECISION_ROLES: readonly LicitacionesRole[] = ["owner", "admin"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Nombres de quienes propusieron/decidieron (para "Propuso: X · Aprobó: Y"). Mejor esfuerzo y SIN PII extra: solo `userId -> nombre`
 * de los ids que aparecen en la lista. `listOrgMembers` corre en SAVEPOINT (la transacción del request es compartida); si no está
 * disponible o el rol no puede listar al equipo, devuelve `{}` y la pantalla muestra "otra persona del equipo".
 */
async function resolvePeople(
  deps: AppDeps,
  c: { get(key: "db"): TenantDbSession; get(key: "organizationId"): string },
  records: readonly { readonly proposedBy?: string | null; readonly approvedBy?: string | null }[],
): Promise<Record<string, string>> {
  const ids = new Set<string>();
  for (const r of records) {
    if (r.proposedBy) ids.add(r.proposedBy);
    if (r.approvedBy) ids.add(r.approvedBy);
  }
  if (ids.size === 0) return {};
  const db = c.get("db");
  return runWithSavepointFallback<Record<string, string>>({
    session: db,
    savepointName: "sp_licitaciones_company_people",
    primary: async () => {
      const members = await deps.coreStaffRepo(db).listOrgMembers(c.get("organizationId"));
      const people: Record<string, string> = {};
      for (const m of members) if (ids.has(m.userId)) people[m.userId] = m.fullName;
      return people;
    },
    isRecoverable: () => true,
    fallback: async () => ({}),
  });
}

/** Aviso in-app (catálogo) de que un dato de empresa espera decisión. Mejor esfuerzo, sin PII (solo tipo + id + hora para dedupe). */
async function avisarAprobacionPendiente(db: TenantDbSession, organizationId: string, kind: CompanyItemKind, itemId: string): Promise<void> {
  await emitirNotificacion(db, {
    evento: "licitaciones.datos_empresa.aprobacion_pendiente",
    organizationId,
    clave: `${kind}:${itemId}:${new Date().toISOString().slice(0, 13)}`,
    entidadTipo: "dato_empresa",
    entidadId: itemId,
  });
}

function decisionStatus(outcome: Exclude<CompanyItemDecisionOutcome, "ok">): never {
  switch (outcome) {
    case "not_found":
      throw Errors.notFound("Dato de empresa no encontrado.");
    case "conflict":
      throw Errors.conflict("Este dato ya no está pendiente de aprobación (otra persona lo decidió o se editó). Vuelve a consultarlo.");
    case "autor":
      throw Errors.forbidden("La persona que propuso o editó por última vez este dato no puede decidirlo: lo debe decidir otra persona con rol de decisión.");
    case "rol":
      throw Errors.forbidden();
    case "no_disponible":
      throw Errors.conflict("No disponible aún: la aprobación de este tipo de dato requiere la migración 036 en esta base.");
  }
}

/** Estado ANTERIOR de un dato de empresa (para el `antes` de la bitacora). `null` si no existe (el update lanzara su 404 propio). */
async function antesDe(deps: AppDeps, c: Context<CoreAuthHonoEnv>, kind: CompanyItemKind, id: string): Promise<object | null> {
  const repo = deps.licitacionesRepo(c.get("db"));
  const organizationId = c.get("organizationId");
  const lista: readonly { readonly id: string }[] =
    kind === "rate"
      ? await repo.listAllApprovedRates(organizationId)
      : kind === "document"
        ? await repo.listCompanyDocuments(organizationId, isoNow())
        : kind === "capability"
          ? await repo.listCompanyCapabilities(organizationId)
          : kind === "experience"
            ? await repo.listCompanyExperience(organizationId)
            : await repo.listCompanySigners(organizationId);
  return lista.find((r) => r.id === id) ?? null;
}

const ENTIDAD_DE: Readonly<Record<CompanyItemKind, AuditEntity>> = { rate: "tarifa", document: "documento_empresa", capability: "capacidad", experience: "experiencia", signer: "firmante" };

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

  const decisionPaths = [documentBase, rateBase, capabilityBase, experienceItemBase, signerBase].flatMap((base) => [`${base}/approve`, `${base}/reject`]);

  for (const path of [documentsBase, documentBase, ratesBase, rateBase, capabilitiesBase, capabilityBase, experienceBase, experienceItemBase, signersBase, signerBase, ...decisionPaths]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  // ---- Documentos de empresa ----

  app.get(documentsBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const documents = await repo.listCompanyDocuments(c.get("organizationId"), isoNow());
    return c.json({ documents, people: await resolvePeople(deps, c, documents) });
  });

  app.post(documentsBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ type?: unknown; label?: unknown; expiresAt?: unknown; approvalStatus?: unknown }>(c.req.raw, 16 * 1024);
    const type = parseRequiredString(raw.type, "type");
    const label = parseRequiredString(raw.label, "label");
    const expiresAt = raw.expiresAt === null || raw.expiresAt === undefined ? null : parseOptionalExplicitOffsetDate(raw.expiresAt, "expiresAt")!;
    rejectApprovalStatusInBody(raw);
    const document = await repo.createCompanyDocument(c.get("organizationId"), { type, label, expiresAt, actorId: c.get("userId") });
    await auditar(deps, c, { entity: ENTIDAD_DE.document, entityId: document.id, action: `${ENTIDAD_DE.document}.creado`, before: null, after: document });
    await avisarAprobacionPendiente(c.get("db"), c.get("organizationId"), "document", document.id);
    return c.json(document, 201);
  });

  app.patch(documentBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ label?: unknown; expiresAt?: unknown; approvalStatus?: unknown }>(c.req.raw, 16 * 1024);
    const input: { label?: string; expiresAt?: string | null } = {};
    if (raw.label !== undefined) input.label = parseRequiredString(raw.label, "label");
    if (raw.expiresAt !== undefined) input.expiresAt = raw.expiresAt === null ? null : parseOptionalExplicitOffsetDate(raw.expiresAt, "expiresAt")!;
    rejectApprovalStatusInBody(raw);
    try {
      const antes = await antesDe(deps, c, "document", c.req.param("documentId") ?? "");
      const document = await repo.updateCompanyDocument(c.get("organizationId"), c.req.param("documentId"), { ...input, actorId: c.get("userId") });
      await auditar(deps, c, { entity: ENTIDAD_DE.document, entityId: document.id, action: `${ENTIDAD_DE.document}.editado`, before: antes, after: document });
      await avisarAprobacionPendiente(c.get("db"), c.get("organizationId"), "document", document.id);
      return c.json(document, 200);
    } catch (err) {
      mapDuplicateOrThrow(err);
    }
  });

  // ---- Tarifas aprobadas ----

  app.get(ratesBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const rates = await repo.listAllApprovedRates(c.get("organizationId"));
    return c.json({ rates, people: await resolvePeople(deps, c, rates) });
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
    rejectApprovalStatusInBody(raw);
    try {
      const rate = await repo.createApprovedRate(c.get("organizationId"), { concept, unitPrice, validFrom, validUntil, actorId: c.get("userId") });
      await auditar(deps, c, { entity: ENTIDAD_DE.rate, entityId: rate.id, action: `${ENTIDAD_DE.rate}.creado`, before: null, after: rate });
      await avisarAprobacionPendiente(c.get("db"), c.get("organizationId"), "rate", rate.id);
      return c.json(rate, 201);
    } catch (err) {
      mapDuplicateOrThrow(err);
    }
  });

  app.patch(rateBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ unitPrice?: unknown; validFrom?: unknown; validUntil?: unknown; approvalStatus?: unknown }>(c.req.raw, 16 * 1024);
    const input: { unitPrice?: string; validFrom?: string; validUntil?: string | null } = {};
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
    rejectApprovalStatusInBody(raw);
    try {
      const antes = await antesDe(deps, c, "rate", c.req.param("rateId") ?? "");
      const rate = await repo.updateApprovedRate(c.get("organizationId"), c.req.param("rateId"), { ...input, actorId: c.get("userId") });
      await auditar(deps, c, { entity: ENTIDAD_DE.rate, entityId: rate.id, action: `${ENTIDAD_DE.rate}.editado`, before: antes, after: rate });
      await avisarAprobacionPendiente(c.get("db"), c.get("organizationId"), "rate", rate.id);
      return c.json(rate, 200);
    } catch (err) {
      mapDuplicateOrThrow(err);
    }
  });

  // ---- Capacidades ----

  app.get(capabilitiesBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const capabilities = await repo.listCompanyCapabilities(c.get("organizationId"));
    return c.json({ capabilities, people: await resolvePeople(deps, c, capabilities) });
  });

  app.post(capabilitiesBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ name?: unknown; description?: unknown; evidenceDocId?: unknown; approvalStatus?: unknown }>(c.req.raw, 16 * 1024);
    const name = parseRequiredString(raw.name, "name");
    const description = parseRequiredString(raw.description, "description");
    const evidenceDocId = parseOptionalNullableString(raw.evidenceDocId, "evidenceDocId") ?? null;
    rejectApprovalStatusInBody(raw);
    try {
      const capability = await repo.createCompanyCapability(c.get("organizationId"), { name, description, evidenceDocId, actorId: c.get("userId") });
      await auditar(deps, c, { entity: ENTIDAD_DE.capability, entityId: capability.id, action: `${ENTIDAD_DE.capability}.creado`, before: null, after: capability });
      await avisarAprobacionPendiente(c.get("db"), c.get("organizationId"), "capability", capability.id);
      return c.json(capability, 201);
    } catch (err) {
      mapDuplicateOrThrow(err);
    }
  });

  app.patch(capabilityBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ description?: unknown; evidenceDocId?: unknown; approvalStatus?: unknown }>(c.req.raw, 16 * 1024);
    const input: { description?: string; evidenceDocId?: string | null } = {};
    if (raw.description !== undefined) input.description = parseRequiredString(raw.description, "description");
    if (raw.evidenceDocId !== undefined) input.evidenceDocId = parseOptionalNullableString(raw.evidenceDocId, "evidenceDocId") ?? null;
    rejectApprovalStatusInBody(raw);
    try {
      const antes = await antesDe(deps, c, "capability", c.req.param("capabilityId") ?? "");
      const capability = await repo.updateCompanyCapability(c.get("organizationId"), c.req.param("capabilityId"), { ...input, actorId: c.get("userId") });
      await auditar(deps, c, { entity: ENTIDAD_DE.capability, entityId: capability.id, action: `${ENTIDAD_DE.capability}.editado`, before: antes, after: capability });
      await avisarAprobacionPendiente(c.get("db"), c.get("organizationId"), "capability", capability.id);
      return c.json(capability, 200);
    } catch (err) {
      mapDuplicateOrThrow(err);
    }
  });

  // ---- Experiencia ----

  app.get(experienceBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const experience = await repo.listCompanyExperience(c.get("organizationId"));
    return c.json({ experience, people: await resolvePeople(deps, c, experience) });
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
    rejectApprovalStatusInBody(raw);
    const experience = await repo.createCompanyExperience(c.get("organizationId"), { description, evidenceDocId, actorId: c.get("userId") });
    await auditar(deps, c, { entity: ENTIDAD_DE.experience, entityId: experience.id, action: `${ENTIDAD_DE.experience}.creado`, before: null, after: experience });
    await avisarAprobacionPendiente(c.get("db"), c.get("organizationId"), "experience", experience.id);
    return c.json(experience, 201);
  });

  app.patch(experienceItemBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ description?: unknown; evidenceDocId?: unknown; approvalStatus?: unknown }>(c.req.raw, 16 * 1024);
    const input: { description?: string; evidenceDocId?: string } = {};
    if (raw.description !== undefined) input.description = parseRequiredString(raw.description, "description");
    if (raw.evidenceDocId !== undefined) input.evidenceDocId = parseRequiredString(raw.evidenceDocId, "evidenceDocId");
    rejectApprovalStatusInBody(raw);
    try {
      const antes = await antesDe(deps, c, "experience", c.req.param("experienceId") ?? "");
      const experience = await repo.updateCompanyExperience(c.get("organizationId"), c.req.param("experienceId"), { ...input, actorId: c.get("userId") });
      await auditar(deps, c, { entity: ENTIDAD_DE.experience, entityId: experience.id, action: `${ENTIDAD_DE.experience}.editado`, before: antes, after: experience });
      await avisarAprobacionPendiente(c.get("db"), c.get("organizationId"), "experience", experience.id);
      return c.json(experience, 200);
    } catch (err) {
      mapDuplicateOrThrow(err);
    }
  });

  // ---- Firmantes autorizados ----

  app.get(signersBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const signers = await repo.listCompanySigners(c.get("organizationId"));
    return c.json({ signers, people: await resolvePeople(deps, c, signers) });
  });

  app.post(signersBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ name?: unknown; role?: unknown; authorized?: unknown; approvalStatus?: unknown }>(c.req.raw, 16 * 1024);
    rejectApprovalStatusInBody(raw);
    const name = parseRequiredString(raw.name, "name");
    const role = parseRequiredString(raw.role, "role");
    if (raw.authorized !== undefined && typeof raw.authorized !== "boolean") throw Errors.validation("authorized: se esperaba un booleano.");
    try {
      const signer = await repo.createCompanySigner(c.get("organizationId"), { name, role, authorized: raw.authorized as boolean | undefined, actorId: c.get("userId") });
      await auditar(deps, c, { entity: ENTIDAD_DE.signer, entityId: signer.id, action: `${ENTIDAD_DE.signer}.creado`, before: null, after: signer });
      await avisarAprobacionPendiente(c.get("db"), c.get("organizationId"), "signer", signer.id);
      return c.json(signer, 201);
    } catch (err) {
      mapDuplicateOrThrow(err);
    }
  });

  app.patch(signerBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const raw = await readJsonCapped<{ name?: unknown; authorized?: unknown; approvalStatus?: unknown }>(c.req.raw, 16 * 1024);
    rejectApprovalStatusInBody(raw);
    const input: { name?: string; authorized?: boolean } = {};
    if (raw.name !== undefined) input.name = parseRequiredString(raw.name, "name");
    if (raw.authorized !== undefined) {
      if (typeof raw.authorized !== "boolean") throw Errors.validation("authorized: se esperaba un booleano.");
      input.authorized = raw.authorized;
    }
    try {
      const antes = await antesDe(deps, c, "signer", c.req.param("signerId") ?? "");
      const signer = await repo.updateCompanySigner(c.get("organizationId"), c.req.param("signerId"), { ...input, actorId: c.get("userId") });
      await auditar(deps, c, { entity: ENTIDAD_DE.signer, entityId: signer.id, action: `${ENTIDAD_DE.signer}.editado`, before: antes, after: signer });
      await avisarAprobacionPendiente(c.get("db"), c.get("organizationId"), "signer", signer.id);
      return c.json(signer, 200);
    } catch (err) {
      mapDuplicateOrThrow(err);
    }
  });

  // ---- Decisión: aprobar / rechazar (REQ-044/064, WI-04) ----
  // Autor distinto del aprobador, transición atómica `where approval_status = 'pendiente_aprobacion'` (404/409 explícitos) y
  // bitácora, todo dentro de `LicitacionesRepository.decideCompanyItem` (en Postgres: `licitaciones.decide_company_item`, 036).
  const decisionTargets: readonly { kind: CompanyItemKind; base: string; param: string; roles: readonly LicitacionesRole[]; stepUp: boolean }[] = [
    { kind: "rate", base: rateBase, param: "rateId", roles: RATE_DECISION_ROLES, stepUp: true },
    { kind: "document", base: documentBase, param: "documentId", roles: DECISION_ROLES, stepUp: false },
    { kind: "capability", base: capabilityBase, param: "capabilityId", roles: DECISION_ROLES, stepUp: false },
    { kind: "experience", base: experienceItemBase, param: "experienceId", roles: DECISION_ROLES, stepUp: false },
    { kind: "signer", base: signerBase, param: "signerId", roles: DECISION_ROLES, stepUp: false },
  ];
  for (const target of decisionTargets) {
    for (const [suffix, decision] of [["approve", "aprobado"], ["reject", "rechazado"]] as const satisfies readonly (readonly [string, CompanyItemDecision])[]) {
      app.post(`${target.base}/${suffix}`, async (c) => {
        assertVerticalRole(c, target.roles);
        const organizationId = c.get("organizationId");
        const userId = c.get("userId");
        const itemId = c.req.param(target.param) ?? "";
        if (!UUID_RE.test(itemId)) throw Errors.notFound("Dato de empresa no encontrado.");
        // Las tarifas son la decisión económica: segundo factor reciente (token atado a usuario + organización + alcance).
        if (target.stepUp) await requireStepUp(deps, { userId, organizationId, scope: "company_rate_approval", token: c.req.header("x-step-up-token"), db: c.get("db") });
        const repo = deps.licitacionesRepo(c.get("db"));
        const outcome = await repo.decideCompanyItem(organizationId, { kind: target.kind, itemId, decision, actorId: userId, actorRole: c.get("verticalRole")! });
        if (outcome !== "ok") decisionStatus(outcome);
        await auditar(deps, c, {
          entity: ENTIDAD_DE[target.kind],
          entityId: itemId,
          action: `${ENTIDAD_DE[target.kind]}.${decision}`,
          before: { approvalStatus: "pendiente_aprobacion" },
          after: { approvalStatus: decision },
        });
        return c.json({ id: itemId, kind: target.kind, approvalStatus: decision, decidedBy: userId }, 200);
      });
    }
  }

  return app;
}
