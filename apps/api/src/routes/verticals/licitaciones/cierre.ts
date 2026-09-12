// L3 · Flujo 3 — licitacionesCierreRoutes: ensamblado del paquete de envío,
// descarga y declaración de presentación. Port ~directo de
// licitaciones/apps/api/src/modules/expediente/{package,submission}.routes.ts
// (ver diseño Fase 1 licitaciones §4.3). El flujo de mayor riesgo real de
// todo el repo origen: un badge "ready" mentiroso puede llevar a que un
// humano presente ante un ente público un expediente incompleto (AE-14).
//
// "ready" se DERIVA SIEMPRE dentro de `PackageAssembler`, nunca se declara
// desde esta ruta (mismo principio que hoteles/quotes.ts con el precio).
// `GET /latest`/`GET /download` NUNCA sirven el `status` guardado a secas
// cuando ese estado guardado era "ready": recalculan el manifiesto contra el
// estado vivo, y `download` responde 409 explícito si el "ready" guardado ya
// no lo es (REQ-LIC-009).
//
// `POST .../expediente/approval` (DECISION_ROLES) sigue siendo el único gate
// que hace posible llegar a "ready": acotado a DECISION_ROLES (owner/admin/
// analyst — nunca writer/reviewer solos, ver roles.ts), siempre recalculando
// el hash de insumos ACTUAL antes de aprobar (nunca un hash que el cliente
// proponga). Fase 2 pieza 1 (AE-02/AE-11, ver
// domain-licitaciones/src/approval-workflow.ts) refuerza su lógica interna
// sin cambiar la superficie pública, y añade
// `POST .../proposal/sections/:sectionKey/approval` para revisión granular
// incremental por sección.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  ApprovalRejectedError,
  DECISION_ROLES,
  IdempotencyConflictError,
  PackageAssembler,
  WRITE_ROLES,
  decodeBase64Content,
  sealInputs,
} from "@atiende/domain-licitaciones";
import type { AssembleInput, ChecklistReport, ExpedienteInputs, PackageDocumentInput } from "@atiende/domain-licitaciones";
import type { Approval, LicitacionesRepository, LicitacionesRole } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

function overallStatusOf(items: readonly { result: "verde" | "ambar" | "rojo" }[]): "verde" | "ambar" | "rojo" {
  if (items.some((i) => i.result === "rojo")) return "rojo";
  if (items.some((i) => i.result === "ambar")) return "ambar";
  return "verde";
}

/**
 * Fase 2 pieza 1: traduce el vocabulario de `ApprovalWorkflow.approve()`
 * (`ApprovalRejectedError.reasonCode`) a un código HTTP -- rol no autorizado
 * o autoaprobación (incluida AE-11) son un 403 explícito (el actor está
 * identificado y autenticado, pero esta acción en particular le está
 * vedada); una inconsistencia scope/scopeRef (AE-02) es un 400 de
 * validación, nunca un 500 genérico.
 */
function mapApprovalRejectedError(err: unknown): Error {
  if (!(err instanceof ApprovalRejectedError)) return err instanceof Error ? err : new Error(String(err));
  if (err.reasonCode === "scope_scopeRef_inconsistente") return Errors.validation(err.message);
  return Errors.forbidden(err.message);
}

interface CierreContext {
  readonly organizationId: string;
  readonly tenderId: string;
  readonly proposalId: string;
  readonly correlationId: string | null;
}

/** Reconstruye el `AssembleInput` completo contra el estado VIVO del expediente — usado tanto por `assemble` como por la re-derivación de `latest`/`download` (AE-14), para que ambos caminos apliquen exactamente la misma lógica. */
async function buildAssembleInput(repo: LicitacionesRepository, ctx: CierreContext): Promise<AssembleInput> {
  const sections = await repo.loadProposalSectionsAsDocuments(ctx.organizationId, ctx.proposalId);
  const documents: PackageDocumentInput[] = sections.map((s) => {
    // Una sección (económica o técnica, Fase 2 pieza 3) cuyo contenido
    // arranca con "PENDIENTE" -- porque `TechnicalProposalBuilder` encontró
    // algún bloqueo (dato faltante/no aprobado, requisito en conflicto) o
    // porque nunca se generó -- se trata como documento "no presente" para
    // el manifiesto, nunca se incluye a medias.
    const blocked = s.content !== undefined && s.content.startsWith("PENDIENTE");
    return { documentId: s.documentId, label: s.label, required: true, filename: s.filename, version: s.version, content: blocked ? undefined : s.content };
  });

  const complianceItems = await repo.listComplianceItems(ctx.organizationId, ctx.proposalId);
  const checklist: ChecklistReport = {
    items: complianceItems.map((ci) => ({ dimension: ci.dimension as ChecklistReport["items"][number]["dimension"], status: ci.result, detail: ci.notes, evidence: ci.evidenceRef ? ci.evidenceRef.split(", ").filter(Boolean) : [] })),
    // Mismo criterio que el origen (loadChecklistReport): un checklist que
    // NUNCA corrió (0 items) es "rojo", no "verde" trivial -- nunca se debe
    // poder ensamblar "ready" sin haber corrido el checklist ni una vez.
    overallStatus: complianceItems.length === 0 ? "rojo" : overallStatusOf(complianceItems),
  };

  const { hash, raw } = await repo.computeCurrentInputsHash(ctx.organizationId, ctx.tenderId, ctx.proposalId);
  const sealed = sealInputs(raw as ExpedienteInputs);
  if (sealed.hash !== hash) {
    // Defensa en profundidad: si el repositorio alguna vez devolviera un
    // `raw` que no reproduce su propio `hash` anunciado, fail-closed aquí en
    // vez de seguir con un sellado potencialmente inconsistente.
    throw new Error("computeCurrentInputsHash: el hash devuelto no coincide con el recalculado a partir de 'raw'.");
  }

  // Fase 2 piezas 1+2 (AE-02/AE-11 + ProposalVersionRegistry, ver diseño
  // §3.2): mismo choke point que el resto de AE-14 en este archivo -- antes
  // de derivar `approvals`, sincroniza el historial de versiones y, si la
  // aprobación vigente de alcance "expediente" ya no coincide con el hash
  // actual, la invalida explícitamente con un motivo que nombra los insumos
  // que cambiaron (en vez de dejar una fila "vigente" obsoleta en la BD que
  // solo `PackageAssembler` filtraría en memoria).
  await repo.syncExpedienteApprovalWithCurrentHash(ctx.organizationId, ctx.proposalId, sealed, raw as ExpedienteInputs);

  const approvals: Approval[] = [...(await repo.activeApprovalsCovering(ctx.organizationId, ctx.proposalId, "expediente"))];

  // Fase 2 pieza 3: requisitos opcionales/condicionales que
  // `TechnicalProposalBuilder` marcó explícitamente "NO APLICA" (nunca
  // omitidos en silencio) -- se reflejan también en el manifiesto final.
  const proposal = await repo.findProposal(ctx.organizationId, ctx.tenderId);
  const notApplicableRequirements = proposal?.generationReport?.technical?.notApplicableRequirements ?? [];

  return { expedienteId: ctx.proposalId, documents, checklist, approvals, currentInputsHash: sealed, correlationId: ctx.correlationId, notApplicableRequirements };
}

export function licitacionesCierreRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const propertyBase = "/licitaciones/:propertyId/tenders/:tenderId";

  app.use(`${propertyBase}/package/assemble`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${propertyBase}/package/latest`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${propertyBase}/package/download`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${propertyBase}/submission`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${propertyBase}/submission/declare`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${propertyBase}/expediente/approval`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${propertyBase}/proposal/sections/:sectionKey/approval`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(`${propertyBase}/expediente/approval`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, DECISION_ROLES);
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    // assertVerticalRole(c, DECISION_ROLES) arriba ya garantiza en runtime
    // que este valor pertenece a DECISION_ROLES (subconjunto de LicitacionesRole).
    const verticalRole = c.get("verticalRole")! as LicitacionesRole;
    const tenderId = c.req.param("tenderId");

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const proposal = await repo.findProposal(organizationId, tenderId);
    if (!proposal) throw Errors.notFound("Genere primero la propuesta antes de aprobar el expediente.");

    // El hash de insumos SIEMPRE se recalcula aquí, en vivo -- nunca se
    // acepta uno que el cliente proponga (mismo principio que el resto del
    // Flujo 3: nada de lo que decide "aprobado" viene del request).
    const { raw } = await repo.computeCurrentInputsHash(organizationId, tenderId, proposal.id);
    const sealed = sealInputs(raw as ExpedienteInputs);
    try {
      // Fase 2 pieza 1 (AE-02/AE-11): reemplaza al `approveExpediente` plano
      // de Fase 1 -- misma superficie pública, lógica interna reforzada
      // (rechaza autoaprobación de quien es autor de contenido de CUALQUIER
      // sección, ver approval-workflow.ts).
      const approval = await repo.approve(organizationId, proposal.id, { scope: "expediente", scopeRef: "expediente", actorId: userId, actorRole: verticalRole, inputsHash: sealed });
      return c.json({ id: approval.id, scope: approval.scope, scopeRef: approval.scopeRef, status: approval.status, inputsHash: approval.inputsHash, decidedAt: approval.approvedAt }, 201);
    } catch (err) {
      throw mapApprovalRejectedError(err);
    }
  });

  // Fase 2 pieza 1: revisión granular incremental por sección (scope
  // "seccion") -- útil sobre todo una vez exista contenido técnico real
  // (Pieza 3). Mismas DECISION_ROLES que aprobar el expediente completo:
  // aprobar CUALQUIER alcance es una decisión, nunca redacción.
  app.post(`${propertyBase}/proposal/sections/:sectionKey/approval`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, DECISION_ROLES);
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    // assertVerticalRole(c, DECISION_ROLES) arriba ya garantiza en runtime
    // que este valor pertenece a DECISION_ROLES (subconjunto de LicitacionesRole).
    const verticalRole = c.get("verticalRole")! as LicitacionesRole;
    const tenderId = c.req.param("tenderId");
    const sectionKey = c.req.param("sectionKey");

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const proposal = await repo.findProposal(organizationId, tenderId);
    if (!proposal) throw Errors.notFound("Genere primero la propuesta antes de aprobar una sección.");

    const { raw } = await repo.computeCurrentInputsHash(organizationId, tenderId, proposal.id);
    const sealed = sealInputs(raw as ExpedienteInputs);
    try {
      const approval = await repo.approve(organizationId, proposal.id, { scope: "seccion", scopeRef: `seccion:${sectionKey}`, actorId: userId, actorRole: verticalRole, inputsHash: sealed });
      return c.json({ id: approval.id, scope: approval.scope, scopeRef: approval.scopeRef, status: approval.status, inputsHash: approval.inputsHash, decidedAt: approval.approvedAt }, 201);
    } catch (err) {
      throw mapApprovalRejectedError(err);
    }
  });

  app.post(`${propertyBase}/package/assemble`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const requestId = c.get("requestId");
    const tenderId = c.req.param("tenderId");

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const proposal = await repo.findProposal(organizationId, tenderId);
    if (!proposal) throw Errors.notFound("Genere primero la propuesta antes de ensamblar el paquete.");

    try {
      const result = await repo.withIdempotency({ organizationId, scope: "package.assemble", key: idempotencyKey, body: { proposalId: proposal.id } }, async () => {
        const input = await buildAssembleInput(repo, { organizationId, tenderId, proposalId: proposal.id, correlationId: requestId ?? null });
        const assembled = await new PackageAssembler().assemble(input);

        const storageRef = await repo.writeManifestZip(organizationId, proposal.id, assembled.zip);
        await repo.saveManifest(organizationId, proposal.id, {
          status: assembled.manifest.status,
          manifest: assembled.manifest,
          checklistSnapshot: assembled.manifest.checklist,
          storageRef,
          inputsHash: input.currentInputsHash.hash,
          correlationId: requestId ?? null,
          generatedBy: userId,
        });

        return { status: 200, body: { id: assembled.manifest.expedienteId, status: assembled.manifest.status, draftReasons: assembled.manifest.draftReasons, missing: assembled.manifest.missing, generatedAt: assembled.manifest.generatedAt, notice: assembled.manifest.notice } };
      });
      return c.json(result.body, result.status as 200);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      throw err;
    }
  });

  app.get(`${propertyBase}/package/latest`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const proposal = await repo.findProposal(organizationId, tenderId);
    if (!proposal) throw Errors.notFound("No se ha generado ningún paquete todavía para este expediente.");

    const stored = await repo.findLatestManifest(organizationId, proposal.id);
    if (!stored) throw Errors.notFound("No se ha generado ningún paquete todavía para este expediente.");

    if (stored.status !== "ready") {
      // AE-14: un paquete que ya nació "draft" (nunca llegó a "ready") sigue
      // reportando su propio draftReasons/missing guardados, sin recalcular
      // -- solo importa re-derivar cuando el último assemble había quedado
      // "ready" (ver rama de abajo).
      const snapshot = stored.manifest as { draftReasons?: string[]; missing?: string[]; notice?: string };
      return c.json({ id: proposal.id, status: "draft" as const, draftReasons: snapshot.draftReasons ?? [], missing: snapshot.missing ?? [], generatedAt: stored.generatedAt, notice: snapshot.notice ?? "" });
    }

    // AE-14: el manifiesto guardado ERA "ready" -- se recalcula contra el
    // estado VIVO (sin volver a escribir el ZIP) y se reporta SIEMPRE el
    // estado recién derivado, nunca el guardado a secas.
    const fresh = new PackageAssembler().buildManifest(await buildAssembleInput(repo, { organizationId, tenderId, proposalId: proposal.id, correlationId: null }));
    return c.json({ id: proposal.id, status: fresh.status, draftReasons: fresh.draftReasons, missing: fresh.missing, generatedAt: stored.generatedAt, notice: fresh.notice });
  });

  app.get(`${propertyBase}/package/download`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const proposal = await repo.findProposal(organizationId, tenderId);
    if (!proposal) throw Errors.notFound("No se ha generado ningún paquete descargable todavía.");

    const stored = await repo.findLatestManifest(organizationId, proposal.id);
    if (!stored || !stored.storageRef) throw Errors.notFound("No se ha generado ningún paquete descargable todavía.");

    if (stored.status === "ready") {
      // REQ-LIC-009/AE-14: nunca se sirve un ZIP "ready" viejo si la
      // re-derivación en vivo ya no lo es (p. ej. la aprobación se invalidó
      // por un cambio de tarifa después de ensamblar).
      const fresh = new PackageAssembler().buildManifest(await buildAssembleInput(repo, { organizationId, tenderId, proposalId: proposal.id, correlationId: null }));
      if (fresh.status !== "ready") {
        // REQ-LIC-009/AE-14: 409 explícito, con los motivos ya derivados --
        // nunca se sirve el ZIP viejo como si siguiera vigente.
        return c.json(
          {
            code: "conflict",
            message: "El paquete generado quedó desactualizado (la aprobación vigente ya no cubre el estado actual del expediente, o el checklist dejó de estar en verde). Vuelve a ejecutar POST /package/assemble.",
            draftReasons: fresh.draftReasons,
            missing: fresh.missing,
          },
          409,
        );
      }
    }

    const bytes = await repo.readManifestZip(stored.storageRef);
    return new Response(bytes, { status: 200, headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="expediente-${proposal.id}.zip"` } });
  });

  app.get(`${propertyBase}/submission`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const proposal = await repo.findProposal(organizationId, tenderId);
    if (!proposal) return c.json(null);

    const submission = await repo.findSubmission(organizationId, proposal.id);
    return c.json(submission ?? null);
  });

  app.post(`${propertyBase}/submission/declare`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    const raw = await readJsonCapped<{ submittedAt?: unknown; acknowledgementContentBase64?: unknown; notes?: unknown }>(c.req.raw, 30 * 1024 * 1024);

    if (typeof raw.submittedAt !== "string" || raw.submittedAt.trim().length === 0) throw Errors.validation("submittedAt requerido (ISO 8601).");
    if (Number.isNaN(new Date(raw.submittedAt).getTime())) throw Errors.validation("submittedAt: fecha inválida.");
    const notes = raw.notes === undefined || raw.notes === null ? null : typeof raw.notes === "string" ? raw.notes.slice(0, 2000) : (() => { throw Errors.validation("notes: se esperaba texto."); })();
    const acknowledgementContentBase64 = raw.acknowledgementContentBase64 === undefined || raw.acknowledgementContentBase64 === null ? null : typeof raw.acknowledgementContentBase64 === "string" ? raw.acknowledgementContentBase64 : (() => { throw Errors.validation("acknowledgementContentBase64: se esperaba texto base64."); })();

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const proposal = await repo.findProposal(organizationId, tenderId);
    if (!proposal) throw Errors.notFound("Genere primero la propuesta antes de declarar la presentación.");

    // REQ-LIC-011: ningún cliente HTTP saliente en este handler -- el sistema
    // NUNCA envía nada a un portal externo, solo registra la declaración del
    // usuario. Tampoco se agrega ningún bloqueo por fecha aquí (ver diseño
    // §0 fila 5): un envío tardío real sigue siendo un hecho que el usuario
    // necesita poder declarar para efectos de auditoría posterior.
    try {
      const result = await repo.withIdempotency({ organizationId, scope: "submission.declare", key: idempotencyKey, body: { submittedAt: raw.submittedAt, notes, hasAcknowledgement: acknowledgementContentBase64 !== null } }, async () => {
        let acknowledgementStorageRef: string | null = null;
        let acknowledgementFileHash: string | null = null;
        if (acknowledgementContentBase64) {
          const buffer = decodeBase64Content(acknowledgementContentBase64);
          const stored = await repo.storeAcknowledgement(organizationId, buffer);
          acknowledgementStorageRef = stored.storageRef;
          acknowledgementFileHash = stored.sha256;
        }

        const submission = await repo.declareSubmission(organizationId, proposal.id, {
          userId,
          submittedAt: raw.submittedAt as string,
          acknowledgementStorageRef,
          acknowledgementFileHash,
          notes,
        });

        return { status: 201, body: submission };
      });
      return c.json(result.body, result.status as 201);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      throw err;
    }
  });

  return app;
}

// NOTA REQ-LIC-011 (verificable estáticamente, mismo patrón que el test
// api-surface del origen, ver docs de este módulo más arriba): este archivo
// no importa 'http', 'https', 'node:http', 'node:https', 'undici' ni ninguna
// librería de cliente HTTP saliente. La única red que toca esta ruta es la
// que Hono expone hacia adentro (peticiones entrantes), nunca hacia un
// portal de licitaciones.
export const NO_OUTBOUND_HTTP_CLIENT_IN_THIS_MODULE = true;
