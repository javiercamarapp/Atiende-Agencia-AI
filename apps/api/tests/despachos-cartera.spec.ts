// D-21 -- cartera de clientes: alta y ficha fiscal por property (RFC validado, regimenes, CP, periodicidad, responsable).
// Cubre: roles, validacion, RFC duplicado, alcance de la membresia (alta solo con acceso a TODA la organizacion), base sin
// migrar (503/"no disponible", nunca 500) y cuerpos hostiles.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "@atiende/db";
import type { InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

const SLUG = "despacho-de-prueba";
const ALTA = { nombre: "Abarrotes del Norte", rfc: "ADN010101AB1", razonSocial: "Abarrotes del Norte SA de CV", regimenesFiscales: ["601"], cpFiscal: "64000", periodicidad: "mensual" };

function req(token: string, method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${token}`, ...headers } };
  if (body !== undefined) {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    init.body = raw;
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    (init.headers as Record<string, string>)["content-length"] = String(new TextEncoder().encode(raw).byteLength);
  }
  return init;
}

const url = `/v1/despachos/${SLUG}/admin/cartera`;
const fichaUrl = (propertyId: string) => `/despachos/${propertyId}/cartera/ficha`;

describe("GET /v1/despachos/:orgSlug/admin/cartera", () => {
  it("lista los clientes de la organizacion; el sembrado aun no tiene ficha y el admin puede dar de alta", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(url, req(ctx.staff.admin.token, "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string; puedeDarDeAlta: boolean; clientes: { propertyId: string; nombre: string; ficha: unknown }[] };
    expect(body.estado).toBe("disponible");
    expect(body.puedeDarDeAlta).toBe(true);
    expect(body.clientes).toEqual([{ propertyId: ctx.propertyId, nombre: "Sede principal", ficha: null }]);
  });

  it("auditor y readonly leen la cartera pero no ven la accion de alta", async () => {
    const app = buildApp(ctx.deps);
    for (const t of [ctx.staff.auditor.token, ctx.staff.readonly.token]) {
      const res = await app.request(url, req(t, "GET"));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { puedeDarDeAlta: boolean }).puedeDarDeAlta).toBe(false);
    }
  });

  it("sin token -> 401; slug inexistente -> 404", async () => {
    const app = buildApp(ctx.deps);
    expect((await app.request(url)).status).toBe(401);
    expect((await app.request("/v1/despachos/no-existe/admin/cartera", req(ctx.staff.admin.token, "GET"))).status).toBe(404);
  });

  it("base sin migrar: estado no_disponible con los clientes SIN ficha, jamas un 500", async () => {
    ctx.carteraRepo.disponible = false;
    const res = await buildApp(ctx.deps).request(url, req(ctx.staff.admin.token, "GET"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ estado: "no_disponible", clientes: [{ nombre: "Sede principal", ficha: null }] });
  });
});

describe("POST /v1/despachos/:orgSlug/admin/cartera (alta)", () => {
  it("el contador da de alta un cliente: 201 y aparece en la cartera con regimen legible, tipo de persona derivado y sin tocar a los demas", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(url, req(ctx.staff.contador.token, "POST", ALTA));
    expect(res.status).toBe(201);
    const { propertyId } = (await res.json()) as { propertyId: string };
    const lista = (await (await app.request(url, req(ctx.staff.admin.token, "GET"))).json()) as { clientes: { propertyId: string; ficha: { rfc: string; tipoPersona: string; regimenesFiscales: { clave: string; nombre: string }[] } | null }[] };
    expect(lista.clientes).toHaveLength(2);
    const nuevo = lista.clientes.find((c) => c.propertyId === propertyId)!;
    expect(nuevo.ficha).toMatchObject({ rfc: "ADN010101AB1", tipoPersona: "moral", regimenesFiscales: [{ clave: "601", nombre: "General de Ley Personas Morales" }] });
    expect(lista.clientes.find((c) => c.propertyId === ctx.propertyId)!.ficha).toBeNull();
  });

  it("normaliza (RFC en minusculas, regimenes repetidos) antes de guardar", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(url, req(ctx.staff.admin.token, "POST", { ...ALTA, rfc: " adn010101ab1 ", regimenesFiscales: ["626", "601", "601"] }));
    expect(res.status).toBe(201);
    const ficha = await ctx.carteraRepo.obtenerFicha(((await res.json()) as { propertyId: string }).propertyId);
    expect(ficha).toMatchObject({ rfc: "ADN010101AB1", regimenesFiscales: ["601", "626"] });
  });

  it.each([
    ["RFC mal formado", { rfc: "ABC" }, /rfc/],
    ["RFC generico", { rfc: "XAXX010101000" }, /rfc/],
    ["fecha imposible en el RFC", { rfc: "ADN011301AB1" }, /rfc/],
    ["regimen fuera de catalogo", { regimenesFiscales: ["999"] }, /regimenesFiscales/],
    ["regimen de persona fisica para un RFC de moral", { regimenesFiscales: ["612"] }, /regimenesFiscales/],
    ["sin regimenes", { regimenesFiscales: [] }, /regimenesFiscales/],
    ["CP de 4 digitos", { cpFiscal: "6400" }, /cpFiscal/],
    ["periodicidad invalida", { periodicidad: "semanal" }, /periodicidad/],
    ["responsable no uuid", { responsableId: "no-uuid" }, /responsableId/],
    ["razon social vacia", { razonSocial: " " }, /razonSocial/],
    ["nombre vacio", { nombre: "" }, /nombre/],
  ])("400 ante %s y no crea nada", async (_n, cambio, mensaje) => {
    const app = buildApp(ctx.deps);
    const res = await app.request(url, req(ctx.staff.admin.token, "POST", { ...ALTA, ...cambio }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(mensaje);
    expect((await ctx.carteraRepo.listar(ctx.organizationId)).clientes).toHaveLength(1);
  });

  it("un cuerpo que no es objeto o es JSON invalido produce 400, no 500", async () => {
    const app = buildApp(ctx.deps);
    expect((await app.request(url, req(ctx.staff.admin.token, "POST", "null"))).status).toBe(400);
    expect((await app.request(url, req(ctx.staff.admin.token, "POST", "{no es json"))).status).toBeGreaterThanOrEqual(400);
    expect((await app.request(url, req(ctx.staff.admin.token, "POST", "{no es json"))).status).toBeLessThan(500);
  });

  it("RFC duplicado en el mismo despacho -> 409", async () => {
    const app = buildApp(ctx.deps);
    expect((await app.request(url, req(ctx.staff.admin.token, "POST", ALTA))).status).toBe(201);
    expect((await app.request(url, req(ctx.staff.admin.token, "POST", { ...ALTA, nombre: "Otro nombre" }))).status).toBe(409);
  });

  it("auditor y readonly NO dan de alta (403) y no se crea nada", async () => {
    const app = buildApp(ctx.deps);
    for (const t of [ctx.staff.auditor.token, ctx.staff.readonly.token]) {
      expect((await app.request(url, req(t, "POST", ALTA))).status).toBe(403);
    }
    expect((await ctx.carteraRepo.listar(ctx.organizationId)).clientes).toHaveLength(1);
  });

  it("un contador acotado a UN cliente NO da de alta (alta = alcance de toda la organizacion) y solo ve su cliente", async () => {
    const id = randomUUID();
    const email = "acotado@despacho-de-prueba.mx";
    const password = "correcto-caballo-batería";
    const coreRepo = ctx.deps.coreRepo as unknown as InMemoryCoreRepository;
    const engine = ctx.deps.engine as unknown as InMemoryTenancyEngine;
    coreRepo.addStaff({ id, email, fullName: "Acotado", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addMembership({ userId: id, organizationId: ctx.organizationId, platformRole: "admin", verticalRole: "contador", propertyIds: [ctx.propertyId] });
    engine.seedMembership({ userId: id, organizationId: ctx.organizationId, platformRole: "admin", verticalRole: "contador", propertyIds: [ctx.propertyId] });
    const app = buildApp(ctx.deps);
    const login = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    const token = ((await login.json()) as { token: string }).token;

    // El admin crea un segundo cliente; el acotado no lo ve.
    await app.request(url, req(ctx.staff.admin.token, "POST", ALTA));
    const lista = (await (await app.request(url, req(token, "GET"))).json()) as { puedeDarDeAlta: boolean; clientes: { propertyId: string }[] };
    expect(lista.clientes.map((c) => c.propertyId)).toEqual([ctx.propertyId]);
    expect(lista.puedeDarDeAlta).toBe(false);
    expect((await app.request(url, req(token, "POST", { ...ALTA, rfc: "ZZZ010101ZZ1" }))).status).toBe(403);
  });

  it("base sin migrar: 503 con mensaje honesto, jamas 500", async () => {
    ctx.carteraRepo.disponible = false;
    const res = await buildApp(ctx.deps).request(url, req(ctx.staff.admin.token, "POST", ALTA));
    expect(res.status).toBe(503);
  });

  it("cuerpo gigante -> rechazado antes de procesarse", async () => {
    const res = await buildApp(ctx.deps).request(url, req(ctx.staff.admin.token, "POST", { ...ALTA, razonSocial: "x".repeat(20000) }));
    expect(res.status).toBe(413);
  });
});

describe("GET/PUT /despachos/:propertyId/cartera/ficha", () => {
  it("PUT crea la ficha de una property existente sin ficha y GET la devuelve; el RFC ya registrado no cambia", async () => {
    const app = buildApp(ctx.deps);
    const put = await app.request(fichaUrl(ctx.propertyId), req(ctx.staff.contador.token, "PUT", { rfc: "SPR010101SP1", razonSocial: "Sede SA", regimenesFiscales: ["601"], cpFiscal: "06600" }));
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ ficha: { rfc: "SPR010101SP1", periodicidad: "mensual", razonSocial: "Sede SA" } });

    const cambio = await app.request(fichaUrl(ctx.propertyId), req(ctx.staff.contador.token, "PUT", { rfc: "OTR010101OT1", razonSocial: "Sede SA", regimenesFiscales: ["601"], cpFiscal: "06600" }));
    expect(cambio.status).toBe(400);
    expect(((await cambio.json()) as { message: string }).message).toMatch(/RFC/);

    const upd = await app.request(fichaUrl(ctx.propertyId), req(ctx.staff.contador.token, "PUT", { rfc: "SPR010101SP1", razonSocial: "Sede SA", regimenesFiscales: ["601", "603"], cpFiscal: "11000", periodicidad: "bimestral" }));
    expect(upd.status).toBe(200);
    const get = (await (await app.request(fichaUrl(ctx.propertyId), req(ctx.staff.auditor.token, "GET"))).json()) as { ficha: { cpFiscal: string; periodicidad: string } };
    expect(get.ficha).toMatchObject({ cpFiscal: "11000", periodicidad: "bimestral" });
  });

  it("GET sin ficha -> { ficha: null }; en la base sin migrar tambien (no 500)", async () => {
    const app = buildApp(ctx.deps);
    expect(await (await app.request(fichaUrl(ctx.propertyId), req(ctx.staff.readonly.token, "GET"))).json()).toEqual({ ficha: null });
    ctx.carteraRepo.disponible = false;
    expect((await app.request(fichaUrl(ctx.propertyId), req(ctx.staff.readonly.token, "GET"))).status).toBe(200);
    expect((await app.request(fichaUrl(ctx.propertyId), req(ctx.staff.admin.token, "PUT", { rfc: "SPR010101SP1", razonSocial: "S", regimenesFiscales: ["601"], cpFiscal: "06600" }))).status).toBe(503);
  });

  it("auditor/readonly no escriben (403); property ajena o inexistente -> sin acceso", async () => {
    const app = buildApp(ctx.deps);
    const body = { rfc: "SPR010101SP1", razonSocial: "Sede SA", regimenesFiscales: ["601"], cpFiscal: "06600" };
    expect((await app.request(fichaUrl(ctx.propertyId), req(ctx.staff.auditor.token, "PUT", body))).status).toBe(403);
    expect((await app.request(fichaUrl(ctx.propertyId), req(ctx.staff.readonly.token, "PUT", body))).status).toBe(403);
    const ajena = await app.request(fichaUrl(randomUUID()), req(ctx.staff.admin.token, "GET"));
    expect([403, 404]).toContain(ajena.status);
    expect((await app.request(fichaUrl(ctx.propertyId))).status).toBe(401);
  });
});
