// Platica de fondo transcrita como si fuera el cliente (medicion STT del 6-nov-2026: Scribe RT escribe la conversacion de la mesa de al lado). Compuerta del STT de
// ElevenLabs con `include_timestamps`: un segmento confirmado cuya voz suena MUCHO mas baja que la del cliente (>= dbBajoVoz por debajo de la mediana de sus segmentos
// aceptados) Y con confianza baja (logprob medio < logprobMax) se descarta: no abre turno ni corta al agente. Hace falta haber aceptado antes 2 segmentos del cliente.
import { describe, expect, it } from "vitest";
import { VOZ_PLATAFORMA, crearSttElevenLabs, urlSttElevenLabs } from "../../src/index.ts";
import type { EventosStt } from "../../src/index.ts";
import { fabricaSockets, turnoMicrotareas } from "./dobles.ts";

const C = VOZ_PLATAFORMA.cascadaV2.elevenlabs;
const HZ = 16_000;

function reloj() {
  let n = 0;
  const p = new Map<number, { fn: () => void; ms: number }>();
  return {
    poner: (fn: () => void, ms: number): unknown => (p.set(++n, { fn, ms }), n),
    quitar: (id: unknown): void => void p.delete(id as number),
    vencer(ms: number): void {
      for (const [id, x] of [...p]) {
        if (x.ms !== ms) continue;
        p.delete(id);
        x.fn();
      }
    },
  };
}

/** `segundos` de tono con amplitud `amp` (PCM16 LE). */
function tono(segundos: number, amp: number): Uint8Array {
  const n = Math.round(segundos * HZ);
  const b = new Uint8Array(n * 2);
  const v = new DataView(b.buffer);
  for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(amp * Math.sin(i / 3)), true);
  return b;
}

const palabras = (texto: string, desde: number, logprob: number) =>
  texto.split(" ").map((t, i) => ({ text: t, start: desde + i * 0.3, end: desde + i * 0.3 + 0.25, type: "word", logprob }));

async function abrir() {
  const f = fabricaSockets();
  const r = reloj();
  const vistos: string[] = [];
  const e: EventosStt = { hablaIniciada: () => undefined, parcial: (t) => void vistos.push(`parcial:${t}`), turnoFinal: (t) => void vistos.push(`final:${t}`), caido: (c) => void vistos.push(`caido:${c}`), descartado: (m) => void vistos.push(`descartado:${m}`) };
  const puerto = crearSttElevenLabs({ apiKey: "k", config: C.stt, crearSocket: f.crear, temporizador: r });
  const abriendo = puerto.abrir({ hzEntrada: HZ }, e);
  await turnoMicrotareas();
  f.sockets[0]!.texto({ message_type: "session_started" });
  const s = await abriendo;
  const sock = f.sockets[0]!;
  /** El cliente (o el fondo) dice `texto` en [desde, desde+dur] con amplitud `amp` y confianza `lp`. */
  const segmento = (texto: string, desde: number, amp: number, lp: number) => {
    sock.texto({ message_type: "committed_transcript", text: texto });
    sock.texto({ message_type: "committed_transcript_with_timestamps", text: texto, words: palabras(texto, desde, lp) });
    r.vencer(C.stt.finTurnoMinMs);
    void amp;
  };
  return { s, vistos, segmento };
}

describe("compuerta de voz de fondo (STT ElevenLabs)", () => {
  it("la URL pide `include_timestamps` (sin `filter_background_audio`: medido, no mejora el WER)", () => {
    const u = new URL(urlSttElevenLabs(C.stt, { hzEntrada: HZ }));
    expect(u.searchParams.get("include_timestamps")).toBe("true");
    expect(u.searchParams.get("filter_background_audio")).toBeNull();
  });

  it("tras dos turnos del cliente a buen volumen, un segmento 20 dB mas bajo y con confianza baja se descarta (no hay turno)", async () => {
    const { s, vistos, segmento } = await abrir();
    s.enviarAudio(tono(2, 8000)); // 0-2 s: cliente
    segmento("Quiero dos de pastor", 0.2, 8000, -0.8);
    s.enviarAudio(tono(2, 8000)); // 2-4 s: cliente
    segmento("para recoger por favor", 2.2, 8000, -0.9);
    s.enviarAudio(tono(2, 800)); // 4-6 s: platica de fondo (20 dB abajo)
    segmento("quien pidio las dos coca sin hielo", 4.2, 800, -1.9);
    expect(vistos.filter((v) => v.startsWith("final:"))).toEqual(["final:Quiero dos de pastor", "final:para recoger por favor"]);
    expect(vistos).toContain("descartado:voz_de_fondo");
  });

  it("un segmento bajo pero con confianza ALTA se acepta (puede ser el cliente que se alejo del telefono)", async () => {
    const { s, vistos, segmento } = await abrir();
    s.enviarAudio(tono(2, 8000));
    segmento("Quiero dos de pastor", 0.2, 8000, -0.8);
    s.enviarAudio(tono(2, 8000));
    segmento("para recoger por favor", 2.2, 8000, -0.9);
    s.enviarAudio(tono(2, 800));
    segmento("y una coca", 4.2, 800, -0.5);
    expect(vistos.filter((v) => v.startsWith("final:"))).toHaveLength(3);
  });

  it("sin dos segmentos aceptados todavia no se descarta nada (el primer turno nunca se filtra)", async () => {
    const { s, vistos, segmento } = await abrir();
    s.enviarAudio(tono(2, 800));
    segmento("bueno buenas tardes", 0.2, 800, -1.9);
    expect(vistos.filter((v) => v.startsWith("final:"))).toEqual(["final:bueno buenas tardes"]);
  });
});
