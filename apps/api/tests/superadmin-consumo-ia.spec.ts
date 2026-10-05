// SA-L-22: GET /superadmin/gasto-api/consumo-ia (corte por rol de hoy contra su techo + insights deterministas) de punta a punta
// contra el repo en memoria. Sin SQL nuevo: la autorizacion real en SQL de las funciones que reutiliza vive en
// scripts/verify-copiloto-presupuesto/ y scripts/verify-llm-usage-budget-guard/.
import { describe, expect, it } from "vitest";
import { InMemoryLlmUsageRepository } from "@atiende/db";
import { totpAt } from "@atiende/core-auth";
import { jsonRequestInit } from "./fixtures.ts";
import { armarConsumoIa } from "../src/production/llm-consumo-ia.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

const RUTA = "/superadmin/gasto-api/consumo-ia";

interface Cuerpo {
  readonly hoy: string;
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly roles: readonly { role: string; grupo: string; hoy: { costMicroUsd: number; callCount: number; fallbackCallCount: number }; ventana: { callCount: number }; techoTurnosDia: number | null; maxTurnosOrganizacionHoy: number; pctTecho: number | null }[];
  readonly insights: readonly { codigo: string; severidad: string; role?: string; organizationId?: string; titulo: string }[];
}

async function setup(opciones: { sembrar: boolean } = { sembrar: true }) {
  const s = await seguridadSetup();
  const usage = s.base.deps.llmUsageRepo as InMemoryLlmUsageRepository;
  const org = s.base.organizationId;
  usage.seedOrganization({ id: org, name: "Los Taquitos de PM", slug: "los-taquitos-de-pm", vertical: "restaurantes" });
  const sa = await s.superadmin();
  usage.addPlatformSuperadmin(sa.id);
  const registrar = (role: string, costMicroUsd: number, fallbackUsed: boolean) =>
    usage.recordUsage({ organizationId: org, vertical: "restaurantes", role, providerId: "openrouter:m", model: "m", lane: "interactive", tokensIn: 10, tokensOut: 5, costMicroUsd, fallbackUsed });
  if (opciones.sembrar) {
    // Rol CON techo (data_chat: 400 turnos/dia): 4 llamadas hoy, 2 con respaldo (50 % > 10 %).
    await registrar("restaurantes:data_chat", 1000, false);
    await registrar("restaurantes:data_chat", 1000, true);
    await registrar("restaurantes:data_chat", 1000, true);
    await registrar("restaurantes:data_chat", 1000, false);
    // Rol SIN techo (agente de WhatsApp): sin fallbacks.
    await registrar("restaurantes:whatsapp_agent", 500, false);
  }
  return { s, usage, sa, org };
}

const get = async (s: Awaited<ReturnType<typeof setup>>["s"], token: string) => s.app.request(RUTA, { headers: bearer(token) });

describe("GET /superadmin/gasto-api/consumo-ia", () => {
  it("un staff normal recibe 403 y sin token 401", async () => {
    const { s } = await setup();
    const st = await s.staff();
    expect((await get(s, st.token)).status).toBe(403);
    expect((await s.app.request(RUTA)).status).toBe(401);
  });

  it("devuelve el gasto de HOY por rol contra su techo; un rol sin tope por defecto sale con techo null ('sin techo')", async () => {
    const { s, sa } = await setup();
    const res = await get(s, sa.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Cuerpo;
    expect(body.disponible).toBe(true);
    const chat = body.roles.find((r) => r.role === "restaurantes:data_chat")!;
    expect(chat).toMatchObject({ grupo: "restaurantes", techoTurnosDia: 400, maxTurnosOrganizacionHoy: 4, pctTecho: 1, hoy: { costMicroUsd: 4000, callCount: 4, fallbackCallCount: 2 } });
    const wa = body.roles.find((r) => r.role === "restaurantes:whatsapp_agent")!;
    expect(wa).toMatchObject({ techoTurnosDia: null, pctTecho: null, hoy: { costMicroUsd: 500, callCount: 1 } });
    // Mayor gasto de hoy primero.
    expect(body.roles.map((r) => r.role)).toEqual(["restaurantes:data_chat", "restaurantes:whatsapp_agent"]);
  });

  it("con datos sembrados dispara los insights: rol sin techo y rol con fallbacks por encima del 10 %", async () => {
    const { s, sa } = await setup();
    const body = (await (await get(s, sa.token)).json()) as Cuerpo;
    const codigos = body.insights.map((i) => `${i.codigo}:${i.role ?? ""}`);
    expect(codigos).toContain("rol_sin_techo:restaurantes:whatsapp_agent");
    expect(codigos).toContain("rol_con_fallbacks:restaurantes:data_chat");
    // data_chat SI tiene techo y whatsapp_agent NO tiene fallbacks: ninguno de los dos cruces aparece.
    expect(codigos).not.toContain("rol_sin_techo:restaurantes:data_chat");
    expect(codigos).not.toContain("rol_con_fallbacks:restaurantes:whatsapp_agent");
  });

  it("organizacion por encima del 80 % de su tope mensual: insight; por debajo o exactamente en 80 %: ninguno", async () => {
    const { s, sa, usage, org } = await setup();
    // Gastado este mes = 4500 micro-USD. Tope 5000 => 90 %.
    await usage.setOrgMonthlyCapForSuperadmin(sa.id, org, 5000, 80);
    let body = (await (await get(s, sa.token)).json()) as Cuerpo;
    expect(body.insights.find((i) => i.codigo === "organizacion_cerca_del_tope")).toMatchObject({ organizationId: org, severidad: "atencion" });
    // Tope 5625 => 4500 / 5625 = 80 % exacto: no esta "por encima".
    await usage.setOrgMonthlyCapForSuperadmin(sa.id, org, 5625, 80);
    body = (await (await get(s, sa.token)).json()) as Cuerpo;
    expect(body.insights.some((i) => i.codigo === "organizacion_cerca_del_tope")).toBe(false);
    // Tope 4000 => 112 %: severidad alta.
    await usage.setOrgMonthlyCapForSuperadmin(sa.id, org, 4000, 80);
    body = (await (await get(s, sa.token)).json()) as Cuerpo;
    expect(body.insights.find((i) => i.codigo === "organizacion_cerca_del_tope")?.severidad).toBe("alta");
  });

  it("sin uso registrado: roles e insights vacios (los insights no aparecen sin datos)", async () => {
    const { s, sa } = await setup({ sembrar: false });
    const body = (await (await get(s, sa.token)).json()) as Cuerpo;
    expect(body).toMatchObject({ disponible: true, roles: [], insights: [] });
  });

  it("base SIN migrar (42883): 200 con disponible=false y roles vacios, nunca un 500; el insight de organizaciones sigue saliendo", async () => {
    const { s, sa, usage, org } = await setup();
    await usage.setOrgMonthlyCapForSuperadmin(sa.id, org, 5000, 80);
    usage.listUsageByOrgRoleMonthForSuperadmin = async () => {
      throw Object.assign(new Error("function core.get_llm_usage_by_org_role_month_for_superadmin(uuid, date, date) does not exist"), { code: "42883" });
    };
    const res = await get(s, sa.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Cuerpo;
    expect(body).toMatchObject({ disponible: false, roles: [] });
    expect(body.mensaje).toContain("0047");
    expect(body.insights.map((i) => i.codigo)).toEqual(["organizacion_cerca_del_tope"]);
  });

  it("un error que NO es de migracion pendiente sube como 500 (no se traga)", async () => {
    const { s, sa, usage } = await setup();
    usage.listUsageByOrgRoleMonthForSuperadmin = async () => {
      throw new Error("conexion perdida");
    };
    expect((await get(s, sa.token)).status).toBe(500);
  });

  it("exige step-up con factor MFA activo: sin x-stepup-token 403 stepup_required; con el token 200", async () => {
    const { s, sa } = await setup();
    const post = (path: string, body: unknown) => s.app.request(path, { ...jsonRequestInit(body, bearer(sa.token)), method: "POST" });
    const { secreto } = (await (await post("/superadmin/mfa/enrolar", {})).json()) as { secreto: string };
    const { stepUpToken } = (await (await post("/superadmin/mfa/verificar", { codigo: totpAt(secreto, Date.now()) })).json()) as { stepUpToken: string };
    const sin = await get(s, sa.token);
    expect(sin.status).toBe(403);
    expect(await sin.json()).toMatchObject({ code: "stepup_required" });
    const con = await s.app.request(RUTA, { headers: bearer(sa.token, { "x-stepup-token": stepUpToken }) });
    expect(con.status).toBe(200);
  });
});

describe("armarConsumoIa (funcion pura)", () => {
  const fila = (role: string, callCount: number, fallbackCallCount: number, costMicroUsd = 100) => ({ organizationId: "o1", organizationName: "Org", role, month: "2026-10", costMicroUsd, callCount, fallbackCallCount, tokensIn: 0, tokensOut: 0 });

  it("el umbral de fallbacks es estricto: 10 % exacto no dispara, 11 % si", () => {
    expect(armarConsumoIa({ hoy: [], ventana: [fila("restaurantes:data_chat", 100, 10)], organizaciones: null }).insights).toEqual([]);
    const c = armarConsumoIa({ hoy: [], ventana: [fila("restaurantes:data_chat", 100, 11)], organizaciones: null });
    expect(c.insights.map((i) => i.codigo)).toEqual(["rol_con_fallbacks"]);
  });

  it("suma el mismo rol de varias organizaciones y el techo se compara con la organizacion que mas turnos uso hoy", () => {
    const c = armarConsumoIa({ hoy: [fila("restaurantes:data_chat", 100, 0), { ...fila("restaurantes:data_chat", 300, 0), organizationId: "o2" }], ventana: [], organizaciones: null });
    expect(c.roles[0]).toMatchObject({ hoy: { callCount: 400 }, maxTurnosOrganizacionHoy: 300, techoTurnosDia: 400, pctTecho: 75 });
  });
});
