// Fase 5 hoteles (H5, REQ-BO-001/002) — CFDI de hospedaje: emisión real vía HTTP
// (dual-PAC simulado, nunca requiere una API key real de Finkok/SW Sapien),
// idempotencia por folio (REQ-BO-002), RFC genérico extranjero/global, propina
// excluida del subtotal, DSA por cuarto-noche, y cancelación.
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";

let ctx: HotelesTestContext;

beforeEach(async () => {
  ctx = await buildHotelesTestContext(buildApp);
});

interface CfdiResponse {
  id: string;
  folioId: string;
  tipo: string;
  uuidFiscal: string | null;
  estado: string;
  pac: string | null;
  subtotal: number;
  iva: number;
  impuestosLocales: { ishTasa: number; ishMonto: number; dsaMonto: number };
  total: number;
  rfcReceptor: string;
  usoCfdi: string;
}

async function seedHospedajeCharges(ctx: HotelesTestContext, nights: number) {
  for (let i = 0; i < nights; i++) {
    await ctx.hotelesRepo.insertCharge({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      folioId: ctx.folioId,
      description: `Hospedaje noche ${i + 1}`,
      amount: 1000,
      taxAmount: 190, // IVA 16% (160) + ISH 3% (30) -- mismo criterio que computeChargeAmounts
      concept: "hospedaje",
      stayDate: `2026-12-0${i + 1}`,
    });
  }
}

describe("POST /hoteles/:propertyId/folios/:folioId/cfdi -- emisión de CFDI de hospedaje", () => {
  it("timbra un CFDI real con desglose ISH residual + DSA por cuarto-noche, propina excluida", async () => {
    await seedHospedajeCharges(ctx, 2);
    await ctx.hotelesRepo.insertCharge({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, folioId: ctx.folioId, description: "Propina", amount: 200, taxAmount: 0, concept: "propina" });

    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`,
      authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-1" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as CfdiResponse;
    expect(body.uuidFiscal).toBeTruthy();
    expect(body.estado).toBe("timbrado");
    expect(body.pac).toBe("finkok");
    expect(body.subtotal).toBe(2000); // 2 noches * 1000, propina EXCLUIDA
    expect(body.iva).toBe(320); // 16% de 2000
    expect(body.impuestosLocales.ishMonto).toBe(60); // taxTotal(380) - iva(320)
    expect(body.impuestosLocales.dsaMonto).toBe(40); // 2 noches * 20
    expect(body.total).toBe(2000 + 320 + 60 + 40);
  });

  it("REQ-BO-002: reintentar sobre el MISMO folio devuelve el mismo UUID, nunca timbra dos veces", async () => {
    await seedHospedajeCharges(ctx, 1);
    const app = buildApp(ctx.deps);
    const first = await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`, authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-a" }));
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as CfdiResponse;

    const second = await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`, authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-b" }));
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as CfdiResponse;
    expect(secondBody.uuidFiscal).toBe(firstBody.uuidFiscal);

    expect(await ctx.hotelesRepo.listCfdiEmisiones(ctx.propertyId)).toHaveLength(1);
  });

  it("esExtranjero=true SIEMPRE usa el RFC genérico extranjero, ignora rfcReceptor del body", async () => {
    await seedHospedajeCharges(ctx, 1);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`, authedJson(ctx.staff.owner.token, { esExtranjero: true }, { "idempotency-key": "cfdi-ext" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as CfdiResponse;
    expect(body.rfcReceptor).toBe("XEXX010101000");
    expect(body.usoCfdi).toBe("S01");
  });

  it("esGlobal=true usa el RFC público en general", async () => {
    await seedHospedajeCharges(ctx, 1);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`, authedJson(ctx.staff.owner.token, { esGlobal: true }, { "idempotency-key": "cfdi-glob" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as CfdiResponse;
    expect(body.rfcReceptor).toBe("XAXX010101000");
  });

  it("sin cargos facturables (fuera de propina) -> 409 conflict", async () => {
    await ctx.hotelesRepo.insertCharge({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, folioId: ctx.folioId, description: "Propina", amount: 200, taxAmount: 0, concept: "propina" });
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`, authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-sin" }));
    expect(res.status).toBe(409);
  });

  it("un CFDI con esAplicacionAnticipo sin CfdiRelacionados tipo 07 -> 422 (nunca se timbra a ciegas)", async () => {
    await seedHospedajeCharges(ctx, 1);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`,
      authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03", esAplicacionAnticipo: true }, { "idempotency-key": "cfdi-antic" }),
    );
    expect(res.status).toBe(422);
    expect(await ctx.hotelesRepo.listCfdiEmisiones(ctx.propertyId)).toHaveLength(0);
  });

  it("sin Idempotency-Key -> 400", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`, authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }));
    expect(res.status).toBe(400);
  });

  it("frontdesk (rol de dinero pero no de CFDI) no puede timbrar -- 403", async () => {
    await seedHospedajeCharges(ctx, 1);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`,
      authedJson(ctx.staff.frontdesk.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-fd" }),
    );
    expect(res.status).toBe(403);
  });

  it("accountant SÍ puede timbrar", async () => {
    await seedHospedajeCharges(ctx, 1);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`,
      authedJson(ctx.staff.accountant.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-acc" }),
    );
    expect(res.status).toBe(201);
  });
});

describe("GET /hoteles/:propertyId/cfdi | .../folios/:folioId/cfdi", () => {
  it("lista los CFDI reales del folio y de la property", async () => {
    await seedHospedajeCharges(ctx, 1);
    const app = buildApp(ctx.deps);
    await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`, authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-list" }));

    const porFolio = await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`, authedJson(ctx.staff.owner.token));
    expect(porFolio.status).toBe(200);
    expect(await porFolio.json()).toHaveLength(1);

    const porProperty = await app.request(`/hoteles/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.owner.token));
    expect(porProperty.status).toBe(200);
    expect(await porProperty.json()).toHaveLength(1);
  });
});

describe("POST /hoteles/:propertyId/cfdi/:cfdiId/cancelar", () => {
  it("cancela un CFDI real ya timbrado", async () => {
    await seedHospedajeCharges(ctx, 1);
    const app = buildApp(ctx.deps);
    const emitido = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`,
      authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-cancel" }),
    );
    const { id } = (await emitido.json()) as CfdiResponse;

    const cancelado = await app.request(`/hoteles/${ctx.propertyId}/cfdi/${id}/cancelar`, authedJson(ctx.staff.owner.token, { motivo: "02" }, { "idempotency-key": "cancel-1" }));
    expect(cancelado.status).toBe(200);
    const body = (await cancelado.json()) as { estado: string };
    expect(body.estado).toBe("cancelado");

    const segundaVez = await app.request(`/hoteles/${ctx.propertyId}/cfdi/${id}/cancelar`, authedJson(ctx.staff.owner.token, { motivo: "02" }, { "idempotency-key": "cancel-2" }));
    expect(segundaVez.status).toBe(409);
  });

  it("motivo fuera del catálogo SAT -> 400", async () => {
    await seedHospedajeCharges(ctx, 1);
    const app = buildApp(ctx.deps);
    const emitido = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`,
      authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-cancel-2" }),
    );
    const { id } = (await emitido.json()) as CfdiResponse;
    const res = await app.request(`/hoteles/${ctx.propertyId}/cfdi/${id}/cancelar`, authedJson(ctx.staff.owner.token, { motivo: "99" }, { "idempotency-key": "cancel-bad" }));
    expect(res.status).toBe(400);
  });
});
