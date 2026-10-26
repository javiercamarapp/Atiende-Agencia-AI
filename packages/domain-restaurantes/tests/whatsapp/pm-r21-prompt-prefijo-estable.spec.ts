// PM-R21: cache de prompt. El proveedor solo cachea PREFIJOS identicos; la fecha/hora iba a 400 caracteres del inicio y el saludo por hora a 10 mil, asi que
// dos turnos de minutos distintos compartian < 1 % del prompt (~20 mil tokens por llamada con herramientas) y nunca habia lectura de cache entre turnos.
// Con `WHATSAPP_PROMPT_PREFIJO_ESTABLE=1` esos datos van al final. Apagado por omision: el prompt de siempre.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSystemPrompt, PM_CONFIG_POR_OMISION, prefijoEstableActivo } from "../../src/whatsapp/llm-turn-handler.ts";

afterEach(() => vi.unstubAllEnvs());

const SUC = [{ propertyId: "p1", slug: "t1", name: "Prolongación Montejo", address: null }];
const NUEVO = { isNew: true } as const;
// 14:00 y 14:07 (misma tarde) y 20:30 (otro saludo); America/Merida = UTC-6.
const T_1400 = new Date("2026-10-06T20:00:00Z");
const T_1407 = new Date("2026-10-06T20:07:00Z");
const T_2030 = new Date("2026-10-07T02:30:00Z");

const prefijoComun = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};
const armar = (now: Date, estado = "") => buildSystemPrompt(PM_CONFIG_POR_OMISION, SUC, NUEVO, now, null, "", estado);

describe("PM-R21 prompt con prefijo estable", () => {
  it("la bandera esta apagada por omision y solo la encienden 1/true/on/si", () => {
    expect(prefijoEstableActivo({})).toBe(false);
    expect(prefijoEstableActivo({ WHATSAPP_PROMPT_PREFIJO_ESTABLE: "0" })).toBe(false);
    for (const v of ["1", "true", "ON", "si"]) expect(prefijoEstableActivo({ WHATSAPP_PROMPT_PREFIJO_ESTABLE: v }), v).toBe(true);
  });

  it("apagada: el prompt es el de siempre (la hora va en el primer bloque y el saludo en el flujo)", () => {
    const p = armar(T_1400, "Prolongación Montejo está ABIERTA y cierra a las 01:00.");
    expect(p.indexOf("Fecha y hora local (America/Merida): 6 de octubre de 2026, 14:00")).toBeLessThan(600);
    expect(p).toContain('con "Buenas tardes. Gracias por escribir');
    expect(p).not.toContain("[SALUDO]");
    expect(prefijoComun(armar(T_1400), armar(T_1407))).toBeLessThan(600);
  });

  it("encendida: dos turnos de minutos distintos comparten casi todo el prompt (>= 95 % del prefijo antes del contexto del cliente)", () => {
    vi.stubEnv("WHATSAPP_PROMPT_PREFIJO_ESTABLE", "1");
    const a = armar(T_1400, "Prolongación Montejo está ABIERTA y cierra a las 01:00.");
    const b = armar(T_1407, "Prolongación Montejo está ABIERTA; el último pedido se toma hasta las 00:30.");
    const comun = prefijoComun(a, b);
    expect(comun).toBeGreaterThan(a.length * 0.95 - 1500); // lo unico distinto va en el bloque del final
    expect(comun).toBeGreaterThan(50_000);
  });

  it("encendida: aun con otro saludo (tarde -> noche) el prefijo se conserva", () => {
    vi.stubEnv("WHATSAPP_PROMPT_PREFIJO_ESTABLE", "1");
    expect(prefijoComun(armar(T_1400), armar(T_2030))).toBeGreaterThan(50_000);
  });

  it("encendida: no se pierde informacion (fecha y hora, estado de la sucursal y saludo siguen en el prompt, antes del contexto del cliente)", () => {
    vi.stubEnv("WHATSAPP_PROMPT_PREFIJO_ESTABLE", "1");
    const p = armar(T_1400, "Prolongación Montejo está ABIERTA y cierra a las 01:00.");
    const iBloque = p.indexOf("# FECHA, HORA Y ESTADO DE ESTE MOMENTO");
    const iCliente = p.indexOf("# CONTEXTO DEL CLIENTE");
    expect(iBloque).toBeGreaterThan(p.length * 0.8);
    expect(iBloque).toBeLessThan(iCliente);
    const bloque = p.slice(iBloque, iCliente);
    // La linea exacta la produce Intl (el separador cambia segun la version de ICU del Node): se toma del prompt SIN la bandera, del mismo instante, y debe aparecer igual en el bloque.
    vi.stubEnv("WHATSAPP_PROMPT_PREFIJO_ESTABLE", "");
    const lineaDeSiempre = /- (Fecha y hora local \(America\/Merida\): [^\n]*)/.exec(armar(T_1400))![1]!;
    vi.stubEnv("WHATSAPP_PROMPT_PREFIJO_ESTABLE", "1");
    expect(lineaDeSiempre).toMatch(/6 de octubre de 2026.*14:00.*martes/);
    expect(bloque).toContain(lineaDeSiempre);
    expect(bloque).toContain("Estado de la sucursal de este chat AHORA");
    expect(bloque).toContain("Prolongación Montejo está ABIERTA y cierra a las 01:00.");
    expect(bloque).toContain('[SALUDO] en el paso 1 es: "Buenas tardes"');
    // El paso 1 remite al saludo del final y la fecha ya no esta al inicio.
    expect(p).toContain('con "[SALUDO]. Gracias por escribir');
    expect(p.slice(0, iBloque)).not.toContain("Fecha y hora local");
  });

  it("encendida: con saludo personalizado del negocio el saludo no se mueve (ya era estable)", () => {
    vi.stubEnv("WHATSAPP_PROMPT_PREFIJO_ESTABLE", "1");
    const p = buildSystemPrompt({ ...PM_CONFIG_POR_OMISION, greetingText: "Hola, bienvenido a PM" }, SUC, NUEVO, T_1400);
    expect(p).toContain("Hola, bienvenido a PM");
    expect(p).not.toContain("[SALUDO]");
  });

  it("encendida: un chat con sucursal de entrada conserva sus reglas y la ruta de voz no cambia", () => {
    vi.stubEnv("WHATSAPP_PROMPT_PREFIJO_ESTABLE", "1");
    const p = buildSystemPrompt(PM_CONFIG_POR_OMISION, SUC, NUEVO, T_1400, { name: "Prolongación Montejo", slug: "t1" } as never);
    expect(p).toContain('branch_slug: "t1"');
  });
});
