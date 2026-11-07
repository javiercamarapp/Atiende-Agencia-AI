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
const ORG_RESTO = "44444444-4444-4444-8444-444444444444";

async function setup(opciones: { sinRepo?: boolean; noMigrado?: boolean } = {}) {
  const s = await seguridadSetup();
  const repo = new InMemoryAltaPropiedadRepository();
  repo.seedOrganizacion({ id: ORG_HOTEL, slug: "hotel-centro", vertical: "hoteles", status: "trial" });
  repo.seedOrganizacion({ id: ORG_LICI, slug: "licitante-uno", vertical: "licitaciones", status: "trial" });
  repo.seedOrganizacion({ id: ORG_DESP, slug: "despacho-uno", vertical: "despachos" });
  repo.seedOrganizacion({ id: ORG_RESTO, slug: "resto-uno", vertical: "restaurantes", propiedades: ["De plataforma"] });
  if (opciones.noMigrado) repo.seedNoMigrado();
  const app = buildApp({ ...s.deps, ...(opciones.sinRepo ? {} : { altaPropiedadRepo: () => repo }) });
  const dueno = await s.staff();
  repo.seedGestor(ORG_HOTEL, dueno.id);
  repo.seedGestor(ORG_LICI, dueno.id);
  repo.seedGestor(ORG_DESP, dueno.id);
  repo.seedGestor(ORG_RESTO, dueno.id);
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
    const body = (await res.json()) as { propertyId: string; slug: string | null; status: string };
    expect(body.slug).toBeNull();
    // Nace inactiva: no recibe reservas/pedidos hasta la activacion explicita.
    expect(body.status).toBe("inactive");
    expect(t.repo.propiedadesDe(ORG_HOTEL)).toEqual([{ id: body.propertyId, nombre: "Hotel Centro", status: "inactive" }]);
    expect(t.repo.bitacora).toEqual([expect.objectContaining({ organizationId: ORG_HOTEL, origen: "dueno", accion: "alta", actor: t.dueno.id, motivo: null })]);
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

describe("slug de restaurantes", () => {
  it("nunca termina en '-' aunque el corte a 60 caiga en un guion, ni empieza con '-'", async () => {
    const t = await setup();
    const url = "/v1/restaurantes/resto-uno/admin/alta-sucursal";
    const largo = (await (await t.app.request(url, jsonRequestInit({ nombre: `${"a".repeat(59)} b` }, bearer(t.dueno.token)))).json()) as { slug: string };
    expect(largo.slug).toBe("a".repeat(59));
    const signos = (await (await t.app.request(url, jsonRequestInit({ nombre: "¡¡Centro!!" }, bearer(t.dueno.token)))).json()) as { slug: string };
    expect(signos.slug).toBe("centro");
  });
});

describe("activacion explicita de la sucursal por el dueño", () => {
  async function conSucursal() {
    const t = await setup();
    const res = await t.app.request("/v1/restaurantes/resto-uno/admin/alta-sucursal", jsonRequestInit({ nombre: "Sucursal Norte" }, bearer(t.dueno.token)));
    const { propertyId } = (await res.json()) as { propertyId: string };
    return { ...t, propertyId, url: `/v1/restaurantes/resto-uno/admin/alta-sucursal/${propertyId}/activar` };
  }

  it("con pasos pendientes -> 409 configuracion_incompleta con la lista; la sucursal sigue inactiva", async () => {
    const t = await conSucursal();
    t.repo.seedPasosPendientes(t.propertyId, ["menu", "horario", "zona_de_entrega"]);
    const res = await t.app.request(t.url, jsonRequestInit({}, bearer(t.dueno.token)));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string; faltantes: string[] };
    expect(body.code).toBe("configuracion_incompleta");
    expect(body.faltantes).toEqual(["menu", "horario", "zona_de_entrega"]);
    expect(body.message).toContain("faltan pasos obligatorios");
    expect(t.repo.propiedadesDe(ORG_RESTO).find((p) => p.id === t.propertyId)?.status).toBe("inactive");
    expect(t.repo.bitacora.filter((b) => b.accion === "activacion")).toHaveLength(0);
  });

  it("configuracion completa -> 200 active con bitacora 'activacion'; repetir es idempotente (sin otra fila)", async () => {
    const t = await conSucursal();
    const res = await t.app.request(t.url, jsonRequestInit({}, bearer(t.dueno.token)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ propertyId: t.propertyId, status: "active", yaEstabaActiva: false });
    expect(t.repo.propiedadesDe(ORG_RESTO).find((p) => p.id === t.propertyId)?.status).toBe("active");
    const otra = await t.app.request(t.url, jsonRequestInit({}, bearer(t.dueno.token)));
    expect(await otra.json()).toEqual({ propertyId: t.propertyId, status: "active", yaEstabaActiva: true });
    expect(t.repo.bitacora.filter((b) => b.accion === "activacion")).toEqual([expect.objectContaining({ propertyId: t.propertyId, origen: "dueno", actor: t.dueno.id })]);
  });

  it("sin token 401; quien no es dueño/admin 403; propiedad de otra organizacion o id invalido 404; sucursal de plataforma 403", async () => {
    const t = await conSucursal();
    expect((await t.app.request(t.url, jsonRequestInit({}))).status).toBe(401);
    expect((await t.app.request(t.url, jsonRequestInit({}, bearer(t.ajeno.token)))).status).toBe(403);
    // La propiedad es de resto-uno: por la organizacion del hotel no existe.
    expect((await t.app.request(`/v1/hoteles/hotel-centro/admin/alta-propiedad/${t.propertyId}/activar`, jsonRequestInit({}, bearer(t.dueno.token)))).status).toBe(404);
    expect((await t.app.request("/v1/restaurantes/resto-uno/admin/alta-sucursal/no-uuid/activar", jsonRequestInit({}, bearer(t.dueno.token)))).status).toBe(404);
    const dePlataforma = t.repo.propiedadesDe(ORG_RESTO).find((p) => p.nombre === "De plataforma")!;
    expect((await t.app.request(`/v1/restaurantes/resto-uno/admin/alta-sucursal/${dePlataforma.id}/activar`, jsonRequestInit({}, bearer(t.dueno.token)))).status).toBe(403);
    expect(t.repo.propiedadesDe(ORG_RESTO).every((p) => p.status === "inactive")).toBe(true);
  });

  it("sin la migracion 0071 -> 503 honesto", async () => {
    const t = await setup({ noMigrado: true });
    expect((await t.app.request(`/v1/licitaciones/licitante-uno/admin/alta-propiedad/${randomUUID()}/activar`, jsonRequestInit({}, bearer(t.dueno.token)))).status).toBe(503);
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
