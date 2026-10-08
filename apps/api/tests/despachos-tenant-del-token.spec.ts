// D-P3-50 (brief paridad3-despachos-fiscal-correcciones; modelo: S/tests/adversarial/test_devolucion_iva_payload_tenant_mismatch.py, regresion
// REQ-IVA-018 del suelto, 04eadfa): un `tenantId` en el CUERPO nunca cambia el tenant de la operacion. El tenant es la property de la RUTA
// (ya validada por `requirePropertyMembership`). Prueba adversarial: un cuerpo con el tenant de OTRO despacho no cambia nada.
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

const TENANT_AJENO = "00000000-0000-0000-0000-00000000dead";

const CLASIFICACION = { cfdiUuid: "11111111-1111-1111-1111-111111111111", rfcEmisor: "CON950820K12", rfcReceptor: "CLI010101CL1", descripcion: "Renta de oficina", subtotal: 1000, iva: 160, total: 1160, tipoCfdi: "I", categoria: "renta_oficina", confidence: 0.95 };

describe("el tenantId del cuerpo se ignora (tenant = property de la ruta)", () => {
  it("bookkeeping/poliza: la poliza sale con la property de la ruta aunque el cuerpo traiga otro tenant", async () => {
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/bookkeeping/poliza`, authedJson(ctx.staff.contador.token, { tenantId: TENANT_AJENO, fecha: "2026-07-31", clasificaciones: [CLASIFICACION] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { polizas: { poliza: { tenantId: string } | null }[] };
    expect(body.polizas[0]!.poliza!.tenantId).toBe(ctx.propertyId);
    expect(JSON.stringify(body)).not.toContain(TENANT_AJENO);
  });

  it("bookkeeping/ajuste: idem", async () => {
    const entries = [{ cuenta: "1100", debe: 100, haber: 0, concepto: "a" }, { cuenta: "2100", debe: 0, haber: 100, concepto: "b" }];
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/bookkeeping/ajuste`, authedJson(ctx.staff.contador.token, { tenantId: TENANT_AJENO, fecha: "2026-07-31", concepto: "Ajuste", entries }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { poliza: { tenantId: string } };
    expect(body.poliza.tenantId).toBe(ctx.propertyId);
    expect(JSON.stringify(body)).not.toContain(TENANT_AJENO);
  });

  it("devolucion-iva/solicitud: la solicitud lleva la property de la ruta, no el tenant del cuerpo", async () => {
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/devolucion-iva/solicitud`, authedJson(ctx.staff.contador.token, { periodo: "2026-07", saldo: { montoDevolucionSugerido: 1000 }, tenantId: TENANT_AJENO }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantId: string | null };
    expect(body.tenantId).toBe(ctx.propertyId);
    expect(JSON.stringify(body)).not.toContain(TENANT_AJENO);
  });

  it("devolucion-iva/papel-trabajo: idem", async () => {
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/devolucion-iva/papel-trabajo`, authedJson(ctx.staff.contador.token, { periodo: "2026-07", facturas: [], tenantId: TENANT_AJENO }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantId: string | null };
    expect(body.tenantId).toBe(ctx.propertyId);
    expect(JSON.stringify(body)).not.toContain(TENANT_AJENO);
  });

  it("nomina/calcular: el tenantId del cuerpo (numerico) no entra y la idempotencyKey incluye la property", async () => {
    const payload = { period: { month: 1, year: 2026, diasPagados: 30 }, employees: [{ employeeId: "e1", nombre: "Ana", salarioBruto: 15000 }] };
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/nomina/calcular`, authedJson(ctx.staff.contador.token, { ...payload, tenantId: 7654321 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantId: number | null; idempotencyKey: string };
    expect(body.tenantId).toBeNull();
    expect(body.idempotencyKey).toBe(`nomina-2026-01-${ctx.propertyId}`);
    expect(body.idempotencyKey).not.toContain("7654321");
  });

  it("nomina: dos clientes (properties) distintos del mismo mes producen claves distintas; el mismo cliente, la misma clave", async () => {
    const otro = await buildDespachosTestContext(buildApp);
    const payload = { period: { month: 3, year: 2026 }, employees: [] };
    const clave = async (c: DespachosTestContext, token: string) => ((await (await buildApp(c.deps).request(`/despachos/${c.propertyId}/nomina/calcular`, authedJson(token, payload))).json()) as { idempotencyKey: string }).idempotencyKey;
    const a1 = await clave(ctx, ctx.staff.contador.token);
    const a2 = await clave(ctx, ctx.staff.contador.token);
    const b = await clave(otro, otro.staff.contador.token);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("un token de OTRO despacho no alcanza la property (403): el tenant no se puede elegir por cuerpo ni por ruta ajena", async () => {
    const otro = await buildDespachosTestContext(buildApp);
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/nomina/calcular`, authedJson(otro.staff.contador.token, { period: {}, employees: [], tenantId: 1 }));
    expect([401, 403]).toContain(res.status);
  });
});
