// Respaldo por etapa (ElevenLabs -> Deepgram), plazo al primer token del LLM con peticion de respaldo, nivel del modelo por turno y seleccion de la pila por llaves.
import { describe, expect, it } from "vitest";
import { VOZ_PLATAFORMA, VozNoConfiguradaError, completarConPlazo, crearProveedorCascadaV2, elegirNivelModelo, esAsentimiento, sttConRespaldo, ttsConRespaldo } from "../../src/index.ts";
import type { EventosStt, PeticionLlmVoz, PuertoLlmVoz, RespuestaLlmVoz } from "../../src/index.ts";
import { SttFalso, TtsFalso, audioDe, compuerta, escribe, fabricaSockets, llmFalso, manejadoresFalsos, turnoMicrotareas } from "./dobles.ts";

const LLM = VOZ_PLATAFORMA.cascadaV2.llm;
/** Lo que el worker enciende con VOZ_CEREBRO_DOS_NIVELES=1 (ver `crearEscalonesPlataforma`). */
const DOS_NIVELES = { modeloLlm: LLM.dosNiveles.modelo, modeloRapido: LLM.dosNiveles.modeloRapido, plazoLlm: { plazoMs: LLM.dosNiveles.plazoPrimerTokenMs, modeloRespaldo: LLM.dosNiveles.modeloRespaldo } } as const;

function eventos() {
  const vistos: string[] = [];
  const e: EventosStt = { hablaIniciada: () => void vistos.push("habla"), parcial: (t) => void vistos.push(`parcial:${t}`), turnoFinal: (t) => void vistos.push(`final:${t}`), caido: (c) => void vistos.push(`caido:${c}`) };
  return { vistos, e };
}

describe("STT con respaldo", () => {
  it("si el principal no abre, abre el respaldo y lo avisa", async () => {
    const avisos: string[] = [];
    const respaldo = new SttFalso();
    const { e, vistos } = eventos();
    const s = await sttConRespaldo(new SttFalso(true), respaldo, (etapa, momento, codigo) => void avisos.push(`${etapa}:${momento}:${codigo}`)).abrir({ hzEntrada: 16_000 }, e);
    expect(avisos).toEqual(["stt:apertura:apertura"]);
    respaldo.eventos!.turnoFinal("hola");
    expect(vistos).toEqual(["final:hola"]);
    s.enviarAudio(Uint8Array.from([1, 2]));
    expect(respaldo.audio).toHaveLength(1);
  });

  it("si el principal se cae a media llamada, pasa al respaldo sin avisar caida; el audio de mientras se reenvia y los eventos del caido se ignoran", async () => {
    const principal = new SttFalso();
    const respaldo = new SttFalso();
    const { e, vistos } = eventos();
    const s = await sttConRespaldo(principal, respaldo).abrir({ hzEntrada: 16_000, vocabulario: ["cochinita"] }, e);
    principal.eventos!.caido("stt_el_ws_1011");
    s.enviarAudio(Uint8Array.from([9, 9]));
    await turnoMicrotareas();
    expect(principal.cerrada).toBe(true);
    expect(respaldo.opciones).toEqual({ hzEntrada: 16_000, vocabulario: ["cochinita"] });
    expect(respaldo.audio.map((a) => [...a])).toEqual([[9, 9]]);
    principal.eventos!.turnoFinal("fantasma");
    respaldo.eventos!.turnoFinal("de verdad");
    expect(vistos).toEqual(["final:de verdad"]);
    expect(s.proveedor?.()).toBe("deepgram");
  });

  it("si tambien cae el respaldo, avisa la caida (la escalera decide)", async () => {
    const principal = new SttFalso();
    const respaldo = new SttFalso();
    const { e, vistos } = eventos();
    await sttConRespaldo(principal, respaldo).abrir({ hzEntrada: 16_000 }, e);
    principal.eventos!.caido("stt_el_ws_1011");
    await turnoMicrotareas();
    respaldo.eventos!.caido("stt_ws_1006");
    expect(vistos).toEqual(["caido:stt_ws_1006"]);
  });
});

describe("TTS con respaldo", () => {
  const consumir = async (it: AsyncIterable<Uint8Array>) => {
    const out: number[][] = [];
    for await (const t of it) out.push([...t]);
    return out;
  };

  it("si el principal no abre, usa el respaldo con SU voz", async () => {
    const respaldo = new TtsFalso();
    const s = await ttsConRespaldo(new TtsFalso(undefined, true), respaldo, "aura-2-estrella-es").abrir({ voz: "9Godp7dNohUvXk6qp0gS", hzSalida: 24_000 });
    expect(respaldo.opciones).toEqual({ voz: "aura-2-estrella-es", hzSalida: 24_000 });
    expect(await consumir(s.sintetizar("hola", new AbortController().signal))).toEqual([[1, 0, 1, 0], [2, 0, 2, 0]]);
    expect(s.proveedor?.()).toBe("deepgram-aura-2");
  });

  it("una frase que falla ANTES de dar audio se repite con el respaldo, y las siguientes van por el respaldo", async () => {
    // eslint-disable-next-line require-yield
    const principal = new TtsFalso(async function* () {
      throw new Error("tts_el_500");
    });
    const respaldo = new TtsFalso(async function* () {
      yield audioDe(7);
    });
    const s = await ttsConRespaldo(principal, respaldo, "aura-2-estrella-es").abrir({ voz: "9Godp7dNohUvXk6qp0gS", hzSalida: 24_000 });
    expect(await consumir(s.sintetizar("uno", new AbortController().signal))).toEqual([[7, 0, 7, 0]]);
    expect(await consumir(s.sintetizar("dos", new AbortController().signal))).toEqual([[7, 0, 7, 0]]);
    expect(principal.frases).toEqual(["uno"]);
    expect(respaldo.frases).toEqual(["uno", "dos"]);
  });

  it("si ya habia sonado parte de la frase, el error sube (no se repite media frase con otra voz)", async () => {
    const principal = new TtsFalso(async function* () {
      yield audioDe(1);
      throw new Error("tts_el_red");
    });
    const s = await ttsConRespaldo(principal, new TtsFalso(), "aura-2-estrella-es").abrir({ voz: "9Godp7dNohUvXk6qp0gS", hzSalida: 24_000 });
    await expect(consumir(s.sintetizar("uno", new AbortController().signal))).rejects.toThrow("tts_el_red");
    expect(s.proveedor?.()).toBe("deepgram-aura-2");
  });
});

function relojManual() {
  const pendientes: { fn: () => void; ms: number }[] = [];
  return {
    pendientes,
    poner: (fn: () => void, ms: number): unknown => (pendientes.push({ fn, ms }), pendientes.length - 1),
    quitar: (id: unknown): void => {
      const p = pendientes[id as number];
      if (p) p.fn = () => undefined;
    },
    vencer: (): void => {
      for (const p of pendientes.splice(0)) p.fn();
    },
  };
}

/** LLM falso con una compuerta por modelo: la prueba decide quien habla primero. */
function llmPorModelo(guion: Record<string, (p: PeticionLlmVoz) => Promise<Partial<RespuestaLlmVoz>>>) {
  const pedidos: string[] = [];
  const senales: Record<string, AbortSignal> = {};
  const llm: PuertoLlmVoz = {
    completar: async (p) => {
      pedidos.push(p.modeloPreferido ?? "");
      if (p.senal) senales[p.modeloPreferido ?? ""] = p.senal;
      const r = await guion[p.modeloPreferido ?? ""]!(p);
      return { texto: "", toolCalls: [], costoMicroUsd: 0, ...r };
    },
  };
  return { llm, pedidos, senales };
}

const PET = { system: "s", mensajes: [], herramientas: [], modeloPreferido: "openai/gpt-6-luna" } as const;

describe("plazo al primer token con peticion de respaldo (hedge)", () => {
  it("si el principal habla antes del plazo, no se lanza el respaldo ni la frase de espera", async () => {
    const reloj = relojManual();
    const { llm, pedidos } = llmPorModelo({ "openai/gpt-6-luna": async (p) => (p.onTextDelta?.("Claro."), { texto: "Claro." }) });
    let vencio = false;
    const r = await completarConPlazo(llm, { ...PET, onTextDelta: () => undefined }, { plazoMs: 2_500, modeloRespaldo: LLM.dosNiveles.modeloRespaldo, alVencer: () => (vencio = true), temporizador: reloj });
    expect(r).toMatchObject({ modelo: "openai/gpt-6-luna", respaldo: false });
    reloj.vencer();
    expect(pedidos).toEqual(["openai/gpt-6-luna"]);
    expect(vencio).toBe(false);
  });

  it("vencido el plazo sin texto: frase de espera + respaldo en paralelo; gana quien hable primero y la otra se aborta; solo pasan los trozos de la ganadora", async () => {
    const reloj = relojManual();
    const lento = compuerta();
    const { llm, pedidos, senales } = llmPorModelo({
      "openai/gpt-6-luna": async (p) => {
        await lento.promesa;
        p.onTextDelta?.("tarde");
        return { texto: "tarde" };
      },
      "anthropic/claude-haiku-5.5": async (p) => (p.onTextDelta?.("A tiempo."), { texto: "A tiempo." }),
    });
    const trozos: string[] = [];
    let esperas = 0;
    const ganado: string[] = [];
    const promesa = completarConPlazo(llm, { ...PET, onTextDelta: (d) => void trozos.push(d) }, { plazoMs: 2_500, modeloRespaldo: "anthropic/claude-haiku-5.5", alVencer: () => void (esperas += 1), alGanarRespaldo: (m) => void ganado.push(m), temporizador: reloj });
    await turnoMicrotareas();
    expect(reloj.pendientes[0]!.ms).toBe(2_500);
    reloj.vencer();
    const r = await promesa;
    expect(r).toMatchObject({ modelo: "anthropic/claude-haiku-5.5", respaldo: true, respuesta: { texto: "A tiempo." } });
    expect(esperas).toBe(1);
    expect(ganado).toEqual(["plazo"]);
    expect(senales["openai/gpt-6-luna"]!.aborted).toBe(true);
    lento.abrir();
    await turnoMicrotareas();
    expect(trozos).toEqual(["A tiempo."]);
    expect(pedidos).toEqual(["openai/gpt-6-luna", "anthropic/claude-haiku-5.5"]);
  });

  it("si el principal FALLA antes de hablar, el respaldo sale de inmediato (sin esperar el plazo)", async () => {
    const reloj = relojManual();
    const { llm, pedidos } = llmPorModelo({
      "openai/gpt-6-luna": async () => {
        throw Object.assign(new Error("x"), { status: 503 });
      },
      "anthropic/claude-haiku-5.5": async () => ({ texto: "ok" }),
    });
    const r = await completarConPlazo(llm, PET, { plazoMs: 2_500, modeloRespaldo: "anthropic/claude-haiku-5.5", temporizador: reloj });
    expect(r.respaldo).toBe(true);
    expect(pedidos).toEqual(["openai/gpt-6-luna", "anthropic/claude-haiku-5.5"]);
  });

  it("con respaldoEnFalla=false (vuelta con herramienta forzada) una falla del principal sube tal cual, sin pedir al respaldo", async () => {
    const { llm, pedidos } = llmPorModelo({
      "openai/gpt-6-luna": async () => {
        throw Object.assign(new Error("x"), { status: 400 });
      },
      "anthropic/claude-haiku-5.5": async () => ({ texto: "ok" }),
    });
    await expect(completarConPlazo(llm, PET, { plazoMs: 2_500, modeloRespaldo: "anthropic/claude-haiku-5.5", respaldoEnFalla: false, temporizador: relojManual() })).rejects.toMatchObject({ status: 400 });
    expect(pedidos).toEqual(["openai/gpt-6-luna"]);
  });

  it("si fallan las dos, sube el error del principal", async () => {
    const { llm } = llmPorModelo({
      "openai/gpt-6-luna": async () => {
        throw Object.assign(new Error("principal"), { status: 503 });
      },
      "anthropic/claude-haiku-5.5": async () => {
        throw Object.assign(new Error("respaldo"), { status: 500 });
      },
    });
    await expect(completarConPlazo(llm, PET, { plazoMs: 2_500, modeloRespaldo: "anthropic/claude-haiku-5.5", temporizador: relojManual() })).rejects.toMatchObject({ status: 503 });
  });

  it("sin modelo de respaldo (o igual al principal) no hay hedge", async () => {
    const reloj = relojManual();
    const { llm } = llmPorModelo({ "openai/gpt-6-luna": async () => ({ texto: "ok" }) });
    await completarConPlazo(llm, PET, { plazoMs: 2_500, modeloRespaldo: "openai/gpt-6-luna", temporizador: reloj });
    expect(reloj.pendientes).toHaveLength(0);
  });

  it("en la sesion: vencido el plazo se dice UNA frase de espera (no entra al historial) y habla el respaldo", async () => {
    const reloj = relojManual();
    const lento = compuerta();
    const { llm } = llmPorModelo({
      "openai/gpt-6-luna": async () => (await lento.promesa, { texto: "" }),
      "anthropic/claude-haiku-5.5": async (p) => (p.onTextDelta?.("Son 345 pesos."), { texto: "Son 345 pesos." }),
    });
    const stt = new SttFalso();
    const tts = new TtsFalso();
    const m = manejadoresFalsos();
    const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm, stt, tts, temporizador: reloj, ...DOS_NIVELES });
    await prov.abrirSesion({ instruccion: "i", voiceId: "Kore", herramientas: [] }, m.h);
    stt.eventos!.turnoFinal("cuanto es de dos tortas de cochinita");
    await turnoMicrotareas(40);
    reloj.vencer();
    await prov.inactivo();
    expect(tts.frases[0]).toBe(LLM.frasesEspera[1 % LLM.frasesEspera.length]);
    expect(tts.frases.join(" ")).toContain("Son 345 pesos.");
    lento.abrir();
  });

  it("si el cliente interrumpe mientras suena la frase de espera, la frase NO entra al historial del modelo", async () => {
    const reloj = relojManual();
    const lento = compuerta();
    const { llm } = llmPorModelo({
      "openai/gpt-6-luna": async () => (await lento.promesa, { texto: "" }),
      "anthropic/claude-haiku-5.5": async () => (await lento.promesa, { texto: "" }),
    });
    const stt = new SttFalso();
    const pet: PeticionLlmVoz[] = [];
    const llmTraza: PuertoLlmVoz = { completar: (p) => (pet.push({ ...p, mensajes: [...p.mensajes] }), llm.completar(p)) };
    let n = 0;
    const tts = new TtsFalso(async function* (_f, senal) {
      yield audioDe(1);
      // Solo la frase de espera "sigue sonando" hasta que el cliente interrumpe; las demas terminan de inmediato.
      if (++n === 1) await new Promise<void>((r) => senal.addEventListener("abort", () => r(), { once: true }));
    });
    const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm: llmTraza, stt, tts, temporizador: reloj, ...DOS_NIVELES, ahora: () => 1_000_000 });
    await prov.abrirSesion({ instruccion: "i", voiceId: "Kore", herramientas: [] }, manejadoresFalsos().h);
    stt.eventos!.turnoFinal("cuanto es de dos tortas de cochinita");
    await turnoMicrotareas(40);
    reloj.vencer();
    await turnoMicrotareas(40);
    expect(tts.frases[0]).toMatch(/permítame|segundito|Déjeme/);
    stt.eventos!.turnoFinal("no, mejor tres");
    lento.abrir();
    await prov.inactivo();
    const ultima = pet.at(-1)!;
    expect(JSON.stringify(ultima.mensajes)).not.toMatch(/permítame|segundito|Déjeme ver/);
  });

  it("sin dos niveles (por omision) un puerto CON ESTADO recibe UNA sola peticion por turno aunque tarde mas del plazo (nunca hay hedge)", async () => {
    const reloj = relojManual();
    const lento = compuerta();
    let llamadas = 0;
    const conEstado: PuertoLlmVoz = { completar: async (p) => (llamadas += 1, await lento.promesa, p.onTextDelta?.("Listo."), { texto: "Listo.", toolCalls: [], costoMicroUsd: 0 }) };
    const stt = new SttFalso();
    const tts = new TtsFalso();
    const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm: conEstado, stt, tts, temporizador: reloj });
    await prov.abrirSesion({ instruccion: "i", voiceId: "Kore", herramientas: [] }, manejadoresFalsos().h);
    stt.eventos!.turnoFinal("hola, quiero tres tacos");
    await turnoMicrotareas(40);
    expect(reloj.pendientes).toHaveLength(0); // ni siquiera se programa el plazo
    reloj.vencer();
    lento.abrir();
    await prov.inactivo();
    expect(llamadas).toBe(1);
    expect(tts.frases).toEqual(["Listo."]); // sin frase de espera
  });
});

describe("nivel del modelo por turno (rapido vs preciso)", () => {
  const F = LLM.dosNiveles.modeloRapido;
  const base = { modeloPorDefecto: LLM.modelo };
  it.each([
    [{ turno: 1, vuelta: 0, textoCliente: "(La llamada acaba de conectarse.)" }, F],
    [{ turno: 2, vuelta: 0, textoCliente: "Hola, buenas tardes" }, F],
    [{ turno: 3, vuelta: 0, textoCliente: "gracias" }, F],
    [{ turno: 2, vuelta: 0, textoCliente: "quiero tres panuchos" }, undefined],
    [{ turno: 2, vuelta: 1, textoCliente: "hola" }, undefined],
    [{ turno: 4, vuelta: 0, textoCliente: "ok", pedidoEnJuego: true }, undefined],
    [{ turno: 4, vuelta: 0, textoCliente: "si" }, undefined],
    [{ turno: 5, vuelta: 0, textoCliente: "eso es todo" }, undefined],
    [{ turno: 5, vuelta: 0, textoCliente: "nada mas" }, undefined],
  ])("%j -> %s", (c, esperado) => {
    expect(elegirNivelModelo({ ...base, ...c }, F)).toBe(esperado);
  });

  it("sin modeloRapido (por omision) todos los turnos van al modelo por omision, tambien la cortesia", async () => {
    const llm = llmFalso([escribe(["Claro."])]);
    const stt = new SttFalso();
    const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm, stt, tts: new TtsFalso() });
    await prov.abrirSesion({ instruccion: "i", voiceId: "Kore", herramientas: [] }, manejadoresFalsos().h);
    stt.eventos!.turnoFinal("hola, buenas tardes");
    await prov.inactivo();
    expect(llm.peticiones.map((p) => p.modeloPreferido)).toEqual([LLM.modelo]);
  });

  it("el modelo elegido en los ajustes del agente reemplaza al preciso; el rapido sigue siendo el de la plataforma", async () => {
    const llm = llmFalso([escribe(["Claro."])]);
    const stt = new SttFalso();
    const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm, stt, tts: new TtsFalso(), ...DOS_NIVELES, plazoLlm: false });
    await prov.abrirSesion({ instruccion: "i", voiceId: "Kore", herramientas: [], modeloLlm: "deepseek/deepseek-v4.1-flash" }, manejadoresFalsos().h);
    stt.eventos!.turnoFinal("quiero tres panuchos");
    await prov.inactivo();
    stt.eventos!.turnoFinal("gracias");
    await prov.inactivo();
    expect(llm.peticiones.map((p) => p.modeloPreferido)).toEqual(["deepseek/deepseek-v4.1-flash", F]);
  });
});

describe("pila por llaves", () => {
  const APERTURA = { instruccion: "i", voiceId: "Kore", herramientas: [] as never[] };
  it("sin ninguna llave de STT/TTS el escalon se salta", async () => {
    await expect(crearProveedorCascadaV2({ deepgramApiKey: null, elevenlabsApiKey: null, llm: llmFalso([]) }).abrirSesion(APERTURA, manejadoresFalsos().h)).rejects.toBeInstanceOf(VozNoConfiguradaError);
  });

  it("con ElevenLabs y Deepgram: abre Scribe con la llave en `xi-api-key`; si no confirma la sesion, cae a Deepgram (respaldo) y la llamada sigue", async () => {
    const f = fabricaSockets();
    const fetchFn = (async (url: string | URL | Request) => (new URL(String(url)).pathname.startsWith("/v1/voices/") ? new Response("{}") : new Response("", { status: 500 }))) as typeof fetch;
    const lineas: { evento: string; campos: Record<string, unknown> }[] = [];
    const prov = crearProveedorCascadaV2({ deepgramApiKey: "dg", elevenlabsApiKey: "el", llm: llmFalso([]), crearSocket: f.crear, fetchFn, log: (l) => void lineas.push({ evento: l.evento, campos: { ...l.campos } }) });
    const abriendo = prov.abrirSesion({ ...APERTURA, vozTelefono: "sDh3eviBhiuHKi0MjTNq", vocabulario: ["cochinita"] }, manejadoresFalsos().h);
    await turnoMicrotareas(40);
    const el = f.sockets.find((s) => new URL(s.url).host === "api.elevenlabs.io")!;
    expect(el.headers).toEqual({ "xi-api-key": "el" });
    el.texto({ message_type: "auth_error", error: "x" });
    await turnoMicrotareas(40);
    const dg = f.sockets.find((s) => new URL(s.url).host === "api.deepgram.com" && new URL(s.url).pathname === "/v1/listen");
    expect(dg).toBeDefined();
    dg!.abrir();
    await abriendo;
    expect(lineas.find((l) => l.evento === "v2_respaldo")?.campos).toMatchObject({ proveedor: "stt", motivo: "apertura" });
  });
});

describe("asentimientos mientras el agente piensa (tras la frase de espera)", () => {
  it.each([["si"], ["Sí."], ["ajá"], ["Está bien, gracias."], ["aquí espero"], ["ok"]])("%j es asentimiento", (t) => expect(esAsentimiento(t)).toBe(true));
  it.each([["no"], ["sí, pero sin cebolla"], ["tres tacos"], ["de"], [""], ["sí, es correcto, y agregue una coca"]])("%j NO es asentimiento", (t) => expect(esAsentimiento(t)).toBe(false));

  it("con la opcion encendida, un «si» del cliente mientras el LLM sigue pensando no corta el turno ni abre otro; algo con contenido si corta", async () => {
    const lento = compuerta();
    const llm = llmFalso([async (p) => (await lento.promesa, p.onTextDelta?.("Son 179 pesos."), { texto: "Son 179 pesos." }), escribe(["Claro, sin cebolla."])]);
    const stt = new SttFalso();
    const tts = new TtsFalso();
    const m = manejadoresFalsos();
    const lineas: string[] = [];
    const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm, stt, tts, ignorarAsentimientosOcupado: true, log: (l) => void lineas.push(l.evento) });
    await prov.abrirSesion({ instruccion: "i", voiceId: "Kore", herramientas: [] }, m.h);
    stt.eventos!.turnoFinal("cuanto es de tres tacos");
    await turnoMicrotareas(20);
    stt.eventos!.parcial("sí");
    stt.eventos!.turnoFinal("Sí.");
    await turnoMicrotareas(20);
    expect(llm.senales[0]!.aborted).toBe(false);
    expect(lineas).toContain("v2_asentimiento_ignorado");
    lento.abrir();
    await prov.inactivo();
    expect(tts.frases).toEqual(["Son 179 pesos."]);
    expect(llm.peticiones).toHaveLength(1);
  });

  it("apagada (por omision) un «si» mientras piensa corta el turno como siempre", async () => {
    const lento = compuerta();
    const llm = llmFalso([async (p) => (await lento.promesa, { texto: "" }), escribe(["Bien."])]);
    const stt = new SttFalso();
    const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm, stt, tts: new TtsFalso() });
    await prov.abrirSesion({ instruccion: "i", voiceId: "Kore", herramientas: [] }, manejadoresFalsos().h);
    stt.eventos!.turnoFinal("cuanto es de tres tacos");
    await turnoMicrotareas(20);
    stt.eventos!.parcial("sí");
    expect(llm.senales[0]!.aborted).toBe(true);
    lento.abrir();
    await prov.inactivo();
  });
});
