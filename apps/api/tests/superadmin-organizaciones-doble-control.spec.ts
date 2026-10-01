// SA-06: doble control para suspender una organizacion con contrato vigente (SA-43), cambio de plan
// atado al contrato y su version, un solo uso, vencimiento, step-up y base sin migrar. La semantica real
// en SQL se verifica en scripts/verify-superadmin-gestion-organizaciones/ contra Postgres real.
import { afterEach, describe, expect, it, vi } from "vitest";
import { signAccessToken, totpAt } from "@atiende/core-auth";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup, type SeguridadSetup } from "./superadmin-seguridad-fixtures.ts";

const MOTIVO = "Cliente en mora de 90 dias, se suspende con doble control del equipo.";
type Accion = {
  id: string;
  estado: string;
  tipo: string;
  requiereDobleControl: boolean;
  contratoId: string | null;
  contratoVersion: number | null;
  aprobadoPor: string | null;
  esSolicitante: boolean;
  resultado: Record<string, unknown> | null;
};
type Headers = Record<string, string>;

const post = (s: SeguridadSetup, path: string, body: unknown, h: Headers) => s.app.request(path, jsonRequestInit(body, h));
const solicitar = (s: SeguridadSetup, body: unknown, h: Headers) => post(s, "/superadmin/organizaciones/acciones", body, h);
const accion = (s: SeguridadSetup, id: string, que: "confirmar" | "aprobar" | "cancelar", h: Headers) => post(s, `/superadmin/organizaciones/acciones/${id}/${que}`, {}, h);
async function pedirSuspension(s: SeguridadSetup, h: Headers): Promise<Accion> {
  const res = await solicitar(s, { tipo: "suspender", organizationId: s.base.organizationId, motivo: MOTIVO }, h);
  expect(res.status).toBe(201);
  return ((await res.json()) as { accion: Accion }).accion;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("doble control -- suspender con contrato vigente", () => {
  it("la solicitud queda marcada con doble control y con el contrato; confirmar SIN aprobacion es 409 y no suspende", async () => {
    const s = await seguridadSetup();
    const ana = await s.superadmin();
    s.orgs.seedContract(s.base.organizationId, { contractId: "contrato-1", version: 3 });
    const a = await pedirSuspension(s, bearer(ana.token));
    expect(a).toMatchObject({ estado: "pending", requiereDobleControl: true, contratoId: "contrato-1", contratoVersion: 3, aprobadoPor: null, esSolicitante: true });
    const res = await accion(s, a.id, "confirmar", bearer(ana.token));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("segundo superadmin");
    expect(s.orgs.organizationStatus(s.base.organizationId)).toBe("active");
  });

  it("el solicitante no puede aprobar su propia solicitud (403)", async () => {
    const s = await seguridadSetup();
    const ana = await s.superadmin();
    s.orgs.seedContract(s.base.organizationId, { contractId: "c", version: 1 });
    const a = await pedirSuspension(s, bearer(ana.token));
    expect((await accion(s, a.id, "aprobar", bearer(ana.token))).status).toBe(403);
    expect(s.orgs.organizationStatus(s.base.organizationId)).toBe("active");
  });

  it("otro superadmin aprueba y el solicitante confirma: queda suspendida con el aprobador y el contrato en el resultado", async () => {
    const s = await seguridadSetup();
    const ana = await s.superadmin();
    const beto = await s.superadmin();
    s.orgs.seedContract(s.base.organizationId, { contractId: "c-9", version: 2 });
    const a = await pedirSuspension(s, bearer(ana.token));

    const aprob = await accion(s, a.id, "aprobar", bearer(beto.token));
    expect(aprob.status).toBe(200);
    const aprobada = ((await aprob.json()) as { accion: Accion }).accion;
    expect(aprobada).toMatchObject({ estado: "pending", aprobadoPor: beto.id, esSolicitante: false });
    expect(s.orgs.organizationStatus(s.base.organizationId)).toBe("active"); // aprobar NO ejecuta

    // El aprobador NO puede ejecutar la accion de otro.
    expect((await accion(s, a.id, "confirmar", bearer(beto.token))).status).toBe(403);
    expect(s.orgs.organizationStatus(s.base.organizationId)).toBe("active");

    const conf = await accion(s, a.id, "confirmar", bearer(ana.token));
    expect(conf.status).toBe(200);
    expect(((await conf.json()) as { accion: Accion }).accion).toMatchObject({
      estado: "executed",
      resultado: { status_previo: "active", status: "suspended", doble_control: true, aprobado_por: beto.id, contrato_id: "c-9", contrato_version: 2 },
    });
    expect(s.orgs.organizationStatus(s.base.organizationId)).toBe("suspended");
  });

  it("un solo uso: no se aprueba dos veces, no se confirma dos veces y no se aprueba tras cancelar", async () => {
    const s = await seguridadSetup();
    const ana = await s.superadmin();
    const beto = await s.superadmin();
    s.orgs.seedContract(s.base.organizationId, { contractId: "c", version: 1 });
    const a = await pedirSuspension(s, bearer(ana.token));
    expect((await accion(s, a.id, "aprobar", bearer(beto.token))).status).toBe(200);
    expect((await accion(s, a.id, "aprobar", bearer(beto.token))).status).toBe(409);
    expect((await accion(s, a.id, "confirmar", bearer(ana.token))).status).toBe(200);
    expect((await accion(s, a.id, "confirmar", bearer(ana.token))).status).toBe(409);
    expect((await accion(s, a.id, "aprobar", bearer(beto.token))).status).toBe(409);

    // Reactivar y repetir con otra solicitud: cancelada -> ya no se aprueba.
    const re = ((await (await solicitar(s, { tipo: "reactivar", organizationId: s.base.organizationId, motivo: "El cliente regularizo su pago, se reactiva la cuenta." }, bearer(ana.token))).json()) as { accion: Accion }).accion;
    expect(re.requiereDobleControl).toBe(false);
    expect((await accion(s, re.id, "confirmar", bearer(ana.token))).status).toBe(200);
    const b = await pedirSuspension(s, bearer(ana.token));
    expect((await accion(s, b.id, "cancelar", bearer(ana.token))).status).toBe(200);
    expect((await accion(s, b.id, "aprobar", bearer(beto.token))).status).toBe(409);
  });

  it("staff normal y sin token no aprueban (403/401); nadie aprueba una accion inexistente (404)", async () => {
    const s = await seguridadSetup();
    const ana = await s.superadmin();
    const st = await s.staff();
    s.orgs.seedContract(s.base.organizationId, { contractId: "c", version: 1 });
    const a = await pedirSuspension(s, bearer(ana.token));
    expect((await accion(s, a.id, "aprobar", bearer(st.token))).status).toBe(403);
    expect((await s.app.request(`/superadmin/organizaciones/acciones/${a.id}/aprobar`, jsonRequestInit({}, {}))).status).toBe(401);
    expect((await accion(s, "no-existe", "aprobar", bearer((await s.superadmin()).token))).status).toBe(404);
  });

  it("sin contrato vigente NO hay doble control: aprobar es 409 y un solo superadmin suspende como hoy", async () => {
    const s = await seguridadSetup();
    const ana = await s.superadmin();
    const beto = await s.superadmin();
    const a = await pedirSuspension(s, bearer(ana.token));
    expect(a).toMatchObject({ requiereDobleControl: false, contratoId: null, contratoVersion: null });
    expect((await accion(s, a.id, "aprobar", bearer(beto.token))).status).toBe(409);
    expect((await accion(s, a.id, "confirmar", bearer(ana.token))).status).toBe(200);
    expect(s.orgs.organizationStatus(s.base.organizationId)).toBe("suspended");
  });

  it("el contrato aparece DESPUES de la solicitud: confirmar es 409 y hay que rehacerla con doble control", async () => {
    const s = await seguridadSetup();
    const ana = await s.superadmin();
    const a = await pedirSuspension(s, bearer(ana.token));
    s.orgs.seedContract(s.base.organizationId, { contractId: "c", version: 1 });
    const res = await accion(s, a.id, "confirmar", bearer(ana.token));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("doble control");
    expect(s.orgs.organizationStatus(s.base.organizationId)).toBe("active");
  });

  it("vence a los 60 min (no a los 10): aprobable a los 30 min, y a los 61 min ni se aprueba ni se ejecuta", async () => {
    const s = await seguridadSetup();
    const ana = await s.superadmin();
    const beto = await s.superadmin();
    s.orgs.seedContract(s.base.organizationId, { contractId: "c", version: 1 });
    const a = await pedirSuspension(s, bearer(ana.token));
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const fresco = async (u: { id: string; email: string }) => bearer(await signAccessToken({ sub: u.id, org_id: "", vertical: "restaurantes", property_ids: null, email: u.email }, s.deps.env.jwtSecret, 7200));
      vi.setSystemTime(t0 + 30 * 60_000);
      expect((await accion(s, a.id, "aprobar", await fresco(beto))).status).toBe(200);
      vi.setSystemTime(t0 + 61 * 60_000);
      expect((await accion(s, a.id, "confirmar", await fresco(ana))).status).toBe(409); // vencida
    } finally {
      vi.useRealTimers();
    }
    expect(s.orgs.organizationStatus(s.base.organizationId)).toBe("active");
    const b = await pedirSuspension(s, bearer(ana.token));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 61 * 60_000);
      const frescoBeto = bearer(await signAccessToken({ sub: beto.id, org_id: "", vertical: "restaurantes", property_ids: null, email: beto.email }, s.deps.env.jwtSecret, 7200));
      expect((await accion(s, b.id, "aprobar", frescoBeto)).status).toBe(409); // aprobar una vencida
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cambio de plan atado al contrato (SA-43)", () => {
  it("con contrato vigente no se pasa a prueba (409, sin solicitud); pasar a activa si y registra contrato y version", async () => {
    const s = await seguridadSetup();
    const ana = await s.superadmin();
    s.orgs.seedContract(s.base.organizationId, { contractId: "c-5", version: 4 });
    const h = bearer(ana.token);
    const bajar = await solicitar(s, { tipo: "cambiar_plan", organizationId: s.base.organizationId, payload: { plan: "trial" }, motivo: "Regresa a cuenta de prueba por acuerdo comercial firmado." }, h);
    expect(bajar.status).toBe(409);
    expect(((await bajar.json()) as { message: string }).message).toContain("contrato vigente");
    expect(((await (await s.app.request("/superadmin/organizaciones/acciones", { headers: h })).json()) as { acciones: unknown[] }).acciones).toEqual([]);

    // Una organizacion en prueba con contrato puede pasar a activa; el resultado deja la version.
    s.orgs.seedOrganization("org-prueba", { vertical: "citas", name: "En prueba", slug: "en-prueba", status: "trial" });
    s.orgs.seedContract("org-prueba", { contractId: "c-7", version: 2 });
    const subir = await solicitar(s, { tipo: "cambiar_plan", organizationId: "org-prueba", payload: { plan: "active" }, motivo: "Cliente firmo y paga: se activa su cuenta segun contrato." }, h);
    expect(subir.status).toBe(201);
    const a = ((await subir.json()) as { accion: Accion }).accion;
    expect(a).toMatchObject({ requiereDobleControl: false, contratoId: "c-7", contratoVersion: 2 });
    const conf = await accion(s, a.id, "confirmar", h);
    expect(conf.status).toBe(200);
    expect(((await conf.json()) as { accion: Accion }).accion.resultado).toMatchObject({ status_previo: "trial", status: "active", contrato_id: "c-7", contrato_version: 2 });
    expect(s.orgs.organizationStatus("org-prueba")).toBe("active");
  });

  it("sin contrato el cambio de plan funciona igual que antes y no inventa version", async () => {
    const s = await seguridadSetup();
    const ana = await s.superadmin();
    const h = bearer(ana.token);
    const r = await solicitar(s, { tipo: "cambiar_plan", organizationId: s.base.organizationId, payload: { plan: "trial" }, motivo: "Regresa a cuenta de prueba por acuerdo comercial firmado." }, h);
    expect(r.status).toBe(201);
    const a = ((await r.json()) as { accion: Accion }).accion;
    expect(a).toMatchObject({ contratoId: null, contratoVersion: null });
    expect(((await (await accion(s, a.id, "confirmar", h)).json()) as { accion: Accion }).accion.resultado).toMatchObject({ status: "trial", contrato_id: null, contrato_version: null });
  });

  it("el contrato aparece despues de solicitar pasar a prueba: confirmar es 409", async () => {
    const s = await seguridadSetup();
    const ana = await s.superadmin();
    const h = bearer(ana.token);
    const a = ((await (await solicitar(s, { tipo: "cambiar_plan", organizationId: s.base.organizationId, payload: { plan: "trial" }, motivo: "Regresa a cuenta de prueba por acuerdo comercial firmado." }, h)).json()) as { accion: Accion }).accion;
    s.orgs.seedContract(s.base.organizationId, { contractId: "c", version: 1 });
    expect((await accion(s, a.id, "confirmar", h)).status).toBe(409);
    expect(s.orgs.organizationStatus(s.base.organizationId)).toBe("active");
  });
});

describe("reactivar restaura sin doble control ni perdida de datos", () => {
  it("suspender (doble control) y reactivar vuelve al estado previo; la lista conserva el historial completo", async () => {
    const s = await seguridadSetup();
    const ana = await s.superadmin();
    const beto = await s.superadmin();
    s.orgs.seedOrganization("org-prueba", { vertical: "citas", name: "En prueba", slug: "en-prueba", status: "trial" });
    s.orgs.seedContract("org-prueba", { contractId: "c", version: 1 });
    const sol = ((await (await solicitar(s, { tipo: "suspender", organizationId: "org-prueba", motivo: MOTIVO }, bearer(ana.token))).json()) as { accion: Accion }).accion;
    await accion(s, sol.id, "aprobar", bearer(beto.token));
    await accion(s, sol.id, "confirmar", bearer(ana.token));
    expect(s.orgs.organizationStatus("org-prueba")).toBe("suspended");

    const re = ((await (await solicitar(s, { tipo: "reactivar", organizationId: "org-prueba", motivo: "El cliente regularizo su pago, se reactiva la cuenta." }, bearer(ana.token))).json()) as { accion: Accion }).accion;
    expect(re.requiereDobleControl).toBe(false);
    await accion(s, re.id, "confirmar", bearer(ana.token));
    expect(s.orgs.organizationStatus("org-prueba")).toBe("trial");

    const lista = ((await (await s.app.request("/superadmin/organizaciones/acciones", { headers: bearer(beto.token) })).json()) as { acciones: Accion[] }).acciones;
    expect(lista.map((a) => a.tipo).sort()).toEqual(["reactivar", "suspender"]);
    expect(lista.every((a) => a.esSolicitante === false)).toBe(true); // beto no pidio ninguna
  });
});

describe("step-up y base sin migrar", () => {
  it("aprobar es sensible: con MFA activa sin step-up es 403 y no queda aprobada; con el, 200", async () => {
    const s = await seguridadSetup();
    const ana = await s.superadmin();
    const beto = await s.superadmin();
    s.orgs.seedContract(s.base.organizationId, { contractId: "c", version: 1 });
    const enr = (await (await s.app.request("/superadmin/mfa/enrolar", jsonRequestInit({}, bearer(beto.token)))).json()) as { secreto: string };
    const ver = (await (await s.app.request("/superadmin/mfa/verificar", jsonRequestInit({ codigo: totpAt(enr.secreto, Date.now()) }, bearer(beto.token)))).json()) as { stepUpToken: string };
    const a = await pedirSuspension(s, bearer(ana.token));

    const sin = await accion(s, a.id, "aprobar", bearer(beto.token));
    expect(sin.status).toBe(403);
    expect(await sin.json()).toMatchObject({ code: "stepup_required" });
    const lista = async () => (await (await s.app.request("/superadmin/organizaciones/acciones", { headers: bearer(ana.token) })).json()) as { acciones: Accion[] };
    expect((await lista()).acciones[0]).toMatchObject({ aprobadoPor: null });

    const con = await accion(s, a.id, "aprobar", bearer(beto.token, { "x-stepup-token": ver.stepUpToken }));
    expect(con.status).toBe(200);
    expect((await lista()).acciones[0]).toMatchObject({ aprobadoPor: beto.id });
  });

  it("sin repos cableados, aprobar es 503 (nunca un exito simulado)", async () => {
    const s = await seguridadSetup({ sinRepos: true });
    const sa = await s.superadmin();
    expect((await accion(s, "x", "aprobar", bearer(sa.token))).status).toBe(503);
  });
});
