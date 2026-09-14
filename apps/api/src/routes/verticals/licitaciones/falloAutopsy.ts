// Fase 6 pieza 4 (REQ-054) — licitacionesFalloAutopsyRoutes: autopsia del
// fallo -- informe estructurado comparando la propuesta propia contra el
// fallo, y lecciones aprendidas vinculadas al perfil de empresa (org-wide).
// REQ-054 explícito: "sin inventar datos ausentes -> 'no disponible'" -- ver
// `fallo-autopsy.ts::normalizeOrNoDisponible`, aplicado dentro del
// repositorio (nunca en esta ruta, para que ningún otro camino de escritura
// futuro se salte la normalización).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { WRITE_ROLES, isOwnProposalStatus, sanitizeCriteriaComparison } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface FalloAutopsyCreateBody {
  readonly ownProposalStatus?: unknown;
  readonly disqualificationReason?: unknown;
  readonly ownScore?: unknown;
  readonly winnerScore?: unknown;
  readonly ownPrice?: unknown;
  readonly winnerPrice?: unknown;
  readonly winnerName?: unknown;
  readonly criteriaComparison?: unknown;
  readonly lessons?: unknown;
}

function parseOptionalNonNegativeNumber(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) throw Errors.validation(`${field}: se esperaba un número >= 0.`);
  return raw;
}

function parseOptionalString(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw Errors.validation(`${field}: se esperaba una cadena.`);
  return raw;
}

export function licitacionesFalloAutopsyRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/tenders/:tenderId/fallo-autopsy";
  const lessonsBase = "/licitaciones/:propertyId/lessons-learned";

  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(lessonsBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    const raw = await readJsonCapped<FalloAutopsyCreateBody>(c.req.raw, 64 * 1024);

    if (typeof raw.ownProposalStatus !== "string" || !isOwnProposalStatus(raw.ownProposalStatus)) {
      throw Errors.validation('ownProposalStatus: se esperaba "ganadora" | "desechada" | "no_presentada" | "desconocido".');
    }
    const disqualificationReason = parseOptionalString(raw.disqualificationReason, "disqualificationReason");
    const winnerName = parseOptionalString(raw.winnerName, "winnerName");
    const ownScore = parseOptionalNonNegativeNumber(raw.ownScore, "ownScore");
    const winnerScore = parseOptionalNonNegativeNumber(raw.winnerScore, "winnerScore");
    const ownPrice = parseOptionalNonNegativeNumber(raw.ownPrice, "ownPrice");
    const winnerPrice = parseOptionalNonNegativeNumber(raw.winnerPrice, "winnerPrice");
    const criteriaComparison = raw.criteriaComparison === undefined ? [] : sanitizeCriteriaComparison(Array.isArray(raw.criteriaComparison) ? raw.criteriaComparison : []);
    const lessons = raw.lessons === undefined ? [] : raw.lessons;
    if (!Array.isArray(lessons) || !lessons.every((l) => typeof l === "string" && l.trim().length > 0)) {
      throw Errors.validation("lessons: se esperaba un arreglo de cadenas no vacías.");
    }

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");

    const { autopsy, lessons: lessonRecords } = await repo.createFalloAutopsy(organizationId, tenderId, {
      ownProposalStatus: raw.ownProposalStatus,
      disqualificationReason,
      ownScore,
      winnerScore,
      ownPrice,
      winnerPrice,
      winnerName,
      criteriaComparison,
      lessons: lessons as string[],
      actorId,
    });
    return c.json({ ...autopsy, lessons: lessonRecords }, 201);
  });

  app.get(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const autopsies = await repo.listFalloAutopsies(organizationId, tenderId);
    return c.json({ autopsies });
  });

  // REQ-054: lecciones vinculadas al PERFIL DE EMPRESA, consultables
  // org-wide (todas las convocatorias), no solo por tender.
  app.get(lessonsBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const lessons = await repo.listLessonsLearned(organizationId);
    return c.json({ lessons });
  });

  return app;
}
