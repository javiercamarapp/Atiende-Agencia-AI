// paridad3 L-P3-16 -- bandeja de EXPEDIENTES: el estado de cada convocatoria que ya se decidio perseguir (go / en curso / presentada), paso por
// paso: requisitos, redaccion, checklist, aprobacion 1/2 (tecnico-legal), aprobacion 2/2 (economica), paquete y presentacion. SOLO LECTURA:
// no sella ni sincroniza nada (a diferencia de GET .../expediente/approvals, que sincroniza la aprobacion con el sello vigente) y esta
// acotada por pagina (limit maximo 50: cada fila cuesta unas lecturas por convocatoria). Cualquier miembro de la organizacion puede leer.
import { Hono } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { evaluateExpedienteStages, sealInputs } from "@atiende/domain-licitaciones";
import type { ExpedienteInputs, LicitacionesRepository, TenderRecord } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";
import { parseOffset, parsePositiveInt } from "./tender-list-query.ts";

export const EXPEDIENTE_STATUSES = ["go", "in_progress", "submitted"] as const;
const DEFAULT_EXPEDIENTES_LIMIT = 25;
const MAX_EXPEDIENTES_LIMIT = 50;

export type PasoEstado = "hecho" | "pendiente";

export interface ExpedienteFila {
  readonly tenderId: string;
  readonly title: string;
  readonly status: string;
  readonly submissionDeadline: string | null;
  readonly requisitos: { readonly total: number; readonly cumplidos: number };
  readonly redaccion: PasoEstado;
  readonly checklist: "verde" | "ambar" | "rojo" | "sin_correr";
  readonly aprobacion: { readonly modo: "doble" | "legacy" | "sin_propuesta"; readonly tecnicaLegal: boolean; readonly economica: boolean; readonly completa: boolean };
  readonly paquete: boolean;
  readonly presentada: boolean;
}

async function filaDe(repo: LicitacionesRepository, organizationId: string, tender: TenderRecord): Promise<ExpedienteFila> {
  const [items, proposal] = await Promise.all([repo.listRequirementItems(organizationId, tender.id), repo.findProposal(organizationId, tender.id)]);
  const base = {
    tenderId: tender.id,
    title: tender.title,
    status: tender.status ?? "discovered",
    submissionDeadline: tender.submissionDeadline,
    requisitos: { total: items.length, cumplidos: items.filter((i) => i.status === "cumplido").length },
  };
  if (!proposal) {
    return { ...base, redaccion: "pendiente", checklist: "sin_correr", aprobacion: { modo: "sin_propuesta", tecnicaLegal: false, economica: false, completa: false }, paquete: false, presentada: false };
  }
  const [compliance, snapshot, manifest, submission, inputs] = await Promise.all([
    repo.listComplianceItems(organizationId, proposal.id),
    repo.listExpedienteStageApprovals(organizationId, proposal.id),
    repo.findLatestManifest(organizationId, proposal.id),
    repo.findSubmission(organizationId, proposal.id),
    repo.computeCurrentInputsHash(organizationId, tender.id, proposal.id),
  ]);
  const checklist: ExpedienteFila["checklist"] = compliance.length === 0 ? "sin_correr" : compliance.some((i) => i.result === "rojo") ? "rojo" : compliance.some((i) => i.result === "ambar") ? "ambar" : "verde";
  const sealed = sealInputs(inputs.raw as ExpedienteInputs);
  let aprobacion: ExpedienteFila["aprobacion"];
  if (snapshot.mode === "legacy") {
    const unica = snapshot.approvals.some((a) => a.inputsHash === sealed.hash);
    aprobacion = { modo: "legacy", tecnicaLegal: unica, economica: unica, completa: unica };
  } else {
    const evaluation = evaluateExpedienteStages(snapshot.approvals, sealed.hash);
    aprobacion = { modo: "doble", tecnicaLegal: evaluation.tecnicaLegal !== null, economica: evaluation.economica !== null, completa: evaluation.complete };
  }
  return { ...base, redaccion: "hecho", checklist, aprobacion, paquete: manifest !== null, presentada: submission !== null };
}

export function licitacionesExpedientesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/expedientes";
  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const limit = parsePositiveInt(c.req.query("limit"), DEFAULT_EXPEDIENTES_LIMIT, MAX_EXPEDIENTES_LIMIT);
    const offset = parseOffset(c.req.query("offset"));
    const status = c.req.query("status");
    if (status !== undefined && status !== "" && !(EXPEDIENTE_STATUSES as readonly string[]).includes(status)) {
      throw Errors.validation(`status: valor no válido (${EXPEDIENTE_STATUSES.join(", ")}).`);
    }
    const page = await repo.listTendersPage(organizationId, status ? { status, limit, offset } : { inStatuses: EXPEDIENTE_STATUSES, limit, offset });
    const items: ExpedienteFila[] = [];
    for (const tender of page.items) items.push(await filaDe(repo, organizationId, tender));
    c.header("X-Total-Count", String(page.total));
    if (page.nextOffset !== null) c.header("X-Next-Offset", String(page.nextOffset));
    return c.json({ expedientes: items });
  });

  return app;
}
