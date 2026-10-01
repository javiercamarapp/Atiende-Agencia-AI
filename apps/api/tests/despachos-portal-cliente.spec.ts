// D-08: portal del cliente final del despacho -- rutas publicas por token de enlace + gestion del staff.
// Doble en memoria con las mismas reglas de aislamiento que la migracion 016 (la verdad de seguridad en
// Postgres real vive en scripts/verify-despachos-portal-cliente). Los tokens se generan en runtime.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDefaultRateLimiterForTests } from "@atiende/core-ratelimit";
import { InMemoryAuditSink } from "@atiende/core-authz";
import { InMemoryPortalClienteRepository, generarTokenPortal, hashTokenPortal } from "@atiende/domain-despachos";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";
import { cfdiXmlPortal } from "../../../packages/domain-despachos/tests/support/portal-cfdi-xml.ts";

let ctx: DespachosTestContext;
let repo: InMemoryPortalClienteRepository;
let deps: AppDeps;
let propertyB: string;

const enc = (s: string) => new TextEncoder().encode(s);
const PDF = enc("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF");

beforeEach(async () => {
  resetDefaultRateLimiterForTests();
  ctx = await buildDespachosTestContext(buildApp);
  repo = new InMemoryPortalClienteRepository();
  propertyB = randomUUID();
  repo.sembrarCliente({
    propertyId: ctx.propertyId, clienteNombre: "Cliente A SA de CV", despachoNombre: "Despacho de Prueba SC",
    obligaciones: [{ tipo: "ISR", periodo: "2026-07", fechaLimite: "2026-08-17", estado: "pendiente", fechaPresentacion: null }],
    cierres: [{ anio: 2026, mes: 6, estado: "open", tareasTotal: 5, tareasListas: 2 }],
  });
  repo.sembrarCliente({
    propertyId: propertyB, clienteNombre: "Cliente B SA de CV", despachoNombre: "Otro Despacho",
    obligaciones: [{ tipo: "IVA", periodo: "2026-07", fechaLimite: "2026-08-17", estado: "completado", fechaPresentacion: "2026-08-10" }],
  });
  deps = { ...ctx.deps, portalClienteRepo: () => repo };
});

async function nuevoToken(propertyId = ctx.propertyId, dias = 30): Promise<string> {
  const token = generarTokenPortal();
  await repo.crearEnlace(propertyId, hashTokenPortal(token), "contacto", dias);
  return token;
}

const app = () => buildApp(deps);
const conToken = (token: string | undefined, init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...(token ? { "x-portal-token": token } : {}), ...(init.headers as Record<string, string> | undefined) } });

function subir(token: string | undefined, bytes: Uint8Array | string, contentType: string, nombre = "archivo.xml", extra: Record<string, string> = {}) {
  const cuerpo = typeof bytes === "string" ? enc(bytes) : bytes;
  return app().request("/portal-cliente/documentos", {
    method: "POST",
    headers: { ...(token ? { "x-portal-token": token } : {}), "content-type": contentType, "content-length": String(cuerpo.byteLength), "x-nombre-archivo": encodeURIComponent(nombre), ...extra },
    body: cuerpo,
  });
}

describe("GET /portal-cliente/resumen -- acceso por token", () => {
  it("token vigente: ve SOLO el estatus de SU cliente (obligaciones, cierres) y responde no-store sin eco del token", async () => {
    const token = await nuevoToken();
    const res = await app().request("/portal-cliente/resumen", conToken(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const texto = await res.text();
    expect(texto).not.toContain(token);
    expect(texto).not.toContain(hashTokenPortal(token));
    const body = JSON.parse(texto);
    expect(body.cliente.nombre).toBe("Cliente A SA de CV");
    expect(body.obligaciones).toEqual([{ tipo: "ISR", periodo: "2026-07", fechaLimite: "2026-08-17", estado: "pendiente", fechaPresentacion: null }]);
    expect(body.cierres).toEqual([{ anio: 2026, mes: 6, estado: "open", tareasTotal: 5, tareasListas: 2 }]);
    expect(texto).not.toContain("Cliente B");
    expect(texto).not.toContain("Otro Despacho");
  });

  it("aislamiento cross-cliente y cross-tenant: el token de B jamas ve datos de A (ni sus documentos ni mensajes)", async () => {
    const tokenA = await nuevoToken(ctx.propertyId);
    const tokenB = await nuevoToken(propertyB);
    expect((await subir(tokenA, PDF, "application/pdf", "secreto-de-A.pdf")).status).toBe(201);
    expect((await app().request("/portal-cliente/mensajes", { method: "POST", headers: { "x-portal-token": tokenA, "content-type": "application/json" }, body: JSON.stringify({ cuerpo: "mensaje confidencial de A" }) })).status).toBe(201);
    const b = await (await app().request("/portal-cliente/resumen", conToken(tokenB))).text().then(JSON.parse);
    expect(b.cliente.nombre).toBe("Cliente B SA de CV");
    expect(b.obligaciones[0].tipo).toBe("IVA");
    expect(b.documentos).toEqual([]);
    expect(b.mensajes).toEqual([]);
    expect(JSON.stringify(b)).not.toMatch(/secreto-de-A|confidencial de A|Cliente A/);
  });

  it("sin enumeracion: sin token, token mal formado, inexistente, expirado y revocado responden IGUAL (404 generico)", async () => {
    const expirado = await nuevoToken(ctx.propertyId, 0);
    const revocado = await nuevoToken();
    const lista = await repo.listarEnlaces(ctx.propertyId);
    if (!lista.disponible) throw new Error("inesperado");
    await repo.revocarEnlace(ctx.propertyId, lista.valor.find((e) => e.revocadoEn === null && e.expiraEn > new Date().toISOString())!.id);
    const casos: (string | undefined)[] = [undefined, "corto", "x".repeat(43), generarTokenPortal(), expirado, revocado];
    const cuerpos = new Set<string>();
    for (const t of casos) {
      const res = await app().request("/portal-cliente/resumen", conToken(t));
      expect(res.status).toBe(404);
      cuerpos.add(JSON.stringify(await res.text().then(JSON.parse)));
    }
    expect(cuerpos.size).toBe(1);
    expect([...cuerpos][0]).toContain("enlace_no_valido");
  });

  it("el token NO se acepta por URL ni query string (solo header), para que nunca viaje en una URL registrada", async () => {
    const token = await nuevoToken();
    expect((await app().request(`/portal-cliente/resumen?t=${token}`)).status).toBe(404);
    expect((await app().request(`/portal-cliente/${token}/resumen`)).status).toBe(404);
  });

  it("base sin migrar: 503 portal_no_disponible (nunca 500) y sin filtrar detalles", async () => {
    const token = await nuevoToken();
    repo.disponible = false;
    const res = await app().request("/portal-cliente/resumen", conToken(token));
    expect(res.status).toBe(503);
    expect(await res.text().then(JSON.parse)).toMatchObject({ code: "service_unavailable" });
  });

  it("rate limit por IP: pasado el tope responde 429, aun con token invalido (frena la fuerza bruta)", async () => {
    let ultimo = 0;
    for (let i = 0; i < 125; i += 1) {
      ultimo = (await app().request("/portal-cliente/resumen", conToken(generarTokenPortal()))).status;
      if (ultimo === 429) break;
    }
    expect(ultimo).toBe(429);
  });
});

describe("POST /portal-cliente/documentos", () => {
  it("CFDI XML valido: 201 recibido; reenviarlo (replay) es idempotente: 200 duplicado, una sola fila", async () => {
    const token = await nuevoToken();
    const xml = cfdiXmlPortal();
    const r1 = await subir(token, xml, "application/xml", "factura.xml");
    expect(r1.status).toBe(201);
    const j1 = await r1.text().then(JSON.parse);
    expect(j1).toMatchObject({ estado: "recibido", duplicado: false, nombreArchivo: "factura.xml" });
    const r2 = await subir(token, xml, "text/xml", "otra-vez.xml");
    expect(r2.status).toBe(200);
    expect(await r2.text().then(JSON.parse)).toMatchObject({ id: j1.id, duplicado: true });
    expect(repo.documentos).toHaveLength(1);
    expect(repo.documentos[0]!.resumen).toMatchObject({ folio_fiscal: "11111111-2222-3333-4444-555555555555", total: "1160.00" });
  });

  it("XXE / billion laughs / hojas de estilo: 422 y NADA se guarda", async () => {
    const token = await nuevoToken();
    const xxe = cfdiXmlPortal({ prologo: '<?xml version="1.0"?><!DOCTYPE c [<!ENTITY x SYSTEM "file:///etc/passwd">]>' });
    const res = await subir(token, xxe, "application/xml");
    expect(res.status).toBe(422);
    expect((await res.text().then(JSON.parse)).code).toBe("archivo_contenido_no_permitido");
    expect((await subir(token, cfdiXmlPortal({ prologo: '<!DOCTYPE l [<!ENTITY a "aaa"><!ENTITY b "&a;&a;&a;">]>' }), "text/xml")).status).toBe(422);
    expect(repo.documentos).toHaveLength(0);
  });

  it("archivo que no es lo que dice (PDF falso, XML que no es CFDI, tipo no permitido) -> 422", async () => {
    const token = await nuevoToken();
    expect((await subir(token, "<script>alert(1)</script>", "application/pdf", "a.pdf")).status).toBe(422);
    expect((await subir(token, "<a/>", "application/xml")).status).toBe(422);
    expect((await subir(token, "MZ-ejecutable", "application/x-msdownload", "a.exe")).status).toBe(422);
    expect((await subir(token, "<html></html>", "text/html", "a.html")).status).toBe(422);
    expect(repo.documentos).toHaveLength(0);
  });

  it("tamano: Content-Length declarado > 2 MB -> 413; cuerpo real > 2 MB sin Content-Length tambien -> 413", async () => {
    const token = await nuevoToken();
    const res = await app().request("/portal-cliente/documentos", { method: "POST", headers: { "x-portal-token": token, "content-type": "application/pdf", "content-length": String(3 * 1024 * 1024) }, body: PDF });
    expect(res.status).toBe(413);
    const grande = new Uint8Array(2 * 1024 * 1024 + 10);
    grande.set(PDF);
    const sinLength = new Request("http://localhost/portal-cliente/documentos", { method: "POST", headers: { "x-portal-token": token, "content-type": "application/pdf" }, body: new ReadableStream({ start(c) { c.enqueue(grande); c.close(); } }), duplex: "half" } as RequestInit);
    expect((await app().request(sinLength)).status).toBe(413);
    expect(repo.documentos).toHaveLength(0);
  });

  it("token expirado/revocado/invalido NO puede subir (404 generico) y no se guarda nada", async () => {
    const expirado = await nuevoToken(ctx.propertyId, 0);
    expect((await subir(expirado, PDF, "application/pdf", "a.pdf")).status).toBe(404);
    expect((await subir(undefined, PDF, "application/pdf", "a.pdf")).status).toBe(404);
    expect((await subir(generarTokenPortal(), PDF, "application/pdf", "a.pdf")).status).toBe(404);
    expect(repo.documentos).toHaveLength(0);
  });

  it("el nombre de archivo se sanea (sin rutas) y el cliente no puede elegir property: queda en la del token", async () => {
    const tokenB = await nuevoToken(propertyB);
    const res = await subir(tokenB, PDF, "application/pdf", "../../etc/passwd.pdf", { "x-property-id": ctx.propertyId });
    expect(res.status).toBe(201);
    expect(repo.documentos[0]).toMatchObject({ nombreArchivo: "passwd.pdf", propertyId: propertyB });
  });

  it("rate limit por enlace: mas de 15 subidas en la ventana -> 429", async () => {
    const token = await nuevoToken();
    let ultimo = 0;
    for (let i = 0; i < 17; i += 1) {
      ultimo = (await subir(token, enc(`%PDF-1.4 ${i}`), "application/pdf", `${i}.pdf`)).status;
    }
    expect(ultimo).toBe(429);
  });

  it("base sin migrar: 503", async () => {
    const token = await nuevoToken();
    repo.disponible = false;
    expect((await subir(token, PDF, "application/pdf", "a.pdf")).status).toBe(503);
  });
});

describe("POST /portal-cliente/mensajes", () => {
  const msg = (token: string | undefined, body: unknown) => app().request("/portal-cliente/mensajes", { method: "POST", headers: { ...(token ? { "x-portal-token": token } : {}), "content-type": "application/json" }, body: JSON.stringify(body) });

  it("mensaje valido -> 201 y aparece en SU resumen; vacio, largo o mal tipo -> 400; token malo -> 404", async () => {
    const token = await nuevoToken();
    expect((await msg(token, { cuerpo: "  Hola, ya subi mis facturas.  " })).status).toBe(201);
    expect((await (await app().request("/portal-cliente/resumen", conToken(token))).text().then(JSON.parse)).mensajes).toMatchObject([{ autor: "cliente", cuerpo: "Hola, ya subi mis facturas." }]);
    expect((await msg(token, { cuerpo: "   " })).status).toBe(400);
    expect((await msg(token, { cuerpo: "a".repeat(2001) })).status).toBe(400);
    expect((await msg(token, { cuerpo: 5 })).status).toBe(400);
    expect((await msg(generarTokenPortal(), { cuerpo: "hola" })).status).toBe(404);
  });
});

describe("gestion del staff", () => {
  const base = () => `/despachos/${ctx.propertyId}/portal-cliente`;

  it("crear enlace (contador): devuelve la URL con el token en el FRAGMENTO, la base solo guarda el hash, y ese enlace funciona", async () => {
    const res = await app().request(`${base()}/enlaces`, authedJson(ctx.staff.contador.token, { etiqueta: "Contacto de Pedro", dias: 15 }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text().then(JSON.parse);
    const [antes, token] = (body.url as string).split("#t=");
    expect(antes).toMatch(/\/portal\/cliente$/);
    expect(antes).not.toContain(token!);
    const guardado = JSON.stringify(repo.enlaces);
    expect(guardado).not.toContain(token!);
    expect(guardado).toContain(hashTokenPortal(token!));
    expect((await app().request("/portal-cliente/resumen", conToken(token))).status).toBe(200);
    // auditoria: sin el token ni el hash en el rastro
    const audit = (deps.despachosAuditSink as InMemoryAuditSink).entries.filter((e) => e.action === "despachos.portal_cliente:enlace_creado");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(token!);
  });

  it("el listado de enlaces NUNCA incluye token ni hash", async () => {
    const token = await nuevoToken();
    const res = await app().request(`${base()}/enlaces`, authedJson(ctx.staff.readonly.token));
    expect(res.status).toBe(200);
    const texto = await res.text();
    expect(texto).not.toContain(token);
    expect(texto).not.toContain(hashTokenPortal(token));
    expect(JSON.parse(texto).enlaces).toHaveLength(1);
  });

  it("roles: auditor/readonly NO crean ni revocan (403) pero SI listan; entrada invalida -> 400", async () => {
    expect((await app().request(`${base()}/enlaces`, authedJson(ctx.staff.auditor.token, { etiqueta: "x" }))).status).toBe(403);
    expect((await app().request(`${base()}/enlaces`, authedJson(ctx.staff.readonly.token, { etiqueta: "x" }))).status).toBe(403);
    expect((await app().request(`${base()}/enlaces`, authedJson(ctx.staff.auditor.token))).status).toBe(200);
    expect((await app().request(`${base()}/enlaces`, authedJson(ctx.staff.admin.token, { etiqueta: "" }))).status).toBe(400);
    expect((await app().request(`${base()}/enlaces`, authedJson(ctx.staff.admin.token, { etiqueta: "ok", dias: 366 }))).status).toBe(400);
    expect((await app().request(`${base()}/enlaces`, authedJson(ctx.staff.admin.token, { etiqueta: "ok", dias: 1.5 }))).status).toBe(400);
  });

  it("sin sesion -> 401; staff sobre una property ajena -> sin acceso (cross-tenant)", async () => {
    expect((await app().request(`${base()}/enlaces`)).status).toBe(401);
    const ajena = await app().request(`/despachos/${propertyB}/portal-cliente/enlaces`, authedJson(ctx.staff.admin.token));
    expect([403, 404]).toContain(ajena.status);
  });

  it("revocar: el MISMO enlace deja de funcionar de inmediato; revocar de nuevo es idempotente (revocado:false)", async () => {
    const token = await nuevoToken();
    const lista = await (await app().request(`${base()}/enlaces`, authedJson(ctx.staff.admin.token))).text().then(JSON.parse);
    const id = lista.enlaces[0].id as string;
    expect((await app().request("/portal-cliente/resumen", conToken(token))).status).toBe(200);
    const r1 = await app().request(`${base()}/enlaces/${id}/revocar`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.contador.token}` } });
    expect(await r1.text().then(JSON.parse)).toEqual({ revocado: true });
    expect((await app().request("/portal-cliente/resumen", conToken(token))).status).toBe(404);
    const r2 = await app().request(`${base()}/enlaces/${id}/revocar`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.contador.token}` } });
    expect(await r2.text().then(JSON.parse)).toEqual({ revocado: false });
    expect((await app().request(`${base()}/enlaces/no-es-uuid/revocar`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.contador.token}` } })).status).toBe(400);
  });

  it("aceptar un CFDI XML del cliente: pasa por la MISMA ingesta (crea el invoice), marca aceptado y un segundo aceptar -> 409", async () => {
    const token = await nuevoToken();
    expect((await subir(token, cfdiXmlPortal(), "application/xml", "factura.xml")).status).toBe(201);
    const docs = await (await app().request(`${base()}/documentos`, authedJson(ctx.staff.contador.token))).text().then(JSON.parse);
    expect(docs.documentos).toHaveLength(1);
    expect(JSON.stringify(docs)).not.toContain("contenido");
    const id = docs.documentos[0].id as string;
    const res = await app().request(`${base()}/documentos/${id}/aceptar`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.contador.token}` } });
    expect(res.status).toBe(200);
    const body = await res.text().then(JSON.parse);
    expect(body).toMatchObject({ estado: "aceptado" });
    expect(body.invoiceId).toBeTruthy();
    expect(await ctx.despachosRepo.findInvoice(ctx.propertyId, body.invoiceId)).toMatchObject({ folioFiscal: "11111111-2222-3333-4444-555555555555", rfcEmisor: "CON950820K12" });
    const otra = await app().request(`${base()}/documentos/${id}/aceptar`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.contador.token}` } });
    expect(otra.status).toBe(409);
  });

  it("aceptar un CFDI cuyo folio ya existe -> 409 y el documento queda 'recibido' (se puede rechazar)", async () => {
    const token = await nuevoToken();
    const xml = cfdiXmlPortal();
    expect((await app().request(`/despachos/${ctx.propertyId}/cfdi/importar-xml`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.contador.token}`, "content-type": "application/xml", "content-length": String(enc(xml).byteLength) }, body: xml })).status).toBe(201);
    await subir(token, xml, "application/xml", "factura.xml");
    const id = repo.documentos[0]!.id;
    const res = await app().request(`${base()}/documentos/${id}/aceptar`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.contador.token}` } });
    expect(res.status).toBe(409);
    expect(repo.documentos[0]!.estado).toBe("recibido");
  });

  it("aceptar un PDF no crea invoice; rechazar con motivo lo deja visible para el cliente; auditor NO puede resolver", async () => {
    const token = await nuevoToken();
    await subir(token, PDF, "application/pdf", "constancia.pdf");
    await subir(token, enc("%PDF-1.4 otro"), "application/pdf", "ilegible.pdf");
    const [d1, d2] = repo.documentos;
    const auth = { authorization: `Bearer ${ctx.staff.contador.token}`, "content-type": "application/json" };
    const ok = await (await app().request(`${base()}/documentos/${d1!.id}/aceptar`, { method: "POST", headers: auth })).text().then(JSON.parse);
    expect(ok).toMatchObject({ estado: "aceptado", invoiceId: null });
    expect((await app().request(`${base()}/documentos/${d2!.id}/rechazar`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.auditor.token}`, "content-type": "application/json" }, body: JSON.stringify({ motivo: "x" }) })).status).toBe(403);
    expect((await app().request(`${base()}/documentos/${d2!.id}/rechazar`, { method: "POST", headers: auth, body: JSON.stringify({ motivo: "Esta ilegible, vuelve a subirlo." }) })).status).toBe(200);
    const resumen = await (await app().request("/portal-cliente/resumen", conToken(token))).text().then(JSON.parse);
    expect(resumen.documentos).toEqual(expect.arrayContaining([
      expect.objectContaining({ nombreArchivo: "constancia.pdf", estado: "aceptado" }),
      expect.objectContaining({ nombreArchivo: "ilegible.pdf", estado: "rechazado", motivo: "Esta ilegible, vuelve a subirlo." }),
    ]));
    expect((await app().request(`${base()}/documentos/${d2!.id}/rechazar`, { method: "POST", headers: auth, body: JSON.stringify({}) })).status).toBe(409);
  });

  it("descargar: siempre como adjunto, nosniff y CSP sandbox; auditor puede; documento ajeno/inexistente -> 404", async () => {
    const token = await nuevoToken();
    await subir(token, PDF, "application/pdf", "constancia.pdf");
    const id = repo.documentos[0]!.id;
    const res = await app().request(`${base()}/documentos/${id}/descargar`, authedJson(ctx.staff.auditor.token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    expect((await app().request(`${base()}/documentos/${randomUUID()}/descargar`, authedJson(ctx.staff.auditor.token))).status).toBe(404);
  });

  it("mensajes: el staff responde y el cliente lo ve; auditor lee pero no escribe", async () => {
    const token = await nuevoToken();
    expect((await app().request(`${base()}/mensajes`, authedJson(ctx.staff.contador.token, { cuerpo: "Recibimos tus facturas." }))).status).toBe(201);
    expect((await app().request(`${base()}/mensajes`, authedJson(ctx.staff.auditor.token, { cuerpo: "no" }))).status).toBe(403);
    expect((await app().request(`${base()}/mensajes`, authedJson(ctx.staff.contador.token, { cuerpo: "" }))).status).toBe(400);
    expect((await (await app().request(`${base()}/mensajes`, authedJson(ctx.staff.auditor.token))).text().then(JSON.parse)).mensajes).toHaveLength(1);
    expect((await (await app().request("/portal-cliente/resumen", conToken(token))).text().then(JSON.parse)).mensajes).toMatchObject([{ autor: "despacho", cuerpo: "Recibimos tus facturas." }]);
  });

  it("base sin migrar: el panel lista vacio con disponible:false y las escrituras responden 503", async () => {
    repo.disponible = false;
    expect(await (await app().request(`${base()}/enlaces`, authedJson(ctx.staff.admin.token))).text().then(JSON.parse)).toEqual({ disponible: false, enlaces: [] });
    expect(await (await app().request(`${base()}/documentos`, authedJson(ctx.staff.admin.token))).text().then(JSON.parse)).toEqual({ disponible: false, documentos: [] });
    expect(await (await app().request(`${base()}/mensajes`, authedJson(ctx.staff.admin.token))).text().then(JSON.parse)).toEqual({ disponible: false, mensajes: [] });
    expect((await app().request(`${base()}/enlaces`, authedJson(ctx.staff.admin.token, { etiqueta: "x" }))).status).toBe(503);
  });
});
