// Rn-36 -- HTTP real (app.request) del checklist de onboarding de rentas: GET /v1/rentas/:propertyId/admin/onboarding.
// El estado de cada punto sale de los conteos del repositorio (en Postgres: tablas reales) y de los miembros/invitaciones de la
// organizacion; solo lo ve admin_gestora con acceso a toda la organizacion; es de solo lectura (un GET no escribe ni notifica).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword } from "@atiende/db";
import { DATOS_ONBOARDING_VACIOS, InMemoryRentasOnboardingChecklistRepository } from "@atiende/domain-rentas";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

interface PuntoBody {
  clave: string;
  estado: "hecho" | "pendiente" | "no_disponible";
  detalle: string | null;
  pantalla: string;
  obligatorio: boolean;
}
interface ChecklistBody {
  puntos: PuntoBody[];
  medibles: number;
  hechos: number;
  porcentaje: number;
  listoParaOperar: boolean;
}

async function preparar() {
  const ctx = await buildRentasTestContext(buildApp);
  const checklist = new InMemoryRentasOnboardingChecklistRepository();
  const app = buildApp({ ...ctx.deps, rentasOnboardingChecklistRepo: () => checklist });
  const url = `/v1/rentas/${ctx.propertyId}/admin/onboarding`;
  const get = (token: string) => app.request(url, authedJson(token, undefined, {}, "GET"));
  return { ctx, checklist, app, url, get };
}

const por = (b: ChecklistBody, clave: string) => b.puntos.find((p) => p.clave === clave)!;

describe("GET /v1/rentas/:propertyId/admin/onboarding", () => {
  it("organizacion nueva: los puntos de datos salen pendientes y el staff ya sembrado sale hecho; no esta lista para operar", async () => {
    const t = await preparar();
    const res = await t.get(t.ctx.staff.adminGestora.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const b = (await res.json()) as ChecklistBody;
    expect(b.puntos.map((p) => p.clave)).toEqual(["ical", "tarifa_base", "reglas_comision", "acceso_huesped", "staff", "propietarios", "plantilla"]);
    for (const clave of ["ical", "tarifa_base", "reglas_comision", "acceso_huesped", "propietarios", "plantilla"]) expect(por(b, clave).estado, clave).toBe("pendiente");
    expect(por(b, "staff")).toMatchObject({ estado: "hecho", pantalla: "equipo" });
    expect(b).toMatchObject({ medibles: 7, hechos: 1, porcentaje: 14, listoParaOperar: false });
  });

  it("cada punto se marca con el dato real: al sembrar los conteos del repositorio todos pasan a hecho y la organizacion queda lista", async () => {
    const t = await preparar();
    t.checklist.porOrganizacion.set(t.ctx.organizationId, {
      unidades: 2,
      feeds: { activos: 2, enCuarentena: 0, sincronizados: 1 },
      unidadesConTarifaBase: 2,
      reglasComision: 3,
      propiedadesConAccesoActivo: 1,
      propietarios: 2,
      plantillasAprobadas: 1,
    });
    const b = (await (await t.get(t.ctx.staff.adminGestora.token)).json()) as ChecklistBody;
    expect(b.puntos.every((p) => p.estado === "hecho")).toBe(true);
    expect(b).toMatchObject({ medibles: 7, hechos: 7, porcentaje: 100, listoParaOperar: true });
    expect(por(b, "ical").detalle).toBe("2 feeds activos, 1 ya sincronizado");
    expect(por(b, "tarifa_base").detalle).toBe("2 de 2 unidades con tarifa");
  });

  it("tarifa base a medias (una de dos unidades) sigue pendiente con la cifra real", async () => {
    const t = await preparar();
    t.checklist.porOrganizacion.set(t.ctx.organizationId, { ...DATOS_ONBOARDING_VACIOS, unidades: 2, unidadesConTarifaBase: 1 });
    const b = (await (await t.get(t.ctx.staff.adminGestora.token)).json()) as ChecklistBody;
    expect(por(b, "tarifa_base")).toMatchObject({ estado: "pendiente", detalle: "1 de 2 unidades con tarifa" });
  });

  it("base sin migrar: lo que no se puede medir sale no_disponible (no hecho ni pendiente), el resto carga y nunca hay 500", async () => {
    const t = await preparar();
    t.checklist.noDisponible.add(t.ctx.organizationId);
    const res = await t.get(t.ctx.staff.adminGestora.token);
    expect(res.status).toBe(200);
    const b = (await res.json()) as ChecklistBody;
    expect(b.puntos.filter((p) => p.estado === "no_disponible").map((p) => p.clave)).toEqual(["ical", "tarifa_base", "reglas_comision", "acceso_huesped", "propietarios", "plantilla"]);
    expect(por(b, "staff").estado).toBe("hecho");
    expect(b.medibles).toBe(1);
    expect(b.listoParaOperar).toBe(true);
  });

  it("403 para los demas roles: operador, contador y limpieza no ven el estado de toda la organizacion", async () => {
    const t = await preparar();
    for (const token of [t.ctx.staff.operadorAccesoTotal.token, t.ctx.staff.operadorSoloCalendario.token, t.ctx.staff.contador.token, t.ctx.staff.limpieza.token]) {
      expect((await t.get(token)).status).toBe(403);
    }
  });

  it("403 para un admin_gestora con membership acotada a la propiedad: el checklist es de toda la organizacion", async () => {
    const t = await preparar();
    const id = randomUUID();
    const email = "admin-acotado@rentas-de-prueba.mx";
    const password = "correcto-caballo-batería";
    t.ctx.deps.coreRepo.addStaff({ id, email, fullName: "acotado", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    t.ctx.deps.coreRepo.addMembership({ userId: id, organizationId: t.ctx.organizationId, platformRole: "owner", verticalRole: "admin_gestora", propertyIds: [t.ctx.propertyId] });
    t.ctx.engine.seedMembership({ userId: id, organizationId: t.ctx.organizationId, platformRole: "owner", verticalRole: "admin_gestora", propertyIds: [t.ctx.propertyId] });
    const login = await t.app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    expect(login.status).toBe(200);
    const { token } = (await login.json()) as { token: string };
    const res = await t.get(token);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("toda la organización");
  });

  it("entre tenants: el admin de OTRA organizacion no lee el checklist de esta propiedad, y sin token es 401", async () => {
    const t = await preparar();
    const otra = await buildRentasTestContext(buildApp);
    const res = await t.get(otra.staff.adminGestora.token);
    expect([403, 404]).toContain(res.status);
    expect((await t.app.request(t.url)).status).toBe(401);
  });

  it("es de solo lectura: un GET no deja ninguna notificacion ni escritura (las filas del repositorio no cambian)", async () => {
    const t = await preparar();
    const antes = JSON.stringify([...t.checklist.porOrganizacion.entries()]);
    expect((await t.get(t.ctx.staff.adminGestora.token)).status).toBe(200);
    expect(JSON.stringify([...t.checklist.porOrganizacion.entries()])).toBe(antes);
  });
});
