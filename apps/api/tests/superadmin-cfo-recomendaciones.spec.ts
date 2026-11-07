// Recomendaciones del CFO de la plataforma, alertas del cockpit en el cron CFO y herramientas financieras del Copiloto.
// El modelo es un doble: se verifica que el prompt no lleve nombres de clientes, que una cifra inventada se descarte y que
// cualquier falla caiga a las reglas deterministas.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmGateway } from "@atiende/agent-core";
import { InMemoryCfoCockpitRepository, InMemoryCfoRepository, InMemoryPylRepository } from "@atiende/db";
import type { CfoOrgRow, UsoCfoRow } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { armarCockpit } from "../src/cfo/cockpit.ts";
import type { DatosCockpit } from "../src/cfo/cockpit.ts";
import { citaSoloCifrasDeHechos, generarRecomendaciones, hechosDelCockpit, RECOMENDACIONES_CFO_LLM_ROLE } from "../src/cfo/recomendaciones.ts";
import { actividadDeRol } from "../src/production/llm-models.ts";
import { buildCatalogoPlataforma, HERRAMIENTAS_FINANCIERAS } from "../src/superadmin-copiloto/catalogo.ts";
import type { AlertaSaliente } from "../src/alertas/tipos.ts";
import { fuentesFalsas, SCOPE_SUPERADMIN } from "./superadmin-copiloto-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

afterEach(() => vi.useRealTimers());

const T0 = new Date("2026-11-15T12:00:00.000Z");

function fila(id: string, nombre: string, parche: Partial<CfoOrgRow> = {}): CfoOrgRow {
  return {
    organizationId: id, organizationName: nombre, organizationSlug: id, vertical: "restaurantes", orgStatus: "active",
    planId: "rest", planNombre: "Restaurantes", precioBaseCentavos: 300000, precioAsientoCentavos: null, asientosIncluidos: 0,
    billingStatus: "activa", billingSeats: null, sucursalesActivas: 1,
    llmMicroUsd: 0, vozMicroUsd: 0, whatsappMicroUsd: 0, telefoniaMicroUsd: 0, otrosMicroUsd: 0,
    eventosTotal: 0, eventosEstimados: 0, minutosVoz: 0, mensajes: 0, llmCapMicroUsd: 900_000_000, llmAlertPct: 80,
    billingPeriodEndMs: null, limites: [], mxnPorUsd: 20, fxFecha: "2026-11-06", fxFuente: "Banxico FIX", ...parche,
  };
}

function uso(id: string, mes: string, parche: Partial<UsoCfoRow> = {}): UsoCfoRow {
  return {
    organizationId: id, mes, vertical: "restaurantes", llmMicroUsd: 0, eventosMicroUsd: 0, llamadas: 0, segundosVoz: 0, segundosPorProveedor: {},
    pedidos: 0, pedidosVoz: 0, pedidosWhatsapp: 0, conversacionesWa: null, minutosFacturables: null, plan: null, ...parche,
  };
}

const PLAN_MEDIDO = { modelo_cobro: "medido", precio_base_mxn_centavos: 300000, minutos_voz_incluidos: 1000, precio_minuto_voz_excedente_mxn_centavos: 300 };

// Pizzeria: 600 llamadas de 3.2 min con ElevenLabs (1,920 min x 0.045 USD x 20 = 1,728 MXN de 3,000) y 192 % del pool proyectado.
// Taqueria: costo medido de LLM de 200 USD (4,000 MXN) contra 3,000 MXN de ingreso -> no rentable, y pago pendiente.
const DATOS: DatosCockpit = {
  mes: "2026-11",
  rows: [fila("p", "Pizzería Modelo Doña Carmen"), fila("t", "Taquería El Güero", { llmMicroUsd: 200_000_000, billingStatus: "pago_pendiente" })],
  rowsPrevias: [fila("p", "Pizzería Modelo Doña Carmen", { mxnPorUsd: 19 })],
  fotos: [],
  uso: [
    uso("p", "2026-11-01", { llamadas: 600, segundosVoz: 115200, segundosPorProveedor: { "elevenlabs-agents": 115200 }, minutosFacturables: 1920, plan: PLAN_MEDIDO }),
    uso("t", "2026-11-01", { llmMicroUsd: 200_000_000 }),
  ],
  supuestos: [],
  capturas: [],
  infra: [],
  cockpitMigrado: true,
  infraMigrada: true,
};

function gatewayFake(complete: LlmGateway["complete"]): LlmGateway {
  return { complete } as unknown as LlmGateway;
}

describe("hechos y recomendaciones", () => {
  const c = armarCockpit(DATOS, T0);

  it("los hechos llevan las cifras del codigo y alias, nunca el nombre del cliente", () => {
    const hechos = hechosDelCockpit(c);
    const todo = hechos.map((h) => h.texto).join(" ");
    expect(todo).not.toMatch(/Pizzería|Taquería|Carmen|Güero/u);
    expect(todo).toMatch(/600 llamadas de 3\.2 min/);
    expect(todo).toMatch(/C\d \(restaurantes, plan Restaurantes\) cierra el mes con margen de -/);
    expect(todo).toMatch(/pago pendiente/);
  });

  it("sin modelo: reglas deterministas con el nombre real repuesto", async () => {
    const r = await generarRecomendaciones(c, undefined);
    expect(r.fuente).toBe("reglas");
    expect(r.recomendaciones.length).toBeGreaterThan(0);
    expect(r.recomendaciones.map((x) => x.explicacion).join(" ")).toMatch(/Taquería El Güero/u);
  });

  it("con modelo: rol de la tabla central, prompt sin nombres y recomendaciones que solo citan cifras de sus hechos", async () => {
    let visto: Parameters<LlmGateway["complete"]>[0] | null = null;
    const hechos = hechosDelCockpit(c);
    const voz = hechos.find((h) => h.texto.includes("llamadas de 3.2 min"))!;
    const gw = gatewayFake(async (opts) => {
      visto = opts;
      return {
        text: JSON.stringify({
          recomendaciones: [
            { titulo: "Acortar llamadas", explicacion: "Las llamadas promedian 3.2 min en restaurantes.", accion: "Revisar el guion.", prioridad: 1, hechos: [voz.id] },
            { titulo: "Inventada", explicacion: "El margen subirá a 87 % si se cambia el plan.", accion: "Cambiar el plan.", prioridad: 2, hechos: [voz.id] },
          ],
        }),
        model: "modelo-barato",
        tokensIn: 1,
        tokensOut: 1,
        costUsd: 0.0004,
        providerId: "openrouter",
        fallbackUsed: false,
        attempts: [],
      };
    });
    const r = await generarRecomendaciones(c, gw);
    expect(visto!.role).toBe(RECOMENDACIONES_CFO_LLM_ROLE);
    expect(actividadDeRol(RECOMENDACIONES_CFO_LLM_ROLE)).toBe("reporte_analisis_financiero");
    const prompt = `${visto!.request.system} ${JSON.stringify(visto!.request.messages)}`;
    expect(prompt).not.toMatch(/Pizzería|Taquería|Carmen|Güero/u);
    expect(r).toMatchObject({ fuente: "modelo", modelo: "modelo-barato", descartadas: 1 });
    expect(r.recomendaciones.map((x) => x.titulo)).toEqual(["Acortar llamadas"]);
  });

  it("modelo caido o respuesta basura -> reglas", async () => {
    expect((await generarRecomendaciones(c, gatewayFake(async () => Promise.reject(new Error("caido"))))).fuente).toBe("reglas");
    const basura = gatewayFake(async () => ({ text: "no es json", model: "m", tokensIn: 1, tokensOut: 1, costUsd: 0, providerId: "p", fallbackUsed: false, attempts: [] }));
    expect((await generarRecomendaciones(c, basura)).fuente).toBe("reglas");
  });

  it("verificador de cifras: ignora alias e ids; rechaza un numero que no esta en los hechos", () => {
    const h = [{ id: "h1", titulo: "", accion: "", impactoMxn: 0, texto: "C2 tiene 1,920 min (192 %)." }];
    expect(citaSoloCifrasDeHechos("C2 lleva 1920 min, 192 % (h1).", h)).toBe(true);
    expect(citaSoloCifrasDeHechos("C2 lleva 2,000 min.", h)).toBe(false);
  });
});

describe("POST /superadmin/cfo/recomendaciones", () => {
  it("superadmin 200 con reglas sin gateway; staff 403", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const s = await seguridadSetup();
    const cfo = new InMemoryCfoRepository();
    cfo.seedRows(DATOS.rows);
    const cockpit = new InMemoryCfoCockpitRepository({ now: () => T0.getTime() });
    cockpit.seedUso(DATOS.uso);
    const pyl = new InMemoryPylRepository();
    const app = buildApp({ ...s.deps, cfoRepo: () => cfo, cfoCockpitRepo: () => cockpit, pylRepo: () => pyl });
    const sa = await s.superadmin();
    cfo.seedSuperadmin(sa.id);
    cockpit.seedSuperadmin(sa.id);
    const res = await app.request("/superadmin/cfo/recomendaciones?mes=2026-11", { method: "POST", headers: bearer(sa.token) });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { fuente: string; recomendaciones: unknown[] };
    expect(b.fuente).toBe("reglas");
    expect(b.recomendaciones.length).toBeGreaterThan(0);
    const st = await s.staff();
    expect((await app.request("/superadmin/cfo/recomendaciones", { method: "POST", headers: bearer(st.token) })).status).toBe(403);
  });
});

describe("cron de alertas CFO con el cockpit", () => {
  it("avisa pool excedido y pago fallido con el umbral capturado; enlaza al CFO de la plataforma", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const s = await seguridadSetup();
    const cfo = new InMemoryCfoRepository();
    cfo.seedRows(DATOS.rows);
    const cockpit = new InMemoryCfoCockpitRepository({ now: () => T0.getTime() });
    cockpit.seedUso([uso("p", "2026-11-01", { minutosFacturables: 1500, plan: PLAN_MEDIDO }), uso("t", "2026-11-01")]);
    cockpit.seedSupuesto({ clave: "umbral_margen_pct", proveedor: "*", valor: 10, fuente: "dueño", nota: null, updatedAt: null });
    const notificar = vi.fn(async (_a: AlertaSaliente) => ({ resultados: [] }));
    const { deps } = conEmisiones({ ...s.deps, cfoRepo: () => cfo, cfoCockpitRepo: () => cockpit, alertas: { notificar } });
    const app = buildApp(deps);
    const res = await app.request("/internal/superadmin/alertas-cfo", { method: "POST", headers: { "x-atiende-internal-secret": deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const tipos = notificar.mock.calls.map((c) => c[0].tipo);
    expect(tipos).toContain("cfo:pool_excedido");
    expect(tipos).toContain("cfo:cobranza_vencida");
    const pool = notificar.mock.calls.find((c) => c[0].tipo === "cfo:pool_excedido")![0];
    expect(pool.href).toBe("/superadmin/cfo-plataforma");
    expect(pool.detalle).toMatch(/voz 150 % de 1,?000 min/);
  });
});

describe("Copiloto: herramientas del CFO de la plataforma", () => {
  it("economia_clientes y metricas_saas son financieras; `soloFinanzas` deja solo esas", () => {
    expect(HERRAMIENTAS_FINANCIERAS).toEqual(expect.arrayContaining(["economia_clientes", "metricas_saas"]));
    const fuentes = fuentesFalsas();
    const todo = buildCatalogoPlataforma(fuentes, SCOPE_SUPERADMIN);
    const solo = buildCatalogoPlataforma(fuentes, SCOPE_SUPERADMIN, { soloFinanzas: true });
    expect(todo.tools.length).toBeGreaterThan(solo.tools.length);
    expect(solo.tools.map((t) => t.name).every((n) => HERRAMIENTAS_FINANCIERAS.includes(n))).toBe(true);
  });
});
