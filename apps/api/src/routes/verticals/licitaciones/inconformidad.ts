// Fase 6 pieza 3 (REQ-053) — licitacionesInconformidadRoutes: redactor de
// inconformidades. Genera un BORRADOR estructurado (hechos/agravios/
// fundamentos/pruebas/plazo) -- este módulo JAMÁS presenta nada ante
// ninguna autoridad (no hay cliente HTTP saliente en ningún archivo de esta
// pieza). El plazo se calcula con el motor determinista de
// `business-days.ts` (Art. 95 LAASSP), nunca con un LLM.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { WRITE_ROLES, INCONFORMIDAD_REVIEW_ROLES, PlazoRegimenNoVerificableError, calendarioAvisos, isValidDateOnly, resolveRegimenLegal } from "@atiende/domain-licitaciones";
import type { InconformidadDraftRecord } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveCalendarioFor } from "./calendario.ts";

/** Reagrupa los campos de plazo (planos en el repositorio) bajo `plazo`, mismo contrato de API que el repo original (`mapDraftRow`). */
function mapDraft(record: InconformidadDraftRecord) {
  return {
    id: record.id,
    tenderId: record.tenderId,
    version: record.version,
    status: record.status,
    contentHash: record.contentHash,
    hechos: record.hechos,
    agravios: record.agravios,
    pruebas: record.pruebas,
    fundamentos: record.fundamentos,
    plazo: {
      diasHabiles: record.businessDays,
      fechaNotificacionFallo: record.falloNotifiedOn,
      fechaLimite: record.dueDate,
      fundamentoLegal: record.legalReference,
      bajoTratados: record.bajoTratados,
    },
    viability: record.viability,
    viabilityRecommendation: record.viabilityRecommendation,
    disclaimer: record.disclaimer,
    reviewedBy: record.reviewedBy,
    reviewedAt: record.reviewedAt,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
  };
}

interface InconformidadGenerateBody {
  readonly hechos?: unknown;
  readonly agravios?: unknown;
  readonly pruebas?: unknown;
  readonly falloNotifiedOn?: unknown;
  readonly bajoTratados?: unknown;
  /** L-23: fecha de publicacion de la convocatoria ("YYYY-MM-DD"); con una anterior al 2025-04-17 el borrador se niega (plazo del regimen abrogado sin verificar). Opcional. */
  readonly convocatoriaPublicadaEn?: unknown;
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `undefined`/`null`/"" = no declarada; cualquier otra cosa debe ser una fecha real "YYYY-MM-DD". */
function parseConvocatoriaPublicadaEn(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !isValidDateOnly(raw)) throw Errors.validation('convocatoriaPublicadaEn: se esperaba una fecha real "YYYY-MM-DD".');
  return raw;
}

function parseStringArray(raw: unknown, field: string, { minLength = 0 }: { minLength?: number } = {}): string[] {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === "string" && v.trim().length > 0)) {
    throw Errors.validation(`${field}: se esperaba un arreglo de cadenas no vacías.`);
  }
  if (raw.length < minLength) throw Errors.validation(`${field}: se requiere al menos ${minLength} elemento(s).`);
  return raw as string[];
}

export function licitacionesInconformidadRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/tenders/:tenderId/inconformidad";
  const markReviewedBase = "/licitaciones/:propertyId/tenders/:tenderId/inconformidad/:id/mark-reviewed";

  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(markReviewedBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    const raw = await readJsonCapped<InconformidadGenerateBody>(c.req.raw, 64 * 1024);

    const hechos = parseStringArray(raw.hechos, "hechos", { minLength: 1 });
    const agravios = parseStringArray(raw.agravios, "agravios", { minLength: 1 });
    const pruebas = raw.pruebas === undefined ? [] : parseStringArray(raw.pruebas, "pruebas");
    if (typeof raw.falloNotifiedOn !== "string" || !DATE_ONLY_PATTERN.test(raw.falloNotifiedOn)) {
      throw Errors.validation('falloNotifiedOn: se esperaba "YYYY-MM-DD".');
    }
    if (typeof raw.bajoTratados !== "boolean") throw Errors.validation("bajoTratados: se esperaba un booleano.");
    const convocatoriaPublicadaEn = parseConvocatoriaPublicadaEn(raw.convocatoriaPublicadaEn);

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");

    // L-22: el plazo del art. 95 se cuenta con el calendario efectivo (oficiales + organizacion + convocatoria).
    const calendario = await resolveCalendarioFor(deps, c, tenderId);
    let draft: InconformidadDraftRecord;
    try {
      draft = await repo.createInconformidadDraft(organizationId, tenderId, {
        hechos,
        agravios,
        pruebas,
        falloNotifiedOn: raw.falloNotifiedOn,
        bajoTratados: raw.bajoTratados,
        actorId,
        calendario,
        convocatoriaPublicadaEn,
      });
    } catch (err) {
      // L-23: el regimen abrogado no tiene plazo verificado; se niega con 422 en vez de inventar una fecha limite.
      if (err instanceof PlazoRegimenNoVerificableError) throw Errors.plazoRegimenNoVerificable(err.message);
      throw err;
    }
    return c.json({ ...mapDraft(draft), regimenLegal: resolveRegimenLegal(convocatoriaPublicadaEn), calendario: { nota: calendario.note, avisos: calendarioAvisos(calendario, raw.falloNotifiedOn, draft.dueDate) } }, 201);
  });

  app.get(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const drafts = await repo.listInconformidadDrafts(organizationId, tenderId);
    return c.json({ drafts: drafts.map(mapDraft) });
  });

  // REQ-053: marcar como "revisado por abogado" -- solo owner/admin/reviewer
  // (INCONFORMIDAD_REVIEW_ROLES), distinto de WRITE_ROLES (certificar la
  // revisión legal es un rol distinto de redactar el borrador).
  app.post(markReviewedBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, INCONFORMIDAD_REVIEW_ROLES);
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    const draftId = c.req.param("id");

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");

    try {
      const draft = await repo.markInconformidadReviewed(organizationId, tenderId, draftId, actorId);
      return c.json(mapDraft(draft));
    } catch (err) {
      const message = err instanceof Error ? err.message : "No se pudo marcar el borrador como revisado.";
      if (message.includes("ya fue marcado")) throw Errors.conflict(message);
      throw Errors.notFound(message);
    }
  });

  return app;
}
