// Fase 16 (post-adjudicación, pieza 0) -- test de integración HTTP real de
// los endpoints de ESCRITURA de "datos de empresa" (companyData.ts). Hasta
// esta pieza, `LicitacionesRepository` solo exponía lectura -- ninguna
// propuesta que dependiera de un dato de empresa podía dejar de estar
// "PENDIENTE" sin un INSERT manual a la base de datos (`seedApprovedRates`/
// `seedCompanyDocuments`, EXCLUSIVOS de pruebas).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

function patchJson(token: string, body: unknown): RequestInit {
  const raw = JSON.stringify(body);
  return { method: "PATCH", body: raw, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) } };
}

describe("POST/GET/PATCH /licitaciones/:propertyId/company/rates (Fase 16)", () => {
  it("camino feliz de punta a punta: crear + aprobar una tarifa por HTTP saca la propuesta económica de PENDIENTE (totals ya no es null)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    // Antes de capturar el dato: sin ninguna tarifa, el motor económico
    // bloquea el total completo (REQ-LIC-006/A8) -- confirma el punto de
    // partida "PENDIENTE" del hallazgo.
    const before = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal/economic/generate`,
      authedJson(ctx.staff.writer.token, { lineItems: [{ concept: "consultoria_hora", quantity: 4 }] }, { "idempotency-key": "before" }),
    );
    const beforeBody = (await before.json()) as { economic: { totals: unknown } };
    expect(beforeBody.economic.totals).toBeNull();

    // POST .../company/rates (el endpoint que este hallazgo agrega) + PATCH
    // para aprobarla -- SIN tocar el repositorio directamente.
    const created = await app.request(`/licitaciones/${ctx.propertyId}/company/rates`, authedJson(ctx.staff.writer.token, { concept: "consultoria_hora", unitPrice: "500.00", validFrom: "2026-01-01T00:00:00-06:00" }));
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string; approvalStatus: string };
    expect(createdBody.approvalStatus).toBe("pendiente_aprobacion");

    const approved = await app.request(`/licitaciones/${ctx.propertyId}/company/rates/${createdBody.id}`, patchJson(ctx.staff.writer.token, { approvalStatus: "aprobado" }));
    expect(approved.status).toBe(200);

    const after = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal/economic/generate`,
      authedJson(ctx.staff.writer.token, { lineItems: [{ concept: "consultoria_hora", quantity: 4 }] }, { "idempotency-key": "after" }),
    );
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as { economic: { totals: { total: string } } };
    expect(afterBody.economic.totals!.total).toBe("2320.00"); // 4*500=2000 + 16% IVA=320
  });

  it("crear una tarifa con 'concept' duplicado -> 409, con instrucción de usar PATCH", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/company/rates`, authedJson(ctx.staff.writer.token, { concept: "consultoria_hora", unitPrice: "500.00" }));
    const duplicate = await app.request(`/licitaciones/${ctx.propertyId}/company/rates`, authedJson(ctx.staff.writer.token, { concept: "consultoria_hora", unitPrice: "999.00" }));
    expect(duplicate.status).toBe(409);
  });

  it("unitPrice con formato inválido -> 400, ninguna fila se crea", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/company/rates`, authedJson(ctx.staff.writer.token, { concept: "x", unitPrice: "no-es-un-numero" }));
    expect(res.status).toBe(400);
    const list = await app.request(`/licitaciones/${ctx.propertyId}/company/rates`, authedJson(ctx.staff.viewer.token));
    const body = (await list.json()) as { rates: unknown[] };
    expect(body.rates).toHaveLength(0);
  });

  it("viewer puede leer pero NUNCA crear/actualizar (403) -- solo WRITE_ROLES", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const readRes = await app.request(`/licitaciones/${ctx.propertyId}/company/rates`, authedJson(ctx.staff.viewer.token));
    expect(readRes.status).toBe(200);
    const writeRes = await app.request(`/licitaciones/${ctx.propertyId}/company/rates`, authedJson(ctx.staff.viewer.token, { concept: "x", unitPrice: "1.00" }));
    expect(writeRes.status).toBe(403);
  });

  it("GET .../company/rates lista TODAS (incluidas pendientes/rechazadas), a diferencia del motor económico que solo ve las aprobadas y vigentes", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/company/rates`, authedJson(ctx.staff.writer.token, { concept: "pendiente", unitPrice: "1.00" }));
    const list = await app.request(`/licitaciones/${ctx.propertyId}/company/rates`, authedJson(ctx.staff.viewer.token));
    const body = (await list.json()) as { rates: { concept: string; approvalStatus: string }[] };
    expect(body.rates).toEqual([{ id: expect.any(String), concept: "pendiente", unitPrice: "1.00", currency: "MXN", approvalStatus: "pendiente_aprobacion", validFrom: expect.any(String), validUntil: null }]);
  });
});

describe("POST/PATCH /licitaciones/:propertyId/company/documents (Fase 16)", () => {
  it("crear un documento sin vigencia, aprobarlo, y que aparezca resoluble para el motor técnico", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/licitaciones/${ctx.propertyId}/company/documents`, authedJson(ctx.staff.writer.token, { type: "acta_constitutiva", label: "Acta Constitutiva Empresa de Prueba", expiresAt: null }));
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string };

    const approved = await app.request(`/licitaciones/${ctx.propertyId}/company/documents/${createdBody.id}`, patchJson(ctx.staff.writer.token, { approvalStatus: "aprobado" }));
    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as { approvalStatus: string; type: string; label: string };
    expect(approvedBody.approvalStatus).toBe("aprobado");
    expect(approvedBody.type).toBe("acta_constitutiva");

    const list = await app.request(`/licitaciones/${ctx.propertyId}/company/documents`, authedJson(ctx.staff.viewer.token));
    const listBody = (await list.json()) as { documents: { id: string }[] };
    expect(listBody.documents.map((d) => d.id)).toContain(createdBody.id);
  });

  it("expiresAt sin offset horario explícito -> 400 (REQ-LIC-001, nunca una fecha 'naive')", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/company/documents`, authedJson(ctx.staff.writer.token, { type: "x", label: "x", expiresAt: "2026-05-01" }));
    expect(res.status).toBe(400);
  });

  it("PATCH contra un documentId inexistente -> 404", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/company/documents/00000000-0000-0000-0000-000000000000`, patchJson(ctx.staff.writer.token, { approvalStatus: "aprobado" }));
    expect(res.status).toBe(404);
  });
});

describe("POST/PATCH /licitaciones/:propertyId/company/{capabilities,experience,signers} (Fase 16)", () => {
  it("capacidad con 'name' duplicado -> 409", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/company/capabilities`, authedJson(ctx.staff.writer.token, { name: "mantenimiento_flotilla", description: "x" }));
    const duplicate = await app.request(`/licitaciones/${ctx.propertyId}/company/capabilities`, authedJson(ctx.staff.writer.token, { name: "mantenimiento_flotilla", description: "y" }));
    expect(duplicate.status).toBe(409);
  });

  it("experiencia exige evidenceDocId (obligatorio a nivel de dominio) -- sin él, 400", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/company/experience`, authedJson(ctx.staff.writer.token, { description: "Proyecto X" }));
    expect(res.status).toBe(400);
  });

  it("firmante con 'role' duplicado -> 409; autorizar/revocar por PATCH", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/licitaciones/${ctx.propertyId}/company/signers`, authedJson(ctx.staff.writer.token, { name: "Juan Pérez", role: "representante_legal", authorized: true }));
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string; authorized: boolean };
    expect(createdBody.authorized).toBe(true);

    const duplicate = await app.request(`/licitaciones/${ctx.propertyId}/company/signers`, authedJson(ctx.staff.writer.token, { name: "Otra Persona", role: "representante_legal" }));
    expect(duplicate.status).toBe(409);

    const revoked = await app.request(`/licitaciones/${ctx.propertyId}/company/signers/${createdBody.id}`, patchJson(ctx.staff.writer.token, { authorized: false }));
    expect(revoked.status).toBe(200);
    const revokedBody = (await revoked.json()) as { authorized: boolean };
    expect(revokedBody.authorized).toBe(false);
  });
});
