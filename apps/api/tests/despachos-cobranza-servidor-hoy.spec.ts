// REQ-r6 (seguimiento de PR #164, punto 1 -- LADO SERVIDOR): `cobranza.ts::todayIso()`
// usaba el día UTC del proceso -- corrido un día adelante del real en CDMX entre las
// 18:00 y las 23:59 hora local (Vercel corre con TZ=UTC). `diasVencidoCartera` (aging,
// bucket, score) quedaba mal calculado en esa ventana. Fix: `todayIso()` ahora delega en
// `@atiende/core-tenancy::hoyFechaNegocio()`.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

afterEach(() => {
  vi.useRealTimers();
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

// 2026-01-02T04:00:00Z = 2026-01-01T22:00:00 en America/Mexico_City (UTC-6 fijo).
const INSTANTE_22H_CDMX_DIA_1 = "2026-01-02T04:00:00.000Z";

describe("GET /despachos/:propertyId/cobranza/cuentas -- diasVencido usa el día de NEGOCIO", () => {
  it("a las 22:00 CDMX, una cuenta que vence HOY (2026-01-01) da diasVencido: 0, nunca 1", async () => {
    const invoice = await ingestarCfdiIngreso();
    const app = buildApp(ctx.deps);

    const registro = await app.request(
      `/despachos/${ctx.propertyId}/cobranza/cuentas`,
      authedJson(ctx.staff.contador.token, { invoiceId: invoice.id, fechaVencimiento: "2026-01-01" }),
    );
    expect(registro.status).toBe(201);
    const { id } = (await registro.json()) as { id: string };

    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_22H_CDMX_DIA_1));

    const res = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas`, authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; diasVencido: number; bucket: string }[];
    const fila = body.find((r) => r.id === id);
    expect(fila).toBeDefined();
    // Control del bug: con el día UTC roto (mañana), esta cuenta habría quedado con
    // diasVencido: 1 (bucket "0-30" igual, pero el número real es distinto). Con el
    // fix, el día de NEGOCIO sigue siendo el día del vencimiento -> 0.
    expect(fila!.diasVencido).toBe(0);
  });
});
