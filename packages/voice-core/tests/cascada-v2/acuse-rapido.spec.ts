// Acuse rapido (latencia, ronda 2): en un turno que va al modelo PRECISO (Luna tarda ~3 s y casi siempre empieza con herramientas, sin texto), el modelo RAPIDO
// escribe en paralelo un acuse corto («Claro, tres de pastor.») que suena primero. Nunca cifras, totales, confirmaciones ni preguntas; si el preciso habla antes,
// el acuse se descarta. No entra al historial del modelo.
import { describe, expect, it } from "vitest";
import { VOZ_PLATAFORMA, crearProveedorCascadaV2 } from "../../src/index.ts";
import type { PeticionLlmVoz, PuertoLlmVoz, RespuestaLlmVoz } from "../../src/index.ts";
import { SttFalso, TtsFalso, compuerta, manejadoresFalsos, turnoMicrotareas } from "./dobles.ts";

const D = VOZ_PLATAFORMA.cascadaV2.llm.dosNiveles;

function llm(acuse: string, opts: { preciso: Promise<void> }) {
  const peticiones: PeticionLlmVoz[] = [];
  const puerto: PuertoLlmVoz = {
    completar: async (p): Promise<RespuestaLlmVoz> => {
      peticiones.push({ ...p, mensajes: [...p.mensajes] });
      if (p.modeloPreferido === D.modeloRapido && p.herramientas.length === 0 && p.system.includes("ACUSE")) return { texto: acuse, toolCalls: [], costoMicroUsd: 1 };
      await opts.preciso;
      p.onTextDelta?.("Son ciento setenta y nueve pesos.");
      return { texto: "Son ciento setenta y nueve pesos.", toolCalls: [], costoMicroUsd: 1 };
    },
  };
  return { puerto, peticiones };
}

async function turno(acuse: string, precisoPrimero = false) {
  const c = compuerta();
  if (precisoPrimero) c.abrir();
  const { puerto, peticiones } = llm(acuse, { preciso: c.promesa });
  const stt = new SttFalso();
  const tts = new TtsFalso();
  const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm: puerto, stt, tts, modeloLlm: D.modelo, modeloRapido: D.modeloRapido, acuseRapido: true });
  await prov.abrirSesion({ instruccion: "i", voiceId: "Kore", herramientas: [{ nombre: "cotizar_pedido", descripcion: "x", parametros: {} }] as never }, manejadoresFalsos().h);
  stt.eventos!.turnoFinal("quiero tres tacos de pastor y una coca para recoger");
  await turnoMicrotareas(40);
  c.abrir();
  await prov.inactivo();
  stt.eventos!.turnoFinal("es todo");
  await prov.inactivo();
  return { tts, peticiones };
}

describe("acuse rapido del modelo rapido mientras piensa el preciso", () => {
  it("suena primero el acuse y despues la respuesta; el acuse no entra al historial", async () => {
    const { tts, peticiones } = await turno("Claro, tres de pastor y una coca.");
    expect(tts.frases[0]).toBe("Claro, tres de pastor y una coca.");
    expect(tts.frases.join(" ")).toContain("Son ciento setenta y nueve pesos.");
    const ultimaPrecisa = peticiones.filter((p) => p.modeloPreferido === D.modelo).at(-1)!;
    expect(JSON.stringify(ultimaPrecisa.mensajes)).not.toContain("tres de pastor y una coca.\"");
  });

  it.each([["Son 179 pesos."], ["Listo, su pedido quedó registrado."], ["¿Algo más?"], ["Claro, con gusto le tomo su pedido de tres tacos al pastor con una coca para recoger."]])("un acuse con cifras, registro, pregunta o largo (%j) no se dice", async (a) => {
    const { tts } = await turno(a);
    expect(tts.frases).not.toContain(a);
  });

  it("si el preciso habla primero, el acuse se descarta", async () => {
    const { tts } = await turno("Claro, tres de pastor.", true);
    expect(tts.frases).not.toContain("Claro, tres de pastor.");
  });
});
