// QA-PM-R2 (voz): pedido grande retenido = llamada `escalado` (voz-14), timeout incierto de crear_pedido (voz-04), despedida que cuelga (voz-16), texto de herramienta
// que el modelo "pronuncia" (voz-12), silencio del agente tras una herramienta (voz-06), reconexion que conserva el contexto (voz-05) y el grader sobre fragmentos
// (voz-15). Sin red.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallStateMachine, ControladorLlamada, crearEjecutorTools, limpiarTextoAgente } from "../src/index.ts";
import type { AperturaLlamada, ManejadoresSesion, RegistroToolsVoz, VozSesionLlamada } from "../src/index.ts";
import { G_PRECIO_HABLADO } from "../src/simulador/index.ts";
import type { LlamadaGradeable } from "../src/simulador/index.ts";

const REGLAS = { herramientaObjetivo: "crear_pedido", resultadoObjetivo: "pedido_creado", herramientaEscalar: "escalar_a_humano" } as const;
const maquina = () => new CallStateMachine<"pedido_creado">(REGLAS);

describe("maquina: pedido retenido e incierto", () => {
  it("un pedido grande retenido (ok, sin entidad, retenido) termina `escalado`, no `abandonado` (VX24/VX25)", () => {
    const m = maquina();
    m.recibir({ tipo: "conectada" });
    m.recibir({ tipo: "tool_resultado", nombre: "crear_pedido", ok: true, entidadId: null, retenido: true });
    const acciones = m.recibir({ tipo: "cliente_cuelga" });
    expect(acciones).toEqual([]);
    expect(m.resultado).toBe("escalado");
  });
  it("sin la marca de retenido, un crear_pedido sin entidad sigue siendo abandonado", () => {
    const m = maquina();
    m.recibir({ tipo: "conectada" });
    m.recibir({ tipo: "tool_resultado", nombre: "crear_pedido", ok: true, entidadId: null });
    m.recibir({ tipo: "cliente_cuelga" });
    expect(m.resultado).toBe("abandonado");
  });
  it("el timeout INCIERTO de crear_pedido avisa a una persona sin colgar, una sola vez, y la llamada termina `escalado` (VX33)", () => {
    const m = maquina();
    m.recibir({ tipo: "conectada" });
    const a = m.recibir({ tipo: "tool_resultado", nombre: "crear_pedido", ok: false, timeout: true, incierto: true });
    expect(a).toEqual([{ tipo: "decir", mensaje: "tool_timeout" }, { tipo: "escalar", motivo: "falla_sistema" }]);
    expect(m.estadoActual).toBe("activa");
    m.recibir({ tipo: "tool_resultado", nombre: "crear_pedido", ok: false, timeout: true, incierto: true });
    m.recibir({ tipo: "cliente_cuelga" });
    expect(m.resultado).toBe("escalado");
  });
  it("tras crear el pedido, la despedida del agente cuelga al terminar su turno (VX35 duro 534 s)", () => {
    const m = maquina();
    m.recibir({ tipo: "conectada" });
    m.recibir({ tipo: "tool_resultado", nombre: "crear_pedido", ok: true, entidadId: "o-1" });
    expect(m.recibir({ tipo: "despedida_dicha" })).toEqual([]);
    expect(m.recibir({ tipo: "agente_termina" })).toEqual([{ tipo: "colgar", resultado: "pedido_creado" }]);
  });
  it("una despedida SIN pedido creado no cuelga", () => {
    const m = maquina();
    m.recibir({ tipo: "conectada" });
    m.recibir({ tipo: "despedida_dicha" });
    expect(m.recibir({ tipo: "agente_termina" })).toEqual([]);
  });
});

describe("ejecutor: el timeout de una escritura que aborta la peticion sigue siendo INCIERTO", () => {
  it("si el transporte rechaza por el aborto ANTES de que gane la carrera del timeout, el resultado conserva `incierto` (antes se perdia y la maquina no avisaba)", async () => {
    const registro: RegistroToolsVoz = { definiciones: () => [{ name: "crear_pedido", description: "x", parameters: { type: "object", properties: {} } }], herramientasInciertas: ["crear_pedido"], mensajeIncierto: "incierto" };
    const ej = crearEjecutorTools({ registro, timeoutMs: 15, transporte: (_n, _a, senal) => new Promise((_r, rej) => senal.addEventListener("abort", () => rej(new Error("abortado")))) });
    const r = await ej.ejecutar("crear_pedido", {});
    expect(r).toMatchObject({ ok: false, timeout: true });
    expect(r.resultado).toMatchObject({ incierto: true });
  });
});

describe("limpiarTextoAgente (VX13 llamada 2)", () => {
  it("quita la llamada a herramienta que el modelo pronuncio", () => {
    expect(limpiarTextoAgente("Un momento. :buscar_cliente{output:{isNew:true}} ¿Para recoger o a domicilio?").replace(/\s+/g, " ")).toBe("Un momento. ¿Para recoger o a domicilio?");
    expect(limpiarTextoAgente("Son ciento sesenta y ocho pesos.")).toBe("Son ciento sesenta y ocho pesos.");
  });
});

// --- controlador con una sesion falsa ---
interface SesionFalsa { readonly aperturas: AperturaLlamada[]; manejadores(): ManejadoresSesion; readonly cerradas: number[]; readonly textos: string[] }
function sesionFalsa(): { abrirSesion: (a: AperturaLlamada, h: ManejadoresSesion) => Promise<VozSesionLlamada>; estado: SesionFalsa } {
  const aperturas: AperturaLlamada[] = [];
  const cerradas: number[] = [];
  const textos: string[] = [];
  let h: ManejadoresSesion | null = null;
  return {
    abrirSesion: async (a, m) => {
      aperturas.push(a);
      h = m;
      return { enviarTexto: (t: string) => void textos.push(t), interrumpir: () => undefined, cerrar: async () => void cerradas.push(1) };
    },
    estado: { aperturas, cerradas, textos, manejadores: () => h! },
  };
}
const REGISTRO: RegistroToolsVoz = {
  definiciones: () => [
    { name: "cotizar_pedido", description: "x", parameters: { type: "object", properties: {} } },
    { name: "crear_pedido", description: "x", parameters: { type: "object", properties: {} } },
    { name: "escalar_a_humano", description: "x", parameters: { type: "object", properties: {} } },
  ],
  herramientasInciertas: ["crear_pedido"],
  mensajeIncierto: "incierto",
};
function controlador(over: Partial<ConstructorParameters<typeof ControladorLlamada>[0]> = {}) {
  const s = sesionFalsa();
  const dichos: string[] = [];
  const escaladas: { motivo: string; resumen: string }[] = [];
  const respuestas: Record<string, unknown> = {
    cotizar_pedido: { quote: { total: 126, lines: [{ name: "Taco Al Pastor (individual)", requested_quantity: 3 }] } },
    crear_pedido: { order: { id: "o-1" } },
    escalar_a_humano: { ok: true },
  };
  const c = new ControladorLlamada({
    callId: "llamada-r2",
    reglas: REGLAS,
    construirEscalacion: (motivo, resumen) => {
      escaladas.push({ motivo, resumen });
      return { nombre: "escalar_a_humano", args: { motivo, resumen } };
    },
    propertyId: "p",
    organizationId: "o",
    abrirSesion: s.abrirSesion,
    ejecutor: crearEjecutorTools({ registro: REGISTRO, timeoutMs: 1000, transporte: async (n) => ({ resultado: respuestas[n], entidadId: n === "crear_pedido" ? "o-1" : null }) }),
    instruccion: "Eres el agente.",
    voiceId: "Kore",
    reproducir: (m) => void dichos.push(String(m)),
    dormir: async () => undefined,
    ...over,
  });
  return { c, s, dichos, escaladas };
}

describe("controlador", () => {
  afterEach(() => vi.useRealTimers());

  it("la transcripcion del agente no lleva el texto de la herramienta (voz-12)", async () => {
    const { c, s } = controlador();
    await c.iniciar({ habilitado: true, gastoMesMicroUsd: 0, topeMensualMicroUsd: null });
    s.estado.manejadores().agenteDijo("Permítame. :buscar_cliente{output:{isNew:true}} ¿Para recoger?");
    await c.vacio();
    expect(c.transcripcion.map((t) => t.texto).join(" ")).not.toContain("buscar_cliente");
    expect(c.transcripcion.map((t) => t.texto).join(" ")).toContain("¿Para recoger?");
  });

  it("tras crear el pedido, la despedida del agente cuelga la llamada como pedido_creado (voz-16)", async () => {
    const { c, s } = controlador();
    await c.iniciar({ habilitado: true, gastoMesMicroUsd: 0, topeMensualMicroUsd: null });
    const h = s.estado.manejadores();
    await h.ejecutarTool({ id: "1", nombre: "crear_pedido", args: {} });
    h.agenteDijo("Su pedido quedó registrado. Gracias por llamar, hasta luego.");
    h.agenteTermino();
    const r = await c.terminada;
    expect(r.resultado).toBe("pedido_creado");
  });

  it("si crear_pedido expira (resultado incierto), el aviso a la persona lleva el carrito y la nota de verificar (voz-04 / voz-13)", async () => {
    const { c, s, escaladas } = controlador({
      ejecutor: crearEjecutorTools({
        registro: REGISTRO,
        timeoutMs: 15,
        transporte: (n, _a, senal) => (n === "crear_pedido" ? new Promise((_r, rej) => senal.addEventListener("abort", () => rej(new Error("abortado")))) : Promise.resolve({ resultado: { quote: { total: 126, lines: [{ name: "Taco Al Pastor (individual)", requested_quantity: 3 }] } }, entidadId: null })),
      }),
    });
    await c.iniciar({ habilitado: true, gastoMesMicroUsd: 0, topeMensualMicroUsd: null });
    const h = s.estado.manejadores();
    await h.ejecutarTool({ id: "1", nombre: "cotizar_pedido", args: {} });
    await h.ejecutarTool({ id: "2", nombre: "crear_pedido", args: {} });
    await c.vacio();
    expect(escaladas).toHaveLength(1);
    expect(escaladas[0]!.motivo).toBe("falla_sistema");
    expect(escaladas[0]!.resumen).toMatch(/PUDO quedar registrado/);
    expect(escaladas[0]!.resumen).toMatch(/3 x Taco Al Pastor \(individual\).*Total \$126/);
    await c.clienteCuelga();
    expect((await c.terminada).resultado).toBe("escalado");
  });

  it("si el agente se queda callado tras una herramienta, se dice el pregrabado 'un momento' (voz-06)", async () => {
    vi.useFakeTimers();
    const { c, s, dichos } = controlador({ vigilarSilencioAgenteMs: 5000 });
    await c.iniciar({ habilitado: true, gastoMesMicroUsd: 0, topeMensualMicroUsd: null });
    await s.estado.manejadores().ejecutarTool({ id: "1", nombre: "cotizar_pedido", args: {} });
    await vi.advanceTimersByTimeAsync(4000);
    expect(dichos).not.toContain("tool_timeout");
    await vi.advanceTimersByTimeAsync(1500);
    await c.vacio();
    expect(dichos).toContain("tool_timeout");
  });

  it("QA-PM-R5-voz-03: tras el pregrabado, si el agente sigue mudo se le empuja UNA vez con un turno de texto", async () => {
    vi.useFakeTimers();
    const { c, s, dichos } = controlador({ vigilarSilencioAgenteMs: 5000 });
    await c.iniciar({ habilitado: true, gastoMesMicroUsd: 0, topeMensualMicroUsd: null });
    await s.estado.manejadores().ejecutarTool({ id: "1", nombre: "cotizar_pedido", args: {} });
    await vi.advanceTimersByTimeAsync(5500);
    await c.vacio();
    expect(dichos).toContain("tool_timeout");
    expect(s.estado.textos.filter((t) => /Aviso del sistema/.test(t))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5500);
    await c.vacio();
    expect(s.estado.textos.filter((t) => /Aviso del sistema/.test(t))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30000);
    await c.vacio();
    expect(s.estado.textos.filter((t) => /Aviso del sistema/.test(t))).toHaveLength(1);
  });

  it("negativo: si el agente habla despues del pregrabado, no se le empuja", async () => {
    vi.useFakeTimers();
    const { c, s } = controlador({ vigilarSilencioAgenteMs: 5000 });
    await c.iniciar({ habilitado: true, gastoMesMicroUsd: 0, topeMensualMicroUsd: null });
    const h = s.estado.manejadores();
    await h.ejecutarTool({ id: "1", nombre: "cotizar_pedido", args: {} });
    await vi.advanceTimersByTimeAsync(5500);
    await c.vacio();
    h.agenteDijo("Son ciento veintiséis pesos.");
    await vi.advanceTimersByTimeAsync(20000);
    await c.vacio();
    expect(s.estado.textos.filter((t) => /Aviso del sistema/.test(t))).toHaveLength(0);
  });

  it("si el agente SI habla tras la herramienta, no se dice nada", async () => {
    vi.useFakeTimers();
    const { c, s, dichos } = controlador({ vigilarSilencioAgenteMs: 5000 });
    await c.iniciar({ habilitado: true, gastoMesMicroUsd: 0, topeMensualMicroUsd: null });
    const h = s.estado.manejadores();
    await h.ejecutarTool({ id: "1", nombre: "cotizar_pedido", args: {} });
    h.agenteDijo("Son ciento veintiséis pesos.");
    await vi.advanceTimersByTimeAsync(8000);
    await c.vacio();
    expect(dichos).not.toContain("tool_timeout");
  });

  it("una caida SIN handle abre la sesion nueva con el historial de la conversacion (voz-05)", async () => {
    const { c, s } = controlador();
    await c.iniciar({ habilitado: true, gastoMesMicroUsd: 0, topeMensualMicroUsd: null });
    s.estado.manejadores().agenteDijo("Buenas tardes, ¿para recoger o a domicilio?");
    await c.usuarioDijo("Para recoger, tres tacos de pastor");
    await c.proveedorCae("ws_1011");
    await c.vacio();
    expect(s.estado.aperturas).toHaveLength(2);
    const segunda = s.estado.aperturas[1]!;
    expect(segunda.historial?.map((h) => h.rol)).toEqual(["agente", "cliente"]);
    expect(segunda.historial?.[1]?.texto).toContain("tres tacos de pastor");
  });
});

describe("G_PRECIO_HABLADO sobre fragmentos de Gemini (voz-15)", () => {
  it("el importe partido en fragmentos ('...ciento' + ' sesenta y ocho pesos') ya no reprueba una llamada correcta", async () => {
    const l = {
      tools: [{ nombre: "cotizar_pedido", args: {}, resultado: { quote: { total: 168 } } }],
      transcripcion: [{ rol: "agente", texto: "Son ciento" }, { rol: "agente", texto: " sesenta y ocho pesos" }],
    } as unknown as LlamadaGradeable;
    expect((await G_PRECIO_HABLADO(l)).ok).toBe(true);
  });
  it("un importe distinto, tambien partido, sigue marcandose", async () => {
    const l = {
      tools: [{ nombre: "cotizar_pedido", args: {}, resultado: { quote: { total: 168 } } }],
      transcripcion: [{ rol: "agente", texto: "Son doscien" }, { rol: "agente", texto: "tos pesos" }],
    } as unknown as LlamadaGradeable;
    expect((await G_PRECIO_HABLADO(l)).ok).toBe(false);
  });
});
