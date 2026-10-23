// D-01 — dashboard gerencial (por cliente y por despacho) y reportes de cliente con
// exportación PDF/Excel: rutas HTTP end-to-end sobre el repositorio en memoria, con
// auth/RLS/roles reales (mismo patrón que despachos-cobranza.spec.ts).
import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "@atiende/db";
import type { InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext, sembrarFichaCliente } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;

// Los fixtures arman repos/motor en memoria; las pruebas de aislamiento necesitan sembrar un segundo despacho.
const coreRepo = () => ctx.deps.coreRepo as InMemoryCoreRepository;
const engine = () => ctx.deps.engine as InMemoryTenancyEngine;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

function hoyMenos(dias: number): string {
  const [y, m, d] = hoyFechaNegocio().split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - dias)).toISOString().slice(0, 10);
}

async function ingestar(overrides: Record<string, unknown> = {}) {
  return ctx.despachosRepo.insertInvoice({
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    folioFiscal: randomUUID(),
    tipo: "I",
    rfcEmisor: "AAA010101AAA",
    rfcReceptor: "CLI010101CL1",
    emisorNombre: "Proveedor Uno SA de CV",
    subtotal: 1000,
    total: 1160,
    iva: 160,
    descuento: 0,
    categoria: "gasto_operativo",
    valido: true,
    issues: [],
    warnings: [],
    requiresHumanReview: false,
    diot: { reportable: true, proveedoresReportables: [{ rfcProveedor: "AAA010101AAA", nombreProveedor: "Proveedor Uno", totalOperacion: "1000", ivaAcreditable: "160", periodo: "2026-08", tasaIva: 0.16 }] },
    fecha: "2026-08-10",
    ...overrides,
  });
}

/** Otro despacho (otra organización) con un contador propio: sirve para probar aislamiento entre tenants. */
async function seedOtroDespacho(): Promise<{ token: string; propertyId: string; slug: string }> {
  const orgId = randomUUID();
  const propertyId = randomUUID();
  const slug = "otro-despacho";
  coreRepo().addOrganization({ id: orgId, slug, name: "Otro Despacho", vertical: "despachos" });
  engine().seedProperty({ id: propertyId, organizationId: orgId });
  ctx.despachosRepo.seedOrganization({ id: orgId, slug, name: "Otro Despacho" });
  ctx.despachosRepo.seedDespachosProperty({ id: propertyId, organizationId: orgId, name: "Sede ajena" });
  const userId = randomUUID();
  const password = "correcto-caballo-batería";
  coreRepo().addStaff({ id: userId, email: "ajeno@otro-despacho.mx", fullName: "Ajeno", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo().addMembership({ userId, organizationId: orgId, platformRole: "admin", verticalRole: "contador", propertyIds: null });
  engine().seedMembership({ userId, organizationId: orgId, platformRole: "admin", verticalRole: "contador", propertyIds: null });
  const res = await buildApp(ctx.deps).request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ajeno@otro-despacho.mx", password }) });
  const { token } = (await res.json()) as { token: string };
  return { token, propertyId, slug };
}

describe("GET /despachos/:propertyId/dashboard", () => {
  it("devuelve los KPIs reales del cliente: cartera vencida, vencimientos, revisiones y CFDI del mes", async () => {
    const app = buildApp(ctx.deps);
    const factura = await ingestar({ fecha: hoyMenos(1), valido: false, requiresHumanReview: true });
    await ctx.despachosRepo.registerReceivable({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, invoiceId: factura.id, fechaVencimiento: hoyMenos(120), clienteEmail: null });
    await ctx.despachosRepo.createDeadline({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, tipo: "IVA", periodo: "2026-08", fechaLimite: hoyMenos(5), prioridad: "critica" });
    await ctx.despachosRepo.createReview({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, invoiceId: factura.id, reason: "revisar" });

    const res = await app.request(`/despachos/${ctx.propertyId}/dashboard`, authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(200);
    const k = (await res.json()) as {
      nombre: string;
      nivelAtencion: string;
      fuentesNoDisponibles: string[];
      cartera: { cuentasPendientes: number; montoPendiente: number; cuentas90Mas: number };
      cargaTrabajo: { revisionesPendientes: number; vencimientosVencidos: number };
      anomalias: { codigo: string }[];
    };
    expect(k.nombre).toBe("Sede principal");
    expect(k.fuentesNoDisponibles).toEqual([]);
    expect(k.cartera).toMatchObject({ cuentasPendientes: 1, montoPendiente: 1160, cuentas90Mas: 1 });
    expect(k.cargaTrabajo).toMatchObject({ revisionesPendientes: 1, vencimientosVencidos: 1 });
    expect(k.nivelAtencion).toBe("critico");
    expect(k.anomalias.map((a) => a.codigo)).toEqual(expect.arrayContaining(["cartera_90_mas", "vencimiento_vencido"]));
  });

  it("los 4 roles pueden leerlo (solo lectura); sin token es 401", async () => {
    const app = buildApp(ctx.deps);
    for (const rol of ["admin", "contador", "auditor", "readonly"] as const) {
      const res = await app.request(`/despachos/${ctx.propertyId}/dashboard`, authedJson(ctx.staff[rol].token));
      expect(res.status, rol).toBe(200);
    }
    expect((await app.request(`/despachos/${ctx.propertyId}/dashboard`)).status).toBe(401);
  });

  it("aislamiento entre despachos: el staff de otra organización recibe 403", async () => {
    const otro = await seedOtroDespacho();
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/dashboard`, authedJson(otro.token));
    expect(res.status).toBe(403);
  });

  it("cliente sin datos: bloques en cero honesto, nunca error", async () => {
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/dashboard`, authedJson(ctx.staff.admin.token));
    const k = (await res.json()) as { cartera: { cuentasPendientes: number; tasaCobranzaPct: number | null }; nivelAtencion: string };
    expect(k.cartera).toMatchObject({ cuentasPendientes: 0, tasaCobranzaPct: null });
    expect(["al_corriente", "atencion"]).toContain(k.nivelAtencion);
  });
});

describe("GET /v1/despachos/:orgSlug/dashboard", () => {
  it("consolida los clientes visibles del despacho con ranking por urgencia", async () => {
    const segunda = randomUUID();
    engine().seedProperty({ id: segunda, organizationId: ctx.organizationId });
    ctx.despachosRepo.seedDespachosProperty({ id: segunda, organizationId: ctx.organizationId, name: "Cliente Dos" });
    await ctx.despachosRepo.createDeadline({ organizationId: ctx.organizationId, propertyId: segunda, tipo: "ISR", periodo: "2026-08", fechaLimite: hoyMenos(3), prioridad: "critica" });

    const res = await buildApp(ctx.deps).request("/v1/despachos/despacho-de-prueba/dashboard", authedJson(ctx.staff.readonly.token));
    expect(res.status).toBe(200);
    const d = (await res.json()) as { organizacion: { slug: string }; totalClientes: number; truncado: boolean; clientesPorNivel: Record<string, number>; ranking: { propertyId: string; nombre: string }[]; cargaTrabajo: { vencimientosVencidos: number } };
    expect(d.organizacion.slug).toBe("despacho-de-prueba");
    expect(d.totalClientes).toBe(2);
    expect(d.truncado).toBe(false);
    expect(d.clientesPorNivel.critico).toBe(1);
    expect(d.ranking[0]).toMatchObject({ propertyId: segunda, nombre: "Cliente Dos" }); // el crítico primero
    expect(d.cargaTrabajo.vencimientosVencidos).toBe(1);
  });

  it("un miembro con alcance acotado solo ve sus clientes", async () => {
    const segunda = randomUUID();
    engine().seedProperty({ id: segunda, organizationId: ctx.organizationId });
    ctx.despachosRepo.seedDespachosProperty({ id: segunda, organizationId: ctx.organizationId, name: "Cliente Dos" });
    // Un contador con alcance acotado: solo la property principal.
    const userId = randomUUID();
    const password = "correcto-caballo-batería";
    coreRepo().addStaff({ id: userId, email: "acotado@despacho-de-prueba.mx", fullName: "Acotado", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo().addMembership({ userId, organizationId: ctx.organizationId, platformRole: "admin", verticalRole: "contador", propertyIds: [ctx.propertyId] });
    engine().seedMembership({ userId, organizationId: ctx.organizationId, platformRole: "admin", verticalRole: "contador", propertyIds: [ctx.propertyId] });
    const login = await buildApp(ctx.deps).request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "acotado@despacho-de-prueba.mx", password }) });
    const { token } = (await login.json()) as { token: string };

    const res = await buildApp(ctx.deps).request("/v1/despachos/despacho-de-prueba/dashboard", authedJson(token));
    const d = (await res.json()) as { totalClientes: number; ranking: { propertyId: string }[] };
    expect(d.ranking.map((c) => c.propertyId)).toEqual([ctx.propertyId]);
    expect(d.totalClientes).toBe(1);
  });

  it("otro despacho: 403; slug inexistente: 404; sin token: 401", async () => {
    const otro = await seedOtroDespacho();
    const app = buildApp(ctx.deps);
    expect((await app.request("/v1/despachos/despacho-de-prueba/dashboard", authedJson(otro.token))).status).toBe(403);
    expect((await app.request("/v1/despachos/no-existe/dashboard", authedJson(ctx.staff.admin.token))).status).toBe(404);
    expect((await app.request("/v1/despachos/despacho-de-prueba/dashboard")).status).toBe(401);
  });
});

describe("GET /despachos/:propertyId/reportes/:tipo", () => {
  beforeEach(async () => {
    // D-P3-01: el RFC del contribuyente de los reportes sale de la ficha de cartera, no de un CFDI.
    await sembrarFichaCliente(ctx, "CLI010101CL1");
  });

  it("D-P3-01: el reporte DIOT excluye la venta del cliente y sin ficha el RFC sale vacio", async () => {
    const app = buildApp(ctx.deps);
    await ingestar();
    await ingestar({ direccion: "emitido", rfcEmisor: "CLI010101CL1", rfcReceptor: "ZZZ010101ZZ1", subtotal: 9000, total: 10440, iva: 1440 });
    const reporte = (await (await app.request(`/despachos/${ctx.propertyId}/reportes/diot?periodo=2026-08`, authedJson(ctx.staff.auditor.token))).json()) as { secciones: { filas: { operaciones: number; montoNeto: number }[] }[]; contribuyente: { rfc: string | null } };
    expect(reporte.secciones[0]!.filas).toHaveLength(1);
    expect(reporte.secciones[0]!.filas[0]).toMatchObject({ operaciones: 1, montoNeto: 1000 });
    expect(reporte.contribuyente.rfc).toBe("CLI010101CL1");

    const sinFicha = await buildDespachosTestContext(buildApp);
    const r2 = (await (await buildApp(sinFicha.deps).request(`/despachos/${sinFicha.propertyId}/reportes/diot?periodo=2026-08`, authedJson(sinFicha.staff.auditor.token))).json()) as { contribuyente: { rfc: string | null }; sinDatos: boolean };
    expect(r2).toMatchObject({ sinDatos: true, contribuyente: { rfc: null } });
  });

  it("DIOT en JSON coincide con GET .../declaraciones/diot/:periodo (misma regla, una sola fuente)", async () => {
    const app = buildApp(ctx.deps);
    await ingestar();
    await ingestar({ subtotal: 500, total: 580, iva: 80 });

    const reporte = (await (await app.request(`/despachos/${ctx.propertyId}/reportes/diot?periodo=2026-08`, authedJson(ctx.staff.auditor.token))).json()) as {
      tipo: string;
      sinDatos: boolean;
      contribuyente: { nombre: string; rfc: string };
      secciones: { filas: { rfc: string; montoNeto: number; iva16: number; operaciones: number }[] }[];
    };
    const diot = (await (await app.request(`/despachos/${ctx.propertyId}/declaraciones/diot/2026-08`, authedJson(ctx.staff.auditor.token))).json()) as { totalMontoNeto: number; totalIvaAcreditable: number; rfcContribuyente: string };

    expect(reporte).toMatchObject({ tipo: "diot", sinDatos: false, contribuyente: { nombre: "Sede principal", rfc: diot.rfcContribuyente } });
    const fila = reporte.secciones[0]!.filas[0]!;
    expect(fila).toMatchObject({ rfc: "AAA010101AAA", operaciones: 2, montoNeto: diot.totalMontoNeto, iva16: diot.totalIvaAcreditable });
  });

  it("los 4 tipos responden 200; sin CFDI del período salen 'sin datos' con motivo", async () => {
    const app = buildApp(ctx.deps);
    for (const tipo of ["balanza", "diot", "nomina", "impuestos"]) {
      const res = await app.request(`/despachos/${ctx.propertyId}/reportes/${tipo}?periodo=2026-08`, authedJson(ctx.staff.readonly.token));
      expect(res.status, tipo).toBe(200);
      const r = (await res.json()) as { sinDatos: boolean; secciones: { sinDatosMotivo: string | null }[] };
      expect(r.sinDatos, tipo).toBe(true);
      expect(r.secciones.some((s) => s.sinDatosMotivo)).toBe(true);
    }
  });

  it("nómina lista solo CFDI tipo N del período y declara sin datos el desglose por empleado", async () => {
    await ingestar({ tipo: "N", total: 8000, subtotal: 8000, iva: null, diot: { reportable: false, proveedoresReportables: [] } });
    await ingestar(); // tipo I: no entra
    const r = (await (await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/reportes/nomina?periodo=2026-08`, authedJson(ctx.staff.contador.token))).json()) as {
      secciones: { filas: unknown[]; totales: { total: number } | null; sinDatosMotivo: string | null }[];
    };
    expect(r.secciones[0]!.filas).toHaveLength(1);
    expect(r.secciones[0]!.totales?.total).toBe(8000);
    expect(r.secciones[1]!.sinDatosMotivo).toContain("no se persiste");
  });

  it("impuestos incluye las obligaciones fiscales del período y solo las de ese período", async () => {
    await ingestar();
    await ctx.despachosRepo.createDeadline({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, tipo: "IVA", periodo: "2026-08", fechaLimite: "2026-09-17", prioridad: "alta" });
    await ctx.despachosRepo.createDeadline({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, tipo: "IVA", periodo: "2026-07", fechaLimite: "2026-08-17", prioridad: "alta" });
    const r = (await (await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/reportes/impuestos?periodo=2026-08`, authedJson(ctx.staff.contador.token))).json()) as {
      secciones: { titulo: string; filas: { fechaLimite: string }[] }[];
    };
    const obl = r.secciones.find((s) => s.titulo.startsWith("Obligaciones"))!;
    expect(obl.filas.map((f) => f.fechaLimite)).toEqual(["2026-09-17"]);
  });

  it("D-P3-05: impuestos lee el papel de pagos provisionales guardado; sin papel dice la verdad y no repite el motivo falso", async () => {
    const app = buildApp(ctx.deps);
    type R = { sinDatos: boolean; secciones: { titulo: string; sinDatosMotivo: string | null; filas: { impuesto?: string; estado?: string; determinado?: number; aCargo?: number }[] }[] };
    const url = `/despachos/${ctx.propertyId}/reportes/impuestos?periodo=2026-08`;
    const sin = (await (await app.request(url, authedJson(ctx.staff.contador.token))).json()) as R;
    expect(sin.secciones[0]!.sinDatosMotivo).toBe("No se ha generado el papel de pagos provisionales de 2026-08: genéralo y guárdalo en Pagos provisionales para ver aquí el IVA y el ISR del periodo.");
    expect(JSON.stringify(sin)).not.toContain("no persiste los CFDI emitidos");

    await ctx.pagosRepo.guardarPapel(ctx.propertyId, { ejercicio: 2026, mes: 8, impuesto: "IVA", regimen: "601", baseCentavos: 1_000_000, determinadoCentavos: 160_000, acreditableCentavos: 64_000, aCargoCentavos: 96_000, aFavorCentavos: 0, parametros: {}, advertencias: 0 });
    await ctx.pagosRepo.guardarPapel(ctx.propertyId, { ejercicio: 2026, mes: 7, impuesto: "IVA", regimen: "601", baseCentavos: 5, determinadoCentavos: 5, acreditableCentavos: 0, aCargoCentavos: 5, aFavorCentavos: 0, parametros: {}, advertencias: 0 });
    const con = (await (await app.request(url, authedJson(ctx.staff.readonly.token))).json()) as R;
    expect(con.sinDatos).toBe(false);
    expect(con.secciones[0]!.filas).toEqual([expect.objectContaining({ impuesto: "IVA", estado: "Borrador", determinado: 1600, aCargo: 960 })]);
  });

  it("formato=xlsx entrega un .xlsx real (ZIP OOXML) con content-type y nombre de archivo", async () => {
    await ingestar();
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/reportes/diot?periodo=2026-08&formato=xlsx`, authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="reporte-diot-2026-08.xlsx"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 2)).toString()).toBe("PK");
    expect(Buffer.from(bytes).includes(Buffer.from("xl/worksheets/sheet2.xml"))).toBe(true);
  });

  it("formato=pdf entrega un PDF real con el contenido del reporte", async () => {
    await ingestar();
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/reportes/diot?periodo=2026-08&formato=pdf`, authedJson(ctx.staff.readonly.token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="reporte-diot-2026-08.pdf"');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    // El contenido está en streams Flate: al menos uno contiene el RFC del proveedor (hex de Tj).
    const latin = bytes.toString("latin1");
    let encontrado = false;
    for (const m of latin.matchAll(/stream\r?\n/g)) {
      const ini = m.index! + m[0].length;
      const fin = latin.indexOf("endstream", ini);
      try {
        if (inflateSync(bytes.subarray(ini, fin)).toString("latin1").includes(Buffer.from("AAA010101AAA", "latin1").toString("hex").toUpperCase().slice(0, 12))) encontrado = true;
      } catch {
        /* no es un stream Flate */
      }
    }
    expect(encontrado).toBe(true);
  });

  it("el período por defecto es el mes anterior de negocio", async () => {
    const r = (await (await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/reportes/diot`, authedJson(ctx.staff.admin.token))).json()) as { periodo: string; generadoEn: string };
    const [y, m] = r.generadoEn.split("-").map(Number) as [number, number];
    expect(r.periodo).toBe(m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`);
  });

  it("valida tipo, periodo y formato (400) y exige sesión (401)", async () => {
    const app = buildApp(ctx.deps);
    const get = (qs: string, tipo = "diot") => app.request(`/despachos/${ctx.propertyId}/reportes/${tipo}${qs}`, authedJson(ctx.staff.admin.token));
    expect((await get("", "inventado")).status).toBe(400);
    expect((await get("?periodo=2026-13")).status).toBe(400);
    expect((await get("?periodo=agosto")).status).toBe(400);
    expect((await get("?periodo=2026-08&formato=docx")).status).toBe(400);
    expect((await app.request(`/despachos/${ctx.propertyId}/reportes/diot`)).status).toBe(401);
  });

  it("base sin la migración 006 (42703 al filtrar CFDI por fecha): 503 honesto, no 500, en los 3 formatos", async () => {
    const original = ctx.despachosRepo.listInvoices.bind(ctx.despachosRepo);
    ctx.despachosRepo.listInvoices = async () => {
      throw Object.assign(new Error('column "fecha" does not exist'), { code: "42703" });
    };
    try {
      const app = buildApp(ctx.deps);
      for (const formato of ["json", "pdf", "xlsx"]) {
        const res = await app.request(`/despachos/${ctx.propertyId}/reportes/diot?periodo=2026-08&formato=${formato}`, authedJson(ctx.staff.admin.token));
        expect(res.status, formato).toBe(503);
        expect(await res.text()).toContain("migración 006");
      }
      // Cualquier OTRO error de Postgres no se enmascara como "no disponible".
      ctx.despachosRepo.listInvoices = async () => {
        throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      };
      expect((await app.request(`/despachos/${ctx.propertyId}/reportes/diot?periodo=2026-08`, authedJson(ctx.staff.admin.token))).status).toBe(500);
    } finally {
      ctx.despachosRepo.listInvoices = original;
    }
  });

  it("aislamiento entre despachos: otro tenant no puede leer ni exportar reportes (403)", async () => {
    await ingestar();
    const otro = await seedOtroDespacho();
    const app = buildApp(ctx.deps);
    for (const formato of ["json", "pdf", "xlsx"]) {
      const res = await app.request(`/despachos/${ctx.propertyId}/reportes/diot?periodo=2026-08&formato=${formato}`, authedJson(otro.token));
      expect(res.status, formato).toBe(403);
    }
  });
});
