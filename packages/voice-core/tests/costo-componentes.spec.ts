// Costo por componente (P4): eventos de `core.usage_cost_event` con proveedor = deepgram | heygen | openrouter:<modelo>, sin romper los eventos por escalon.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CallStateMachine, LIMITES_POR_DEFECTO, PROVEEDOR_COMPONENTE_RE, motivoComponenteInvalido, refIdComponente, costoTotalMicroUsd, crearEscaleraLlamada, eventosCostoLlamada } from "../src/index.ts";
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
    // una sola fila por componente; el piso por minuto de 120 s (28 000) deja el remanente de 20 800 en el evento del escalon
    expect(e.map((x) => [x.proveedor, x.cantidad, x.costoMicroUsd])).toEqual([["deepgram", 90, 7_200], ["cascada-openrouter", 120, 20_800]]);
  });
  it("un aporte estimado junto a otro real deja el componente ESTIMADO (nunca se marca real un costo parcialmente supuesto)", () => {
    const e = eventosCostoLlamada({ ...BASE, tramos: [{ ...tramo, costoReportadoMicroUsd: 300, componentes: [comp(HAIKU, "unidad", 1, 100, true), comp(HAIKU, "unidad", 1, 200, false)] }] });
    expect(e[0]).toMatchObject({ proveedor: HAIKU, costoMicroUsd: 300, costoEstimado: true });
  });
  it("el LLM con costo real queda con costo_estimado = false", () => {
    const e = eventosCostoLlamada({ ...BASE, tramos: [{ escalon: "cascada-openrouter", duracionS: 600, costoReportadoMicroUsd: 50, componentes: [comp(HAIKU, "unidad", 1, 50, true)] }] });
    expect(e[0]).toMatchObject({ proveedor: HAIKU, costoMicroUsd: 50, costoEstimado: false });
  });
  it("un desglose PARCIAL no borra el piso por minuto: 600 s de cascada con solo el LLM (50) registran 140 000 en total, el resto como remanente estimado del escalon", () => {
    const e = eventosCostoLlamada({ ...BASE, tramos: [{ escalon: "cascada-openrouter", duracionS: 600, costoReportadoMicroUsd: 50, componentes: [comp(HAIKU, "unidad", 1, 50, true)] }] });
    expect(costoTotalMicroUsd(e)).toBe(140_000);
    expect(e.at(-1)).toMatchObject({ proveedor: "cascada-openrouter", costoMicroUsd: 139_950, costoEstimado: true, refId: "sala-1:cascada-openrouter" });
  });
  it("un componente en cero no hace desaparecer el evento del escalon: 120 s de cascada con heygen en 0 siguen costando el piso (28 000)", () => {
    const e = eventosCostoLlamada({ ...BASE, tramos: [{ escalon: "cascada-openrouter", duracionS: 120, costoReportadoMicroUsd: 0, componentes: [comp("heygen", "unidad", 0, 0, false)] }] });
    expect(costoTotalMicroUsd(e)).toBe(28_000);
    expect(e.map((x) => x.proveedor)).toEqual(["cascada-openrouter"]);
  });
  it("componentes que suman MAS que lo reportado y que el piso: el remanente es 0 (nunca negativo) y la suma es la de los componentes", () => {
    const e = eventosCostoLlamada({ ...BASE, tramos: [{ escalon: "cascada-openrouter", duracionS: 60, costoReportadoMicroUsd: 1_000, componentes: [comp("deepgram", "segundo", 60, 20_000, false)] }] });
    expect(e.map((x) => [x.proveedor, x.costoMicroUsd])).toEqual([["deepgram", 20_000]]);
  });
  it("Gemini Live NO admite componentes: el tramo se rechaza en vez de perder el piso o duplicar el costo", () => {
    expect(() => eventosCostoLlamada({ ...BASE, tramos: [{ escalon: "gemini-3.8-live", duracionS: 120, costoReportadoMicroUsd: 0, componentes: [comp("heygen", "unidad", 0, 0, false)] }] })).toThrow(/no admite componentes/);
    // y sin componentes conserva el piso de siempre (120 s = 150 000)
    expect(costoTotalMicroUsd(eventosCostoLlamada({ ...BASE, tramos: [{ escalon: "gemini-3.8-live", duracionS: 120, costoReportadoMicroUsd: 0 }] }))).toBe(150_000);
  });
  it("la bandera del remanente depende SOLO de lo reportado sin componente: un componente real no vuelve 'real' un remanente estimado", () => {
    const e = eventosCostoLlamada({ ...BASE, tramos: [{ escalon: "cascada-openrouter", duracionS: 60, costoReportadoMicroUsd: 20_000, componentes: [comp(HAIKU, "unidad", 1, 300, true)] }] });
    expect(e.at(-1)).toMatchObject({ proveedor: "cascada-openrouter", costoMicroUsd: 19_700, costoEstimado: true });
  });
  it.each([["gemini"], ["Deepgram"], [""], ["openrouter:"], ["openrouter:../x"], ["x".repeat(81)], ["deepgram:extra:cosa:mas"], ["openrouter:" + "a".repeat(70)], ["openrouter:" + "a".repeat(60) + ":" + "b".repeat(16)]])("proveedor de componente invalido %j se rechaza", (proveedor) => {
    expect(PROVEEDOR_COMPONENTE_RE.test(proveedor)).toBe(false);
    expect(() => eventosCostoLlamada({ ...BASE, tramos: [{ ...tramo, componentes: [comp(proveedor, "unidad", 1, 1, false)] }] })).toThrow(/componente invalido/);
  });
  it("el largo maximo es el CHECK de la base (1-80): 80 caracteres pasan y 81 a 89 de forma VALIDA no (la base responderia 23514)", () => {
    const con = (n: number) => "openrouter:" + "a".repeat(n - 11 - 17) + ":" + "b".repeat(16);
    expect(con(80).length).toBe(80);
    expect(PROVEEDOR_COMPONENTE_RE.test(con(80))).toBe(true);
    for (const n of [81, 85, 89]) {
      expect(con(n).length).toBe(n);
      expect(PROVEEDOR_COMPONENTE_RE.test(con(n)), String(n)).toBe(false);
      expect(() => eventosCostoLlamada({ ...BASE, tramos: [{ escalon: "cascada-openrouter", duracionS: 1, costoReportadoMicroUsd: 1, componentes: [comp(con(n), "unidad", 1, 1, true)] }] })).toThrow(/componente invalido/);
    }
  });
  it.each([["deepgram"], ["deepgram-aura-2"], ["heygen"], [HAIKU], ["openrouter:anthropic/claude-sonnet-5.5"], ["openrouter:google/gemini-3.8-flash:nitro"]])("proveedor valido %j", (p) => {
    expect(PROVEEDOR_COMPONENTE_RE.test(p)).toBe(true);
    expect(p.length).toBeLessThanOrEqual(80);
  });
});

describe("coherencia del componente y ref_id", () => {
  it.each([
    [{ proveedor: "deepgram", unidad: "unidad", costoReal: false }, "unidad"],
    [{ proveedor: "heygen", unidad: "segundo", costoReal: false }, "unidad"],
    [{ proveedor: HAIKU, unidad: "segundo", costoReal: true }, "unidad"],
    [{ proveedor: "deepgram", unidad: "segundo", costoReal: true }, "costoReal"],
    [{ proveedor: "heygen", unidad: "unidad", costoReal: true }, "costoReal"],
    [{ proveedor: "deepgram-aura-2", unidad: "unidad", costoReal: true }, "costoReal"],
    [{ proveedor: HAIKU, unidad: "unidad", costoReal: 1 }, "costoReal"],
    [{ proveedor: "nada", unidad: "unidad", costoReal: false }, "proveedor"],
  ])("%j -> motivo %s", (c, motivo) => {
    expect(motivoComponenteInvalido(c)).toBe(motivo);
  });
  it("deepgram en segundos, heygen y aura en caracteres y el LLM con costo real son coherentes", () => {
    for (const c of [{ proveedor: "deepgram", unidad: "segundo", costoReal: false }, { proveedor: "heygen", unidad: "unidad", costoReal: false }, { proveedor: HAIKU, unidad: "unidad", costoReal: true }, { proveedor: HAIKU, unidad: "unidad", costoReal: false }]) expect(motivoComponenteInvalido(c)).toBeNull();
  });
  it("el ref_id de un componente largo se acorta a 200 sin chocar con otro que solo difiere al final", () => {
    const llamada = "l".repeat(128);
    const a = "openrouter:" + "a".repeat(52) + ":" + "b".repeat(15) + "1";
    const b = "openrouter:" + "a".repeat(52) + ":" + "b".repeat(15) + "2";
    const ra = refIdComponente(llamada, "cascada-openrouter", a);
    const rb = refIdComponente(llamada, "cascada-openrouter", b);
    expect(ra.length).toBeLessThanOrEqual(200);
    expect(rb.length).toBeLessThanOrEqual(200);
    expect(ra).not.toBe(rb);
    expect(refIdComponente(llamada, "cascada-openrouter", a)).toBe(ra);
    // las que caben se quedan como siempre
    expect(refIdComponente("sala-1", "cascada-openrouter", "heygen")).toBe("sala-1:cascada-openrouter:heygen");
  });
  it("los eventos de dos componentes largos distintos no comparten ref_id", () => {
    const a = "openrouter:" + "a".repeat(52) + ":" + "b".repeat(15) + "1";
    const b = "openrouter:" + "a".repeat(52) + ":" + "b".repeat(15) + "2";
    expect([a.length, b.length]).toEqual([80, 80]);
    const e = eventosCostoLlamada({ ...BASE, llamadaId: "l".repeat(128), tramos: [{ escalon: "cascada-openrouter", duracionS: 60, costoReportadoMicroUsd: 20_000, componentes: [comp(a, "unidad", 1, 5, true), comp(b, "unidad", 1, 6, true)] }] });
    const refs = e.map((x) => x.refId);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs.every((r) => r.length <= 200)).toBe(true);
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
    costo?.(70); // sin componente: solo suma al total del tramo (estimado)
    const [t] = e.tramos();
    expect(t?.costoReportadoMicroUsd).toBe(5_370);
    expect(t?.componentes).toEqual([
      { proveedor: "deepgram", unidad: "segundo", cantidad: 60, costoMicroUsd: 4_800, costoReal: false },
      { proveedor: HAIKU, unidad: "unidad", cantidad: 2, costoMicroUsd: 500, costoReal: true },
    ]);
    const ev = eventosCostoLlamada({ ...BASE, tramos: e.tramos() });
    expect(costoTotalMicroUsd(ev)).toBe(5_370);
  });
  it("la bandera 'real' del tramo NO sale de un aporte con componente: costo(300, real, haiku) + costo(4800) estimado deja el remanente estimado", async () => {
    const { escalon, costo } = escalonConCostos();
    const e = crearEscaleraLlamada([escalon], { ahora: () => 1_000 });
    await e.abrirSesion(APERTURA, { caido: () => undefined } as unknown as ManejadoresSesion);
    costo?.(300, true, { proveedor: HAIKU, unidad: "unidad", cantidad: 1 });
    costo?.(4_800);
    const [t] = e.tramos();
    expect(t?.costoReal).toBeUndefined();
    const ev = eventosCostoLlamada({ ...BASE, tramos: e.tramos() });
    expect(ev.at(-1)).toMatchObject({ proveedor: "cascada-openrouter", costoEstimado: true });
    expect(costoTotalMicroUsd(ev)).toBe(5_100);
  });
  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY], [-5], ["10"], [null], [undefined]])("un costo invalido (%s) se descarta: no suma, no se reenvia y se cuenta", async (malo) => {
    const reenviados: number[] = [];
    const { escalon, costo } = escalonConCostos();
    const e = crearEscaleraLlamada([escalon], { ahora: () => 1_000 });
    await e.abrirSesion(APERTURA, { caido: () => undefined, costo: (m: number) => void reenviados.push(m) } as unknown as ManejadoresSesion);
    costo?.(malo as unknown as number, false, { proveedor: "deepgram", unidad: "segundo", cantidad: 1 });
    costo?.(malo as unknown as number);
    costo?.(100);
    expect(e.costosInvalidos()).toBe(2);
    expect(e.tramos()[0]?.costoReportadoMicroUsd).toBe(100);
    expect(e.tramos()[0]?.componentes).toBeUndefined();
    expect(reenviados).toEqual([100]);
  });
  it("un componente incoherente (unidad que no corresponde) o en Gemini no se desglosa pero su costo SI cuenta en el total", async () => {
    const { escalon, costo } = escalonConCostos();
    const e = crearEscaleraLlamada([escalon], { ahora: () => 1_000 });
    await e.abrirSesion(APERTURA, { caido: () => undefined } as unknown as ManejadoresSesion);
    costo?.(500, true, { proveedor: "deepgram", unidad: "unidad", cantidad: 1 });
    const [t] = e.tramos();
    expect(t?.costoReportadoMicroUsd).toBe(500);
    expect(t?.componentes).toBeUndefined();
    expect(t?.costoReal).toBeUndefined();

    const gem: EscalonLlamada = { id: "gemini-3.8-live", abrirSesion: async (_a, h) => { h.costo?.(700, true, { proveedor: "heygen", unidad: "unidad", cantidad: 1 }); return { enviarTexto: () => undefined, interrumpir: () => undefined, cerrar: async () => undefined }; } };
    const eg = crearEscaleraLlamada([gem], { ahora: () => 1_000 });
    await eg.abrirSesion(APERTURA, { caido: () => undefined } as unknown as ManejadoresSesion);
    expect(eg.tramos()[0]?.componentes).toBeUndefined();
    expect(eg.tramos()[0]?.costoReportadoMicroUsd).toBe(700);
  });
  it("el desglose de cada tramo nunca suma mas que lo reportado aunque haya costos fraccionarios (redondeo hacia abajo por componente)", async () => {
    const { escalon, costo } = escalonConCostos();
    const e = crearEscaleraLlamada([escalon], { ahora: () => 1_000 });
    await e.abrirSesion(APERTURA, { caido: () => undefined } as unknown as ManejadoresSesion);
    for (let i = 0; i < 3; i++) costo?.(10.4, false, { proveedor: "heygen", unidad: "unidad", cantidad: 1 });
    costo?.(5.5, true, { proveedor: HAIKU, unidad: "unidad", cantidad: 1 });
    const [t] = e.tramos();
    const suma = (t?.componentes ?? []).reduce((n, c) => n + c.costoMicroUsd, 0);
    expect(Number.isInteger(suma)).toBe(true);
    expect(suma).toBeLessThanOrEqual(t!.costoReportadoMicroUsd);
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
  it("un costo NaN o infinito no envenena el acumulado: el tope por llamada sigue funcionando", () => {
    const m = new CallStateMachine(REGLAS, limites);
    m.recibir({ tipo: "conectada" });
    expect(m.recibir({ tipo: "costo", microUsd: Number.NaN })).toEqual([]);
    expect(m.recibir({ tipo: "costo", microUsd: Number.POSITIVE_INFINITY })).toEqual([]);
    expect(m.costoMicroUsd).toBe(0);
    expect(m.recibir({ tipo: "costo", microUsd: tope - 1 })).toEqual([]);
    expect(m.recibir({ tipo: "costo", microUsd: 1 })[0]).toEqual({ tipo: "decir", mensaje: "limite_costo" });
  });
  it("lo que el tope ve (suma de costos reportados) es lo que la base registra: el tope mensual suma categoria voz sin filtrar proveedor", () => {
    const tramos: TramoLlamada[] = [{ escalon: "cascada-openrouter", duracionS: 1, costoReportadoMicroUsd: 600, componentes: [comp("deepgram", "segundo", 60, 100, false), comp("heygen", "unidad", 10, 200, false), comp(HAIKU, "unidad", 1, 300, true)] }];
    expect(costoTotalMicroUsd(eventosCostoLlamada({ ...BASE, tramos }))).toBe(600);
    const sql = readFileSync(new URL("../../domain-restaurantes/migrations/067_voz_modo_entrada_gasto_mes_y_latencia.sql", import.meta.url), "utf8");
    const funcion = sql.slice(sql.indexOf("create or replace function restaurantes.voz_gasto_mes_micro_usd"));
    const consulta = funcion.slice(funcion.indexOf("from core.usage_cost_event u"), funcion.indexOf("from core.usage_cost_event u") + 300);
    expect(consulta).toContain("u.categoria = 'voz'");
    expect(consulta).not.toContain("proveedor");
  });
});
