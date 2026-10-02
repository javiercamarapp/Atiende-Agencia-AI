// CHAT-07: reporte de gasto por organizacion/rol/mes y tope diario de turnos por rol del superadmin. Rutas de punta a punta contra los repos
// en memoria; el step-up (401/403 sin el) se prueba con un factor MFA activo; la autorizacion real en SQL vive en
// scripts/verify-copiloto-presupuesto/.
import { describe, expect, it } from "vitest";
import { InMemoryLlmUsageRepository } from "@atiende/db";
import { totpAt } from "@atiende/core-auth";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

const hoy = new Date().toISOString().slice(0, 10);
const mes = hoy.slice(0, 7);

async function setup() {
  const s = await seguridadSetup();
  const usage = s.base.deps.llmUsageRepo as InMemoryLlmUsageRepository;
  usage.seedOrganization({ id: s.base.organizationId, name: "Los Taquitos de PM", slug: "los-taquitos-de-pm", vertical: "restaurantes" });
  const sa = await s.superadmin();
  usage.addPlatformSuperadmin(sa.id);
  await usage.recordUsage({ organizationId: s.base.organizationId, vertical: "restaurantes", role: "restaurantes:data_chat", providerId: "openrouter:m", model: "m", lane: "interactive", tokensIn: 10, tokensOut: 5, costMicroUsd: 1200, fallbackUsed: false });
  await usage.recordUsage({ organizationId: s.base.organizationId, vertical: "restaurantes", role: "restaurantes:data_chat", providerId: "openrouter:m", model: "m", lane: "interactive", tokensIn: 10, tokensOut: 5, costMicroUsd: 800, fallbackUsed: true });
  await usage.recordUsage({ organizationId: s.base.organizationId, vertical: "plataforma", role: "plataforma:titulos_resumenes", providerId: "openrouter:q", model: "q", lane: "background", tokensIn: 1, tokensOut: 1, costMicroUsd: 30, fallbackUsed: false });
  return { s, usage, sa };
}

const req = (app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> }, method: string, path: string, body: unknown, headers: Record<string, string>) =>
  app.request(path, { ...jsonRequestInit(body, headers), method });

describe("GET /superadmin/gasto-api/por-rol", () => {
  it("un staff normal recibe 403 y sin token 401", async () => {
    const { s } = await setup();
    const st = await s.staff();
    expect((await s.app.request("/superadmin/gasto-api/por-rol", { headers: bearer(st.token) })).status).toBe(403);
    expect((await s.app.request("/superadmin/gasto-api/por-rol")).status).toBe(401);
  });

  it("el superadmin ve el gasto REAL agrupado por organizacion, rol y mes (suma de lo registrado, sin inventar)", async () => {
    const { s, sa } = await setup();
    const res = await s.app.request("/superadmin/gasto-api/por-rol", { headers: bearer(sa.token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; filas: { organizationId: string; role: string; month: string; costMicroUsd: number; callCount: number; fallbackCallCount: number }[] };
    expect(body.disponible).toBe(true);
    const chat = body.filas.find((f) => f.role === "restaurantes:data_chat");
    expect(chat).toMatchObject({ organizationId: s.base.organizationId, month: mes, costMicroUsd: 2000, callCount: 2, fallbackCallCount: 1 });
    expect(body.filas.find((f) => f.role === "plataforma:titulos_resumenes")).toMatchObject({ costMicroUsd: 30 });
  });

  it("sin uso registrado la lista viene vacia (estado vacio honesto)", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    (s.base.deps.llmUsageRepo as InMemoryLlmUsageRepository).addPlatformSuperadmin(sa.id);
    const body = (await (await s.app.request("/superadmin/gasto-api/por-rol", { headers: bearer(sa.token) })).json()) as { disponible: boolean; filas: unknown[] };
    expect(body).toMatchObject({ disponible: true, filas: [] });
  });

  it("un rango mal formado responde 400", async () => {
    const { s, sa } = await setup();
    expect((await s.app.request("/superadmin/gasto-api/por-rol?from=ayer", { headers: bearer(sa.token) })).status).toBe(400);
  });

  it("base SIN migrar (42883): disponible=false y lista vacia, nunca un 500", async () => {
    const { s, sa, usage } = await setup();
    usage.listUsageByOrgRoleMonthForSuperadmin = async () => {
      throw Object.assign(new Error("function core.get_llm_usage_by_org_role_month_for_superadmin(uuid, date, date) does not exist"), { code: "42883" });
    };
    const res = await s.app.request("/superadmin/gasto-api/por-rol", { headers: bearer(sa.token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false, filas: [] });
  });
});

describe("topes diarios por rol de una organizacion", () => {
  it("lista los defaults del sistema y los topes propios; el PUT guarda un tope propio y lo devuelve con el uso de hoy", async () => {
    const { s, sa, usage } = await setup();
    const org = s.base.organizationId;
    const antes = (await (await s.app.request(`/superadmin/gasto-api/organizaciones/${org}/topes-rol`, { headers: bearer(sa.token) })).json()) as { defaults: { role: string; maxTurnosDia: number }[]; propios: unknown[] };
    expect(antes.propios).toEqual([]);
    expect(antes.defaults.find((d) => d.role === "restaurantes:data_chat")).toEqual({ role: "restaurantes:data_chat", maxTurnosDia: 400 });
    expect(antes.defaults.some((d) => d.role === "restaurantes:whatsapp_agent")).toBe(false);

    const put = await req(s.app, "PUT", `/superadmin/gasto-api/organizaciones/${org}/topes-rol`, { role: "restaurantes:data_chat", maxTurnosDia: 30 }, bearer(sa.token));
    expect(put.status).toBe(200);
    await usage.consumeRoleTurn(org, "restaurantes:data_chat", 400);
    const despues = (await (await s.app.request(`/superadmin/gasto-api/organizaciones/${org}/topes-rol`, { headers: bearer(sa.token) })).json()) as { propios: { role: string; maxTurnosDia: number; turnosHoy: number }[] };
    expect(despues.propios).toEqual([{ role: "restaurantes:data_chat", maxTurnosDia: 30, turnosHoy: 1 }]);
    // El tope propio manda sobre el default: tras 30 turnos el 31 se rechaza.
    for (let i = 1; i < 30; i += 1) expect((await usage.consumeRoleTurn(org, "restaurantes:data_chat", 400)).allowed).toBe(true);
    expect(await usage.consumeRoleTurn(org, "restaurantes:data_chat", 400)).toMatchObject({ allowed: false, used: 30, maxTurnos: 30 });
  });

  it("validacion: rol sin tope diario, tope fuera de rango, no entero o id invalido -> 400; organizacion inexistente -> 404; staff -> 403", async () => {
    const { s, sa } = await setup();
    const org = s.base.organizationId;
    const put = (id: string, body: unknown) => req(s.app, "PUT", `/superadmin/gasto-api/organizaciones/${id}/topes-rol`, body, bearer(sa.token));
    expect((await put(org, { role: "restaurantes:whatsapp_agent", maxTurnosDia: 10 })).status).toBe(400);
    expect((await put(org, { role: "restaurantes:data_chat", maxTurnosDia: 0 })).status).toBe(400);
    expect((await put(org, { role: "restaurantes:data_chat", maxTurnosDia: 100001 })).status).toBe(400);
    expect((await put(org, { role: "restaurantes:data_chat", maxTurnosDia: 2.5 })).status).toBe(400);
    expect((await put("no-es-uuid", { role: "restaurantes:data_chat", maxTurnosDia: 5 })).status).toBe(400);
    expect((await put("00000000-0000-4000-8000-0000000000ff", { role: "restaurantes:data_chat", maxTurnosDia: 5 })).status).toBe(404);
    const st = await s.staff();
    expect((await req(s.app, "PUT", `/superadmin/gasto-api/organizaciones/${org}/topes-rol`, { role: "restaurantes:data_chat", maxTurnosDia: 5 }, bearer(st.token))).status).toBe(403);
  });
});

describe("step-up: el reporte y los topes por rol lo exigen con factor MFA activo", () => {
  it("sin x-stepup-token 403 stepup_required; con el token, 200", async () => {
    const { s, sa } = await setup();
    const enr = await req(s.app, "POST", "/superadmin/mfa/enrolar", {}, bearer(sa.token));
    const { secreto } = (await enr.json()) as { secreto: string };
    const ver = await req(s.app, "POST", "/superadmin/mfa/verificar", { codigo: totpAt(secreto, Date.now()) }, bearer(sa.token));
    const { stepUpToken } = (await ver.json()) as { stepUpToken: string };
    const org = s.base.organizationId;
    const rutas: [string, string, unknown][] = [
      ["GET", "/superadmin/gasto-api/por-rol", undefined],
      ["GET", `/superadmin/gasto-api/organizaciones/${org}/topes-rol`, undefined],
      ["PUT", `/superadmin/gasto-api/organizaciones/${org}/topes-rol`, { role: "restaurantes:data_chat", maxTurnosDia: 30 }],
    ];
    for (const [method, path, body] of rutas) {
      const sin = await s.app.request(path, { method, headers: bearer(sa.token), ...(body ? jsonRequestInit(body, bearer(sa.token)) : {}), ...(body ? { method } : {}) });
      expect(sin.status, `${method} ${path}`).toBe(403);
      expect(await sin.json()).toMatchObject({ code: "stepup_required" });
      const con = await s.app.request(path, { method, ...(body ? jsonRequestInit(body, bearer(sa.token, { "x-stepup-token": stepUpToken })) : { headers: bearer(sa.token, { "x-stepup-token": stepUpToken }) }), method });
      expect(con.status, `${method} ${path} con step-up`).toBe(200);
    }
  });
});
