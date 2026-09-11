// L2 · Flujo 2 — licitacionesProposalRoutes: motor de propuesta económica
// determinista sobre tarifas aprobadas y vigentes a la fecha del acto. Port
// ~directo de la porción económica de
// licitaciones/apps/api/src/modules/expediente/proposal.routes.ts (ver
// diseño Fase 1 licitaciones §4.2) -- la porción técnica
// (`/proposal/technical/generate`) queda fuera de fase (ver diseño §6).
//
// Body validado a mano, sin zod (adaptación deliberada del origen, mismo
// criterio que hoteles/quotes.ts de no introducir esa dependencia en el
// monorepo fusionado).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { CompanyDataService, EconomicProposalBuilder, fromCents, IdempotencyConflictError, InMemoryCompanyDataResolver, resolveExpedienteAsOfIso, SubmissionDeadlineUnknownError, WRITE_ROLES } from "@atiende/domain-licitaciones";
import type { ApprovedRate, EconomicLineItemBlocked, EconomicTotals, EconomicLineItemResolved, ProposalRecord } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface LineItemBody {
  readonly concept?: unknown;
  readonly quantity?: unknown;
}

interface EconomicGenerateBody {
  readonly lineItems?: unknown;
}

interface ParsedLineItem {
  readonly concept: string;
  readonly quantity: number;
}

function parseLineItems(raw: unknown): ParsedLineItem[] {
  if (!Array.isArray(raw) || raw.length === 0) throw Errors.validation("lineItems: se esperaba un arreglo no vacío de {concept, quantity}.");
  return raw.map((item, i) => {
    const o = item as LineItemBody;
    if (typeof o.concept !== "string" || o.concept.length === 0) throw Errors.validation(`lineItems[${i}].concept requerido.`);
    if (typeof o.quantity !== "number" || !Number.isFinite(o.quantity) || o.quantity <= 0) throw Errors.validation(`lineItems[${i}].quantity: se esperaba un número positivo.`);
    return { concept: o.concept, quantity: o.quantity };
  });
}

/** `EconomicLineItemResolved.{unitPriceCents,subtotalCents}` son `bigint` -- no serializables por `JSON.stringify`/`c.json()`. Se convierten a decimal en el borde HTTP; el dominio nunca deja de operar en centavos internamente. */
function serializeLineItem(li: EconomicLineItemResolved) {
  return { concept: li.concept, quantity: li.quantity, unitPrice: fromCents(li.unitPriceCents), subtotal: fromCents(li.subtotalCents), sourceRef: li.sourceRef };
}

function serializeProposal(proposal: ProposalRecord) {
  return {
    id: proposal.id,
    tenderId: proposal.tenderId,
    title: proposal.title,
    ivaRate: proposal.ivaRate,
    economicTotals: proposal.economicTotals,
    generationReport: proposal.generationReport,
    correlationId: proposal.correlationId,
    createdAt: proposal.createdAt,
  };
}

/** Forma explícita del cuerpo de respuesta -- `totals` es `EconomicTotals | null` en las dos ramas (bloqueado vs. resuelto); sin esta anotación TS infiere un tipo demasiado estrecho de la primera rama y rechaza la segunda. */
interface EconomicGenerateResponseBody {
  readonly proposal: ReturnType<typeof serializeProposal>;
  readonly economic: {
    readonly lineItems: ReturnType<typeof serializeLineItem>[];
    readonly blockedLineItems: readonly EconomicLineItemBlocked[];
    readonly totals: EconomicTotals | null;
  };
}

export function licitacionesProposalRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const repo = deps.licitacionesRepo;
  const base = "/licitaciones/:propertyId/tenders/:tenderId/proposal";

  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${base}/economic/generate`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(base, async (c) => {
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");

    // Lazy-create, igual que el origen: la primera vez que alguien consulta
    // la propuesta de una convocatoria, se crea.
    const proposal = await repo.getOrCreateProposal(organizationId, tenderId, userId, `Propuesta — ${tender.title}`);
    return c.json(serializeProposal(proposal));
  });

  app.post(`${base}/economic/generate`, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const requestId = c.get("requestId");
    const tenderId = c.req.param("tenderId");
    const raw = await readJsonCapped<EconomicGenerateBody>(c.req.raw, 32 * 1024);
    const lineItems = parseLineItems(raw.lineItems);

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");

    let asOfIso: string;
    try {
      // REQ-LIC-005: mismo guardia que Flujo 1, ninguna duplicación de la
      // lógica de fecha -- reutiliza resolveExpedienteAsOfIso tal cual.
      asOfIso = resolveExpedienteAsOfIso(tender);
    } catch (err) {
      if (err instanceof SubmissionDeadlineUnknownError) throw Errors.submissionDeadlineUnknown(err.message);
      throw err;
    }

    const proposal = await repo.getOrCreateProposal(organizationId, tenderId, userId, `Propuesta — ${tender.title}`);

    try {
      const result = await repo.withIdempotency<EconomicGenerateResponseBody>({ organizationId, scope: "proposal.economic.generate", key: idempotencyKey, body: { tenderId, lineItems } }, async () => {
        const approvedRates = await repo.listApprovedRates(organizationId, asOfIso);
        const resolverRates: ApprovedRate[] = approvedRates.map((r) => ({
          id: r.id,
          companyId: organizationId,
          concept: r.concept,
          unit: "unidad",
          unitPrice: r.unitPrice,
          currency: r.currency,
          approvalStatus: r.approvalStatus,
          validFrom: r.validFrom,
          validUntil: r.validUntil,
        }));
        const companyData = new CompanyDataService(new InMemoryCompanyDataResolver({ rates: resolverRates }));

        let builder: EconomicProposalBuilder;
        try {
          // REQ-LIC-007: el constructor ya valida ivaRate en [0, 0.30], lanza
          // si no -- se mapea a 422 explícito, nunca se deja pasar.
          builder = new EconomicProposalBuilder(companyData, { ivaRate: proposal.ivaRate });
        } catch (err) {
          throw Errors.validation(err instanceof Error ? err.message : "ivaRate inválido.");
        }

        const economicResult = builder.build(organizationId, lineItems, asOfIso);

        // Regla dura (REQ-LIC-006/A8): un concepto bloqueado nunca produce un
        // total parcial -- se refleja explícitamente, sin persistir cambios.
        if (economicResult.totals === null) {
          return { status: 200, body: { proposal: serializeProposal(proposal), economic: { lineItems: economicResult.lineItems.map(serializeLineItem), blockedLineItems: economicResult.blockedLineItems, totals: null } } };
        }

        const updated = await repo.saveEconomicGeneration(organizationId, proposal.id, {
          economicTotals: economicResult.totals,
          generationReportPatch: { usedRateConcepts: economicResult.lineItems.map((li) => li.concept), blockedLineItems: [], totals: economicResult.totals },
          correlationId: requestId ?? null,
          cartaSection: { content: economicResult.cartaText!, sources: [] },
          anexoSection: { content: economicResult.anexoText!, sources: [] },
        });

        return { status: 200, body: { proposal: serializeProposal(updated), economic: { lineItems: economicResult.lineItems.map(serializeLineItem), blockedLineItems: [], totals: economicResult.totals } } };
      });
      return c.json(result.body, result.status as 200);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      throw err;
    }
  });

  return app;
}
