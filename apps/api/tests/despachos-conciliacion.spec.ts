// Fase 5 (conciliación bancaria): verifica que la ruta HTTP invoca de verdad el
// motor real de domain-despachos (no un objeto vacío) y que el role-gating
// (CONCILIACION_ROLES = admin|contador) excluye auditor/readonly — mismo criterio
// que despachos-declaraciones-nomina.spec.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { conciliarMovimientos } from "@atiende/domain-despachos";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

function cfdiIngreso(overrides: Record<string, unknown> = {}) {
  return {
    folioFiscal: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    tipo: "I",
    subtotal: 1000,
    total: 1160,
    descuento: 0,
    iva: 160,
    conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000 }],
    usoCfdi: "G03",
    formaPago: "03",
    metodoPago: "PUE",
    regimenFiscalEmisor: "601",
    rfcEmisor: "CON950820K12",
    rfcReceptor: "XAXX010101000",
    emisorNombre: "PROVEEDOR DE PRUEBA SA DE CV",
    tieneSello: true,
    noCertificado: "00001000000504465028",
    fecha: "2025-03-10T10:00:00",
    fechaTimbrado: "2025-03-10T10:05:00",
    ...overrides,
  };
}

describe("POST /despachos/:propertyId/conciliacion/matching", () => {
  it("concilia un movimiento bancario exacto contra un CFDI ya ingerido -- invoca el motor real", async () => {
    const app = buildApp(ctx.deps);
    const cfdiRes = await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, cfdiIngreso()));
    expect(cfdiRes.status).toBe(201);

    const res = await app.request(
      `/despachos/${ctx.propertyId}/conciliacion/matching`,
      authedJson(ctx.staff.contador.token, {
        movimientos: [{ fecha: "2025-03-10", descripcion: "Pago SPEI proveedor", referencia: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", monto: 1160 }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matched: unknown[]; totalMatched: number };
    expect(body.totalMatched).toBe(1);
    expect(body.matched).toHaveLength(1);
  });

  it("readonly/auditor no pueden correr conciliación -- 403", async () => {
    const app = buildApp(ctx.deps);
    const resReadonly = await app.request(`/despachos/${ctx.propertyId}/conciliacion/matching`, authedJson(ctx.staff.readonly.token, { movimientos: [] }));
    expect(resReadonly.status).toBe(403);
    const resAuditor = await app.request(`/despachos/${ctx.propertyId}/conciliacion/matching`, authedJson(ctx.staff.auditor.token, { movimientos: [] }));
    expect(resAuditor.status).toBe(403);
  });

  it("movimientos faltante o inválido -> 400", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/conciliacion/matching`, authedJson(ctx.staff.admin.token, {}));
    expect(res.status).toBe(400);
  });

  // Migración 006 (hallazgo de auditoría): antes de esta migración, un CFDI que
  // nunca produce `diot.proveedoresReportables` (cualquier tipo distinto de "I" con
  // subtotal>0 -- ver reglas-fiscales-avanzadas.ts) conciliaba usando `createdAt`
  // (fecha de INGESTA, "ahora") en vez de la fecha real del CFDI. Este CFDI tipo "E"
  // (nota de crédito) trae una fecha real muy anterior a "hoy" -- si el motor
  // siguiera usando `createdAt`, el movimiento bancario con la fecha REAL del CFDI
  // jamás haría match dentro de la tolerancia default (3 días).
  it("REQ: concilia por la fecha REAL del CFDI, no por createdAt -- un CFDI tipo E (sin datos DIOT) hace match aunque su fecha real esté muy lejos de 'hoy'", async () => {
    const app = buildApp(ctx.deps);
    const notaCredito = cfdiIngreso({
      folioFiscal: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      tipo: "E",
      iva: null,
      cfdiRelacionados: ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
      tipoRelacion: "01",
      // Muy anterior a "hoy" -- createdAt (fecha de ingesta real) sería la fecha de
      // ejecución de este test, no esta.
      fecha: "2020-01-15T10:00:00",
      fechaTimbrado: "2020-01-15T10:05:00",
    });
    const cfdiRes = await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, notaCredito));
    expect(cfdiRes.status).toBe(201);
    const cfdiBody = (await cfdiRes.json()) as { diot: { reportable: boolean; proveedoresReportables: unknown[] } };
    // Confirma la premisa: un tipo "E" nunca es reportable en DIOT -- sin la
    // columna `fecha`, este invoice no tendría ninguna fecha real recuperable.
    expect(cfdiBody.diot.reportable).toBe(false);
    expect(cfdiBody.diot.proveedoresReportables).toHaveLength(0);

    const res = await app.request(
      `/despachos/${ctx.propertyId}/conciliacion/matching`,
      authedJson(ctx.staff.contador.token, {
        movimientos: [{ fecha: "2020-01-15", descripcion: "Nota de crédito proveedor", referencia: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", monto: 1160 }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalMatched: number };
    expect(body.totalMatched).toBe(1);
  });
});

describe("POST /despachos/:propertyId/conciliacion/alertas", () => {
  it("genera alertas reales (comisión bancaria) -- cruza contra el motor de dominio", async () => {
    const app = buildApp(ctx.deps);
    const movimientos = [{ fecha: "2025-01-01", descripcion: "Cargo por comisión de manejo de cuenta", monto: -80 }];
    const res = await app.request(`/despachos/${ctx.propertyId}/conciliacion/alertas`, authedJson(ctx.staff.contador.token, { movimientos }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alertas: Array<{ rule: string }> };
    expect(body.alertas.some((a) => a.rule === "bank_fee")).toBe(true);
  });
});

describe("POST /despachos/:propertyId/conciliacion/clasificar-deposito", () => {
  it("clasifica un depósito con CFDI como ingreso", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/conciliacion/clasificar-deposito`, authedJson(ctx.staff.admin.token, { descripcion: "Pago cliente", referencia: "CFDI-1" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clasificacion: string };
    expect(body.clasificacion).toBe("ingreso");
  });
});

describe("cruce contra el motor real", () => {
  it("el resultado de la ruta coincide exactamente con llamar conciliarMovimientos directamente", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, cfdiIngreso({ folioFiscal: "11111111-1111-1111-1111-111111111111" })));

    const movimientos = [{ fecha: "2025-03-10", descripcion: "Pago SPEI", referencia: "11111111-1111-1111-1111-111111111111", monto: 1160 }];
    const res = await app.request(`/despachos/${ctx.propertyId}/conciliacion/matching`, authedJson(ctx.staff.contador.token, { movimientos }));
    const body = (await res.json()) as { totalMatched: number };

    const registros = (await ctx.despachosRepo.listInvoices(ctx.propertyId)).map((inv) => ({
      id: inv.id,
      fecha: inv.fecha,
      total: inv.total,
      descripcion: inv.emisorNombre,
      referencia: inv.folioFiscal,
      folioFiscal: inv.folioFiscal,
    }));
    const directo = conciliarMovimientos(
      movimientos.map((m) => ({ fecha: m.fecha, descripcion: m.descripcion, referencia: m.referencia, cargo: null, abono: m.monto, saldo: null, monto: m.monto, banco: "generic", formato: "csv" })),
      registros,
    );
    expect(body.totalMatched).toBe(directo.totalMatched);
  });
});
