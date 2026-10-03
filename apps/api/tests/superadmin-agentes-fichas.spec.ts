// Fichas de agente (SA-L-09) y Model Ops (SA-L-10): rutas de punta a punta contra los repos en memoria. La autorizacion real en
// SQL se verifica en scripts/verify-superadmin-agentes-fichas/.
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryConsolaRepository, InMemoryFichasAgenteRepository, InMemorySaludRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { esRolDeFicha, rolesDelGateway } from "../src/routes/superadmin-agentes-fichas.ts";
import { ALL_PRODUCTION_ROLES } from "../src/production/llm-gateway.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

afterEach(() => vi.useRealTimers());

const T_MEDIODIA = new Date("2026-09-30T18:00:00.000Z");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cuerpo = async (res: Response): Promise<any> => res.json();

async function setup(opciones: { fichas?: InMemoryFichasAgenteRepository | null; consola?: InMemoryConsolaRepository | null } = {}) {
  const s = await seguridadSetup();
  const fichas = opciones.fichas === undefined ? new InMemoryFichasAgenteRepository() : opciones.fichas;
  const consola = opciones.consola === undefined ? new InMemoryConsolaRepository() : opciones.consola;
  const deps = { ...s.deps, ...(fichas ? { fichasAgenteRepo: () => fichas } : {}), ...(consola ? { consolaRepo: () => consola } : {}) };
  const app = buildApp(deps);
  return {
    s, fichas, consola, app,
    async superadmin() {
      const sa = await s.superadmin();
      fichas?.seedSuperadmin(sa.id);
      consola?.seedSuperadmin(sa.id);
      (deps.saludRepo as InMemorySaludRepository).addPlatformSuperadmin(sa.id);
      return sa;
    },
  };
}
const get = (app: ReturnType<typeof buildApp>, path: string, token: string) => app.request(path, { headers: bearer(token) });

const act = (vertical: string, role: string, llamadasHist: number, costoHistMicroUsd: number, fallbackHist = 0) => ({
  vertical, role, llamadasHist, costoHistMicroUsd, fallbackHist, llamadas30d: llamadasHist, costo30dMicroUsd: costoHistMicroUsd, fallback30d: fallbackHist,
});
const modelo = (vertical: string, role: string, providerId: string, model: string, lane: string, llamadas: number, fallbacks: number, costoMicroUsd: number) => ({
  vertical, role, providerId, model, lane, llamadas, fallbacks, costoMicroUsd, tokensIn: llamadas * 10, tokensOut: llamadas * 5,
});

function sembrar(t: Awaited<ReturnType<typeof setup>>): void {
  t.consola!.seed({
    agentesActividad: {
      ok: true,
      data: [
        act("restaurantes", "restaurantes:whatsapp_agent", 100, 4_000_000, 5),
        act("restaurantes", "restaurantes:whatsapp_agent_escalated", 20, 3_000_000),
        act("rentas", "rentas:mensajeria_agent", 30, 1_000_000),
        act("restaurantes", "restaurantes:data_chat", 999, 9_000_000),
        act("licitaciones", "licitaciones:requirement_extractor", 50, 2_500_000),
        act("despachos", "despachos:conciliacion_llm_agent", 12, 600_000),
      ],
    },
    conversacionesWa: {
      ok: true,
      data: [{ vertical: "restaurantes", total: 40, razon: null }, { vertical: "rentas", total: 8, razon: null }, { vertical: "hoteles", total: null, razon: "fuente_no_migrada" }],
    },
  });
  t.fichas!.seed({
    documentosExtraidos: { ok: true, data: { documentos: 6, requisitos: 41, licitaciones: 3, razon: null } },
    conciliados: { ok: true, data: { movimientosConciliados: 30, porMotor: 20, porLlmAprobado: 6, porManual: 4, sugerenciasPendientes: 2, sugerenciasTotal: 9, razon: null } },
    vozPorVertical: { ok: true, data: [{ vertical: "restaurantes", minutosVoz: 12.5, costoMicroUsd: 500_000, eventos: 3 }] },
    actividadDiaria: {
      ok: true,
      data: [
        { dia: "2026-09-30", vertical: "restaurantes", role: "restaurantes:whatsapp_agent", llamadas: 7, costoMicroUsd: 700_000, fallbacks: 1 },
        { dia: "2026-09-28", vertical: "restaurantes", role: "restaurantes:whatsapp_agent_escalated", llamadas: 2, costoMicroUsd: 200_000, fallbacks: 0 },
        { dia: "2026-09-30", vertical: "restaurantes", role: "restaurantes:data_chat", llamadas: 500, costoMicroUsd: 5_000_000, fallbacks: 0 },
      ],
    },
    modelosPorRol: {
      ok: true,
      data: [
        modelo("restaurantes", "restaurantes:whatsapp_agent", "prov-a", "m1", "interactive", 60, 3, 2_000_000),
        modelo("restaurantes", "restaurantes:whatsapp_agent", "prov-b", "m2", "batch", 10, 5, 400_000),
        modelo("restaurantes", "restaurantes:whatsapp_agent_escalated", "prov-a", "m1", "interactive", 5, 0, 500_000),
        modelo("restaurantes", "restaurantes:data_chat", "prov-a", "m9", "interactive", 100, 0, 9_000_000),
        modelo("licitaciones", "licitaciones:requirement_extractor", "prov-a", "m1", "background", 8, 0, 300_000),
      ],
    },
  });
}

describe("seguridad", () => {
  it("sin sesion 401, staff normal 403, y el superadmin lee sin step-up", async () => {
    const t = await setup();
    const st = await t.s.staff();
    for (const ruta of ["/superadmin/agentes/extractor", "/superadmin/agentes/conciliacion", "/superadmin/agentes/whatsapp", "/superadmin/model-ops"]) {
      expect((await t.app.request(ruta)).status).toBe(401);
      expect((await get(t.app, ruta, st.token)).status).toBe(403);
    }
    const sa = await t.superadmin();
    for (const ruta of ["/superadmin/agentes/extractor", "/superadmin/agentes/conciliacion", "/superadmin/agentes/whatsapp", "/superadmin/model-ops"]) {
      expect((await get(t.app, ruta, sa.token)).status).toBe(200);
    }
  });

  it("solo lectura: un POST no existe", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    for (const ruta of ["/superadmin/agentes/whatsapp", "/superadmin/model-ops"]) {
      expect([404, 405]).toContain((await t.app.request(ruta, { method: "POST", headers: bearer(sa.token) })).status);
    }
  });

  it(":ficha desconocida es 404 y /superadmin/agentes/corridas sigue siendo de la bitacora de corridas", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    expect((await get(t.app, "/superadmin/agentes/inexistente", sa.token)).status).toBe(404);
    const corridas = await get(t.app, "/superadmin/agentes/corridas", sa.token);
    expect(corridas.status).toBe(200);
    expect(await cuerpo(corridas)).toHaveProperty("disponible");
  });

  it("si la fuente no reconoce al caller como superadmin, entrega fuentes en error y listas vacias, nunca cifras (defensa en profundidad)", async () => {
    const t = await setup();
    sembrar(t);
    const sa = await t.s.superadmin(); // superadmin de la API, pero NO sembrado en las fuentes de datos
    (t.s.deps.saludRepo as InMemorySaludRepository).addPlatformSuperadmin(sa.id);
    const b = await cuerpo(await get(t.app, "/superadmin/agentes/extractor", sa.token));
    expect(b.documentosExtraidos).toMatchObject({ valor: null, codigo: "error" });
    expect(b.serie7d.valor.every((d: { llamadas: number }) => d.llamadas === 0)).toBe(true);
    expect(b.costoPorModelo.valor).toEqual([]);
  });
});

describe("GET /superadmin/agentes/:ficha", () => {
  it("base sin migrar: 200 con disponible:false y cada campo null con su razon (nunca 0)", async () => {
    const t = await setup({ fichas: null, consola: null });
    const sa = await t.superadmin();
    for (const ficha of ["extractor", "conciliacion", "whatsapp"]) {
      const b = await cuerpo(await get(t.app, `/superadmin/agentes/${ficha}`, sa.token));
      expect(b.disponible).toBe(false);
      expect(b.mensaje).toMatch(/0049/);
      expect(b.gastado.valor).toBeNull();
      expect(b.gastado.razon).toBeTruthy();
      expect(b.llamadas.valor).toBeNull();
      expect(b.serie7d.valor).toBeNull();
      expect(b.costoPorModelo.valor).toBeNull();
    }
  });

  it("extractor: solo cuenta su rol, documentos extraidos de la fuente y precision con estado vacio honesto", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T_MEDIODIA);
    const t = await setup();
    sembrar(t);
    const sa = await t.superadmin();
    const b = await cuerpo(await get(t.app, "/superadmin/agentes/extractor", sa.token));
    expect(b.disponible).toBe(true);
    expect(b.nombre).toBe("Agente extractor");
    expect(b.nombreConfirmado).toBe(false);
    expect(b.roles).toEqual(["licitaciones:requirement_extractor"]);
    expect(b.gastado.valor).toEqual({ totalUsd: 2.5, llmUsd: 2.5, vozUsd: null });
    expect(b.llamadas.valor).toBe(50);
    expect(b.documentosExtraidos.valor).toEqual({ documentos: 6, requisitos: 41, licitaciones: 3 });
    expect(b.precision.valor).toBeNull();
    expect(b.precision.razon).toMatch(/verdad de terreno/);
    expect(b.costoPorModelo.valor).toEqual([{ proveedor: "prov-a", modelo: "m1", llamadas: 8, fallbacks: 0, costoUsd: 0.3, tokensEntrada: 80, tokensSalida: 40 }]);
    expect(t.fichas!.llamadas.actividadDiaria).toEqual([{ desde: "2026-09-24", hasta: "2026-09-30" }]);
    expect(t.fichas!.llamadas.modelosPorRol).toEqual([{ desde: "2026-09-01", hasta: "2026-09-30" }]);
  });

  it("extractor: sin la tabla de requisitos, documentos extraidos es null con razon (no 0) y el resto de la ficha sigue", async () => {
    const t = await setup();
    sembrar(t);
    t.fichas!.seed({ documentosExtraidos: { ok: true, data: { documentos: null, requisitos: null, licitaciones: null, razon: "fuente_no_migrada" } } });
    const sa = await t.superadmin();
    const b = await cuerpo(await get(t.app, "/superadmin/agentes/extractor", sa.token));
    expect(b.documentosExtraidos.valor).toBeNull();
    expect(b.documentosExtraidos.codigo).toBe("fuente_no_migrada");
    expect(b.llamadas.valor).toBe(50);
  });

  it("conciliacion: movimientos conciliados por origen y sugerencias; fuente caida -> null con razon", async () => {
    const t = await setup();
    sembrar(t);
    const sa = await t.superadmin();
    let b = await cuerpo(await get(t.app, "/superadmin/agentes/conciliacion", sa.token));
    expect(b.roles).toEqual(["despachos:conciliacion_llm_agent"]);
    expect(b.llamadas.valor).toBe(12);
    expect(b.movimientosConciliados.valor).toEqual({ total: 30, porMotor: 20, porLlmAprobado: 6, porManual: 4, sugerenciasPendientes: 2, sugerenciasTotal: 9 });
    t.fichas!.seed({ conciliados: { ok: false, razon: "error" } });
    b = await cuerpo(await get(t.app, "/superadmin/agentes/conciliacion", sa.token));
    expect(b.movimientosConciliados.valor).toBeNull();
    expect(b.movimientosConciliados.codigo).toBe("error");
    expect(b.llamadas.valor).toBe(12);
  });

  it("whatsapp: LLM (3 roles de agente, sin data_chat) mas voz, escalamiento, desglose por vertical y serie de 7 dias rellena", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T_MEDIODIA);
    const t = await setup();
    sembrar(t);
    const sa = await t.superadmin();
    const b = await cuerpo(await get(t.app, "/superadmin/agentes/whatsapp", sa.token));
    expect(b.roles).toEqual(["rentas:mensajeria_agent", "restaurantes:whatsapp_agent", "restaurantes:whatsapp_agent_escalated"]);
    expect(b.llamadas.valor).toBe(150);
    expect(b.gastado.valor).toEqual({ totalUsd: 8.5, llmUsd: 8, vozUsd: 0.5 });
    expect(b.conversaciones.valor).toBe(48);
    expect(b.minutosVoz.valor).toBe(12.5);
    expect(b.escalamiento.valor).toEqual({ escaladas: 20, total: 150, tasaPct: 13.3 });
    expect(b.fallbacks.valor).toEqual({ total: 5, tasaPct: 3.3 });
    const rest = b.porVertical.valor.find((v: { vertical: string }) => v.vertical === "restaurantes");
    expect(rest).toMatchObject({ llamadas: 120, escaladas: 20, costoLlmUsd: 7, conversaciones: { valor: 40 }, minutosVoz: { valor: 12.5 }, costoVozUsd: { valor: 0.5 } });
    const rentas = b.porVertical.valor.find((v: { vertical: string }) => v.vertical === "rentas");
    expect(rentas).toMatchObject({ llamadas: 30, conversaciones: { valor: 8 }, minutosVoz: { valor: 0 } });
    const hoteles = b.porVertical.valor.find((v: { vertical: string }) => v.vertical === "hoteles");
    expect(hoteles.conversaciones).toMatchObject({ valor: null, codigo: "fuente_no_migrada" });
    expect(b.serie7d.valor).toHaveLength(7);
    expect(b.serie7d.valor[0]).toEqual({ dia: "2026-09-24", llamadas: 0, costoUsd: 0 });
    expect(b.serie7d.valor.find((d: { dia: string }) => d.dia === "2026-09-28")).toEqual({ dia: "2026-09-28", llamadas: 2, costoUsd: 0.2 });
    expect(b.serie7d.valor[6]).toEqual({ dia: "2026-09-30", llamadas: 7, costoUsd: 0.7 });
  });

  it("whatsapp: sin eventos de voz legibles el gasto total NO se inventa (null con la razon de la voz) pero el LLM sigue", async () => {
    const t = await setup();
    sembrar(t);
    t.fichas!.seed({ vozPorVertical: { ok: false, razon: "no_migrado" } });
    const sa = await t.superadmin();
    const b = await cuerpo(await get(t.app, "/superadmin/agentes/whatsapp", sa.token));
    expect(b.gastado.valor).toBeNull();
    expect(b.gastado.codigo).toBe("no_migrado");
    expect(b.minutosVoz.valor).toBeNull();
    expect(b.llamadas.valor).toBe(150);
    expect(b.escalamiento.valor.tasaPct).toBe(13.3);
  });

  it("tasa de escalamiento con cero llamadas es null (no 0 %)", async () => {
    const t = await setup();
    sembrar(t);
    t.consola!.seed({ agentesActividad: { ok: true, data: [] } });
    const sa = await t.superadmin();
    const b = await cuerpo(await get(t.app, "/superadmin/agentes/whatsapp", sa.token));
    expect(b.escalamiento.valor).toEqual({ escaladas: 0, total: 0, tasaPct: null });
  });
});

describe("GET /superadmin/model-ops", () => {
  it("base sin migrar: 200 con disponible:false y fichas con modelo configurado pero consumo null con razon", async () => {
    const t = await setup({ fichas: null });
    const sa = await t.superadmin();
    const b = await cuerpo(await get(t.app, "/superadmin/model-ops", sa.token));
    expect(b.disponible).toBe(false);
    expect(b.mensaje).toMatch(/0049/);
    expect(b.fichas.length).toBeGreaterThan(10);
    const f = b.fichas.find((x: { role: string }) => x.role === "restaurantes:whatsapp_agent");
    expect(f.modelo).toBeTruthy();
    expect(f.llamadas30d.valor).toBeNull();
    expect(f.tasaFallbackPct.valor).toBeNull();
    expect(b.porAgente.valor).toBeNull();
  });

  it("una ficha por rol del gateway con escalera, proveedores, carril real, llamadas, costo y fallback de 30 dias", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T_MEDIODIA);
    const t = await setup();
    sembrar(t);
    const sa = await t.superadmin();
    const b = await cuerpo(await get(t.app, "/superadmin/model-ops", sa.token));
    expect(b.disponible).toBe(true);
    expect(b.desde).toBe("2026-09-01");
    expect(b.fichas.map((f: { role: string }) => f.role)).toEqual(expect.arrayContaining([...ALL_PRODUCTION_ROLES]));
    expect(new Set(b.fichas.map((f: { role: string }) => f.role)).size).toBe(b.fichas.length);
    const wa = b.fichas.find((x: { role: string }) => x.role === "restaurantes:whatsapp_agent");
    expect(wa.escalera.length).toBeGreaterThan(1);
    expect(wa.escalera[0].proveedores.length).toBeGreaterThan(0);
    expect(wa.modelo).toBe(wa.escalera[0].modelo);
    expect(wa.carril.valor).toEqual(["batch", "interactive"]);
    expect(wa.llamadas30d.valor).toBe(70);
    expect(wa.costo30dUsd.valor).toBe(2.4);
    expect(wa.tasaFallbackPct.valor).toBe(11.4);
    expect(wa.circuitBreaker).toMatchObject({ valor: null, codigo: "breaker_no_legible" });
    const sinUso = b.fichas.find((x: { role: string }) => x.role === "citas:data_chat");
    expect(sinUso.llamadas30d.valor).toBe(0);
    expect(sinUso.tasaFallbackPct).toMatchObject({ valor: null, codigo: "sin_llamadas" });
    expect(b.porAgente.valor[0]).toEqual({ role: "restaurantes:data_chat", costoUsd: 9 });
    expect(b.porModelo.valor.map((m: { modelo: string }) => m.modelo)).toEqual(["m9", "m1", "m2"]);
    expect(b.notas.join(" ")).toMatch(/no versiona prompts ni cambia modelos/);
  });

  it("no filtra secretos: ni claves, ni tokens, ni la politica interna del gateway", async () => {
    const t = await setup();
    sembrar(t);
    const sa = await t.superadmin();
    const texto = await (await get(t.app, "/superadmin/model-ops", sa.token)).text();
    expect(texto).not.toMatch(/api[_-]?key|secret|bearer|sk-/i);
  });

  it("usa la ruta vigente de deps.rutaLlmDeRol (LLM_MODELS_JSON) cuando existe", async () => {
    const t = await setup();
    const app = buildApp({ ...t.s.deps, fichasAgenteRepo: () => t.fichas!, consolaRepo: () => t.consola!, rutaLlmDeRol: () => ({ models: [{ model: "anthropic/claude-sonnet-5.5" }] }) });
    const sa = await t.superadmin();
    const b = await cuerpo(await get(app, "/superadmin/model-ops", sa.token));
    expect(b.fichas[0].modelo).toBe("anthropic/claude-sonnet-5.5");
    expect(b.fichas[0].proveedores.length).toBeGreaterThan(0);
  });
});

describe("helpers puros", () => {
  it("esRolDeFicha separa los tres agentes y deja fuera data_chat", () => {
    expect(esRolDeFicha("whatsapp", "citas:whatsapp_agent")).toBe(true);
    expect(esRolDeFicha("whatsapp", "hoteles:whatsapp_agent_escalated")).toBe(true);
    expect(esRolDeFicha("whatsapp", "rentas:mensajeria_agent")).toBe(true);
    expect(esRolDeFicha("whatsapp", "restaurantes:data_chat")).toBe(false);
    expect(esRolDeFicha("extractor", "licitaciones:requirement_extractor")).toBe(true);
    expect(esRolDeFicha("conciliacion", "despachos:conciliacion_llm_agent")).toBe(true);
    expect(esRolDeFicha("extractor", "despachos:conciliacion_llm_agent")).toBe(false);
  });
  it("rolesDelGateway incluye los de produccion sin duplicados", () => {
    const r = rolesDelGateway();
    expect(new Set(r).size).toBe(r.length);
    for (const role of ALL_PRODUCTION_ROLES) expect(r).toContain(role);
  });
});
