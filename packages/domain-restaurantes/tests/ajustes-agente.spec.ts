// Ajustes del agente por organizacion: lista permitida de modelos con costo estimado, validacion estricta y temperatura honesta.
import { describe, expect, it } from "vitest";
import {
  AJUSTES_AGENTE_POR_DEFECTO,
  AjustesInvalidosError,
  CLONACION_DE_VOZ_ESTADO,
  DOCUMENTOS_AUTO_OMITIDOS,
  MODELOS_AGENTE,
  MODELO_PREDETERMINADO_ID,
  PERFIL_COSTO_AGENTE,
  ajustesDeLlamada,
  costoEstimadoModelo,
  esModeloAgentePermitido,
  modeloAgentePorId,
  temperaturaEfectivaWhatsapp,
  validarAjustesAgente,
} from "../src/index.ts";
import type { AjustesAgente } from "../src/index.ts";

const COMPLETOS: AjustesAgente = { ...AJUSTES_AGENTE_POR_DEFECTO };

describe("lista permitida de modelos", () => {
  it("tiene exactamente un predeterminado y es el primer escalon de la plataforma", () => {
    expect(MODELOS_AGENTE.filter((m) => m.predeterminado).map((m) => m.id)).toEqual([MODELO_PREDETERMINADO_ID]);
    expect(new Set(MODELOS_AGENTE.map((m) => m.id)).size).toBe(MODELOS_AGENTE.length);
  });

  it("solo los ids listados son validos", () => {
    expect(esModeloAgentePermitido("deepseek/deepseek-v4.1-flash")).toBe(true);
    expect(esModeloAgentePermitido("evil/modelo-no-listado")).toBe(false);
    expect(esModeloAgentePermitido(42)).toBe(false);
    expect(modeloAgentePorId(null)).toBeNull();
  });

  it("la temperatura se ofrece solo donde los endpoints permitidos la aceptan (evidencia OpenRouter 4-oct-2026)", () => {
    const acepta = Object.fromEntries(MODELOS_AGENTE.map((m) => [m.id, m.aceptaTemperatura]));
    expect(acepta).toEqual({
      "openai/gpt-6-luna": false,
      "deepseek/deepseek-v4.1-flash": true,
      "google/gemini-2.5-flash-lite": true,
      "meta/muse-spark-1.3": true,
      "google/gemini-3.8-flash": true,
      "anthropic/claude-sonnet-5.5": false,
    });
  });
});

describe("costo estimado por modelo (micro-USD enteros, hacia arriba, con la tabla de precios de agent-core)", () => {
  it("un mensaje de WhatsApp con GPT-6 Luna: 6,000 in * 0.1 + 400 out * 0.5 = 800 micro-USD", () => {
    expect(PERFIL_COSTO_AGENTE.whatsapp_mensaje).toEqual({ tokensEntrada: 6000, tokensSalida: 400 });
    const c = costoEstimadoModelo("openai/gpt-6-luna", "whatsapp_mensaje");
    expect(c).toMatchObject({ microUsdPorUnidad: 800, microUsdPorMil: 800_000, verificadoEn: "2026-10-01" });
  });

  it("un minuto de cascada con Claude Sonnet 5.5 cuesta mas que con Gemini 2.5 Flash-Lite", () => {
    const caro = costoEstimadoModelo("anthropic/claude-sonnet-5.5", "voz_cascada_minuto").microUsdPorUnidad!;
    const barato = costoEstimadoModelo("google/gemini-2.5-flash-lite", "voz_cascada_minuto").microUsdPorUnidad!;
    expect(caro).toBe(Math.ceil(12000 * 2 + 500 * 10));
    expect(caro).toBeGreaterThan(barato * 10);
  });

  it("todo modelo de la lista tiene precio de lista; uno desconocido da null (nunca inventa)", () => {
    for (const m of MODELOS_AGENTE) expect(costoEstimadoModelo(m.id, "whatsapp_mensaje").microUsdPorUnidad, m.id).toBeGreaterThan(0);
    expect(costoEstimadoModelo("x/desconocido", "whatsapp_mensaje")).toMatchObject({ microUsdPorUnidad: null, microUsdPorMil: null, verificadoEn: null });
  });
});

describe("validarAjustesAgente (el PUT reemplaza todo: cada campo es obligatorio)", () => {
  it("acepta los ajustes por omision y los de un modelo con temperatura", () => {
    expect(validarAjustesAgente(COMPLETOS)).toEqual(COMPLETOS);
    const ok = validarAjustesAgente({ ...COMPLETOS, whatsappModelo: "google/gemini-3.8-flash", whatsappTemperatura: 0.3, vozTemperatura: 0.6, vozRitmo: "pausado", vozEstilo: "calido", vozFondoActivo: true, vozFondoVolumen: 12 });
    expect(ok).toMatchObject({ whatsappModelo: "google/gemini-3.8-flash", whatsappTemperatura: 0.3, vozFondoVolumen: 12 });
  });

  it("rechaza un campo faltante: un cliente desactualizado no borra lo que no conoce", () => {
    const { vozRitmo: _omit, ...sinRitmo } = COMPLETOS;
    expect(() => validarAjustesAgente(sinRitmo)).toThrow(/vozRitmo: campo requerido/);
  });

  it("rechaza modelos fuera de la lista, temperatura fuera de rango, ritmos y volumenes invalidos", () => {
    const malos: [Partial<Record<keyof AjustesAgente, unknown>>, RegExp][] = [
      [{ whatsappModelo: "otro/modelo" }, /whatsappModelo/],
      [{ vozModeloCascada: "otro/modelo" }, /vozModeloCascada/],
      [{ vozTemperatura: 1.5 }, /vozTemperatura/],
      [{ vozTemperatura: "0.2" }, /vozTemperatura/],
      [{ vozRitmo: "rapido" }, /vozRitmo/],
      [{ vozEstilo: "gritado" }, /vozEstilo/],
      [{ vozFondoActivo: "si" }, /vozFondoActivo/],
      [{ vozFondoVolumen: 21 }, /vozFondoVolumen/],
      [{ vozFondoVolumen: 3.5 }, /vozFondoVolumen/],
    ];
    for (const [parche, esperado] of malos) expect(() => validarAjustesAgente({ ...COMPLETOS, ...parche }), JSON.stringify(parche)).toThrow(esperado);
    expect(() => validarAjustesAgente({ ...COMPLETOS, vozTemperatura: 2 })).toThrow(AjustesInvalidosError);
  });

  it("pide temperatura a un modelo que no la admite: se rechaza con un mensaje claro (el predeterminado Luna tampoco la admite)", () => {
    expect(() => validarAjustesAgente({ ...COMPLETOS, whatsappTemperatura: 0.2 })).toThrow(/GPT-6 Luna no admite temperatura/);
    expect(() => validarAjustesAgente({ ...COMPLETOS, whatsappModelo: "anthropic/claude-sonnet-5.5", whatsappTemperatura: 0.2 })).toThrow(/Claude Sonnet 5.5 no admite temperatura/);
    expect(validarAjustesAgente({ ...COMPLETOS, whatsappModelo: "deepseek/deepseek-v4.1-flash", whatsappTemperatura: 0 }).whatsappTemperatura).toBe(0);
  });
});

describe("temperatura efectiva y ajustes de llamada", () => {
  it("WhatsApp: la elegida si el modelo la admite; si no, 0 como siempre", () => {
    expect(temperaturaEfectivaWhatsapp({ whatsappModelo: "google/gemini-2.5-flash-lite", whatsappTemperatura: 0.4 })).toBe(0.4);
    expect(temperaturaEfectivaWhatsapp({ whatsappModelo: null, whatsappTemperatura: 0.4 })).toBe(0); // fila escrita directo: Luna no la admite
    expect(temperaturaEfectivaWhatsapp({ whatsappModelo: "google/gemini-2.5-flash-lite", whatsappTemperatura: null })).toBe(0);
  });

  it("el fondo solo cuenta activo con la bandera y volumen > 0; apagado manda volumen 0", () => {
    expect(ajustesDeLlamada(COMPLETOS).fondo).toEqual({ activo: false, volumen: 0 });
    expect(ajustesDeLlamada({ ...COMPLETOS, vozFondoActivo: true, vozFondoVolumen: 0 }).fondo).toEqual({ activo: false, volumen: 0 });
    expect(ajustesDeLlamada({ ...COMPLETOS, vozFondoActivo: true, vozFondoVolumen: 9, vozModeloCascada: "google/gemini-3.8-flash", vozTemperatura: 0.3 })).toMatchObject({
      fondo: { activo: true, volumen: 9 },
      modeloCascada: "google/gemini-3.8-flash",
      temperatura: 0.3,
    });
  });
});

describe("estados honestos de lo que no se construye", () => {
  it("clonacion de voz: no disponible, con motivo y la decision pendiente", () => {
    expect(CLONACION_DE_VOZ_ESTADO.disponible).toBe(false);
    expect(CLONACION_DE_VOZ_ESTADO.motivo).toMatch(/no clona/);
    expect(CLONACION_DE_VOZ_ESTADO.decision).toMatch(/proveedor de voz aparte/);
  });

  it("ventas y personal no se generan y cada uno dice por que", () => {
    expect(DOCUMENTOS_AUTO_OMITIDOS.map((d) => d.tipo)).toEqual(["ventas", "personal"]);
    for (const d of DOCUMENTOS_AUTO_OMITIDOS) expect(d.motivo.length).toBeGreaterThan(40);
  });
});
