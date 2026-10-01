// Gestion de organizaciones del superadmin: solicitar -> confirmar (dos pasos),
// motivo, una pendiente por organizacion, solo el solicitante, vencimiento, base
// sin migrar, y el efecto de suspender sobre el acceso del staff.
import { describe, expect, it } from "vitest";
import type { OrgAdminRepository } from "@atiende/db";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

const MOTIVO = "Cliente en mora de 90 dias, se suspende previa confirmacion del director.";
type App = { request: (u: string, i?: RequestInit) => Response | Promise<Response> };
const solicitar = (app: App, body: unknown, headers: Record<string, string>) => app.request("/superadmin/organizaciones/acciones", jsonRequestInit(body, headers));
const confirmar = (app: App, id: string, headers: Record<string, string>) => app.request(`/superadmin/organizaciones/acciones/${id}/confirmar`, jsonRequestInit({}, headers));
const cancelar = (app: App, id: string, headers: Record<string, string>) => app.request(`/superadmin/organizaciones/acciones/${id}/cancelar`, jsonRequestInit({}, headers));
type Accion = { id: string; estado: string; tipo: string; resultado: Record<string, unknown> | null };

describe("gestion de organizaciones -- gateo", () => {
  it("un staff normal recibe 403 en todas las rutas; sin token, 401", async () => {
    const s = await seguridadSetup();
    const st = await s.staff();
    expect((await s.app.request("/superadmin/organizaciones/acciones", { headers: bearer(st.token) })).status).toBe(403);
    expect((await solicitar(s.app, { tipo: "suspender", organizationId: s.base.organizationId, motivo: MOTIVO }, bearer(st.token))).status).toBe(403);
    expect((await confirmar(s.app, "x", bearer(st.token))).status).toBe(403);
    expect((await s.app.request("/superadmin/organizaciones/acciones")).status).toBe(401);
  });
});

describe("gestion de organizaciones -- ciclo de vida", () => {
  it("suspender: solicitar NO cambia nada; confirmar suspende; reactivar restaura el estado previo", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    const org = s.base.organizationId;

    const sol = await solicitar(s.app, { tipo: "suspender", organizationId: org, motivo: MOTIVO }, bearer(sa.token));
    expect(sol.status).toBe(201);
    const { accion } = (await sol.json()) as { accion: Accion };
    expect(accion).toMatchObject({ estado: "pending", tipo: "suspender" });
    expect(s.orgs.organizationStatus(org)).toBe("active");

    const conf = await confirmar(s.app, accion.id, bearer(sa.token));
    expect(conf.status).toBe(200);
    expect(((await conf.json()) as { accion: Accion }).accion).toMatchObject({ estado: "executed", resultado: { status_previo: "active", status: "suspended" } });
    expect(s.orgs.organizationStatus(org)).toBe("suspended");

    const re = (await (await solicitar(s.app, { tipo: "reactivar", organizationId: org, motivo: "El cliente regularizo su pago, se reactiva su cuenta." }, bearer(sa.token))).json()) as { accion: Accion };
    await confirmar(s.app, re.accion.id, bearer(sa.token));
    expect(s.orgs.organizationStatus(org)).toBe("active");
  });

  it("cambiar_plan trial <-> active y alta de organizacion nueva (en trial) solo al confirmar", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    const org = s.base.organizationId;

    const plan = (await (await solicitar(s.app, { tipo: "cambiar_plan", organizationId: org, payload: { plan: "trial" }, motivo: "Regresa a cuenta de prueba por acuerdo comercial firmado." }, bearer(sa.token))).json()) as { accion: Accion };
    await confirmar(s.app, plan.accion.id, bearer(sa.token));
    expect(s.orgs.organizationStatus(org)).toBe("trial");

    const alta = await solicitar(s.app, { tipo: "alta", payload: { vertical: "citas", name: "Clinica Nueva", slug: "clinica-nueva" }, motivo: "Cliente nuevo cerrado por ventas, se da de alta su organizacion." }, bearer(sa.token));
    expect(alta.status).toBe(201);
    expect(s.orgs.organizationBySlug("clinica-nueva")).toBeUndefined();
    const { accion } = (await alta.json()) as { accion: Accion };
    await confirmar(s.app, accion.id, bearer(sa.token));
    const nuevo = s.orgs.organizationBySlug("clinica-nueva")!;
    expect(s.orgs.organizationStatus(nuevo)).toBe("trial");
  });

  it("solo el solicitante confirma/cancela (otro superadmin 403); no se confirma dos veces ni tras cancelar; una pendiente por organizacion", async () => {
    const s = await seguridadSetup();
    const ana = await s.superadmin();
    const beto = await s.superadmin();
    const org = s.base.organizationId;
    const { accion } = (await (await solicitar(s.app, { tipo: "suspender", organizationId: org, motivo: MOTIVO }, bearer(ana.token))).json()) as { accion: Accion };

    expect((await solicitar(s.app, { tipo: "cambiar_plan", organizationId: org, payload: { plan: "trial" }, motivo: "Otra solicitud sobre la misma organizacion pendiente." }, bearer(beto.token))).status).toBe(409);
    expect((await confirmar(s.app, accion.id, bearer(beto.token))).status).toBe(403);
    expect((await cancelar(s.app, accion.id, bearer(beto.token))).status).toBe(403);
    expect(s.orgs.organizationStatus(org)).toBe("active");

    expect((await cancelar(s.app, accion.id, bearer(ana.token))).status).toBe(200);
    expect((await confirmar(s.app, accion.id, bearer(ana.token))).status).toBe(409);
    expect(s.orgs.organizationStatus(org)).toBe("active");

    const otra = (await (await solicitar(s.app, { tipo: "suspender", organizationId: org, motivo: MOTIVO }, bearer(ana.token))).json()) as { accion: Accion };
    expect((await confirmar(s.app, otra.accion.id, bearer(ana.token))).status).toBe(200);
    expect((await confirmar(s.app, otra.accion.id, bearer(ana.token))).status).toBe(409);
  });

  it("validaciones -> 400/404/409 sin efectos", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    const org = s.base.organizationId;
    const h = bearer(sa.token);
    expect((await solicitar(s.app, { tipo: "borrar", organizationId: org, motivo: MOTIVO }, h)).status).toBe(400);
    expect((await solicitar(s.app, { tipo: "suspender", motivo: MOTIVO }, h)).status).toBe(400); // falta organizationId
    expect((await solicitar(s.app, { tipo: "suspender", organizationId: org, motivo: "corto" }, h)).status).toBe(400);
    expect((await solicitar(s.app, { tipo: "suspender", organizationId: "no-existe", motivo: MOTIVO }, h)).status).toBe(404);
    expect((await solicitar(s.app, { tipo: "reactivar", organizationId: org, motivo: MOTIVO }, h)).status).toBe(409); // no esta suspendida
    expect((await solicitar(s.app, { tipo: "cambiar_plan", organizationId: org, payload: { plan: "enterprise" }, motivo: MOTIVO }, h)).status).toBe(400);
    expect((await solicitar(s.app, { tipo: "cambiar_plan", organizationId: org, payload: { plan: "active" }, motivo: MOTIVO }, h)).status).toBe(409); // ya es active
    expect((await solicitar(s.app, { tipo: "alta", payload: { vertical: "citas", name: "X", slug: "Slug Malo" }, motivo: MOTIVO }, h)).status).toBe(400);
    expect((await solicitar(s.app, { tipo: "alta", payload: { vertical: "citas", name: "Otra", slug: "los-taquitos-de-pm" }, motivo: MOTIVO }, h)).status).toBe(409); // slug repetido
    expect((await confirmar(s.app, "no-existe", h)).status).toBe(404);
    expect(s.orgs.organizationStatus(org)).toBe("active");
    expect(((await (await s.app.request("/superadmin/organizaciones/acciones", { headers: h })).json()) as { acciones: unknown[] }).acciones).toEqual([]);
  });

  it("una solicitud vencida no se ejecuta (409) y la organizacion no cambia", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    const org = s.base.organizationId;
    const { accion } = (await (await solicitar(s.app, { tipo: "suspender", organizationId: org, motivo: MOTIVO }, bearer(sa.token))).json()) as { accion: Accion };
    const { vi } = await import("vitest");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    try {
      const { signAccessToken } = await import("@atiende/core-auth");
      const fresco = await signAccessToken({ sub: sa.id, org_id: "", vertical: "restaurantes", property_ids: null, email: sa.email }, s.deps.env.jwtSecret, 900);
      const res = await confirmar(s.app, accion.id, bearer(fresco));
      expect(res.status).toBe(409);
    } finally {
      vi.useRealTimers();
    }
    expect(s.orgs.organizationStatus(org)).toBe("active");
  });

  it("sin repos cableados -> GET disponible:false y POST 503", async () => {
    const s = await seguridadSetup({ sinRepos: true });
    const sa = await s.superadmin();
    expect(await (await s.app.request("/superadmin/organizaciones/acciones", { headers: bearer(sa.token) })).json()).toMatchObject({ disponible: false, acciones: [] });
    expect((await solicitar(s.app, { tipo: "suspender", organizationId: s.base.organizationId, motivo: MOTIVO }, bearer(sa.token))).status).toBe(503);
    expect((await confirmar(s.app, "x", bearer(sa.token))).status).toBe(503);
  });

  it("BASE SIN MIGRAR: not_migrated -> 503 honesto en escrituras y lista vacia en lectura, nunca 500", async () => {
    const notMigrated: OrgAdminRepository = {
      request: async () => ({ availability: "not_migrated", action: null }),
      confirm: async () => ({ availability: "not_migrated", action: null }),
      cancel: async () => ({ availability: "not_migrated", action: null }),
      list: async () => ({ availability: "not_migrated", actions: [] }),
    };
    const s = await seguridadSetup({ orgAdminRepo: () => notMigrated });
    const sa = await s.superadmin();
    const h = bearer(sa.token);
    expect(await (await s.app.request("/superadmin/organizaciones/acciones", { headers: h })).json()).toMatchObject({ disponible: false, acciones: [] });
    expect((await solicitar(s.app, { tipo: "suspender", organizationId: s.base.organizationId, motivo: MOTIVO }, h)).status).toBe(503);
    expect((await confirmar(s.app, "x", h)).status).toBe(503);
    expect((await cancelar(s.app, "x", h)).status).toBe(503);
  });

  it("confirmar es sensible: con MFA activa exige step-up; sin el, 403 y la organizacion NO cambia", async () => {
    const { totpAt } = await import("@atiende/core-auth");
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    const org = s.base.organizationId;
    const enr = (await (await s.app.request("/superadmin/mfa/enrolar", jsonRequestInit({}, bearer(sa.token)))).json()) as { secreto: string };
    const ver = (await (await s.app.request("/superadmin/mfa/verificar", jsonRequestInit({ codigo: totpAt(enr.secreto, Date.now()) }, bearer(sa.token)))).json()) as { stepUpToken: string };
    const { accion } = (await (await solicitar(s.app, { tipo: "suspender", organizationId: org, motivo: MOTIVO }, bearer(sa.token))).json()) as { accion: Accion };

    const sin = await confirmar(s.app, accion.id, bearer(sa.token));
    expect(sin.status).toBe(403);
    expect(await sin.json()).toMatchObject({ code: "stepup_required" });
    expect(s.orgs.organizationStatus(org)).toBe("active");

    const con = await confirmar(s.app, accion.id, bearer(sa.token, { "x-stepup-token": ver.stepUpToken }));
    expect(con.status).toBe(200);
    expect(s.orgs.organizationStatus(org)).toBe("suspended");
  });
});
