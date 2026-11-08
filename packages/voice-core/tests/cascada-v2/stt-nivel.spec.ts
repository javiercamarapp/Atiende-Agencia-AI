// Platica del restaurante (E2E r2 7-nov-2026, condicion 4: voces de fondo 10 dB por debajo del cliente): Scribe RT transcribe la mesa de al lado. Sus parciales
// (a) cortaban al agente (barge-in con 2 palabras), (b) cambiaban sin parar y el turno del cliente no cerraba (respuestas a los 28 s o nunca) y (c) se confirmaban como
// turnos del cliente («lo de la bodega», «la moto»). Compuerta por NIVEL, sin cambiar el protocolo (no pide include_timestamps): el STT mide el audio que envia; un parcial
// o segmento cuyo nivel queda cerca del piso de ruido Y por debajo de la voz del cliente es fondo: no corta, no mantiene abierto el turno y no abre turno.
import { describe, expect, it } from "vitest";
import { COMPUERTA_NIVEL_ELEVENLABS, VOZ_PLATAFORMA, crearSttElevenLabs } from "../../src/index.ts";
import type { EventosStt } from "../../src/index.ts";
import { fabricaSockets, turnoMicrotareas } from "./dobles.ts";

const HZ = 16_000;
const BASE = VOZ_PLATAFORMA.cascadaV2.elevenlabs.stt;

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

/** `segundos` de tono con amplitud `amp` (PCM16 LE). amp 600 ~ 52 dB (platica de fondo); amp 3000 ~ 66 dB (el cliente). */
function tono(segundos: number, amp: number): Uint8Array {
  const n = Math.round(segundos * HZ);
  const b = new Uint8Array(n * 2);
  const v = new DataView(b.buffer);
  for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(amp * Math.sin(i / 3)), true);
  return b;
}

async function abrir(compuertaNivel: typeof COMPUERTA_NIVEL_ELEVENLABS | null = COMPUERTA_NIVEL_ELEVENLABS) {
  const f = fabricaSockets();
  const r = reloj();
  const vistos: string[] = [];
  const e: EventosStt = { hablaIniciada: () => undefined, parcial: (t) => void vistos.push(`parcial:${t}`), turnoFinal: (t) => void vistos.push(`final:${t}`), caido: (c) => void vistos.push(`caido:${c}`), descartado: (m) => void vistos.push(`descartado:${m}`) };
  const puerto = crearSttElevenLabs({ apiKey: "k", config: { ...BASE, compuertaNivel }, crearSocket: f.crear, temporizador: r });
  const abriendo = puerto.abrir({ hzEntrada: HZ }, e);
  await turnoMicrotareas();
  f.sockets[0]!.texto({ message_type: "session_started" });
  const s = await abriendo;
  const sock = f.sockets[0]!;
  const audio = (segundos: number, amp: number) => {
    // En tramas de 20 ms, como el puente.
    const b = tono(segundos, amp);
    for (let i = 0; i < b.length; i += 640) s.enviarAudio(b.subarray(i, i + 640));
  };
  const parcial = (t: string) => sock.texto({ message_type: "partial_transcript", text: t });
  const commit = (t: string) => {
    sock.texto({ message_type: "committed_transcript", text: t });
    r.vencer(BASE.finTurnoMinMs);
  };
  return { vistos, audio, parcial, commit, r, sock };
}

describe("compuerta por nivel del STT de ElevenLabs (platica de fondo)", () => {
  it("encendida por omision en la plataforma y sin pedir include_timestamps", () => {
    expect(BASE.compuertaNivel).toEqual(COMPUERTA_NIVEL_ELEVENLABS);
    expect(BASE.compuertaFondo).toBeNull();
  });

  it("con platica de fondo constante, un parcial y un segmento al nivel del fondo NO cortan ni abren turno", async () => {
    const t = await abrir();
    t.audio(4, 600);
    t.audio(1, 3000);
    t.parcial("hola buenas tardes");
    t.commit("Hola, buenas tardes.");
    t.vistos.length = 0;
    t.audio(4, 600);
    t.parcial("lo de la bodega");
    t.commit("Lo de la bodega.");
    expect(t.vistos.filter((v) => v.startsWith("parcial:") || v.startsWith("final:"))).toEqual([]);
    expect(t.vistos).toContain("descartado:nivel_fondo");
  });

  it("el cliente que habla por ENCIMA del fondo si corta y abre turno", async () => {
    const t = await abrir();
    t.audio(4, 600);
    t.audio(1, 3000);
    t.parcial("quiero tres tacos");
    t.commit("Quiero tres tacos de pastor.");
    expect(t.vistos).toContain("parcial:quiero tres tacos");
    expect(t.vistos).toContain("final:Quiero tres tacos de pastor.");
  });

  it("tras el cliente, los parciales del fondo que cambian sin parar no mantienen abierto el turno: se fuerza el commit y cierra con lo del cliente", async () => {
    const t = await abrir();
    t.audio(4, 600);
    t.audio(1, 3000);
    t.parcial("quiero tres tacos");
    t.audio(1, 600);
    t.parcial("quiero tres tacos y la moto");
    t.audio(0.5, 600);
    t.parcial("quiero tres tacos y la moto de juan");
    t.r.vencer(BASE.finTurnoMaxMs);
    expect(t.sock.json.some((m) => m["commit"] === true)).toBe(true);
    t.r.vencer(1_000);
    expect(t.vistos, JSON.stringify(t.vistos)).toContain("final:quiero tres tacos");
  });

  it("sin referencia del cliente (primer segmento) un segmento nunca se descarta, aunque suene al nivel del piso: solo se frenan los parciales", async () => {
    const t = await abrir();
    t.audio(6, 3000);
    t.commit("Quiero tres tacos de pastor y una coca para recoger.");
    expect(t.vistos).toContain("final:Quiero tres tacos de pastor y una coca para recoger.");
  });

  it("un parcial que llega TARDE (el cliente ya callo hace 400 ms) en linea limpia sigue siendo voz: el nivel mira los ultimos 500 ms (E2E r3: parcial_fondo en limpio)", async () => {
    const t = await abrir();
    t.audio(4, 0);
    t.audio(1, 3000);
    t.audio(0.4, 0);
    t.parcial("quiero cuatro tacos");
    expect(t.vistos).toContain("parcial:quiero cuatro tacos");
    expect(t.vistos).not.toContain("descartado:parcial_fondo");
  });

  it("primer turno con platica constante y la voz del cliente cerca del piso (tras Krisp): el turno igual CIERRA con el commit forzado (E2E r3 c4: 15 de 19 fallas, la llamada colgaba por silencio)", async () => {
    const t = await abrir();
    t.audio(12, 600);
    t.parcial("quiero tres tacos de pastor");
    t.audio(1, 600);
    t.parcial("quiero tres tacos de pastor y una coca");
    t.r.vencer(BASE.finTurnoMaxMs);
    expect(t.sock.json.some((m) => m["commit"] === true)).toBe(true);
    t.commit("Quiero tres tacos de pastor y una coca.");
    expect(t.vistos).toContain("final:Quiero tres tacos de pastor y una coca.");
  });

  it("en una linea limpia (piso bajo) un cliente que habla bajito pasa siempre", async () => {
    const t = await abrir();
    t.audio(4, 0);
    t.audio(1, 400);
    t.parcial("si correcto");
    t.commit("Sí, correcto.");
    expect(t.vistos).toContain("final:Sí, correcto.");
  });

  it("apagada (null): el fondo se comporta como antes (corta y abre turno)", async () => {
    const t = await abrir(null);
    t.audio(4, 600);
    t.parcial("lo de la bodega");
    t.commit("Lo de la bodega.");
    expect(t.vistos).toContain("parcial:lo de la bodega");
    expect(t.vistos).toContain("final:Lo de la bodega.");
  });

  it("nunca deja la llamada sorda: tras `descartesMax` segmentos descartados seguidos se apaga en esa llamada", async () => {
    const t = await abrir();
    t.audio(4, 600);
    t.audio(1, 3000);
    t.commit("Hola, buenas tardes.");
    t.audio(4, 600);
    for (let i = 0; i < COMPUERTA_NIVEL_ELEVENLABS.descartesMax; i++) {
      t.audio(1, 600);
      t.commit(`fondo ${i}.`);
    }
    expect(t.vistos.filter((v) => v.startsWith("final:"))).toEqual(["final:Hola, buenas tardes."]);
    expect(t.vistos).toContain("descartado:compuerta_nivel_apagada");
    t.commit("Hola, ¿me escucha?");
    expect(t.vistos).toContain("final:Hola, ¿me escucha?");
  });
});
