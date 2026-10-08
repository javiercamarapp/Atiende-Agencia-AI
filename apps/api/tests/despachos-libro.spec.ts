// D-24 -- libro contable: catalogo, polizas (manual y desde CFDI), reversa, balanza derivada y contabilidad electronica.
// Cubre roles, validacion (centavos enteros, cuadre), periodo cerrado, CFDI duplicado/cancelado, bitacora y base sin migrar (503).
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { validarFichaCliente } from "@atiende/domain-despachos";
import type { NewInvoiceInput } from "@atiende/domain-despachos";
import { buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

function req(token: string, method: string, body?: unknown): RequestInit {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${token}` } };
  if (body !== undefined) {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    init.body = raw;
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    (init.headers as Record<string, string>)["content-length"] = String(new TextEncoder().encode(raw).byteLength);
  }
  return init;
}
const base = () => `/despachos/${ctx.propertyId}/libro`;
const POLIZA = {
  tipo: "ingreso",
  fecha: "2026-07-20",
  concepto: "Honorarios de julio",
  movimientos: [
    { cuenta: "1050000", debe: 116000, haber: 0 },
    { cuenta: "4080000", debe: 0, haber: 100000 },
    { cuenta: "2600400", debe: 0, haber: 16000 },
  ],
};

async function sembrarFicha() {
  const f = validarFichaCliente({ rfc: "CLI010101CL1", razonSocial: "Cliente SA de CV", regimenesFiscales: ["601"], cpFiscal: "06600" });
  if (!f.ok) throw new Error("ficha invalida");
  await ctx.carteraRepo.guardarFicha(ctx.propertyId, f.valor);
}

async function sembrarCfdi(parcial: Partial<NewInvoiceInput> = {}) {
  return ctx.despachosRepo.insertInvoice({
    organizationId: ctx.organizationId, propertyId: ctx.propertyId, folioFiscal: randomUUID(), tipo: "I", rfcEmisor: "CLI010101CL1", rfcReceptor: "RRR010101RR1", emisorNombre: null,
    subtotal: 1000, total: 1160, iva: 160, descuento: 0, categoria: "honorarios", valido: true, issues: [], warnings: [], requiresHumanReview: false,
    diot: { reportable: false } as NewInvoiceInput["diot"], fecha: "2026-07-10", direccion: "emitido", metodoPago: "PUE", moneda: "MXN", subtotalCentavos: 100000, descuentoCentavos: 0,
    totalCentavos: 116000, ivaTrasladadoCentavos: 16000, ...parcial,
  });
}

describe("catalogo de cuentas", () => {
  it("siembra el catalogo base (idempotente) y lo lista", async () => {
    const app = buildApp(ctx.deps);
    const primera = await app.request(`${base()}/catalogo/sembrar`, req(ctx.staff.contador.token, "POST", {}));
    expect(primera.status).toBe(200);
    expect(((await primera.json()) as { agregadas: number }).agregadas).toBeGreaterThan(30);
    expect(((await (await app.request(`${base()}/catalogo/sembrar`, req(ctx.staff.contador.token, "POST", {}))).json()) as { agregadas: number }).agregadas).toBe(0);
    const lista = (await (await app.request(`${base()}/cuentas`, req(ctx.staff.readonly.token, "GET"))).json()) as { estado: string; cuentas: { codigo: string; naturaleza: string }[] };
    expect(lista.estado).toBe("disponible");
    expect(lista.cuentas.find((c) => c.codigo === "2600300")?.naturaleza).toBe("D");
    expect(ctx.auditSink.entries.filter((e) => e.action === "despachos.libro:sembrar-catalogo")).toHaveLength(1);
  });

  it("alta de una cuenta propia con validacion", async () => {
    const app = buildApp(ctx.deps);
    expect((await app.request(`${base()}/cuentas`, req(ctx.staff.admin.token, "PUT", { codigo: "6020900", descripcion: "Gastos varios", naturaleza: "D" }))).status).toBe(200);
    expect((await app.request(`${base()}/cuentas`, req(ctx.staff.admin.token, "PUT", { codigo: "12", descripcion: "x" }))).status).toBe(400);
    expect((await app.request(`${base()}/cuentas`, req(ctx.staff.admin.token, "PUT", { codigo: "6020901", descripcion: "x", naturaleza: "Z" }))).status).toBe(400);
  });
});

describe("polizas manuales", () => {
  it("registra una poliza cuadrada (siembra el catalogo la primera vez), folio 1 y bitacora", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`${base()}/polizas`, req(ctx.staff.contador.token, "POST", POLIZA));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { polizaId: string; folio: number };
    expect(body.folio).toBe(1);
    const detalle = (await (await app.request(`${base()}/polizas/${body.polizaId}`, req(ctx.staff.auditor.token, "GET"))).json()) as { totalCentavos: number; movimientos: unknown[]; origen: string };
    expect(detalle).toMatchObject({ totalCentavos: 116000, origen: "manual" });
    expect(detalle.movimientos).toHaveLength(3);
    const lista = (await (await app.request(`${base()}/polizas?ejercicio=2026&mes=7`, req(ctx.staff.readonly.token, "GET"))).json()) as { polizas: unknown[] };
    expect(lista.polizas).toHaveLength(1);
    expect(ctx.auditSink.entries.some((e) => e.action === "despachos.libro:registrar-poliza" && e.metadata?.folio === 1)).toBe(true);
  });

  it.each([
    ["descuadrada", { ...POLIZA, movimientos: POLIZA.movimientos.slice(0, 2) }],
    ["con decimales (no son centavos)", { ...POLIZA, movimientos: [{ cuenta: "1050000", debe: 10.5, haber: 0 }, { cuenta: "4080000", debe: 0, haber: 10.5 }] }],
    ["fecha imposible", { ...POLIZA, fecha: "2026-02-30" }],
    ["tipo desconocido", { ...POLIZA, tipo: "cobro" }],
  ])("rechaza con 400: %s", async (_n, body) => {
    const res = await buildApp(ctx.deps).request(`${base()}/polizas`, req(ctx.staff.admin.token, "POST", body));
    expect(res.status).toBe(400);
  });

  it("cuenta fuera del catalogo del cliente -> 400 (la base lo repite)", async () => {
    const res = await buildApp(ctx.deps).request(`${base()}/polizas`, req(ctx.staff.admin.token, "POST", { ...POLIZA, movimientos: [{ cuenta: "1050000", debe: 5, haber: 0 }, { cuenta: "9999999", debe: 0, haber: 5 }] }));
    expect(res.status).toBe(400);
  });

  it("periodo cerrado -> 409", async () => {
    ctx.libroRepo.periodosCerrados.add(`${ctx.propertyId}|2026-07`);
    expect((await buildApp(ctx.deps).request(`${base()}/polizas`, req(ctx.staff.admin.token, "POST", POLIZA))).status).toBe(409);
  });

  it("auditor y readonly leen pero NO escriben (403); sin token 401", async () => {
    const app = buildApp(ctx.deps);
    for (const t of [ctx.staff.auditor.token, ctx.staff.readonly.token]) {
      expect((await app.request(`${base()}/polizas`, req(t, "POST", POLIZA))).status).toBe(403);
      expect((await app.request(`${base()}/catalogo/sembrar`, req(t, "POST", {}))).status).toBe(403);
      expect((await app.request(`${base()}/polizas`, req(t, "GET"))).status).toBe(200);
    }
    expect((await app.request(`${base()}/polizas`)).status).toBe(401);
  });

  it("cuerpo hostil: JSON enorme -> 413 y mal formado -> 400", async () => {
    const app = buildApp(ctx.deps);
    const enorme = JSON.stringify({ ...POLIZA, concepto: "x".repeat(200 * 1024) });
    expect((await app.request(`${base()}/polizas`, req(ctx.staff.admin.token, "POST", enorme))).status).toBe(413);
    expect((await app.request(`${base()}/polizas`, req(ctx.staff.admin.token, "POST", "{no es json"))).status).toBe(400);
  });
});

describe("poliza desde un CFDI persistido", () => {
  it("emitido: cargo Clientes, abonos Ingresos e IVA trasladado; el CFDI no se contabiliza dos veces", async () => {
    const f = await sembrarCfdi();
    const app = buildApp(ctx.deps);
    const res = await app.request(`${base()}/polizas/desde-cfdi`, req(ctx.staff.contador.token, "POST", { invoiceId: f.id }));
    expect(res.status).toBe(201);
    const { polizaId } = (await res.json()) as { polizaId: string };
    const det = (await (await app.request(`${base()}/polizas/${polizaId}`, req(ctx.staff.contador.token, "GET"))).json()) as { origen: string; invoiceId: string; movimientos: { cuenta: string; debeCentavos: number; haberCentavos: number }[] };
    expect(det).toMatchObject({ origen: "cfdi", invoiceId: f.id });
    expect(det.movimientos.map((m) => [m.cuenta, m.debeCentavos, m.haberCentavos])).toEqual([["1050000", 116000, 0], ["4080000", 0, 100000], ["2600400", 0, 16000]]);
    expect((await app.request(`${base()}/polizas/desde-cfdi`, req(ctx.staff.contador.token, "POST", { invoiceId: f.id }))).status).toBe(409);
  });

  it("un CFDI que no se puede armar (cancelado, sin sentido) devuelve 409 con el motivo", async () => {
    const f = await sembrarCfdi({ direccion: "indeterminado" });
    const res = await buildApp(ctx.deps).request(`${base()}/polizas/desde-cfdi`, req(ctx.staff.contador.token, "POST", { invoiceId: f.id }));
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toMatch(/emitido o recibido/);
  });

  it("CFDI inexistente -> 404; id mal formado -> 400", async () => {
    const app = buildApp(ctx.deps);
    expect((await app.request(`${base()}/polizas/desde-cfdi`, req(ctx.staff.admin.token, "POST", { invoiceId: randomUUID() }))).status).toBe(404);
    expect((await app.request(`${base()}/polizas/desde-cfdi`, req(ctx.staff.admin.token, "POST", { invoiceId: "no-uuid" }))).status).toBe(400);
  });
});

describe("reversa y balanza", () => {
  it("la reversa deja la balanza en cero y no se repite", async () => {
    const app = buildApp(ctx.deps);
    const creada = (await (await app.request(`${base()}/polizas`, req(ctx.staff.admin.token, "POST", POLIZA))).json()) as { polizaId: string };
    const antes = (await (await app.request(`${base()}/balanza?periodo=2026-07`, req(ctx.staff.admin.token, "GET"))).json()) as { totales: { cuadrada: boolean; debeCentavos: number }; lineas: unknown[] };
    expect(antes.totales).toMatchObject({ cuadrada: true, debeCentavos: 116000 });
    const rev = await app.request(`${base()}/polizas/${creada.polizaId}/reversar`, req(ctx.staff.admin.token, "POST", { fecha: "2026-07-25", concepto: "Corrige captura" }));
    expect(rev.status).toBe(201);
    const despues = (await (await app.request(`${base()}/balanza?periodo=2026-07`, req(ctx.staff.admin.token, "GET"))).json()) as { lineas: { saldoFinalCentavos: number }[] };
    expect(despues.lineas.every((l) => l.saldoFinalCentavos === 0)).toBe(true);
    expect((await app.request(`${base()}/polizas/${creada.polizaId}/reversar`, req(ctx.staff.admin.token, "POST", { fecha: "2026-07-26", concepto: "Otra vez" }))).status).toBe(400);
    expect(ctx.auditSink.entries.some((e) => e.action === "despachos.libro:reversar-poliza")).toBe(true);
  });

  it("reversar: poliza inexistente 404 y datos invalidos 400", async () => {
    const app = buildApp(ctx.deps);
    expect((await app.request(`${base()}/polizas/${randomUUID()}/reversar`, req(ctx.staff.admin.token, "POST", { fecha: "2026-07-25", concepto: "x" }))).status).toBe(404);
    expect((await app.request(`${base()}/polizas/${randomUUID()}/reversar`, req(ctx.staff.admin.token, "POST", { fecha: "2026-13-01", concepto: "x" }))).status).toBe(400);
  });

  it("periodo mal formado -> 400", async () => {
    expect((await buildApp(ctx.deps).request(`${base()}/balanza?periodo=2026-7`, req(ctx.staff.admin.token, "GET"))).status).toBe(400);
  });
});

describe("contabilidad electronica desde el libro", () => {
  it("sin ficha -> 409; con ficha y movimientos devuelve catalogo + balanza XML con SHA-1 y cuadre", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`${base()}/polizas`, req(ctx.staff.admin.token, "POST", POLIZA));
    expect((await app.request(`${base()}/contabilidad-electronica?periodo=2026-07`, req(ctx.staff.admin.token, "GET"))).status).toBe(409);
    await sembrarFicha();
    const res = await app.request(`${base()}/contabilidad-electronica?periodo=2026-07`, req(ctx.staff.admin.token, "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balanza: { xml: string; sha1: string; cuadrada: boolean }; catalogo: { sha1: string }; resumen: { totalDebe: string } };
    expect(body.balanza.cuadrada).toBe(true);
    expect(body.balanza.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(body.balanza.xml).toContain('RFC="CLI010101CL1"');
    expect(body.balanza.xml).toContain('Debe="1160.00"');
    expect(body.resumen.totalDebe).toBe("1160.00");
  });

  it("sin movimientos en el periodo -> 409 (no inventa una balanza vacia)", async () => {
    await sembrarFicha();
    await buildApp(ctx.deps).request(`${base()}/catalogo/sembrar`, req(ctx.staff.admin.token, "POST", {}));
    expect((await buildApp(ctx.deps).request(`${base()}/contabilidad-electronica?periodo=2026-07`, req(ctx.staff.admin.token, "GET"))).status).toBe(409);
  });
});

describe("base sin migrar (migracion 020 pendiente)", () => {
  it("lecturas: estado no_disponible y vacio; escrituras: 503; nunca 500", async () => {
    ctx.libroRepo.disponible = false;
    const app = buildApp(ctx.deps);
    expect(await (await app.request(`${base()}/cuentas`, req(ctx.staff.admin.token, "GET"))).json()).toEqual({ estado: "no_disponible", cuentas: [], sinCodigoAgrupador: 0 });
    expect(((await (await app.request(`${base()}/polizas?ejercicio=2026`, req(ctx.staff.admin.token, "GET"))).json()) as { estado: string }).estado).toBe("no_disponible");
    expect(((await (await app.request(`${base()}/balanza?periodo=2026-07`, req(ctx.staff.admin.token, "GET"))).json()) as { estado: string }).estado).toBe("no_disponible");
    expect((await app.request(`${base()}/polizas`, req(ctx.staff.admin.token, "POST", POLIZA))).status).toBe(503);
    expect((await app.request(`${base()}/catalogo/sembrar`, req(ctx.staff.admin.token, "POST", {}))).status).toBe(503);
  });
});

describe("CFDI del periodo con su poliza", () => {
  it("lista los CFDI del periodo: armable, con poliza, y el motivo cuando no se puede armar sola", async () => {
    const app = buildApp(ctx.deps);
    const listo = await sembrarCfdi();
    const yaContabilizado = await sembrarCfdi({ fecha: "2026-07-11" });
    const sinSentido = await sembrarCfdi({ fecha: "2026-07-12", direccion: "indeterminado" });
    await sembrarCfdi({ fecha: "2026-08-01" }); // otro periodo
    await app.request(`${base()}/polizas/desde-cfdi`, req(ctx.staff.contador.token, "POST", { invoiceId: yaContabilizado.id }));
    const res = await app.request(`${base()}/cfdi?periodo=2026-07`, req(ctx.staff.auditor.token, "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cfdi: { id: string; armable: boolean; motivo: string | null; poliza: { folio: number } | null }[]; truncado: boolean };
    expect(body.truncado).toBe(false);
    expect(body.cfdi).toHaveLength(3);
    expect(body.cfdi.find((x) => x.id === listo.id)).toMatchObject({ armable: true, motivo: null, poliza: null });
    expect(body.cfdi.find((x) => x.id === yaContabilizado.id)).toMatchObject({ armable: false, poliza: { folio: 1 } });
    expect(body.cfdi.find((x) => x.id === sinSentido.id)?.motivo).toMatch(/emitido o recibido/);
  });
  it("periodo mal formado -> 400; sin token -> 401", async () => {
    const app = buildApp(ctx.deps);
    expect((await app.request(`${base()}/cfdi?periodo=julio`, req(ctx.staff.admin.token, "GET"))).status).toBe(400);
    expect((await app.request(`${base()}/cfdi?periodo=2026-07`)).status).toBe(401);
  });
});

describe("reporte de balanza desde el libro (D-01 + D-24)", () => {
  it("con polizas registradas, el reporte de balanza trae las cuentas y totales del libro; sin polizas queda 'sin datos' con su motivo", async () => {
    const app = buildApp(ctx.deps);
    const vacio = (await (await app.request(`/despachos/${ctx.propertyId}/reportes/balanza?periodo=2026-07`, req(ctx.staff.auditor.token, "GET"))).json()) as { secciones: { sinDatosMotivo: string | null }[] };
    expect(vacio.secciones[0]!.sinDatosMotivo).toMatch(/no tiene pólizas/);
    await app.request(`${base()}/polizas`, req(ctx.staff.admin.token, "POST", POLIZA));
    const res = await app.request(`/despachos/${ctx.propertyId}/reportes/balanza?periodo=2026-07`, req(ctx.staff.auditor.token, "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { secciones: { sinDatosMotivo: string | null; filas: { cuenta: string; debe: number; haber: number }[]; totales: { debe: number; haber: number } | null }[] };
    const s = body.secciones[0]!;
    expect(s.sinDatosMotivo).toBeNull();
    expect(s.filas.find((f) => f.cuenta.startsWith("1050000"))).toMatchObject({ debe: 1160, haber: 0 });
    expect(s.totales).toMatchObject({ debe: 1160, haber: 1160 });
  });
  it("base sin migrar (020): el reporte sigue respondiendo 200 con la seccion 'sin datos'", async () => {
    ctx.libroRepo.disponible = false;
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/reportes/balanza?periodo=2026-07`, req(ctx.staff.auditor.token, "GET"));
    expect(res.status).toBe(200);
  });
});
