// D-03 -- POST /despachos/:propertyId/conciliacion/importar-estado-de-cuenta: vista previa
// de importación de estado de cuenta (CSV/OFX) end-to-end sobre el repositorio en memoria,
// con auth/RLS/roles reales (mismo patrón que despachos-conciliacion.spec.ts).
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "@atiende/db";
import type { InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;
const coreRepo = () => ctx.deps.coreRepo as InMemoryCoreRepository;
const engine = () => ctx.deps.engine as InMemoryTenancyEngine;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

const FOLIO = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

async function ingestarCfdi(total = 1160, fecha = "2026-01-05", folio = FOLIO) {
  return ctx.despachosRepo.insertInvoice({
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    folioFiscal: folio,
    tipo: "I",
    rfcEmisor: "AAA010101AAA",
    rfcReceptor: "CLI010101CL1",
    emisorNombre: "CLIENTE ACME SA DE CV",
    subtotal: total / 1.16,
    total,
    iva: total - total / 1.16,
    descuento: 0,
    categoria: "gasto_operativo",
    valido: true,
    issues: [],
    warnings: [],
    requiresHumanReview: false,
    diot: { reportable: false, proveedoresReportables: [] },
    fecha,
  });
}

const CSV_BBVA = [
  "BBVA México - Estado de cuenta (sintetico)",
  "Fecha Operación;Fecha Valor;Concepto;Cargo;Abono;Saldo",
  "05/01/2026;05/01/2026;SPEI RECIBIDO CLIENTE ACME SA DE CV;;1,160.00;51,160.00",
  "08/01/2026;08/01/2026;PAGO DE NÓMINA;3,000.00;;48,160.00",
  "31/02/2026;31/02/2026;FECHA IMPOSIBLE;1.00;;48,159.00",
].join("\n");

async function importar(token: string, body: unknown, propertyId = ctx.propertyId) {
  return buildApp(ctx.deps).request(`/despachos/${propertyId}/conciliacion/importar-estado-de-cuenta`, authedJson(token, body));
}

interface Vista {
  parseo: { banco: string; movimientos: { hash: string; monto: number; renglon: number }[]; errores: { renglon: number; codigo: string }[]; periodo: { desde: string; hasta: string } | null };
  nuevos: number;
  yaImportados: string[];
  conciliacion: { totalMatched: number } | null;
  conciliacionOmitida: string | null;
  coincidencias: { hash: string; renglon: number; folioFiscal: string[]; cobranzaPendienteIds: string[] }[];
  cobranzaDisponible: boolean;
  libroDisponible: boolean;
}

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

async function guardar(token: string, body: unknown, propertyId = ctx.propertyId) {
  return buildApp(ctx.deps).request(`/despachos/${propertyId}/conciliacion/importar-estado-de-cuenta/guardar`, authedJson(token, body));
}

describe("POST .../conciliacion/importar-estado-de-cuenta", () => {
  it("parsea, reporta errores por renglón y concilia contra el CFDI real con sugerencia de cobranza", async () => {
    const factura = await ingestarCfdi();
    await ctx.despachosRepo.registerReceivable({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, invoiceId: factura.id, fechaVencimiento: "2026-02-05", clienteEmail: null });

    const res = await importar(ctx.staff.contador.token, { contenido: CSV_BBVA });
    expect(res.status).toBe(200);
    const v = (await res.json()) as Vista;

    expect(v.parseo.banco).toBe("bbva");
    expect(v.parseo.movimientos.map((m) => m.monto)).toEqual([1160, -3000]);
    expect(v.parseo.errores).toEqual([expect.objectContaining({ renglon: 5, codigo: "fecha_invalida" })]);
    expect(v.parseo.periodo).toEqual({ desde: "2026-01-05", hasta: "2026-01-08" });
    expect(v.nuevos).toBe(2);
    expect(v.conciliacion?.totalMatched).toBe(1);
    expect(v.coincidencias).toHaveLength(1);
    expect(v.coincidencias[0]).toMatchObject({ hash: v.parseo.movimientos[0]!.hash, renglon: 3, folioFiscal: [FOLIO] });
    expect(v.coincidencias[0]!.cobranzaPendienteIds).toEqual([expect.any(String)]);
    expect(v.cobranzaDisponible).toBe(true);
  });

  it("es solo lectura: importar dos veces da el mismo resultado y no marca nada como pagado", async () => {
    const factura = await ingestarCfdi();
    const cuenta = await ctx.despachosRepo.registerReceivable({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, invoiceId: factura.id, fechaVencimiento: "2026-02-05", clienteEmail: null });
    const a = (await (await importar(ctx.staff.contador.token, { contenido: CSV_BBVA })).json()) as Vista;
    const b = (await (await importar(ctx.staff.contador.token, { contenido: CSV_BBVA })).json()) as Vista;
    expect(b.parseo.movimientos.map((m) => m.hash)).toEqual(a.parseo.movimientos.map((m) => m.hash));
    expect((await ctx.despachosRepo.findReceivable(ctx.propertyId, cuenta.id))?.pagadoEn).toBeNull();
  });

  it("sin CFDI ingeridos: parsea igual y explica por qué no concilió", async () => {
    const v = (await (await importar(ctx.staff.admin.token, { contenido: CSV_BBVA })).json()) as Vista;
    expect(v.parseo.movimientos).toHaveLength(2);
    expect(v.conciliacion).toBeNull();
    expect(v.conciliacionOmitida).toContain("No hay CFDI");
  });

  it("OFX con banco y cuenta indicados por el usuario", async () => {
    const ofx = "<OFX><STMTTRN><DTPOSTED>20260105<TRNAMT>1160.00<NAME>SPEI ACME</STMTTRN></OFX>";
    const res = await importar(ctx.staff.contador.token, { contenido: ofx, banco: "hsbc", cuenta: "021180000123456786" });
    const v = (await res.json()) as Vista;
    expect(res.status).toBe(200);
    expect(v.parseo.banco).toBe("hsbc");
    expect(v.parseo.movimientos).toHaveLength(1);
  });

  it("un archivo sin movimientos válidos responde 200 con los errores, no un 4xx/5xx", async () => {
    const res = await importar(ctx.staff.contador.token, { contenido: "esto,no,es,un,estado\n1,2,3,4,5" });
    expect(res.status).toBe(200);
    const v = (await res.json()) as Vista;
    expect(v.parseo.movimientos).toEqual([]);
    expect(v.parseo.errores.length).toBeGreaterThan(0);
  });

  it("auditor y readonly no pueden importar -- 403", async () => {
    expect((await importar(ctx.staff.auditor.token, { contenido: CSV_BBVA })).status).toBe(403);
    expect((await importar(ctx.staff.readonly.token, { contenido: CSV_BBVA })).status).toBe(403);
  });

  it("sin token -- 401", async () => {
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/conciliacion/importar-estado-de-cuenta`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it.each<[unknown, string]>([
    [{}, "contenido faltante"],
    [{ contenido: "" }, "contenido vacío"],
    [{ contenido: 5 }, "contenido no string"],
    [{ contenido: "a", formato: "xlsx" }, "formato desconocido"],
    [{ contenido: "a", banco: "bancoazteca2" }, "banco desconocido"],
    [{ contenido: "a", cuenta: "x" }, "cuenta demasiado corta"],
    [{ contenido: "a", cuenta: "1234 5678; drop" }, "cuenta con caracteres no permitidos"],
    [{ contenido: "a", dateToleranceDays: "tres" }, "tolerancia no numérica"],
  ])("validación -> 400 (%j: %s)", async (body, _motivo) => {
    expect((await importar(ctx.staff.contador.token, body)).status).toBe(400);
  });

  it("cuerpo mayor al tope (2 MB) -- 413", async () => {
    const res = await importar(ctx.staff.contador.token, { contenido: "x".repeat(2 * 1024 * 1024 + 10) });
    expect(res.status).toBe(413);
  });

  it("aislamiento entre despachos: otro tenant no puede importar ni ver CFDI de esta property (403)", async () => {
    await ingestarCfdi();
    const orgId = randomUUID();
    const propertyId = randomUUID();
    coreRepo().addOrganization({ id: orgId, slug: "otro-despacho", name: "Otro Despacho", vertical: "despachos" });
    engine().seedProperty({ id: propertyId, organizationId: orgId });
    ctx.despachosRepo.seedOrganization({ id: orgId, slug: "otro-despacho", name: "Otro Despacho" });
    ctx.despachosRepo.seedDespachosProperty({ id: propertyId, organizationId: orgId, name: "Sede ajena" });
    const userId = randomUUID();
    const password = "correcto-caballo-batería";
    coreRepo().addStaff({ id: userId, email: "ajeno@otro-despacho.mx", fullName: "Ajeno", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo().addMembership({ userId, organizationId: orgId, platformRole: "admin", verticalRole: "contador", propertyIds: null });
    engine().seedMembership({ userId, organizationId: orgId, platformRole: "admin", verticalRole: "contador", propertyIds: null });
    const login = await buildApp(ctx.deps).request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ajeno@otro-despacho.mx", password }) });
    const { token } = (await login.json()) as { token: string };
    const res = await importar(token, { contenido: CSV_BBVA }, ctx.propertyId);
    expect(res.status).toBe(403);
  });
});

describe("POST .../conciliacion/importar-estado-de-cuenta/guardar (libro idempotente por hash)", () => {
  const CSV_OK = ["Fecha;Concepto;Cargo;Abono;Saldo", "05/01/2026;SPEI RECIBIDO CLIENTE ACME;;1,160.00;51,160.00", "08/01/2026;PAGO DE NÓMINA;3,000.00;;48,160.00"].join("\n");

  it("guarda los movimientos (201) y re-subir el mismo archivo no duplica (200, yaExistentes)", async () => {
    const a = await guardar(ctx.staff.contador.token, { contenido: CSV_OK, banco: "bbva", cuenta: "012180000123456782" });
    expect(a.status).toBe(201);
    expect(await a.json()).toMatchObject({ insertados: 2, yaExistentes: 0, totalMovimientos: 2 });
    const b = await guardar(ctx.staff.contador.token, { contenido: CSV_OK, banco: "bbva", cuenta: "012180000123456782" });
    expect(b.status).toBe(200);
    expect(await b.json()).toMatchObject({ insertados: 0, yaExistentes: 2 });
  });

  it("después de guardar, la vista previa marca los movimientos como ya importados y no los concilia de nuevo", async () => {
    await ingestarCfdi();
    const cuerpo = { contenido: CSV_OK, banco: "bbva", cuenta: "012180000123456782" };
    await guardar(ctx.staff.contador.token, cuerpo);
    const v = (await (await importar(ctx.staff.contador.token, cuerpo)).json()) as Vista;
    expect(v.libroDisponible).toBe(true);
    expect(v.yaImportados).toHaveLength(2);
    expect(v.nuevos).toBe(0);
    expect(v.coincidencias).toEqual([]);
  });

  it("un periodo traslapado solo guarda lo nuevo", async () => {
    await guardar(ctx.staff.contador.token, { contenido: CSV_OK, cuenta: "012180000123456782" });
    const traslapado = ["Fecha;Concepto;Cargo;Abono;Saldo", "08/01/2026;PAGO DE NÓMINA;3,000.00;;48,160.00", "09/01/2026;OTRO;;10.00;48,170.00"].join("\n");
    const r = await guardar(ctx.staff.contador.token, { contenido: traslapado, cuenta: "012180000123456782" });
    expect(await r.json()).toMatchObject({ insertados: 1, yaExistentes: 1 });
  });

  it("todo o nada: un archivo con renglones con error se rechaza (400) y no guarda nada", async () => {
    const malo = CSV_OK + "\n31/02/2026;FECHA IMPOSIBLE;1.00;;1.00";
    const r = await guardar(ctx.staff.contador.token, { contenido: malo });
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toContain("renglón 4");
    const despues = (await (await importar(ctx.staff.contador.token, { contenido: CSV_OK })).json()) as Vista;
    expect(despues.yaImportados).toEqual([]);
  });

  it("sin movimientos que guardar: 400", async () => {
    expect((await guardar(ctx.staff.contador.token, { contenido: "Fecha;Concepto;Cargo;Abono\n" })).status).toBe(400);
  });

  it("auditor y readonly no pueden guardar (403); sin token 401", async () => {
    expect((await guardar(ctx.staff.auditor.token, { contenido: CSV_OK })).status).toBe(403);
    expect((await guardar(ctx.staff.readonly.token, { contenido: CSV_OK })).status).toBe(403);
    const sinToken = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/conciliacion/importar-estado-de-cuenta/guardar`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(sinToken.status).toBe(401);
  });

  it("validaciones del cuerpo -> 400 y tope de 2 MB -> 413", async () => {
    expect((await guardar(ctx.staff.contador.token, { contenido: CSV_OK, banco: "inventado" })).status).toBe(400);
    expect((await guardar(ctx.staff.contador.token, {})).status).toBe(400);
    expect((await guardar(ctx.staff.contador.token, { contenido: "x".repeat(2 * 1024 * 1024 + 10) })).status).toBe(413);
  });

  it("BASE SIN MIGRAR al guardar (42P01): 503 honesto, nunca 500", async () => {
    vi.spyOn(ctx.despachosRepo, "insertEstadoCuentaMovimientos").mockRejectedValue(pgError("42P01", 'relation "despachos.estado_cuenta_movimiento" does not exist'));
    const r = await guardar(ctx.staff.contador.token, { contenido: CSV_OK });
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).toContain("migración 015");
  });

  it("BASE SIN MIGRAR en la vista previa (42P01 al leer el libro): sigue funcionando con libroDisponible=false", async () => {
    vi.spyOn(ctx.despachosRepo, "listEstadoCuentaHashesExistentes").mockRejectedValue(pgError("42P01", 'relation "despachos.estado_cuenta_movimiento" does not exist'));
    const res = await importar(ctx.staff.contador.token, { contenido: CSV_OK });
    expect(res.status).toBe(200);
    const v = (await res.json()) as Vista;
    expect(v.libroDisponible).toBe(false);
    expect(v.parseo.movimientos).toHaveLength(2);
    expect(v.nuevos).toBe(2);
  });

  it("un error real (RLS 42501) al guardar NO se disfraza de 503", async () => {
    vi.spyOn(ctx.despachosRepo, "insertEstadoCuentaMovimientos").mockRejectedValue(pgError("42501", "new row violates row-level security policy"));
    const r = await guardar(ctx.staff.contador.token, { contenido: CSV_OK });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(r.status).not.toBe(503);
  });
});
