// D-P3-22 -- portal del cliente: autoaceptado de los XML validos (bandera por cliente, ENCENDIDA por omision), aviso al staff cuando el documento queda pendiente,
// el cliente ve y exporta SUS CFDI (CSV con celdas neutralizadas, bitacora D-38), y el staff acepta un REP por la ruta REP, un duplicado como "ya existia" y avisa EFOS.
// Doble en memoria con las reglas de las funciones de sistema de la migracion 026 (la verdad de seguridad en Postgres real: scripts/verify-despachos-ingesta-libro).
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDefaultRateLimiterForTests } from "@atiende/core-ratelimit";
import { DEFAULT_MONTHLY_CLOSE_TEMPLATE, InMemoryPortalClienteRepository, generarTokenPortal, hashTokenPortal, ingestaPortalDesdeRepositorios, validarFichaCliente } from "@atiende/domain-despachos";
import type { NewInvoiceInput } from "@atiende/domain-despachos";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";
import { RFC_CLIENTE, RFC_PROVEEDOR, repXml } from "./fixtures/cfdi-xml.ts";
import { cfdiXmlClasificable } from "./fixtures/cfdi-xml-clasificable.ts";
import { conEmisiones } from "./support/emisiones.ts";

let ctx: DespachosTestContext;
let repo: InMemoryPortalClienteRepository;
let deps: AppDeps;
let efosLista: { listaDisponible: boolean; situacionPorRfc: Map<string, string> };

const enc = (s: string) => new TextEncoder().encode(s);
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PDF = enc("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF");

beforeEach(async () => {
  resetDefaultRateLimiterForTests();
  ctx = await buildDespachosTestContext(buildApp);
  const f = validarFichaCliente({ rfc: RFC_CLIENTE, razonSocial: "Cliente SA de CV", regimenesFiscales: ["601"], cpFiscal: "06600" });
  if (!f.ok) throw new Error("ficha invalida");
  await ctx.carteraRepo.guardarFicha(ctx.propertyId, f.valor);
  efosLista = { listaDisponible: true, situacionPorRfc: new Map() };
  repo = new InMemoryPortalClienteRepository();
  repo.sembrarCliente({ propertyId: ctx.propertyId, organizationId: ctx.organizationId, clienteNombre: "Cliente SA de CV", despachoNombre: "Despacho de Prueba SC" });
  repo.ingesta = ingestaPortalDesdeRepositorios({ organizationIdDe: () => ctx.organizationId, despachos: ctx.despachosRepo, clasificacion: ctx.clasificacionRepo, cartera: ctx.carteraRepo, efos: () => efosLista });
  deps = { ...ctx.deps, portalClienteRepo: () => repo };
});

async function nuevoToken(): Promise<string> {
  const token = generarTokenPortal();
  await repo.crearEnlace(ctx.propertyId, hashTokenPortal(token), "contacto", 30);
  return token;
}
function subir(token: string, bytes: Uint8Array | string, contentType = "application/xml", nombre = "factura.xml", d: AppDeps = deps) {
  const cuerpo = typeof bytes === "string" ? enc(bytes) : bytes;
  return buildApp(d).request("/portal-cliente/documentos", {
    method: "POST",
    headers: { "x-portal-token": token, "content-type": contentType, "content-length": String(cuerpo.byteLength), "x-nombre-archivo": encodeURIComponent(nombre) },
    body: cuerpo,
  });
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const pendientes = (emisiones: readonly { evento: string }[]) => emisiones.filter((e) => e.evento === "despachos.portal.documento_pendiente");

describe("autoaceptado de XML validos", () => {
  it("un XML valido, de emisor limpio, nuevo, sin hallazgos y bien clasificado se acepta SOLO: crea el CFDI en el cliente del enlace con su clasificacion, queda en bitacora y no avisa", async () => {
    const token = await nuevoToken();
    const { deps: d, emisiones } = conEmisiones(deps);
    const res = await subir(token, cfdiXmlClasificable({ uuid: U(1) }), "application/xml", "factura.xml", d);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ estado: "aceptado", duplicado: false });
    const invoices = await ctx.despachosRepo.listInvoices(ctx.propertyId);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ folioFiscal: U(1), propertyId: ctx.propertyId, direccion: "recibido", requiresHumanReview: false, valido: true });
    const cls = (await ctx.clasificacionRepo.vigentes(ctx.propertyId, [invoices[0]!.id])).datos.get(invoices[0]!.id);
    expect(cls).toMatchObject({ categoria: "servicios_profesionales", metodo: "reglas", clasificadaPor: null });
    expect(repo.documentos[0]).toMatchObject({ estado: "aceptado", invoiceId: invoices[0]!.id });
    expect(pendientes(emisiones)).toHaveLength(0);
    const audit = ctx.auditSink.entries.filter((e) => e.action === "despachos.portal_cliente:documento_autoaceptado");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: null, organizationId: ctx.organizationId, metadata: { propertyId: ctx.propertyId, yaExistia: false, origen: "sistema" } });
    expect(JSON.stringify(audit[0])).not.toContain(token);
    // El cliente ve su documento aceptado en su resumen.
    const resumen = (await (await buildApp(deps).request("/portal-cliente/resumen", { headers: { "x-portal-token": token } })).json()) as { documentos: { estado: string }[] };
    expect(resumen.documentos[0]!.estado).toBe("aceptado");
  });

  it("un UUID que YA existe en el cliente se acepta como 'ya existia' (sin duplicar la factura)", async () => {
    const token = await nuevoToken();
    await subir(token, cfdiXmlClasificable({ uuid: U(2) }));
    const otra = await subir(token, cfdiXmlClasificable({ uuid: U(2), descripcion: "Honorarios por consultoría contable" }), "application/xml", "otra.xml");
    expect(await otra.json()).toMatchObject({ estado: "aceptado" });
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(1);
    expect(repo.documentos.map((d) => d.estado)).toEqual(["aceptado", "aceptado"]);
    expect(ctx.auditSink.entries.filter((e) => e.action === "despachos.portal_cliente:documento_autoaceptado").map((e) => (e.metadata as { yaExistia: boolean }).yaExistia)).toEqual([false, true]);
  });

  it.each([
    ["bandera apagada (portal_autoaceptar_validos = false)", async () => void (await ctx.clasificacionRepo.guardarConfig(ctx.propertyId, ctx.organizationId, { portalAutoaceptar: false })), cfdiXmlClasificable({ uuid: U(3) })],
    ["emisor presunto en la 69-B", async () => void efosLista.situacionPorRfc.set(RFC_PROVEEDOR, "presunto"), cfdiXmlClasificable({ uuid: U(4) })],
    ["emisor definitivo en la 69-B", async () => void efosLista.situacionPorRfc.set(RFC_PROVEEDOR, "definitivo"), cfdiXmlClasificable({ uuid: U(5) })],
    ["la lista 69-B nunca se ingirio (no figurar NO es estar limpio)", async () => void (efosLista.listaDisponible = false), cfdiXmlClasificable({ uuid: U(6) })],
    ["con hallazgos del motor fiscal (total que no cuadra)", async () => undefined, cfdiXmlClasificable({ uuid: U(7), total: "1500.00" })],
    ["sin sello", async () => undefined, cfdiXmlClasificable({ uuid: U(8), sello: "" })],
    ["clasificacion dudosa (empate)", async () => undefined, cfdiXmlClasificable({ uuid: U(9), descripcion: "Renta de laptop" })],
    ["clasificacion sin coincidencias (otros 0.30)", async () => undefined, cfdiXmlClasificable({ uuid: U(10), descripcion: "Concepto 7788" })],
    ["nota de credito (tipo E)", async () => undefined, cfdiXmlClasificable({ uuid: U(11), tipo: "E" })],
    ["complemento de pago (REP)", async () => undefined, repXml(U(12), U(13))],
  ])("NO se acepta solo y queda pendiente con aviso al staff: %s", async (_n, preparar, xml) => {
    await preparar();
    const token = await nuevoToken();
    const { deps: d, emisiones } = conEmisiones(deps);
    const res = await subir(token, xml, "application/xml", "f.xml", d);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ estado: "recibido" });
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(0);
    expect(repo.documentos[0]!.estado).toBe("recibido");
    const e = pendientes(emisiones);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, categoria: "aprobaciones", enlace: "/despachos/{orgSlug}/portal-cliente", dedupeKey: `despachos.portal.documento_pendiente:${repo.documentos[0]!.id}`, roles: ["contador"] });
    expect(JSON.stringify(e[0])).not.toMatch(/EMISOR DE PRUEBA|CON950820K12|factura/);
  });

  it("periodo cerrado: queda pendiente (no se escribe en un periodo cerrado)", async () => {
    const { periodo } = await ctx.despachosRepo.insertPeriodoCierre({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, anio: 2026, mes: 7, template: DEFAULT_MONTHLY_CLOSE_TEMPLATE });
    await ctx.despachosRepo.updatePeriodoCierre({ ...periodo, status: "closed" });
    const token = await nuevoToken();
    const res = await subir(token, cfdiXmlClasificable({ uuid: U(14) }));
    expect(await res.json()).toMatchObject({ estado: "recibido" });
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(0);
  });

  it("un XML cuyo emisor y receptor NO son el RFC de la ficha (direccion indeterminada) no se acepta solo: queda pendiente para el staff", async () => {
    const token = await nuevoToken();
    const res = await subir(token, cfdiXmlClasificable({ uuid: U(15), receptor: "XAXX010101000" }));
    expect(await res.json()).toMatchObject({ estado: "recibido" });
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(0);
  });

  it("un PDF o una imagen nunca se aceptan solos: pendientes con aviso; reenviar el mismo archivo (replay) no avisa otra vez", async () => {
    const token = await nuevoToken();
    const { deps: d, emisiones } = conEmisiones(deps);
    expect(await (await subir(token, PDF, "application/pdf", "constancia.pdf", d)).json()).toMatchObject({ estado: "recibido" });
    const replay = await subir(token, PDF, "application/pdf", "constancia.pdf", d);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ duplicado: true });
    expect(pendientes(emisiones)).toHaveLength(1);
  });

  it("base sin migrar: la recepcion sigue y el documento queda pendiente (el autoaceptado y el aviso son best-effort), nunca un 5xx", async () => {
    const token = await nuevoToken();
    const roto: AppDeps = { ...deps, portalClienteRepo: () => Object.assign(Object.create(repo) as InMemoryPortalClienteRepository, { contextoIngesta: async () => ({ disponible: false }) as const }) };
    const res = await subir(token, cfdiXmlClasificable({ uuid: U(15) }), "application/xml", "f.xml", roto);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ estado: "recibido" });
  });

  it("un fallo inesperado al aceptar NO tumba la recepcion: queda pendiente y el cliente recibe 201", async () => {
    const token = await nuevoToken();
    const roto: AppDeps = {
      ...deps,
      portalClienteRepo: () =>
        Object.assign(Object.create(repo) as InMemoryPortalClienteRepository, {
          aceptarCfdiSistema: async () => {
            throw Object.assign(new Error("boom"), { code: "XX000" });
          },
        }),
    };
    const res = await subir(token, cfdiXmlClasificable({ uuid: U(16) }), "application/xml", "f.xml", roto);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ estado: "recibido" });
  });
});

describe("GET /portal-cliente/cfdi -- el cliente ve y exporta sus CFDI", () => {
  async function sembrar(parcial: Partial<NewInvoiceInput> = {}, propertyId = ctx.propertyId) {
    return ctx.despachosRepo.insertInvoice({
      organizationId: ctx.organizationId, propertyId, folioFiscal: randomUUID(), tipo: "I", rfcEmisor: RFC_PROVEEDOR, rfcReceptor: RFC_CLIENTE, emisorNombre: "Proveedor SA", subtotal: 1000, total: 1160, iva: 160, descuento: 0,
      categoria: "sin_clasificar", valido: true, issues: [], warnings: [], requiresHumanReview: false, diot: { reportable: false } as NewInvoiceInput["diot"], fecha: "2026-07-10", direccion: "recibido", metodoPago: "PUE", moneda: "MXN",
      subtotalCentavos: 100000, descuentoCentavos: 0, totalCentavos: 116000, ivaTrasladadoCentavos: 16000, ...parcial,
    });
  }

  it("lista SOLO los CFDI de SU cliente (nunca los de otro cliente, ni de otro despacho), con la marca de excluido; sin token o con token malo 404 generico", async () => {
    const token = await nuevoToken();
    await sembrar();
    const rechazado = await sembrar();
    const rev = await ctx.despachosRepo.createReview({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, invoiceId: rechazado.id, reason: "x" });
    await ctx.despachosRepo.resolveReview(ctx.propertyId, rev.id, ctx.staff.contador.id, "rechazado", null);
    await sembrar({ folioFiscal: U(90) }, randomUUID()); // otro cliente
    const res = await buildApp(deps).request("/portal-cliente/cfdi", { headers: { "x-portal-token": token } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { cfdi: { id: string; excluido: boolean; folioFiscal: string; totalCentavos: number }[] };
    expect(body.cfdi).toHaveLength(2);
    expect(body.cfdi.find((c) => c.id === rechazado.id)?.excluido).toBe(true);
    expect(body.cfdi.some((c) => c.folioFiscal === U(90))).toBe(false);
    expect(body.cfdi[0]!.totalCentavos).toBe(116000);
    expect((await buildApp(deps).request("/portal-cliente/cfdi")).status).toBe(404);
    expect((await buildApp(deps).request("/portal-cliente/cfdi", { headers: { "x-portal-token": generarTokenPortal() } })).status).toBe(404);
  });

  it("?formato=csv exporta con BOM y CRLF, neutraliza celdas que empiezan con = + - @ (inyeccion de formulas) y deja bitacora sin el token (D-38)", async () => {
    const token = await nuevoToken();
    await sembrar({ emisorNombre: '=HYPERLINK("http://x","clic")' });
    await sembrar({ emisorNombre: "+cmd|' /C calc'!A0" });
    await sembrar({ emisorNombre: "Proveedor, SA \"de\" CV" });
    const res = await buildApp(deps).request("/portal-cliente/cfdi?formato=csv", { headers: { "x-portal-token": token } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM UTF-8 (fetch lo quita de res.text(), por eso se lee en bytes)
    const csv = await res.text();
    expect(csv.startsWith("Fecha,Tipo,Sentido,UUID,")).toBe(true);
    expect(csv).toContain("\r\n");
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain(",'+cmd|' /C calc'!A0,"); // neutralizada: comilla simple al frente
    expect(csv).toContain('"Proveedor, SA ""de"" CV"');
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
    const filas = csv.trim().split("\r\n");
    expect(filas).toHaveLength(4);
    expect(filas[1]).toContain("1160.00");
    const audit = ctx.auditSink.entries.filter((e) => e.action === "despachos.portal_cliente:cfdi_exportado");
    expect(audit).toMatchObject([{ actorUserId: null, organizationId: ctx.organizationId, metadata: { propertyId: ctx.propertyId, filas: 3, formato: "csv", origen: "portal_cliente" } }]);
    expect(JSON.stringify(ctx.auditSink.entries)).not.toContain(token);
    await buildApp(deps).request("/portal-cliente/cfdi", { headers: { "x-portal-token": token } });
    expect(ctx.auditSink.entries.some((e) => e.action === "despachos.portal_cliente:cfdi_consultado")).toBe(true);
  });

  it("base sin migrar: 503 honesto (nunca 500) y el token se valida igual", async () => {
    const token = await nuevoToken();
    repo.disponible = false;
    expect((await buildApp(deps).request("/portal-cliente/cfdi", { headers: { "x-portal-token": token } })).status).toBe(503);
  });
});

describe("aceptar un documento del portal (staff)", () => {
  const aceptar = (id: string) => buildApp(deps).request(`/despachos/${ctx.propertyId}/portal-cliente/documentos/${id}/aceptar`, { method: "POST", headers: auth(ctx.staff.contador.token) });

  it("un REP se ingiere por la ruta REP (registra el pago), no como factura: el documento queda aceptado sin invoice y el pago existe", async () => {
    const FOLIO_PPD = U(50);
    const inv = await ctx.despachosRepo.insertInvoice({
      organizationId: ctx.organizationId, propertyId: ctx.propertyId, folioFiscal: FOLIO_PPD, tipo: "I", rfcEmisor: RFC_CLIENTE, rfcReceptor: RFC_PROVEEDOR, emisorNombre: null, subtotal: 5000, total: 5800, iva: 800, descuento: 0,
      categoria: "honorarios", valido: true, issues: [], warnings: [], requiresHumanReview: false, diot: { reportable: false } as never, fecha: "2026-06-20", direccion: "emitido", metodoPago: "PPD", moneda: "MXN",
      subtotalCentavos: 500_000, descuentoCentavos: 0, totalCentavos: 580_000, ivaTrasladadoCentavos: 80_000,
    });
    ctx.pagosRepo.sembrarFacturas({
      id: inv.id, folioFiscal: FOLIO_PPD, tipo: "I", valido: true, fecha: "2026-06-20", direccion: "emitido", metodoPago: "PPD", formaPago: "99", usoCfdi: "G03", moneda: "MXN",
      subtotalCentavos: 500_000, descuentoCentavos: 0, totalCentavos: 580_000, ivaTrasladadoCentavos: 80_000, isrRetenidoCentavos: 0, ivaRetenidoCentavos: 0, estadoSat: "vigente",
    });
    const token = await nuevoToken();
    await subir(token, repXml(U(51), FOLIO_PPD), "application/xml", "pago.xml");
    const id = repo.documentos[0]!.id;
    const res = await aceptar(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ estado: "aceptado", invoiceId: null, cfdi: null, rep: { registrados: 1, yaExistian: 0 } });
    expect((await ctx.pagosRepo.leerBase(ctx.propertyId, 2026, 7)).pagos).toHaveLength(1);
    expect(repo.documentos[0]!.estado).toBe("aceptado");
    // Aceptarlo de nuevo no se puede (ya resuelto) y el pago no se duplica.
    expect((await aceptar(id)).status).toBe(409);
    expect((await ctx.pagosRepo.leerBase(ctx.propertyId, 2026, 7)).pagos).toHaveLength(1);
  });

  it("un REP que no se puede ligar a ninguna factura del cliente NO se acepta: 409 con el motivo y el documento sigue pendiente", async () => {
    const token = await nuevoToken();
    await subir(token, repXml(U(52), U(53)), "application/xml", "pago.xml");
    const res = await aceptar(repo.documentos[0]!.id);
    expect(res.status).toBe(409);
    expect(repo.documentos[0]!.estado).toBe("recibido");
  });

  it("aceptar un CFDI nuevo avisa EFOS (emisor presunto) y la revision pendiente con la campana del dia; un duplicado no vuelve a avisar", async () => {
    // El motor marca EFOS cuando la lista del despacho trae al emisor: se siembra en el repo de despachos.
    await ctx.despachosRepo.ingestarListaEfos("2026-07", "a".repeat(64), [{ rfc: RFC_PROVEEDOR, nombre: "EMISOR", situacion: "presunto", oficioPresuncion: null, fechaPresuncionSat: "2026-01-01", fechaDesvirtuadoSat: null, fechaDefinitivoSat: null, fechaSentenciaFavorableSat: null }] as never).catch(() => undefined);
    efosLista.situacionPorRfc.set(RFC_PROVEEDOR, "presunto");
    const token = await nuevoToken();
    await subir(token, cfdiXmlClasificable({ uuid: U(60) }));
    const { deps: d, emisiones } = conEmisiones(deps);
    const res = await buildApp(d).request(`/despachos/${ctx.propertyId}/portal-cliente/documentos/${repo.documentos[0]!.id}/aceptar`, { method: "POST", headers: auth(ctx.staff.contador.token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ estado: "aceptado", cfdi: { duplicado: false } });
    expect(emisiones.some((e) => e.evento === "despachos.cfdi.requiere_revision")).toBe(true);
  });
});
