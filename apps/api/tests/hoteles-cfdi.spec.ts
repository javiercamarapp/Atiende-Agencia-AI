// Fase 5 hoteles (H5, REQ-BO-001/002) — CFDI de hospedaje: emisión real vía HTTP
// (dual-PAC simulado, nunca requiere una API key real de Finkok/SW Sapien),
// idempotencia por folio (REQ-BO-002), RFC genérico extranjero/global, propina
// excluida del subtotal, DSA por cuarto-noche, y cancelación.
import { beforeEach, describe, expect, it } from "vitest";
import { DualPacCfdiPort, FinkokAdapter, SwSapienAdapter } from "@atiende/mcp-cfdi";
import type { CancelarInput, CfdiCancelacion, CfdiPort, CfdiTimbrado, CfdiWebhookEvent, DomainCfdiStatus, TimbrarInput } from "@atiende/mcp-cfdi";
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

  // Fix hallazgo auditoría — un CFDI de hospedaje cancelado SÍ debe poder
  // reemitirse con un folio fiscal (UUID) nuevo: antes de este fix, el
  // corto-circuito de idempotencia de REQ-BO-002 no distinguía "existe" de
  // "existe y está vigente", así que una vez cancelado quedaba bloqueado para
  // siempre (ver 015_cfdi_hospedaje_reemision_tras_cancelacion.sql).
  it("un CFDI de hospedaje cancelado SÍ puede reemitirse con un UUID fiscal nuevo", async () => {
    await seedHospedajeCharges(ctx, 1);
    const app = buildApp(ctx.deps);

    const primero = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`,
      authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-reemision-1" }),
    );
    expect(primero.status).toBe(201);
    const primeroBody = (await primero.json()) as CfdiResponse;

    const cancelado = await app.request(
      `/hoteles/${ctx.propertyId}/cfdi/${primeroBody.id}/cancelar`,
      authedJson(ctx.staff.owner.token, { motivo: "02" }, { "idempotency-key": "cancel-reemision-1" }),
    );
    expect(cancelado.status).toBe(200);

    // Reemisión sobre el MISMO folio, con una Idempotency-Key nueva (como haría
    // el panel real al volver a enviar el formulario de "Timbrar CFDI") -- debe
    // timbrar un CFDI NUEVO (201, UUID distinto), no devolver el cancelado.
    const segundo = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`,
      authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-reemision-2" }),
    );
    expect(segundo.status).toBe(201);
    const segundoBody = (await segundo.json()) as CfdiResponse;
    expect(segundoBody.id).not.toBe(primeroBody.id);
    expect(segundoBody.uuidFiscal).toBeTruthy();
    expect(segundoBody.uuidFiscal).not.toBe(primeroBody.uuidFiscal);
    expect(segundoBody.estado).toBe("timbrado");

    // El folio ahora tiene 2 CFDI de hospedaje en su historial: el cancelado y
    // el vigente -- REQ-BO-002 solo limita a UNO VIGENTE a la vez, nunca uno
    // para siempre.
    const historial = (await (await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`, authedJson(ctx.staff.owner.token))).json()) as CfdiResponse[];
    expect(historial).toHaveLength(2);
    expect(historial.filter((c) => c.estado === "cancelado")).toHaveLength(1);
    expect(historial.filter((c) => c.estado === "timbrado")).toHaveLength(1);

    // Reintentar la reemisión (misma Idempotency-Key de la reemisión) sigue
    // siendo idempotente: devuelve el vigente recién timbrado, no re-timbra.
    const reintento = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`,
      authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-reemision-3" }),
    );
    expect(reintento.status).toBe(200);
    const reintentoBody = (await reintento.json()) as CfdiResponse;
    expect(reintentoBody.id).toBe(segundoBody.id);
    expect(await ctx.hotelesRepo.listCfdiEmisiones(ctx.propertyId)).toHaveLength(2);
  });
});

// Hallazgo auditoría 1 — en producción `hotelesCfdiPort` es
// `DualPacCfdiPort(FinkokAdapter, SwSapienAdapter)`, y AMBOS lanzan
// `PortUnavailableError` de forma INCONDICIONAL en este entorno (sin CSD/
// credenciales reales de Finkok/SW Sapien, ver comentario de cabecera de esos
// adaptadores) -- correcto y esperado, este repo no tiene esas credenciales. El
// bug real era que `app.onError` (app.ts) solo conoce `ApiError`: cualquier otro
// error se aplanaba a un 500 genérico "Error interno", indistinguible de un bug
// real. Estos tests usan el `CfdiPort` REAL (no el Fake de `ctx.deps`) para
// probar el camino honesto: 503 `service_unavailable` con un mensaje claro.
describe("hallazgo auditoría -- PAC sin credenciales responde 503 honesto, nunca un 500 genérico", () => {
  it("timbrar CFDI de hospedaje con el CfdiPort real (sin credenciales) -> 503, no 500", async () => {
    await seedHospedajeCharges(ctx, 1);
    const deps = { ...ctx.deps, hotelesCfdiPort: new DualPacCfdiPort(new FinkokAdapter(), new SwSapienAdapter()) };
    const app = buildApp(deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`,
      authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-503-1" }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("service_unavailable");
    expect(body.message.toLowerCase()).toContain("pac");
    // Nunca se persiste un CFDI a medias cuando el PAC no está disponible.
    expect(await ctx.hotelesRepo.listCfdiEmisiones(ctx.propertyId)).toHaveLength(0);
  });

  it("timbrar el complemento de pago con el CfdiPort real (sin credenciales) -> 503, no 500", async () => {
    await seedHospedajeCharges(ctx, 1);
    const appFake = buildApp(ctx.deps);
    const hospedaje = await appFake.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`,
      authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-503-pago-hosp" }),
    );
    const hospedajeBody = (await hospedaje.json()) as CfdiResponse;
    const { id: paymentId } = await ctx.hotelesRepo.insertPayment({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      folioId: ctx.folioId,
      amount: 1000,
      method: "tarjeta",
      status: "capturado",
    });

    const deps = { ...ctx.deps, hotelesCfdiPort: new DualPacCfdiPort(new FinkokAdapter(), new SwSapienAdapter()) };
    const appReal = buildApp(deps);
    const res = await appReal.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi/pago`,
      authedJson(ctx.staff.owner.token, { paymentId, relacionadoCfdiId: hospedajeBody.id }, { "idempotency-key": "cfdi-503-pago-2" }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("service_unavailable");
  });

  it("cancelar con el CfdiPort real (sin credenciales) -> 503, no 500, y el CFDI sigue timbrado sin tocarse", async () => {
    await seedHospedajeCharges(ctx, 1);
    const appFake = buildApp(ctx.deps);
    const emitido = await appFake.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`,
      authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-503-cancel-1" }),
    );
    const { id } = (await emitido.json()) as CfdiResponse;

    const deps = { ...ctx.deps, hotelesCfdiPort: new DualPacCfdiPort(new FinkokAdapter(), new SwSapienAdapter()) };
    const appReal = buildApp(deps);
    const res = await appReal.request(`/hoteles/${ctx.propertyId}/cfdi/${id}/cancelar`, authedJson(ctx.staff.owner.token, { motivo: "02" }, { "idempotency-key": "cancel-503-1" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("service_unavailable");

    const stillThere = await ctx.hotelesRepo.findCfdiEmision(ctx.propertyId, id);
    expect(stillThere!.status).toBe("timbrado");
    expect(stillThere!.canceledAt).toBeNull();
  });
});

/** Doble de prueba controlable del `CfdiPort` -- a diferencia de
 * `FakeGenericPacAdapter` (`cancelar` siempre devuelve 'cancelado' de inmediato),
 * este permite simular el ciclo real de aceptación/rechazo de cancelación 2022+
 * del SAT: `cancelar` puede devolver 'en_proceso_cancelacion' y `consultarEstado`
 * se controla por separado, para probar el hallazgo de auditoría 2 (el callejón
 * sin salida) de punta a punta vía HTTP. */
class ScriptableCfdiPort implements CfdiPort {
  public nextCancelarStatus: DomainCfdiStatus = "cancelado";
  public nextConsultarEstado: DomainCfdiStatus = "cancelado";

  status() {
    return { provider: "scriptable-test-pac", available: true, simulated: true } as const;
  }

  async timbrar(input: TimbrarInput): Promise<CfdiTimbrado> {
    return {
      uuid: `uuid-${input.folio}`,
      folio: input.folio,
      status: "timbrado",
      selloDigital: "sello-test",
      fechaTimbrado: new Date().toISOString(),
      pac: "scriptable-test-pac",
    };
  }

  async cancelar(input: CancelarInput): Promise<CfdiCancelacion> {
    return { uuid: input.uuid, status: this.nextCancelarStatus, fechaSolicitud: new Date().toISOString() };
  }

  async consultarEstado(_uuid: string): Promise<DomainCfdiStatus> {
    return this.nextConsultarEstado;
  }

  async verifyAndNormalizeWebhook(): Promise<CfdiWebhookEvent> {
    throw new Error("ScriptableCfdiPort: verifyAndNormalizeWebhook no se usa en estos tests.");
  }
}

// Hallazgo auditoría 2 — 'en_proceso_cancelacion' era un callejón sin salida:
// `updateCfdiEmisionCancelacion` escribía `canceled_at = now()` con CUALQUIER
// status que devolviera el PAC (incluyendo 'en_proceso_cancelacion', no solo
// 'cancelado'), y ninguna ruta invocaba jamás `CfdiPort.consultarEstado` para
// saber si el SAT terminó aceptando o rechazando esa cancelación.
describe("hallazgo auditoría -- 'en_proceso_cancelacion' ya no es un callejón sin salida", () => {
  it("cancelar con el PAC devolviendo 'en_proceso_cancelacion' NO marca canceladoEn (antes: se marcaba con cualquier status)", async () => {
    await seedHospedajeCharges(ctx, 1);
    const pac = new ScriptableCfdiPort();
    const app = buildApp({ ...ctx.deps, hotelesCfdiPort: pac });
    const emitido = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`,
      authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-pend-1" }),
    );
    const { id } = (await emitido.json()) as CfdiResponse;

    pac.nextCancelarStatus = "en_proceso_cancelacion";
    const cancelado = await app.request(`/hoteles/${ctx.propertyId}/cfdi/${id}/cancelar`, authedJson(ctx.staff.owner.token, { motivo: "02" }, { "idempotency-key": "cancel-pend-1" }));
    expect(cancelado.status).toBe(200);
    const body = (await cancelado.json()) as { estado: string };
    expect(body.estado).toBe("en_proceso_cancelacion");

    const stored = await ctx.hotelesRepo.findCfdiEmision(ctx.propertyId, id);
    expect(stored!.status).toBe("en_proceso_cancelacion");
    expect(stored!.canceledAt).toBeNull();
  });

  it("POST .../consultar-estado confirma 'cancelado' ante el PAC y AHORA SÍ actualiza el registro (antes: ninguna ruta invocaba consultarEstado)", async () => {
    await seedHospedajeCharges(ctx, 1);
    const pac = new ScriptableCfdiPort();
    const app = buildApp({ ...ctx.deps, hotelesCfdiPort: pac });
    const emitido = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`,
      authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-pend-2" }),
    );
    const { id } = (await emitido.json()) as CfdiResponse;

    pac.nextCancelarStatus = "en_proceso_cancelacion";
    await app.request(`/hoteles/${ctx.propertyId}/cfdi/${id}/cancelar`, authedJson(ctx.staff.owner.token, { motivo: "02" }, { "idempotency-key": "cancel-pend-2" }));

    // El SAT sigue sin resolver -- consultar de nuevo no debe cambiar nada.
    pac.nextConsultarEstado = "en_proceso_cancelacion";
    const sinCambios = await app.request(`/hoteles/${ctx.propertyId}/cfdi/${id}/consultar-estado`, authedJson(ctx.staff.owner.token, {}));
    expect(sinCambios.status).toBe(200);
    const sinCambiosBody = (await sinCambios.json()) as { estado: string; estadoReal: string };
    expect(sinCambiosBody.estado).toBe("en_proceso_cancelacion");
    expect(sinCambiosBody.estadoReal).toBe("en_proceso_cancelacion");
    expect((await ctx.hotelesRepo.findCfdiEmision(ctx.propertyId, id))!.canceledAt).toBeNull();

    // El SAT ya confirmó la cancelación -- ahora sí se persiste, con canceladoEn.
    pac.nextConsultarEstado = "cancelado";
    const confirmado = await app.request(`/hoteles/${ctx.propertyId}/cfdi/${id}/consultar-estado`, authedJson(ctx.staff.owner.token, {}));
    expect(confirmado.status).toBe(200);
    const confirmadoBody = (await confirmado.json()) as { estado: string; estadoReal: string };
    expect(confirmadoBody.estado).toBe("cancelado");
    expect(confirmadoBody.estadoReal).toBe("cancelado");

    const stored = await ctx.hotelesRepo.findCfdiEmision(ctx.propertyId, id);
    expect(stored!.status).toBe("cancelado");
    expect(stored!.canceledAt).not.toBeNull();
  });

  it("POST .../consultar-estado sobre un CFDI que NO está en_proceso_cancelacion -> 409 (nada pendiente que consultar)", async () => {
    await seedHospedajeCharges(ctx, 1);
    const app = buildApp(ctx.deps);
    const emitido = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`,
      authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-pend-3" }),
    );
    const { id } = (await emitido.json()) as CfdiResponse;
    const res = await app.request(`/hoteles/${ctx.propertyId}/cfdi/${id}/consultar-estado`, authedJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(409);
  });

  it("POST .../consultar-estado con el CfdiPort real (sin credenciales) -> 503, no 500", async () => {
    await seedHospedajeCharges(ctx, 1);
    const pac = new ScriptableCfdiPort();
    const appFake = buildApp({ ...ctx.deps, hotelesCfdiPort: pac });
    const emitido = await appFake.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cfdi`,
      authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "cfdi-pend-4" }),
    );
    const { id } = (await emitido.json()) as CfdiResponse;
    pac.nextCancelarStatus = "en_proceso_cancelacion";
    await appFake.request(`/hoteles/${ctx.propertyId}/cfdi/${id}/cancelar`, authedJson(ctx.staff.owner.token, { motivo: "02" }, { "idempotency-key": "cancel-pend-4" }));

    const appReal = buildApp({ ...ctx.deps, hotelesCfdiPort: new DualPacCfdiPort(new FinkokAdapter(), new SwSapienAdapter()) });
    const res = await appReal.request(`/hoteles/${ctx.propertyId}/cfdi/${id}/consultar-estado`, authedJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("service_unavailable");
  });
});
