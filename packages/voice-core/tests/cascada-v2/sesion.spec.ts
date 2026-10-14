// Nucleo de la cascada v2 con puertos FALSOS (STT, LLM en streaming y TTS): turno completo, primer audio antes de que el LLM termine, barge-in, herramientas,
// caida de cada etapa y paso al siguiente escalon, y eventos de costo por componente. Sin red, sin llaves, reloj inyectado.
import { describe, expect, it, vi } from "vitest";
import { VOZ_PLATAFORMA, VozNoConfiguradaError, VozProveedorError, crearEscaleraLlamada, crearProveedorCascadaV2, eventosCostoLlamada } from "../../src/index.ts";
import type { AperturaLlamada, ManejadoresSesion } from "../../src/index.ts";
import { SttFalso, TtsFalso, audioDe, compuerta, escribe, llmFalso, manejadoresFalsos, turnoMicrotareas } from "./dobles.ts";
import type { GuionTts } from "./dobles.ts";

const APERTURA: AperturaLlamada = {
  instruccion: "Eres el agente de la taqueria.",
  voiceId: "Kore",
  herramientas: [{ name: "buscar_cliente", description: "Busca.", parameters: { type: "object", properties: {} } }],
  vocabulario: ["cochinita", "panuchos"],
};
const AHORA = () => 1_700_000_000_000;
const MODELO = VOZ_PLATAFORMA.cascadaV2.llm.modelo;

async function armar(llm: ReturnType<typeof llmFalso>, o: { ahora?: () => number; confirmacionAntesDeCrear?: { confirmar: string; crear: string }; tts?: TtsFalso; stt?: SttFalso; h?: Partial<ManejadoresSesion>; herramientasEnParalelo?: ReadonlySet<string>; elegirModelo?: (c: { turno: number; vuelta: number; modeloPorDefecto: string }) => string | undefined } = {}) {
  const stt = o.stt ?? new SttFalso();
  const tts = o.tts ?? new TtsFalso();
  const m = manejadoresFalsos(o.h);
  const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm, stt, tts, ahora: o.ahora ?? AHORA, ...(o.confirmacionAntesDeCrear ? { confirmacionAntesDeCrear: o.confirmacionAntesDeCrear } : {}), ...(o.herramientasEnParalelo ? { herramientasEnParalelo: o.herramientasEnParalelo } : {}), ...(o.elegirModelo ? { elegirModelo: o.elegirModelo } : {}) });
  const sesion = await prov.abrirSesion(APERTURA, m.h);
  return { stt, tts, sesion, prov, inactivo: () => prov.inactivo(), ...m };
}
const dice = (e: ReturnType<typeof manejadoresFalsos>["eventos"]) => e.filter((x) => x.startsWith("agente:")).map((x) => x.slice(7).trim());

describe("apertura", () => {
  it("sin DEEPGRAM_API_KEY el escalon se salta con VozNoConfiguradaError (nunca finge)", async () => {
    for (const llave of [null, "", "   "]) {
      const prov = crearProveedorCascadaV2({ deepgramApiKey: llave, llm: llmFalso([]) });
      await expect(prov.abrirSesion(APERTURA, manejadoresFalsos().h)).rejects.toBeInstanceOf(VozNoConfiguradaError);
    }
  });

  it("abre STT y TTS con los parametros de la plataforma: terminos del menu, 16 kHz de entrada, 24 kHz de salida y la voz mexicana por omision", async () => {
    const { stt, tts } = await armar(llmFalso([]));
    expect(stt.opciones).toEqual({ hzEntrada: 16_000, vocabulario: ["cochinita", "panuchos"] });
    expect(tts.opciones).toEqual({ voz: "aura-2-estrella-es", hzSalida: 24_000 });
  });

  it("la voz de la sucursal se usa solo si es una voz de Aura-2 en espanol", async () => {
    const tts = new TtsFalso();
    const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm: llmFalso([]), stt: new SttFalso(), tts });
    await prov.abrirSesion({ ...APERTURA, voiceId: "aura-2-olivia-es" }, manejadoresFalsos().h);
    expect(tts.opciones?.voz).toBe("aura-2-olivia-es");
  });

  it("si falla el STT o el TTS al abrir, cierra el otro y rechaza con error de proveedor (la escalera pasa al siguiente escalon)", async () => {
    const tts = new TtsFalso();
    await expect(crearProveedorCascadaV2({ deepgramApiKey: null, llm: llmFalso([]), stt: new SttFalso(true), tts }).abrirSesion(APERTURA, manejadoresFalsos().h)).rejects.toBeInstanceOf(VozProveedorError);
    expect(tts.cerrada).toBe(true);
    const stt = new SttFalso();
    await expect(crearProveedorCascadaV2({ deepgramApiKey: null, llm: llmFalso([]), stt, tts: new TtsFalso(undefined, true) }).abrirSesion(APERTURA, manejadoresFalsos().h)).rejects.toBeInstanceOf(VozProveedorError);
    expect(stt.cerrada).toBe(true);
  });
});

describe("turno completo", () => {
  it("fin de turno del STT -> LLM en streaming (sin temperature, con el modelo de la plataforma y esfuerzo bajo) -> TTS por frase -> audio y fin", async () => {
    const llm = llmFalso([escribe(["Claro, con gusto. ", "Le anoto dos tacos."], { costoMicroUsd: 1500, costoReal: true })]);
    const { stt, tts, eventos, audio, inactivo } = await armar(llm);
    stt.eventos!.turnoFinal("quiero dos tacos de cochinita");
    await inactivo();
    expect(eventos).toEqual(["cliente:quiero dos tacos de cochinita", "agente:Claro, con gusto. ", "agente:Le anoto dos tacos. ", "fin"]);
    expect(tts.frases).toEqual(["Claro, con gusto.", "Le anoto dos tacos."]);
    expect(audio.map((a) => [...a])).toEqual([[1, 0, 1, 0], [2, 0, 2, 0], [1, 0, 1, 0], [2, 0, 2, 0]]);
    const p = llm.peticiones[0]!;
    expect(p.system).toBe(APERTURA.instruccion);
    expect(p.mensajes).toEqual([{ role: "user", content: "quiero dos tacos de cochinita" }]);
    expect(p.modeloPreferido).toBe("anthropic/claude-sonnet-5.5");
    expect(p.esfuerzo).toBe("low");
    expect(p.temperatura).toBeUndefined();
    expect(typeof p.onTextDelta).toBe("function");
  });

  it("el saludo (enviarTexto) arranca el turno sin pasar por el STT ni contarlo como frase del cliente", async () => {
    const { sesion, eventos, stt, inactivo } = await armar(llmFalso([escribe(["Buenas tardes, bienvenido."])]));
    sesion.enviarTexto("(La llamada acaba de conectarse.)");
    await inactivo();
    expect(eventos).toEqual(["agente:Buenas tardes, bienvenido. ", "fin"]);
    expect(stt.audio).toEqual([]);
  });

  it("el audio del cliente va al STT tal cual y se ignora el vacio", async () => {
    const { sesion, stt } = await armar(llmFalso([]));
    sesion.enviarAudio!(Uint8Array.from([1, 0, 2, 0]));
    sesion.enviarAudio!(new Uint8Array(0));
    expect(stt.audio.map((a) => [...a])).toEqual([[1, 0, 2, 0]]);
  });

  it("una transcripcion vacia no abre turno", async () => {
    const llm = llmFalso([escribe(["x"])]);
    const { stt, inactivo } = await armar(llm);
    stt.eventos!.turnoFinal("   ");
    await inactivo();
    expect(llm.peticiones).toHaveLength(0);
  });

  it("el modelo de cada turno sale de la configuracion y del selector por turno (gancho para P3)", async () => {
    const vistos: { turno: number; vuelta: number; modeloPorDefecto: string }[] = [];
    const llm = llmFalso([escribe(["Listo, gracias por su llamada."]), escribe(["Con gusto, aqui estoy."])]);
    const { stt, inactivo } = await armar(llm, { elegirModelo: (c) => (vistos.push(c), c.turno === 2 ? VOZ_PLATAFORMA.cascadaV2.llm.modeloFacil : undefined) });
    stt.eventos!.turnoFinal("uno");
    await inactivo();
    stt.eventos!.turnoFinal("dos");
    await inactivo();
    expect(llm.peticiones.map((p) => p.modeloPreferido)).toEqual([MODELO, "anthropic/claude-haiku-5.5"]);
    expect(vistos).toEqual([{ turno: 1, vuelta: 0, modeloPorDefecto: MODELO }, { turno: 2, vuelta: 0, modeloPorDefecto: MODELO }]);
  });
});

describe("por frase: el primer audio sale antes de que el LLM termine de escribir", () => {
  it("la primera oracion llega al TTS y suena mientras el LLM sigue escribiendo", async () => {
    const compuertaLlm = compuerta();
    let llmTermino = false;
    const llm = llmFalso([
      async (_p, texto) => {
        texto("Claro, con gusto. ");
        await compuertaLlm.promesa; // el modelo sigue "pensando" la segunda frase
        texto("Le anoto dos tacos de cochinita.");
        llmTermino = true;
        return { texto: "Claro, con gusto. Le anoto dos tacos de cochinita." };
      },
    ]);
    const { stt, tts, audio, eventos, inactivo } = await armar(llm);
    stt.eventos!.turnoFinal("quiero dos tacos");
    await turnoMicrotareas(60);
    expect(llmTermino).toBe(false);
    expect(tts.frases).toEqual(["Claro, con gusto."]);
    expect(audio.length).toBeGreaterThan(0); // YA hay audio del agente
    expect(eventos).toContain("agente:Claro, con gusto. ");
    expect(eventos).not.toContain("fin");
    compuertaLlm.abrir();
    await inactivo();
    expect(tts.frases).toEqual(["Claro, con gusto.", "Le anoto dos tacos de cochinita."]);
    expect(eventos.at(-1)).toBe("fin");
  });

  it("registra (sin texto) el primer audio y el uso de tokens, incluida la lectura de cache del system prompt", async () => {
    const lineas: { evento: string; campos: Record<string, string | number | boolean> }[] = [];
    const llm = llmFalso([escribe(["Claro, con gusto."], { modelo: MODELO, tokensEntrada: 1200, tokensSalida: 20, tokensCache: 1100 })]);
    const stt = new SttFalso();
    const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm, stt, tts: new TtsFalso(), ahora: AHORA, log: (l) => lineas.push({ evento: l.evento, campos: { ...l.campos } }) });
    const m = manejadoresFalsos();
    await prov.abrirSesion(APERTURA, m.h);
    stt.eventos!.turnoFinal("hola");
    await prov.inactivo();
    const l = lineas.find((x) => x.evento === "v2_llm")!;
    expect(l.campos).toMatchObject({ proveedor: MODELO, tokensEntrada: 1200, tokensSalida: 20, tokensCache: 1100, ms: 0, ttftMs: 0 });
    expect(lineas.find((x) => x.evento === "v2_primer_audio")?.campos).toEqual({ ms: 0 });
    expect(JSON.stringify(lineas)).not.toContain("Claro");
  });
});

describe("barge-in", () => {
  /** TTS cuya primera frase entrega un trozo y luego espera (el audio "sigue sonando"). */
  function ttsLento() {
    const sigue = compuerta();
    let llamadas = 0;
    const guion: GuionTts = async function* (_frase, senal) {
      yield audioDe(1);
      if (++llamadas > 1) return; // solo la primera frase "sigue sonando"; las demas terminan de inmediato
      await Promise.race([sigue.promesa, new Promise<void>((r) => senal.addEventListener("abort", () => r(), { once: true }))]);
      if (senal.aborted) return;
      yield audioDe(2);
    };
    return { tts: new TtsFalso(guion), sigue };
  }

  it("si el STT detecta voz mientras el agente habla, cancela el LLM y el TTS en curso, avisa interrumpido y no sigue hablando", async () => {
    const { tts, sigue } = ttsLento();
    const llm = llmFalso([escribe(["Le confirmo dos tacos de cochinita. ", "Algo mas de beber?"]), escribe(["Perfecto, ahora que desea."])]);
    const { stt, eventos, audio, inactivo } = await armar(llm, { tts });
    stt.eventos!.turnoFinal("quiero dos tacos");
    await turnoMicrotareas(60);
    expect(audio).toHaveLength(1);
    stt.eventos!.hablaIniciada(); // un SpeechStarted aislado NO corta: se confirma con el primer parcial con texto
    expect(eventos).not.toContain("interrumpido");
    stt.eventos!.parcial("no espere");
    await inactivo();
    expect(tts.senales[0]!.aborted).toBe(true);
    expect(llm.senales[0]!.aborted).toBe(true);
    expect(eventos.filter((e) => e === "interrumpido")).toHaveLength(1);
    expect(eventos).not.toContain("fin");
    expect(tts.frases).toEqual(["Le confirmo dos tacos de cochinita."]); // la segunda frase nunca se mando al TTS
    sigue.abrir();
    await turnoMicrotareas();
    expect(audio).toHaveLength(1); // ni un trozo mas
  });

  it("el historial del siguiente turno refleja lo que el cliente SI oyo, no todo lo que el modelo escribio", async () => {
    const { tts } = ttsLento();
    const llm = llmFalso([escribe(["Le confirmo dos tacos de cochinita. ", "Algo mas de beber?"]), escribe(["Perfecto, que desea."])]);
    const { stt, inactivo } = await armar(llm, { tts });
    stt.eventos!.turnoFinal("quiero dos tacos");
    await turnoMicrotareas(60);
    stt.eventos!.parcial("mejor");
    stt.eventos!.turnoFinal("mejor tres");
    await inactivo();
    expect(llm.peticiones[1]!.mensajes).toEqual([
      { role: "user", content: "quiero dos tacos" },
      { role: "assistant", content: "Le confirmo dos tacos de cochinita." },
      { role: "user", content: "mejor tres" },
    ]);
  });

  it("un texto del cliente (interino) mientras el agente piensa tambien interrumpe; un SpeechStarted aislado mientras piensa no (un ruido no lo deja mudo)", async () => {
    const compuertaLlm = compuerta();
    const llm = llmFalso([async () => (await compuertaLlm.promesa, { texto: "nunca se dice" }), escribe(["Dime, te escucho con atencion."])]);
    const { stt, eventos, inactivo } = await armar(llm);
    stt.eventos!.turnoFinal("hola");
    await turnoMicrotareas(20);
    stt.eventos!.hablaIniciada(); // solo ruido: sin transcripcion
    expect(eventos).not.toContain("interrumpido");
    stt.eventos!.parcial("   ");
    expect(eventos).not.toContain("interrumpido");
    stt.eventos!.parcial("espera");
    expect(eventos).toContain("interrumpido");
    compuertaLlm.abrir();
    stt.eventos!.turnoFinal("espera un momento");
    await inactivo();
    expect(eventos.at(-1)).toBe("fin");
  });

  it("interrumpir() del controlador tambien corta el turno y no deja `interrumpido` repetido", async () => {
    const { tts } = ttsLento();
    const { stt, sesion, eventos, inactivo } = await armar(llmFalso([escribe(["Una frase larga para decir. ", "Y otra mas."])]), { tts });
    stt.eventos!.turnoFinal("hola");
    await turnoMicrotareas(60);
    sesion.interrumpir();
    sesion.interrumpir();
    await inactivo();
    expect(eventos.filter((e) => e === "interrumpido")).toHaveLength(1);
  });
});

describe("herramientas", () => {
  const pideTres = (p: { nombre: string }[]) => async (_p: unknown, texto: (d: string) => void) => {
    texto("Un momento, reviso. ");
    return { texto: "Un momento, reviso. ", toolCalls: p.map((x, i) => ({ id: `t${i}`, nombre: x.nombre, argsJson: "{\"q\":1}" })) };
  };

  it("corre las herramientas EN SERIE y en el orden pedido, y devuelve el resultado al modelo en la vuelta siguiente (que habla despues)", async () => {
    let activas = 0;
    let maxActivas = 0;
    const orden: string[] = [];
    const llm = llmFalso([pideTres([{ nombre: "cotizar" }, { nombre: "crear_pedido" }]), escribe(["Listo, su pedido quedo registrado."])]);
    const { stt, eventos, inactivo } = await armar(llm, {
      h: {
        ejecutarTool: async (l) => {
          activas++;
          maxActivas = Math.max(maxActivas, activas);
          orden.push(`inicia:${l.nombre}`);
          await turnoMicrotareas(10);
          orden.push(`termina:${l.nombre}`);
          activas--;
          return { ok: l.nombre, args: l.args };
        },
      },
    });
    stt.eventos!.turnoFinal("hazme el pedido");
    await inactivo();
    expect(maxActivas).toBe(1);
    expect(orden).toEqual(["inicia:cotizar", "termina:cotizar", "inicia:crear_pedido", "termina:crear_pedido"]);
    expect(dice(eventos)).toEqual(["Un momento, reviso.", "Listo, su pedido quedo registrado."]);
    expect(llm.peticiones[1]!.mensajes.slice(1)).toEqual([
      { role: "assistant", content: "Un momento, reviso. ", toolCalls: [{ id: "t0", nombre: "cotizar", argsJson: "{\"q\":1}" }, { id: "t1", nombre: "crear_pedido", argsJson: "{\"q\":1}" }] },
      { role: "tool", toolCallId: "t0", content: JSON.stringify({ ok: "cotizar", args: { q: 1 } }) },
      { role: "tool", toolCallId: "t1", content: JSON.stringify({ ok: "crear_pedido", args: { q: 1 } }) },
    ]);
  });

  it("solo la racha INICIAL de herramientas de solo lectura corre en paralelo; lo que sigue vuelve a la serie", async () => {
    let activas = 0;
    let maxActivas = 0;
    const llm = llmFalso([pideTres([{ nombre: "buscar_cliente" }, { nombre: "buscar_producto" }, { nombre: "crear_pedido" }, { nombre: "buscar_cliente" }]), escribe(["Listo."])]);
    const { stt, herramientas, inactivo } = await armar(llm, {
      herramientasEnParalelo: new Set(["buscar_cliente", "buscar_producto"]),
      h: {
        ejecutarTool: async () => {
          activas++;
          maxActivas = Math.max(maxActivas, activas);
          await turnoMicrotareas(10);
          activas--;
          return {};
        },
      },
    });
    void herramientas;
    stt.eventos!.turnoFinal("pedido");
    await inactivo();
    expect(maxActivas).toBe(2);
  });

  it("una herramienta que lanza se informa al modelo como error y el turno sigue; argumentos ilegibles llegan como objeto vacio", async () => {
    const recibidos: unknown[] = [];
    const llm = llmFalso([
      async () => ({ texto: "", toolCalls: [{ id: "a", nombre: "falla", argsJson: "{no es json" }] }),
      escribe(["Disculpe, tuve un problema."]),
    ]);
    const { stt, inactivo } = await armar(llm, {
      h: {
        ejecutarTool: async (l) => {
          recibidos.push(l.args);
          throw new Error("detalle interno con telefono 9991234567");
        },
      },
    });
    stt.eventos!.turnoFinal("hola");
    await inactivo();
    expect(recibidos).toEqual([{}]);
    const tool = llm.peticiones[1]!.mensajes.find((m) => m.role === "tool");
    expect(tool).toEqual({ role: "tool", toolCallId: "a", content: JSON.stringify({ error: "herramienta_fallo" }) });
    expect(JSON.stringify(llm.peticiones)).not.toContain("9991234567");
  });

  it("el tope de vueltas modelo -> herramienta evita un bucle infinito", async () => {
    const llm = llmFalso([async () => ({ texto: "", toolCalls: [{ id: "x", nombre: "buscar_cliente", argsJson: "{}" }] })]);
    const { stt, eventos, inactivo } = await armar(llm);
    stt.eventos!.turnoFinal("hola");
    await inactivo();
    expect(llm.peticiones).toHaveLength(5); // 1 + vueltasToolMax (4)
    expect(eventos.at(-1)).toBe("fin");
  });
});

describe("caida de cada etapa", () => {
  
  it("STT: una caida despues de abrir sube `v2_stt_ws_1006`, cierra los sockets (el STT factura por segundo) y deja de atender", async () => {
    const llm = llmFalso([escribe(["x"])]);
    const { stt, tts, sesion, eventos, inactivo } = await armar(llm);
    stt.eventos!.caido("stt_ws_1006");
    await turnoMicrotareas();
    expect(eventos).toEqual(["caido:v2_stt_ws_1006"]);
    expect(stt.cerrada).toBe(true);
    expect(tts.cerrada).toBe(true);
    stt.eventos!.turnoFinal("hola");
    sesion.enviarTexto("hola");
    await inactivo();
    expect(llm.peticiones).toHaveLength(0);
  });

  it("LLM: un error con estado HTTP sube `v2_llm_429`; sin estado, `v2_llm`; el mensaje del proveedor (que puede traer datos) nunca sale", async () => {
    for (const [error, esperado] of [[Object.assign(new Error("rate limit para +52 999 123 4567"), { status: 429 }), "v2_llm_429"], [new Error("boom con direccion calle 60 #123"), "v2_llm"]] as const) {
      const { stt, eventos, inactivo } = await armar(llmFalso([async () => { throw error; }]));
      stt.eventos!.turnoFinal("hola");
      await inactivo();
      expect(eventos.filter((e) => e.startsWith("caido:"))).toEqual([`caido:${esperado}`]);
      expect(eventos.join("|")).not.toMatch(/999|calle 60/);
    }
  });

  it("LLM sin endpoint de retencion cero: un 404 de OpenRouter sube `v2_llm_sin_zdr` (falla claro; la escalera pasa al siguiente escalon)", async () => {
    const { stt, eventos, inactivo } = await armar(llmFalso([async () => { throw Object.assign(new Error("No endpoints found"), { status: 404 }); }]));
    stt.eventos!.turnoFinal("hola");
    await inactivo();
    expect(eventos.filter((e) => e.startsWith("caido:"))).toEqual(["caido:v2_llm_sin_zdr"]);
  });

  it("TTS: un fallo del sintetizador sube `v2_tts_ws_1006`, detiene al LLM y no registra el turno como terminado", async () => {
    const tts = new TtsFalso(async function* () {
      yield audioDe(1);
      throw new Error("tts_ws_1006");
    });
    const llm = llmFalso([escribe(["Claro, con gusto. ", "Le anoto el pedido."])]);
    const { stt, eventos, inactivo } = await armar(llm, { tts });
    stt.eventos!.turnoFinal("hola");
    await inactivo();
    expect(eventos.filter((e) => e.startsWith("caido:"))).toEqual(["caido:v2_tts_ws_1006"]);
    expect(eventos).not.toContain("fin");
  });

  it("un fallo del TTS sin codigo reconocible (p. ej. con datos en el mensaje) sube solo `v2_tts`", async () => {
    const tts = new TtsFalso(async function* (): AsyncGenerator<Uint8Array> {
      yield* [];
      throw new Error("fallo con el nombre Juan Perez");
    });
    const { stt, eventos, inactivo } = await armar(llmFalso([escribe(["Claro, con gusto."])]), { tts });
    stt.eventos!.turnoFinal("hola");
    await inactivo();
    expect(eventos.filter((e) => e.startsWith("caido:"))).toEqual(["caido:v2_tts"]);
  });

  it("la escalera pasa al siguiente escalon: si la cascada v2 se cae a media llamada, el respaldo recibe el resumen REDACTADO de lo ya dicho", async () => {
    const respaldo: string[] = [];
    const stt = new SttFalso();
    const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm: llmFalso([escribe(["Buenas tardes, bienvenido a la taqueria."])]), stt, tts: new TtsFalso() });
    const escalera = crearEscaleraLlamada([
      { id: "cascada-v2", abrirSesion: prov.abrirSesion },
      { id: "cascada-openrouter", abrirSesion: async (a) => (respaldo.push(a.instruccion), { enviarTexto: () => undefined, interrumpir: () => undefined, cerrar: async () => undefined }) },
    ]);
    const m = manejadoresFalsos();
    const s = await escalera.abrirSesion(APERTURA, m.h);
    expect(escalera.escalonActual()).toBe("cascada-v2");
    s.enviarTexto("saludo");
    await prov.inactivo();
    stt.eventos!.turnoFinal("mi tarjeta es 4111 1111 1111 1111");
    await prov.inactivo();
    stt.eventos!.caido("stt_ws_1011");
    await turnoMicrotareas();
    expect(escalera.fallidos()).toEqual(["cascada-v2"]);
    expect(m.eventos).toContain("caido:v2_stt_ws_1011");
    // El controlador reabre la sesion tras la caida: la escalera va al siguiente escalon, sin reintentar el que fallo.
    await escalera.abrirSesion(APERTURA, m.h);
    expect(escalera.escalonActual()).toBe("cascada-openrouter");
    expect(respaldo[0]).toContain("Lo dicho hasta ahora");
    expect(respaldo[0]).toContain("Buenas tardes, bienvenido a la taqueria.");
    expect(respaldo[0]).toContain("[TARJETA REDACTADA]");
    expect(respaldo[0]).not.toContain("4111");
  });

  it("si la cascada v2 no logra abrir (STT o TTS), la escalera abre el siguiente escalon desde el saludo", async () => {
    const respaldo: string[] = [];
    const escalera = crearEscaleraLlamada([
      { id: "cascada-v2", abrirSesion: crearProveedorCascadaV2({ deepgramApiKey: null, llm: llmFalso([]), stt: new SttFalso(true), tts: new TtsFalso() }).abrirSesion },
      { id: "cascada-openrouter", abrirSesion: async (a) => (respaldo.push(a.instruccion), { enviarTexto: () => undefined, interrumpir: () => undefined, cerrar: async () => undefined }) },
    ]);
    await escalera.abrirSesion(APERTURA, manejadoresFalsos().h);
    expect(respaldo).toEqual([APERTURA.instruccion]);
    expect(escalera.fallidos()).toEqual(["cascada-v2"]);
  });

  it("sin llave de Deepgram (ni puertos), la escalera salta la cascada v2 y abre el siguiente escalon", async () => {
    const respaldo: string[] = [];
    const escalera = crearEscaleraLlamada([
      { id: "cascada-v2", abrirSesion: crearProveedorCascadaV2({ deepgramApiKey: null, llm: llmFalso([]) }).abrirSesion },
      { id: "cascada-openrouter", abrirSesion: async () => (respaldo.push("abrio"), { enviarTexto: () => undefined, interrumpir: () => undefined, cerrar: async () => undefined }) },
    ]);
    await escalera.abrirSesion(APERTURA, manejadoresFalsos().h);
    expect(respaldo).toEqual(["abrio"]);
    expect(escalera.fallidos()).toEqual(["cascada-v2"]);
    expect(escalera.escalonActual()).toBe("cascada-openrouter");
  });
});

describe("costo por componente", () => {
  it("emite deepgram (segundos de audio), deepgram-aura-2 (caracteres) y openrouter:<modelo> (costo real), y los eventos de la llamada los desglosan", async () => {
    const stt = new SttFalso();
    const llm = llmFalso([escribe(["Claro, con gusto."], { costoMicroUsd: 2500, costoReal: true })]);
    const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm, stt, tts: new TtsFalso(), ahora: AHORA });
    const escalera = crearEscaleraLlamada([{ id: "cascada-v2", abrirSesion: prov.abrirSesion }], { ahora: AHORA });
    const m = manejadoresFalsos();
    const sesion = await escalera.abrirSesion(APERTURA, m.h);
    sesion.enviarAudio!(new Uint8Array(16_000 * 2)); // 1 s de audio PCM16 a 16 kHz
    stt.eventos!.turnoFinal("hola buenas");
    await prov.inactivo();
    await turnoMicrotareas(60);
    const porProveedor = Object.fromEntries(m.costos.map((c) => [c.proveedor, c]));
    expect(porProveedor["deepgram"]).toEqual({ micro: 102, real: false, proveedor: "deepgram", unidad: "segundo", cantidad: 1 }); // 1 s x (US$0.0048 + US$0.0013 de keyterms)/min: la apertura trae vocabulario
    expect(porProveedor["deepgram-aura-2"]).toEqual({ micro: 510, real: false, proveedor: "deepgram-aura-2", unidad: "unidad", cantidad: 17 }); // 17 caracteres x US$0.030 / 1 000
    expect(porProveedor[`openrouter:${MODELO}`]).toEqual({ micro: 2500, real: true, proveedor: `openrouter:${MODELO}`, unidad: "unidad", cantidad: 1 });
    const eventos = eventosCostoLlamada({ vertical: "restaurantes", llamadaId: "llamada-1", organizationId: "o", propertyId: "p", ocurridoEn: "2026-10-13T12:00:00.000Z", tramos: escalera.tramos() });
    const evento = Object.fromEntries(eventos.map((e) => [e.proveedor, e]));
    expect(evento["deepgram"]).toMatchObject({ costoMicroUsd: 102, costoEstimado: true, unidad: "segundo", cantidad: 1 });
    expect(evento["deepgram-aura-2"]).toMatchObject({ costoMicroUsd: 510, costoEstimado: true, unidad: "unidad", cantidad: 17 });
    expect(evento[`openrouter:${MODELO}`]).toMatchObject({ costoMicroUsd: 2500, costoEstimado: false, unidad: "unidad", cantidad: 1 });
  });

  it("al cerrar, el audio que quedo sin reportar tambien se cobra (nada de segundos perdidos)", async () => {
    const m = manejadoresFalsos();
    const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm: llmFalso([]), stt: new SttFalso(), tts: new TtsFalso() });
    const sesion = await prov.abrirSesion(APERTURA, m.h);
    sesion.enviarAudio!(new Uint8Array(16_000 * 2 * 3));
    await sesion.cerrar();
    expect(m.costos).toEqual([{ micro: 305, real: false, proveedor: "deepgram", unidad: "segundo", cantidad: 3 }]); // con keyterms: 3 s x US$0.0061/min
  });

  it("sin vocabulario no hay keyterms y no se cobra el add-on: 3 s x US$0.0048/min", async () => {
    const m = manejadoresFalsos();
    const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm: llmFalso([]), stt: new SttFalso(), tts: new TtsFalso() });
    const sesion = await prov.abrirSesion({ ...APERTURA, vocabulario: [] }, m.h);
    sesion.enviarAudio!(new Uint8Array(16_000 * 2 * 3));
    await sesion.cerrar();
    expect(m.costos).toEqual([{ micro: 240, real: false, proveedor: "deepgram", unidad: "segundo", cantidad: 3 }]);
  });
});

describe("lo que el cliente oyo, cola del puente y reproduccion estimada", () => {
  /** 1 s de audio PCM16 a 24 kHz con voz por cada frase sintetizada. */
  const unSegundo = (): GuionTts =>
    async function* () {
      const b = new Uint8Array(24_000 * 2);
      new DataView(b.buffer).setInt16(0, 8000, true);
      yield b;
    };

  it("un barge-in DESPUES de que el TTS termino de generar pero con la cola del puente aun sonando corta la cola (interrumpido) y deja en el historial solo lo que sono", async () => {
    let t = 1_000_000;
    const llm = llmFalso([escribe(["Primera frase del agente. ", "Segunda frase del agente."])]);
    const { stt, eventos, inactivo } = await armar(llm, { tts: new TtsFalso(unSegundo()), ahora: () => t });
    stt.eventos!.turnoFinal("hola");
    await inactivo();
    expect(eventos.at(-1)).toBe("fin"); // el turno ya termino: todo el audio esta generado (2 s) y encolado en el puente
    t += 500; // el cliente habla a los 0.5 s: solo sono la primera frase
    stt.eventos!.parcial("espera");
    expect(eventos.filter((e) => e === "interrumpido")).toHaveLength(1);
  });

  it("el historial conserva solo las frases que ya sonaban al interrumpir (no las que el TTS genero de mas) y no corta si el audio ya acabo de sonar", async () => {
    let t = 1_000_000;
    const llm = llmFalso([escribe(["Primera frase del agente. ", "Segunda frase del agente."]), escribe(["Entendido, dime."])]);
    const { stt, eventos, inactivo } = await armar(llm, { tts: new TtsFalso(unSegundo()), ahora: () => t });
    stt.eventos!.turnoFinal("hola");
    await inactivo();
    t += 500;
    stt.eventos!.parcial("espera");
    stt.eventos!.turnoFinal("quiero otra cosa");
    await inactivo();
    expect(llm.peticiones[1]!.mensajes).toEqual([
      { role: "user", content: "hola" },
      { role: "assistant", content: "Primera frase del agente." },
      { role: "user", content: "quiero otra cosa" },
    ]);
    // Pasados los 2 s el audio ya termino de sonar: un parcial NO interrumpe nada.
    t += 10_000;
    const antes = eventos.filter((e) => e === "interrumpido").length;
    stt.eventos!.parcial("hola otra vez");
    expect(eventos.filter((e) => e === "interrumpido").length).toBe(antes);
  });

  it("si interrumpe en la segunda vuelta de herramientas, el historial NO duplica el texto de la primera vuelta", async () => {
    const sigue = compuerta();
    let n = 0;
    const tts = new TtsFalso(async function* (_f, senal) {
      yield audioDe(1);
      if (++n === 2) await Promise.race([sigue.promesa, new Promise<void>((r) => senal.addEventListener("abort", () => r(), { once: true }))]);
    });
    const llm = llmFalso([
      async (_p, texto) => {
        texto("Un momento, reviso. ");
        return { texto: "Un momento, reviso. ", toolCalls: [{ id: "t0", nombre: "buscar_cliente", argsJson: "{}" }] };
      },
      escribe(["Ya lo encontre, es su cuenta frecuente. ", "Desea lo de siempre?"]),
      escribe(["Entendido."]),
    ]);
    let t = 1_000_000;
    const { stt, inactivo } = await armar(llm, { tts, ahora: () => t });
    stt.eventos!.turnoFinal("hola");
    await vi.waitFor(() => expect(tts.frases.length).toBeGreaterThanOrEqual(2)); // la 2a vuelta ya esta hablando (su audio sigue sonando)
    t += 1_000; // ya sono la 2a vuelta (el audio de la 1a dura apenas unos microsegundos)
    stt.eventos!.parcial("no, espera");
    stt.eventos!.turnoFinal("no, espera");
    await inactivo();
    const hist = llm.peticiones[2]!.mensajes;
    expect(hist.filter((m) => m.role === "assistant" && m.content.includes("Un momento, reviso."))).toHaveLength(1);
    expect(hist.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    expect((hist[3] as { content: string }).content).toBe("Ya lo encontre, es su cuenta frecuente.");
  });
});

describe("respuesta vacia (el razonamiento agoto el tope: finish_reason length)", () => {
  const vacia = async () => ({ texto: "", finishReason: "length" });

  it("reintenta UNA vez y habla la respuesta del reintento", async () => {
    const llm = llmFalso([vacia, escribe(["Claro, digame que desea."])]);
    const { stt, eventos, inactivo } = await armar(llm);
    stt.eventos!.turnoFinal("hola");
    await inactivo();
    expect(llm.peticiones).toHaveLength(2);
    expect(dice(eventos)).toEqual(["Claro, digame que desea."]);
    expect(eventos.at(-1)).toBe("fin");
    // La respuesta vacia no queda en el historial.
    expect(llm.peticiones[1]!.mensajes).toEqual([{ role: "user", content: "hola" }]);
  });

  it("si vuelve vacia dice la frase de respaldo en lugar de quedarse en silencio, y la registra en el historial", async () => {
    const llm = llmFalso([vacia, vacia, escribe(["Si, digame."])]);
    const { stt, tts, eventos, inactivo } = await armar(llm);
    stt.eventos!.turnoFinal("hola");
    await inactivo();
    expect(llm.peticiones).toHaveLength(2);
    expect(tts.frases).toEqual([VOZ_PLATAFORMA.cascadaV2.llm.fraseRespaldo]);
    expect(eventos.at(-1)).toBe("fin");
    stt.eventos!.turnoFinal("si, un taco");
    await inactivo();
    expect(llm.peticiones[2]!.mensajes[1]).toEqual({ role: "assistant", content: VOZ_PLATAFORMA.cascadaV2.llm.fraseRespaldo });
  });

  it("el costo de cada intento se registra (aunque la respuesta venga vacia)", async () => {
    const llm = llmFalso([async () => ({ texto: "", finishReason: "length", costoMicroUsd: 900, costoReal: true }), escribe(["Hola, digame."], { costoMicroUsd: 400, costoReal: true })]);
    const { stt, costos, inactivo } = await armar(llm);
    stt.eventos!.turnoFinal("hola");
    await inactivo();
    expect(costos.filter((c) => c.proveedor?.startsWith("openrouter:")).map((c) => c.micro)).toEqual([900, 400]);
  });
});

describe("herramientas e interrupciones", () => {
  const dos = async (_p: unknown, texto: (d: string) => void) => {
    texto("Le leo el resumen. ");
    return {
      texto: "Le leo el resumen. ",
      toolCalls: [
        { id: "c", nombre: "confirmar_resumen", argsJson: "{}" },
        { id: "p", nombre: "crear_pedido", argsJson: "{}" },
      ],
    };
  };

  it("si el modelo pide confirmar_resumen y crear_pedido en la MISMA respuesta, solo corre el primero y el segundo espera la confirmacion del cliente", async () => {
    const llm = llmFalso([dos, escribe(["Son 328 pesos, le parece bien?"])]);
    const { stt, herramientas, inactivo } = await armar(llm, { confirmacionAntesDeCrear: { confirmar: "confirmar_resumen", crear: "crear_pedido" } });
    stt.eventos!.turnoFinal("quiero el pedido");
    await inactivo();
    expect(herramientas).toEqual(["confirmar_resumen"]);
    const tool = llm.peticiones[1]!.mensajes.filter((m) => m.role === "tool");
    expect(tool.map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(["c", "p"]);
    expect(JSON.parse((tool[1] as { content: string }).content)).toMatchObject({ error: "espera_confirmacion_del_cliente" });
  });

  it("sin la regla configurada se conserva el comportamiento de siempre (ambas corren en serie)", async () => {
    const llm = llmFalso([dos, escribe(["Listo."])]);
    const { stt, herramientas, inactivo } = await armar(llm);
    stt.eventos!.turnoFinal("quiero el pedido");
    await inactivo();
    expect(herramientas).toEqual(["confirmar_resumen", "crear_pedido"]);
  });

  it("si el cliente interrumpe («no, espere») a media confirmar_resumen, crear_pedido NO corre y el historial queda consistente", async () => {
    const llm = llmFalso([dos, escribe(["Entendido, dime."])]);
    const { stt, herramientas, inactivo } = await armar(llm, {
      h: {
        ejecutarTool: async (l) => {
          herramientas.push(l.nombre);
          if (l.nombre === "confirmar_resumen") stt.eventos!.parcial("no, espere"); // el cliente habla mientras corre la confirmacion
          return { ok: true };
        },
      },
    });
    stt.eventos!.turnoFinal("quiero el pedido");
    await inactivo();
    expect(herramientas).toEqual(["confirmar_resumen"]);
    stt.eventos!.turnoFinal("no, espere, quiero cambiar algo");
    await inactivo();
    const tool = llm.peticiones[1]!.mensajes.filter((m) => m.role === "tool") as { toolCallId: string; content: string }[];
    expect(tool.map((m) => m.toolCallId)).toEqual(["c", "p"]);
    expect(JSON.parse(tool[1]!.content)).toMatchObject({ error: "interrumpido_por_el_cliente" });
  });
});

describe("costo del LLM", () => {
  it("el costo de una respuesta que termina DESPUES de que el cliente interrumpio igual se registra", async () => {
    const compuertaLlm = compuerta();
    const llm = llmFalso([async () => (await compuertaLlm.promesa, { texto: "nunca se dice", costoMicroUsd: 700, costoReal: true })]);
    const { stt, costos, inactivo } = await armar(llm);
    stt.eventos!.turnoFinal("hola");
    await vi.waitFor(() => expect(llm.peticiones).toHaveLength(1));
    stt.eventos!.parcial("espera"); // el cliente interrumpe mientras el LLM sigue
    compuertaLlm.abrir();
    await inactivo();
    expect(costos.filter((c) => c.proveedor?.startsWith("openrouter:"))).toEqual([{ micro: 700, real: true, proveedor: `openrouter:${MODELO}`, unidad: "unidad", cantidad: 1 }]);
  });

  it("solo es REAL si el proveedor lo reporto: sin costoReal el evento sale estimado", async () => {
    const llm = llmFalso([escribe(["Hola, digame."], { costoMicroUsd: 321 })]);
    const { stt, costos, inactivo } = await armar(llm);
    stt.eventos!.turnoFinal("hola");
    await inactivo();
    expect(costos.find((c) => c.proveedor?.startsWith("openrouter:"))).toMatchObject({ micro: 321, real: false });
  });
});

describe("agrupar frases para no agotar el limite de Flush", () => {
  const tresFrases = escribe(["Primera frase del agente. ", "Segunda frase del agente. ", "Tercera frase del agente."]);

  it("la primera frase sale sola (menor latencia) y las siguientes van juntas en UNA sintesis", async () => {
    const { stt, tts, inactivo } = await armar(llmFalso([tresFrases]));
    stt.eventos!.turnoFinal("hola");
    await inactivo();
    expect(tts.frases).toEqual(["Primera frase del agente.", "Segunda frase del agente. Tercera frase del agente."]);
  });

  it("con pocos Flush disponibles TODO el turno va junto (degrada la latencia, no cae el escalon)", async () => {
    const tts = new TtsFalso();
    tts.flushes = 2;
    const { stt, eventos, inactivo } = await armar(llmFalso([tresFrases]), { tts });
    stt.eventos!.turnoFinal("hola");
    await inactivo();
    expect(tts.frases).toEqual(["Primera frase del agente. Segunda frase del agente. Tercera frase del agente."]);
    expect(eventos.filter((e) => e.startsWith("caido:"))).toEqual([]);
    expect(eventos.at(-1)).toBe("fin");
  });

  it("el costo de TTS cuenta los caracteres de cada sintesis, juntas o no", async () => {
    const { stt, costos, inactivo } = await armar(llmFalso([tresFrases]));
    stt.eventos!.turnoFinal("hola");
    await inactivo();
    const aura = costos.filter((c) => c.proveedor === "deepgram-aura-2").map((c) => c.cantidad);
    expect(aura).toEqual(["Primera frase del agente.".length, "Segunda frase del agente. Tercera frase del agente.".length]);
  });
});

describe("colgar / cerrar con audio en cola", () => {
  it("cerrar() a media sintesis aborta el LLM y el TTS, cierra STT y TTS y no deja promesas colgadas", async () => {
    const sigue = compuerta();
    const tts = new TtsFalso(async function* (_f, senal) {
      yield audioDe(1);
      await Promise.race([sigue.promesa, new Promise<void>((r) => senal.addEventListener("abort", () => r(), { once: true }))]);
    });
    const { stt, sesion, inactivo } = await armar(llmFalso([escribe(["Una frase larga del agente. ", "Y otra mas del agente."])]), { tts });
    stt.eventos!.turnoFinal("hola");
    await turnoMicrotareas(60);
    await sesion.cerrar();
    await inactivo(); // si quedara una promesa colgada, esto nunca resolveria
    expect(tts.senales[0]!.aborted).toBe(true);
    expect(stt.cerrada).toBe(true);
    expect(tts.cerrada).toBe(true);
  });
});

describe("TTS sin respuesta", () => {
  it("un tts_timeout del adaptador sube `v2_tts_timeout` y la escalera pasa al siguiente escalon", async () => {
    const tts = new TtsFalso(async function* (): AsyncGenerator<Uint8Array> {
      yield* [];
      throw new Error("tts_timeout");
    });
    const { stt, eventos, inactivo } = await armar(llmFalso([escribe(["Claro, con gusto."])]), { tts });
    stt.eventos!.turnoFinal("hola");
    await inactivo();
    expect(eventos.filter((e) => e.startsWith("caido:"))).toEqual(["caido:v2_tts_timeout"]);
  });
});
