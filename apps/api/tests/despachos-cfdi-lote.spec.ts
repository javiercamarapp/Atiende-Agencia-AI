// D-13: POST /despachos/:propertyId/cfdi/importar-lote (carga masiva: XML sueltos o ZIP). Doble en memoria del repo; el cuerpo es
// multipart real (FormData) y los ZIP se fabrican con fixtures/zip-builder.ts (incluidos los hostiles).
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "@atiende/db";
import { getTemplate, validarFichaCliente } from "@atiende/domain-despachos";
import type { ResultadoArchivoLote, TotalesLote } from "@atiende/domain-despachos";
import { buildApp } from "../src/app.ts";
import { buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";
import { RFC_CLIENTE, RFC_PROVEEDOR, cfdiXml, cfdiXmlConDtd, nominaXml, repXml } from "./fixtures/cfdi-xml.ts";
import { construirZip } from "./fixtures/zip-builder.ts";

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FOLIO_PPD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOLIO_REP = "99999999-9999-4999-8999-999999999999";

interface ArchivoPrueba {
  readonly nombre: string;
  readonly datos: Uint8Array | string;
  readonly tipo?: string;
}
interface RespuestaLote {
  readonly loteId: string;
  readonly resultados: readonly ResultadoArchivoLote[];
  readonly totales: TotalesLote;
  readonly ignorados: number;
}

function formulario(archivos: readonly ArchivoPrueba[]): FormData {
  const fd = new FormData();
  for (const a of archivos) fd.append("archivos", new File([a.datos as never], a.nombre, { type: a.tipo ?? "application/xml" }));
  return fd;
}
const enviar = (archivos: readonly ArchivoPrueba[], token = ctx.staff.contador.token, propertyId = ctx.propertyId) =>
  buildApp(ctx.deps).request(`/despachos/${propertyId}/cfdi/importar-lote`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: formulario(archivos) });
const zipDe = (entradas: Parameters<typeof construirZip>[0]): ArchivoPrueba => ({ nombre: "sat.zip", datos: construirZip(entradas), tipo: "application/zip" });
const porNombre = (b: RespuestaLote, nombre: string) => b.resultados.find((r) => r.archivo === nombre)!;

async function sembrarFichaYFacturaPpd() {
  const f = validarFichaCliente({ rfc: RFC_CLIENTE, razonSocial: "Cliente SA de CV", regimenesFiscales: ["601"], cpFiscal: "06600" });
  if (!f.ok) throw new Error("ficha invalida");
  await ctx.carteraRepo.guardarFicha(ctx.propertyId, f.valor);
  const inv = await ctx.despachosRepo.insertInvoice({
    organizationId: ctx.organizationId, propertyId: ctx.propertyId, folioFiscal: FOLIO_PPD, tipo: "I", rfcEmisor: RFC_CLIENTE, rfcReceptor: RFC_PROVEEDOR, emisorNombre: null, subtotal: 5000, total: 5800, iva: 800, descuento: 0,
    categoria: "honorarios", valido: true, issues: [], warnings: [], requiresHumanReview: false, diot: { reportable: false } as never, fecha: "2026-06-20", direccion: "emitido", metodoPago: "PPD", moneda: "MXN",
    subtotalCentavos: 500_000, descuentoCentavos: 0, totalCentavos: 580_000, ivaTrasladadoCentavos: 80_000,
  });
  ctx.pagosRepo.sembrarFacturas({
    id: inv.id, folioFiscal: FOLIO_PPD, tipo: "I", valido: true, fecha: "2026-06-20", direccion: "emitido", metodoPago: "PPD", formaPago: "99", usoCfdi: "G03", moneda: "MXN",
    subtotalCentavos: 500_000, descuentoCentavos: 0, totalCentavos: 580_000, ivaTrasladadoCentavos: 80_000, isrRetenidoCentavos: 0, ivaRetenidoCentavos: 0, estadoSat: "vigente",
  });
}

describe("POST .../cfdi/importar-lote — ZIP mixto (criterio de aceptacion)", () => {
  it("3 emitidos + 2 recibidos + 1 REP + 1 duplicado + 1 malicioso con DTD + 1 de nomina producen EXACTAMENTE esos resultados", async () => {
    await sembrarFichaYFacturaPpd();
    const res = await enviar([
      zipDe([
        { nombre: "emitido-1.xml", datos: cfdiXml({ uuid: U(1) }) },
        { nombre: "emitido-2.xml", datos: cfdiXml({ uuid: U(2) }) },
        { nombre: "emitido-3.xml", datos: cfdiXml({ uuid: U(3) }) },
        { nombre: "recibido-1.xml", datos: cfdiXml({ uuid: U(4), emisor: RFC_PROVEEDOR, receptor: RFC_CLIENTE }) },
        { nombre: "recibido-2.xml", datos: cfdiXml({ uuid: U(5), emisor: RFC_PROVEEDOR, receptor: RFC_CLIENTE }) },
        { nombre: "pago.xml", datos: repXml(FOLIO_REP, FOLIO_PPD) },
        { nombre: "emitido-1-copia.xml", datos: cfdiXml({ uuid: U(1) }) },
        { nombre: "malicioso.xml", datos: cfdiXmlConDtd(U(6)) },
        { nombre: "nomina.xml", datos: nominaXml(U(7)) },
      ]),
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RespuestaLote;

    for (const n of ["emitido-1.xml", "emitido-2.xml", "emitido-3.xml", "recibido-1.xml", "recibido-2.xml"]) {
      const r = porNombre(body, n);
      expect(["ingerido", "en_revision"], n).toContain(r.estado);
      expect(r.clase).toBe("cfdi");
    }
    expect(porNombre(body, "pago.xml")).toMatchObject({ estado: "ingerido", clase: "rep", folioFiscal: FOLIO_REP });
    expect(porNombre(body, "pago.xml").motivo).toContain("1 pago(s) registrado(s)");
    expect(porNombre(body, "emitido-1-copia.xml")).toMatchObject({ estado: "duplicado", clase: "cfdi" });
    expect(porNombre(body, "malicioso.xml")).toMatchObject({ estado: "rechazado" });
    expect(porNombre(body, "malicioso.xml").motivo).toMatch(/DTD/);
    expect(porNombre(body, "nomina.xml")).toMatchObject({ estado: "rechazado" });
    expect(porNombre(body, "nomina.xml").motivo).toMatch(/nómina/i);

    expect(body.totales).toMatchObject({ recibidos: 9, duplicados: 1, rechazados: 2, reps: 1 });
    expect(body.totales.ingeridos + body.totales.enRevision).toBe(6);

    // Efecto real en el repo: 5 CFDI nuevos (3 emitidos, 2 recibidos) + el PPD sembrado; el duplicado, el DTD y la nomina NO se guardaron.
    const guardados = (await ctx.despachosRepo.listInvoices(ctx.propertyId)).filter((i) => i.folioFiscal !== FOLIO_PPD);
    expect(guardados).toHaveLength(5);
    expect(guardados.filter((i) => i.direccion === "emitido")).toHaveLength(3);
    expect(guardados.filter((i) => i.direccion === "recibido")).toHaveLength(2);
    const base = await ctx.pagosRepo.leerBase(ctx.propertyId, 2026, 7);
    expect(base.pagos).toHaveLength(1);
    // Una bitacora por lote, sin PII (solo totales).
    const audit = ctx.auditSink.entries.filter((e) => e.action === "despachos.cfdi:importar-lote");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ propertyId: ctx.propertyId, recibidos: 9, duplicados: 1 });
  });

  it("es idempotente: reenviar el mismo ZIP no crea nada nuevo y todo se reporta como 'ya existia'", async () => {
    const zip = zipDe([
      { nombre: "a.xml", datos: cfdiXml({ uuid: U(1) }) },
      { nombre: "b.xml", datos: cfdiXml({ uuid: U(2), emisor: RFC_PROVEEDOR, receptor: RFC_CLIENTE }) },
    ]);
    await enviar([zip]);
    const body = (await (await enviar([zip])).json()) as RespuestaLote;
    expect(body.totales).toMatchObject({ recibidos: 2, duplicados: 2, ingeridos: 0, enRevision: 0, rechazados: 0 });
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(2);
  });
});

describe("POST .../cfdi/importar-lote — XML sueltos (multipart)", () => {
  it("ingiere hasta 50 XML y reporta por archivo; un REP sin la factura ligada se rechaza con motivo; basura no-UTF8 y XML roto tambien", async () => {
    await sembrarFichaYFacturaPpd();
    const res = await enviar([
      { nombre: "ok.xml", datos: cfdiXml({ uuid: U(10) }) },
      { nombre: "rep-ajeno.xml", datos: repXml(FOLIO_REP, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb") },
      { nombre: "roto.xml", datos: "<cfdi:Comprobante" },
      { nombre: "latin1.xml", datos: new Uint8Array([0x3c, 0xe9, 0x3e]) },
      { nombre: "otro-tipo.xml", datos: cfdiXml({ uuid: U(11), tipo: "X" }) },
    ]);
    const body = (await res.json()) as RespuestaLote;
    expect(porNombre(body, "ok.xml").estado).not.toBe("rechazado");
    expect(porNombre(body, "rep-ajeno.xml")).toMatchObject({ estado: "rechazado", clase: "rep" });
    expect(porNombre(body, "rep-ajeno.xml").motivo).toMatch(/No se registró ningún pago/);
    expect(porNombre(body, "roto.xml").estado).toBe("rechazado");
    expect(porNombre(body, "latin1.xml").motivo).toMatch(/UTF-8/);
    expect(porNombre(body, "otro-tipo.xml")).toMatchObject({ estado: "rechazado" });
    expect(porNombre(body, "otro-tipo.xml").motivo).toMatch(/I\|E\|T\|P\|N/);
  });

  it("REP: sin ficha del cliente se rechaza con la instruccion; el rol auditor no puede importar (403) y un REP reenviado es 'duplicado'", async () => {
    const sinFicha = (await (await enviar([{ nombre: "pago.xml", datos: repXml(FOLIO_REP, FOLIO_PPD) }])).json()) as RespuestaLote;
    expect(sinFicha.resultados[0]).toMatchObject({ estado: "rechazado", clase: "rep" });
    expect(sinFicha.resultados[0]!.motivo).toMatch(/ficha del cliente/);
    await sembrarFichaYFacturaPpd();
    await enviar([{ nombre: "pago.xml", datos: repXml(FOLIO_REP, FOLIO_PPD) }]);
    const otra = (await (await enviar([{ nombre: "pago.xml", datos: repXml(FOLIO_REP, FOLIO_PPD) }])).json()) as RespuestaLote;
    expect(otra.resultados[0]).toMatchObject({ estado: "duplicado", clase: "rep" });
  });

  it("mas de 50 XML -> 413; sin archivos -> 400; no multipart -> 400; ZIP mezclado con XML -> 400", async () => {
    const cincuentaYUno = Array.from({ length: 51 }, (_, i) => ({ nombre: `f${i}.xml`, datos: cfdiXml({ uuid: U(100 + i) }) }));
    expect((await enviar(cincuentaYUno)).status).toBe(413);
    expect((await enviar([])).status).toBe(400);
    const json = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/cfdi/importar-lote`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.contador.token}`, "content-type": "application/json" }, body: "{}" });
    expect(json.status).toBe(400);
    expect((await enviar([zipDe([{ nombre: "a.xml", datos: cfdiXml({ uuid: U(1) }) }]), { nombre: "b.xml", datos: cfdiXml({ uuid: U(2) }) }])).status).toBe(400);
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(0);
  });

  it("un XML de mas de 512 KB se rechaza solo a el, no al lote", async () => {
    const grande = cfdiXml({ uuid: U(20) }) + "<!-- " + "x".repeat(520 * 1024) + " -->";
    const body = (await (await enviar([{ nombre: "grande.xml", datos: grande }, { nombre: "ok.xml", datos: cfdiXml({ uuid: U(21) }) }])).json()) as RespuestaLote;
    expect(porNombre(body, "grande.xml")).toMatchObject({ estado: "rechazado" });
    expect(porNombre(body, "grande.xml").motivo).toMatch(/512 KB/);
    expect(porNombre(body, "ok.xml").estado).not.toBe("rechazado");
  });
});

describe("POST .../cfdi/importar-lote — ZIP hostil", () => {
  it("zip-bomb (8 MB de ceros en pocos KB) -> 400 y no se guarda nada; no agota la memoria", async () => {
    const rssAntes = process.memoryUsage().rss;
    const res = await enviar([zipDe([{ nombre: "ok.xml", datos: cfdiXml({ uuid: U(1) }) }, { nombre: "bomba.xml", datos: new Uint8Array(8 * 1024 * 1024) }])]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/512 KB/);
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(0);
    expect(process.memoryUsage().rss - rssAntes).toBeLessThan(96 * 1024 * 1024);
  });

  it.each([
    ["ruta con ..", [{ nombre: "../x.xml", datos: "<a/>" }]],
    ["ZIP anidado", [{ nombre: "otro.zip", datos: "PK" }]],
    ["encabezado que miente", [{ nombre: "x.xml", datos: new Uint8Array(2 * 1024 * 1024), declararDescomprimido: 500 }]],
  ])("%s -> 400 sin guardar nada", async (_t, entradas) => {
    expect((await enviar([zipDe(entradas)])).status).toBe(400);
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(0);
  });

  it("un archivo que no es XML dentro del ZIP se reporta rechazado y no invalida el resto; macOS __MACOSX se ignora", async () => {
    const body = (await (await enviar([zipDe([{ nombre: "a.xml", datos: cfdiXml({ uuid: U(1) }) }, { nombre: "notas.pdf", datos: "pdf" }, { nombre: "__MACOSX/._a.xml", datos: "x" }])])).json()) as RespuestaLote;
    expect(porNombre(body, "notas.pdf")).toMatchObject({ estado: "rechazado", motivo: "No es un archivo XML: se omitió." });
    expect(body.totales.recibidos).toBe(2);
    expect(body.ignorados).toBe(1);
  });
});

describe("POST .../cfdi/importar-lote — periodo cerrado, roles y aislamiento", () => {
  it("un periodo cerrado rechaza SOLO los XML de ese periodo", async () => {
    const { periodo } = await ctx.despachosRepo.insertPeriodoCierre({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, anio: 2026, mes: 7, template: getTemplate() });
    await ctx.despachosRepo.updatePeriodoCierre({ ...periodo, status: "closed" });
    const body = (await (await enviar([
      { nombre: "julio.xml", datos: cfdiXml({ uuid: U(1), fecha: "2026-07-10T10:00:00" }) },
      { nombre: "agosto.xml", datos: cfdiXml({ uuid: U(2), fecha: "2026-08-10T10:00:00" }) },
    ])).json()) as RespuestaLote;
    expect(porNombre(body, "julio.xml")).toMatchObject({ estado: "rechazado" });
    expect(porNombre(body, "julio.xml").motivo).toMatch(/2026-07.*cerrado/);
    expect(porNombre(body, "agosto.xml").estado).not.toBe("rechazado");
    expect((await ctx.despachosRepo.listInvoices(ctx.propertyId)).map((i) => i.folioFiscal)).toEqual([U(2)]);
  });

  it("readonly y auditor no pueden importar (403); sin token 401; admin y contador si", async () => {
    const archivos = [{ nombre: "a.xml", datos: cfdiXml({ uuid: U(1) }) }];
    expect((await enviar(archivos, ctx.staff.readonly.token)).status).toBe(403);
    expect((await enviar(archivos, ctx.staff.auditor.token)).status).toBe(403);
    const sinToken = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/cfdi/importar-lote`, { method: "POST", body: formulario(archivos) });
    expect(sinToken.status).toBe(401);
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(0);
    expect((await enviar(archivos, ctx.staff.admin.token)).status).toBe(200);
  });

  it("cross-tenant: el staff de OTRA organizacion no puede cargar en esta property (403) ni en una property inexistente", async () => {
    const otraOrg = randomUUID();
    const otraProp = randomUUID();
    const userId = randomUUID();
    const password = "correcto-caballo-batería";
    const core = ctx.deps.coreRepo as unknown as { addOrganization(o: unknown): void; addStaff(s: unknown): void; addMembership(m: unknown): void };
    const motor = ctx.deps.engine as unknown as { seedProperty(p: unknown): void; seedMembership(m: unknown): void };
    core.addOrganization({ id: otraOrg, slug: "otro-despacho", name: "Otro Despacho", vertical: "despachos" });
    motor.seedProperty({ id: otraProp, organizationId: otraOrg });
    core.addStaff({ id: userId, email: "intruso@otro.mx", fullName: "intruso", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    core.addMembership({ userId, organizationId: otraOrg, platformRole: "admin", verticalRole: "contador", propertyIds: null });
    motor.seedMembership({ userId, organizationId: otraOrg, platformRole: "admin", verticalRole: "contador", propertyIds: null });
    const login = await buildApp(ctx.deps).request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "intruso@otro.mx", password }) });
    const { token } = (await login.json()) as { token: string };
    const archivos = [{ nombre: "a.xml", datos: cfdiXml({ uuid: U(1) }) }];
    expect((await enviar(archivos, token)).status).toBe(403);
    expect((await enviar(archivos, token, randomUUID())).status).toBe(403);
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(0);
  });
});
