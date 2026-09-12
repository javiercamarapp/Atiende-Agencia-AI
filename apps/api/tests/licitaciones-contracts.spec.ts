// Fase 6 pieza 1 (REQ-050/REQ-051) -- test de integración HTTP real de la
// máquina de estados del contrato post-adjudicación: alta, metadatos,
// transición (incluida la gate de DECISION_ROLES para las ramas sensibles),
// historial e idempotencia de alta.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

function patchJson(token: string, body: unknown): RequestInit {
  const raw = JSON.stringify(body);
  return { method: "PATCH", body: raw, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) } };
}

describe("POST/GET/PATCH /licitaciones/:propertyId/tenders/:tenderId/contract (Fase 6, REQ-051)", () => {
  it("viewer NO puede crear un contrato (403); GET antes de existir -> 404", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const forbidden = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.viewer.token}` } });
    expect(forbidden.status).toBe(403);

    const notFound = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`, authedJson(ctx.staff.owner.token));
    expect(notFound.status).toBe(404);
  });

  it("crear, leer, y un segundo alta para la misma convocatoria -> 409", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const created = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.writer.token}` } });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { status: string; tenderId: string };
    expect(body.status).toBe("adjudicado");
    expect(body.tenderId).toBe(ctx.tenderId);

    const fetched = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`, authedJson(ctx.staff.viewer.token));
    expect(fetched.status).toBe(200);

    const duplicate = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(duplicate.status).toBe(409);
  });

  it("PATCH de metadatos (endDate/contractNumber/hasRenewalOption) -- writer puede, viewer no", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });

    const forbidden = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`, patchJson(ctx.staff.viewer.token, { endDate: "2027-01-01" }));
    expect(forbidden.status).toBe(403);

    const updated = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`,
      patchJson(ctx.staff.writer.token, { endDate: "2027-06-30", contractNumber: "SABG-2026-042", hasRenewalOption: true, renewalOptionNotes: "Opción a un año más." }),
    );
    expect(updated.status).toBe(200);
    const body = (await updated.json()) as { endDate: string; contractNumber: string; hasRenewalOption: boolean };
    expect(body.endDate).toBe("2027-06-30");
    expect(body.contractNumber).toBe("SABG-2026-042");
    expect(body.hasRenewalOption).toBe(true);
  });

  it("PATCH con endDate mal formado -> 400", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`, patchJson(ctx.staff.writer.token, { endDate: "no-es-fecha" }));
    expect(res.status).toBe(400);
  });

  it("transición válida del flujo principal (writer): adjudicado -> contrato_firmado_declarado -> en_ejecucion, con historial completo", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });

    const t1 = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/transition`,
      authedJson(ctx.staff.writer.token, { toStatus: "contrato_firmado_declarado", reason: "El proveedor entregó el contrato firmado en físico." }),
    );
    expect(t1.status).toBe(200);
    expect(((await t1.json()) as { status: string }).status).toBe("contrato_firmado_declarado");

    const t2 = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/transition`,
      authedJson(ctx.staff.writer.token, { toStatus: "en_ejecucion", reason: "Arrancó la ejecución del contrato." }),
    );
    expect(t2.status).toBe(200);

    const history = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/history`, authedJson(ctx.staff.viewer.token));
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as { history: { fromStatus: string | null; toStatus: string }[] };
    expect(historyBody.history).toHaveLength(3); // alta + 2 transiciones.
    expect(historyBody.history[0]!.fromStatus).toBeNull();
    expect(historyBody.history[0]!.toStatus).toBe("adjudicado");
  });

  it("transición inválida en el grafo -> 409 con el detalle de estados permitidos", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });

    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/transition`,
      authedJson(ctx.staff.owner.token, { toStatus: "cerrado", reason: "Intento de saltar directo al cierre." }),
    );
    expect(res.status).toBe(409);
  });

  it("estado de contrato desconocido -> 400", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/transition`,
      authedJson(ctx.staff.owner.token, { toStatus: "no_existe", reason: "x" }),
    );
    expect(res.status).toBe(400);
  });

  it("transiciones sensibles (CONTRACT_DECISION_TRANSITIONS) exigen DECISION_ROLES -- writer NO puede rescindir, analyst SÍ", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });

    const writerAttempt = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/transition`,
      authedJson(ctx.staff.writer.token, { toStatus: "rescindido", reason: "Incumplimiento grave del proveedor." }),
    );
    expect(writerAttempt.status).toBe(403);

    const analystAttempt = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/transition`,
      authedJson(ctx.staff.analyst.token, { toStatus: "rescindido", reason: "Incumplimiento grave del proveedor.", evidenceRef: "acta-rescision.pdf" }),
    );
    expect(analystAttempt.status).toBe(200);
    expect(((await analystAttempt.json()) as { status: string }).status).toBe("rescindido");
  });

  it("sin reason -> 400, ninguna transición se aplica", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/transition`, authedJson(ctx.staff.owner.token, { toStatus: "contrato_firmado_declarado" }));
    expect(res.status).toBe(400);
  });

  it("contrato inexistente -> 404 en historial y transición", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const history = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/history`, authedJson(ctx.staff.owner.token));
    expect(history.status).toBe(404);
    const transition = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract/transition`,
      authedJson(ctx.staff.owner.token, { toStatus: "contrato_firmado_declarado", reason: "x" }),
    );
    expect(transition.status).toBe(404);
  });
});
