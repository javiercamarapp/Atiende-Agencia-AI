// D-P3-13/18/23 -- clasificacion contable al ingerir, correcciones por RFC, umbral por cliente, UUID por cliente y direccion al capturar la ficha.
// Sin LLM: reglas + ClaveProdServ. Cubre la compuerta (piso 0.5 / umbral), el empate que SIEMPRE revisa, la regla persistida por RFC, nunca un update silencioso,
// roles, base sin migrar (la ingesta sigue igual) y avisos in-app sin PII.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { validarFichaCliente } from "@atiende/domain-despachos";
import { buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";
import { RFC_CLIENTE, RFC_PROVEEDOR } from "./fixtures/cfdi-xml.ts";
import { cfdiXmlClasificable } from "./fixtures/cfdi-xml-clasificable.ts";
import { conEmisiones } from "./support/emisiones.ts";

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = () => `/despachos/${ctx.propertyId}`;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function importar(xml: string, token = ctx.staff.contador.token, deps = ctx.deps, propertyId = ctx.propertyId) {
  return buildApp(deps).request(`/despachos/${propertyId}/cfdi/importar-xml`, { method: "POST", headers: { ...auth(token), "content-type": "application/xml", "content-length": String(new TextEncoder().encode(xml).byteLength) }, body: xml });
}
function json(token: string, metodo: string, ruta: string, cuerpo?: unknown, deps = ctx.deps) {
  const raw = cuerpo === undefined ? undefined : JSON.stringify(cuerpo);
  return buildApp(deps).request(ruta, { method: metodo, headers: { ...auth(token), ...(raw ? { "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) } : {}) }, body: raw });
}
async function sembrarFicha(rfc = RFC_CLIENTE) {
  const f = validarFichaCliente({ rfc, razonSocial: "Cliente SA de CV", regimenesFiscales: ["601"], cpFiscal: "06600" });
  if (!f.ok) throw new Error("ficha invalida");
  await ctx.carteraRepo.guardarFicha(ctx.propertyId, f.valor);
}
interface RespuestaIngesta {
  id: string;
  duplicado: boolean;
  requiereRevisionHumana: boolean;
  clasificacion: { categoria: string; metodo: string; confianza: number; empate: boolean; requiereRevision: boolean } | null;
}
const motivo = async (invoiceId: string) => (await ctx.despachosRepo.listPendingReviews(ctx.propertyId)).find((r) => r.invoiceId === invoiceId)?.reason ?? "";

describe("ingesta: clasificacion y compuerta de revision", () => {
  it("descripcion clara: clasifica por palabras (servicios_profesionales, 0.95), la escribe como fila del CFDI y NO agrega clasificacion_baja", async () => {
    await sembrarFicha();
    const res = await importar(cfdiXmlClasificable({ uuid: U(1) }));
    expect(res.status).toBe(201);
    const r = (await res.json()) as RespuestaIngesta;
    expect(r.clasificacion).toMatchObject({ categoria: "servicios_profesionales", metodo: "reglas", empate: false, requiereRevision: false });
    expect(r.clasificacion!.confianza).toBeCloseTo(0.95, 2);
    const vigente = (await ctx.clasificacionRepo.vigentes(ctx.propertyId, [r.id])).datos.get(r.id);
    expect(vigente).toMatchObject({ categoria: "servicios_profesionales", metodo: "reglas", clasificadaPor: null });
    // La revision que ya pedia el motor fiscal (proveedor reportable en DIOT) no menciona la clasificacion.
    expect(await motivo(r.id)).not.toContain("clasificacion_baja");
  });

  it("empate («Renta de laptop»): confianza 0.45, SIEMPRE a revision con motivo clasificacion_baja, aun con umbral bajo", async () => {
    await sembrarFicha();
    await json(ctx.staff.admin.token, "PUT", `${base()}/clasificacion/ajustes`, { umbralConfianza: 0.5 });
    const r = (await (await importar(cfdiXmlClasificable({ uuid: U(2), descripcion: "Renta de laptop" }))).json()) as RespuestaIngesta;
    expect(r.clasificacion).toMatchObject({ empate: true, requiereRevision: true });
    expect(r.clasificacion!.confianza).toBeCloseTo(0.45, 2);
    expect(r.requiereRevisionHumana).toBe(true);
    expect(await motivo(r.id)).toContain("clasificacion_baja");
    expect(await motivo(r.id)).toContain("empate");
  });

  it("sin descripcion util ni ClaveProdServ: otros con 0.30, a revision (nunca se inventa una categoria)", async () => {
    await sembrarFicha();
    const r = (await (await importar(cfdiXmlClasificable({ uuid: U(3), descripcion: "Concepto 7788" }))).json()) as RespuestaIngesta;
    expect(r.clasificacion).toMatchObject({ categoria: "otros", requiereRevision: true });
    expect(await motivo(r.id)).toContain("clasificacion_baja");
  });

  it("ClaveProdServ conocida sola (equipo de computo) llega a 0.80 y pasa el umbral 0.7; con umbral 0.9 del despacho va a revision", async () => {
    await sembrarFicha();
    const a = (await (await importar(cfdiXmlClasificable({ uuid: U(4), descripcion: "Articulo 7788", claveProdServ: "43211503" }))).json()) as RespuestaIngesta;
    expect(a.clasificacion).toMatchObject({ categoria: "equipo_computo", metodo: "claveprodserv", requiereRevision: false });
    expect(await ctx.clasificacionRepo.guardarConfig(ctx.propertyId, ctx.organizationId, { umbral: 0.9 })).toMatchObject({ umbral: 0.9 });
    const b = (await (await importar(cfdiXmlClasificable({ uuid: U(5), descripcion: "Articulo 7788", claveProdServ: "43211503" }))).json()) as RespuestaIngesta;
    expect(b.clasificacion).toMatchObject({ requiereRevision: true });
    expect(await motivo(b.id)).toContain("clasificacion_baja");
  });

  it("un comprobante EMITIDO (venta del cliente) se clasifica pero no pasa por la compuerta: su categoria no decide ninguna poliza", async () => {
    await sembrarFicha();
    const r = (await (await importar(cfdiXmlClasificable({ uuid: U(6), emisor: RFC_CLIENTE, receptor: RFC_PROVEEDOR, descripcion: "Concepto 7788" }))).json()) as RespuestaIngesta;
    expect(r.clasificacion).not.toBeNull();
    expect(r.clasificacion!.requiereRevision).toBe(false);
    expect(await motivo(r.id)).not.toContain("clasificacion_baja");
  });

  it("nota de credito (E): no se clasifica sola (clasificacion null) y su revision es la de siempre", async () => {
    await sembrarFicha();
    const r = (await (await importar(cfdiXmlClasificable({ uuid: U(7), tipo: "E" }))).json()) as RespuestaIngesta;
    expect(r.clasificacion).toBeNull();
    expect(r.requiereRevisionHumana).toBe(true);
    expect((await ctx.clasificacionRepo.vigentes(ctx.propertyId, [r.id])).datos.size).toBe(0);
  });

  it("POST /cfdi (JSON) con categoria explicita es una decision humana: fila manual de confianza 1, sin compuerta; sin categoria, por palabras de los conceptos", async () => {
    const cuerpo = (folio: string, extra: Record<string, unknown>) => ({
      folioFiscal: folio, tipo: "I", subtotal: 1000, total: 1160, descuento: 0, iva: 160, usoCfdi: "G03", formaPago: "03", metodoPago: "PUE", regimenFiscalEmisor: "601", rfcEmisor: RFC_PROVEEDOR, rfcReceptor: RFC_CLIENTE,
      tieneSello: true, noCertificado: "00001000000504465028", fecha: "2026-07-01T10:00:00", fechaTimbrado: "2026-07-01T10:05:00", ...extra,
    });
    await sembrarFicha();
    const manual = (await (await json(ctx.staff.contador.token, "POST", `${base()}/cfdi`, cuerpo(U(8), { categoria: "honorarios", conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000 }] }))).json()) as RespuestaIngesta;
    expect(manual.clasificacion).toMatchObject({ metodo: "manual", confianza: 1, categoria: "honorarios", requiereRevision: false });
    const auto = (await (await json(ctx.staff.contador.token, "POST", `${base()}/cfdi`, cuerpo(U(9), { conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000, descripcion: "Servicio de internet y fibra óptica", claveProdServ: "81161701" }] }))).json()) as RespuestaIngesta;
    expect(auto.clasificacion).toMatchObject({ categoria: "telefonia", metodo: "claveprodserv" });
    const invalido = await json(ctx.staff.contador.token, "POST", `${base()}/cfdi`, cuerpo(U(10), { conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000, claveProdServ: "12" }] }));
    expect(invalido.status).toBe(400);
  });

  it("base SIN migrar (026 pendiente): la ingesta es la de siempre -- sin clasificacion, sin compuerta, mismo 201", async () => {
    await sembrarFicha();
    ctx.clasificacionRepo.disponible = false;
    const res = await importar(cfdiXmlClasificable({ uuid: U(11), descripcion: "Renta de laptop" }));
    expect(res.status).toBe(201);
    const r = (await res.json()) as RespuestaIngesta;
    expect(r.clasificacion).toBeNull();
    expect(await motivo(r.id)).not.toContain("clasificacion_baja");
  });
});

describe("PUT /cfdi/:invoiceId/categoria y reglas por RFC", () => {
  async function ingerirDudoso(n: number, descripcion = "Renta de laptop") {
    return (await (await importar(cfdiXmlClasificable({ uuid: U(n), descripcion }))).json()) as RespuestaIngesta;
  }

  it("corrige la categoria: fila NUEVA (la anterior queda en el historial), method manual, confianza 1, bitacora y detalle con historial", async () => {
    await sembrarFicha();
    const dudoso = await ingerirDudoso(20);
    const res = await json(ctx.staff.contador.token, "PUT", `${base()}/cfdi/${dudoso.id}/categoria`, { categoria: "equipo_computo", cuenta: "1600000" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ clasificacion: { categoria: "equipo_computo", metodo: "manual", confianza: 1, cuenta: "1600000", porPersona: true } });
    const detalle = (await (await buildApp(ctx.deps).request(`${base()}/cfdi/${dudoso.id}`, { headers: auth(ctx.staff.auditor.token) })).json()) as { clasificacionEstado: string; clasificacion: { categoria: string }; clasificacionHistorial: unknown[] };
    expect(detalle.clasificacionEstado).toBe("ok");
    expect(detalle.clasificacion.categoria).toBe("equipo_computo");
    expect(detalle.clasificacionHistorial).toHaveLength(2);
    expect(ctx.auditSink.entries.filter((e) => e.action === "despachos.cfdi:categoria")).toHaveLength(1);
    expect(JSON.stringify(ctx.auditSink.entries)).not.toContain(RFC_PROVEEDOR);
  });

  it("con guardarRegla, el RFC del emisor queda corregido: el siguiente CFDI de ese emisor sale con method correccion, 0.95 y SIN clasificacion_baja", async () => {
    await sembrarFicha();
    const dudoso = await ingerirDudoso(21);
    expect((await json(ctx.staff.contador.token, "PUT", `${base()}/cfdi/${dudoso.id}/categoria`, { categoria: "equipo_computo", guardarRegla: true })).status).toBe(200);
    const lista = (await (await buildApp(ctx.deps).request(`${base()}/clasificacion/correcciones`, { headers: auth(ctx.staff.readonly.token) })).json()) as { estado: string; correcciones: { rfcEmisor: string; categoria: string }[] };
    expect(lista.correcciones).toMatchObject([{ rfcEmisor: RFC_PROVEEDOR, categoria: "equipo_computo" }]);
    const siguiente = await ingerirDudoso(22);
    expect(siguiente.clasificacion).toMatchObject({ categoria: "equipo_computo", metodo: "correccion", requiereRevision: false });
    expect(siguiente.clasificacion!.confianza).toBeCloseTo(0.95, 2);
    expect(await motivo(siguiente.id)).not.toContain("clasificacion_baja");
  });

  it("validaciones: categoria inventada o gruesa (400), cuenta mal formada (400), id mal formado (404), CFDI de otra property (404)", async () => {
    await sembrarFicha();
    const dudoso = await ingerirDudoso(23);
    const put = (id: string, cuerpo: unknown) => json(ctx.staff.contador.token, "PUT", `${base()}/cfdi/${id}/categoria`, cuerpo);
    expect((await put(dudoso.id, { categoria: "inventada" })).status).toBe(400);
    expect((await put(dudoso.id, { categoria: "sin_clasificar" })).status).toBe(400);
    expect((await put(dudoso.id, { categoria: "seguros", cuenta: "abc" })).status).toBe(400);
    expect((await put(dudoso.id, { categoria: "seguros", guardarRegla: "si" })).status).toBe(400);
    expect((await put("no-es-uuid", { categoria: "seguros" })).status).toBe(404);
    expect((await put(randomUUID(), { categoria: "seguros" })).status).toBe(404);
  });

  it("roles: auditor y readonly NO corrigen (403); base sin migrar -> 503", async () => {
    await sembrarFicha();
    const dudoso = await ingerirDudoso(24);
    for (const rol of [ctx.staff.auditor, ctx.staff.readonly]) expect((await json(rol.token, "PUT", `${base()}/cfdi/${dudoso.id}/categoria`, { categoria: "seguros" })).status).toBe(403);
    ctx.clasificacionRepo.disponible = false;
    expect((await json(ctx.staff.contador.token, "PUT", `${base()}/cfdi/${dudoso.id}/categoria`, { categoria: "seguros" })).status).toBe(503);
  });

  it("correcciones: alta/edicion por RFC (+ClaveProdServ), validaciones, baja, lectura para todos y 503 sin migrar; la bitacora no lleva RFC", async () => {
    const put = (cuerpo: unknown) => json(ctx.staff.contador.token, "PUT", `${base()}/clasificacion/correcciones`, cuerpo);
    const alta = await put({ rfcEmisor: RFC_PROVEEDOR.toLowerCase(), categoria: "publicidad" });
    expect(alta.status).toBe(200);
    const { id } = (await alta.json()) as { id: string };
    expect((await put({ rfcEmisor: RFC_PROVEEDOR, categoria: "seguros", cuenta: "6080100" })).status).toBe(200);
    expect((await put({ rfcEmisor: RFC_PROVEEDOR, claveProdServ: "43211503", categoria: "transporte" })).status).toBe(200);
    const lista = (await (await buildApp(ctx.deps).request(`${base()}/clasificacion/correcciones`, { headers: auth(ctx.staff.auditor.token) })).json()) as { correcciones: { id: string; categoria: string; cuenta: string | null }[] };
    expect(lista.correcciones).toHaveLength(2);
    expect(lista.correcciones.find((c) => c.id === id)).toMatchObject({ categoria: "seguros", cuenta: "6080100" });
    expect((await put({ rfcEmisor: "malo", categoria: "seguros" })).status).toBe(400);
    expect((await put({ rfcEmisor: RFC_PROVEEDOR, categoria: "sin_clasificar" })).status).toBe(400);
    expect((await put({ rfcEmisor: RFC_PROVEEDOR, claveProdServ: "12", categoria: "seguros" })).status).toBe(400);
    expect((await json(ctx.staff.readonly.token, "PUT", `${base()}/clasificacion/correcciones`, { rfcEmisor: RFC_PROVEEDOR, categoria: "seguros" })).status).toBe(403);
    expect((await json(ctx.staff.contador.token, "DELETE", `${base()}/clasificacion/correcciones/${id}`)).status).toBe(200);
    expect((await json(ctx.staff.contador.token, "DELETE", `${base()}/clasificacion/correcciones/${id}`)).status).toBe(404);
    expect((await json(ctx.staff.contador.token, "DELETE", `${base()}/clasificacion/correcciones/no-uuid`)).status).toBe(404);
    expect(JSON.stringify(ctx.auditSink.entries)).not.toContain(RFC_PROVEEDOR);
    ctx.clasificacionRepo.disponible = false;
    expect(await (await buildApp(ctx.deps).request(`${base()}/clasificacion/correcciones`, { headers: auth(ctx.staff.readonly.token) })).json()).toMatchObject({ estado: "no_disponible", correcciones: [] });
    expect((await put({ rfcEmisor: RFC_PROVEEDOR, categoria: "seguros" })).status).toBe(503);
  });
});

describe("ajustes por cliente: umbral de confianza y autoaceptado del portal", () => {
  it("el umbral nunca baja del piso (0.5) ni pasa de 1; solo el admin escribe; todos leen; queda en bitacora", async () => {
    const put = (token: string, cuerpo: unknown) => json(token, "PUT", `${base()}/clasificacion/ajustes`, cuerpo);
    expect((await put(ctx.staff.admin.token, { umbralConfianza: 0.4 })).status).toBe(400);
    expect((await put(ctx.staff.admin.token, { umbralConfianza: 1.01 })).status).toBe(400);
    expect((await put(ctx.staff.admin.token, { umbralConfianza: "0.7" })).status).toBe(400);
    expect((await put(ctx.staff.admin.token, {})).status).toBe(400);
    expect((await put(ctx.staff.admin.token, { portalAutoaceptarValidos: "no" })).status).toBe(400);
    expect((await put(ctx.staff.contador.token, { umbralConfianza: 0.8 })).status).toBe(403);
    const ok = await put(ctx.staff.admin.token, { umbralConfianza: 0.8, portalAutoaceptarValidos: false });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ umbralConfianza: 0.8, portalAutoaceptarValidos: false, pisoConfianza: 0.5 });
    const lectura = await (await buildApp(ctx.deps).request(`${base()}/clasificacion/ajustes`, { headers: auth(ctx.staff.readonly.token) })).json();
    expect(lectura).toMatchObject({ estado: "disponible", umbralConfianza: 0.8, portalAutoaceptarValidos: false });
    expect(ctx.auditSink.entries.filter((e) => e.action === "despachos.clasificacion:configuracion")).toHaveLength(1);
    ctx.clasificacionRepo.disponible = false;
    expect((await put(ctx.staff.admin.token, { umbralConfianza: 0.9 })).status).toBe(503);
    expect(await (await buildApp(ctx.deps).request(`${base()}/clasificacion/ajustes`, { headers: auth(ctx.staff.readonly.token) })).json()).toMatchObject({ estado: "no_disponible", umbralConfianza: 0.7 });
  });

  it("el catalogo de categorias trae las 18 con su nombre, el piso y el umbral por omision", async () => {
    const r = (await (await buildApp(ctx.deps).request(`${base()}/clasificacion/catalogo`, { headers: auth(ctx.staff.readonly.token) })).json()) as { categorias: { id: string; nombre: string }[]; pisoConfianza: number; umbralPorOmision: number };
    expect(r.categorias).toHaveLength(18);
    expect(r.categorias.find((c) => c.id === "equipo_computo")?.nombre).toBe("Equipo de cómputo");
    expect(r).toMatchObject({ pisoConfianza: 0.5, umbralPorOmision: 0.7 });
  });
});

describe("D-P3-18: el UUID es unico por cliente, no por organizacion", () => {
  it("el mismo CFDI entra a dos clientes del mismo despacho; reingestarlo en el mismo cliente devuelve la fila existente (200, duplicado)", async () => {
    const segundo = randomUUID();
    (ctx.deps.engine as unknown as { seedProperty(p: object): void }).seedProperty({ id: segundo, organizationId: ctx.organizationId });
    ctx.despachosRepo.seedDespachosProperty({ id: segundo, organizationId: ctx.organizationId, name: "Cliente 2" });
    ctx.carteraRepo.sembrarCliente(ctx.organizationId, "Cliente 2", undefined, segundo);
    const xml = cfdiXmlClasificable({ uuid: U(30) });
    const a = await importar(xml);
    const b = await importar(xml, ctx.staff.contador.token, ctx.deps, segundo);
    expect([a.status, b.status]).toEqual([201, 201]);
    const ida = ((await a.json()) as RespuestaIngesta).id;
    const idb = ((await b.json()) as RespuestaIngesta).id;
    expect(ida).not.toBe(idb);
    const otra = await importar(xml);
    expect(otra.status).toBe(200);
    expect(await otra.json()).toMatchObject({ id: ida, duplicado: true });
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(1);
    expect(await ctx.despachosRepo.listInvoices(segundo)).toHaveLength(1);
  });
});

describe("D-P3-23: la direccion se recalcula al capturar la ficha", () => {
  it("un CFDI ingerido SIN ficha queda indeterminado; al guardar la ficha pasa a recibido, con bitacora y respuesta con el conteo; guardar de nuevo recalcula 0", async () => {
    const r = (await (await importar(cfdiXmlClasificable({ uuid: U(31) }))).json()) as RespuestaIngesta & { direccion: string | null };
    expect(r.direccion).toBe("indeterminado");
    const ficha = { rfc: RFC_CLIENTE, razonSocial: "Cliente SA de CV", regimenesFiscales: ["601"], cpFiscal: "06600" };
    const res = await json(ctx.staff.contador.token, "PUT", `${base()}/cartera/ficha`, ficha);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ direccionRecalculada: 1 });
    expect((await ctx.despachosRepo.findInvoice(ctx.propertyId, r.id))?.direccion).toBe("recibido");
    expect(ctx.auditSink.entries.filter((e) => e.action === "despachos.cartera:direccion-recalculada")).toMatchObject([{ metadata: { cfdi: 1 } }]);
    expect(await (await json(ctx.staff.contador.token, "PUT", `${base()}/cartera/ficha`, ficha)).json()).toMatchObject({ direccionRecalculada: 0 });
  });

  it("contra la base sin migrar el guardado de la ficha sigue funcionando (direccionRecalculada 0)", async () => {
    ctx.clasificacionRepo.disponible = false;
    const res = await json(ctx.staff.contador.token, "PUT", `${base()}/cartera/ficha`, { rfc: RFC_CLIENTE, razonSocial: "Cliente SA de CV", regimenesFiscales: ["601"], cpFiscal: "06600" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ direccionRecalculada: 0 });
  });
});

describe("D-P3-23: avisos in-app de la cola de revision", () => {
  it("despachos.cfdi.requiere_revision: una por cliente y dia (clave property+fecha), sin PII, enlace a /cfdi; no se emite al reingestar un duplicado", async () => {
    await sembrarFicha();
    const { deps, emisiones } = conEmisiones(ctx.deps);
    await importar(cfdiXmlClasificable({ uuid: U(40) }), ctx.staff.contador.token, deps);
    await importar(cfdiXmlClasificable({ uuid: U(41), descripcion: "Renta de laptop" }), ctx.staff.contador.token, deps);
    await importar(cfdiXmlClasificable({ uuid: U(40) }), ctx.staff.contador.token, deps);
    const e = emisiones.filter((x) => x.evento === "despachos.cfdi.requiere_revision");
    expect(e.length).toBeGreaterThanOrEqual(1);
    expect(new Set(e.map((x) => x.dedupeKey)).size).toBe(1);
    expect(e[0]).toMatchObject({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, categoria: "aprobaciones", enlace: "/despachos/{orgSlug}/cfdi?revision=1", roles: ["contador"] });
    expect(e[0]!.dedupeKey).toMatch(new RegExp(`^despachos\\.cfdi\\.requiere_revision:${ctx.propertyId}:\\d{4}-\\d{2}-\\d{2}$`));
    expect(JSON.stringify(e[0])).not.toMatch(/EMISOR DE PRUEBA|CON950820K12|laptop/i);
    // Reingestar el primero (duplicado) no suma emisiones.
    const antes = emisiones.length;
    await importar(cfdiXmlClasificable({ uuid: U(41), descripcion: "Renta de laptop" }), ctx.staff.contador.token, deps);
    expect(emisiones.length).toBe(antes);
  });
});
