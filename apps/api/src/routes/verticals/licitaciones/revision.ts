// paridad3 (L-P3-07) -- revision del expediente con comentarios y editor humano de secciones. Rutas bajo
// /licitaciones/:propertyId/tenders/:tenderId/proposal:
//
//   GET   sections                     secciones con su contenido, version, si estan aprobadas y si QUIEN CONSULTA es autor (no puede aprobar, AE-11).
//   PATCH sections/:sectionKey (WRITE) edicion humana: registra la autoria (section_author); si el texto cambio invalida las aprobaciones
//                                      vigentes de esa seccion y del expediente (AE-02); el mismo texto no invalida nada.
//   GET   comments                     hilo de revision (solo de adicion): autor (nombre y rol) y alcance.
//   POST  comments             (WRITE) agrega un comentario al expediente o a una seccion.
//   POST  request-review (SUBMITTER)   pide la revision de un alcance: queda como solicitud en el hilo (quien la pide no puede aprobar ese
//                                      alcance) y avisa a los revisores por la campana.
//
// Base sin la migracion 037: las lecturas devuelven `disponible: false`; comentar/pedir revision responde 503 honesto.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { ApprovalRejectedError, ApprovalWorkflow, BovedaRevisionNoDisponibleError, WRITE_ROLES } from "@atiende/domain-licitaciones";
import type { LicitacionesRepository, LicitacionesRole, ProposalCommentScope } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { avisarAprobacionInvalidada, avisarRevisionSolicitada } from "./avisos-revision.ts";

const MAX_SECTION_CONTENT = 200_000;
const MAX_COMMENT = 4_000;
const SECTION_KEY_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

async function requireProposal(repo: LicitacionesRepository, organizationId: string, tenderId: string) {
  if (!(await repo.findTender(organizationId, tenderId))) throw Errors.notFound("Convocatoria no encontrada.");
  const proposal = await repo.findProposal(organizationId, tenderId);
  if (!proposal) throw Errors.notFound("Genere primero la propuesta antes de revisarla.");
  return proposal;
}

function parseScope(raw: Record<string, unknown>): { scope: ProposalCommentScope; scopeRef: string; sectionKey: string | null } {
  const scope = raw.scope === undefined ? "expediente" : raw.scope;
  if (scope === "expediente") return { scope, scopeRef: "expediente", sectionKey: null };
  if (scope !== "seccion") throw Errors.validation('scope: se esperaba "expediente" | "seccion".');
  if (typeof raw.sectionKey !== "string" || !SECTION_KEY_RE.test(raw.sectionKey)) throw Errors.validation("sectionKey: se esperaba la clave de una sección.");
  return { scope, scopeRef: `seccion:${raw.sectionKey}`, sectionKey: raw.sectionKey };
}

function parseBody(raw: unknown, required: boolean): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (required && text.length === 0) throw Errors.validation("body: escribe el comentario.");
  if (text.length > MAX_COMMENT) throw Errors.validation(`body: máximo ${MAX_COMMENT} caracteres.`);
  return text;
}

export function licitacionesRevisionRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/tenders/:tenderId/proposal";
  const mw = [authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId")] as const;
  app.on("GET", `${base}/sections`, ...mw);
  app.on("PATCH", `${base}/sections/:sectionKey`, ...mw);
  app.on(["GET", "POST"], `${base}/comments`, ...mw);
  app.on("POST", `${base}/request-review`, ...mw);

  app.get(`${base}/sections`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const proposal = await requireProposal(repo, organizationId, c.req.param("tenderId"));
    const sections = await repo.listProposalSections(organizationId, proposal.id, c.get("userId"));
    const withApproval = await Promise.all(
      sections.map(async (s) => {
        const covering = await repo.activeApprovalsCovering(organizationId, proposal.id, `seccion:${s.sectionKey}`);
        return { ...s, approved: covering.some((a) => a.scopeRef === `seccion:${s.sectionKey}`), expedienteApproved: covering.some((a) => a.scopeRef === "expediente") };
      }),
    );
    return c.json({ sections: withApproval });
  });

  app.patch(`${base}/sections/:sectionKey`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    const sectionKey = c.req.param("sectionKey");
    if (!SECTION_KEY_RE.test(sectionKey)) throw Errors.notFound("Sección no encontrada.");
    const raw = await readJsonCapped<{ content?: unknown }>(c.req.raw, 400 * 1024);
    if (typeof raw.content !== "string" || raw.content.trim().length === 0) throw Errors.validation("content: el contenido de la sección no puede quedar vacío.");
    if (raw.content.length > MAX_SECTION_CONTENT) throw Errors.validation(`content: máximo ${MAX_SECTION_CONTENT} caracteres.`);
    const proposal = await requireProposal(repo, organizationId, tenderId);
    const result = await repo.editProposalSection(organizationId, proposal.id, sectionKey, { content: raw.content, actorId: userId });
    if (!result) throw Errors.notFound("Sección no encontrada.");
    const invalidatedApprovals = result.invalidated?.invalidatedApprovalIds.length ?? 0;
    if (result.changed) {
      await repo.recordTenderAuditEvent(organizationId, tenderId, "section.edited", userId);
      if (invalidatedApprovals > 0) await avisarAprobacionInvalidada(c.get("db"), { organizationId, proposalId: proposal.id, tenderId, sectionKey, version: result.section.version });
    }
    return c.json({ section: result.section, changed: result.changed, invalidatedApprovals });
  });

  app.get(`${base}/comments`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const proposal = await requireProposal(repo, organizationId, c.req.param("tenderId"));
    const { disponible, comments } = await repo.listProposalComments(organizationId, proposal.id);
    const assignees = await repo.listRequirementAssignees(organizationId);
    const names = new Map(assignees.map((a) => [a.userId, a.nombre]));
    return c.json({
      disponible,
      comments: comments.map(({ authorId, ...rest }) => ({ ...rest, esTuyo: authorId === userId, authorName: names.get(authorId) ?? null })),
    });
  });

  app.post(`${base}/comments`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 16 * 1024);
    const { scope, scopeRef } = parseScope(raw);
    const body = parseBody(raw.body, true);
    const proposal = await requireProposal(repo, organizationId, c.req.param("tenderId"));
    try {
      const comment = await repo.addProposalComment(organizationId, proposal.id, { scope, scopeRef, kind: "comentario", body, authorId: userId, authorRole: String(c.get("verticalRole")) });
      const { authorId, ...rest } = comment;
      return c.json({ comment: { ...rest, esTuyo: authorId === userId } }, 201);
    } catch (err) {
      if (err instanceof BovedaRevisionNoDisponibleError) throw Errors.licitacionesBovedaNoDisponible(err.funcion);
      throw err;
    }
  });

  app.post(`${base}/request-review`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    const verticalRole = c.get("verticalRole")! as LicitacionesRole;
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 16 * 1024);
    const { scope, scopeRef } = parseScope(raw);
    const note = parseBody(raw.note, false);
    const proposal = await requireProposal(repo, organizationId, tenderId);
    // La regla de quien puede pedir revision vive en ApprovalWorkflow (SUBMITTER_ROLES): no se reescribe aqui.
    try {
      new ApprovalWorkflow().requestReview({ scopeRef, actorId: userId, actorRole: verticalRole });
    } catch (err) {
      if (err instanceof ApprovalRejectedError) throw Errors.forbidden(err.message);
      throw err;
    }
    try {
      const comment = await repo.addProposalComment(organizationId, proposal.id, {
        scope,
        scopeRef,
        kind: "solicitud_revision",
        body: note.length > 0 ? note : scope === "expediente" ? "Se solicitó la revisión del expediente." : "Se solicitó la revisión de una sección.",
        authorId: userId,
        authorRole: verticalRole,
      });
      await avisarRevisionSolicitada(c.get("db"), { organizationId, proposalId: proposal.id, requestId: comment.id, tenderId });
      const { authorId, ...rest } = comment;
      return c.json({ comment: { ...rest, esTuyo: authorId === userId } }, 201);
    } catch (err) {
      if (err instanceof BovedaRevisionNoDisponibleError) throw Errors.licitacionesBovedaNoDisponible(err.funcion);
      throw err;
    }
  });

  return app;
}
