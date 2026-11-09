// Barge-in con plática de fondo (P2-5 de la revision de #719): el primer parcial no vacio cortaba al agente, y Scribe transcribe la mesa de al lado. Un parcial de UNA
// palabra ya no corta; dos palabras si (y el turno final siempre corta). El STT que descarta un segmento de fondo lo deja en el log.
import { describe, expect, it } from "vitest";
import { crearProveedorCascadaV2 } from "../../src/index.ts";
import { SttFalso, TtsFalso, compuerta, llmFalso, manejadoresFalsos, turnoMicrotareas } from "./dobles.ts";

async function armar() {
  const lento = compuerta();
  const llm = llmFalso([async (p) => (await lento.promesa, p.onTextDelta?.("Son 179 pesos."), { texto: "Son 179 pesos." })]);
  const stt = new SttFalso();
  const logs: string[] = [];
  const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm, stt, tts: new TtsFalso(), log: (l) => void logs.push(l.evento) });
  await prov.abrirSesion({ instruccion: "i", voiceId: "Kore", herramientas: [] }, manejadoresFalsos().h);
  stt.eventos!.turnoFinal("cuanto es de tres tacos");
  await turnoMicrotareas(20);
  return { llm, stt, lento, prov, logs };
}

describe("barge-in: hace falta mas de una palabra en el parcial", () => {
  it("un parcial de una palabra (ruido o fondo) no corta al agente", async () => {
    const { llm, stt, lento, prov } = await armar();
    stt.eventos!.parcial("oye");
    expect(llm.senales[0]!.aborted).toBe(false);
    lento.abrir();
    await prov.inactivo();
  });

  it("un parcial de dos palabras si corta", async () => {
    const { llm, stt, lento, prov } = await armar();
    stt.eventos!.parcial("no espere");
    expect(llm.senales[0]!.aborted).toBe(true);
    lento.abrir();
    await prov.inactivo();
  });

  it("un segmento descartado por el STT queda en el log (sin texto)", async () => {
    const { stt, lento, prov, logs } = await armar();
    stt.eventos!.descartado?.("voz_de_fondo");
    lento.abrir();
    await prov.inactivo();
    expect(logs).toContain("v2_stt_descartado");
  });
});
