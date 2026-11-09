// Acuse rapido (latencia, ronda 2): en un turno que va al modelo PRECISO (Luna tarda ~3 s y casi siempre empieza con herramientas, sin texto) suena un acuse corto
// mientras el preciso piensa. Revision #752 (P1-2, P2-1, P2-2): el acuse NO lo escribe un modelo (flash-lite decia «Sí, no lleva cacahuate.», «Entendido, cancelo su
// pedido.», «Sí, tenemos pastor.»): sale de una lista FIJA de acuses neutros, elegido de forma determinista; nunca en un turno de riesgo (alergia, cancelacion,
// pago, pedir una persona, precio o existencia); como mucho UN relleno por turno (acuse o frase de espera) y solo dentro de su plazo; si la guardia determinista
// del controlador actua sobre ese turno, el acuse no suena. No entra al historial del modelo.
import { describe, expect, it } from "vitest";
import { ACUSES_NEUTROS, ACUSE_ESPERA_MS, VOZ_PLATAFORMA, crearProveedorCascadaV2, esTurnoDeRiesgoVoz } from "../../src/index.ts";
import type { PeticionLlmVoz, PuertoLlmVoz, RespuestaLlmVoz, VozSesionLlamada } from "../../src/index.ts";
import { SttFalso, TtsFalso, compuerta, manejadoresFalsos, turnoMicrotareas } from "./dobles.ts";

const LLM = VOZ_PLATAFORMA.cascadaV2.llm;
const D = LLM.dosNiveles;
const ES_ESPERA = (f: string) => (LLM.frasesEspera as readonly string[]).includes(f);
const ES_ACUSE = (f: string) => (ACUSES_NEUTROS as readonly string[]).includes(f);

function relojConTiempo() {
  let ahora = 0;
  const pendientes: { fn: () => void; vence: number; vivo: boolean }[] = [];
  return {
    poner: (fn: () => void, ms: number): unknown => (pendientes.push({ fn, vence: ahora + ms, vivo: true }), pendientes.length - 1),
    quitar: (id: unknown): void => {
      const p = pendientes[id as number];
      if (p) p.vivo = false;
    },
    avanzar: (ms: number): void => {
      ahora += ms;
      for (const p of pendientes) {
        if (p.vivo && p.vence <= ahora) {
          p.vivo = false;
          p.fn();
        }
      }
    },
    ahora: () => ahora,
  };
}

function llmLento() {
  const peticiones: PeticionLlmVoz[] = [];
  const turnos: { abrir: () => void }[] = [];
  const llm: PuertoLlmVoz = {
    completar: async (p): Promise<RespuestaLlmVoz> => {
      peticiones.push({ ...p, mensajes: [...p.mensajes] });
      const c = compuerta();
      turnos.push(c);
      await c.promesa;
      p.onTextDelta?.("Son ciento setenta y nueve pesos.");
      return { texto: "Son ciento setenta y nueve pesos.", toolCalls: [], costoMicroUsd: 1 };
    },
  };
  return { llm, peticiones, abrirTodo: () => turnos.splice(0).forEach((t) => t.abrir()) };
}

async function abrir(o: { plazo?: boolean; omitirAcuse?: (t: string) => boolean } = {}) {
  const reloj = relojConTiempo();
  const { llm, peticiones, abrirTodo } = llmLento();
  const stt = new SttFalso();
  const tts = new TtsFalso();
  const prov = crearProveedorCascadaV2({
    deepgramApiKey: null,
    llm,
    stt,
    tts,
    temporizador: reloj,
    modeloLlm: D.modelo,
    modeloRapido: D.modeloRapido,
    acuseRapido: true,
    ...(o.plazo ? { plazoLlm: { plazoMs: D.plazoPrimerTokenMs, modeloRespaldo: null } } : {}),
    ...(o.omitirAcuse ? { omitirAcuse: o.omitirAcuse } : {}),
  });
  const sesion = (await prov.abrirSesion({ instruccion: "i", voiceId: "Kore", herramientas: [] }, manejadoresFalsos().h)) as VozSesionLlamada & { silenciarTurnoPendiente?: () => void };
  const decir = async (texto: string, ms = ACUSE_ESPERA_MS) => {
    stt.eventos!.turnoFinal(texto);
    await turnoMicrotareas(40);
    reloj.avanzar(ms);
    await turnoMicrotareas(40);
  };
  const terminar = async () => {
    abrirTodo();
    await prov.inactivo();
  };
  return { reloj, stt, tts, prov, sesion, peticiones, decir, terminar };
}

describe("acuse rapido: lista fija y neutra, sin modelo", () => {
  it("la lista fija no afirma nada: sin cifras, sin preguntas, sin hechos del pedido, del menu ni de la cuenta", () => {
    expect(ACUSES_NEUTROS.length).toBeGreaterThanOrEqual(3);
    for (const a of ACUSES_NEUTROS) {
      expect(a.split(/\s+/).length).toBeLessThanOrEqual(4);
      expect(a).not.toMatch(/[0-9?¿$]/);
      expect(a.toLowerCase()).not.toMatch(/\b(no|sin|si|sí|tenemos|hay|lleva|cancel\w*|paso|persona|alerg\w*|registr\w*|confirm\w*|queda\w*|listo|pesos|total|pastor|taco\w*)\b/);
    }
  });

  // E2E r2 (7-nov-2026): tras un «Claro.» suelto el agente callaba 2-3 s mientras el preciso pensaba y el cliente lo tomaba como fin de turno: hablaba encima y
  // cortaba la respuesta. Cada acuse debe sonar a «espere» (un momento, déjeme ver, lo reviso), nunca a respuesta terminada.
  it("cada acuse pide esperar: ninguno es un «Claro.» o «Entendido.» suelto", () => {
    for (const a of ACUSES_NEUTROS) expect(a.toLowerCase()).toMatch(/\b(momento|d[eé]jeme|lo reviso|perm[ií]tame|reviso)\b/);
  });

  it("en un turno lento del preciso suena un acuse de la lista, ANTES de la respuesta, sin pedirselo a ningun modelo y sin entrar al historial", async () => {
    const t = await abrir();
    await t.decir("quiero tres tacos de pastor y una coca para recoger");
    expect(t.tts.frases).toHaveLength(1);
    expect(ES_ACUSE(t.tts.frases[0]!)).toBe(true);
    await t.terminar();
    expect(t.tts.frases.join(" ")).toContain("Son ciento setenta y nueve pesos.");
    expect(t.peticiones.every((p) => !p.system.includes("ACUSE") && p.modeloPreferido !== D.modeloRapido)).toBe(true);
    await t.decir("y otra coca");
    const ultima = t.peticiones.at(-1)!;
    for (const a of ACUSES_NEUTROS) expect(JSON.stringify(ultima.mensajes)).not.toContain(a);
    await t.terminar();
  });

  it("es determinista: la misma llamada con los mismos turnos dice los mismos acuses", async () => {
    const correr = async () => {
      const t = await abrir();
      await t.decir("quiero tres tacos de pastor");
      await t.terminar();
      await t.decir("y dos de suadero para llevar");
      await t.terminar();
      return t.tts.frases.filter(ES_ACUSE);
    };
    const a = await correr();
    expect(a).toHaveLength(2);
    expect(await correr()).toEqual(a);
  });

  it("si el preciso habla antes del plazo del acuse, el acuse no suena", async () => {
    const t = await abrir();
    t.stt.eventos!.turnoFinal("quiero tres tacos de pastor");
    await turnoMicrotareas(40);
    await t.terminar();
    t.reloj.avanzar(ACUSE_ESPERA_MS * 3);
    await turnoMicrotareas(40);
    expect(t.tts.frases.filter(ES_ACUSE)).toEqual([]);
  });

  it.each([
    ["soy alérgico al cacahuate, ¿el mole tiene?"],
    ["quiero cancelar mi pedido"],
    ["ya no lo quiero, cancélelo"],
    ["¿cuánto cuesta la orden de pastor?"],
    ["¿tienen cochinita hoy?"],
    ["¿hay suadero?"],
    ["¿puedo pagar con tarjeta?"],
    ["me cobraron dos veces"],
    ["páseme con una persona"],
    ["quiero hablar con el gerente"],
  ])("turno de riesgo (%j): NO suena acuse", async (texto) => {
    expect(esTurnoDeRiesgoVoz(texto)).toBe(true);
    const t = await abrir();
    await t.decir(texto);
    expect(t.tts.frases).toEqual([]);
    await t.terminar();
    expect(t.tts.frases.filter(ES_ACUSE)).toEqual([]);
  });

  it("`omitirAcuse` de la vertical tambien lo apaga (guardia de riesgo del worker)", async () => {
    const t = await abrir({ omitirAcuse: (x) => x.includes("pastor") });
    await t.decir("quiero tres tacos de pastor");
    expect(t.tts.frases).toEqual([]);
    await t.terminar();
  });

  it("la guardia determinista actua sobre el turno (silenciarTurnoPendiente): no suena el acuse ni la respuesta del modelo", async () => {
    const t = await abrir();
    t.stt.eventos!.turnoFinal("quiero tres tacos de pastor, ah y soy alérgica");
    await turnoMicrotareas(5);
    t.sesion.silenciarTurnoPendiente!();
    await turnoMicrotareas(40);
    t.reloj.avanzar(ACUSE_ESPERA_MS * 10);
    await t.terminar();
    expect(t.tts.frases).toEqual([]);
  });

  it("la guardia actua ANTES de que arranque el turno encolado: ese turno no habla", async () => {
    const t = await abrir();
    t.sesion.silenciarTurnoPendiente!(); // nada pendiente: no hace nada
    t.stt.eventos!.turnoFinal("quiero tres tacos de pastor");
    t.sesion.silenciarTurnoPendiente!();
    await turnoMicrotareas(40);
    t.reloj.avanzar(ACUSE_ESPERA_MS * 10);
    await t.terminar();
    expect(t.tts.frases).toEqual([]);
    // El siguiente turno del cliente vuelve a hablar normalmente.
    await t.decir("y una coca");
    await t.terminar();
    expect(t.tts.frases.join(" ")).toContain("Son ciento setenta y nueve pesos.");
  });

  it("como mucho UN relleno por turno: tras el acuse ya no suena la frase de espera de los 4 s", async () => {
    const t = await abrir({ plazo: true });
    await t.decir("quiero tres tacos de pastor");
    t.reloj.avanzar(LLM.esperaMinMs + 1_000);
    await turnoMicrotareas(40);
    await t.terminar();
    const rellenos = t.tts.frases.filter((f) => ES_ACUSE(f) || ES_ESPERA(f));
    expect(rellenos).toHaveLength(1);
  });

  it("el acuse tiene plazo: corto (<= 1.5 s) para no sonar pegado a la respuesta", () => {
    expect(ACUSE_ESPERA_MS).toBeGreaterThan(0);
    expect(ACUSE_ESPERA_MS).toBeLessThanOrEqual(1_500);
  });
});
