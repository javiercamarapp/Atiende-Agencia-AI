// Medicion de Deepgram (TTS Aura-2 y STT Nova-3) y de la latencia voz-a-voz de la cascada completa. La llave sale SOLO de DEEPGRAM_API_KEY en el entorno del
// proceso (el que lanza el script la carga de un archivo con permisos 600); nunca se imprime ni se guarda. Solo usa /v1/speak y /v1/listen (sin endpoints de cuenta).
// Uso: set -a; . ~/atiende-loop/.env.voz-bench; set +a; OPENROUTER_API_KEY=... npx vite-node scripts/voz-bench/deepgram.ts <tts|stt|e2e> [--reps 3] [--out DIR]
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { FondoRestaurante } from "../../packages/voice-core/src/fondo-ambiente.ts";
import { OpenRouterProvider } from "../../packages/agent-core/src/index.ts";
import { instruccionVozPm } from "../../packages/domain-restaurantes/src/voz/simulador/prompt-voz.ts";
import { crearMundoVoz } from "../../packages/domain-restaurantes/src/voz/simulador/mundo-voz.ts";

const modo = process.argv[2] ?? "tts";
const arg = (n: string, d: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const reps = Number(arg("reps", "3"));
const HOME = process.env.HOME!;
const OUT = arg("out", `${HOME}/atiende-loop/work/voz-bench-resultados`);
const AUDIO = `${HOME}/atiende-loop/pm/audio-ambiente/aura2`;
const KEY = process.env.DEEPGRAM_API_KEY ?? "";
if (!KEY) throw new Error("Falta DEEPGRAM_API_KEY en el entorno (cargala desde ~/atiende-loop/.env.voz-bench sin imprimirla).");
const VOCES = ["aura-2-estrella-es", "aura-2-olivia-es"] as const;
const USD_POR_MILLON_CHARS = 30; // Aura-2, lista (developers.deepgram.com/pricing); no hay endpoint de costo por solicitud sin permisos de cuenta

export const CORTAS = [
  "Quiero seis tacos al pastor para llevar.", "Me da una orden de gringas de pastor, por favor.", "Con tortilla de harina, sin cebolla.", "A nombre de Ana Pech.",
  "Voy a pagar en efectivo con quinientos pesos.", "Es para entregar en la colonia Altabrisa.", "Una horchata y una coca cola, por favor.", "Sí, está bien, confírmelo.",
  "Mejor cambie los tacos de bistec por pastor.", "Paso por el pedido en veinte minutos.",
];
export const LARGAS = [
  "Buenas tardes, quiero hacer un pedido a domicilio: dos órdenes de tacos de bistec con tortilla de maíz, una gringa de pastor y dos aguas de horchata.",
  "Mi dirección es calle sesenta y tres, número cuatrocientos doce, por cuarenta y cinco y cuarenta y siete, colonia Centro, en Mérida.",
  "Necesito un pedido grande para una fiesta de treinta personas, ¿me pueden pasar con alguien de la sucursal para cotizarlo?",
  "Disculpe, mi pedido llegó incompleto, faltaron los nachos de pastor y la salsa, quiero que me lo reponga o me regresen el dinero.",
  "Quiero tres cuartos de kilo de arrachera para recoger en la sucursal Francisco de Montejo, con tortilla de harina, y pago con tarjeta.",
];
const FRASES = [...CORTAS.map((t, i) => ({ id: `C${i + 1}`, t })), ...LARGAS.map((t, i) => ({ id: `L${i + 1}`, t }))];
const KEYTERMS = ["pastor", "bistec", "gringa", "horchata", "arrachera", "Altabrisa", "Montejo", "nachos", "Pech"];

const cuantil = (xs: number[], q: number): number | null => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]! : null;
};
const r1 = (x: number | null) => (x === null ? null : Math.round(x));

// ---------------- audio ----------------
function wavAPcm(wav: Uint8Array): Uint8Array {
  // cabecera RIFF de 44 bytes (container=wav, linear16)
  return wav.subarray(44);
}
/** La API entrega WAV en streaming con tamanos 0x7FFFFFFF: se reescribe la cabecera con los tamanos reales para que cualquier reproductor lo abra. */
function wavReal(pcm: Uint8Array, hz: number): Uint8Array {
  const w = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(w.buffer);
  const t = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  t(0, "RIFF"); v.setUint32(4, 36 + pcm.byteLength, true); t(8, "WAVE"); t(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, hz, true); v.setUint32(28, hz * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); t(36, "data"); v.setUint32(40, pcm.byteLength, true); w.set(pcm, 44);
  return w;
}
const aInt16 = (b: Uint8Array) => new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.byteLength & ~1)));
function rms(x: Int16Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / Math.max(1, x.length));
}
function silencioInicialMs(x: Int16Array, hz: number): number {
  const umbral = 0.01 * 32768;
  const ventana = Math.round(hz * 0.01);
  for (let i = 0; i + ventana <= x.length; i += ventana) if (rms(x.subarray(i, i + ventana)) > umbral) return Math.round((i / hz) * 1000);
  return Math.round((x.length / hz) * 1000);
}
/** 24 kHz -> 8 kHz: promedio de 3 muestras (pasa-bajas simple). */
function a8k(x: Int16Array): Int16Array {
  const o = new Int16Array(Math.floor(x.length / 3));
  for (let i = 0; i < o.length; i++) o[i] = Math.round((x[3 * i]! + x[3 * i + 1]! + x[3 * i + 2]!) / 3);
  return o;
}
function mulaw(x: Int16Array): Uint8Array {
  const o = new Uint8Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let s = x[i]!;
    const sign = s < 0 ? 0x80 : 0;
    if (s < 0) s = -s;
    s = Math.min(s + 132, 32635);
    let exp = 7;
    for (let m = 0x4000; (s & m) === 0 && exp > 0; m >>= 1) exp--;
    const mant = (s >> (exp + 3)) & 0x0f;
    o[i] = ~(sign | (exp << 4) | mant) & 0xff;
  }
  return o;
}
/** Mezcla el murmullo de fondo (fondo-ambiente.ts) a una relacion senal/ruido dada (dB). */
function conRuido(x: Int16Array, snrDb: number, semilla: number): Int16Array {
  const f = new FondoRestaurante({ volumen: 20, semilla, hz: 24_000 });
  const ruido = aInt16(f.siguiente(x.length));
  const k = rms(x) / Math.max(1, rms(ruido)) / Math.pow(10, snrDb / 20);
  const o = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) o[i] = Math.max(-32768, Math.min(32767, Math.round(x[i]! + ruido[i]! * k)));
  return o;
}

// ---------------- TTS ----------------
interface ResTts { pcm: Uint8Array; wav: Uint8Array; ttfbMs: number; totalMs: number; chars: number; estado: number }
async function tts(texto: string, voz: string, contenedor: "wav" | "none" = "wav"): Promise<ResTts> {
  const t0 = performance.now();
  const res = await fetch(`https://api.deepgram.com/v1/speak?model=${voz}&encoding=linear16&sample_rate=24000&container=${contenedor}`, {
    method: "POST", headers: { Authorization: `Token ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ text: texto }),
  });
  if (!res.ok || !res.body) return { pcm: new Uint8Array(0), wav: new Uint8Array(0), ttfbMs: -1, totalMs: -1, chars: texto.length, estado: res.status };
  const rd = res.body.getReader();
  const trozos: Uint8Array[] = [];
  let ttfb = -1;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    if (ttfb < 0) ttfb = performance.now() - t0;
    trozos.push(value);
  }
  const total = performance.now() - t0;
  const n = trozos.reduce((s, c) => s + c.byteLength, 0);
  const wav = new Uint8Array(n);
  let o = 0;
  for (const c of trozos) { wav.set(c, o); o += c.byteLength; }
  return { pcm: contenedor === "wav" ? wavAPcm(wav) : wav, wav, ttfbMs: ttfb, totalMs: total, chars: texto.length, estado: res.status };
}

async function modoTts(): Promise<void> {
  mkdirSync(AUDIO, { recursive: true });
  const filas: Record<string, unknown>[] = [];
  for (const voz of VOCES) {
    for (const f of FRASES) {
      for (let r = 1; r <= reps; r++) {
        const x = await tts(f.t, voz);
        if (x.estado !== 200) { filas.push({ voz, frase: f.id, rep: r, error: `HTTP ${x.estado}` }); continue; }
        const pcm = aInt16(x.pcm);
        const durS = pcm.length / 24_000;
        filas.push({ voz, frase: f.id, rep: r, chars: x.chars, ttfbMs: r1(x.ttfbMs), totalMs: r1(x.totalMs), audioS: +durS.toFixed(2), silencioInicialMs: silencioInicialMs(pcm, 24_000), pico: Math.max(...Array.from(pcm.subarray(0, 48000)).map(Math.abs)), rtf: +(x.totalMs / 1000 / durS).toFixed(2), bytes: x.wav.byteLength, formato: "wav pcm16 24 kHz mono" });
        if (r === 1) writeFileSync(`${AUDIO}/${voz.replace("aura-2-", "").replace("-es", "")}-${f.id}.wav`, wavReal(x.pcm, 24_000));
      }
    }
  }
  // Solo cifras (nunca texto que venga de la red) llegan al archivo de resultados.
  const soloCifras = filas.map((f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === "number" ? Number(v) : k === "voz" || k === "frase" || k === "formato" ? String(v).replace(/[^\w .-]/g, "") : typeof v === "string" ? "error" : null])));
  writeFileSync(`${OUT}/deepgram-tts.json`, JSON.stringify(soloCifras, null, 1));
  const resumen: Record<string, unknown>[] = [];
  for (const voz of VOCES) for (const grupo of ["C", "L"]) {
    const rs = filas.filter((f) => f.voz === voz && String(f.frase).startsWith(grupo) && !f.error);
    const chars = rs.reduce((s, f) => s + (f.chars as number), 0);
    resumen.push({ voz, grupo: grupo === "C" ? "cortas" : "largas", n: rs.length, ttfb_p50_ms: cuantil(rs.map((f) => f.ttfbMs as number), 0.5), ttfb_p95_ms: cuantil(rs.map((f) => f.ttfbMs as number), 0.95), total_p50_ms: cuantil(rs.map((f) => f.totalMs as number), 0.5), total_p95_ms: cuantil(rs.map((f) => f.totalMs as number), 0.95), audio_p50_s: cuantil(rs.map((f) => f.audioS as number), 0.5), silencio_inicial_p50_ms: cuantil(rs.map((f) => f.silencioInicialMs as number), 0.5), rtf_p50: cuantil(rs.map((f) => f.rtf as number), 0.5), chars_totales: chars, usd_por_1000_chars_lista: USD_POR_MILLON_CHARS / 1000, usd_gastado_lista: +(chars * USD_POR_MILLON_CHARS / 1e6).toFixed(4) });
  }
  writeFileSync(`${OUT}/deepgram-tts-resumen.json`, JSON.stringify(resumen, null, 1));
  console.log(JSON.stringify(resumen, null, 1));
}

// ---------------- STT ----------------
const UN = ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve", "veinte"];
function normalizar(s: string): string[] {
  const sinAcentos = s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ ]/g, " ");
  return sinAcentos.split(/\s+/).filter(Boolean).flatMap((w) => (/^\d+$/.test(w) && Number(w) <= 20 ? [UN[Number(w)]!.normalize("NFD").replace(/[̀-ͯ]/g, "")] : [w]));
}
function wer(ref: string[], hip: string[]): { errores: number; n: number } {
  const d: number[][] = Array.from({ length: ref.length + 1 }, (_, i) => Array.from({ length: hip.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= ref.length; i++) for (let j = 1; j <= hip.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (ref[i - 1] === hip[j - 1] ? 0 : 1));
  return { errores: d[ref.length]![hip.length]!, n: ref.length };
}
interface ResStt { texto: string; latFinalMs: number | null; primerParcialMs: number | null; error?: string }
function transcribir(mu: Uint8Array, conKeyterms: boolean): Promise<ResStt> {
  return new Promise((resolve) => {
    const kt = conKeyterms ? KEYTERMS.map((k) => `&keyterm=${encodeURIComponent(k)}`).join("") : "";
    const url = `wss://api.deepgram.com/v1/listen?model=nova-3&language=es-419&encoding=mulaw&sample_rate=8000&channels=1&interim_results=true&endpointing=300&smart_format=false&punctuate=false${kt}`;
    const WS = (globalThis as unknown as { WebSocket: new (u: string, o?: unknown) => WebSocket }).WebSocket;
    const ws = new WS(url, { headers: { Authorization: `Token ${KEY}` } });
    ws.binaryType = "arraybuffer";
    const finales: string[] = [];
    let tFinHabla = 0, latFinal: number | null = null, primer: number | null = null, hecho = false;
    const cerrar = (error?: string) => {
      if (hecho) return;
      hecho = true;
      try { ws.close(); } catch { /* ya cerrado */ }
      resolve({ texto: finales.join(" ").trim(), latFinalMs: latFinal, primerParcialMs: primer, ...(error ? { error } : {}) });
    };
    const plazo = setTimeout(() => cerrar("timeout"), 60_000);
    ws.onerror = () => { clearTimeout(plazo); cerrar("ws_error"); };
    ws.onclose = () => { clearTimeout(plazo); cerrar(); };
    ws.onmessage = (ev) => {
      let m: { type?: string; is_final?: boolean; speech_final?: boolean; channel?: { alternatives?: { transcript?: string }[] } };
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type !== "Results") return;
      const tr = m.channel?.alternatives?.[0]?.transcript ?? "";
      if (tr && tFinHabla > 0 && primer === null) primer = performance.now() - tFinHabla;
      if (m.is_final && tr) finales.push(tr);
      if (m.speech_final && tFinHabla > 0 && latFinal === null) { latFinal = performance.now() - tFinHabla; setTimeout(() => cerrar(), 300); }
    };
    ws.onopen = async () => {
      const CH = 160; // 20 ms a 8 kHz mu-law
      const cola = 1.2 * 8000; // 1.2 s de linea abierta tras la frase (silencio/ruido de fondo ya mezclado)
      const total = mu.length;
      const t0 = performance.now();
      for (let i = 0; i < total && !hecho; i += CH) {
        ws.send(mu.subarray(i, Math.min(total, i + CH)));
        if (i + CH >= total - cola && tFinHabla === 0) tFinHabla = performance.now();
        const objetivo = t0 + ((i + CH) / 8000) * 1000;
        const esp = objetivo - performance.now();
        if (esp > 0) await new Promise((r) => setTimeout(r, esp));
      }
      if (!hecho) ws.send(JSON.stringify({ type: "CloseStream" }));
    };
  });
}
async function modoStt(): Promise<void> {
  const cond = [
    { id: "limpio", snr: null as number | null, kt: true },
    { id: "limpio-sin-keyterms", snr: null, kt: false },
    { id: "ruido-15dB", snr: 15, kt: true },
    { id: "ruido-5dB", snr: 5, kt: true },
  ];
  const filas: Record<string, unknown>[] = [];
  for (const voz of VOCES) for (const f of FRASES) {
    const cache = `${OUT}/tts-cache-${voz}-${f.id}.pcm`;
    let pcm24: Int16Array;
    let guardado: Uint8Array | null = null;
    try { guardado = new Uint8Array(readFileSync(cache)); } catch { /* sin cache: se sintetiza */ }
    if (guardado) pcm24 = aInt16(guardado);
    else { const x = await tts(f.t, voz); if (x.estado !== 200) continue; pcm24 = aInt16(x.pcm); writeFileSync(cache, x.pcm); }
    const pad = new Int16Array(24_000 * 1.2); // 1.2 s de linea abierta al final
    for (const c of cond) {
      const base = new Int16Array(pcm24.length + pad.length);
      base.set(pcm24);
      const señal = c.snr === null ? base : conRuido(base, c.snr, 7);
      const mu = mulaw(a8k(señal));
      const r = await transcribir(mu, c.kt);
      const w = wer(normalizar(f.t), normalizar(r.texto));
      filas.push({ voz, frase: f.id, cond: c.id, ref: f.t, hip: r.texto, errores: w.errores, n: w.n, latFinalMs: r1(r.latFinalMs), primerParcialMs: r1(r.primerParcialMs), audioS: +(pcm24.length / 24_000).toFixed(2), error: r.error });
    }
  }
  writeFileSync(`${OUT}/deepgram-stt.json`, JSON.stringify(filas, null, 1));
  const res: Record<string, unknown>[] = [];
  for (const c of cond) {
    const rs = filas.filter((f) => f.cond === c.id && !f.error);
    const err = rs.reduce((s, f) => s + (f.errores as number), 0), n = rs.reduce((s, f) => s + (f.n as number), 0);
    res.push({ condicion: c.id, frases: rs.length, WER: +(err / n).toFixed(3), frases_perfectas: rs.filter((f) => f.errores === 0).length, lat_final_p50_ms: cuantil(rs.map((f) => f.latFinalMs as number).filter((x) => x != null), 0.5), lat_final_p95_ms: cuantil(rs.map((f) => f.latFinalMs as number).filter((x) => x != null), 0.95), sin_final: rs.filter((f) => f.latFinalMs == null).length, audio_s: +rs.reduce((s, f) => s + (f.audioS as number), 0).toFixed(0), errores_ws: filas.filter((f) => f.cond === c.id && f.error).length });
  }
  writeFileSync(`${OUT}/deepgram-stt-resumen.json`, JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
}

// ---------------- voz-a-voz ----------------
async function modoE2e(): Promise<void> {
  const KEY_OR = process.env.OPENROUTER_API_KEY ?? "";
  if (!KEY_OR) throw new Error("Falta OPENROUTER_API_KEY");
  const mundo = crearMundoVoz();
  const system = instruccionVozPm([{ propertyId: mundo.propertyId, slug: "fco-montejo", name: "Francisco de Montejo", address: null }, { propertyId: "altabrisa", slug: "altabrisa", name: "Altabrisa", address: null }], "lunes 18:30", "lunes", "fco-montejo");
  const modelos = [
    { m: "anthropic/claude-sonnet-5.5", r: "low", cache: true, n: "sonnet-5.5 low+cache" },
    { m: "anthropic/claude-haiku-5.5", r: "none", cache: true, n: "haiku-5.5 none+cache" },
    { m: "openai/gpt-6-luna", r: "low", cache: false, n: "luna low" },
  ] as const;
  const frases = CORTAS.slice(0, 8).concat(LARGAS.slice(0, 2));
  const N = Number(arg("n", "10"));
  const filas: Record<string, unknown>[] = [];
  for (const cfg of modelos) {
    const llm = new OpenRouterProvider({
      apiKey: KEY_OR, model: cfg.m, appName: "atiende-voz-bench", params: { temperature: "omit", reasoningEffort: cfg.r, minMaxTokens: 1500 }, timeoutMs: 30_000, maxRetries: 2, backoffBaseMs: 1500,
      ...(cfg.cache ? { fetchImpl: ((u: Parameters<typeof fetch>[0], i?: Parameters<typeof fetch>[1]) => {
        const b = JSON.parse(String(i?.body)) as { messages: { role: string; content: unknown }[] };
        if (b.messages[0]?.role === "system" && typeof b.messages[0].content === "string") b.messages[0] = { role: "system", content: [{ type: "text", text: b.messages[0].content, cache_control: { type: "ephemeral" } }] };
        return fetch(u, { ...i, body: JSON.stringify(b) });
      }) as typeof fetch } : {}),
    });
    for (let k = 0; k < N; k++) {
      const f = frases[k % frases.length]!;
      const voz = VOCES[k % 2]!;
      // 1) STT: la frase del cliente (Aura-2 -> 8 kHz mu-law -> Nova-3 es-419, tal cual llegaria por telefono)
      const x = await tts(f, voz);
      const pcm = aInt16(x.pcm);
      const base = new Int16Array(pcm.length + 28_800); base.set(pcm);
      const stt = await transcribir(mulaw(a8k(base)), true);
      if (stt.latFinalMs === null) { filas.push({ modelo: cfg.n, k, error: "sin final STT" }); continue; }
      // 2) LLM en streaming: tiempo al primer token y a la primera oracion completa (lo que ya se puede mandar a TTS)
      const tL = performance.now();
      let tPrimero = -1, tOracion = -1, buf = "", primeraOracion = "";
      const r = await llm.complete({ system, messages: [{ role: "user", content: stt.texto || f }], maxOutputTokens: 400, onTextDelta: (d: string) => {
        if (tPrimero < 0) tPrimero = performance.now() - tL;
        buf += d;
        if (tOracion < 0) { const m = /^(.+?[.?!¿¡:])(\s|$)/s.exec(buf); if (m && m[1]!.length > 12) { tOracion = performance.now() - tL; primeraOracion = m[1]!; } }
      } });
      if (tOracion < 0) { tOracion = performance.now() - tL; primeraOracion = buf.slice(0, 160) || r.text.slice(0, 160); }
      // 3) TTS Aura-2 de la primera oracion
      const t = await tts(primeraOracion || "Con gusto.", voz);
      const vozAVoz = stt.latFinalMs + tOracion + t.ttfbMs;
      filas.push({ modelo: cfg.n, k, frase: f, sttFinalMs: r1(stt.latFinalMs), llmPrimerTokenMs: r1(tPrimero), llmPrimeraOracionMs: r1(tOracion), llmCosto: r.costUsd, llmTokIn: r.tokensIn, llmCache: r.tokensCached ?? 0, ttsTtfbMs: r1(t.ttfbMs), oracionChars: primeraOracion.length, vozAVozMs: r1(vozAVoz), vozAVozConTool1Ms: r1(vozAVoz + (tPrimero > 0 ? tPrimero : 0)) });
    }
  }
  writeFileSync(`${OUT}/deepgram-e2e.json`, JSON.stringify(filas, null, 1));
  const res = modelos.map((cfg) => {
    const rs = filas.filter((f) => f.modelo === cfg.n && !f.error);
    const g = (k: string, q: number) => cuantil(rs.map((f) => f[k] as number), q);
    return { modelo: cfg.n, n: rs.length, stt_final_p50: g("sttFinalMs", 0.5), llm_1er_token_p50: g("llmPrimerTokenMs", 0.5), llm_1a_oracion_p50: g("llmPrimeraOracionMs", 0.5), tts_ttfb_p50: g("ttsTtfbMs", 0.5), voz_a_voz_p50: g("vozAVozMs", 0.5), voz_a_voz_p95: g("vozAVozMs", 0.95), voz_a_voz_con_una_herramienta_p50: g("vozAVozConTool1Ms", 0.5), usd_llm_medio: +(rs.reduce((s, f) => s + (f.llmCosto as number), 0) / Math.max(1, rs.length)).toFixed(5) };
  });
  writeFileSync(`${OUT}/deepgram-e2e-resumen.json`, JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
}
if (modo === "tts") await modoTts();
else if (modo === "stt") await modoStt();
else if (modo === "e2e") await modoE2e();
else throw new Error("modo: tts | stt | e2e");
