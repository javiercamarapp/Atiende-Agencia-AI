// Nota: el corte del TOKEN DE ACCESO lo da `requirePropertyMembership` (membresia en vivo); el motor de tenencia en memoria de este harness es un
// almacen aparte del repositorio de staff, asi que aqui se prueba lo que SI comparte estado: la revocacion de sesiones.
// BAJA INMEDIATA de empleado: al dar de baja a un miembro, deja de entrar a la API al instante y no puede reemitir sesion con un refresh
// token viejo (incluido el repartidor y su vinculo de celular). Quien conserva membresia en otra organizacion NO pierde esa sesion.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

type Ctx = Awaited<ReturnType<typeof buildRestaurantesKpiTestContext>>;
type Persona = Ctx["staff"]["repartidor"];

async function login(app: ReturnType<typeof buildApp>, p: Persona): Promise<{ token: string; refreshToken: string }> {
  const res = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: p.email, password: p.password }) });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; refreshToken: string };
}
const refrescar = (app: ReturnType<typeof buildApp>, refreshToken: string) =>
  app.request("/auth/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken }) });
const baja = (app: ReturnType<typeof buildApp>, ctx: Ctx, userId: string) =>
  app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros/${userId}`, { method: "DELETE", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });

describe("baja inmediata", () => {
  it("repartidor dado de baja: su refresh token ya no reemite sesion", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const sesion = await login(app, ctx.staff.repartidor);

    expect((await baja(app, ctx, ctx.staff.repartidor.id)).status).toBe(200);

    expect((await refrescar(app, sesion.refreshToken)).status).toBe(401);
  });

  it("staff dado de baja: igual (refresh 401)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const sesion = await login(app, ctx.staff.staffSucursalA);
    expect((await baja(app, ctx, ctx.staff.staffSucursalA.id)).status).toBe(200);
    expect((await refrescar(app, sesion.refreshToken)).status).toBe(401);
  });

  it("sin la baja, el refresh token del mismo usuario SI reemite sesion (control)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const sesion = await login(app, ctx.staff.repartidor);
    expect((await refrescar(app, sesion.refreshToken)).status).toBe(200);
  });

  it("quien conserva membresia en otra organizacion conserva su refresh token (la baja solo afecta esta organizacion)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    // El admin tiene ademas una membresia en la otra organizacion.
    const core = ctx.deps.coreRepo as unknown as { addMembership(m: unknown): void };
    core.addMembership({ userId: ctx.staff.admin.id, organizationId: ctx.otherOrganizationId, platformRole: "admin", verticalRole: "admin", propertyIds: null });
    const sesion = await login(app, ctx.staff.admin);
    expect((await baja(app, ctx, ctx.staff.admin.id)).status).toBe(200);
    expect((await refrescar(app, sesion.refreshToken)).status).toBe(200);
  });
});
