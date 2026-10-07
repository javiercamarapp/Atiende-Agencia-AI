// Escalera hibrida (Gemini Live -> cascada OpenRouter -> humano/buzon), costo por llamada y estado de credenciales. Sin red.
import { describe, expect, it } from "vitest";
import {
  ControladorLlamada,
  VOZ_PLATAFORMA,
  VozNoConfiguradaError,
  VozProveedorError,
  costoEstimadoMicroUsd,
  costoTotalMicroUsd,
  crearEjecutorTools,
  crearEscaleraLlamada,
  estadoEscalera,
  eventosCostoLlamada,
} from "../src/index.ts";
import type { AperturaLlamada, EscalonLlamada, ManejadoresSesion, RegistroToolsVoz, VozSesionLlamada } from "../src/index.ts";

const REGISTRO: RegistroToolsVoz = {
  definiciones: () => [{ name: "pasar_a_persona", description: "Persona.", parameters: { type: "object", properties: {} } }],
  herramientasInciertas: [],
  mensajeIncierto: "incierto",
};
const APERTURA: AperturaLlamada = { instruccion: "Eres el agente.", voiceId: "Kore", herramientas: REGISTRO.definiciones() };

interface EscalonFalso extends EscalonLlamada {
  readonly aperturas: AperturaLlamada[];
  caer(razon?: string): void;
  decir(texto: string): void;
}

function escalon(id: EscalonLlamada["id"], opts: { falla?: Error } = {}): EscalonFalso {
  const aperturas: AperturaLlamada[] = [];
  let h: ManejadoresSesion | null = null;
  return {
    id,
    aperturas,
    caer: (razon = "ws_cerrado") => h?.caido(razon, `handle-${id}`),
    decir: (t) => h?.agenteDijo(t),
    abrirSesion: async (apertura, manejadores) => {
      if (opts.falla) throw opts.falla;
      aperturas.push(apertura);
      h = manejadores;
      const sesion: VozSesionLlamada = { enviarTexto: () => undefined, interrumpir: () => undefined, cerrar: async () => undefined };
      return sesion;
    },
  };
}

function reloj() {
  let t = 1_000_000;
  return { ahora: () => t, avanzar: (s: number) => void (t += s * 1000) };
}

describe("escalera de proveedores de una llamada", () => {
  it("abre Gemini primero; sin credencial (VozNoConfiguradaError) salta a la cascada, sin error", async () => {
    const gemini = escalon("gemini-3.8-live", { falla: new VozNoConfiguradaError("falta GEMINI_API_KEY") });
    const cascada = escalon("cascada-openrouter");
    const e = crearEscaleraLlamada([gemini, cascada]);
    await e.abrirSesion(APERTURA, { caido: () => undefined } as unknown as ManejadoresSesion);
    expect(e.escalonActual()).toBe("cascada-openrouter");
    expect(e.fallidos()).toEqual(["gemini-3.8-live"]);
    expect(cascada.aperturas).toHaveLength(1);
  });

  it("con Gemini sano, la cascada ni se toca", async () => {
    const gemini = escalon("gemini-3.8-live");
    const cascada = escalon("cascada-openrouter");
    const e = crearEscaleraLlamada([gemini, cascada]);
    await e.abrirSesion(APERTURA, { caido: () => undefined } as unknown as ManejadoresSesion);
    expect(e.escalonActual()).toBe("gemini-3.8-live");
    expect(cascada.aperturas).toHaveLength(0);
    expect(e.fallidos()).toEqual([]);
  });

  it("Gemini falla por el proveedor (5xx) al abrir: cae a la cascada", async () => {
    const e = crearEscaleraLlamada([escalon("gemini-3.8-live", { falla: new VozProveedorError("503", 503) }), escalon("cascada-openrouter")]);
    await e.abrirSesion(APERTURA, { caido: () => undefined } as unknown as ManejadoresSesion);
    expect(e.escalonActual()).toBe("cascada-openrouter");
  });

  it("si Gemini falla al ABRIR la llamada, la cascada recibe la instruccion original (debe saludar), sin aviso de reconexion", async () => {
    const cascada = escalon("cascada-openrouter");
    const e = crearEscaleraLlamada([escalon("gemini-3.8-live", { falla: new VozProveedorError("503", 503) }), cascada]);
    await e.abrirSesion(APERTURA, { caido: () => undefined } as unknown as ManejadoresSesion);
    expect(cascada.aperturas[0]!.instruccion).toBe(APERTURA.instruccion);
  });

  it("si Gemini se cae a MEDIA llamada, la reconexion del controlador cae a la cascada con un resumen redactado de lo dicho, y el costo sale por tramo", async () => {
    const r = reloj();
    const gemini = escalon("gemini-3.8-live");
    const cascada = escalon("cascada-openrouter");
    const e = crearEscaleraLlamada([gemini, cascada], { ahora: r.ahora });
    const c = new ControladorLlamada({
      callId: "llamada-1",
      reglas: { herramientaObjetivo: "apartar", resultadoObjetivo: "logrado", herramientaEscalar: "pasar_a_persona" },
      construirEscalacion: (motivo, resumen) => ({ nombre: "pasar_a_persona", args: { motivo, resumen } }),
      propertyId: "p",
      organizationId: "o",
      abrirSesion: e.abrirSesion,
      ejecutor: crearEjecutorTools({ registro: REGISTRO, transporte: async () => ({ resultado: { ok: true }, entidadId: null }), timeoutMs: 1000 }),
      instruccion: APERTURA.instruccion,
      voiceId: "Kore",
      reproducir: () => undefined,
      dormir: async () => undefined,
    });
    await c.iniciar({ habilitado: true, gastoMesMicroUsd: 0, topeMensualMicroUsd: null });
    gemini.decir("Hola, buenas tardes. Mi tarjeta es 4111 1111 1111 1111");
    await c.vacio();
    r.avanzar(30);
    gemini.caer("ws_cerrado");
    await c.vacio();

    expect(e.escalonActual()).toBe("cascada-openrouter");
    expect(e.fallidos()).toEqual(["gemini-3.8-live"]);
    const ap = cascada.aperturas[0]!;
    expect(ap.instruccion).toContain("Eres el agente.");
    expect(ap.instruccion).toContain("se reconecto");
    expect(ap.instruccion).toContain("buenas tardes");
    expect(ap.instruccion).not.toContain("4111 1111 1111 1111");
    expect(ap.reanudarHandle ?? null).toBeNull(); // el handle de Gemini no vale para la cascada

    r.avanzar(60);
    await c.clienteCuelga();
    const tramos = e.tramos();
    expect(tramos.map((t) => [t.escalon, t.duracionS])).toEqual([["gemini-3.8-live", 30], ["cascada-openrouter", 60]]);
  });

  it("sin ningun escalon disponible `abrirSesion` lanza y el controlador deja la llamada a la persona/buzon (falla_sistema), sin colgar a medias", async () => {
    const e = crearEscaleraLlamada([escalon("gemini-3.8-live", { falla: new VozNoConfiguradaError("x") }), escalon("cascada-openrouter", { falla: new VozProveedorError("500", 500) })]);
    const dichos: string[] = [];
    const herramientas: string[] = [];
    const c = new ControladorLlamada({
      callId: "llamada-2",
      reglas: { herramientaObjetivo: "apartar", resultadoObjetivo: "logrado", herramientaEscalar: "pasar_a_persona" },
      construirEscalacion: (motivo, resumen) => ({ nombre: "pasar_a_persona", args: { motivo, resumen } }),
      propertyId: "p",
      organizationId: "o",
      abrirSesion: e.abrirSesion,
      ejecutor: crearEjecutorTools({
        registro: REGISTRO,
        transporte: async (n) => {
          herramientas.push(n);
          return { resultado: { ok: true }, entidadId: null };
        },
        timeoutMs: 1000,
      }),
      instruccion: "x",
      voiceId: "Kore",
      reproducir: (m) => void dichos.push(m),
      dormir: async () => undefined,
    });
    await c.iniciar({ habilitado: true, gastoMesMicroUsd: 0, topeMensualMicroUsd: null });
    const fin = await c.terminada;
    expect(fin.resultado).toBe("escalado");
    expect(dichos).toContain("proveedor_caido");
    expect(herramientas).toEqual(["pasar_a_persona"]);
    expect(e.tramos()).toEqual([]);
  });
});

describe("costo por llamada (config unica de plataforma)", () => {
  it("el precio por minuto es el de la plataforma y se redondea hacia arriba", () => {
    expect(costoEstimadoMicroUsd("gemini-3.8-live", 60)).toBe(VOZ_PLATAFORMA.gemini.precioMicroUsdPorMinuto);
    expect(costoEstimadoMicroUsd("cascada-openrouter", 60)).toBe(VOZ_PLATAFORMA.cascada.precioMicroUsdPorMinuto);
    expect(costoEstimadoMicroUsd("gemini-3.8-live", 1)).toBe(Math.ceil(VOZ_PLATAFORMA.gemini.precioMicroUsdPorMinuto / 60));
    expect(costoEstimadoMicroUsd("gemini-3.8-live", 0)).toBe(0);
    expect(costoEstimadoMicroUsd("gemini-3.8-live", Number.NaN)).toBe(0);
  });

  it("un evento por escalon con ref_id `<llamada>:<escalon>` (idempotente) y proveedor = escalon", () => {
    const eventos = eventosCostoLlamada({
      vertical: "hoteles",
      llamadaId: "abc",
      organizationId: "org",
      propertyId: "prop",
      ocurridoEn: "2026-10-03T12:00:00Z",
      tramos: [
        { escalon: "gemini-3.8-live", duracionS: 30, costoReportadoMicroUsd: 0 },
        { escalon: "cascada-openrouter", duracionS: 60, costoReportadoMicroUsd: 0 },
      ],
    });
    expect(eventos.map((e) => [e.proveedor, e.refTipo, e.refId, e.unidad, e.categoria, e.cantidad, e.costoEstimado])).toEqual([
      ["gemini-3.8-live", "voz_hoteles", "abc:gemini-3.8-live", "segundo", "voz", 30, true],
      ["cascada-openrouter", "voz_hoteles", "abc:cascada-openrouter", "segundo", "voz", 60, true],
    ]);
    expect(costoTotalMicroUsd(eventos)).toBe(costoEstimadoMicroUsd("gemini-3.8-live", 30) + VOZ_PLATAFORMA.cascada.precioMicroUsdPorMinuto);
  });

  it("el costo que reporta el escalon solo SUBE la estimacion por minuto, nunca la baja; dos tramos del mismo escalon se suman", () => {
    const [e] = eventosCostoLlamada({
      vertical: "hoteles",
      llamadaId: "x",
      organizationId: "o",
      propertyId: null,
      ocurridoEn: "2026-10-03T12:00:00Z",
      tramos: [
        { escalon: "cascada-openrouter", duracionS: 6, costoReportadoMicroUsd: 99_999 },
        { escalon: "cascada-openrouter", duracionS: 6, costoReportadoMicroUsd: 1 },
      ],
    });
    expect(e!.costoMicroUsd).toBe(100_000);
    expect(e!.cantidad).toBe(12);
    const [b] = eventosCostoLlamada({ vertical: "hoteles", llamadaId: "y", organizationId: "o", propertyId: null, ocurridoEn: "t", tramos: [{ escalon: "gemini-3.8-live", duracionS: 60, costoReportadoMicroUsd: 5 }] });
    expect(b!.costoMicroUsd).toBe(VOZ_PLATAFORMA.gemini.precioMicroUsdPorMinuto);
  });

  it("sin tramos o con tramos vacios no hay evento; una vertical invalida se rechaza (ref_tipo del SQL)", () => {
    expect(eventosCostoLlamada({ vertical: "hoteles", llamadaId: "z", organizationId: "o", propertyId: null, ocurridoEn: "t", tramos: [] })).toEqual([]);
    expect(eventosCostoLlamada({ vertical: "hoteles", llamadaId: "z", organizationId: "o", propertyId: null, ocurridoEn: "t", tramos: [{ escalon: "gemini-3.8-live", duracionS: 0, costoReportadoMicroUsd: 0 }] })).toEqual([]);
    expect(() => eventosCostoLlamada({ vertical: "Hoteles; drop", llamadaId: "z", organizationId: "o", propertyId: null, ocurridoEn: "t", tramos: [] })).toThrow();
  });
});

describe("estado honesto de la escalera", () => {
  const llm = { completar: async () => ({ texto: "", toolCalls: [], costoMicroUsd: 0 }) };
  it("sin llaves: no operativa y dice que falta", () => {
    const s = estadoEscalera({ geminiApiKey: null, openrouterApiKey: null, llm: null });
    expect(s.operativa).toBe(false);
    expect(s.escalones.map((x) => [x.escalon, x.configurado])).toEqual([["gemini-3.8-live", false], ["cascada-openrouter", false]]);
    expect(s.escalones[0]!.detalle).toContain("GEMINI_API_KEY");
    expect(s.escalones[1]!.detalle).toContain("OPENROUTER_API_KEY");
  });
  it("solo OpenRouter + gateway: operativa por la cascada; sin gateway la cascada no cuenta", () => {
    expect(estadoEscalera({ geminiApiKey: null, openrouterApiKey: "k", llm }).operativa).toBe(true);
    const sinGateway = estadoEscalera({ geminiApiKey: null, openrouterApiKey: "k", llm: null });
    expect(sinGateway.operativa).toBe(false);
    expect(sinGateway.escalones[1]!.detalle).toContain("gateway");
  });
  it("nunca devuelve la llave", () => {
    expect(JSON.stringify(estadoEscalera({ geminiApiKey: "AIza-secreta", openrouterApiKey: "sk-or-secreta", llm }))).not.toMatch(/secreta/);
  });
});

describe("reintentosPorEscalon (reconexion al MISMO escalon, voz-05)", () => {
  const manejadores = { caido: () => undefined } as unknown as ManejadoresSesion;
  it("por omision un escalon caido no se reabre (comportamiento original)", async () => {
    const gemini = escalon("gemini-3.8-live");
    const e = crearEscaleraLlamada([gemini]);
    await e.abrirSesion(APERTURA, manejadores);
    gemini.caer("ws_1011");
    await expect(e.abrirSesion(APERTURA, manejadores)).rejects.toThrow();
    expect(e.fallidos()).toEqual(["gemini-3.8-live"]);
  });
  it("con reintentos, la caida reabre el mismo escalon sin darlo por fallido y sin saltar a la cascada", async () => {
    const gemini = escalon("gemini-3.8-live");
    const cascada = escalon("cascada-openrouter");
    const e = crearEscaleraLlamada([gemini, cascada], { reintentosPorEscalon: 2 });
    await e.abrirSesion(APERTURA, manejadores);
    gemini.caer("ws_1011");
    expect(e.fallidos()).toEqual([]);
    await e.abrirSesion(APERTURA, manejadores);
    expect(e.escalonActual()).toBe("gemini-3.8-live");
    expect(gemini.aperturas).toHaveLength(2);
    expect(cascada.aperturas).toHaveLength(0);
  });
  it("un fallo al abrir con reintentos pendientes hace fallar el intento (el controlador espera y reintenta); agotados, pasa a la cascada", async () => {
    const falla = escalon("gemini-3.8-live", { falla: new Error("ws_1011") });
    const cascada = escalon("cascada-openrouter");
    const e = crearEscaleraLlamada([falla, cascada], { reintentosPorEscalon: 1 });
    await expect(e.abrirSesion(APERTURA, manejadores)).rejects.toThrow("ws_1011");
    expect(e.fallidos()).toEqual([]);
    await e.abrirSesion(APERTURA, manejadores);
    expect(e.fallidos()).toEqual(["gemini-3.8-live"]);
    expect(e.escalonActual()).toBe("cascada-openrouter");
  });
  it("sin credencial (VozNoConfiguradaError) no se reintenta aunque haya reintentos", async () => {
    const gemini = escalon("gemini-3.8-live", { falla: new VozNoConfiguradaError("falta GEMINI_API_KEY") });
    const cascada = escalon("cascada-openrouter");
    const e = crearEscaleraLlamada([gemini, cascada], { reintentosPorEscalon: 3 });
    await e.abrirSesion(APERTURA, manejadores);
    expect(e.escalonActual()).toBe("cascada-openrouter");
  });
});
