// Migración 006 (hallazgo de auditoría, severidad ALTA): "devolucion de IVA ...
// dependen de ese mismo JSON [de DIOT] o caen a createdAt" -- antes de esta
// migración, `GET .../devolucion-iva/facturas/:periodo` resolvía el período con
// `repo.listInvoices({ periodo })`, que a su vez resolvía contra
// `diot.proveedoresReportables` (solo existe para un CFDI tipo "I" con subtotal>0) y
// luego re-filtraba localmente usando esa misma fecha con fallback a `createdAt`. Un
// CFDI tipo "E"/"T"/"P"/"N" (o un "I" con subtotal=0) desaparecía del período por
// completo, sin importar su fecha real -- exactamente el tipo de CFDI que SÍ importa
// para devolución de IVA (facturas de ingreso Y egreso). Este test cubre que ahora
// aparece, usando `invoice.fecha` (migración 006) directamente.
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

function cfdiIngreso(overrides: Record<string, unknown> = {}) {
  return {
    folioFiscal: "11111111-2222-3333-4444-555555555555",
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
    fecha: "2026-07-01T10:00:00",
    fechaTimbrado: "2026-07-01T10:05:00",
    ...overrides,
  };
}

describe("GET /despachos/:propertyId/devolucion-iva/facturas/:periodo", () => {
  it("REQ: incluye un CFDI tipo E (nota de crédito, sin datos de DIOT) del período -- antes desaparecía por completo", async () => {
    const app = buildApp(ctx.deps);

    const ingreso = await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, cfdiIngreso()));
    expect(ingreso.status).toBe(201);

    const notaCredito = await app.request(
      `/despachos/${ctx.propertyId}/cfdi`,
      authedJson(
        ctx.staff.contador.token,
        cfdiIngreso({
          folioFiscal: "aaaaaaaa-2222-3333-4444-555555555555",
          tipo: "E",
          iva: null,
          cfdiRelacionados: ["11111111-2222-3333-4444-555555555555"],
          tipoRelacion: "01",
          fecha: "2026-07-20T10:00:00",
          fechaTimbrado: "2026-07-20T10:05:00",
        }),
      ),
    );
    expect(notaCredito.status).toBe(201);
    const notaCreditoBody = (await notaCredito.json()) as { diot: { reportable: boolean; proveedoresReportables: unknown[] } };
    // Confirma la premisa del hallazgo: un tipo "E" nunca trae datos de DIOT.
    expect(notaCreditoBody.diot.reportable).toBe(false);
    expect(notaCreditoBody.diot.proveedoresReportables).toHaveLength(0);

    const res = await app.request(`/despachos/${ctx.propertyId}/devolucion-iva/facturas/2026-07`, authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { facturas: readonly { uuid: string; tipo: string; fecha: string }[] };

    expect(body.facturas.map((f) => f.uuid).sort()).toEqual(["11111111-2222-3333-4444-555555555555", "aaaaaaaa-2222-3333-4444-555555555555"].sort());
    const egreso = body.facturas.find((f) => f.uuid === "aaaaaaaa-2222-3333-4444-555555555555")!;
    expect(egreso.tipo).toBe("Egreso");
    expect(egreso.fecha).toBe("2026-07-20");
  });

  it("no incluye un CFDI de un período distinto", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, cfdiIngreso({ fecha: "2026-08-01T10:00:00", fechaTimbrado: "2026-08-01T10:05:00" })));

    const res = await app.request(`/despachos/${ctx.propertyId}/devolucion-iva/facturas/2026-07`, authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { facturas: readonly unknown[] };
    expect(body.facturas).toHaveLength(0);
  });
});
