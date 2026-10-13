// Costo por componente (P4): eventos de `core.usage_cost_event` con proveedor = deepgram | heygen | openrouter:<modelo>, sin romper los eventos por escalon.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CallStateMachine, LIMITES_POR_DEFECTO, PROVEEDOR_COMPONENTE_RE, costoTotalMicroUsd, crearEscaleraLlamada, eventosCostoLlamada } from "../src/index.ts";
import type { AperturaLlamada, ComponenteCosto, EscalonLlamada, ManejadoresSesion, TramoLlamada } from "../src/index.ts";

const BASE = { vertical: "restaurantes", llamadaId: "sala-1", organizationId: "org", propertyId: "prop", ocurridoEn: "2026-10-13T18:00:00.000Z" } as const;
const HAIKU = "openrouter:anthropic/claude-haiku-5.5";
const comp = (proveedor: string, unidad: ComponenteCosto["unidad"], cantidad: number, costoMicroUsd: number, costoReal: boolean): ComponenteCosto => ({ proveedor, unidad, cantidad, costoMicroUsd, costoReal });

describe("eventosCostoLlamada sin componentes (compatibilidad)", () => {
  it("un tramo sin componentes produce el MISMO evento de siempre (proveedor = escalon, ref_id <llamada>:<escalon>)", () => {
    const e = eventosCostoLlamada({ ...BASE, tramos: [{ escalon: "gemini-3.8-live", duracionS: 90, costoReportadoMicroUsd: 0 }] });
    expect(e).toEqual([{ organizationId: "org", propertyId: "prop", ocurridoEn: BASE.ocurridoEn, categoria: "voz", proveedor: "gemini-3.8-live", unidad: "segundo", cantidad: 90, costoMicroUsd: 112_500, costoEstimado: true, refTipo: "voz_restaurantes", refId: "sala-1:gemini-3.8-live" }]);
  });
  it("una lista vacia de componentes en el objeto (no en el tipo) no desglosa nada", () => {
    const e = eventosCostoLlamada({ ...BASE, tramos: [{ escalon: "cascada-openrouter", duracionS: 30, costoReportadoMicroUsd: 0, componentes: [] }] });
    expect(e.map((x) => [x.proveedor, x.refId, x.costoMicroUsd])).toEqual([["cascada-openrouter", "sala-1:cascada-openrouter", 7_000]]);
  });
});

describe("eventosCostoLlamada con componentes", () => {
  const tramo: TramoLlamada = {
    escalon: "cascada-openrouter",
    duracionS: 60,
    costoReportadoMicroUsd: 4_800 + 13_500 + 321,
    componentes: [comp("deepgram", "segundo", 60, 4_800, false), comp("heygen", "unidad", 900, 13_500, false), comp(HAIKU, "unidad", 3, 321, true)],
  };

  it("sale un evento por componente con su proveedor, unidad, ref_id y costo_estimado (false solo donde el proveedor reporta el costo)", () => {
    const e = eventosCostoLlamada({ ...BASE, tramos: [tramo] });
    expect(e.map((x) => [x.proveedor, x.unidad, x.cantidad, x.costoMicroUsd, x.costoEstimado, x.refId])).toEqual([
      ["deepgram", "segundo", 60, 4_800, true, "sala-1:cascada-openrouter:deepgram"],
      ["heygen", "unidad", 900, 13_500, true, "sala-1:cascada-openrouter:heygen"],
      [HAIKU, "unidad", 3, 321, false, `sala-1:cascada-openrouter:${HAIKU}`],
    ]);
  });
  it("la suma de los eventos es el costo reportado (el tope por llamada ve el mismo total que la base) y no hay evento de escalon duplicado", () => {
    const e = eventosCostoLlamada({ ...BASE, tramos: [tramo] });
    expect(costoTotalMicroUsd(e)).toBe(tramo.costoReportadoMicroUsd);
    expect(e.some((x) => x.proveedor === "cascada-openrouter")).toBe(false);
  });
  it("lo no desglosado del tramo sigue saliendo en el evento del escalon con su ref_id de siempre", () => {
    const e = eventosCostoLlamada({ ...BASE, tramos: [{ ...tramo, costoReportadoMicroUsd: tramo.costoReportadoMicroUsd + 1_000 }] });
    expect(e.at(-1)).toMatchObject({ proveedor: "cascada-openrouter", refId: "sala-1:cascada-openrouter", costoMicroUsd: 1_000 });
    expect(costoTotalMicroUsd(e)).toBe(tramo.costoReportadoMicroUsd + 1_000);
  });
  it("el reintento es idempotente: mismos ref_id, mismo orden, mismos importes", () => {
    const a = eventosCostoLlamada({ ...BASE, tramos: [tramo] });
    const b = eventosCostoLlamada({ ...BASE, tramos: [tramo] });
    expect(b).toEqual(a);
    expect(new Set(a.map((x) => x.refId)).size).toBe(a.length);
  });
  it("dos tramos del mismo escalon suman por componente (una sola fila por componente)", () => {
    const e = eventosCostoLlamada({ ...BASE, tramos: [{ ...tramo, costoReportadoMicroUsd: 4_800, componentes: [comp("deepgram", "segundo", 60, 4_800, false)] }, { ...tramo, costoReportadoMicroUsd: 2_400, componentes: [comp("deepgram", "segundo", 30, 2_400, false)] }] });
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ proveedor: "deepgram", cantidad: 90, costoMicroUsd: 7_200 });
  });
  it("un aporte estimado junto a otro real deja el componente ESTIMADO (nunca se marca real un costo parcialmente supuesto)", () => {
    const e = eventosCostoLlamada({ ...BASE, tramos: [{ ...tramo, costoReportadoMicroUsd: 300, componentes: [comp(HAIKU, "unidad", 1, 100, true), comp(HAIKU, "unidad", 1, 200, false)] }] });
    expect(e[0]).toMatchObject({ proveedor: HAIKU, costoMicroUsd: 300, costoEstimado: true });
  });
  it("el LLM con costo real queda con costo_estimado = false y gana al piso por minuto", () => {
    const e = eventosCostoLlamada({ ...BASE, tramos: [{ escalon: "cascada-openrouter", duracionS: 600, costoReportadoMicroUsd: 50, componentes: [comp(HAIKU, "unidad", 1, 50, true)] }] });
    expect(e).toEqual([expect.objectContaining({ proveedor: HAIKU, costoMicroUsd: 50, costoEstimado: false })]);
  });
  it.each([["gemini"], ["Deepgram"], [""], ["openrouter:"], ["openrouter:../x"], ["x".repeat(81)], ["deepgram:extra:cosa:mas"]])("proveedor de componente invalido %j se rechaza", (proveedor) => {
    expect(PROVEEDOR_COMPONENTE_RE.test(proveedor)).toBe(false);
    expect(() => eventosCostoLlamada({ ...BASE, tramos: [{ ...tramo, componentes: [comp(proveedor, "unidad", 1, 1, false)] }] })).toThrow(/proveedor de componente invalido/);
  });
  it.each([["deepgram"], ["heygen"], [HAIKU], ["openrouter:anthropic/claude-sonnet-5.5"], ["openrouter:google/gemini-3.8-flash:nitro"]])("proveedor valido %j", (p) => {
    expect(PROVEEDOR_COMPONENTE_RE.test(p)).toBe(true);
    expect(p.length).toBeLessThanOrEqual(80);
  });
});

describe("la escalera desglosa el costo que la sesion reporta por componente", () => {
  const APERTURA = { instruccion: "x", voiceId: "v", herramientas: [] } as unknown as AperturaLlamada;
  function escalonConCostos(): { escalon: EscalonLlamada; costo: ManejadoresSesion["costo"] } {
    const ref: { h: ManejadoresSesion | null } = { h: null };
    const escalon: EscalonLlamada = {
      id: "cascada-openrouter",
      abrirSesion: async (_a, h) => {
        ref.h = h;
        return { enviarTexto: () => undefined, interrumpir: () => undefined, cerrar: async () => undefined };
      },
    };
    return { escalon, costo: (...args) => ref.h?.costo?.(...args) };
  }

  it("acumula por componente, deja el total en el tramo y conserva las llamadas sin componente", async () => {
    const { escalon, costo } = escalonConCostos();
    const e = crearEscaleraLlamada([escalon], { ahora: () => 1_000 });
    await e.abrirSesion(APERTURA, { caido: () => undefined } as unknown as ManejadoresSesion);
    costo?.(4_800, false, { proveedor: "deepgram", unidad: "segundo", cantidad: 60 });
    costo?.(300, true, { proveedor: HAIKU, unidad: "unidad", cantidad: 1 });
    costo?.(200, true, { proveedor: HAIKU, unidad: "unidad", cantidad: 1 });
    costo?.(70); // sin componente: solo suma al total del tramo
    const [t] = e.tramos();
    expect(t?.costoReportadoMicroUsd).toBe(5_370);
    expect(t?.componentes).toEqual([
      { proveedor: "deepgram", unidad: "segundo", cantidad: 60, costoMicroUsd: 4_800, costoReal: false },
      { proveedor: HAIKU, unidad: "unidad", cantidad: 2, costoMicroUsd: 500, costoReal: true },
    ]);
    const ev = eventosCostoLlamada({ ...BASE, tramos: e.tramos() });
    expect(costoTotalMicroUsd(ev)).toBe(5_370);
  });
  it("un nombre de componente invalido no pierde el costo: queda en el total del tramo, sin desglose", async () => {
    const { escalon, costo } = escalonConCostos();
    const e = crearEscaleraLlamada([escalon], { ahora: () => 1_000 });
    await e.abrirSesion(APERTURA, { caido: () => undefined } as unknown as ManejadoresSesion);
    costo?.(900, false, { proveedor: "desconocido", unidad: "unidad", cantidad: 1 });
    const [t] = e.tramos();
    expect(t?.costoReportadoMicroUsd).toBe(900);
    expect(t?.componentes).toBeUndefined();
  });
  it("sin componentes el tramo no trae la clave (forma de siempre)", async () => {
    const { escalon, costo } = escalonConCostos();
    const e = crearEscaleraLlamada([escalon], { ahora: () => 1_000 });
    await e.abrirSesion(APERTURA, { caido: () => undefined } as unknown as ManejadoresSesion);
    costo?.(10);
    expect("componentes" in e.tramos()[0]!).toBe(false);
  });
});

describe("el tope por llamada (VOICE_COSTO_MAX_LLAMADA_USD) es el mismo para los dos motores", () => {
  const REGLAS = { herramientaObjetivo: "crear_pedido", resultadoObjetivo: "pedido_creado", herramientaEscalar: "pasar_a_persona" } as const;
  const tope = 500_000;
  const limites = { ...LIMITES_POR_DEFECTO, costoMaxMicroUsd: tope };

  it("el costo sumado de Deepgram + HeyGen + LLM llega al tope y corta exactamente igual que un costo unico de Gemini", () => {
    const gemini = new CallStateMachine(REGLAS, limites);
    gemini.recibir({ tipo: "conectada" });
    const v2 = new CallStateMachine(REGLAS, limites);
    v2.recibir({ tipo: "conectada" });
    expect(gemini.recibir({ tipo: "costo", microUsd: tope - 1 })).toEqual([]);
    for (const microUsd of [200_000, 150_000, 149_999]) expect(v2.recibir({ tipo: "costo", microUsd })).toEqual([]);
    const cortaGemini = gemini.recibir({ tipo: "costo", microUsd: 1 });
    const cortaV2 = v2.recibir({ tipo: "costo", microUsd: 1 });
    expect(cortaV2).toEqual(cortaGemini);
    expect(cortaV2[0]).toEqual({ tipo: "decir", mensaje: "limite_costo" });
  });
  it("lo que el tope ve (suma de costos reportados) es lo que la base registra: el tope mensual suma categoria voz sin filtrar proveedor", () => {
    const tramos: TramoLlamada[] = [{ escalon: "cascada-openrouter", duracionS: 60, costoReportadoMicroUsd: 600, componentes: [comp("deepgram", "segundo", 60, 100, false), comp("heygen", "unidad", 10, 200, false), comp(HAIKU, "unidad", 1, 300, true)] }];
    expect(costoTotalMicroUsd(eventosCostoLlamada({ ...BASE, tramos }))).toBe(600);
    const sql = readFileSync(new URL("../../domain-restaurantes/migrations/067_voz_modo_entrada_gasto_mes_y_latencia.sql", import.meta.url), "utf8");
    const funcion = sql.slice(sql.indexOf("create or replace function restaurantes.voz_gasto_mes_micro_usd"));
    const consulta = funcion.slice(funcion.indexOf("from core.usage_cost_event u"), funcion.indexOf("from core.usage_cost_event u") + 300);
    expect(consulta).toContain("u.categoria = 'voz'");
    expect(consulta).not.toContain("proveedor");
  });
});
