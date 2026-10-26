// Auditoria minima de accesos: inicios de sesion del personal de restaurantes y lectura de la ficha completa de un cliente quedan en la
// bitacora (tipo `acceso`, la leen owner/admin). Sin IP, correo ni telefono en las filas.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

type Ctx = Awaited<ReturnType<typeof buildRestaurantesKpiTestContext>>;
const entrar = (app: ReturnType<typeof buildApp>, email: string, password: string) =>
  app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
const accesos = (ctx: Ctx, action: string) => ctx.restaurantesRepo.auditLog.filter((f) => f.entityType === "acceso" && f.action === action);

describe("inicios de sesion", () => {
  it("un login correcto deja una fila sesion.login con el canal (catalogo), sin ruta, correo ni IP", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = accesos(ctx, "sesion.login").length;
    const res = await entrar(app, ctx.staff.staffSucursalA.email, ctx.staff.staffSucursalA.password);
    expect(res.status).toBe(200);
    const filas = accesos(ctx, "sesion.login");
    expect(filas.length).toBe(antes + 1);
    const fila = filas[filas.length - 1]!;
    expect(fila.actorUserId).toBe(ctx.staff.staffSucursalA.id);
    expect(fila.despues).toBe("correo");
    expect(JSON.stringify(fila)).not.toContain(ctx.staff.staffSucursalA.email);
  });

  it("un login fallido no registra nada y el refresh no suma filas", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const base = accesos(ctx, "sesion.login").length;
    expect((await entrar(app, ctx.staff.owner.email, "incorrecta-incorrecta")).status).toBe(401);
    expect(accesos(ctx, "sesion.login").length).toBe(base);
    const ok = (await (await entrar(app, ctx.staff.owner.email, ctx.staff.owner.password)).json()) as { refreshToken: string };
    expect(accesos(ctx, "sesion.login").length).toBe(base + 1);
    const r = await app.request("/auth/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: ok.refreshToken }) });
    expect(r.status).toBe(200);
    expect(accesos(ctx, "sesion.login").length).toBe(base + 1);
  });

  it("owner/admin ven los inicios de sesion en la bitacora; staff no", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await entrar(app, ctx.staff.staffSucursalA.email, ctx.staff.staffSucursalA.password);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria?tipo=acceso`;
    const ver = await app.request(url, authedGet(ctx.staff.owner.token));
    expect(((await ver.json()) as { items: Array<{ action: string }> }).items.some((i) => i.action === "sesion.login")).toBe(true);
    expect((await app.request(url, authedGet(ctx.staff.staffSucursalA.token))).status).toBe(403);
  });
});

describe("lectura de PII sensible", () => {
  it("abrir la ficha de un cliente queda registrado con el id del cliente (no con su telefono)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const cliente = await ctx.restaurantesRepo.upsertCustomer(ctx.organizationId, "9991112222", "Ana Torres");
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers/${cliente.id}/ficha`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const filas = accesos(ctx, "pii.cliente_ficha");
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ entityId: cliente.id, actorUserId: ctx.staff.owner.id });
    expect(JSON.stringify(filas)).not.toContain("9991112222");
  });

  it("una ficha inexistente (404) no deja fila", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers/00000000-0000-4000-8000-000000000000/ficha`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(404);
    expect(accesos(ctx, "pii.cliente_ficha")).toHaveLength(0);
  });
});
