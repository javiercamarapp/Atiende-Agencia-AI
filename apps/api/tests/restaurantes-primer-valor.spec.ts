// «Primer valor en <30 min»: pasos de UNA sucursal con datos reales del doble en memoria, confirmacion de metodos de pago, permisos, y
// el respaldo de GET .../admin/branches que lista la sucursal INACTIVA cuando la organizacion aun no tiene ninguna activa (alta autoservicio).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

interface Pv {
  sucursal: { status: string };
  pasos: Array<{ id: string; estado: string }>;
  minutosRestantes: number;
  puedeActivar: boolean;
}

async function setup() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  return { ctx, app: buildApp(ctx.deps), url: `/v1/restaurantes/${ctx.propertyIdA}/admin/primer-valor` };
}

describe("GET/POST /v1/restaurantes/:propertyId/admin/primer-valor", () => {
  it("calcula los pasos con los datos reales de la sucursal (menu, horario, zonas)", async () => {
    const t = await setup();
    t.ctx.restaurantesRepo.seedBranchPolicy(t.ctx.propertyIdA, { horario: [{ dia: 1, abre: "09:00", cierra: "18:00" }] as never });
    t.ctx.restaurantesRepo.seedBranchDeliveryZones(t.ctx.propertyIdA, ["z1"]);
    const res = await t.app.request(t.url, authedGet(t.ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const pv = (await res.json()) as Pv;
    const estado = Object.fromEntries(pv.pasos.map((p) => [p.id, p.estado]));
    expect(estado.horario).toBe("hecho");
    expect(estado.zonas).toBe("hecho");
    expect(pv.sucursal.status).toBe("active");
    expect(estado.activar).toBe("hecho");
  });

  it("confirmar metodos de pago: owner 200; staff 403", async () => {
    const t = await setup();
    const res = await t.app.request(`${t.url}/metodos-pago`, authedJson(t.ctx.staff.owner.token, {}));
    // El motor en memoria no ejecuta SQL (devuelve 0 filas): aqui solo se prueba el contrato HTTP y los permisos. La escritura real del
    // hito, sus permisos y el CHECK del tipo nuevo se verifican contra Postgres real en scripts/verify-onboarding-evento/ (escenarios 16-19).
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect((await t.app.request(`${t.url}/metodos-pago`, authedJson(t.ctx.staff.staffSucursalA.token, {}))).status).toBe(403);
    expect((await t.app.request(t.url, authedGet(t.ctx.staff.staffSucursalA.token))).status).toBe(403);
  });

  it("sucursal de otra organizacion: 403 (membresia)", async () => {
    const t = await setup();
    expect((await t.app.request(`/v1/restaurantes/${t.ctx.otherPropertyId}/admin/primer-valor`, authedGet(t.ctx.staff.owner.token))).status).toBe(403);
  });
});

describe("GET /v1/restaurantes/:orgSlug/admin/branches con solo sucursales inactivas", () => {
  it("owner ve su sucursal inactiva (para configurarla); staff no; con alguna activa no cambia nada", async () => {
    const t = await setup();
    const url = "/v1/restaurantes/los-taquitos-de-pm/admin/branches";
    const activas = (await (await t.app.request(url, authedGet(t.ctx.staff.owner.token))).json()) as { branches: Array<{ status: string }> };
    expect(activas.branches.length).toBe(2);
    expect(activas.branches.every((b) => b.status === "active")).toBe(true);

    for (const [propertyId, name, slug] of [[t.ctx.propertyIdA, "Francisco de Montejo", "fco-montejo"], [t.ctx.propertyIdB, "Centro", "centro"]] as const) {
      t.ctx.restaurantesRepo.seedBranch({ propertyId, organizationId: t.ctx.organizationId, name, slug, status: "inactive", phone: null, address: null, lat: null, lng: null });
    }
    const owner = (await (await t.app.request(url, authedGet(t.ctx.staff.owner.token))).json()) as { branches: Array<{ status: string }> };
    expect(owner.branches).toHaveLength(2);
    expect(owner.branches.every((b) => b.status === "inactive")).toBe(true);
    const staff = (await (await t.app.request(url, authedGet(t.ctx.staff.staffSucursalA.token))).json()) as { branches: unknown[] };
    expect(staff.branches).toEqual([]);
  });
});
