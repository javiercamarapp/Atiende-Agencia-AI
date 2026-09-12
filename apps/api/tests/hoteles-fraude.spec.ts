// Fase 5 hoteles (H16-014, REQ-REC-014) — fraude interno: escaneo real de los 2
// patrones portados (descuento fuera de política, folio reabierto post-auditoría),
// cola de revisión humana (confirmar/descartar) auditada vía
// @atiende/core-authz::AuditSink -- MISMO patrón que
// apps/api/tests/despachos-cfdi.spec.ts (cola de revisión de despachos).
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";

let ctx: HotelesTestContext;

beforeEach(async () => {
  ctx = await buildHotelesTestContext(buildApp);
});

interface AlertaResponse {
  id: string;
  patron: string;
  folioId: string | null;
  cargoId: string | null;
  razon: string;
  estado: string;
  resueltoPor: string | null;
}

interface EscaneoResponse {
  alertas: (AlertaResponse & { esNueva: boolean })[];
  generadas: number;
  yaExistentes: number;
}

describe("POST /hoteles/:propertyId/fraude/escaneos", () => {
  it("detecta un descuento fuera de política SIN autorización (bypass del camino feliz de folios.ts)", async () => {
    const charge = await ctx.hotelesRepo.insertCharge({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      folioId: ctx.folioId,
      description: "Descuento aplicado directo en BD",
      amount: -1000, // supera el discountThreshold=500 sembrado en el fixture
      taxAmount: 0,
      concept: "descuento",
    });

    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/fraude/escaneos`, authedJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as EscaneoResponse;
    expect(body.generadas).toBe(1);
    expect(body.alertas[0]!.patron).toBe("descuento_fuera_de_politica");
    expect(body.alertas[0]!.cargoId).toBe(charge.id);
    expect(body.alertas[0]!.estado).toBe("pendiente");

    // Auditoría real de que la alerta se generó -- ver hotelesFraudeAuditSink.
    const entries = (ctx.deps.hotelesFraudeAuditSink as unknown as { entries: { action: string }[] }).entries;
    expect(entries.some((e) => e.action === "hoteles.fraude:alerta_generada:descuento_fuera_de_politica")).toBe(true);
  });

  it("NO marca un descuento grande aplicado con discount_authorized_by verificado", async () => {
    await ctx.hotelesRepo.insertCharge({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      folioId: ctx.folioId,
      description: "Descuento autorizado",
      amount: -1000,
      taxAmount: 0,
      concept: "descuento",
      discountAuthorizedBy: ctx.staff.owner.id,
    });

    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/fraude/escaneos`, authedJson(ctx.staff.owner.token, {}));
    const body = (await res.json()) as EscaneoResponse;
    expect(body.generadas).toBe(0);
  });

  it("detecta un folio reabierto después de cerrado (cargo posterior a closedAt)", async () => {
    ctx.hotelesRepo.seedFolio({
      id: "folio-cerrado",
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      reservationId: ctx.reservationId,
      status: "cerrado",
      label: "Secundario cerrado",
      isPrimary: false,
      closedAt: "2026-01-01T00:00:00.000Z",
      closeReason: "saldo_cero",
      arApprovedBy: null,
    });
    const charge = await ctx.hotelesRepo.insertCharge({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      folioId: "folio-cerrado",
      description: "Cargo posterior al cierre (bypass)",
      amount: 100,
      taxAmount: 16,
      concept: "otro",
    });

    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/fraude/escaneos`, authedJson(ctx.staff.owner.token, {}));
    const body = (await res.json()) as EscaneoResponse;
    const hallazgo = body.alertas.find((a) => a.patron === "folio_reabierto_post_auditoria");
    expect(hallazgo).toBeDefined();
    expect(hallazgo!.cargoId).toBe(charge.id);
    expect(hallazgo!.folioId).toBe("folio-cerrado");
  });

  it("re-escanear los MISMOS datos NUNCA duplica la alerta (idempotente por dedupeKey)", async () => {
    await ctx.hotelesRepo.insertCharge({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, folioId: ctx.folioId, description: "Descuento", amount: -1000, taxAmount: 0, concept: "descuento" });

    const app = buildApp(ctx.deps);
    const first = await app.request(`/hoteles/${ctx.propertyId}/fraude/escaneos`, authedJson(ctx.staff.owner.token, {}));
    expect(((await first.json()) as EscaneoResponse).generadas).toBe(1);

    const second = await app.request(`/hoteles/${ctx.propertyId}/fraude/escaneos`, authedJson(ctx.staff.owner.token, {}));
    const secondBody = (await second.json()) as EscaneoResponse;
    expect(secondBody.generadas).toBe(0);
    expect(secondBody.yaExistentes).toBe(1);

    expect(await ctx.hotelesRepo.listFraudAlerts(ctx.propertyId)).toHaveLength(1);
  });

  it("frontdesk no puede disparar un escaneo -- 403", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/fraude/escaneos`, authedJson(ctx.staff.frontdesk.token, {}));
    expect(res.status).toBe(403);
  });
});

describe("GET /hoteles/:propertyId/fraude/alertas", () => {
  it("lista las alertas ya detectadas, y filtra por estado", async () => {
    await ctx.hotelesRepo.insertCharge({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, folioId: ctx.folioId, description: "Descuento", amount: -1000, taxAmount: 0, concept: "descuento" });
    const app = buildApp(ctx.deps);
    await app.request(`/hoteles/${ctx.propertyId}/fraude/escaneos`, authedJson(ctx.staff.owner.token, {}));

    const todas = await app.request(`/hoteles/${ctx.propertyId}/fraude/alertas`, authedJson(ctx.staff.owner.token));
    expect(todas.status).toBe(200);
    expect(await todas.json()).toHaveLength(1);

    const pendientes = await app.request(`/hoteles/${ctx.propertyId}/fraude/alertas?estado=pendiente`, authedJson(ctx.staff.owner.token));
    expect(await pendientes.json()).toHaveLength(1);

    const confirmadas = await app.request(`/hoteles/${ctx.propertyId}/fraude/alertas?estado=confirmado`, authedJson(ctx.staff.owner.token));
    expect(await confirmadas.json()).toHaveLength(0);
  });

  it("frontdesk no puede ver alertas de fraude -- 403", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/fraude/alertas`, authedJson(ctx.staff.frontdesk.token));
    expect(res.status).toBe(403);
  });
});

describe("cola de revisión de fraude -- confirmar/descartar, auditado", () => {
  async function scanAndGetAlertId(app: ReturnType<typeof buildApp>): Promise<string> {
    await ctx.hotelesRepo.insertCharge({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, folioId: ctx.folioId, description: "Descuento", amount: -1000, taxAmount: 0, concept: "descuento" });
    const res = await app.request(`/hoteles/${ctx.propertyId}/fraude/escaneos`, authedJson(ctx.staff.owner.token, {}));
    const body = (await res.json()) as EscaneoResponse;
    return body.alertas[0]!.id;
  }

  it("owner confirma una alerta pendiente -- queda auditada", async () => {
    const app = buildApp(ctx.deps);
    const alertId = await scanAndGetAlertId(app);

    const res = await app.request(`/hoteles/${ctx.propertyId}/fraude/alertas/${alertId}/confirmar`, authedJson(ctx.staff.owner.token, { nota: "confirmado, fue un descuento no autorizado" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AlertaResponse;
    expect(body.estado).toBe("confirmado");
    expect(body.resueltoPor).toBe(ctx.staff.owner.id);

    const entries = (ctx.deps.hotelesFraudeAuditSink as unknown as { entries: { action: string; decision: string }[] }).entries;
    expect(entries.some((e) => e.action === "hoteles.fraude.alerta:confirmado" && e.decision === "allowed")).toBe(true);
  });

  it("accountant descarta una alerta pendiente (falso positivo)", async () => {
    const app = buildApp(ctx.deps);
    const alertId = await scanAndGetAlertId(app);
    const res = await app.request(`/hoteles/${ctx.propertyId}/fraude/alertas/${alertId}/descartar`, authedJson(ctx.staff.accountant.token, { nota: "era el owner, false positive" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as AlertaResponse).estado).toBe("descartado");
  });

  it("resolver dos veces la misma alerta da 409 conflict, nunca sobreescribe la decisión original", async () => {
    const app = buildApp(ctx.deps);
    const alertId = await scanAndGetAlertId(app);
    const primera = await app.request(`/hoteles/${ctx.propertyId}/fraude/alertas/${alertId}/confirmar`, authedJson(ctx.staff.owner.token, {}));
    expect(primera.status).toBe(200);

    const segunda = await app.request(`/hoteles/${ctx.propertyId}/fraude/alertas/${alertId}/descartar`, authedJson(ctx.staff.owner.token, {}));
    expect(segunda.status).toBe(409);
  });

  it("frontdesk no puede resolver una alerta -- 403", async () => {
    const app = buildApp(ctx.deps);
    const alertId = await scanAndGetAlertId(app);
    const res = await app.request(`/hoteles/${ctx.propertyId}/fraude/alertas/${alertId}/confirmar`, authedJson(ctx.staff.frontdesk.token, {}));
    expect(res.status).toBe(403);
  });
});
