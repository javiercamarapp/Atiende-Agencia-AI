// Ajustes de voz equivalentes a los del original: temperatura al proveedor, ritmo/estilo por instruccion, fondo de restaurante en aislado.
import { describe, expect, it } from "vitest";
import {
  AJUSTES_HABLA_POR_DEFECTO,
  FONDO_VOLUMEN_MAX,
  FondoRestaurante,
  GeminiLiveProvider,
  conInstruccionDeHabla,
  crearProveedorCascadaLlamada,
  esEstiloHabla,
  esRitmoHabla,
  esTemperaturaVoz,
  esVolumenFondo,
  instruccionDeHabla,
  VOZ_PLATAFORMA,
  mensajeSetup,
} from "../src/index.ts";
import type { AperturaLlamada, ManejadoresSesion, PeticionLlmVoz, PuertoLlmVoz } from "../src/index.ts";

const BASE: AperturaLlamada = { instruccion: "Eres el agente.", voiceId: "Kore", herramientas: [] };

describe("temperatura de voz hacia Gemini Live", () => {
  it("sin temperatura el setup manda 0 (el agente de voz no improvisa importes ni datos)", () => {
    const g = mensajeSetup("gemini-3.8-live", BASE).setup.generationConfig as Record<string, unknown>;
    expect(g.temperature).toBe(0);
  });

  it("con temperatura la manda en generationConfig; 0 tambien se manda", () => {
    expect((mensajeSetup("m", { ...BASE, temperatura: 0.4 }).setup.generationConfig as Record<string, unknown>).temperature).toBe(0.4);
    expect((mensajeSetup("m", { ...BASE, temperatura: 0 }).setup.generationConfig as Record<string, unknown>).temperature).toBe(0);
    expect((mensajeSetup("m", { ...BASE, temperatura: null }).setup.generationConfig as Record<string, unknown>).temperature).toBe(0);
  });

  it("la sesion de preview manda la temperatura al token efimero", async () => {
    const cuerpos: Record<string, unknown>[] = [];
    const fetchFn = (async (_u: unknown, init?: RequestInit) => {
      cuerpos.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ name: "tok" }), { status: 200 });
    }) as typeof fetch;
    const p = new GeminiLiveProvider({ apiKey: "k", fetchFn });
    const entrada = { organizationId: "o", propertyId: "p", sessionId: "s", voiceId: "Kore", comportamiento: "x", mensajeInicial: "", ttlSegundos: 60 };
    await p.emitirSesionPreview({ ...entrada, temperatura: 0.3 });
    await p.emitirSesionPreview(entrada);
    const gc = (c: Record<string, unknown>) => ((c.bidiGenerateContentSetup as Record<string, unknown>).generationConfig as Record<string, unknown>);
    expect(gc(cuerpos[0]!).temperature).toBe(0.3);
    expect("temperature" in gc(cuerpos[1]!)).toBe(false);
  });
});

describe("temperatura y modelo elegido en la cascada", () => {
  it("la peticion al puerto del LLM lleva el modelo preferido y la temperatura de la apertura", async () => {
    const peticiones: PeticionLlmVoz[] = [];
    const llm: PuertoLlmVoz = {
      completar: async (p) => {
        peticiones.push(p);
        return { texto: "Hola.", toolCalls: [], costoMicroUsd: 1 };
      },
    };
    const fetchFn = (async (u: string | URL | Request) => (String(u).endsWith("/audio/speech") ? new Response(new Uint8Array([1, 2]), { status: 200 }) : new Response(JSON.stringify({ text: "x" }), { status: 200 }))) as typeof fetch;
    const prov = crearProveedorCascadaLlamada({ apiKey: "k", llm, fetchFn });
    const h: ManejadoresSesion = { agenteDijo: () => {}, agenteTermino: () => {}, interrumpido: () => {}, ejecutarTool: async () => ({}), caido: () => {} };
    const s1 = await prov.abrirSesion({ ...BASE, modeloLlm: "google/gemini-3.8-flash", temperatura: 0.2 }, h);
    s1.enviarTexto("hola");
    await prov.inactivo();
    const s2 = await prov.abrirSesion(BASE, h);
    s2.enviarTexto("hola");
    await prov.inactivo();
    expect(peticiones[0]).toMatchObject({ modeloPreferido: "google/gemini-3.8-flash", temperatura: 0.2 });
    expect("modeloPreferido" in peticiones[1]!).toBe(false);
    // Sin ajuste de la organizacion manda la temperatura de la plataforma (VOZ_PLATAFORMA.cascada), nunca omitida.
    expect(peticiones[1]!.temperatura).toBe(VOZ_PLATAFORMA.cascada.temperatura);
  });
});

describe("ritmo y estilo de habla (por instruccion: Gemini no tiene velocidad numerica)", () => {
  it("los valores por defecto no anexan nada", () => {
    expect(instruccionDeHabla(AJUSTES_HABLA_POR_DEFECTO)).toBe("");
    expect(conInstruccionDeHabla("Reglas.", AJUSTES_HABLA_POR_DEFECTO)).toBe("Reglas.");
  });

  it("pausado + calido se anexan AL FINAL, sin tocar lo anterior, y declaran que no cambian reglas ni el usted", () => {
    const t = conInstruccionDeHabla("Reglas duras.\nSiempre de usted.", { ritmo: "pausado", estilo: "calido" });
    expect(t.startsWith("Reglas duras.\nSiempre de usted.\n\n")).toBe(true);
    expect(t).toMatch(/ritmo pausado/);
    expect(t).toMatch(/calida y cercana/);
    expect(t).toMatch(/no cambia ninguna regla, herramienta ni el trato de usted/);
  });

  it("con instruccion vacia solo queda el bloque; validadores estrictos", () => {
    expect(conInstruccionDeHabla("", { ritmo: "agil", estilo: "neutro" })).toMatch(/^ESTILO DE HABLA/);
    expect(esRitmoHabla("pausado")).toBe(true);
    expect(esRitmoHabla("rapido")).toBe(false);
    expect(esEstiloHabla("animado")).toBe(true);
    expect(esEstiloHabla(undefined)).toBe(false);
    expect([0, 0.5, 1].every(esTemperaturaVoz)).toBe(true);
    expect([-0.1, 1.1, Number.NaN, "0.3"].some(esTemperaturaVoz)).toBe(false);
  });
});

function pcm(valores: number[]): Uint8Array {
  const b = new Uint8Array(valores.length * 2);
  const v = new DataView(b.buffer);
  valores.forEach((x, i) => v.setInt16(i * 2, x, true));
  return b;
}
const muestras = (b: Uint8Array): number[] => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return Array.from({ length: Math.floor(b.byteLength / 2) }, (_, i) => v.getInt16(i * 2, true));
};
const pico = (b: Uint8Array): number => Math.max(...muestras(b).map(Math.abs));
const rms = (b: Uint8Array): number => Math.sqrt(muestras(b).reduce((s, x) => s + x * x, 0) / Math.max(1, muestras(b).length));

describe("mezcla del fondo de restaurante (apagado por omision, volumen bajo)", () => {
  it("volumen 0 = apagado: devuelve el mismo trozo y el murmullo es silencio", () => {
    const f = new FondoRestaurante({ volumen: 0 });
    const voz = pcm([1000, -2000, 3000]);
    expect(f.activo).toBe(false);
    expect(f.mezclar(voz)).toBe(voz);
    expect(muestras(f.siguiente(100)).every((x) => x === 0)).toBe(true);
  });

  it("el fondo nunca pasa de su tope: el volumen maximo acota el pico del murmullo", () => {
    const f = new FondoRestaurante({ volumen: FONDO_VOLUMEN_MAX, semilla: 7 });
    const fondo = f.siguiente(48_000);
    expect(pico(fondo)).toBeLessThanOrEqual(Math.round((FONDO_VOLUMEN_MAX / 100) * 32767));
    expect(pico(fondo)).toBeGreaterThan(500);
  });

  it("a mas volumen, mas energia; con la misma semilla es determinista", () => {
    const bajo = new FondoRestaurante({ volumen: 4, semilla: 3 }).siguiente(24_000);
    const alto = new FondoRestaurante({ volumen: 16, semilla: 3 }).siguiente(24_000);
    expect(rms(alto)).toBeGreaterThan(rms(bajo) * 2);
    expect(muestras(new FondoRestaurante({ volumen: 8, semilla: 9 }).siguiente(500))).toEqual(muestras(new FondoRestaurante({ volumen: 8, semilla: 9 }).siguiente(500)));
  });

  it("mezclar suma el fondo a la voz sin tocar la longitud y satura en vez de desbordar", () => {
    const f = new FondoRestaurante({ volumen: 10, semilla: 5 });
    const voz = pcm(new Array(2400).fill(0).map((_, i) => (i % 2 === 0 ? 32767 : -32768)));
    const mezcla = f.mezclar(voz);
    expect(mezcla.byteLength).toBe(voz.byteLength);
    expect(pico(mezcla)).toBeLessThanOrEqual(32768);
    const silencio = pcm(new Array(2400).fill(0));
    const sobreSilencio = new FondoRestaurante({ volumen: 10, semilla: 5 }).mezclar(silencio);
    expect(rms(sobreSilencio)).toBeGreaterThan(0);
  });

  it("un trozo de longitud impar conserva el ultimo byte; volumen invalido se rechaza", () => {
    const f = new FondoRestaurante({ volumen: 5 });
    const impar = new Uint8Array([1, 0, 9]);
    expect(f.mezclar(impar).byteLength).toBe(3);
    expect(f.mezclar(impar)[2]).toBe(9);
    expect(() => new FondoRestaurante({ volumen: 21 })).toThrow(RangeError);
    expect(() => new FondoRestaurante({ volumen: 1.5 })).toThrow(RangeError);
    expect(esVolumenFondo(20)).toBe(true);
    expect(esVolumenFondo(-1)).toBe(false);
  });
});
