// L-P3-03/04 (REQ-141/142/109) -- perfil de empresa COMPLETO: perfil general, productos y servicios, ubicaciones, restricciones y
// socios/representantes. Mismo patron que `companyData.ts`:
//   GET    .../company/<recurso>                 lista (cualquier miembro) con `people` y `provenance` (quien capturo cada dato y cuando)
//   POST   .../company/<recurso>                 alta (WRITE_ROLES), SIEMPRE pendiente de aprobacion
//   PATCH  .../company/<recurso>/:id             edicion (WRITE_ROLES); un dato aprobado vuelve a pendiente
//   DELETE .../company/<recurso>/:id             baja (productos y ubicaciones: WRITE_ROLES; restricciones y socios: DECISION_ROLES)
//   POST   .../company/<recurso>/:id/approve|reject   decision (DECISION_ROLES, autor distinto del aprobador; 404/409 explicitos)
// El perfil general es uno por organizacion: GET/PUT .../company/profile (+ approve|reject con el id del perfil).
//
// Cada alta o edicion registra su PROCEDENCIA en la misma transaccion del request (repositorio): si falla, no queda nada.
// Base sin la migracion 040: las lecturas devuelven vacio con `disponible: false` y las escrituras responden 409 "no disponible aun".
// `approvalStatus` en el cuerpo es un intento de auto-aprobacion y se rechaza.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { Context } from "hono";
import {
  DECISION_ROLES,
  KycValidationError,
  LOCATION_KINDS,
  MIPYME_SECTORES,
  PRODUCT_SERVICE_KINDS,
  RESTRICTION_KINDS,
  STAKEHOLDER_KINDS,
  WRITE_ROLES,
  estratificarMipyme,
  fichaNormaPorId,
  MIPYME_FICHA_ID,
  normalizeParticipationPct,
  parseRfc,
} from "@atiende/domain-licitaciones";
import type {
  CompanyItemDecision,
  CompanyItemDecisionOutcome,
  CompanyItemKind,
  CompanyLocationCreateInput,
  CompanyLocationRecord,
  CompanyLocationUpdateInput,
  CompanyProductServiceCreateInput,
  CompanyProductServiceRecord,
  CompanyProductServiceUpdateInput,
  CompanyProfileCollectionKind,
  CompanyProfileUpsertInput,
  CompanyRestrictionCreateInput,
  CompanyRestrictionRecord,
  CompanyRestrictionUpdateInput,
  CompanyStakeholderCreateInput,
  CompanyStakeholderRecord,
  CompanyStakeholderUpdateInput,
  LicitacionesRepository,
  LicitacionesRole,
  ProvenanceEntity,
} from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { auditar } from "./auditoria.ts";
import {
  ENTIDAD_DE,
  UUID_RE,
  antesDe,
  avisarAprobacionPendiente,
  decisionStatus,
  mapDuplicateOrThrow,
  parseDateOnly,
  parseOptionalText,
  parseRequiredString,
  peopleAndProvenance,
  rejectApprovalStatusInBody,
} from "./companyData.ts";

const BODY_MAX = 16 * 1024;

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], field: string): T {
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) throw Errors.validation(`${field}: se esperaba ${allowed.map((a) => `"${a}"`).join(" | ")}.`);
  return raw as T;
}

function boundedRequired(raw: unknown, field: string, max: number): string {
  const text = parseRequiredString(raw, field).trim();
  if (text.length > max) throw Errors.validation(`${field}: máximo ${max} caracteres.`);
  return text;
}

/** RFC normalizado y validado (forma, fecha y homoclave). `undefined` = ausente, `null` = sin RFC. */
function parseTaxId(raw: unknown, field: string): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || (typeof raw === "string" && raw.trim() === "")) return null;
  try {
    return parseRfc(raw).rfc;
  } catch (err) {
    if (err instanceof KycValidationError) throw Errors.validation(`${field}: ${err.message}`);
    throw err;
  }
}

function parseNullableInt(raw: unknown, field: string, min: number, max: number): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min || raw > max) throw Errors.validation(`${field}: se esperaba un entero entre ${min} y ${max}.`);
  return raw;
}

function parseWebsite(raw: unknown): string | null | undefined {
  const text = parseOptionalText(raw, "website", 300);
  if (text === undefined || text === null) return text;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocolo");
  } catch {
    throw Errors.validation("website: se esperaba una dirección http:// o https://.");
  }
  return text;
}

const centsOf = (pct: string): number => Math.round(Number(pct) * 100);

export function licitacionesCompanyProfileRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/company";

  function guard(path: string): void {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  /** Decision (approve/reject) comun a los cinco tipos. Mismos roles que el resto de datos no economicos; sin step-up. */
  function registerDecision(kind: CompanyItemKind, itemBase: string, param: string): void {
    for (const [suffix, decision] of [["approve", "aprobado"], ["reject", "rechazado"]] as const satisfies readonly (readonly [string, CompanyItemDecision])[]) {
      guard(`${itemBase}/${suffix}`);
      app.post(`${itemBase}/${suffix}`, async (c) => {
        assertVerticalRole(c, DECISION_ROLES);
        const itemId = c.req.param(param) ?? "";
        if (!UUID_RE.test(itemId)) throw Errors.notFound("Dato de empresa no encontrado.");
        const repo = deps.licitacionesRepo(c.get("db"));
        const outcome: CompanyItemDecisionOutcome = await repo.decideCompanyItem(c.get("organizationId"), { kind, itemId, decision, actorId: c.get("userId"), actorRole: c.get("verticalRole")! });
        if (outcome !== "ok") decisionStatus(outcome);
        await auditar(deps, c, { entity: ENTIDAD_DE[kind], entityId: itemId, action: `${ENTIDAD_DE[kind]}.${decision}`, before: { approvalStatus: "pendiente_aprobacion" }, after: { approvalStatus: decision } });
        return c.json({ id: itemId, kind, approvalStatus: decision, decidedBy: c.get("userId") }, 200);
      });
    }
  }

  // ---------------------------------------------------------------- perfil general
  const profileBase = `${base}/profile`;
  const profileItem = `${base}/profile/:profileId`;
  guard(profileBase);
  guard(profileItem);

  app.get(profileBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const disponible = await repo.isCompanyProfileAvailable();
    const profile = await repo.getCompanyProfile(organizationId);
    const ficha = fichaNormaPorId(MIPYME_FICHA_ID);
    // REQ-109: estratificacion determinista con las cifras de la ficha normativa (hoy sin verificar). Sin perfil no hay nada que estratificar.
    const mipyme = profile ? estratificarMipyme({ sector: profile.sector, employeeCount: profile.employeeCount, annualSalesCents: profile.annualSalesCents }) : null;
    return c.json({
      disponible,
      profile,
      mipyme,
      norma: ficha ? { id: ficha.id, titulo: ficha.titulo, estadoVerificacion: ficha.estadoVerificacion, validarConAbogado: ficha.validarConAbogado, nota: ficha.nota } : null,
      ...(await peopleAndProvenance(deps, c, repo, "profile", profile ? [profile] : [])),
    });
  });

  app.put(profileBase, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    const repo = deps.licitacionesRepo(c.get("db"));
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, BODY_MAX);
    rejectApprovalStatusInBody(raw);
    const legalName = boundedRequired(raw.legalName, "legalName", 300);
    const taxId = parseTaxId(raw.taxId, "taxId");
    if (!taxId) throw Errors.validation("taxId requerido: el RFC de la empresa.");
    const sector = raw.sector === undefined || raw.sector === null ? null : oneOf(raw.sector, MIPYME_SECTORES, "sector");
    const tradeName = parseOptionalText(raw.tradeName, "tradeName", 300) ?? null;
    const input: CompanyProfileUpsertInput = {
      legalName,
      taxId,
      tradeName,
      sector,
      foundedYear: parseNullableInt(raw.foundedYear, "foundedYear", 1800, new Date().getUTCFullYear()) ?? null,
      employeeCount: parseNullableInt(raw.employeeCount, "employeeCount", 0, 10_000_000) ?? null,
      annualSalesCents: parseNullableInt(raw.annualSalesCents, "annualSalesCents", 0, Number.MAX_SAFE_INTEGER) ?? null,
      website: parseWebsite(raw.website) ?? null,
      actorId: c.get("userId"),
    };
    const organizationId = c.get("organizationId");
    try {
      const antes = await repo.getCompanyProfile(organizationId);
      const profile = await repo.upsertCompanyProfile(organizationId, input);
      await auditar(deps, c, { entity: ENTIDAD_DE.profile, entityId: profile.id, action: `${ENTIDAD_DE.profile}.${antes ? "editado" : "creado"}`, before: antes, after: profile });
      await avisarAprobacionPendiente(c.get("db"), organizationId, "profile", profile.id);
      return c.json(profile, antes ? 200 : 201);
    } catch (err) {
      mapDuplicateOrThrow(err);
    }
  });
  registerDecision("profile", profileItem, "profileId");

  // ---------------------------------------------------------------- colecciones
  interface Spec<Rec extends { id: string; approvalStatus: string; proposedBy?: string | null; approvedBy?: string | null }, Create, Update> {
    readonly segment: string;
    readonly kind: CompanyProfileCollectionKind;
    readonly entity: ProvenanceEntity;
    readonly listKey: string;
    readonly param: string;
    readonly deleteRoles: readonly LicitacionesRole[];
    readonly list: (repo: LicitacionesRepository, org: string) => Promise<readonly Rec[]>;
    readonly create: (repo: LicitacionesRepository, org: string, input: Create) => Promise<Rec>;
    readonly update: (repo: LicitacionesRepository, org: string, id: string, input: Update) => Promise<Rec>;
    readonly parseCreate: (raw: Record<string, unknown>, ctx: { repo: LicitacionesRepository; org: string }) => Promise<Create> | Create;
    readonly parsePatch: (raw: Record<string, unknown>, ctx: { repo: LicitacionesRepository; org: string; id: string }) => Promise<Update> | Update;
  }

  function registerCollection<Rec extends { id: string; approvalStatus: string; proposedBy?: string | null; approvedBy?: string | null }, Create, Update>(spec: Spec<Rec, Create, Update>): void {
    const listPath = `${base}/${spec.segment}`;
    const itemPath = `${base}/${spec.segment}/:${spec.param}`;
    guard(listPath);
    guard(itemPath);

    app.get(listPath, async (c) => {
      const repo = deps.licitacionesRepo(c.get("db"));
      const records = await spec.list(repo, c.get("organizationId"));
      return c.json({ disponible: await repo.isCompanyProfileAvailable(), [spec.listKey]: records, ...(await peopleAndProvenance(deps, c, repo, spec.entity, records)) });
    });

    app.post(listPath, async (c) => {
      assertVerticalRole(c, WRITE_ROLES);
      const repo = deps.licitacionesRepo(c.get("db"));
      const organizationId = c.get("organizationId");
      const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, BODY_MAX);
      rejectApprovalStatusInBody(raw);
      const input = await spec.parseCreate(raw, { repo, org: organizationId });
      try {
        const record = await spec.create(repo, organizationId, { ...input, actorId: c.get("userId") } as Create);
        await auditar(deps, c, { entity: ENTIDAD_DE[spec.kind], entityId: record.id, action: `${ENTIDAD_DE[spec.kind]}.creado`, before: null, after: record });
        await avisarAprobacionPendiente(c.get("db"), organizationId, spec.kind, record.id);
        return c.json(record, 201);
      } catch (err) {
        mapDuplicateOrThrow(err);
      }
    });

    app.patch(itemPath, async (c) => {
      assertVerticalRole(c, WRITE_ROLES);
      const repo = deps.licitacionesRepo(c.get("db"));
      const organizationId = c.get("organizationId");
      const id = c.req.param(spec.param) ?? "";
      if (!UUID_RE.test(id)) throw Errors.notFound("Dato de empresa no encontrado.");
      const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, BODY_MAX);
      rejectApprovalStatusInBody(raw);
      const input = await spec.parsePatch(raw, { repo, org: organizationId, id });
      try {
        const antes = await antesDe(deps, c as unknown as Context<CoreAuthHonoEnv>, spec.kind, id);
        const record = await spec.update(repo, organizationId, id, { ...input, actorId: c.get("userId") } as Update);
        await auditar(deps, c, { entity: ENTIDAD_DE[spec.kind], entityId: record.id, action: `${ENTIDAD_DE[spec.kind]}.editado`, before: antes, after: record });
        await avisarAprobacionPendiente(c.get("db"), organizationId, spec.kind, record.id);
        return c.json(record, 200);
      } catch (err) {
        mapDuplicateOrThrow(err);
      }
    });

    app.delete(itemPath, async (c) => {
      assertVerticalRole(c, spec.deleteRoles);
      const repo = deps.licitacionesRepo(c.get("db"));
      const organizationId = c.get("organizationId");
      const id = c.req.param(spec.param) ?? "";
      if (!UUID_RE.test(id)) throw Errors.notFound("Dato de empresa no encontrado.");
      try {
        const antes = await antesDe(deps, c as unknown as Context<CoreAuthHonoEnv>, spec.kind, id);
        if (!(await repo.deleteCompanyProfileItem(organizationId, spec.kind, id))) throw Errors.notFound("Dato de empresa no encontrado.");
        await auditar(deps, c, { entity: ENTIDAD_DE[spec.kind], entityId: id, action: `${ENTIDAD_DE[spec.kind]}.eliminado`, before: antes, after: null });
        return c.json({ id, deleted: true }, 200);
      } catch (err) {
        mapDuplicateOrThrow(err);
      }
    });

    registerDecision(spec.kind, itemPath, spec.param);
  }

  registerCollection<CompanyProductServiceRecord, CompanyProductServiceCreateInput, CompanyProductServiceUpdateInput>({
    segment: "products-services",
    kind: "product",
    entity: "product",
    listKey: "productsServices",
    param: "itemId",
    deleteRoles: WRITE_ROLES,
    list: (repo, org) => repo.listCompanyProductsServices(org),
    create: (repo, org, input) => repo.createCompanyProductService(org, input),
    update: (repo, org, id, input) => repo.updateCompanyProductService(org, id, input),
    parseCreate: (raw) => ({
      kind: oneOf(raw.kind, PRODUCT_SERVICE_KINDS, "kind"),
      name: boundedRequired(raw.name, "name", 300),
      description: parseOptionalText(raw.description, "description", 2000),
      classifierCode: parseOptionalText(raw.classifierCode, "classifierCode", 40),
    }),
    parsePatch: (raw) => ({
      ...(raw.name !== undefined ? { name: boundedRequired(raw.name, "name", 300) } : {}),
      ...(raw.description !== undefined ? { description: parseOptionalText(raw.description, "description", 2000) } : {}),
      ...(raw.classifierCode !== undefined ? { classifierCode: parseOptionalText(raw.classifierCode, "classifierCode", 40) } : {}),
    }),
  });

  registerCollection<CompanyLocationRecord, CompanyLocationCreateInput, CompanyLocationUpdateInput>({
    segment: "locations",
    kind: "location",
    entity: "location",
    listKey: "locations",
    param: "itemId",
    deleteRoles: WRITE_ROLES,
    list: (repo, org) => repo.listCompanyLocations(org),
    create: (repo, org, input) => repo.createCompanyLocation(org, input),
    update: (repo, org, id, input) => repo.updateCompanyLocation(org, id, input),
    parseCreate: (raw) => ({
      kind: oneOf(raw.kind, LOCATION_KINDS, "kind"),
      name: boundedRequired(raw.name, "name", 300),
      state: boundedRequired(raw.state, "state", 100),
      municipality: parseOptionalText(raw.municipality, "municipality", 150),
      address: parseOptionalText(raw.address, "address", 400),
    }),
    parsePatch: (raw) => ({
      ...(raw.kind !== undefined ? { kind: oneOf(raw.kind, LOCATION_KINDS, "kind") } : {}),
      ...(raw.name !== undefined ? { name: boundedRequired(raw.name, "name", 300) } : {}),
      ...(raw.state !== undefined ? { state: boundedRequired(raw.state, "state", 100) } : {}),
      ...(raw.municipality !== undefined ? { municipality: parseOptionalText(raw.municipality, "municipality", 150) } : {}),
      ...(raw.address !== undefined ? { address: parseOptionalText(raw.address, "address", 400) } : {}),
    }),
  });

  registerCollection<CompanyRestrictionRecord, CompanyRestrictionCreateInput, CompanyRestrictionUpdateInput>({
    segment: "restrictions",
    kind: "restriction",
    entity: "restriction",
    listKey: "restrictions",
    param: "itemId",
    deleteRoles: DECISION_ROLES,
    list: (repo, org) => repo.listCompanyRestrictions(org),
    create: (repo, org, input) => repo.createCompanyRestriction(org, input),
    update: (repo, org, id, input) => repo.updateCompanyRestriction(org, id, input),
    parseCreate: (raw) => {
      const validFrom = parseDateOnly(raw.validFrom, "validFrom");
      if (!validFrom) throw Errors.validation("validFrom requerido: desde cuándo rige la restricción (AAAA-MM-DD).");
      const validUntil = parseDateOnly(raw.validUntil, "validUntil");
      if (validUntil && validUntil < validFrom) throw Errors.validation("validUntil: la restricción no puede terminar antes de empezar.");
      return { kind: oneOf(raw.kind, RESTRICTION_KINDS, "kind"), description: boundedRequired(raw.description, "description", 1000), validFrom, validUntil };
    },
    parsePatch: async (raw, { repo, org, id }) => {
      const validFrom = parseDateOnly(raw.validFrom, "validFrom");
      if (validFrom === null) throw Errors.validation("validFrom no se puede borrar.");
      const validUntil = parseDateOnly(raw.validUntil, "validUntil");
      const actual = (await repo.listCompanyRestrictions(org)).find((r) => r.id === id);
      const desde = validFrom ?? actual?.validFrom ?? null;
      const hasta = validUntil !== undefined ? validUntil : (actual?.validUntil ?? null);
      if (desde && hasta && hasta < desde) throw Errors.validation("validUntil: la restricción no puede terminar antes de empezar.");
      return {
        ...(raw.kind !== undefined ? { kind: oneOf(raw.kind, RESTRICTION_KINDS, "kind") } : {}),
        ...(raw.description !== undefined ? { description: boundedRequired(raw.description, "description", 1000) } : {}),
        ...(validFrom !== undefined ? { validFrom } : {}),
        ...(validUntil !== undefined ? { validUntil } : {}),
      };
    },
  });

  /** REQ-111: la suma de las participaciones de los socios no puede pasar de 100.00 (se excluyen los rechazados y el propio elemento al editar). */
  function assertParticipationFits(existing: readonly CompanyStakeholderRecord[], excludeId: string | null, add: string | null): void {
    if (add === null) return;
    const others = existing.filter((s) => s.id !== excludeId && s.kind === "socio" && s.approvalStatus !== "rechazado" && s.participationPct !== null);
    const total = others.reduce((sum, s) => sum + centsOf(s.participationPct!), 0) + centsOf(add);
    if (total > 10_000) throw Errors.validation(`participationPct: la suma de las participaciones de los socios no puede pasar de 100.00 (con este socio sería ${(total / 100).toFixed(2)}).`);
  }

  registerCollection<CompanyStakeholderRecord, CompanyStakeholderCreateInput, CompanyStakeholderUpdateInput>({
    segment: "stakeholders",
    kind: "stakeholder",
    entity: "stakeholder",
    listKey: "stakeholders",
    param: "itemId",
    deleteRoles: DECISION_ROLES,
    list: (repo, org) => repo.listCompanyStakeholders(org),
    create: (repo, org, input) => repo.createCompanyStakeholder(org, input),
    update: (repo, org, id, input) => repo.updateCompanyStakeholder(org, id, input),
    parseCreate: async (raw, { repo, org }) => {
      const kind = oneOf(raw.kind, STAKEHOLDER_KINDS, "kind");
      const rfc = parseTaxId(raw.rfc, "rfc") ?? null;
      let participationPct: string | null = null;
      if (kind === "socio") {
        participationPct = normalizeParticipationPct(raw.participationPct);
        if (participationPct === null) throw Errors.validation("participationPct requerido para un socio: porcentaje de 0 a 100 con hasta dos decimales.");
        assertParticipationFits(await repo.listCompanyStakeholders(org), null, participationPct);
      } else if (raw.participationPct !== undefined && raw.participationPct !== null) {
        throw Errors.validation("participationPct: un representante no tiene participación accionaria.");
      }
      return { kind, fullName: boundedRequired(raw.fullName, "fullName", 300), rfc, participationPct };
    },
    parsePatch: async (raw, { repo, org, id }) => {
      const actual = (await repo.listCompanyStakeholders(org)).find((s) => s.id === id);
      const rfc = parseTaxId(raw.rfc, "rfc");
      let participationPct: string | null | undefined;
      if (raw.participationPct !== undefined) {
        if (raw.participationPct === null) {
          if (actual?.kind === "socio") throw Errors.validation("participationPct: un socio siempre declara su porcentaje.");
          participationPct = null;
        } else {
          if (actual && actual.kind !== "socio") throw Errors.validation("participationPct: un representante no tiene participación accionaria.");
          const normalized = normalizeParticipationPct(raw.participationPct);
          if (normalized === null) throw Errors.validation("participationPct: porcentaje de 0 a 100 con hasta dos decimales.");
          assertParticipationFits(await repo.listCompanyStakeholders(org), id, normalized);
          participationPct = normalized;
        }
      }
      return {
        ...(raw.fullName !== undefined ? { fullName: boundedRequired(raw.fullName, "fullName", 300) } : {}),
        ...(rfc !== undefined ? { rfc } : {}),
        ...(participationPct !== undefined ? { participationPct } : {}),
      };
    },
  });

  return app;
}
