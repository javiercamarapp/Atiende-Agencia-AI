/* eslint-disable @typescript-eslint/no-explicit-any -- arnes de medicion: dependencias de QA sin tipos */
// E2E por LiveKit Cloud con el WORKER REAL (apps/voice-worker: Worker + LiveKitTelefonia + Krisp + escalera de la plataforma con ElevenLabs/Deepgram/OpenRouter)
// contra la API REAL local (stack.ts de QA, Postgres efimero con la config de PM). Un participante "llamante" sintetico entra a la sala con los atributos SIP
// (numero marcado y telefono), habla con voz Aura-2 (distinta de la del agente), con linea telefonica (banda + mu-law) y, segun VOZA_RUIDO, cama de ruido de
// restaurante; oye el audio del agente POR LIVEKIT, lo transcribe (Deepgram REST) para que el cliente-LLM conteste, y mide fin de voz -> primer audio del agente
// recibido por la red. Al final: checks deterministas contra la base + juez (los mismos del arnes de audio) y costo del worker por componente.
// Solo medicion local: LiveKit acepta al llamante como participante ESTANDAR, asi que aqui (y solo aqui) se hace pasar por SIP para la deteccion del worker.
// Uso: VOZ_QA_DIR=<qa> OPENROUTER_API_KEY=... VOZ_REP=1 [VOZ_FILTRO] [VOZA_RUIDO=0|1|4] [VOZA_SNR_DB=10] [VOZA_GRABAR_N] vite-node -c <qa>/vite-node.config.ts e2e-livekit.ts
import { randomInt } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { AccessToken } from "livekit-server-sdk";
import * as rtc from "@livekit/rtc-node";
import { DATOS_POR_OMISION, ESCENARIOS, RELOJES } from "../voz-medicion-real/escenarios.ts";
import type { Chk, Escenario } from "../voz-medicion-real/escenarios.ts";
import { rngDesdeSemilla } from "../voz-medicion-real/ruido-stt.ts";
import { sintetizarCliente } from "./adaptadores.ts";
import { concatenar, recortarSilencios, silencio } from "./pcm.ts";
import { lineaTelefonica } from "./telefonia.ts";

// El reloj del arnes (stack.ts) desplaza `Date` +N dias para los escenarios: los tokens de LiveKit (del llamante y del worker) se firman con la hora REAL.
const RealDate = Date;
const toJwtOriginal = AccessToken.prototype.toJwt;
AccessToken.prototype.toJwt = async function (this: AccessToken) {
  const D = globalThis.Date; globalThis.Date = RealDate;
  try { return await toJwtOriginal.call(this); } finally { globalThis.Date = D; }
};
// El participante sintetico es ESTANDAR: el worker busca uno de tipo SIP. Solo en este proceso se hace equivaler SIP a ESTANDAR.
(rtc.ParticipantKind as any).SIP = rtc.ParticipantKind.STANDARD;

const QA = process.env.VOZ_QA_DIR!;
// Fallas de INFRAESTRUCTURA local (no del agente): la API en proceso escribe `apps_api_error_interno` (p. ej. el Postgres local agota la conexion cuando la Mac
// pasa de carga 30). Se cuentan por llamada para clasificar esa llamada como `infra` y no como falla del agente (E2E r2: 6 de 32 llamadas).
let erroresApi = 0;
for (const flujo of [process.stdout, process.stderr]) {
  const escribir = flujo.write.bind(flujo) as (...a: unknown[]) => boolean;
  (flujo as unknown as { write: (...a: unknown[]) => boolean }).write = (...a: unknown[]) => {
    if (typeof a[0] === "string" && a[0].includes("apps_api_error_interno")) erroresApi += 1;
    return escribir(...a);
  };
}
// Llaves por VARIABLE DE ENTORNO (las exporta corrida/correr-el.sh desde ~/.atiende-secrets): este proceso nunca lee archivos de llaves.
const leer = (n: string): string => { const v = (process.env[n] ?? "").trim(); if (!v) throw new Error(`falta la variable ${n} (correr con corrida/correr-el.sh)`); return v; };
const { startStack, setClock, PROP } = await import(`${QA}/stack.ts`);
const { chat, gasto } = await import(`${QA}/llm.ts`);
const { nextClientMsg } = await import(`${QA}/lib.ts`);
const R = new URL("../..", import.meta.url).pathname;
const { cargarConfig } = await import(`${R}apps/voice-worker/src/config.ts`);
const { Worker } = await import(`${R}apps/voice-worker/src/worker.ts`);
const { OPCIONES_ESCALERA_PM, CONFIRMACION_VOZ_PM } = await import(`${R}apps/voice-worker/src/llamada.ts`);
const { afirmaPedidoRegistrado } = await import(`${R}packages/domain-restaurantes/src/index.ts`);
const { ClienteApi } = await import(`${R}apps/voice-worker/src/api-cliente.ts`);
const { crearPuertoLlmVozV2 } = await import(`${R}apps/voice-worker/src/llm-openrouter.ts`);
const { cargarCancelacionRuido } = await import(`${R}apps/voice-worker/src/telefonia/ruido.ts`);
const { LiveKitTelefonia } = await import(`${R}apps/voice-worker/src/telefonia/livekit.ts`);
const { VOZ_PLATAFORMA, crearEscaleraPlataforma, MENSAJE_IDS } = await import(`${R}packages/voice-core/src/index.ts`);
const { HERRAMIENTAS_VOZ_SOLO_LECTURA } = await import(`${R}packages/domain-restaurantes/src/index.ts`);

const REP = process.env.VOZ_REP ?? "1";
const FILTRO = process.env.VOZ_FILTRO ? new RegExp(process.env.VOZ_FILTRO) : null;
const NIVEL_RUIDO = Number(process.env.VOZA_RUIDO ?? "4");
const SNR_CAMA = Number(process.env.VOZA_SNR_DB ?? "10");
const VOZ_CLIENTE = process.env.VOZA_VOZ_CLIENTE ?? "aura-2-javier-es";
const JUEZ = process.env.VOZ_JUEZ ?? "anthropic/claude-haiku-5.5";
const RES = process.env.VOZ_RES_DIR ?? `${QA}/results`;
const ETQ = process.env.VOZ_ETQ ?? "e2e";
const ARCHIVO = `${RES}/voz-e2e-${ETQ}-rep${REP}.json`;
const GRABAR_DIR = process.env.VOZA_GRABAR_DIR ?? ""; let grabarRestantes = Number(process.env.VOZA_GRABAR_N ?? "0");
mkdirSync(RES, { recursive: true });
const llaveDg = leer("DEEPGRAM_API_KEY");
const llaveEl = leer("ELEVENLABS_API_KEY");
// Creditos de ElevenLabs usados (cuenta propia de la medicion): delta de character_count de la suscripcion antes/despues de cada llamada. null si falla la lectura.
async function creditosEl(): Promise<number | null> {
  try { const r = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": llaveEl }, signal: AbortSignal.timeout(10_000) }); if (!r.ok) return null; const j: any = await r.json(); return Number(j.character_count); } catch { return null; }
}
const FALLAS_DIR = process.env.VOZA_FALLAS_DIR ?? "";
const PREFIJO = "e2e-el-";
const DNIS = { T1: "+529990000101", T3: "+529990000103", T7: "+529990000107" } as const;
const SLUG = { T1: "prol-montejo", T3: "pensiones", T7: "garcia-lavin" } as const;
const ORG_ID = "f838fd2c-967e-46fd-af8d-e0229b15748d";

const s = await startStack();
// Solo en la base EFIMERA local: el agente de voz encendido en las 3 sucursales del arnes.
await s.pool.query("update restaurantes.branch_voice_config set habilitado = true");

const env: Record<string, string> = {
  LIVEKIT_URL: leer("LIVEKIT_URL"), LIVEKIT_API_KEY: leer("LIVEKIT_API_KEY"), LIVEKIT_API_SECRET: leer("LIVEKIT_API_SECRET"),
  ATIENDE_API_URL: s.api, INTERNAL_SECRET: "qa-internal-secret-local", OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY!,
  ELEVENLABS_API_KEY: leer("ELEVENLABS_API_KEY"), DEEPGRAM_API_KEY: llaveDg, VOZ_CASCADA_V2_HABILITADA: "1", VOZ_ESCALERA: "cascada-v2", VOZ_CEREBRO_DOS_NIVELES: "1",
  // Como produccion (`VOZ_RUIDO` por omision `ninguno`). r3 (8-nov-2026): con `krisp-telefonia` (BVC) y platica a 10 dB el worker dejaba de oir al cliente
  // (0 de voz en su VAD, «silencio_reprompt» y cuelgue en 13 de 30 llamadas); sin Krisp, 0 cuelgues. Para medirlo: VOZ_RUIDO_KRISP=krisp-telefonia.
  VOZ_RUIDO: process.env.VOZ_RUIDO_KRISP ?? "ninguno", VOICE_ROOM_PREFIX: PREFIJO, VOICE_SECRET_QA: "qa-voice-tool-secret-local",
  VOICE_DNIS_MAP: JSON.stringify(Object.fromEntries((["T1", "T3", "T7"] as const).map((t) => [DNIS[t], { orgSlug: "los-taquitos-de-pm", organizationId: ORG_ID, propertyId: PROP[t], branchSlug: SLUG[t], secretoEnv: "VOICE_SECRET_QA", modoEntrada: "total" }]))),
};
const config = cargarConfig(env, { pregrabadosFaltantes: [] });
if (config.estado !== "configurado") throw new Error("worker no configurado: " + config.motivos.join(" | "));
// Pregrabados: 0.3 s de silencio (no se mide su voz; el worker los exige para arrancar).
const pregrabados = new Map((MENSAJE_IDS as readonly string[]).map((id) => [id, { hz: 16_000, muestras: new Int16Array(4_800) }]));
const eventos: { evento: string; campos: any; t: number; tp: number }[] = [];
const sumidero = ({ evento, campos }: any) => void eventos.push({ evento, campos, t: Date.now(), tp: performance.now() });
const logPlano = (evento: string, campos: any = {}) => void eventos.push({ evento, campos, t: Date.now(), tp: performance.now() });
const ruido = await cargarCancelacionRuido(config.ruido, logPlano);
const telefonia = new LiveKitTelefonia({ ...config.livekit!, log: logPlano, ...(ruido ? { cancelacionRuido: ruido } : {}) });
const api = new ClienteApi({ baseUrl: config.apiBaseUrl, internalSecret: config.internalSecret });
const llmV2 = crearPuertoLlmVozV2(config.openrouterApiKey!, undefined, { proveedoresZdr: config.proveedoresZdr });
const worker = new Worker({
  config, telefonia, log: logPlano,
  deps: {
    config, pregrabados, api, log: sumidero,
    crearEscalera: () => crearEscaleraPlataforma({ geminiApiKey: null, openrouterApiKey: config.openrouterApiKey, deepgramApiKey: config.deepgramApiKey, elevenlabsApiKey: config.elevenlabsApiKey, config: { ...VOZ_PLATAFORMA, escalera: config.escalera ?? VOZ_PLATAFORMA.escalera }, dosNiveles: config.cerebroDosNiveles, cascadaV2Habilitada: true, confirmacionAntesDeCrear: CONFIRMACION_VOZ_PM, llm: null, llmV2, log: sumidero, herramientasEnParalelo: HERRAMIENTAS_VOZ_SOLO_LECTURA }, OPCIONES_ESCALERA_PM),
  },
});
if (!(await worker.iniciar())) throw new Error("el worker no arranco");

const rms = (d: Int16Array) => { let e = 0; for (let i = 0; i < d.length; i += 1) e += d[i]! * d[i]!; return Math.sqrt(e / Math.max(1, d.length)); };
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UMBRAL = 700;

async function transcribir(pcm: Int16Array): Promise<string> {
  if (pcm.length < 1600) return "";
  const b = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const r = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&language=es-419&encoding=linear16&sample_rate=16000&smart_format=true", { method: "POST", headers: { Authorization: `Token ${llaveDg}`, "content-type": "application/octet-stream" }, body: b, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) return "";
  const j: any = await r.json();
  return String(j?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "");
}

// Cama de ruido de restaurante (8 kHz -> 16 kHz) para VOZA_RUIDO=4.
const CAMA: Int16Array | null = (() => {
  const f = NIVEL_RUIDO === 5 ? process.env.VOZA_CAMA_COCINA_CALLE : process.env.VOZA_CAMA_RESTAURANTE; if (!f) return null;
  const b = readFileSync(f); let i = 12;
  while (i < b.length) { const id = b.toString("ascii", i, i + 4); const n = b.readUInt32LE(i + 4); if (id === "data") { const d = new Int16Array(b.buffer.slice(b.byteOffset + i + 8, b.byteOffset + i + 8 + n)); const o = new Int16Array(d.length * 2); for (let k = 0; k < d.length; k += 1) { o[2 * k] = d[k]!; o[2 * k + 1] = k + 1 < d.length ? (d[k]! + d[k + 1]!) >> 1 : d[k]!; } return o; } i += 8 + n + (n % 2); }
  return null;
})();
function mezclarCama(pcm: Int16Array, rng: () => number): Int16Array {
  if (!CAMA) return pcm;
  const r = rms(pcm.filter((v) => Math.abs(v) > 300)) || 1000;
  const off = Math.floor(rng() * Math.max(1, CAMA.length - pcm.length));
  const seg = CAMA.subarray(off, off + pcm.length); const g = r / ((rms(seg) || 1) * 10 ** (SNR_CAMA / 20));
  const o = new Int16Array(pcm.length);
  for (let k = 0; k < pcm.length; k += 1) o[k] = Math.max(-32768, Math.min(32767, Math.round(pcm[k]! + (seg[k] ?? 0) * g)));
  return o;
}

function escribirWavEstereo(ruta: string, izq: Int16Array, der: Int16Array): void {
  const n = Math.max(izq.length, der.length); const b = Buffer.alloc(44 + n * 4);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 4, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(64000, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 4, 40);
  for (let k = 0; k < n; k += 1) { b.writeInt16LE(izq[k] ?? 0, 44 + k * 4); b.writeInt16LE(der[k] ?? 0, 46 + k * 4); }
  writeFileSync(ruta, b);
}

async function correrLlamada(e: Escenario, phone: string) {
  const sala = `${PREFIJO}${e.id.toLowerCase()}-${REP}-${Date.now() % 1e7}`;
  const tok = new AccessToken(env.LIVEKIT_API_KEY!, env.LIVEKIT_API_SECRET!, { identity: `llamante-${Date.now() % 1e6}`, ttl: "20m" });
  tok.attributes = { "sip.phoneNumber": `+${phone}`, "sip.trunkPhoneNumber": DNIS[e.sucursal] };
  tok.addGrant({ roomJoin: true, room: sala, canPublish: true, canSubscribe: true });
  const room = new rtc.Room();
  const t0 = performance.now();
  const agente: { t: number; pcm: Int16Array; voz: boolean }[] = [];
  let colgo = false;
  room.on(rtc.RoomEvent.TrackSubscribed, (track: any, _pub: any, p: any) => {
    if (track.kind !== rtc.TrackKind.KIND_AUDIO || !String(p.identity).startsWith("agente-")) return;
    void (async () => { for await (const f of new rtc.AudioStream(track, { sampleRate: 16_000, numChannels: 1 })) agente.push({ t: performance.now(), pcm: Int16Array.from(f.data), voz: rms(f.data) > UMBRAL }); })().catch(() => undefined);
  });
  room.on(rtc.RoomEvent.Disconnected, () => { colgo = true; });
  room.on(rtc.RoomEvent.ParticipantDisconnected, (p: any) => { if (String(p.identity).startsWith("agente-")) colgo = true; });
  const jwt = await tok.toJwt(); console.error("[e2e] jwt len", jwt.length, "url ok", /^wss:/.test(env.LIVEKIT_URL!));
  await room.connect(env.LIVEKIT_URL!, jwt, { autoSubscribe: true, dynacast: false });
  console.error("[e2e] llamante conectado");
  const fuente = new rtc.AudioSource(16_000, 1);
  await room.localParticipant!.publishTrack(rtc.LocalAudioTrack.createAudioTrack("voz", fuente), new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE }));
  const enviado: { t: number; pcm: Int16Array }[] = [];
  // Trama de silencio continua mientras el cliente no habla (una linea telefonica nunca calla del todo): el ruido de fondo entra tambien entre turnos.
  let hablando = false; let vivo = true; const rng = rngDesdeSemilla(`${e.id}-${REP}`);
  const silencioLinea = async () => {
    while (vivo) {
      if (!hablando) { let f = new Int16Array(320); if ((NIVEL_RUIDO === 4 || NIVEL_RUIDO === 5) && CAMA) { const off = Math.floor(rng() * (CAMA.length - 320)); const g = 0.25; f = Int16Array.from(CAMA.subarray(off, off + 320), (v) => v * g); } await fuente.captureFrame(new rtc.AudioFrame(f, 16_000, 1, 320)); }
      await esperar(20);
    }
  };
  void silencioLinea();
  const vozDesde = (t: number) => agente.filter((a) => a.t >= t);
  /** Espera a que el agente hable y luego calle `callaMs`; devuelve el instante del primer audio con voz tras `desde` (null si no hablo en `maxMs`). */
  const esperarAgente = async (desde: number, maxMs: number, callaMs = 1400): Promise<number | null> => {
    const lim = desde + maxMs; let primera: number | null = null;
    while (performance.now() < lim && !colgo) {
      const v = vozDesde(desde).find((a) => a.voz); if (v && primera === null) primera = v.t;
      if (primera !== null) { const ult = [...vozDesde(desde)].reverse().find((a) => a.voz); if (ult && performance.now() - ult.t > callaMs) break; }
      await esperar(50);
    }
    return primera;
  };
  const textoDesde = async (desde: number) => { const seg = vozDesde(desde).map((a) => a.pcm); const n = seg.reduce((a, b) => a + b.length, 0); const o = new Int16Array(n); let k = 0; for (const x of seg) { o.set(x, k); k += x.length; } return transcribir(o); };
  const hablar = async (dicho: string) => {
    const voz = recortarSilencios(await sintetizarCliente(llaveDg, VOZ_CLIENTE, dicho));
    let pcm = concatenar(silencio(120), voz);
    if (NIVEL_RUIDO === 4 || NIVEL_RUIDO === 5) pcm = lineaTelefonica(mezclarCama(pcm, rng), rng); else if (NIVEL_RUIDO >= 1) pcm = lineaTelefonica(pcm, rng);
    hablando = true; const ti = performance.now();
    for (let k = 0; k + 320 <= pcm.length; k += 320) { await fuente.captureFrame(new rtc.AudioFrame(pcm.slice(k, k + 320), 16_000, 1, 320)); const d = ti + ((k / 320) + 1) * 20 - performance.now(); if (d > 0) await esperar(d); }
    hablando = false; enviado.push({ t: ti, pcm });
    return performance.now();
  };
  const hist: { who: "cliente" | "agente"; text: string }[] = [];
  const registro: any[] = []; const latencias: number[] = []; const latenciasRespuesta: number[] = [];
  // Saludo del agente.
  await esperarAgente(t0, 25_000);
  let marca = performance.now();
  hist.push({ who: "agente", text: await textoDesde(t0) });
  const guion = e.turnos.filter((x): x is string => typeof x === "string");
  const persona = { goal: `Llamas por telefono a una taqueria: ${e.titulo}. Hablas como en una llamada: frases cortas, sin escribir cifras ni signos raros.`, hints: guion, datos: e.datos ?? DATOS_POR_OMISION };
  let extra = 0; const ph10 = phone.slice(-10);
  for (let k = 0; k < guion.length + 6 && !colgo; k += 1) {
    if (k >= guion.length) {
      if (!e.sigue) break;
      const n = (await s.pool.query("select count(*)::int c from restaurantes.orders where customer_phone like $1", [`%${ph10}`])).rows[0].c;
      const cb = (await s.pool.query("select count(*)::int c from restaurantes.callback_requests where customer_phone like $1", [`%${ph10}`])).rows[0].c;
      if ((n > 0 && extra >= 1) || cb > 0 || extra >= 5) break;
      extra += 1;
    }
    const { msg } = await nextClientMsg(persona, hist as never, hist.length <= 1, "voz");
    const dicho = (msg ?? "").replace(/\s+/g, " ").trim() || "Bueno?";
    const tFin = await hablar(dicho);
    const primera = await esperarAgente(tFin, 30_000);
    if (primera !== null) latencias.push(Math.round(primera - tFin));
    let texto = await textoDesde(marca === 0 ? tFin : tFin);
    let respuestaEn: number | null = primera;
    // Paciencia de una persona real (r3): si lo ultimo que dijo el agente es una frase de espera («Déjeme ver.», «Un momento.», «Permítame.»), el cliente
    // espera a que siga en vez de contestar a los 1.4 s de silencio (antes contestaba «Sí, gracias» encima y gastaba turnos). Hasta 2 veces, 12 s cada una.
    for (let espera = 0; espera < 2 && !colgo && /(d[eé]jeme (ver|checar|revisar)|un momento|un segundito|perm[ií]tame|lo reviso)[.!…\s]*$/i.test(texto.trim()); espera += 1) {
      const sigue = await esperarAgente(performance.now(), 12_000);
      if (sigue === null) break;
      respuestaEn = sigue;
      texto = await textoDesde(tFin);
    }
    // Latencia a la RESPUESTA (no al relleno): primer audio despues de la ultima frase de espera.
    if (respuestaEn !== null) latenciasRespuesta.push(Math.round(respuestaEn - tFin));
    marca = performance.now();
    const ultVoz = [...vozDesde(tFin)].reverse().find((a) => a.voz)?.t ?? null;
    registro.push({ quien: "cliente", dicho }, { quien: "agente", texto, msPrimerAudio: primera === null ? null : Math.round(primera - tFin), tp0: primera, tp1: ultVoz });
    hist.push({ who: "cliente", text: dicho }, { who: "agente", text: texto || "(silencio del agente)" });
  }
  vivo = false;
  const durS = (performance.now() - t0) / 1000;
  const grabar = (ruta: string) => {
    const n = Math.ceil(durS * 16000) + 16000; const izq = new Int16Array(n); const der = new Int16Array(n);
    for (const c of enviado) { const o = Math.floor(((c.t - t0) / 1000) * 16000); izq.set(c.pcm.subarray(0, Math.max(0, n - o)), o); }
    let cab = 0; for (const a of agente) { const o = Math.max(cab, Math.floor(((a.t - t0) / 1000) * 16000)); if (o + a.pcm.length < n) der.set(a.pcm, o); cab = o + a.pcm.length; }
    escribirWavEstereo(ruta, izq, der);
  };
  const n0 = worker.resumenes.length;
  await room.disconnect().catch(() => undefined);
  const lim = Date.now() + 30_000; while (worker.resumenes.length === n0 && Date.now() < lim) await esperar(200);
  return { registro, latencias, latenciasRespuesta, durS, resumen: worker.resumenes.at(-1) ?? null, colgoAgente: colgo, grabar };
}

function evaluar(c: Chk, i: { orders: any[]; callbacks: any[]; agenteTexto: string }): string | null {
  const { orders, callbacks, agenteTexto } = i;
  switch (c.t) {
    case "sinPedido": return orders.length ? `no debia crear pedido y creo ${orders.length}` : null;
    case "pedidos": return orders.length === c.n ? null : `pedidos=${orders.length} (esperado ${c.n})`;
    case "maxPedidos": return orders.length <= c.n ? null : `DUPLICADO: ${orders.length} pedidos (max ${c.n})`;
    case "total": return orders.some((o) => c.en.includes(o.total)) ? null : `total ${JSON.stringify(orders.map((o) => o.total))} no esta en ${JSON.stringify(c.en)}`;
    case "totalSiCrea": return orders.every((o) => c.en.includes(o.total)) ? null : `total ${JSON.stringify(orders.map((o) => o.total))} fuera de ${JSON.stringify(c.en)}`;
    case "callback": return callbacks.length && (!c.motivos || callbacks.some((cb) => c.motivos!.includes(cb.reason))) ? null : `no registro escalacion (callback)`;
    case "sinCallback": return callbacks.length ? `escalo una consulta informativa` : null;
    case "sinTexto": return new RegExp(c.re, "i").test(agenteTexto) ? `el agente dijo algo prohibido (/${c.re}/)` : null;
    case "texto": return new RegExp(c.re, "i").test(agenteTexto) ? null : `el agente no dijo /${c.re}/`;
    case "sinItem": return orders.some((o) => new RegExp(c.re, "i").test(JSON.stringify(o.items))) ? `pedido contiene /${c.re}/` : null;
    case "canal": return orders.length && orders.every((o) => o.canal === c.v) ? null : `canal ${JSON.stringify(orders.map((o) => o.canal))} != ${c.v}`;
    case "sinDomicilio": return orders.some((o) => o.canal === "domicilio") ? "creo pedido a domicilio" : null;
    case "piezas": { const re = new RegExp(c.re, "i"); const n = orders.reduce((a, o) => a + o.items.filter((it: any) => re.test(it.name)).reduce((b: number, it: any) => b + Number(it.quantity), 0), 0); return n === c.n ? null : `piezas /${c.re}/ = ${n} (esperado ${c.n})`; }
  }
  return null;
}
const JUEZ_SYS = `Eres un evaluador estricto del agente de VOZ (llamada telefonica) de una taqueria. Recibes el escenario (lo que DEBE y NO DEBE hacer), la transcripcion (lo que el agente dijo es una transcripcion automatica de su audio; puede traer errores menores de reconocimiento) y el estado real de la base de datos.
Si el agente dijo que el pedido quedo registrado (o "queda registrado", "ya quedo", "confirmado") y la BD no lo tiene, o lo dijo ANTES de que el sistema lo creara (ver EVENTOS: crear_pedido ok), es FALLA grave aunque despues se haya creado. Si el agente escalo a una persona sin crear un pedido que el cliente ya habia confirmado, es FALLA. Un turno largo es un defecto menor.
Las cantidades de la BD son UNIDADES DE VENTA del menu, no piezas: «3x Gringa de Pastor@194» son 3 ordenes (de 2 gringas cada una) y «1x Tacos de Bistec (orden de 3)» es una orden de 3 tacos. Los checks deterministas (pedidos, cantidades y totales contra la BD) ya se corrieron: si FALLAS DETERMINISTAS dice "ninguna", no contradigas el pedido, su total ni sus cantidades; juzga la conversacion. La transcripcion del agente es lo que el arnes alcanzo a oir antes de colgar: que termine en una frase de espera no es falla si el pedido correcto existe.
Responde SOLO JSON: {"veredicto":"PASA"|"PARCIAL"|"FALLA","motivo":"1-2 frases","causa":"modelo|prompt|herramienta|ruido_stt|arnes|ninguna","severidad":"P0|P1|P2|P3|ninguna"}`;

const previo: any[] = (() => { try { const j = JSON.parse(readFileSync(ARCHIVO, "utf8")); return Array.isArray(j) ? j : []; } catch { return []; } })();
const results: any[] = previo.filter((r) => !r.excepcion);
const hechos = new Set(results.map((r) => r.id));
const costosVistos = new Set<string>();
const elInicio = await creditosEl();
const guardar = () => { writeFileSync(`${ARCHIVO}.tmp`, JSON.stringify(results, null, 1), { mode: 0o600 }); renameSync(`${ARCHIVO}.tmp`, ARCHIVO); };
console.error(`[e2e-livekit] rep=${REP} ruido=${NIVEL_RUIDO} snr=${SNR_CAMA} krisp=${env.VOZ_RUIDO} krispCargado=${ruido !== null}`);

for (const e of ESCENARIOS) {
  if (FILTRO && !FILTRO.test(e.id)) continue;
  if (hechos.has(e.id)) continue;
  setClock(RELOJES[e.reloj]);
  const phone = `521999${String(randomInt(1000000, 10000000))}`; const ph10 = phone.slice(-10);
  const ev0 = eventos.length; const rec: any = { id: e.id, titulo: e.titulo, rep: REP, ruido: NIVEL_RUIDO, snrDb: SNR_CAMA };
  const el0 = await creditosEl(); const cj0 = gasto.usd; const carga0 = loadavg()[0]!; const api0 = erroresApi; const tp0 = performance.now();
  // Tope por llamada (r3: 2 llamadas colgadas 34-37 min): pasado este tiempo la llamada es una excepcion del arnes y se reintenta en el bloque.
  const topeLlamadaMs = Number(process.env.VOZA_TOPE_LLAMADA_MS ?? 12 * 60_000);
  let ll: any; try { ll = await Promise.race([correrLlamada(e, phone), new Promise<never>((_, no) => setTimeout(() => no(new Error(`tope_llamada_${topeLlamadaMs}ms`)), topeLlamadaMs).unref())]); } catch (x) { rec.excepcion = true; rec.infra = { motivo: "excepcion", erroresApi: erroresApi - api0 }; rec.veredicto = "FALLA"; rec.motivo = String((x as Error).message).slice(0, 300); results.push(rec); guardar(); console.log("EXCEPCION", e.id, rec.motivo); continue; }
  await esperar(4000); const el1 = await creditosEl();
  // Costo por componente que el worker registro en la API local (core.usage_cost_event de la base efimera): solo los eventos nuevos de esta llamada.
  const costoRows = (await s.pool.query("select id::text, proveedor, unidad, cantidad::float cantidad, costo_micro_usd::float micro, costo_estimado from core.usage_cost_event")).rows.filter((x: any) => !costosVistos.has(x.id));
  for (const x of costoRows) costosVistos.add(x.id);
  const orders = (await s.pool.query("select total::float total, canal, items, customer_address from restaurantes.orders where customer_phone like $1", [`%${ph10}`])).rows;
  const callbacks = (await s.pool.query("select reason from restaurantes.callback_requests where customer_phone like $1", [`%${ph10}`])).rows;
  const agenteTexto = ll.registro.filter((x: any) => x.quien === "agente").map((x: any) => x.texto).join(" ");
  const hard = e.checks.map((c) => evaluar(c, { orders, callbacks, agenteTexto })).filter((x): x is string => x !== null);
  const evs = eventos.slice(ev0);
  // JUEZ ENDURECIDO (VZ01 aprobado con «queda registrado» antes de crear): una frase del agente que AFIRMA el registro en un turno que termino ANTES de que
  // crear_pedido respondiera con exito (o sin pedido) es falla determinista, diga lo que diga el juez.
  const crearOk = evs.find((x) => x.evento === "tool" && x.campos?.herramienta === "crear_pedido" && x.campos?.ok === true)?.tp ?? null;
  for (const t of ll.registro) {
    if (t.quien !== "agente" || !t.texto) continue;
    const afirma = String(t.texto).split(/(?<=[.!?])\s+/).some((f: string) => afirmaPedidoRegistrado(f));
    if (afirma && (crearOk === null || (t.tp1 !== null && t.tp1 < crearOk))) { hard.push("afirmo el registro antes de que crear_pedido tuviera exito"); break; }
  }
  const v2llm = evs.filter((x) => x.evento === "v2_llm").map((x) => x.campos);
  const trTxt = ll.registro.map((x: any) => x.quien === "cliente" ? `CLIENTE: ${x.dicho}` : `AGENTE (transcrito): ${x.texto}`).join("\n").slice(0, 9000);
  const usr = `ESCENARIO ${e.id}: ${e.titulo}\nDEBE: ${e.debe}\nNO DEBE: ${e.noDebe}\nRESULTADO: ${ll.resumen?.resultado}\nTRANSCRIPCION:\n${trTxt}\nBD: pedidos=${JSON.stringify(orders.map((o: any) => ({ total: o.total, canal: o.canal, direccion: o.customer_address, items: o.items.map((i: any) => `${i.quantity}x ${i.name}@${i.price}`) })))}; callbacks=${JSON.stringify(callbacks.map((c: any) => c.reason))}\nFALLAS DETERMINISTAS: ${hard.join(" ; ") || "ninguna"}\nEVENTOS: ${evs.filter((x) => x.evento === "tool").map((x) => `${x.campos?.herramienta}:${x.campos?.ok ? "ok" : "error"}`).join(", ")}`;
  let jr: any = { veredicto: "PARCIAL", motivo: "juez sin respuesta", causa: "juez" };
  for (let i = 0; i < 3; i += 1) { try { const out = await chat([{ role: "system", content: JUEZ_SYS }, { role: "user", content: usr }], { max: 1500, json: true, model: JUEZ }); const m = /\{[\s\S]*\}/.exec(out); const j = JSON.parse(m ? m[0] : out); if (typeof j.veredicto === "string") { jr = j; break; } } catch { /* */ } }
  Object.assign(rec, {
    veredicto: hard.length === 0 && jr.veredicto === "PASA" ? "PASA" : "FALLA", juez: jr.veredicto, motivo: jr.motivo, causa: jr.causa, hard,
    resultado: ll.resumen?.resultado ?? null, costoWorkerMicroUsd: ll.resumen?.costoMicroUsd ?? null, durS: Math.round(ll.durS * 10) / 10,
    latenciasMs: ll.latencias, latenciasRespuestaMs: ll.latenciasRespuesta, latenciasWorkerMs: ll.resumen?.latenciasMs ?? [], turnosCliente: ll.registro.filter((x: any) => x.quien === "cliente").length,
    pedidos: orders.map((o: any) => ({ total: o.total, canal: o.canal, items: o.items.map((i: any) => `${i.quantity}x ${i.name}@${i.price}`) })), callbacks: callbacks.map((c: any) => c.reason),
    llm: v2llm.map((c) => ({ m: c.proveedor, ttft: c.ttftMs, ti: c.tokensEntrada, to: c.tokensSalida })), respaldos: evs.filter((x) => x.evento === "v2_respaldo" || x.evento === "v2_llm_respaldo").map((x) => `${x.evento}:${x.campos?.proveedor ?? ""}:${x.campos?.motivo ?? ""}`),
    caidas: evs.filter((x) => /caida/.test(x.evento)).map((x) => `${x.evento}:${x.campos?.codigo ?? ""}`), turnos: ll.registro,
    compuerta: evs.filter((x) => /^v2_(crear|escalar|registro|resumen|confirmacion|frase_espera|stt_descartado|reglas|asentimiento)/.test(x.evento) || x.evento === "tool" || /^consentimiento/.test(x.evento)).map((x) => `${x.evento}:${x.campos?.herramienta ?? x.campos?.motivo ?? x.campos?.resultado ?? ""}${x.evento === "tool" ? (x.campos?.ok ? ":ok" : ":err") : ""}`),
    llmMs: evs.filter((x) => x.evento === "v2_llm").map((x) => ({ m: x.campos.proveedor, ms: x.campos.ms, ttft: x.campos.ttftMs ?? null, ti: x.campos.tokensEntrada, tc: x.campos.tokensCache ?? null })),
    krisp: env.VOZ_RUIDO, etiqueta: ETQ, carga: [Math.round(carga0 * 10) / 10, Math.round(loadavg()[0]! * 10) / 10],
    costoComponentes: costoRows.map((x: any) => ({ p: x.proveedor, u: x.unidad, n: x.cantidad, usd: x.micro / 1e6, est: x.costo_estimado })),
    creditosEl: el0 !== null && el1 !== null ? el1 - el0 : null, clienteJuezUsd: Math.round((gasto.usd - cj0) * 1e6) / 1e6,
    primerAudioWorker: evs.filter((x) => x.evento === "v2_primer_audio").map((x) => x.campos.ms),
    // Diagnostico: TODOS los eventos del worker de esta llamada (sin PII por diseño: codigos, conteos y tiempos) con ms desde el inicio de la llamada.
    eventos: evs.map((x) => ({ e: x.evento, dt: Math.round(x.tp - tp0), ...(x.campos && Object.keys(x.campos).length ? { c: x.campos } : {}) })),
    infra: erroresApi - api0 > 0 ? { motivo: "api_local", erroresApi: erroresApi - api0 } : null,
  });
  if ((rec.veredicto === "FALLA" && FALLAS_DIR) || (GRABAR_DIR && grabarRestantes > 0)) {
    const dir = rec.veredicto === "FALLA" && FALLAS_DIR ? FALLAS_DIR : GRABAR_DIR; if (dir === GRABAR_DIR) grabarRestantes -= 1;
    mkdirSync(dir, { recursive: true }); const ruta = `${dir}/e2e-${ETQ}-${e.id}-rep${REP}.wav`;
    try { ll.grabar(ruta); rec.grabacion = ruta; } catch (x) { rec.grabacion = `error: ${String((x as Error).message).slice(0, 80)}`; }
  }
  results.push(rec); guardar();
  const l = [...ll.latencias].sort((a, b) => a - b);
  console.log(`${rec.veredicto} ${e.id} [juez ${jr.veredicto}] res=${rec.resultado} dur=${rec.durS}s turnos=${rec.turnosCliente} lat_p50=${l[Math.floor((l.length - 1) / 2)] ?? "-"}ms costoWorker=$${((rec.costoWorkerMicroUsd ?? 0) / 1e6).toFixed(4)} | ${String(jr.motivo ?? "").slice(0, 140)}${hard.length ? " | HARD: " + hard.join("; ").slice(0, 200) : ""}`);
}
await esperar(20_000); const elFin = await creditosEl();
appendFileSync(`${ARCHIVO}.gasto.jsonl`, JSON.stringify({ rep: REP, clienteJuezUsd: gasto.usd, creditosElCorrida: elInicio !== null && elFin !== null ? elFin - elInicio : null, ts: new RealDate().toISOString() }) + "\n");
await worker.detener(); await s.stop();
process.exit(0);
