// Fase 6 pieza 1, ítem 2 (REQ-051 "agente de cobranza") —
// licitacionesContractBillingRoutes: seguimiento de pagos pendientes contra
// el contrato. El vencimiento SIEMPRE lo calcula el servidor
// (`computePaymentDueDate`, Art. 73 LAASSP, 17 días hábiles) -- el cliente
// nunca declara `dueDate`. El monto se valida como cadena decimal
// (`DecimalString`, `money.ts::assertValidDecimalString`) -- nunca se acepta
// un `number` de punto flotante para dinero.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { WRITE_ROLES, assertValidDecimalString } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface CreateInvoiceBody {
  readonly concepto?: unknown;
  readonly amount?: unknown;
  readonly invoiceVerifiedOn?: unknown;
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function licitacionesContractBillingRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const invoicesBase = "/licitaciones/:propertyId/tenders/:tenderId/contract/invoices";
  const markPaidBase = "/licitaciones/:propertyId/tenders/:tenderId/contract/invoices/:invoiceId/mark-paid";
  const receivablesBase = "/licitaciones/:propertyId/tenders/:tenderId/contract/receivables";

  app.use(invoicesBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(markPaidBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(receivablesBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  async function requireContract(repo: ReturnType<AppDeps["licitacionesRepo"]>, organizationId: string, tenderId: string) {
    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const contract = await repo.findContractByTender(organizationId, tenderId);
    if (!contract) throw Errors.notFound("No existe contrato registrado para esta convocatoria todavía; regístrelo primero con POST .../contract.");
    return contract;
  }

  app.post(invoicesBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    const raw = await readJsonCapped<CreateInvoiceBody>(c.req.raw, 8 * 1024);

    if (typeof raw.concepto !== "string" || raw.concepto.trim().length === 0) throw Errors.validation("concepto requerido.");
    if (typeof raw.amount !== "string") throw Errors.validation('amount: se esperaba una cadena decimal (p. ej. "12345.67").');
    try {
      assertValidDecimalString(raw.amount);
    } catch (err) {
      throw Errors.validation(err instanceof Error ? err.message : "amount inválido.");
    }
    if (typeof raw.invoiceVerifiedOn !== "string" || !DATE_ONLY_PATTERN.test(raw.invoiceVerifiedOn)) {
      throw Errors.validation('invoiceVerifiedOn: se esperaba "YYYY-MM-DD".');
    }

    await requireContract(repo, organizationId, tenderId);
    const invoice = await repo.createContractInvoice(organizationId, tenderId, { concepto: raw.concepto, amount: raw.amount, invoiceVerifiedOn: raw.invoiceVerifiedOn, actorId });
    return c.json(invoice, 201);
  });

  app.get(invoicesBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    await requireContract(repo, organizationId, tenderId);
    const invoices = await repo.listContractInvoices(organizationId, tenderId);
    return c.json({ invoices });
  });

  app.post(markPaidBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    const invoiceId = c.req.param("invoiceId");

    await requireContract(repo, organizationId, tenderId);
    try {
      const invoice = await repo.markContractInvoicePaid(organizationId, tenderId, invoiceId, actorId);
      return c.json(invoice);
    } catch (err) {
      throw Errors.notFound(err instanceof Error ? err.message : "Factura no encontrada.");
    }
  });

  app.get(receivablesBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    await requireContract(repo, organizationId, tenderId);
    const summary = await repo.receivablesSummary(organizationId, tenderId);
    return c.json(summary);
  });

  return app;
}
