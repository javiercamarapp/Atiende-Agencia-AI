// Fase 3 pieza 1 — licitacionesTendersRoutes: `POST base/tenders`, alta/
// actualización MANUAL de una convocatoria (ver diseño Fase 3 §6). Sustituye
// (no complementa) la ingesta automática bloqueada por B-02
// (docs/BLOQUEOS.md: ComprasMX/OCDS-SHCP/PDN-S6/portales estatales
// inalcanzables por reCAPTCHA/bot-detection) -- mientras ese bloqueo externo
// siga abierto, este es el ÚNICO camino de escritura productivo para
// `licitaciones.tender` (antes de esta pieza, `LicitacionesRepository` solo
// exponía `findTender`; `seedTender` es exclusivo del repositorio in-memory
// de pruebas).
//
// `source` SIEMPRE se fija en el servidor como "manual" -- el body NUNCA
// puede declarar un `source` distinto (ver `TenderCreateBody` abajo: ni
// siquiera se declara el campo, así que aunque el cliente lo mande se
// ignora), precisamente para que quede trazable qué convocatorias son
// captura manual (todas, mientras B-02 esté abierto) frente a una futura
// ingesta automática que usaría otros valores de `source`.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { WRITE_ROLES, assertExplicitOffset } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface TenderUpsertBody {
  readonly title?: unknown;
  readonly submissionDeadline?: unknown;
  readonly externalId?: unknown;
  readonly contractingBody?: unknown;
  readonly cpvCodes?: unknown;
  readonly budgetAmount?: unknown;
  readonly currency?: unknown;
  readonly state?: unknown;
  readonly procedureTypeRaw?: unknown;
}

function parseOptionalString(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim().length === 0) throw Errors.validation(`${field}: se esperaba una cadena no vacía o ausente.`);
  return raw;
}

function parseCpvCodes(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every((c) => typeof c === "string" && c.length > 0)) throw Errors.validation("cpvCodes: se esperaba un arreglo de strings no vacíos.");
  return raw;
}

function parseOptionalNonNegativeNumber(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) throw Errors.validation(`${field}: se esperaba un número >= 0.`);
  return raw;
}

export function licitacionesTendersRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/tenders";

  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const raw = await readJsonCapped<TenderUpsertBody>(c.req.raw, 64 * 1024);

    if (typeof raw.title !== "string" || raw.title.trim().length === 0) throw Errors.validation("title requerido.");

    let submissionDeadline: string | null = null;
    if (raw.submissionDeadline !== undefined && raw.submissionDeadline !== null) {
      if (typeof raw.submissionDeadline !== "string") throw Errors.validation("submissionDeadline: se esperaba una cadena ISO 8601 con offset explícito.");
      try {
        assertExplicitOffset(raw.submissionDeadline, "submissionDeadline");
      } catch (err) {
        throw Errors.validation(err instanceof Error ? err.message : "submissionDeadline inválido.");
      }
      submissionDeadline = raw.submissionDeadline;
    }

    const externalId = parseOptionalString(raw.externalId, "externalId");
    const contractingBody = parseOptionalString(raw.contractingBody, "contractingBody");
    const cpvCodes = parseCpvCodes(raw.cpvCodes);
    const budgetAmount = parseOptionalNonNegativeNumber(raw.budgetAmount, "budgetAmount");
    const currency = raw.currency === undefined || raw.currency === null ? "MXN" : typeof raw.currency === "string" && raw.currency.length === 3 ? raw.currency : (() => { throw Errors.validation("currency: se esperaba un código de 3 letras (p. ej. \"MXN\")."); })();
    const state = parseOptionalString(raw.state, "state");
    const procedureTypeRaw = parseOptionalString(raw.procedureTypeRaw, "procedureTypeRaw");

    const result = await repo.upsertTenderManual(organizationId, {
      title: raw.title,
      submissionDeadline,
      externalId,
      contractingBody,
      cpvCodes,
      budgetAmount,
      currency,
      state,
      procedureTypeRaw,
      actorId,
    });

    // §6 del diseño: reutiliza la máquina de invalidación de aprobaciones de
    // Fase 2 pieza 1 (ApprovalWorkflow/recordChange) en vez de inventar una
    // nueva -- un cambio de fecha límite en una convocatoria ya cargada
    // invalida la aprobación "expediente" vigente de su propuesta, si existe
    // (a lo sumo una: `licitaciones.proposal` tiene `unique(organization_id,
    // tender_id)`, así que "cada propuesta abierta de esa convocatoria" es
    // 0 o 1 propuesta en este esquema).
    if (result.submissionDeadlineChanged) {
      const proposal = await repo.findProposal(organizationId, result.tender.id);
      if (proposal) {
        await repo.recordChange(organizationId, proposal.id, { scope: "expediente", scopeRef: "expediente", reason: "Cambio de fecha límite por alta manual" });
      }
    }

    return c.json(result.tender, result.created ? 201 : 200);
  });

  return app;
}
