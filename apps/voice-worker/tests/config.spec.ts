// Configuracion del worker: tabla DNIS -> sucursal, modo "no configurado" (nunca atiende a medias), tope mensual y modo de entrada.
import { describe, expect, it } from "vitest";
import { cargarConfig, franjaDeHora, modoEntradaDeLlamada, normalizarNumero, parsearTablaDnis, resolverTopeMensualMicroUsd, sinDiagonalFinal } from "../src/config.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const SUC_A = "00000000-0000-4000-8000-0000000000a1";
const SUC_B = "00000000-0000-4000-8000-0000000000b1";

const entrada = (extra: Record<string, unknown> = {}) => ({ orgSlug: "los-taquitos-de-pm", organizationId: ORG, propertyId: SUC_A, branchSlug: "fco-montejo", secretoEnv: "VOICE_SECRET_FCO", ...extra });
const ENV_BASE = {
  LIVEKIT_URL: "wss://ejemplo.livekit.invalid",
  LIVEKIT_API_KEY: "llave-livekit",
  LIVEKIT_API_SECRET: "secreto-livekit",
  ATIENDE_API_URL: "https://api.ejemplo.invalid/",
  INTERNAL_SECRET: "secreto-interno",
  GEMINI_API_KEY: "llave-gemini",
  VOICE_DNIS_MAP: JSON.stringify({ "+52 999 111 0001": entrada() }),
  VOICE_SECRET_FCO: "secreto-sucursal",
};

describe("normalizarNumero", () => {
  it("canoniza a los ultimos 10 digitos (misma llave sin importar +52, 521, espacios o guiones)", () => {
    expect(normalizarNumero("+52 999 111 0001")).toBe("9991110001");
    expect(normalizarNumero("+5219991110001")).toBe("9991110001");
    expect(normalizarNumero("(999) 111-0001")).toBe("9991110001");
    expect(normalizarNumero("9991110001")).toBe("9991110001");
  });
  it("un valor sin 10 digitos o ausente no es un numero", () => {
    expect(normalizarNumero("12345")).toBeNull();
    expect(normalizarNumero("anonymous")).toBeNull();
    expect(normalizarNumero(null)).toBeNull();
    expect(normalizarNumero(undefined)).toBeNull();
  });
});

describe("sinDiagonalFinal", () => {
  it("quita todas las diagonales finales y nada mas", () => {
    expect(sinDiagonalFinal("https://api.ejemplo.invalid///")).toBe("https://api.ejemplo.invalid");
    expect(sinDiagonalFinal("https://api.ejemplo.invalid/v1/")).toBe("https://api.ejemplo.invalid/v1");
    expect(sinDiagonalFinal("https://api.ejemplo.invalid")).toBe("https://api.ejemplo.invalid");
    expect(sinDiagonalFinal("///")).toBe("");
    expect(sinDiagonalFinal("")).toBe("");
  });
  it("una entrada con cientos de miles de diagonales se procesa de inmediato (sin retroceso de expresion regular)", () => {
    const inicio = performance.now();
    expect(sinDiagonalFinal(`a${"/".repeat(500_000)}x${"/".repeat(500_000)}`)).toBe(`a${"/".repeat(500_000)}x`);
    expect(performance.now() - inicio).toBeLessThan(500);
  });
});

describe("parsearTablaDnis (VOICE_DNIS_MAP)", () => {
  it("mapea el numero marcado a la sucursal y lee el secreto de la variable nombrada, no del JSON", () => {
    const { tabla, problemas } = parsearTablaDnis(JSON.stringify({ "+52 999 111 0001": entrada({ topeMensualUsd: 25, modoEntrada: "desborde" }) }), { VOICE_SECRET_FCO: "s3creto" });
    expect(problemas).toEqual([]);
    expect(tabla.get("9991110001")).toMatchObject({ orgSlug: "los-taquitos-de-pm", organizationId: ORG, propertyId: SUC_A, branchSlug: "fco-montejo", secreto: "s3creto", topeMensualUsd: 25, modoEntrada: "desborde" });
  });

  it("dos numeros son dos sucursales distintas (DNIS -> sucursal, nunca al reves)", () => {
    const json = JSON.stringify({ "+5299911100001": entrada(), "9992220002": entrada({ propertyId: SUC_B, branchSlug: "altabrisa", secretoEnv: "VOICE_SECRET_ALT" }) });
    const { tabla } = parsearTablaDnis(json.replace("+5299911100001", "+52 999 111 0001"), { VOICE_SECRET_FCO: "a", VOICE_SECRET_ALT: "b" });
    expect(tabla.get("9991110001")?.propertyId).toBe(SUC_A);
    expect(tabla.get("9992220002")?.propertyId).toBe(SUC_B);
    expect(tabla.get("9993330003")).toBeUndefined();
  });

  it.each([
    ["sin la variable", undefined],
    ["vacia", "  "],
    ["no es JSON", "{no"],
    ["es un arreglo", "[]"],
  ])("tabla %s: problema explicito y ninguna entrada", (_n, json) => {
    const { tabla, problemas } = parsearTablaDnis(json, {});
    expect(tabla.size).toBe(0);
    expect(problemas.length).toBeGreaterThan(0);
  });

  it("rechaza entradas invalidas sin filtrar valores: uuid malo, secreto sin valor, tope no positivo, modo desconocido, numero repetido", () => {
    const casos: Array<[string, Record<string, unknown>]> = [
      ["uuid malo", entrada({ organizationId: "no-es-uuid" })],
      ["sin secretoEnv", { ...entrada(), secretoEnv: undefined }],
      ["secreto sin valor", entrada({ secretoEnv: "VOICE_SECRET_VACIO" })],
      ["tope cero", entrada({ topeMensualUsd: 0 })],
      ["modo desconocido", entrada({ modoEntrada: "otro" })],
    ];
    for (const [nombre, e] of casos) {
      const { tabla, problemas } = parsearTablaDnis(JSON.stringify({ "9991110001": e }), { VOICE_SECRET_FCO: "x", VOICE_SECRET_VACIO: "" });
      expect(tabla.size, nombre).toBe(0);
      expect(problemas.join(" "), nombre).not.toContain("secreto-real");
    }
    const repetido = parsearTablaDnis(JSON.stringify({ "+52 999 111 0001": entrada(), "9991110001": entrada() }), { VOICE_SECRET_FCO: "x" });
    expect(repetido.problemas.join(" ")).toMatch(/repetido/);
  });
});

describe("cargarConfig: modo NO CONFIGURADO", () => {
  it("con todo presente queda configurado, sin motivos, y normaliza la URL de la API", () => {
    const c = cargarConfig(ENV_BASE);
    expect(c.estado).toBe("configurado");
    expect(c.motivos).toEqual([]);
    expect(c.apiBaseUrl).toBe("https://api.ejemplo.invalid");
    expect(c.livekit).toMatchObject({ url: "wss://ejemplo.livekit.invalid", prefijoSala: "llamada-" });
    expect(c.dnis.size).toBe(1);
  });

  it.each(["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "ATIENDE_API_URL", "INTERNAL_SECRET", "VOICE_DNIS_MAP"] as const)("sin %s: no configurado y el motivo nombra la variable", (variable) => {
    const { [variable]: _quitada, ...resto } = ENV_BASE;
    const c = cargarConfig(resto);
    expect(c.estado).toBe("no_configurado");
    expect(c.motivos.join(" ")).toContain(variable);
  });

  it("sin GEMINI_API_KEY ni OPENROUTER_API_KEY ninguna escalera puede abrir: no configurado", () => {
    const { GEMINI_API_KEY: _g, ...resto } = ENV_BASE;
    expect(cargarConfig(resto).estado).toBe("no_configurado");
    expect(cargarConfig({ ...resto, OPENROUTER_API_KEY: "or" }).estado).toBe("configurado");
  });

  it("faltan audios pregrabados: no configurado (el worker no contesta sin poder decir los avisos locales)", () => {
    const c = cargarConfig(ENV_BASE, { pregrabadosFaltantes: ["handoff", "despedida"] });
    expect(c.estado).toBe("no_configurado");
    expect(c.motivos.join(" ")).toMatch(/pregrabados/);
  });

  it("los motivos jamas contienen el valor de un secreto", () => {
    const c = cargarConfig({ ...ENV_BASE, LIVEKIT_URL: "", VOICE_SECRET_FCO: "" });
    const todo = c.motivos.join(" ");
    for (const secreto of ["secreto-livekit", "llave-livekit", "secreto-interno", "llave-gemini", "secreto-sucursal"]) expect(todo).not.toContain(secreto);
  });

  it("VOICE_TOPE_MENSUAL_USD invalido es un motivo; valido se guarda en micro-USD", () => {
    expect(cargarConfig({ ...ENV_BASE, VOICE_TOPE_MENSUAL_USD: "abc" }).motivos.join(" ")).toContain("VOICE_TOPE_MENSUAL_USD");
    expect(cargarConfig({ ...ENV_BASE, VOICE_TOPE_MENSUAL_USD: "12.5" }).topeMensualPlataformaMicroUsd).toBe(12_500_000);
    expect(cargarConfig(ENV_BASE).topeMensualPlataformaMicroUsd).toBeNull();
  });
});

describe("tope mensual por organizacion", () => {
  it("la sobreescritura de la organizacion gana; sin ella el de plataforma; sin ninguno, sin tope", () => {
    expect(resolverTopeMensualMicroUsd(50_000_000, 10)).toBe(10_000_000);
    expect(resolverTopeMensualMicroUsd(50_000_000, null)).toBe(50_000_000);
    expect(resolverTopeMensualMicroUsd(null, null)).toBeNull();
    expect(resolverTopeMensualMicroUsd(null, 7.25)).toBe(7_250_000);
  });
  it("un tope no positivo no cuenta como tope", () => {
    expect(resolverTopeMensualMicroUsd(0, 0)).toBeNull();
  });
});

describe("modo de entrada de la llamada", () => {
  it("un encabezado de desvio la vuelve desborde; sin el se respeta lo configurado; prueba siempre manda", () => {
    expect(modoEntradaDeLlamada("total", "<sip:+529991110000@conmutador>")).toBe("desborde");
    expect(modoEntradaDeLlamada("total", null)).toBe("total");
    expect(modoEntradaDeLlamada("desborde", null)).toBe("desborde");
    expect(modoEntradaDeLlamada("prueba", "<sip:+529991110000@conmutador>")).toBe("prueba");
    expect(modoEntradaDeLlamada("total", "  ")).toBe("total");
  });
  it("franja del dia segun la hora local", () => {
    expect([4, 5, 11, 12, 18, 19, 23].map(franjaDeHora)).toEqual(["noche", "manana", "manana", "tarde", "tarde", "noche", "noche"]);
  });
});

describe("Vertex AI y tope de costo por llamada (variables nuevas, todas opcionales)", () => {
  const MAPA = JSON.stringify({ "+52 999 111 0001": { orgSlug: "los-taquitos-de-pm", organizationId: "00000000-0000-4000-8000-000000000001", propertyId: "00000000-0000-4000-8000-0000000000a1", branchSlug: "fco-montejo", secretoEnv: "VOICE_SECRET_FCO" } });
  const base = { LIVEKIT_URL: "wss://x.invalid", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s", ATIENDE_API_URL: "http://a.invalid", INTERNAL_SECRET: "i", GEMINI_API_KEY: "g", VOICE_SECRET_FCO: "s", VOICE_DNIS_MAP: MAPA };

  it("por omision: Gemini API, sin Vertex y con el tope de la plataforma", () => {
    expect(cargarConfig(base)).toMatchObject({ estado: "configurado", geminiBackend: "api", vertex: null, costoMaxLlamadaMicroUsd: null });
  });

  it("VOICE_COSTO_MAX_LLAMADA_USD se convierte a micro-USD y se valida (0, negativo, texto y mas de US$20 son motivos)", () => {
    expect(cargarConfig({ ...base, VOICE_COSTO_MAX_LLAMADA_USD: "0.75" }).costoMaxLlamadaMicroUsd).toBe(750_000);
    for (const malo of ["0", "-1", "abc", "21"]) {
      const c = cargarConfig({ ...base, VOICE_COSTO_MAX_LLAMADA_USD: malo });
      expect(c.estado).toBe("no_configurado");
      expect(c.motivos.join(" ")).toContain("VOICE_COSTO_MAX_LLAMADA_USD");
    }
  });

  it("GEMINI_BACKEND=vertex exige proyecto y cuenta de servicio (solo nombres de variables en los motivos) y no necesita GEMINI_API_KEY", () => {
    const sinNada = cargarConfig({ ...base, GEMINI_API_KEY: "", GEMINI_BACKEND: "vertex" });
    expect(sinNada.estado).toBe("no_configurado");
    expect(sinNada.motivos.join(" ")).toContain("VERTEX_PROJECT");
    expect(sinNada.motivos.join(" ")).toContain("VERTEX_SERVICE_ACCOUNT_JSON");
    const ok = cargarConfig({ ...base, GEMINI_API_KEY: "", GEMINI_BACKEND: "vertex", VERTEX_PROJECT: "mi-proyecto", VERTEX_SERVICE_ACCOUNT_JSON: '{"cuenta":"de-servicio"}' });
    expect(ok.estado).toBe("configurado");
    expect(ok.vertex).toEqual({ project: "mi-proyecto", location: "us-central1", serviceAccountJson: '{"cuenta":"de-servicio"}' });
    expect(ok.motivos.join(" ")).not.toContain("cuenta");
  });

  it("un GEMINI_BACKEND desconocido o una region que no lo parece dejan al worker sin configurar", () => {
    expect(cargarConfig({ ...base, GEMINI_BACKEND: "azure" }).motivos.join(" ")).toContain("GEMINI_BACKEND");
    expect(cargarConfig({ ...base, GEMINI_BACKEND: "vertex", VERTEX_PROJECT: "p", VERTEX_SERVICE_ACCOUNT_JSON: "{}", VERTEX_LOCATION: "no es region" }).motivos.join(" ")).toContain("VERTEX_LOCATION");
  });
});

describe("VAD por variable (VOICE_VAD_SILENCIO_MS, VOICE_VAD_SENSIBILIDAD_FIN)", () => {
  const MAPA = JSON.stringify({ "+52 999 111 0001": { orgSlug: "los-taquitos-de-pm", organizationId: "00000000-0000-4000-8000-000000000001", propertyId: "00000000-0000-4000-8000-0000000000a1", branchSlug: "fco-montejo", secretoEnv: "VOICE_SECRET_FCO" } });
  const base = { LIVEKIT_URL: "wss://x.invalid", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s", ATIENDE_API_URL: "http://a.invalid", INTERNAL_SECRET: "i", GEMINI_API_KEY: "g", VOICE_SECRET_FCO: "s", VOICE_DNIS_MAP: MAPA };
  it("sin variables el VAD queda vacio (manda el de la plataforma)", () => {
    expect(cargarConfig(base).vad).toEqual({});
  });
  it("traduce el silencio y la sensibilidad", () => {
    expect(cargarConfig({ ...base, VOICE_VAD_SILENCIO_MS: "700", VOICE_VAD_SENSIBILIDAD_FIN: "baja" }).vad).toEqual({ silencioFinMs: 700, sensibilidadFin: "END_SENSITIVITY_LOW" });
    expect(cargarConfig({ ...base, VOICE_VAD_SENSIBILIDAD_FIN: "omitir" }).vad).toEqual({ sensibilidadFin: null });
  });
  it.each([["VOICE_VAD_SILENCIO_MS", "50"], ["VOICE_VAD_SILENCIO_MS", "abc"], ["VOICE_VAD_SILENCIO_MS", "5000"], ["VOICE_VAD_SENSIBILIDAD_FIN", "media"]])("%s=%s deja al worker sin configurar", (nombre, valor) => {
    const c = cargarConfig({ ...base, [nombre]: valor });
    expect(c.estado).toBe("no_configurado");
    expect(c.motivos.join(" ")).toContain(nombre);
  });
});
