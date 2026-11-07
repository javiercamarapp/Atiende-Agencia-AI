// Onboarding P0: alta de sucursal/propiedad desde el producto (dueño por slug y superadmin asistido), de punta a punta contra el doble en
// memoria. La autorizacion real, el tope, la bitacora y el detalle por vertical en SQL se verifican en scripts/verify-alta-sucursal/.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryAltaPropiedadRepository } from "@atiende/db";
import { totpAt } from "@atiende/core-auth";
import { buildApp } from "../src/app.ts";
import { isSensitiveRoute } from "../src/superadmin-seguridad/step-up.ts";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

const MOTIVO = "Alta asistida de la primera sucursal durante el onboarding.";
const ORG_HOTEL = "11111111-1111-4111-8111-111111111111";
const ORG_LICI = "22222222-2222-4222-8222-222222222222";
const ORG_DESP = "33333333-3333-4333-8333-333333333333";

async function setup(opciones: { sinRepo?: boolean; noMigrado?: boolean } = {}) {
  const s = await seguridadSetup();
  const repo = new InMemoryAltaPropiedadRepository();
  repo.seedOrganizacion({ id: ORG_HOTEL, slug: "hotel-centro", vertical: "hoteles", status: "trial" });
  repo.seedOrganizacion({ id: ORG_LICI, slug: "licitante-uno", vertical: "licitaciones", status: "trial" });
  repo.seedOrganizacion({ id: ORG_DESP, slug: "despacho-uno", vertical: "despachos" });
  if (opciones.noMigrado) repo.seedNoMigrado();
  const app = buildApp({ ...s.deps, ...(opciones.sinRepo ? {} : { altaPropiedadRepo: () => repo }) });
  const dueno = await s.staff();
  repo.seedGestor(ORG_HOTEL, dueno.id);
  repo.seedGestor(ORG_LICI, dueno.id);
  repo.seedGestor(ORG_DESP, dueno.id);
  const ajeno = await s.staff();
  return { s, repo, app, dueno, ajeno };
}

describe("alta de sucursal por el dueño", () => {
  it("hoteles: el dueño crea su primera propiedad (201) y queda en la bitacora; sin token 401", async () => {
    const t = await setup();
    const url = "/v1/hoteles/hotel-centro/admin/alta-propiedad";
    expect((await t.app.request(url, jsonRequestInit({ nombre: "Hotel Centro" }))).status).toBe(401);
    const res = await t.app.request(url, jsonRequestInit({ nombre: "Hotel Centro", zonaHoraria: "America/Merida" }, bearer(t.dueno.token)));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { propertyId: string; slug: string | null };
    expect(body.slug).toBeNull();
    expect(t.repo.propiedadesDe(ORG_HOTEL)).toEqual([{ id: body.propertyId, nombre: "Hotel Centro" }]);
    expect(t.repo.bitacora).toEqual([expect.objectContaining({ organizationId: ORG_HOTEL, origen: "dueno", actor: t.dueno.id, motivo: null })]);
  });

  it("quien no es dueño/admin de toda la organizacion -> 403; organizacion de otra vertical o inexistente -> 404", async () => {
    const t = await setup();
    expect((await t.app.request("/v1/hoteles/hotel-centro/admin/alta-propiedad", jsonRequestInit({ nombre: "Hotel X" }, bearer(t.ajeno.token)))).status).toBe(403);
    // El slug es de hoteles: por la ruta de citas no existe.
    expect((await t.app.request("/v1/citas/hotel-centro/admin/alta-sucursal", jsonRequestInit({ nombre: "Sucursal" }, bearer(t.dueno.token)))).status).toBe(404);
    expect((await t.app.request("/v1/hoteles/NO_VALIDO/admin/alta-propiedad", jsonRequestInit({ nombre: "Hotel X" }, bearer(t.dueno.token)))).status).toBe(404);
    expect(t.repo.propiedadesDe(ORG_HOTEL)).toHaveLength(0);
  });

  it("validacion: nombre corto o zona horaria invalida -> 400; nombre repetido -> 409; licitaciones solo una -> 409", async () => {
    const t = await setup();
    const url = "/v1/licitaciones/licitante-uno/admin/alta-propiedad";
    expect((await t.app.request(url, jsonRequestInit({ nombre: "X" }, bearer(t.dueno.token)))).status).toBe(400);
    expect((await t.app.request(url, jsonRequestInit({ nombre: "Empresa", zonaHoraria: "Mars/Olympus" }, bearer(t.dueno.token)))).status).toBe(400);
    expect((await t.app.request(url, jsonRequestInit({ nombre: "Empresa" }, bearer(t.dueno.token)))).status).toBe(201);
    expect((await t.app.request(url, jsonRequestInit({ nombre: "Otra" }, bearer(t.dueno.token)))).status).toBe(409);
    const hotel = "/v1/hoteles/hotel-centro/admin/alta-propiedad";
    expect((await t.app.request(hotel, jsonRequestInit({ nombre: "Hotel Centro" }, bearer(t.dueno.token)))).status).toBe(201);
    expect((await t.app.request(hotel, jsonRequestInit({ nombre: "hotel centro" }, bearer(t.dueno.token)))).status).toBe(409);
  });

  it("despachos tiene su propio alta (cartera): no hay ruta generica para despachos", async () => {
    const t = await setup();
    expect((await t.app.request("/v1/despachos/despacho-uno/admin/alta-sucursal", jsonRequestInit({ nombre: "Cliente" }, bearer(t.dueno.token)))).status).toBe(404);
  });

  it("sin el repositorio o sin la migracion 0071 -> 503 honesto", async () => {
    const sinRepo = await setup({ sinRepo: true });
    expect((await sinRepo.app.request("/v1/hoteles/hotel-centro/admin/alta-propiedad", jsonRequestInit({ nombre: "Hotel" }, bearer(sinRepo.dueno.token)))).status).toBe(503);
    const noMigrado = await setup({ noMigrado: true });
    expect((await noMigrado.app.request("/v1/hoteles/hotel-centro/admin/alta-propiedad", jsonRequestInit({ nombre: "Hotel" }, bearer(noMigrado.dueno.token)))).status).toBe(503);
  });
});

describe("alta asistida por el superadmin", () => {
  it("superadmin crea la propiedad con motivo (bitacora con origen superadmin); staff normal 403; motivo corto 400; org no uuid 404", async () => {
    const t = await setup();
    const sa = await t.s.superadmin();
    t.repo.seedSuperadmin(sa.id);
    const url = `/superadmin/organizaciones/${ORG_HOTEL}/propiedades`;
    expect((await t.app.request(url, jsonRequestInit({ nombre: "Hotel Centro", motivo: MOTIVO }, bearer(t.dueno.token)))).status).toBe(403);
    expect((await t.app.request(url, jsonRequestInit({ nombre: "Hotel Centro", motivo: "corto" }, bearer(sa.token)))).status).toBe(400);
    expect((await t.app.request(`/superadmin/organizaciones/no-uuid/propiedades`, jsonRequestInit({ nombre: "Hotel Centro", motivo: MOTIVO }, bearer(sa.token)))).status).toBe(404);
    const res = await t.app.request(url, jsonRequestInit({ nombre: "Hotel Centro", motivo: MOTIVO }, bearer(sa.token)));
    expect(res.status).toBe(201);
    expect(t.repo.bitacora).toEqual([expect.objectContaining({ organizationId: ORG_HOTEL, origen: "superadmin", actor: sa.id, motivo: MOTIVO })]);
    expect((await t.app.request(`/superadmin/organizaciones/${randomUUID()}/propiedades`, jsonRequestInit({ nombre: "Hotel", motivo: MOTIVO }, bearer(sa.token)))).status).toBe(404);
  });

  it("es ruta sensible: con MFA activa exige step-up", async () => {
    expect(isSensitiveRoute("POST", `/superadmin/organizaciones/${ORG_HOTEL}/propiedades`)).toBe(true);
    const t = await setup();
    const sa = await t.s.superadmin();
    t.repo.seedSuperadmin(sa.id);
    const enr = (await (await t.app.request("/superadmin/mfa/enrolar", jsonRequestInit({}, bearer(sa.token)))).json()) as { secreto: string };
    await t.app.request("/superadmin/mfa/verificar", jsonRequestInit({ codigo: totpAt(enr.secreto, Date.now()) }, bearer(sa.token)));
    const sin = await t.app.request(`/superadmin/organizaciones/${ORG_HOTEL}/propiedades`, jsonRequestInit({ nombre: "Hotel Centro", motivo: MOTIVO }, bearer(sa.token)));
    expect(sin.status).toBe(403);
    expect(t.repo.propiedadesDe(ORG_HOTEL)).toHaveLength(0);
  });
});
