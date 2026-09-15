// Hallazgo de auditoría (severidad ALTA): "Cobranza (Fase 10) tiene motor +
// persistencia completos pero cero rutas HTTP y cero UI" -- el motor
// determinista (aging/score de cobrabilidad/proyección/resumen ejecutivo,
// `@atiende/domain-despachos::cobranza/engine.ts`) y el repositorio
// (`registerReceivable`/`listReceivables`/`markReceivablePaid`/
// `insertCollectionEvent`, migración 004) ya existían completos y probados;
// este test cubre las rutas HTTP nuevas (cobranza.ts) end-to-end, sin mockear
// el motor de dominio -- mismo patrón que despachos-cfdi.spec.ts (leído
// primero como plantilla).
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

async function ingestarCfdiIngreso(overrides: Record<string, unknown> = {}) {
  return ctx.despachosRepo.insertInvoice({
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    folioFiscal: randomUUID(),
    tipo: "I",
    rfcEmisor: "CON950820K12",
    rfcReceptor: "XAXX010101000",
    emisorNombre: "CLIENTE DE PRUEBA SA DE CV",
    subtotal: 1000,
    total: 1160,
    iva: 160,
    descuento: 0,
    categoria: "sin_clasificar",
    valido: true,
    issues: [],
    warnings: [],
    requiresHumanReview: false,
    diot: { proveedoresReportables: [], reportable: false },
    fecha: "2026-01-01",
    ...overrides,
  });
}

function fechaHace(dias: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

describe("POST /despachos/:propertyId/cobranza/cuentas -- arranca el reloj de cobranza", () => {
  it("un contador registra una cuenta por cobrar real sobre un CFDI de ingreso ya ingerido", async () => {
    const app = buildApp(ctx.deps);
    const invoice = await ingestarCfdiIngreso();

    const res = await app.request(
      `/despachos/${ctx.propertyId}/cobranza/cuentas`,
      authedJson(ctx.staff.contador.token, { invoiceId: invoice.id, fechaVencimiento: fechaHace(-10), clienteNombre: "Cliente de Prueba", clienteEmail: "cliente@example.com" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; facturaId: string; monto: number; bucket: string };
    expect(body.facturaId).toBe(invoice.folioFiscal);
    expect(body.monto).toBe(1160);
    expect(body.bucket).toBe("0-30");

    const persisted = await ctx.despachosRepo.findReceivable(ctx.propertyId, body.id);
    expect(persisted).not.toBeNull();
    expect(persisted?.clienteEmail).toBe("cliente@example.com");
  });

  it("rechaza registrar una cuenta sobre un CFDI que no es tipo Ingreso (422)", async () => {
    const app = buildApp(ctx.deps);
    const invoice = await ingestarCfdiIngreso({ tipo: "T", folioFiscal: randomUUID() });

    const res = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas`, authedJson(ctx.staff.contador.token, { invoiceId: invoice.id, fechaVencimiento: fechaHace(-10) }));
    expect(res.status).toBe(400);
  });

  it("un mismo invoiceId no puede registrar 2 cuentas por cobrar -- 409 conflict", async () => {
    const app = buildApp(ctx.deps);
    const invoice = await ingestarCfdiIngreso();
    const first = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas`, authedJson(ctx.staff.contador.token, { invoiceId: invoice.id, fechaVencimiento: fechaHace(-10) }));
    expect(first.status).toBe(201);

    const second = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas`, authedJson(ctx.staff.contador.token, { invoiceId: invoice.id, fechaVencimiento: fechaHace(-10) }));
    expect(second.status).toBe(409);
  });

  it("un rol readonly no puede registrar una cuenta por cobrar (403)", async () => {
    const app = buildApp(ctx.deps);
    const invoice = await ingestarCfdiIngreso();
    const res = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas`, authedJson(ctx.staff.readonly.token, { invoiceId: invoice.id, fechaVencimiento: fechaHace(-10) }));
    expect(res.status).toBe(403);
  });
});

describe("GET /despachos/:propertyId/cobranza/cuentas y /resumen -- cartera con aging/score real", () => {
  it("un auditor (rol de solo lectura de cobranza) ve la cartera con antigüedad y score ya calculados", async () => {
    const app = buildApp(ctx.deps);
    const vencidaHace45 = await ingestarCfdiIngreso();
    await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas`, authedJson(ctx.staff.contador.token, { invoiceId: vencidaHace45.id, fechaVencimiento: fechaHace(45) }));

    const listRes = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas`, authedJson(ctx.staff.auditor.token));
    expect(listRes.status).toBe(200);
    const cuentas = (await listRes.json()) as Array<{ bucket: string; diasVencido: number; score: number }>;
    expect(cuentas).toHaveLength(1);
    expect(cuentas[0]!.bucket).toBe("31-60");
    expect(cuentas[0]!.diasVencido).toBe(45);

    const resumenRes = await app.request(`/despachos/${ctx.propertyId}/cobranza/resumen`, authedJson(ctx.staff.auditor.token));
    expect(resumenRes.status).toBe(200);
    const resumen = (await resumenRes.json()) as { totalCartera: number; totalCount: number; porAntiguedad: Record<string, { count: number }> };
    expect(resumen.totalCartera).toBe(1160);
    expect(resumen.totalCount).toBe(1);
    expect(resumen.porAntiguedad["31-60"]!.count).toBe(1);
  });

  it("un rol readonly (fuera de VER_COBRANZA_ROLES) no puede consultar la cartera (403)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas`, authedJson(ctx.staff.readonly.token));
    expect(res.status).toBe(403);
  });
});

describe("POST /despachos/:propertyId/cobranza/cuentas/:id/pagar -- cierra el reloj", () => {
  it("marca una cuenta como pagada y ya no aparece en el filtro de pendientes", async () => {
    const app = buildApp(ctx.deps);
    const invoice = await ingestarCfdiIngreso();
    const registrar = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas`, authedJson(ctx.staff.contador.token, { invoiceId: invoice.id, fechaVencimiento: fechaHace(-10) }));
    const { id: receivableId } = (await registrar.json()) as { id: string };

    const pagar = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas/${receivableId}/pagar`, authedJson(ctx.staff.contador.token, { montoPagado: 1160 }));
    expect(pagar.status).toBe(200);
    const pagada = (await pagar.json()) as { pagadoEn: string | null; montoPagado: number | null };
    expect(pagada.pagadoEn).not.toBeNull();
    expect(pagada.montoPagado).toBe(1160);

    const pendientes = (await (await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas?pendiente=true`, authedJson(ctx.staff.contador.token))).json()) as unknown[];
    expect(pendientes).toHaveLength(0);
  });

  it("marcar pagada 2 veces la misma cuenta -- 409 conflict", async () => {
    const app = buildApp(ctx.deps);
    const invoice = await ingestarCfdiIngreso();
    const registrar = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas`, authedJson(ctx.staff.contador.token, { invoiceId: invoice.id, fechaVencimiento: fechaHace(-10) }));
    const { id: receivableId } = (await registrar.json()) as { id: string };

    const primero = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas/${receivableId}/pagar`, authedJson(ctx.staff.contador.token, {}));
    expect(primero.status).toBe(200);
    const segundo = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas/${receivableId}/pagar`, authedJson(ctx.staff.contador.token, {}));
    expect(segundo.status).toBe(409);
  });
});

describe("POST /despachos/:propertyId/cobranza/cuentas/:id/recordatorio -- conecta el correo real a una acción del usuario", () => {
  it("envía el recordatorio real (encola messaging_outbox real) cuando la cuenta tiene correo de contacto capturado", async () => {
    const app = buildApp(ctx.deps);
    const invoice = await ingestarCfdiIngreso();
    const registrar = await app.request(
      `/despachos/${ctx.propertyId}/cobranza/cuentas`,
      authedJson(ctx.staff.contador.token, { invoiceId: invoice.id, fechaVencimiento: fechaHace(45), clienteNombre: "Cliente de Prueba", clienteEmail: "cliente@example.com" }),
    );
    const { id: receivableId } = (await registrar.json()) as { id: string };

    const res = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas/${receivableId}/recordatorio`, authedJson(ctx.staff.contador.token, {}));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { etapa: string; enviado: boolean; motivo: string | null };
    // 45 días de atraso -> la última etapa vencida es 'segundo_recordatorio' (offset 30).
    expect(body.etapa).toBe("segundo_recordatorio");
    expect(body.enviado).toBe(true);
    expect(body.motivo).toBeNull();

    const outbox = ctx.despachosRepo.getMessagingOutbox();
    expect(outbox.some((j) => j.eventType === "cobranza.segundo_recordatorio" && j.payload.to === "cliente@example.com")).toBe(true);

    const eventos = await ctx.despachosRepo.listCollectionEvents(ctx.propertyId, receivableId);
    expect(eventos.some((e) => e.etapa === "segundo_recordatorio")).toBe(true);
  });

  it("permite forzar una etapa explícita distinta de la sugerida", async () => {
    const app = buildApp(ctx.deps);
    const invoice = await ingestarCfdiIngreso();
    const registrar = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas`, authedJson(ctx.staff.contador.token, { invoiceId: invoice.id, fechaVencimiento: fechaHace(-10) }));
    const { id: receivableId } = (await registrar.json()) as { id: string };

    const res = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas/${receivableId}/recordatorio`, authedJson(ctx.staff.contador.token, { stage: "pre_vencimiento" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { etapa: string };
    expect(body.etapa).toBe("pre_vencimiento");
  });

  it("registra el evento de auditoría aunque la cuenta no tenga correo de contacto capturado (honesto, no falla)", async () => {
    const app = buildApp(ctx.deps);
    const invoice = await ingestarCfdiIngreso();
    const registrar = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas`, authedJson(ctx.staff.contador.token, { invoiceId: invoice.id, fechaVencimiento: fechaHace(-10) }));
    const { id: receivableId } = (await registrar.json()) as { id: string };

    const res = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas/${receivableId}/recordatorio`, authedJson(ctx.staff.contador.token, {}));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { enviado: boolean; motivo: string | null };
    expect(body.enviado).toBe(false);
    expect(body.motivo).toBe("no_email");
  });

  it("rechaza enviar recordatorio a una cuenta ya pagada (409)", async () => {
    const app = buildApp(ctx.deps);
    const invoice = await ingestarCfdiIngreso();
    const registrar = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas`, authedJson(ctx.staff.contador.token, { invoiceId: invoice.id, fechaVencimiento: fechaHace(-10) }));
    const { id: receivableId } = (await registrar.json()) as { id: string };
    await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas/${receivableId}/pagar`, authedJson(ctx.staff.contador.token, {}));

    const res = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas/${receivableId}/recordatorio`, authedJson(ctx.staff.contador.token, {}));
    expect(res.status).toBe(409);
  });

  it("un auditor (rol de solo lectura) no puede enviar recordatorios (403)", async () => {
    const app = buildApp(ctx.deps);
    const invoice = await ingestarCfdiIngreso();
    const registrar = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas`, authedJson(ctx.staff.contador.token, { invoiceId: invoice.id, fechaVencimiento: fechaHace(-10) }));
    const { id: receivableId } = (await registrar.json()) as { id: string };

    const res = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas/${receivableId}/recordatorio`, authedJson(ctx.staff.auditor.token, {}));
    expect(res.status).toBe(403);
  });
});

describe("GET /despachos/:propertyId/cobranza/cuentas/:id/eventos", () => {
  it("lista el historial real de eventos de cobranza de una cuenta", async () => {
    const app = buildApp(ctx.deps);
    const invoice = await ingestarCfdiIngreso();
    const registrar = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas`, authedJson(ctx.staff.contador.token, { invoiceId: invoice.id, fechaVencimiento: fechaHace(-10) }));
    const { id: receivableId } = (await registrar.json()) as { id: string };
    await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas/${receivableId}/recordatorio`, authedJson(ctx.staff.contador.token, { stage: "pre_vencimiento" }));

    const res = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas/${receivableId}/eventos`, authedJson(ctx.staff.auditor.token));
    expect(res.status).toBe(200);
    const eventos = (await res.json()) as Array<{ etapa: string; canal: string }>;
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.etapa).toBe("pre_vencimiento");
    expect(eventos[0]!.canal).toBe("email");
  });

  it("404 para una cuenta que no existe", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas/${randomUUID()}/eventos`, authedJson(ctx.staff.auditor.token));
    expect(res.status).toBe(404);
  });
});
