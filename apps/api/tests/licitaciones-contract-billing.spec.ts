// Fase 6 pieza 1, ítem 2 (REQ-051 "agente de cobranza") -- test de
// integración HTTP real: facturas contra el contrato, vencimiento calculado
// server-side, y el resumen de cuentas por cobrar (Decimal, nunca number
// flotante).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

async function createContract(app: ReturnType<typeof buildApp>, propertyId: string, tenderId: string, token: string) {
  const res = await app.request(`/licitaciones/${propertyId}/tenders/${tenderId}/contract`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(201);
}

describe("Fase 6 pieza 1, ítem 2 (REQ-051) -- cobranza: facturas y cuentas por cobrar", () => {
  it("sin contrato -> 404 al registrar una factura", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/invoices`,
      authedJson(ctx.staff.writer.token, { concepto: "Primera exhibición", amount: "100000.00", invoiceVerifiedOn: "2026-01-05" }),
    );
    expect(res.status).toBe(404);
  });

  it("viewer no puede registrar una factura (403); writer sí, y el vencimiento SIEMPRE lo calcula el servidor (17 días hábiles)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await createContract(app, ctx.propertyId, ctx.tenderId, ctx.staff.owner.token);

    const forbidden = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/invoices`,
      authedJson(ctx.staff.viewer.token, { concepto: "x", amount: "1.00", invoiceVerifiedOn: "2026-01-05" }),
    );
    expect(forbidden.status).toBe(403);

    const today = new Date().toISOString().slice(0, 10);
    const created = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/invoices`,
      authedJson(ctx.staff.writer.token, { concepto: "Primera exhibición", amount: "100000.00", invoiceVerifiedOn: today }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { amount: string; dueDate: string; legalReference: string; status: string };
    expect(body.amount).toBe("100000.00");
    expect(body.dueDate > today).toBe(true);
    expect(body.legalReference).toMatch(/Art\. 73/);
    expect(body.status).toBe("pendiente");
  });

  it("un dueDate inyectado por el cliente se ignora -- no existe ningún campo que lo acepte", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await createContract(app, ctx.propertyId, ctx.tenderId, ctx.staff.owner.token);
    const created = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/invoices`,
      authedJson(ctx.staff.writer.token, { concepto: "x", amount: "1.00", invoiceVerifiedOn: "2026-01-05", dueDate: "2020-01-01" }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { dueDate: string };
    expect(body.dueDate).not.toBe("2020-01-01");
  });

  it("amount inválido (no decimal) -> 400", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await createContract(app, ctx.propertyId, ctx.tenderId, ctx.staff.owner.token);
    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/invoices`,
      authedJson(ctx.staff.writer.token, { concepto: "x", amount: "cien pesos", invoiceVerifiedOn: "2026-01-05" }),
    );
    expect(res.status).toBe(400);
  });

  it("marcar una factura como pagada la saca de pendiente/vencido; una factura inexistente -> 404", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await createContract(app, ctx.propertyId, ctx.tenderId, ctx.staff.owner.token);
    const created = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/invoices`,
      authedJson(ctx.staff.writer.token, { concepto: "x", amount: "500.00", invoiceVerifiedOn: "2026-01-05" }),
    );
    const invoiceId = ((await created.json()) as { id: string }).id;

    const notFound = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/invoices/00000000-0000-0000-0000-000000000000/mark-paid`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.writer.token}` },
    });
    expect(notFound.status).toBe(404);

    const paid = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/invoices/${invoiceId}/mark-paid`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.writer.token}` },
    });
    expect(paid.status).toBe(200);
    expect(((await paid.json()) as { status: string; paidAt: string | null }).status).toBe("pagada");
  });

  it("receivablesSummary suma en Decimal (nunca number) el pendiente/vencido y trae el detalle de facturas", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await createContract(app, ctx.propertyId, ctx.tenderId, ctx.staff.owner.token);
    await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/invoices`,
      authedJson(ctx.staff.writer.token, { concepto: "Primera exhibición", amount: "1000.50", invoiceVerifiedOn: "2026-01-05" }),
    );
    await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/invoices`,
      authedJson(ctx.staff.writer.token, { concepto: "Segunda exhibición", amount: "250.25", invoiceVerifiedOn: "2026-01-05" }),
    );

    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/receivables`, authedJson(ctx.staff.viewer.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalPending: string; countPending: number; invoices: unknown[] };
    expect(body.totalPending).toBe("1250.75");
    expect(body.countPending).toBe(2);
    expect(body.invoices).toHaveLength(2);
  });
});
