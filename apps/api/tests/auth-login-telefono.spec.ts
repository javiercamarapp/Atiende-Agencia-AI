// Login del repartidor por celular + codigo de WhatsApp (docs/LOGIN-CHOFER-WHATSAPP.md), de punta a punta contra los repos en memoria.
// Cubre: bandera apagada, indisponibilidad global honesta, respuesta identica exista o no la cuenta, plantilla sin texto libre, un solo uso,
// 5 intentos, expiracion, codigo anterior invalidado, limites, baja del chofer y -- lo central -- que encargado, cajero, administrador, owner,
// superadmin y repartidores con otra membresia NO entran por esta via aunque tengan telefono registrado.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryLoginChoferRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { buildTestDeps, jsonRequestInit, TEST_ENV } from "./fixtures.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

let contadorIp = 0;
function nuevaIp(): Record<string, string> {
  contadorIp += 1;
  return { "x-forwarded-for": `203.0.113.${(contadorIp % 250) + 1}` };
}

const TEL_CHOFER = "9991230001";
const TEL_CHOFER_E164 = "+529991230001";
const TEL_NADIE = "9995550000";

interface Escenario {
  readonly app: ReturnType<typeof buildApp>;
  readonly deps: AppDeps;
  readonly repo: InMemoryLoginChoferRepository;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly choferId: string;
  readonly ownerEmail: string;
  readonly ownerPassword: string;
  readonly reloj: { desfase: number };
  codigosEnviados(): string[];
  outbox(): ReadonlyArray<{ eventType: string; payload: unknown }>;
}

async function montar(opts: { bandera?: boolean; plantilla?: boolean } = {}): Promise<Escenario> {
  const base = await buildTestDeps();
  const core = base.deps.coreRepo as unknown as import("@atiende/db").InMemoryCoreRepository;
  const reloj = { desfase: 0 };
  const repo = new InMemoryLoginChoferRepository(core, () => Date.now() + reloj.desfase);
  if (opts.plantilla !== false) repo.aprobarPlantilla(base.organizationId);
  const choferId = randomUUID();
  core.addStaff({ id: choferId, email: "chofer@pm.test", fullName: "Chofer Uno", passwordHash: null, createdVia: "invite", emailVerifiedAt: null });
  core.addMembership({ userId: choferId, organizationId: base.organizationId, platformRole: "member", verticalRole: "repartidor", propertyIds: null });
  repo.sembrarTelefono(choferId, base.organizationId, TEL_CHOFER_E164);
  const deps: AppDeps = { ...base.deps, env: { ...TEST_ENV, loginChoferWhatsapp: opts.bandera !== false }, loginChoferRepo: () => repo };
  return {
    app: buildApp(deps),
    deps,
    repo,
    organizationId: base.organizationId,
    propertyId: base.propertyId,
    choferId,
    ownerEmail: base.ownerEmail,
    ownerPassword: base.ownerPassword,
    reloj,
    outbox: () => base.restaurantesRepo.getOutbox(),
    codigosEnviados: () =>
      base.restaurantesRepo
        .getOutbox()
        .filter((o) => o.eventType === "auth.codigo_acceso")
        .map((o) => ((o.payload as { template: { params: string[] } }).template.params[0] ?? "")),
  };
}

async function solicitar(e: Escenario, telefono: string, headers = nuevaIp()) {
  return e.app.request("/auth/login-telefono/solicitar", jsonRequestInit({ telefono }, headers));
}
async function verificar(e: Escenario, telefono: string, codigo: string, headers = nuevaIp()) {
  return e.app.request("/auth/login-telefono/verificar", jsonRequestInit({ telefono, codigo }, headers));
}

describe("bandera y disponibilidad", () => {
  it("bandera apagada (por omision): estado=false y solicitar/verificar responden 503 sin enviar nada", async () => {
    const e = await montar({ bandera: false });
    const estado = await e.app.request("/auth/login-telefono/estado");
    expect(await estado.json()).toEqual({ disponible: false });
    expect((await solicitar(e, TEL_CHOFER)).status).toBe(503);
    expect((await verificar(e, TEL_CHOFER, "123456")).status).toBe(503);
    expect(e.codigosEnviados()).toHaveLength(0);
  });

  it("sin plantilla aprobada: 503 'no disponible aun' IDENTICO para un telefono con cuenta y uno sin cuenta, y no se encola nada", async () => {
    const e = await montar({ plantilla: false });
    expect(await (await e.app.request("/auth/login-telefono/estado")).json()).toEqual({ disponible: false });
    const a = await solicitar(e, TEL_CHOFER);
    const b = await solicitar(e, TEL_NADIE);
    expect(a.status).toBe(503);
    expect(b.status).toBe(503);
    expect(await a.json()).toEqual(await b.json());
    expect(e.codigosEnviados()).toHaveLength(0);
  });

  it("bandera encendida y plantilla aprobada: estado=true", async () => {
    const e = await montar();
    expect(await (await e.app.request("/auth/login-telefono/estado")).json()).toEqual({ disponible: true });
  });

  it("base sin migrar (el repositorio lanza LoginChoferNoDisponibleError): 503 honesto, nunca 500", async () => {
    const e = await montar();
    const { LoginChoferNoDisponibleError } = await import("@atiende/db");
    const roto = { ...e.deps, loginChoferRepo: () => new Proxy(e.repo, { get: () => async () => { throw new LoginChoferNoDisponibleError(); } }) };
    const app = buildApp(roto);
    expect((await app.request("/auth/login-telefono/solicitar", jsonRequestInit({ telefono: TEL_CHOFER }, nuevaIp()))).status).toBe(503);
    expect(await (await app.request("/auth/login-telefono/estado")).json()).toEqual({ disponible: false });
  });
});

describe("solicitar: sin enumeracion y solo plantilla", () => {
  it("cuenta existente y telefono inexistente: MISMO status y MISMO cuerpo", async () => {
    const e = await montar();
    const a = await solicitar(e, TEL_CHOFER);
    const b = await solicitar(e, TEL_NADIE);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
  });

  it("solo se encola para el repartidor, como plantilla `codigo_acceso` es_MX y SIN texto libre con el codigo", async () => {
    const e = await montar();
    await solicitar(e, TEL_CHOFER);
    await solicitar(e, TEL_NADIE);
    const filas = e.outbox().filter((o) => o.eventType === "auth.codigo_acceso") as Array<{ payload: Record<string, unknown> }>;
    expect(filas).toHaveLength(1);
    const p = filas[0]!.payload as { to: string; body: string; template: { name: string; language: string; params: string[]; codigoBoton: string }; solo_plantilla: boolean };
    expect(p.solo_plantilla).toBe(true);
    expect(p.template.name).toBe("codigo_acceso");
    expect(p.template.language).toBe("es_MX");
    expect(p.template.params).toHaveLength(1);
    expect(p.template.params[0]).toMatch(/^\d{6}$/);
    expect(p.template.codigoBoton).toBe(p.template.params[0]);
    expect(p.to).toBe(TEL_CHOFER_E164);
    // El cuerpo de respaldo es fijo: jamas contiene el codigo.
    expect(p.body).not.toContain(p.template.params[0]!);
  });

  it("formato invalido: 400 (depende solo del formato, no de la cuenta)", async () => {
    const e = await montar();
    for (const malo of ["", "123", "abc", "+15551234567", "99912300011"]) {
      expect((await solicitar(e, malo)).status).toBe(400);
    }
  });

  it("acepta +52, 52, 521, espacios y guiones y llega a la misma cuenta", async () => {
    const e = await montar();
    for (const forma of ["+52 999 123 0001", "52-999-123-0001", "521 999 123 0001"]) {
      const r = await solicitar(e, forma);
      expect(r.status).toBe(200);
    }
    expect(e.codigosEnviados().length).toBe(3);
  });

  it("limite por telefono: la cuarta solicitud responde 429 (igual para un telefono sin cuenta)", async () => {
    const e = await montar();
    const ips = [nuevaIp(), nuevaIp(), nuevaIp(), nuevaIp()];
    for (let i = 0; i < 3; i += 1) expect((await solicitar(e, TEL_CHOFER, ips[i])).status).toBe(200);
    expect((await solicitar(e, TEL_CHOFER, ips[3])).status).toBe(429);
    const ips2 = [nuevaIp(), nuevaIp(), nuevaIp(), nuevaIp()];
    for (let i = 0; i < 3; i += 1) expect((await solicitar(e, TEL_NADIE, ips2[i])).status).toBe(200);
    expect((await solicitar(e, TEL_NADIE, ips2[3])).status).toBe(429);
  });
});

describe("verificar: ciclo del codigo", () => {
  it("camino feliz: la sesion sale de issueSession, funciona en /auth/me y es de repartidor", async () => {
    const e = await montar();
    await solicitar(e, TEL_CHOFER);
    const codigo = e.codigosEnviados().at(-1)!;
    const r = await verificar(e, TEL_CHOFER, codigo);
    expect(r.status).toBe(200);
    const sesion = (await r.json()) as { token: string; refreshToken: string; email: string; organizations: Array<{ rol: string }> };
    expect(sesion.refreshToken).toBeTruthy();
    expect(sesion.organizations).toHaveLength(1);
    expect(sesion.organizations[0]!.rol).toBe("repartidor");
    const me = await e.app.request("/auth/me", { headers: { authorization: `Bearer ${sesion.token}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe("chofer@pm.test");
    // El refresh token funciona con el flujo existente.
    const ref = await e.app.request("/auth/refresh", jsonRequestInit({ refreshToken: sesion.refreshToken }, nuevaIp()));
    expect(ref.status).toBe(200);
  });

  it("un solo uso: repetir el mismo codigo falla", async () => {
    const e = await montar();
    await solicitar(e, TEL_CHOFER);
    const codigo = e.codigosEnviados().at(-1)!;
    expect((await verificar(e, TEL_CHOFER, codigo)).status).toBe(200);
    expect((await verificar(e, TEL_CHOFER, codigo)).status).toBe(401);
  });

  it("dos verificaciones simultaneas con el codigo correcto: solo una gana", async () => {
    const e = await montar();
    await solicitar(e, TEL_CHOFER);
    const codigo = e.codigosEnviados().at(-1)!;
    const [a, b] = await Promise.all([verificar(e, TEL_CHOFER, codigo), verificar(e, TEL_CHOFER, codigo)]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
  });

  it("codigo incorrecto, cuenta inexistente y codigo no pedido: el MISMO 401", async () => {
    const e = await montar();
    await solicitar(e, TEL_CHOFER);
    const malo = e.codigosEnviados().at(-1) === "000000" ? "111111" : "000000";
    const a = await verificar(e, TEL_CHOFER, malo);
    const b = await verificar(e, TEL_NADIE, "123456");
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(await a.json()).toEqual(await b.json());
  });

  it("5 intentos: despues del quinto fallo el codigo se invalida aunque el sexto sea el correcto", async () => {
    const e = await montar();
    await solicitar(e, TEL_CHOFER);
    const bueno = e.codigosEnviados().at(-1)!;
    const malo = bueno === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i += 1) expect((await verificar(e, TEL_CHOFER, malo)).status).toBe(401);
    expect((await verificar(e, TEL_CHOFER, bueno)).status).toBe(401);
  });

  it("expira a los 5 minutos", async () => {
    const e = await montar();
    await solicitar(e, TEL_CHOFER);
    const codigo = e.codigosEnviados().at(-1)!;
    e.reloj.desfase = 5 * 60_000 + 1000;
    expect((await verificar(e, TEL_CHOFER, codigo)).status).toBe(401);
  });

  it("un codigo nuevo invalida el anterior", async () => {
    const e = await montar();
    await solicitar(e, TEL_CHOFER);
    const primero = e.codigosEnviados().at(-1)!;
    await solicitar(e, TEL_CHOFER);
    const segundo = e.codigosEnviados().at(-1)!;
    if (primero !== segundo) expect((await verificar(e, TEL_CHOFER, primero)).status).toBe(401);
    expect((await verificar(e, TEL_CHOFER, segundo)).status).toBe(200);
  });

  it("chofer dado de baja entre pedir y usar el codigo: pierde el acceso", async () => {
    const e = await montar();
    await solicitar(e, TEL_CHOFER);
    const codigo = e.codigosEnviados().at(-1)!;
    await (e.deps.coreRepo as unknown as { removeMembership(o: string, u: string): Promise<void> }).removeMembership(e.organizationId, e.choferId);
    expect((await verificar(e, TEL_CHOFER, codigo)).status).toBe(401);
  });

  it("codigo con formato invalido: 400", async () => {
    const e = await montar();
    for (const malo of ["", "12345", "1234567", "abcdef"]) expect((await verificar(e, TEL_CHOFER, malo)).status).toBe(400);
  });

  it("el codigo guardado es un hash con sal (no el codigo) y la auditoria no contiene el telefono", async () => {
    const e = await montar();
    await solicitar(e, TEL_CHOFER);
    const codigo = e.codigosEnviados().at(-1)!;
    const guardado = e.repo.codigosRegistrados();
    expect(guardado).toHaveLength(1);
    expect(guardado[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(guardado[0]!.codeSalt).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(guardado)).not.toContain(codigo);
    await verificar(e, TEL_CHOFER, "000000");
    const eventos = JSON.stringify(e.repo.eventosRegistrados());
    expect(eventos).not.toContain("9991230001");
    for (const ev of e.repo.eventosRegistrados()) expect(ev.telefonoHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("solo repartidores: nadie mas entra por esta via aunque tenga telefono registrado", () => {
  async function conOtros() {
    const e = await montar();
    const core = e.deps.coreRepo as unknown as import("@atiende/db").InMemoryCoreRepository;
    const crear = (email: string) => {
      const id = randomUUID();
      core.addStaff({ id, email, fullName: email, passwordHash: null, createdVia: "invite", emailVerifiedAt: null });
      return id;
    };
    const casos: Array<{ nombre: string; telefono: string; id: string }> = [];
    const agregar = (nombre: string, telefono: string, m: { platformRole: "owner" | "admin" | "member"; verticalRole: string }, extra?: () => void) => {
      const id = crear(`${nombre}@pm.test`);
      core.addMembership({ userId: id, organizationId: e.organizationId, platformRole: m.platformRole, verticalRole: m.verticalRole, propertyIds: null });
      extra?.();
      e.repo.sembrarTelefono(id, e.organizationId, `+52${telefono}`);
      casos.push({ nombre, telefono, id });
    };
    agregar("encargado", "9992000001", { platformRole: "member", verticalRole: "staff" });
    agregar("cajero", "9992000002", { platformRole: "member", verticalRole: "staff" });
    agregar("administrador", "9992000003", { platformRole: "admin", verticalRole: "admin" });
    agregar("owner", "9992000004", { platformRole: "owner", verticalRole: "owner" });
    const idSuper = crear("super@pm.test");
    core.addMembership({ userId: idSuper, organizationId: e.organizationId, platformRole: "member", verticalRole: "repartidor", propertyIds: null });
    core.addPlatformSuperadmin(idSuper);
    e.repo.sembrarTelefono(idSuper, e.organizationId, "+529992000005");
    casos.push({ nombre: "superadmin con membresia de repartidor", telefono: "9992000005", id: idSuper });
    // Repartidor que ademas es encargado en OTRA organizacion.
    const idMulti = crear("multi@pm.test");
    const otraOrg = randomUUID();
    core.addOrganization({ id: otraOrg, slug: "otra", name: "Otra", vertical: "restaurantes" });
    core.addMembership({ userId: idMulti, organizationId: e.organizationId, platformRole: "member", verticalRole: "repartidor", propertyIds: null });
    core.addMembership({ userId: idMulti, organizationId: otraOrg, platformRole: "member", verticalRole: "staff", propertyIds: null });
    e.repo.sembrarTelefono(idMulti, e.organizationId, "+529992000006");
    casos.push({ nombre: "repartidor con otra membresia de encargado", telefono: "9992000006", id: idMulti });
    // "repartidor" de una organizacion que NO es de restaurantes.
    const idHotel = crear("hotel@pm.test");
    const orgHotel = randomUUID();
    core.addOrganization({ id: orgHotel, slug: "hotel", name: "Hotel", vertical: "hoteles" });
    core.addMembership({ userId: idHotel, organizationId: orgHotel, platformRole: "member", verticalRole: "repartidor", propertyIds: null });
    e.repo.sembrarTelefono(idHotel, orgHotel, "+529992000007");
    casos.push({ nombre: "repartidor de otra vertical", telefono: "9992000007", id: idHotel });
    return { e, casos };
  }

  it("solicitar responde 200 igual, NO se encola ningun codigo y verificar da 401", async () => {
    const { e, casos } = await conOtros();
    for (const c of casos) {
      const r = await solicitar(e, c.telefono);
      expect(r.status, c.nombre).toBe(200);
    }
    expect(e.codigosEnviados(), "no se debe enviar ningun codigo a cuentas no repartidor").toHaveLength(0);
    for (const c of casos) {
      expect((await verificar(e, c.telefono, "123456")).status, c.nombre).toBe(401);
    }
  });

  it("aunque se fuerce un codigo en la base, la elegibilidad se reevalua y no hay sesion", async () => {
    const { e, casos } = await conOtros();
    for (const c of casos) {
      const id = await e.repo.emitir({ userId: c.id, organizationId: e.organizationId, codeHash: "a".repeat(64), codeSalt: "b".repeat(32), expiresAt: new Date(Date.now() + 60_000).toISOString() });
      expect(id, c.nombre).toBeNull();
      expect(await e.repo.consumir("codigo-inexistente")).toBeNull();
    }
  });

  it("registrar telefono a cuentas no repartidor es rechazado", async () => {
    const { e, casos } = await conOtros();
    for (const c of casos.slice(0, 5)) {
      await expect(e.repo.guardarTelefono(e.organizationId, c.id, "+529993000001"), c.nombre).rejects.toThrow();
    }
  });

  it("el login por correo existente sigue igual (owner entra con correo y contrasena)", async () => {
    const e = await montar();
    const r = await e.app.request("/auth/login", jsonRequestInit({ email: e.ownerEmail, password: e.ownerPassword }, nuevaIp()));
    expect(r.status).toBe(200);
  });
});

describe("alta del telefono por el encargado/admin", () => {
  async function ctxAdmin() {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const core = ctx.deps.coreRepo as unknown as import("@atiende/db").InMemoryCoreRepository;
    const repo = new InMemoryLoginChoferRepository(core);
    repo.aprobarPlantilla(ctx.organizationId);
    const deps: AppDeps = { ...ctx.deps, env: { ...ctx.deps.env, loginChoferWhatsapp: true }, loginChoferRepo: () => repo };
    return { ctx, repo, app: buildApp(deps), deps };
  }
  const url = (propertyId: string, ruta: string) => `/v1/restaurantes/${propertyId}/admin/staff/${ruta}`;

  it("owner registra, lista (enmascarado), reemplaza y quita el telefono; la bitacora no lleva el numero", async () => {
    const { ctx, app, repo, deps } = await ctxAdmin();
    const chofer = ctx.staff.repartidor.id;
    const put = await app.request(url(ctx.propertyIdA, `miembros/${chofer}/telefono-acceso`), authedJson(ctx.staff.owner.token, { telefono: "999 777 8899" }, "PUT"));
    expect(put.status).toBe(200);
    const lista = await app.request(url(ctx.propertyIdA, "telefonos-acceso"), authedGet(ctx.staff.owner.token));
    const cuerpo = (await lista.json()) as { telefonos: Array<{ userId: string; telefonoEnmascarado: string }> };
    expect(cuerpo.telefonos.find((t) => t.userId === chofer)?.telefonoEnmascarado).toBe("******8899");
    expect(JSON.stringify(cuerpo)).not.toContain("9997778899");
    // El numero registrado ya sirve para entrar.
    expect((await repo.resolver("+529997778899"))?.userId).toBe(chofer);
    // La bitacora y los registros no guardan el telefono.
    expect(JSON.stringify(ctx.restaurantesRepo.auditLog)).not.toContain("9997778899");
    expect(ctx.restaurantesRepo.auditLog.some((a) => a.action === "staff.telefono_acceso_registrado")).toBe(true);
    const del = await app.request(url(ctx.propertyIdA, `miembros/${chofer}/telefono-acceso`), authedJson(ctx.staff.owner.token, undefined, "DELETE"));
    expect(((await del.json()) as { quitado: boolean }).quitado).toBe(true);
    expect(await repo.resolver("+529997778899")).toBeNull();
    void deps;
  });

  it("el encargado (staff) tambien puede registrar; un repartidor NO (403)", async () => {
    const { ctx, app } = await ctxAdmin();
    const chofer = ctx.staff.repartidor.id;
    const ok = await app.request(url(ctx.propertyIdA, `miembros/${chofer}/telefono-acceso`), authedJson(ctx.staff.staffSucursalA.token, { telefono: "9997778899" }, "PUT"));
    expect(ok.status).toBe(200);
    const no = await app.request(url(ctx.propertyIdA, `miembros/${chofer}/telefono-acceso`), authedJson(ctx.staff.repartidor.token, { telefono: "9997778898" }, "PUT"));
    expect(no.status).toBe(403);
    const sin = await app.request(url(ctx.propertyIdA, `miembros/${chofer}/telefono-acceso`), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ telefono: "9997778899" }) });
    expect(sin.status).toBe(401);
  });

  it("solo a repartidores de la organizacion: otro rol u otra organizacion -> 404; formato invalido -> 400", async () => {
    const { ctx, app } = await ctxAdmin();
    const ruta = (id: string) => url(ctx.propertyIdA, `miembros/${id}/telefono-acceso`);
    for (const objetivo of [ctx.staff.admin.id, ctx.staff.staffSucursalA.id, ctx.staff.owner.id, ctx.staff.otroOrgOwner.id]) {
      const r = await app.request(ruta(objetivo), authedJson(ctx.staff.owner.token, { telefono: "9997778899" }, "PUT"));
      expect(r.status, objetivo).toBe(404);
    }
    const malo = await app.request(ruta(ctx.staff.repartidor.id), authedJson(ctx.staff.owner.token, { telefono: "123" }, "PUT"));
    expect(malo.status).toBe(400);
  });

  it("telefono ya usado por otra cuenta: 409 generico", async () => {
    const { ctx, app, repo } = await ctxAdmin();
    repo.sembrarTelefono(ctx.staff.admin.id, ctx.organizationId, "+529997778899");
    const r = await app.request(url(ctx.propertyIdA, `miembros/${ctx.staff.repartidor.id}/telefono-acceso`), authedJson(ctx.staff.owner.token, { telefono: "9997778899" }, "PUT"));
    expect(r.status).toBe(409);
  });

  it("base sin migrar: 503 honesto", async () => {
    const { ctx, deps } = await ctxAdmin();
    const { LoginChoferNoDisponibleError } = await import("@atiende/db");
    const roto = buildApp({ ...deps, loginChoferRepo: () => new Proxy({}, { get: () => async () => { throw new LoginChoferNoDisponibleError(); } }) as never });
    const r = await roto.request(url(ctx.propertyIdA, "telefonos-acceso"), authedGet(ctx.staff.owner.token));
    expect(r.status).toBe(503);
  });
});
