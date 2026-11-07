// Frase de espera («Permítame», «Déjeme ver») de la cascada v2. Medicion E2E del 6-nov-2026 (LiveKit + worker real): con el plazo del hedge (2.5 s) sonaba en casi
// cada turno porque el primer token tarda ~3 s; el cliente contestaba «sí» y luego hablaba encima de la respuesta real (bucle de «Permítame»). Regla nueva:
//   - la frase de espera es INDEPENDIENTE del plazo del hedge: solo si pasan >= 4 s sin audio del agente;
//   - a lo mas UNA vez por llamada;
//   - un asentimiento del cliente («sí», «aquí espero») nunca la vuelve a disparar.
import { describe, expect, it } from "vitest";
import { VOZ_PLATAFORMA, crearProveedorCascadaV2 } from "../../src/index.ts";
import type { PeticionLlmVoz, PuertoLlmVoz, RespuestaLlmVoz } from "../../src/index.ts";
import { SttFalso, TtsFalso, compuerta, manejadoresFalsos, turnoMicrotareas } from "./dobles.ts";

const LLM = VOZ_PLATAFORMA.cascadaV2.llm;
const DOS_NIVELES = { modeloLlm: LLM.dosNiveles.modelo, modeloRapido: LLM.dosNiveles.modeloRapido, plazoLlm: { plazoMs: LLM.dosNiveles.plazoPrimerTokenMs, modeloRespaldo: LLM.dosNiveles.modeloRespaldo }, ignorarAsentimientosOcupado: true } as const;
const ES_ESPERA = new RegExp(LLM.frasesEspera.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));

/** Reloj manual con tiempo: `avanzar(ms)` dispara solo los temporizadores que vencen hasta ese instante. */
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
  const turnos: { abrir: () => void }[] = [];
  const llm: PuertoLlmVoz = {
    completar: async (p: PeticionLlmVoz): Promise<RespuestaLlmVoz> => {
      // Principal y respaldo esperan la MISMA compuerta del turno: la prueba decide cuando llega el primer token.
      const c = compuerta();
      turnos.push(c);
      await c.promesa;
      p.onTextDelta?.("Son 179 pesos.");
      return { texto: "Son 179 pesos.", toolCalls: [], costoMicroUsd: 0 };
    },
  };
  return { llm, abrirTodo: () => turnos.splice(0).forEach((t) => t.abrir()) };
}

async function abrir(llm: PuertoLlmVoz, reloj: ReturnType<typeof relojConTiempo>) {
  const stt = new SttFalso();
  const tts = new TtsFalso();
  const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm, stt, tts, temporizador: reloj, ...DOS_NIVELES });
  await prov.abrirSesion({ instruccion: "i", voiceId: "Kore", herramientas: [] }, manejadoresFalsos().h);
  return { stt, tts, prov };
}

describe("frase de espera: solo tras >= 4 s, una vez por llamada", () => {
  it("al vencer el plazo del hedge (2.5 s) NO se dice frase de espera", async () => {
    const reloj = relojConTiempo();
    const { llm, abrirTodo } = llmLento();
    const { stt, tts, prov } = await abrir(llm, reloj);
    stt.eventos!.turnoFinal("cuanto es de tres tacos de pastor");
    await turnoMicrotareas(40);
    reloj.avanzar(3_000);
    await turnoMicrotareas(40);
    expect(tts.frases.filter((f) => ES_ESPERA.test(f))).toEqual([]);
    abrirTodo();
    await prov.inactivo();
    expect(tts.frases.some((f) => ES_ESPERA.test(f))).toBe(false);
  });

  it("pasados 4 s sin audio se dice UNA frase de espera; en un segundo turno lento de la misma llamada ya no", async () => {
    const reloj = relojConTiempo();
    const { llm, abrirTodo } = llmLento();
    const { stt, tts, prov } = await abrir(llm, reloj);
    stt.eventos!.turnoFinal("cuanto es de tres tacos de pastor");
    await turnoMicrotareas(40);
    reloj.avanzar(4_100);
    await turnoMicrotareas(40);
    expect(tts.frases.filter((f) => ES_ESPERA.test(f))).toHaveLength(1);
    abrirTodo();
    await prov.inactivo();
    stt.eventos!.turnoFinal("y agregue una coca de seiscientos");
    await turnoMicrotareas(40);
    reloj.avanzar(6_000);
    await turnoMicrotareas(40);
    abrirTodo();
    await prov.inactivo();
    expect(tts.frases.filter((f) => ES_ESPERA.test(f))).toHaveLength(1);
  });

  it("un asentimiento del cliente tras la frase de espera no la repite ni abre otro turno", async () => {
    const reloj = relojConTiempo();
    const { llm, abrirTodo } = llmLento();
    const { stt, tts, prov } = await abrir(llm, reloj);
    stt.eventos!.turnoFinal("cuanto es de tres tacos de pastor");
    await turnoMicrotareas(40);
    reloj.avanzar(4_100);
    await turnoMicrotareas(40);
    stt.eventos!.parcial("sí");
    stt.eventos!.turnoFinal("Sí, aquí espero.");
    await turnoMicrotareas(40);
    reloj.avanzar(8_000);
    await turnoMicrotareas(40);
    abrirTodo();
    await prov.inactivo();
    expect(tts.frases.filter((f) => ES_ESPERA.test(f))).toHaveLength(1);
    expect(tts.frases.filter((f) => f === "Son 179 pesos.")).toHaveLength(1);
  });
});
