/* eslint-disable @typescript-eslint/no-explicit-any -- arnes de medicion local (QA), no codigo de produccion */
// Adaptadores de medicion para el arnes con audio real: envuelven el STT y el TTS REALES de la cascada v2 (Deepgram Nova-3 y Aura-2, los mismos `crearSttDeepgram` /
// `crearTtsDeepgram` del motor) para anotar tiempos, y sintetizan la voz del CLIENTE con el TTS REST de Deepgram. No tocan el motor. Sin dependencias de QA: reciben las fabricas por parametro.
import { HZ_CLIENTE, parsearPcm16 } from "./pcm.ts";

/** Estado de medicion de UNA llamada (lo llenan los adaptadores y el arnes lo lee). Tiempos en ms de `performance.now()`. */
export class EstadoLlamada {
  finales: { t: number; texto: string }[] = [];
  parciales = 0;
  hablaIniciada: number[] = [];
  frases: { tCall: number; tChunk: number | null; chars: number }[] = [];
  audioAgente: { t: number; ms: number }[] = [];
  /** Hasta cuando "suena" lo que el agente ha dicho (reloj de reproduccion): el cliente espera a que termine antes de hablar, como en una llamada. */
  cabezalMs = 0;
  interrupciones = 0;
  hablaEncimaDelAgente = 0;
  ttsEnVuelo = 0;
  caidas: string[] = [];
  costoMotorMicro = { stt: 0, tts: 0 };
  sttBytes = 0;
}

type Evs = { hablaIniciada(): void; parcial(t: string): void; turnoFinal(t: string): void; caido(c: string): void };

export function envolverStt(real: { abrir(o: any, ev: Evs): Promise<{ enviarAudio(p: Uint8Array): void; cerrar(): Promise<void> }> }, S: EstadoLlamada, ahora: () => number) {
  return {
    async abrir(o: any, ev: Evs) {
      const ses = await real.abrir(o, {
        hablaIniciada: () => { S.hablaIniciada.push(ahora()); if (S.ttsEnVuelo > 0 || ahora() < S.cabezalMs) S.hablaEncimaDelAgente += 1; ev.hablaIniciada(); },
        parcial: (t) => { S.parciales += 1; if (process.env.VOZA_DEBUG) console.error(`[dbg ${Math.round(ahora())}] stt_parcial ${t.slice(-30)}`); ev.parcial(t); },
        turnoFinal: (t) => { S.finales.push({ t: ahora(), texto: t }); if (process.env.VOZA_DEBUG) console.error(`[dbg ${Math.round(ahora())}] stt_final ${t.slice(0, 40)}`); ev.turnoFinal(t); },
        caido: (c) => { S.caidas.push(c); if (process.env.VOZA_DEBUG) console.error(`[dbg ${Math.round(ahora())}] stt_caido ${c}`); ev.caido(c); },
      });
      return { enviarAudio: (p: Uint8Array) => { S.sttBytes += p.byteLength; ses.enviarAudio(p); }, cerrar: () => ses.cerrar() };
    },
  };
}

export function envolverTts(real: { abrir(o: any): Promise<any> }, S: EstadoLlamada, ahora: () => number, contarChars: (n: number) => void) {
  return {
    async abrir(o: any) {
      const ses = await real.abrir(o);
      return {
        flushesDisponibles: () => ses.flushesDisponibles?.() ?? 1000,
        sintetizar: async function* (texto: string, senal: AbortSignal) {
          const f = { tCall: ahora(), tChunk: null as number | null, chars: texto.length };
          S.frases.push(f); contarChars(texto.length); S.ttsEnVuelo += 1;
          if (process.env.VOZA_DEBUG) console.error(`[dbg ${Math.round(ahora())}] tts_inicio ${texto.length}c prov=${ses.proveedor?.() ?? "?"}`);
          try { for await (const c of ses.sintetizar(texto, senal)) { if (f.tChunk === null) { f.tChunk = ahora(); if (process.env.VOZA_DEBUG) console.error(`[dbg ${Math.round(ahora())}] tts_primer`); } yield c; } } catch (e) { if (process.env.VOZA_DEBUG) console.error(`[dbg ${Math.round(ahora())}] tts_error ${(e as Error).message}`); throw e; } finally { S.ttsEnVuelo -= 1; if (process.env.VOZA_DEBUG) console.error(`[dbg ${Math.round(ahora())}] tts_fin aborted=${senal.aborted}`); }
        },
        cerrar: () => ses.cerrar(),
      };
    },
  };
}

/** Voz del cliente por TTS REST de Deepgram (`/v1/speak`, linear16, 16 kHz, sin contenedor). Devuelve PCM16 mono. Lanza con codigo corto y sin llave si falla. */
export async function sintetizarCliente(apiKey: string, voz: string, texto: string, fetchFn: typeof fetch = fetch): Promise<Int16Array> {
  const url = `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voz)}&encoding=linear16&sample_rate=${HZ_CLIENTE}&container=none`;
  let ultimo = "";
  for (let i = 0; i < 3; i += 1) {
    try {
      const r = await fetchFn(url, { method: "POST", headers: { Authorization: `Token ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ text: texto }), signal: AbortSignal.timeout(20_000) });
      if (r.ok) return parsearPcm16(new Uint8Array(await r.arrayBuffer()));
      ultimo = `cliente_tts_http_${r.status}`;
      if (r.status < 500 && r.status !== 429) break;
    } catch { ultimo = "cliente_tts_red"; }
    await new Promise((res) => setTimeout(res, 500 * (i + 1)));
  }
  throw new Error(ultimo || "cliente_tts");
}

/** Vocabulario del menu para `keyterm`: nombres sin parentesis de presentacion ("(orden de 3)", "(individual)"), unicos. */
export function vocabularioMenu(nombres: readonly string[]): string[] {
  const vistos = new Map<string, string>();
  for (const n of nombres) {
    const l = n.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    if (l.length >= 3 && !vistos.has(l.toLowerCase())) vistos.set(l.toLowerCase(), l);
  }
  return [...vistos.values()];
}
