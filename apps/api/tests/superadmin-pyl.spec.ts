// P&L por vertical y cliente (SA-29): rutas de punta a punta contra los repos en memoria (la
// autorizacion real en SQL se verifica en scripts/verify-superadmin-pyl/ y verify-superadmin-cfo/).
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCfoRepository, InMemoryPylRepository } from "@atiende/db";
import type { BillingSnapshotRow, CfoOrgRow } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { isSensitiveRoute } from "../src/superadmin-seguridad/step-up.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

afterEach(() => vi.useRealTimers());

const T0 = new Date("2026-09-30T12:00:00.000Z").getTime();

function fila(id: string, parche: Partial<CfoOrgRow> = {}): CfoOrgRow {
  return {
    organizationId: id, organizationName: `Org ${id}`, organizationSlug: `org-${id}`, vertical: "restaurantes", orgStatus: "active",
    planId: "restaurantes-estandar", planNombre: "Restaurantes", precioBaseCentavos: 0, precioAsientoCentavos: 79900, asientosIncluidos: 1,
    billingStatus: null, billingSeats: null, sucursalesActivas: 3, // (3 - 1) x 799 = 1,598 MXN
    llmMicroUsd: 4_000_000, vozMicroUsd: 0, whatsappMicroUsd: 0, telefoniaMicroUsd: 0, otrosMicroUsd: 0, // 4 USD x 20 = 80 MXN
    eventosTotal: 0, eventosEstimados: 0, minutosVoz: 0, mensajes: 0, llmCapMicroUsd: 900_000_000, llmAlertPct: 80,
    billingPeriodEndMs: null, limites: [], mxnPorUsd: 20, fxFecha: "2026-09-01", fxFuente: "Banxico FIX", ...parche,
  };
}

const FILAS: CfoOrgRow[] = [
  fila("a"),
  fila("b", { vertical: "hoteles", planId: "hoteles-estandar", planNombre: "Hoteles", precioAsientoCentavos: 8900, asientosIncluidos: 5, sucursalesActivas: 15, vozMicroUsd: 1_000_000 }), // 890 MXN; costo 5 USD = 100 MXN
  fila("d", { vertical: "rentas", planId: "rentas-estandar", planNombre: "Rentas", precioBaseCentavos: null, precioAsientoCentavos: null, asientosIncluidos: 0 }), // sin precio
  fila("e", { orgStatus: "trial", llmMicroUsd: 0 }), // en prueba: ingreso 0 y sin costo -> fuera del P&L
];

const foto = (organizationId: string, mes: string, mrrCentavos: number | null, vertical = "restaurantes"): BillingSnapshotRow => ({
  organizationId, mes, vertical, orgStatus: "active", planId: null, billingStatus: null, mrrCentavos, mrrRazon: mrrCentavos === null ? "sin_plan" : null,
});

async function setup(opciones: { cfo?: InMemoryCfoRepository | null; pyl?: InMemoryPylRepository | null; filas?: CfoOrgRow[]; snapshots?: BillingSnapshotRow[] } = {}) {
  const s = await seguridadSetup();
  const cfo = opciones.cfo === undefined ? new InMemoryCfoRepository() : opciones.cfo;
  cfo?.seedRows(opciones.filas ?? FILAS);
  cfo?.seedSnapshots(opciones.snapshots ?? []);
  const pyl = opciones.pyl === undefined ? new InMemoryPylRepository({ now: () => T0 }) : opciones.pyl;
  const deps = { ...s.deps, ...(cfo ? { cfoRepo: () => cfo } : {}), ...(pyl ? { pylRepo: () => pyl } : {}) };
  const app = buildApp(deps);
  return {
    s, cfo, pyl, app,
    async superadmin() {
      const sa = await s.superadmin();
      cfo?.seedSuperadmin(sa.id);
      pyl?.seedSuperadmin(sa.id);
      return sa;
    },
  };
}

const get = (app: ReturnType<typeof buildApp>, path: string, token: string) => app.request(path, { headers: bearer(token) });
const put = (app: ReturnType<typeof buildApp>, path: string, body: unknown, token: string) =>
  app.request(path, { method: "PUT", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify(body) });

interface PylBody {
  disponible: boolean;
  mensaje?: string;
  mes: string;
  mesPrevio: string;
  infraCapturaDisponible: boolean;
  tipoCambio: { mxnPorUsd: number } | null;
  pyl: {
    infra: { disponible: boolean; totalMxn?: number };
    total: { ingresoMxn: number; cogsDirectoMxn: number | null; infraMxn: number | null; contribucionMxn: number | null; margenBrutoMxn: number | null; organizacionesSinIngreso: number };
    porVertical: Array<{ clave: string; ingresoMxn: number; margenBrutoMxn: number | null; organizacionesSinIngreso: number }>;
    porCliente: Array<{ organizationId: string; ingresoMxn: number | null; ingresoRazon: string | null; cogsDirectoMxn: number | null; infraMxn: number | null }>;
  };
  previo: { total: { ingresoMxn: number } };
  comparativo: { total: { ingreso: { actual: number; previo: number; deltaMxn: number } } };
  movimientoMrr: { disponible: boolean; razon?: string; porVertical?: Array<{ vertical: string; nrr: { expansionMxn?: number; churnMxn?: number } }> };
  supuestos: string[];
}

describe("gateo y validacion", () => {
  it("staff normal 403 y sin token 401 en lectura, exportacion y captura", async () => {
    const t = await setup();
    const st = await t.s.staff();
    expect((await get(t.app, "/superadmin/pyl", st.token)).status).toBe(403);
    expect((await get(t.app, "/superadmin/pyl/export.csv", st.token)).status).toBe(403);
    expect((await put(t.app, "/superadmin/pyl/infra", { mes: "2026-09", concepto: "Vercel", montoMxn: 1 }, st.token)).status).toBe(403);
    expect((await t.app.request("/superadmin/pyl")).status).toBe(401);
  });

  it("valida mes (formato y futuro) y nivel del CSV (400)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup();
    const sa = await t.superadmin();
    expect((await get(t.app, "/superadmin/pyl?mes=2026-13", sa.token)).status).toBe(400);
    expect((await get(t.app, "/superadmin/pyl?mes=septiembre", sa.token)).status).toBe(400);
    expect((await get(t.app, "/superadmin/pyl?mes=2026-10", sa.token)).status).toBe(400);
    expect((await get(t.app, "/superadmin/pyl/export.csv?nivel=todo", sa.token)).status).toBe(400);
  });

  it("la captura de infra es una ruta sensible (step-up)", () => {
    expect(isSensitiveRoute("PUT", "/superadmin/pyl/infra")).toBe(true);
    expect(isSensitiveRoute("GET", "/superadmin/pyl")).toBe(false);
  });
});

describe("base sin migrar", () => {
  it("sin cfoRepo o con 0030 sin aplicar: disponible false con mensaje, CSV 503, nunca 500 ni cifras", async () => {
    for (const cfo of [null, new InMemoryCfoRepository({ migrado: false })]) {
      const t = await setup({ cfo });
      const sa = await t.superadmin();
      const res = await get(t.app, "/superadmin/pyl?mes=2026-09", sa.token);
      expect(res.status).toBe(200);
      const b = (await res.json()) as PylBody;
      expect(b.disponible).toBe(false);
      expect(b.mensaje).toMatch(/0030_superadmin_cfo_dashboard/);
      expect((b as unknown as { pyl?: unknown }).pyl).toBeUndefined();
      expect((await get(t.app, "/superadmin/pyl/export.csv?mes=2026-09", sa.token)).status).toBe(503);
    }
  });

  it("0030 aplicada y 0032 sin aplicar: el P&L se calcula sin infra y la captura responde 503", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    for (const pyl of [null, new InMemoryPylRepository({ migrado: false })]) {
      const t = await setup({ pyl });
      const sa = await t.superadmin();
      const b = (await (await get(t.app, "/superadmin/pyl?mes=2026-09", sa.token)).json()) as PylBody;
      expect(b.disponible).toBe(true);
      expect(b.infraCapturaDisponible).toBe(false);
      expect(b.pyl.infra).toEqual({ disponible: false, razon: "sin_infra_capturada" });
      expect(b.pyl.total.contribucionMxn).not.toBeNull();
      expect(b.pyl.total.margenBrutoMxn).toBeNull();
      expect((await put(t.app, "/superadmin/pyl/infra", { mes: "2026-09", concepto: "Vercel", montoMxn: 100 }, sa.token)).status).toBe(503);
    }
  });
});

describe("GET /superadmin/pyl -- mes en curso", () => {
  it("ingreso por plan vigente, COGS por categoria, infra prorrateada, comparativo y sin ingreso aparte", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup({ snapshots: [foto("a", "2026-08-01", 100_000), foto("b", "2026-08-01", 89_000, "hoteles")] });
    const sa = await t.superadmin();
    t.pyl!.seedCost({ mes: "2026-09-01", concepto: "Vercel + Supabase", montoMxnCentavos: 18_000, nota: null }); // 180 MXN
    const b = (await (await get(t.app, "/superadmin/pyl?mes=2026-09", sa.token)).json()) as PylBody;
    expect(b.disponible).toBe(true);
    expect(b.mesPrevio).toBe("2026-08");
    expect(b.tipoCambio).toMatchObject({ mxnPorUsd: 20 });
    // a 1,598 + b 890; d sin precio; e en prueba fuera
    expect(b.pyl.total.ingresoMxn).toBe(2488);
    expect(b.pyl.total.organizacionesSinIngreso).toBe(1);
    expect(b.pyl.porCliente.map((f) => f.organizationId)).toEqual(["a", "b", "d"]);
    expect(b.pyl.porCliente[2]).toMatchObject({ organizationId: "d", ingresoMxn: null, ingresoRazon: "precio_no_configurado" });
    // costo directo: a 80, b 100, d 80 = 260; infra 180 repartida 80/100/80 -> a 55.38 b 69.23 d 55.38 (suma exacta)
    expect(b.pyl.total.cogsDirectoMxn).toBe(260);
    expect(b.pyl.total.infraMxn).toBe(180);
    expect(b.pyl.porCliente.reduce((s, f) => s + (f.infraMxn ?? 0), 0)).toBeCloseTo(180, 2);
    expect(b.pyl.infra).toMatchObject({ disponible: true, totalMxn: 180 });
    // margenes solo con a y b: ingreso 2488 - cogs 180 = 2308 contribucion
    expect(b.pyl.total.contribucionMxn).toBe(2308);
    expect(b.pyl.porVertical.map((v) => v.clave)).toEqual(["restaurantes", "hoteles", "rentas"]);
    expect(b.pyl.porVertical.find((v) => v.clave === "rentas")).toMatchObject({ ingresoMxn: 0, margenBrutoMxn: null, organizacionesSinIngreso: 1 });
    // previo: fotos de agosto 1,000 + 890
    expect(b.previo.total.ingresoMxn).toBe(1890);
    expect(b.comparativo.total.ingreso).toEqual({ actual: 2488, previo: 1890, deltaMxn: 598, deltaPct: 31.64 });
    // movimiento de MRR: a expandio 598
    expect(b.movimientoMrr.disponible).toBe(true);
    expect(b.movimientoMrr.porVertical!.find((v) => v.vertical === "restaurantes")!.nrr).toMatchObject({ expansionMxn: 598 });
    expect(b.supuestos.some((x) => /Caja, cuentas por cobrar/.test(x))).toBe(true);
  });

  it("sin tipo de cambio: costos y margenes null (el ingreso se conserva); sin foto previa el movimiento no esta disponible", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup({ filas: FILAS.map((f) => ({ ...f, mxnPorUsd: null, fxFecha: null, fxFuente: null })) });
    const sa = await t.superadmin();
    const b = (await (await get(t.app, "/superadmin/pyl?mes=2026-09", sa.token)).json()) as PylBody;
    expect(b.tipoCambio).toBeNull();
    expect(b.pyl.total.ingresoMxn).toBe(2488);
    expect(b.pyl.total.cogsDirectoMxn).toBeNull();
    expect(b.pyl.total.contribucionMxn).toBeNull();
    expect(b.movimientoMrr).toEqual({ disponible: false, razon: "sin_foto_previa" });
    // El mes previo sin fotos tampoco inventa ingreso: ninguna organizacion con ingreso conocido
    expect(b.previo.total.ingresoMxn).toBe(0);
    expect(b.comparativo.total.ingreso.previo).toBe(0);
  });
});

describe("GET /superadmin/pyl -- mes cerrado", () => {
  it("usa la foto guardada del mes (no el plan de hoy); sin foto, ingreso null con razon", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    // agosto: a facturaba 500 (hoy 1,598); b sin foto
    const t = await setup({ snapshots: [foto("a", "2026-08-01", 50_000), foto("a", "2026-07-01", 40_000)] });
    const sa = await t.superadmin();
    const b = (await (await get(t.app, "/superadmin/pyl?mes=2026-08", sa.token)).json()) as PylBody;
    expect(b.pyl.total.ingresoMxn).toBe(500);
    const bFila = b.pyl.porCliente.find((f) => f.organizationId === "b")!;
    expect(bFila).toMatchObject({ ingresoMxn: null, ingresoRazon: "sin_foto_del_mes" });
    // movimiento: foto de julio solo de a (400) -> expansion 100 en restaurantes
    expect(b.movimientoMrr.disponible).toBe(true);
    expect(b.movimientoMrr.porVertical!.find((v) => v.vertical === "restaurantes")!.nrr).toMatchObject({ expansionMxn: 100 });
  });
});

describe("exportacion CSV", () => {
  it("por vertical y por cliente, con BOM, nombre de archivo y nota de lo que no tiene fuente", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup();
    const sa = await t.superadmin();
    const v = await get(t.app, "/superadmin/pyl/export.csv?mes=2026-09&nivel=vertical", sa.token);
    expect(v.status).toBe(200);
    expect(v.headers.get("content-type")).toMatch(/text\/csv/);
    expect(v.headers.get("content-disposition")).toBe('attachment; filename="pyl-vertical-2026-09.csv"');
    const bytes = new Uint8Array(await v.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM UTF-8 para Excel
    const textoV = await v.text(); // el decodificador de texto descarta el BOM
    expect(textoV.startsWith("mes,vertical,organizaciones")).toBe(true);
    expect(textoV).toContain("2026-09,total,3,");
    expect(textoV).toContain("sin infra capturada");
    const c = await get(t.app, "/superadmin/pyl/export.csv?mes=2026-09&nivel=cliente", sa.token);
    const lineas = (await c.text()).replace("\uFEFF", "").trim().split("\r\n");
    expect(lineas[0]).toContain("organizacion_id,cliente,vertical");
    expect(lineas).toHaveLength(4); // encabezado + a, b, d
    expect(lineas.find((l) => l.includes(",Org d,"))).toContain("plan sin precio configurado");
  });
});

describe("PUT /superadmin/pyl/infra", () => {
  it("valida mes, concepto, monto y decimales (400)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup();
    const sa = await t.superadmin();
    const p = (b: unknown) => put(t.app, "/superadmin/pyl/infra", b, sa.token);
    expect((await p({ mes: "2026-10", concepto: "Vercel", montoMxn: 10 })).status).toBe(400);
    expect((await p({ mes: "sep", concepto: "Vercel", montoMxn: 10 })).status).toBe(400);
    expect((await p({ mes: "2026-09", concepto: " ", montoMxn: 10 })).status).toBe(400);
    expect((await p({ mes: "2026-09", concepto: "Vercel", montoMxn: -1 })).status).toBe(400);
    expect((await p({ mes: "2026-09", concepto: "Vercel", montoMxn: "10" })).status).toBe(400);
    expect((await p({ mes: "2026-09", concepto: "Vercel", montoMxn: 10.123 })).status).toBe(400);
    expect((await p({ mes: "2026-09", concepto: "Vercel", montoMxn: 10, nota: "x".repeat(301) })).status).toBe(400);
  });

  it("guarda en centavos exactos y el P&L lo refleja; el mismo concepto se corrige sin duplicar", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup();
    const sa = await t.superadmin();
    expect((await put(t.app, "/superadmin/pyl/infra", { mes: "2026-09", concepto: "Vercel", montoMxn: 1234.56, nota: "factura" }, sa.token)).status).toBe(200);
    expect((await put(t.app, "/superadmin/pyl/infra", { mes: "2026-09", concepto: "vercel", montoMxn: 100.1 }, sa.token)).status).toBe(200);
    const b = (await (await get(t.app, "/superadmin/pyl?mes=2026-09", sa.token)).json()) as PylBody;
    expect(b.infraCapturaDisponible).toBe(true);
    expect(b.pyl.infra).toMatchObject({ disponible: true, totalMxn: 100.1 });
    expect(b.pyl.total.margenBrutoMxn).not.toBeNull();
  });
});
