/* eslint-disable @typescript-eslint/no-explicit-any -- script de medicion: las dependencias del directorio de QA se importan dinamicamente y no tienen tipos */
// Arnes de voz con AUDIO REAL de extremo a extremo (sin red telefonica). Reemplaza el atajo de `voz-medicion-real/ejecutar.ts`, donde el cliente "hablaba" entregando texto como
// si fuera el final del STT. Aqui cada turno del cliente se SINTETIZA a audio (Deepgram TTS, voz distinta de la del agente, PCM16 16 kHz), opcionalmente se pasa por una linea
// telefonica sintetica (banda 300-3400 Hz, mu-law 8 kHz ida y vuelta, ruido de fondo) y se manda en streaming y en tiempo real al STT REAL del motor (Nova-3 es-419, endpointing y
// keyterms de config-plataforma.ts). Lo que el agente "oye" es lo que Deepgram transcribe; su respuesta pasa por el TTS REAL (Aura-2) y se mide fin-de-voz -> primer audio.
// El resto (controlador, sesion de la cascada v2, LLM real por OpenRouter, herramientas HTTP, Postgres efimero, cliente-LLM, juez, checks) es identico al arnes de texto.
//
// Uso (ver README.md): VOZ_QA_DIR=<qa> OPENROUTER_API_KEY=... [VOZA_RUIDO=0|1|2|3] [VOZA_TOPE_USD=1] [VOZA_TOPE_AUDIO_S=1800] [VOZA_TOPE_LLAMADA_S=240] [VOZ_FILTRO=^P01$] vite-node -c ... ejecutar-audio.ts
// Las llaves llegan por variable de entorno (correr-audio.sh las exporta desde ~/.atiende-secrets); NUNCA se imprimen ni se escriben en los resultados.
// Sale con codigo 3 si se corto por un tope (gasto de Deepgram, audio, OpenRouter): volver a lanzar con el mismo VOZ_REP continua donde se quedo.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { DATOS_POR_OMISION, ESCENARIOS, RELOJES } from "../voz-medicion-real/escenarios.ts";
import type { Chk, Escenario, Evento } from "../voz-medicion-real/escenarios.ts";
import { cortarMensaje, rngDesdeSemilla } from "../voz-medicion-real/ruido-stt.ts";
import { EstadoLlamada, envolverStt, envolverTts, sintetizarCliente, vocabularioMenu } from "./adaptadores.ts";
import { GastoDeepgram, TopeExcedido } from "./gasto.ts";
import { resumenTurnos } from "./metricas.ts";
import type { TurnoAudio } from "./metricas.ts";
import { HZ_CLIENTE, concatenar, duracionS, pcmABytes, recortarSilencios, silencio, trozos } from "./pcm.ts";
import { lineaTelefonica } from "./telefonia.ts";
import { erroresNumeros, erroresTerminos, esDireccion, normalizar, wer } from "./wer.ts";

const QA = process.env.VOZ_QA_DIR;
if (!QA) throw new Error("Falta VOZ_QA_DIR (directorio con stack.ts, lib.ts, llm.ts).");
const { startStack, setClock, PROP } = await import(`${QA}/stack.ts`);
const { chat, usoRealOpenRouter, gasto } = await import(`${QA}/llm.ts`);
const { nextClientMsg } = await import(`${QA}/lib.ts`);
const { motivoPrecioInvalido } = await import(`${QA}/inv-precio.ts`);
const P = new URL("../../packages", import.meta.url).pathname;
const { ControladorLlamada } = await import(`${P}/voice-core/src/llamada/controlador.ts`);
const { LIMITES_POR_DEFECTO } = await import(`${P}/voice-core/src/llamada/maquina.ts`);
const { crearEjecutorTools } = await import(`${P}/voice-core/src/llamada/ejecutor-tools.ts`);
const { extraerTelefonoSipFrom } = await import(`${P}/voice-core/src/llamada/sip.ts`);
const { crearProveedorCascadaV2, crearSttDeepgram, crearTtsDeepgram, resolverVozAura2, crearSttElevenLabs, crearTtsElevenLabs, sttConRespaldo, ttsConRespaldo } = await import(`${P}/voice-core/src/llamada/cascada-v2/index.ts`);
const { VOZ_PLATAFORMA } = await import(`${P}/voice-core/src/config-plataforma.ts`);
const { crearPuertoLlmVozV2 } = await import(`${P}/../apps/voice-worker/src/llm-openrouter.ts`);
const { REGISTRO_TOOLS_PM, HERRAMIENTAS_VOZ_SOLO_LECTURA } = await import(`${P}/domain-restaurantes/src/voz/llamada/ejecutor-tools.ts`);
const { REGLAS_CIERRE_PM } = await import(`${P}/domain-restaurantes/src/voz/llamada/maquina.ts`);
const { VOICE_TOOL_HTTP_PATHS } = await import(`${P}/domain-restaurantes/src/agent-tools/registry.ts`);
const { canonicalizeMexicanPhone } = await import(`${P}/domain-restaurantes/src/phone.ts`);

const REP = process.env.VOZ_REP ?? "1";
const CORTE = Number(process.env.VOZ_CORTE_USD ?? "1.5");
const MODELO = process.env.VOZ_MODELO || VOZ_PLATAFORMA.cascadaV2.llm.modelo;
const ESFUERZO = (process.env.VOZ_ESFUERZO as "low" | "medium" | "high" | undefined) ?? VOZ_PLATAFORMA.cascadaV2.llm.esfuerzo;
// Ruido de AUDIO: 0 = limpio; 1 = linea telefonica (banda 300-3400 Hz + mu-law 8 kHz); 2 = linea + ruido de fondo SNR 20 dB; 3 = linea + ruido SNR 10 dB (cocina/calle).
const NIVEL_RUIDO = Number(process.env.VOZA_RUIDO ?? "0");
const SNR_DB: Record<number, number | undefined> = { 2: 20, 3: 10 };
const COLA_MS = Number(process.env.VOZA_COLA_MS ?? "1200");        // silencio tras la voz del cliente para que el endpointing cierre el turno
const REACCION_MS = Number(process.env.VOZA_REACCION_MS ?? "350"); // pausa humana tras terminar de oir al agente
const VOZ_CLIENTE = process.env.VOZA_VOZ_CLIENTE ?? "aura-2-javier-es"; // distinta de la del agente (aura-2-estrella-es)
const llaveDg = (process.env.DEEPGRAM_API_KEY ?? "").trim(); // la exporta correr-audio.sh (este proceso no lee archivos de llaves)
if (!llaveDg) throw new Error("falta DEEPGRAM_API_KEY (correr con correr-audio.sh)");
const CFG_DG = VOZ_PLATAFORMA.cascadaV2.deepgram;
// STACK de PM (PR #719): ElevenLabs Scribe RT + v4 Turbo con Deepgram de respaldo. VOZA_STACK=deepgram mide el stack anterior.
const STACK = process.env.VOZA_STACK ?? "elevenlabs";
const llaveEl = (process.env.ELEVENLABS_API_KEY ?? "").trim();
if (STACK === "elevenlabs" && !llaveEl) throw new Error("falta la llave de ElevenLabs");
const CFG_EL = VOZ_PLATAFORMA.cascadaV2.elevenlabs;
const dg = new GastoDeepgram(
  STACK === "elevenlabs"
    ? { sttUsdPorMinuto: CFG_EL.stt.usdPorHora / 60, keytermUsdPorMinuto: CFG_EL.stt.usdPorHoraKeyterms / 60, ttsUsdPorMilCaracteres: CFG_EL.tts.usdPorMilCaracteres }
    : { sttUsdPorMinuto: CFG_DG.usdPorMinuto, keytermUsdPorMinuto: CFG_DG.usdPorMinutoKeyterms, ttsUsdPorMilCaracteres: VOZ_PLATAFORMA.cascadaV2.deepgramAura2.usdPorMilCaracteres },
  { usd: Number(process.env.VOZA_TOPE_USD ?? "1"), audioS: Number(process.env.VOZA_TOPE_AUDIO_S ?? "1800"), llamadaS: Number(process.env.VOZA_TOPE_LLAMADA_S ?? "240") },
);
const FILTRO = process.env.VOZ_FILTRO ? new RegExp(process.env.VOZ_FILTRO) : null;
const JUEZ = process.env.VOZ_JUEZ ?? "anthropic/claude-haiku-5.5";
const SIN_COMPUERTA = process.env.VOZ_SIN_COMPUERTA === "1";
const RES = process.env.VOZ_RES_DIR ?? `${QA}/results`;
mkdirSync(RES, { recursive: true });
const ARCHIVO = `${RES}/voz-audio-${process.env.VOZ_ETQ ?? "main"}-rep${REP}.json`;

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("falta OPENROUTER_API_KEY en el entorno");

const s = await startStack();
const org = "los-taquitos-de-pm";
const HDR_TOOL: Record<string, string> = { "content-type": "application/json", "x-atiende-tool-secret": "qa-voice-tool-secret-local" };
const HDR_INT: Record<string, string> = { "content-type": "application/json", "x-atiende-internal-secret": "qa-internal-secret-local" };
const SLUG = { T1: "prol-montejo", T3: "pensiones", T7: "garcia-lavin" } as const;
const ORG_ID = "f838fd2c-967e-46fd-af8d-e0229b15748d";
const VOCAB: string[] = await (async () => { try { return vocabularioMenu((await s.pool.query("select distinct name from restaurantes.products where name is not null order by name")).rows.map((r: any) => r.name)); } catch { return []; } })();
if (process.env.VOZA_SIN_KEYTERMS === "1") VOCAB.length = 0; // control: el controlador del repo NO manda `vocabulario` al STT (ver README); por omision se manda el menu, como pide la config
const priceMap = new Map<string, number>();
for (const r of (await s.pool.query("select property_id, product_id, price::float p from restaurantes.branch_products")).rows) priceMap.set(`${r.property_id}:${r.product_id}`, r.p);

// ---- LLM de la cascada: el puerto del worker, SIN tocar su enrutamiento (ZDR) ----
// VOZ_SIN_ZDR=1: SOLO para modelos baratos sin endpoint de retencion cero (control de costo); la medicion oficial va con el enrutamiento de produccion.
const fetchSinZdr: typeof fetch | undefined = process.env.VOZ_SIN_ZDR === "1"
  ? (async (url: any, init: any) => { try { const b = JSON.parse(String(init?.body)); if (b.provider) { delete b.provider.zdr; delete b.provider.only; b.provider.data_collection = "deny"; } b.usage = { include: true }; return fetch(url, { ...init, body: JSON.stringify(b) }); } catch { return fetch(url, init); } }) as typeof fetch
  : undefined;
const llmPuerto = crearPuertoLlmVozV2(key, fetchSinZdr, { modelo: MODELO, config: { ...VOZ_PLATAFORMA, cascadaV2: { ...VOZ_PLATAFORMA.cascadaV2, llm: { ...VOZ_PLATAFORMA.cascadaV2.llm, esfuerzo: ESFUERZO } } } });

// ---- STT y TTS REALES (Deepgram) envueltos solo para medir; el motor los usa exactamente como en produccion ----
const respaldos: string[] = [];
const avisoRespaldo = (etapa: string, momento: string, codigo: string) => void respaldos.push(`${etapa}:${momento}:${codigo}`);
const sttDg = crearSttDeepgram({ apiKey: llaveDg, config: CFG_DG });
const ttsDg = crearTtsDeepgram({ apiKey: llaveDg, config: VOZ_PLATAFORMA.cascadaV2.deepgramAura2 });
const sttReal = STACK === "elevenlabs" ? sttConRespaldo(crearSttElevenLabs({ apiKey: llaveEl, config: CFG_EL.stt }), sttDg, avisoRespaldo) : sttDg;
const ttsReal = STACK === "elevenlabs" ? ttsConRespaldo(crearTtsElevenLabs({ apiKey: llaveEl, config: CFG_EL.tts }), ttsDg, VOZ_PLATAFORMA.cascadaV2.deepgramAura2.voz, avisoRespaldo) : ttsDg;
// Cama de ruido de restaurante (la misma de PRUEBAS-STT-TTS-NOV: platica de cocina, golpes, zumbido; 8 kHz) para VOZA_RUIDO=4.
const CAMA: Int16Array | null = (() => {
  const f = process.env.VOZA_CAMA_RESTAURANTE; if (!f) return null;
  const b = readFileSync(f); let i = 12; let hz = 8000;
  while (i < b.length) { const id = b.toString("ascii", i, i + 4); const n = b.readUInt32LE(i + 4); if (id === "fmt ") hz = b.readUInt32LE(i + 12); if (id === "data") { const d = new Int16Array(b.buffer.slice(b.byteOffset + i + 8, b.byteOffset + i + 8 + n)); if (hz === 16000) return d; const o = new Int16Array(d.length * 2); for (let k = 0; k < d.length; k += 1) { o[2 * k] = d[k]!; o[2 * k + 1] = k + 1 < d.length ? (d[k]! + d[k + 1]!) >> 1 : d[k]!; } return o; } i += 8 + n + (n % 2); }
  return null;
})();
const SNR_CAMA = Number(process.env.VOZA_SNR_DB ?? "10");
let ultimaGananciaCama = 0.3;
function mezclarCama(pcm: Int16Array, rng: () => number): Int16Array {
  if (!CAMA) return pcm;
  const activo = (() => { let mx = 0; for (let k = 0; k + 320 <= pcm.length; k += 320) { let e = 0; for (let j = k; j < k + 320; j += 1) e += pcm[j]! * pcm[j]!; mx = Math.max(mx, Math.sqrt(e / 320)); } let e2 = 0; let c = 0; for (let k = 0; k + 320 <= pcm.length; k += 320) { let e = 0; for (let j = k; j < k + 320; j += 1) e += pcm[j]! * pcm[j]!; const r0 = Math.sqrt(e / 320); if (r0 > 0.1 * mx) { e2 += e; c += 320; } } return c ? Math.sqrt(e2 / c) : 1000; })();
  const off = Math.floor(rng() * Math.max(1, CAMA.length - pcm.length));
  let er = 0; for (let k = 0; k < pcm.length; k += 1) { const v = CAMA[(off + k) % CAMA.length]!; er += v * v; }
  const rmsR = Math.sqrt(er / pcm.length) || 1;
  const g = activo / (rmsR * 10 ** (SNR_CAMA / 20));
  ultimaGananciaCama = g;
  const o = new Int16Array(pcm.length);
  for (let k = 0; k < pcm.length; k += 1) o[k] = Math.max(-32768, Math.min(32767, Math.round(pcm[k]! + CAMA[(off + k) % CAMA.length]! * g)));
  return o;
}
// Grabaciones para escuchar: estereo 16 kHz, izquierda = lo que entra al STT (cliente con linea/ruido), derecha = la voz del agente.
const GRABAR_DIR = process.env.VOZA_GRABAR_DIR ?? ""; let grabarRestantes = Number(process.env.VOZA_GRABAR_N ?? "0");
function escribirWavEstereo(ruta: string, izq: Int16Array, der: Int16Array): void {
  const n = Math.max(izq.length, der.length); const b = Buffer.alloc(44 + n * 4);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 4, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(64000, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 4, 40);
  for (let k = 0; k < n; k += 1) { b.writeInt16LE(izq[k] ?? 0, 44 + k * 4); b.writeInt16LE(der[k] ?? 0, 46 + k * 4); }
  writeFileSync(ruta, b);
}
const esperarHasta = (t: number) => new Promise<void>((r) => { const d = t - performance.now(); if (d <= 0) r(); else setTimeout(r, d); });

interface TurnoRegistro { quien: "cliente" | "agente" | "sistema"; dicho?: string; oido?: string; cambios?: readonly string[]; texto?: string; msPrimeraFrase?: number | null; msTurno?: number; herramientas?: string[] }

async function correrLlamada(e: Escenario, phone: string, instruccion: string, voiceId: string, semilla: string) {
  const mundo = { organizationId: ORG_ID, propertyId: PROP[e.sucursal], callbacks: [] };
  const lat: number[] = [];
  const callId = `vm-${e.id}-${Date.now()}`;
  const tk = (await (await fetch(`${s.api}/v1/restaurantes/${org}/voice/call-token`, { method: "POST", headers: HDR_TOOL, body: JSON.stringify({ call_id: callId, caller_phone: phone, branch_slug: SLUG[e.sucursal] }) })).json()) as { call_token: string };
  const hdr = { ...HDR_TOOL, "x-atiende-call-token": tk.call_token };
  const transporte = async (nombre: string, args: Record<string, unknown>, senal: AbortSignal) => {
    const t0 = Date.now();
    const r = await fetch(`${s.api}/v1/restaurantes/${org}${(VOICE_TOOL_HTTP_PATHS as Record<string, string>)[nombre]}`, { method: "POST", headers: hdr, body: JSON.stringify(args), signal: senal });
    const txt = await r.text(); let body: any; try { body = JSON.parse(txt); } catch { body = { error: txt.slice(0, 200) }; }
    lat.push(Date.now() - t0);
    return { resultado: r.status >= 400 ? { error: body.message ?? body.error ?? `HTTP ${r.status}` } : body, entidadId: nombre === "crear_pedido" ? body?.order?.id ?? null : null };
  };
  const S = new EstadoLlamada();
  const grab = GRABAR_DIR && grabarRestantes > 0 ? { t0: performance.now(), cliente: [] as { t: number; pcm: Int16Array }[], agente: [] as { t: number; pcm: Uint8Array }[] } : null;
  if (grab) grabarRestantes -= 1;
  dg.nuevaLlamada();
  const v2log: { evento: string; campos: any }[] = [];
  const base = crearProveedorCascadaV2({
    deepgramApiKey: null, ...(STACK === "elevenlabs" ? { elevenlabsApiKey: llaveEl } : {}), llm: llmPuerto,
    // Cerebro de dos niveles de PM (lo que el worker enciende con VOZ_CEREBRO_DOS_NIVELES=1); VOZA_DOS_NIVELES=0 mide el cerebro por omision.
    ...(process.env.VOZA_DOS_NIVELES !== "0" ? { modeloLlm: VOZ_PLATAFORMA.cascadaV2.llm.dosNiveles.modelo, modeloRapido: VOZ_PLATAFORMA.cascadaV2.llm.dosNiveles.modeloRapido, plazoLlm: { plazoMs: VOZ_PLATAFORMA.cascadaV2.llm.dosNiveles.plazoPrimerTokenMs, modeloRespaldo: VOZ_PLATAFORMA.cascadaV2.llm.dosNiveles.modeloRespaldo } } : {}),
    ...(process.env.VOZ_MODELO ? { modeloLlm: MODELO } : {}), stt: envolverStt(sttReal, S, () => performance.now()) as never, tts: envolverTts(ttsReal, S, () => performance.now(), (n) => dg.tts(n)) as never, herramientasEnParalelo: HERRAMIENTAS_VOZ_SOLO_LECTURA,
    ...(SIN_COMPUERTA ? {} : { confirmacionAntesDeCrear: { confirmar: "confirmar_resumen", crear: "crear_pedido" } }),
    log: (l: any) => { v2log.push(l); if (process.env.VOZA_DEBUG) console.error(`[dbg ${Math.round(performance.now())}] ${l.evento} ${JSON.stringify(l.campos)}`); },
  });
  const costo = { micro: 0, real: true, tokIn: 0, tokOut: 0 };
  let ses: any = null;
  const abrirSesion = (ap: any, h: any) => base.abrirSesion(VOCAB.length ? { ...ap, vocabulario: VOCAB } : ap, {
    ...h,
    // Audio del agente tal como saldria a la sala: se anota el primer audio y el reloj de reproduccion (24 kHz PCM16) para que el cliente espere a que termine de hablar.
    audioAgente: (pcm: Uint8Array) => { const t = performance.now(); if (grab) grab.agente.push({ t, pcm: pcm.slice() }); const ms = (pcm.byteLength / 2 / VOZ_PLATAFORMA.cascadaV2.deepgramAura2.hzSalida) * 1000; S.audioAgente.push({ t, ms }); S.cabezalMs = Math.max(S.cabezalMs, t) + ms; h.audioAgente?.(pcm); },
    interrumpido: () => { S.interrupciones += 1; S.cabezalMs = performance.now(); h.interrumpido(); },
    costo: (m: number, real?: boolean, comp?: any) => { if (comp?.proveedor?.startsWith("openrouter")) { costo.micro += m; if (real === false) costo.real = false; } else if (comp?.proveedor === "deepgram" || comp?.proveedor === "elevenlabs") S.costoMotorMicro.stt += m; else if (comp?.proveedor === "deepgram-aura-2" || comp?.proveedor === "elevenlabs-tts") S.costoMotorMicro.tts += m; h.costo?.(m, real, comp); },
  }).then((x: any) => { ses = x; return x; });
  const limites = { ...LIMITES_POR_DEFECTO };
  const tools: any[] = []; const pregrabados: any[] = []; const logs: any[] = []; const kpi: any[] = [];
  const ctrl = new ControladorLlamada({
    callId, reglas: REGLAS_CIERRE_PM,
    construirEscalacion: (motivo: string, resumen: string) => ({ nombre: "escalar_a_humano", args: { customer_name: "Cliente", motivo, resumen } }),
    propertyId: mundo.propertyId, organizationId: mundo.organizationId,
    abrirSesion, ejecutor: crearEjecutorTools({ registro: REGISTRO_TOOLS_PM, transporte: transporte as never, timeoutMs: limites.toolTimeoutMs }),
    instruccion, voiceId, limites, reproducir: (m: any) => void pregrabados.push(m), cortarAudio: () => undefined, log: (l: any) => void logs.push(l), kpi: (k: any) => void kpi.push(k), dormir: async () => undefined, trazarTool: (t: any) => void tools.push(t),
  });
  void extraerTelefonoSipFrom; void canonicalizeMexicanPhone;
  const rng = rngDesdeSemilla(semilla);
  const registro: TurnoRegistro[] = [];
  const histCliente: { who: "cliente" | "agente"; text: string }[] = [];
  const { iniciada } = await ctrl.iniciar({ habilitado: true, gastoMesMicroUsd: 0, topeMensualMicroUsd: null });
  // Linea telefonica CONTINUA entre turnos del cliente (como una llamada real: el STT siempre recibe audio): silencio, o la cama de ruido con VOZA_RUIDO=4.
  let lineaViva = true; let clienteHablando = false; let posCama = 0;
  void (async () => {
    const t0l = performance.now(); let k = 0;
    while (lineaViva) {
      if (!clienteHablando && ses) {
        const f = new Int16Array(320);
        if (NIVEL_RUIDO === 4 && CAMA) { for (let j = 0; j < 320; j += 1) f[j] = Math.max(-32768, Math.min(32767, Math.round(CAMA[(posCama + j) % CAMA.length]! * ultimaGananciaCama))); posCama = (posCama + 320) % CAMA.length; }
        try { ses.enviarAudio(pcmABytes(f)); dg.audioStt(320 / HZ_CLIENTE, VOCAB.length > 0); } catch { /* sesion cerrada */ }
      }
      k += 1; const d = t0l + k * 20 - performance.now(); await new Promise((r) => setTimeout(r, Math.max(0, d)));
    }
  })();
  const sincronizar = async () => { await base.inactivo(); await ctrl.vacio(); await base.inactivo(); await ctrl.vacio(); };
  const ultimoAgente = () => { const tr = ctrl.transcripcion as { rol: string; texto: string }[]; let i = tr.length - 1; const ps: string[] = []; while (i >= 0 && tr[i]!.rol !== "cliente") { if (tr[i]!.rol === "agente") ps.unshift(tr[i]!.texto); i -= 1; } return ps.join(" ").replace(/\s+/g, " ").trim(); };
  const guion = e.turnos.filter((t): t is string => typeof t === "string");
  let gi = 0; let extra = 0;
  const datos = e.datos ?? DATOS_POR_OMISION;

  const turnosAudio: TurnoAudio[] = [];
  const hablar = async (dicho: string, opciones: { interrumpe?: boolean } = {}) => {
    const nTools0 = tools.length;
    // 1. Voz del cliente: TTS real (voz distinta), recorte de silencios, cola de silencio para el endpointing y, si toca, linea telefonica.
    const voz = recortarSilencios(await sintetizarCliente(llaveDg, VOZ_CLIENTE === resolverVozAura2(voiceId, "") ? "aura-2-luciano-es" : VOZ_CLIENTE, dicho));
    dg.tts(dicho.length);
    if (voz.length === 0) throw new Error("el TTS del cliente devolvio silencio");
    const LEAD_MS = 150;
    let pcm = concatenar(silencio(LEAD_MS), voz, silencio(COLA_MS));
    if (NIVEL_RUIDO === 4 && !e.sinRuido) pcm = lineaTelefonica(mezclarCama(pcm, rng), rng);
    else if (NIVEL_RUIDO > 0 && !e.sinRuido) { const snr = SNR_DB[NIVEL_RUIDO]; pcm = lineaTelefonica(pcm, rng, snr === undefined ? undefined : { snrDb: snr }); }
    const finVozMs = LEAD_MS + (voz.length / HZ_CLIENTE) * 1000;
    // 2. Cuando habla: tras oir al agente completo (+ reaccion), o a media frase del agente si es una interrupcion (barge-in real con la logica del motor).
    const t0Ref = performance.now();
    if (opciones.interrumpe) await esperarHasta(Math.max(t0Ref, (S.audioAgente.at(-1)?.t ?? t0Ref) + 600));
    else await esperarHasta(S.cabezalMs + REACCION_MS);
    // 3. Streaming en tiempo real (trozos de 20 ms) por el camino real de la sesion: ses.enviarAudio -> STT.
    const n0 = S.finales.length; const nFrases0 = S.frases.length;
    const frames = trozos(pcm); const conKeyterms = VOCAB.length > 0;
    const t0 = performance.now(); const idxFin = Math.ceil(finVozMs / 20); let tFinVoz = t0 + finVozMs;
    if (grab) grab.cliente.push({ t: t0, pcm });
    clienteHablando = true;
    for (let i = 0; i < frames.length; i += 1) {
      await esperarHasta(t0 + i * 20);
      ses.enviarAudio(pcmABytes(frames[i]!)); dg.audioStt(frames[i]!.length / HZ_CLIENTE, conKeyterms);
      if (i === idxFin) tFinVoz = performance.now();
    }
    clienteHablando = false;
    // 4. Espera del final del STT (si no llega, el turno se pierde: el agente no oye nada, igual que en vivo).
    const limite = performance.now() + 8000;
    while (S.finales.length === n0 && performance.now() < limite) await new Promise((r) => setTimeout(r, 15));
    await sincronizar();
    for (let k = 0; k < 2; k += 1) { const n = S.finales.length; await new Promise((r) => setTimeout(r, 350)); if (S.finales.length > n) await sincronizar(); }
    const t1 = performance.now();
    const fin = S.finales.slice(n0); const oido = fin.map((f) => f.texto).join(" ").trim();
    const tFinal = fin[0]?.t ?? null;
    const frase = S.frases.slice(nFrases0).find((f) => tFinal !== null && f.tCall >= tFinal) ?? null;
    const audio1 = tFinal === null ? null : S.audioAgente.find((a) => a.t >= tFinal) ?? null;
    const r = (x: number | null) => (x === null ? null : Math.round(x));
    const w = wer(normalizar(dicho), normalizar(oido));
    const num = erroresNumeros(normalizar(dicho), normalizar(oido)); const ter = erroresTerminos(dicho, oido, VOCAB);
    turnosAudio.push({
      dicho, oido, audioS: Math.round(duracionS(pcm) * 100) / 100,
      sttMs: tFinal === null ? null : r(tFinal - tFinVoz), llmMs: tFinal === null || !frase ? null : r(frase.tCall - tFinal), ttsMs: frase?.tChunk ? r(frase.tChunk - frase.tCall) : null,
      totalMs: audio1 ? r(audio1.t - tFinVoz) : null, finales: fin.length, wer: { s: w.sustituciones, d: w.borrados, i: w.insertados, n: w.n }, numeros: { n: num.n, errores: num.errores }, terminos: { n: ter.n, errores: ter.errores }, direccion: esDireccion(dicho),
    });
    const agente = ultimoAgente();
    registro.push({ quien: "cliente", dicho, oido: oido || "(el STT no entrego nada)", cambios: [] });
    registro.push({ quien: "agente", texto: agente || "(silencio del agente)", msPrimeraFrase: audio1 ? r(audio1.t - tFinVoz) : null, msTurno: Math.round(t1 - tFinVoz), herramientas: tools.slice(nTools0).map((t: any) => t.nombre) });
    histCliente.push({ who: "cliente", text: dicho }, { who: "agente", text: agente || "(silencio del agente)" });
  };
  const generar = async (intenciones: readonly string[]) => {
    const persona = { goal: `Llamas por telefono a una taqueria: ${e.titulo}. Hablas como en una llamada: frases cortas, sin escribir cifras ni signos raros.`, hints: intenciones, datos };
    const { msg } = await nextClientMsg(persona, histCliente as never, histCliente.length === 0, "voz");
    const limpio = (msg ?? "").replace(/\s+/g, " ").trim();
    return limpio || "Hola";
  };

  if (iniciada) {
    for (let k = 0; k < e.turnos.length && ctrl.maquina.estadoActual !== "cerrada"; k += 1) {
      const t = e.turnos[k]!;
      if (typeof t === "string") { await hablar(await generar(guion.slice(gi, gi + 3))); gi += 1; continue; }
      const ev = t as Evento;
      if (ev.k === "interrumpe") await hablar(ev.dice, { interrumpe: true });
      else if (ev.k === "cortada") await hablar(cortarMensaje(ev.dice, rng));
      else if (ev.k === "ruido") { await ctrl.ruido(); registro.push({ quien: "sistema", texto: "(ruido)" }); await sincronizar(); }
      else if (ev.k === "no_entendido") { await ctrl.noEntendido(); registro.push({ quien: "sistema", texto: "(no se entiende lo que dice)" }); await sincronizar(); }
      else if (ev.k === "silencio") {
        const n0 = (ctrl.transcripcion as unknown[]).length;
        await ctrl.silencio(ev.ms); await sincronizar();
        registro.push({ quien: "sistema", texto: `(silencio ${ev.ms / 1000}s)` });
        const tr = (ctrl.transcripcion as { rol: string; texto: string }[]).slice(n0).filter((x) => x.rol === "agente").map((x) => x.texto).join(" ");
        if (tr) registro.push({ quien: "agente", texto: tr });
      } else if (ev.k === "cuelga") { await ctrl.clienteCuelga(); registro.push({ quien: "sistema", texto: "(cuelga)" }); }
    }
    while (e.sigue && ctrl.maquina.estadoActual !== "cerrada" && extra < 5) {
      const q = `restaurantes.orders where customer_phone like $1`;
      const n = (await s.pool.query(`select count(*)::int c from ${q}`, [`%${phone.slice(-10)}`])).rows[0].c;
      const cb = (await s.pool.query(`select count(*)::int c from restaurantes.callback_requests where customer_phone like $1`, [`%${phone.slice(-10)}`])).rows[0].c;
      if ((n > 0 && extra >= 1) || cb > 0) break;
      await hablar(await generar(["(responde a lo que te pregunta el asistente; si te repite tu pedido con el total, confirma con 'sí, es correcto')"])); extra += 1;
    }
  }
  await sincronizar();
  lineaViva = false;
  if (iniciada && ctrl.maquina.estadoActual !== "cerrada") await ctrl.clienteCuelga();
  await sincronizar();
  try { await (base as any).cerrar?.(); } catch { /* */ }
  if (grab) {
    const fin = performance.now(); const n = Math.ceil(((fin - grab.t0) / 1000) * 16000) + 16000;
    const izq = new Int16Array(n); const der = new Int16Array(n);
    for (const c of grab.cliente) { const o = Math.floor(((c.t - grab.t0) / 1000) * 16000); for (let k = 0; k < c.pcm.length && o + k < n; k += 1) izq[o + k] = c.pcm[k]!; }
    let cab = 0;
    for (const a of grab.agente) {
      const d = new Int16Array(a.pcm.buffer.slice(a.pcm.byteOffset, a.pcm.byteOffset + a.pcm.byteLength - (a.pcm.byteLength % 2)));
      const o = Math.max(cab, Math.floor(((a.t - grab.t0) / 1000) * 16000)); const m = Math.floor((d.length * 2) / 3);
      for (let k = 0; k < m && o + k < n; k += 1) { const x = (k * 3) / 2; const i0 = Math.floor(x); der[o + k] = Math.round((d[i0] ?? 0) * (1 - (x - i0)) + (d[i0 + 1] ?? d[i0] ?? 0) * (x - i0)); }
      cab = o + m;
    }
    try { mkdirSync(GRABAR_DIR, { recursive: true }); escribirWavEstereo(`${GRABAR_DIR}/${e.id}-rep${REP}.wav`, izq, der); } catch { /* */ }
  }
  const resultado = iniciada ? (ctrl.maquina.resultado ?? "abandonado") : "no_iniciada";
  return { iniciada, resultado, transcripcion: ctrl.transcripcion as { rol: string; texto: string }[], registro, tools, pregrabados, kpi, logs, toolLatMs: lat, costoMicro: costo.micro, costoReal: costo.real, v2log, turnosAudio, interrupciones: S.interrupciones, hablaEncima: S.hablaEncimaDelAgente, sttCaidas: S.caidas, costoMotorDgMicro: S.costoMotorMicro, respaldos: respaldos.splice(0), sttS: S.sttBytes / 32000, frasesTts: S.frases.length, ttsCharsAgente: S.frases.reduce((a, f) => a + f.chars, 0) };
}

// ---- checks deterministas ----
function evaluar(c: Chk, i: { orders: any[]; callbacks: any[]; agenteTexto: string }): string | null {
  const { orders, callbacks, agenteTexto } = i;
  switch (c.t) {
    case "sinPedido": return orders.length ? `no debia crear pedido y creo ${orders.length}` : null;
    case "pedidos": return orders.length === c.n ? null : `pedidos=${orders.length} (esperado ${c.n})`;
    case "maxPedidos": return orders.length <= c.n ? null : `DUPLICADO: ${orders.length} pedidos (max ${c.n})`;
    case "total": return orders.some((o) => c.en.includes(o.total)) ? null : `total ${JSON.stringify(orders.map((o) => o.total))} no esta en ${JSON.stringify(c.en)}`;
    case "totalSiCrea": return orders.every((o) => c.en.includes(o.total)) ? null : `total ${JSON.stringify(orders.map((o) => o.total))} fuera de ${JSON.stringify(c.en)}`;
    case "callback": return callbacks.length && (!c.motivos || callbacks.some((cb) => c.motivos!.includes(cb.reason))) ? null : `no registro escalacion (callback)${c.motivos ? ` con motivo ${c.motivos.join("|")}` : ""}`;
    case "sinCallback": return callbacks.length ? `escalo una consulta informativa (${callbacks.map((cb) => cb.reason).join(",")})` : null;
    case "sinTexto": return new RegExp(c.re, "i").test(agenteTexto) ? `el agente dijo algo prohibido (/${c.re}/)` : null;
    case "texto": return new RegExp(c.re, "i").test(agenteTexto) ? null : `el agente no dijo /${c.re}/`;
    case "sinItem": return orders.some((o) => new RegExp(c.re, "i").test(JSON.stringify(o.items))) ? `pedido contiene /${c.re}/` : null;
    case "canal": return orders.length && orders.every((o) => o.canal === c.v) ? null : `canal ${JSON.stringify(orders.map((o) => o.canal))} != ${c.v}`;
    case "sinDomicilio": return orders.some((o) => o.canal === "domicilio") ? "creo pedido a domicilio" : null;
    case "piezas": { const re = new RegExp(c.re, "i"); const n = orders.reduce((a, o) => a + o.items.filter((it: any) => re.test(it.name)).reduce((b: number, it: any) => b + Number(it.quantity), 0), 0); return n === c.n ? null : `piezas /${c.re}/ = ${n} (esperado ${c.n})`; }
  }
}

const JUEZ_SYS = `Eres un evaluador estricto del agente de VOZ (llamada telefonica) de una taqueria. Recibes el escenario (lo que DEBE y NO DEBE hacer), la transcripcion y el estado real de la base de datos.
En la transcripcion, cada turno del cliente muestra [dijo] lo que el cliente DIJO y [STT] lo que el reconocimiento de voz le ENTREGO al agente (puede traer errores: cifras, nombres mal escritos, muletillas). Juzga el comportamiento del agente
frente a lo que recibio y a lo que el cliente quiso decir. Si el agente dijo que el pedido quedo registrado y la BD no lo tiene, es FALLA grave. Si un check determinista fallo pero crees que el agente obro bien, dilo en el motivo.
Las horas deben decirse habladas («doce y media», no «12:30»). Un turno largo (varias frases) es un defecto de voz menor, no una falla por si solo.
Responde SOLO JSON: {"veredicto":"PASA"|"PARCIAL"|"FALLA","motivo":"1-2 frases","causa":"modelo|prompt|herramienta|ruido_stt|arnes|ninguna","severidad":"P0|P1|P2|P3|ninguna"}
causa: modelo = el agente razono o decidio mal pese a un prompt/herramienta correctos; prompt = falta o se contradice una regla de la instruccion; herramienta = la herramienta/servidor dio un resultado o error incorrecto; ruido_stt = el error de transcripcion bastaba para confundir a cualquier agente; arnes = el cliente simulado o el guion se comporto de forma inverosimil.`;

// Lectura sin comprobar antes la existencia (evita la carrera comprobar-usar): si no esta o no es JSON valido, se empieza de cero.
const previo: any[] = (() => { try { const j = JSON.parse(readFileSync(ARCHIVO, "utf8")); return Array.isArray(j) ? j : []; } catch { return []; } })();
// Todo lo que viene de la red (respuestas de modelos y de la API, transcripciones) se sanea antes de escribirlo: sin caracteres de control y con tope de largo por texto.
const sanear = (v: unknown, prof = 0): unknown => {
  if (typeof v === "string") return Array.from(v.slice(0, 20000)).filter((c) => { const n = c.charCodeAt(0); return n === 9 || n === 10 || n === 13 || (n >= 32 && n !== 127); }).join("");
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  if (prof > 8) return null;
  if (Array.isArray(v)) return v.slice(0, 2000).map((x) => sanear(x, prof + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 200).map(([k, x]) => [k.slice(0, 80), sanear(x, prof + 1)]));
  return null;
};
// Escritura atomica (archivo temporal + rename) del resultado saneado.
const guardar = () => { const tmp = `${ARCHIVO}.tmp`; writeFileSync(tmp, JSON.stringify(sanear(results), null, 1), { mode: 0o600 }); renameSync(tmp, ARCHIVO); };
const hechos = new Set(previo.filter((r) => !r.excepcion).map((r) => r.id));
const results: any[] = previo.filter((r) => !r.excepcion || r.intentos >= 3);
const uso0 = (await usoRealOpenRouter()) ?? 0;
let pendientes = 0; let cortado = false; let llmAcum = 0;
console.error(`[voz-real] rep=${REP} modelo=${MODELO} esfuerzo=${ESFUERZO} ruido_audio=${NIVEL_RUIDO} topeDg=$${dg.topes.usd} compuerta=${!SIN_COMPUERTA} corte=$${CORTE} uso0=${uso0.toFixed(4)}`);

for (const e of ESCENARIOS) {
  if (FILTRO && !FILTRO.test(e.id)) continue;
  if (hechos.has(e.id)) continue;
  // El /key de OpenRouter se actualiza con retraso: el corte usa el mayor entre su delta y la cuenta propia (costo real de las llamadas del agente + cliente simulado + juez).
  if (dg.excedido()) { cortado = true; pendientes += 1; continue; }
  const uso = (await usoRealOpenRouter()) ?? uso0;
  if (Math.max(uso - uso0, llmAcum + gasto.usd) >= CORTE) { cortado = true; pendientes += 1; continue; }
  setClock(RELOJES[e.reloj]);
  const phone = `521999${String(Math.floor(Math.random() * 9000000) + 1000000)}`; const phone10 = phone.slice(-10);
  const rec: any = { id: e.id, fuente: e.fuente, titulo: e.titulo, sucursal: e.sucursal, rep: REP, intentos: (previo.find((r) => r.id === e.id)?.intentos ?? 0) + 1 };
  const t0 = Date.now(); let llamada: any; let err: string | null = null; let instruccion = "";
  try {
    const ctx = (await (await fetch(`${s.api}/internal/restaurantes/voz/llamada/contexto`, { method: "POST", headers: HDR_INT, body: JSON.stringify({ organizationId: ORG_ID, propertyId: PROP[e.sucursal], callerPhone: phone }) })).json()) as any;
    if (typeof ctx.instruccion !== "string") throw new Error("contexto sin instruccion: " + JSON.stringify(ctx).slice(0, 160));
    instruccion = ctx.instruccion;
    llamada = await correrLlamada(e, phone, instruccion, ctx.voiceId ?? "aura-2-estrella-es", `${e.id}-${REP}`);
  } catch (x) { if (x instanceof TopeExcedido) { cortado = true; pendientes += 1; } err = ((x as Error).stack ?? (x as Error).message).split(llaveDg).join("***").replace(/(key|token|bearer)[=: ]+[^&\s]+/gi, "$1=***").slice(0, 700); }
  llmAcum += llamada ? llamada.costoMicro / 1e6 : 0;
  rec.durS = Math.round((Date.now() - t0) / 1000);
  if (err || !llamada) {
    rec.excepcion = true; rec.veredicto = "FALLA"; rec.causa = "arnes"; rec.motivo = "EXCEPCION: " + err;
    const i = results.findIndex((r) => r.id === e.id); if (i >= 0) results[i] = rec; else results.push(rec);
    guardar(); console.log("EXCEPCION", e.id, err?.slice(0, 200)); continue;
  }
  const orders = (await s.pool.query(`select total::float total, canal, status, items, property_id, customer_address from restaurantes.orders where customer_phone like $1`, [`%${phone10}`])).rows;
  const callbacks = (await s.pool.query(`select reason from restaurantes.callback_requests where customer_phone like $1`, [`%${phone10}`])).rows;
  const tr = llamada.transcripcion;
  const agenteTexto = tr.filter((x: any) => x.rol === "agente").map((x: any) => x.texto).join(" ");
  const inv: string[] = [];
  for (const o of orders) {
    let sum = 0;
    for (const it of o.items) { sum += it.price * it.quantity; const dbp = priceMap.get(`${o.property_id}:${it.id}`); if (!/^Extra Salsa/.test(it.name) && dbp !== undefined && motivoPrecioInvalido(it, dbp, o.items)) inv.push(`INV precio ${it.name} ${it.price}!=${dbp}`); if (dbp === undefined && !/^Extra Salsa/.test(it.name)) inv.push(`INV renglon ${it.name} fuera de menu`); }
    if (Math.abs(sum - o.total) > 0.01) inv.push(`INV total ${o.total}!=${sum}`);
    if (o.property_id !== PROP[e.sucursal]) inv.push("INV sucursal distinta");
  }
  const hard = [...inv, ...e.checks.map((c) => evaluar(c, { orders, callbacks, agenteTexto })).filter((x): x is string => x !== null)];
  if (llamada.resultado === undefined || llamada.resultado === null) hard.push("la llamada no tiene resultado (posible llamada colgada)");
  const caidas = llamada.v2log.filter((l: any) => /caida|vacia/.test(l.evento)).map((l: any) => `${l.evento}:${l.campos?.codigo ?? ""}`);
  const trTxt = llamada.registro.map((x: TurnoRegistro) => x.quien === "cliente" ? `CLIENTE [dijo]: ${x.dicho}${x.oido !== x.dicho ? `\n         [STT]: ${x.oido}` : ""}` : x.quien === "agente" ? `AGENTE: ${x.texto}${x.herramientas?.length ? `  <herramientas: ${x.herramientas.join(", ")}>` : ""}` : `SISTEMA: ${x.texto}`).join("\n").slice(0, 9000);
  const usr = `ESCENARIO ${e.id}: ${e.titulo}\nDEBE: ${e.debe}\nNO DEBE: ${e.noDebe}\nRESULTADO DE LA LLAMADA: ${llamada.resultado}\nTRANSCRIPCION:\n${trTxt}\nTOOLS: ${JSON.stringify(llamada.tools.map((t: any) => ({ n: t.nombre, r: JSON.stringify(t.resultado).slice(0, 180) }))).slice(0, 2800)}\nBD: pedidos=${JSON.stringify(orders.map((o: any) => ({ total: o.total, canal: o.canal, direccion: o.customer_address, items: o.items.map((i: any) => `${i.quantity}x ${i.name}@${i.price}`) })))}; callbacks=${JSON.stringify(callbacks.map((c: any) => c.reason))}\nFALLAS DETERMINISTAS: ${hard.join(" ; ") || "ninguna"}${caidas.length ? `\nINFRA: ${caidas.join(",")}` : ""}`;
  let jr: any = { veredicto: "PARCIAL", motivo: "juez sin respuesta tras 3 intentos", causa: "juez", severidad: "ninguna" };
  for (let intento = 0; intento < 3; intento += 1) {
    try {
      const out = await chat([{ role: "system", content: JUEZ_SYS }, { role: "user", content: usr }], { max: 1500, json: true, model: JUEZ });
      const m = /\{[\s\S]*\}/.exec(out);
      const j = JSON.parse(m ? m[0] : out);
      if (typeof j.veredicto === "string") { jr = j; break; }
    } catch { /* reintenta */ }
  }
  const turnosAg = llamada.registro.filter((x: TurnoRegistro) => x.quien === "agente" && x.msTurno !== undefined);
  const palabras = turnosAg.map((x: TurnoRegistro) => (x.texto ?? "").split(/\s+/).filter(Boolean).length);
  Object.assign(rec, {
    resultado: llamada.resultado, hard, juez: jr.veredicto, motivo: jr.motivo, causa: hard.length || jr.veredicto !== "PASA" ? jr.causa : "ninguna", severidad: jr.severidad,
    veredicto: hard.length === 0 && jr.veredicto === "PASA" ? "PASA" : "FALLA", soloHard: hard.length === 0 ? "PASA" : "FALLA",
    infra: caidas, pedidos: orders.map((o: any) => ({ total: o.total, canal: o.canal, items: o.items.map((i: any) => `${i.quantity}x ${i.name}@${i.price}`), direccion: o.customer_address })), callbacks: callbacks.map((c: any) => c.reason),
    turnos: llamada.registro, tools: llamada.tools.map((t: any) => ({ n: t.nombre, r: JSON.stringify(t.resultado).slice(0, 220) })), toolLatMs: llamada.toolLatMs,
    msPrimeraFrase: turnosAg.map((x: TurnoRegistro) => x.msPrimeraFrase).filter((x: any) => typeof x === "number"), msTurno: turnosAg.map((x: TurnoRegistro) => x.msTurno), palabrasAgente: palabras,
    conHerramienta: turnosAg.map((x: TurnoRegistro) => (x.herramientas?.length ?? 0) > 0), llmUsd: llamada.costoMicro / 1e6, llmCostoReal: llamada.costoReal, instruccionChars: instruccion.length,
    stack: STACK, camaRestaurante: CAMA !== null, snrCamaDb: SNR_CAMA, ruidoAudio: NIVEL_RUIDO, vozCliente: VOZ_CLIENTE, conKeyterms: VOCAB.length > 0, keytermsEnviados: Math.min(VOCAB.length, CFG_DG.keytermsMax), endpointingMs: CFG_DG.endpointingMs,
    turnosAudio: llamada.turnosAudio, resumenAudio: resumenTurnos(llamada.turnosAudio), interrupciones: llamada.interrupciones, hablaEncimaDelAgente: llamada.hablaEncima, sttCaidas: llamada.sttCaidas, respaldos: llamada.respaldos, llmRespaldo: llamada.v2log.filter((l: any) => l.evento === "v2_llm_respaldo").length, llmPorModelo: llamada.v2log.filter((l: any) => l.evento === "v2_llm").map((l: any) => l.campos?.proveedor),
    audioSttS: llamada.sttS, frasesTts: llamada.frasesTts, ttsCharsAgente: llamada.ttsCharsAgente, costoMotorDgUsd: (llamada.costoMotorDgMicro.stt + llamada.costoMotorDgMicro.tts) / 1e6, dgAcumulado: dg.resumen(),
    v2llm: llamada.v2log.filter((l: any) => l.evento === "v2_llm").map((l: any) => l.campos).slice(0, 60), v2todo: llamada.v2log.map((l: any) => [l.evento, l.campos]).slice(0, 80), logsCtrl: llamada.logs.map((l: any) => [l.evento, l.campos]).slice(0, 80),
  });
  const i = results.findIndex((r) => r.id === e.id); if (i >= 0) results[i] = rec; else results.push(rec);
  guardar();
  const ra = rec.resumenAudio as any; const p50 = ra.totalP50;
  console.log(`${rec.veredicto} ${e.id} ${e.titulo} [juez ${jr.veredicto}/${jr.causa}] res=${llamada.resultado} ${rec.durS}s total_p50=${p50}ms stt_p50=${ra.sttP50}ms tts_p50=${ra.ttsP50}ms wer=${ra.werGlobal === null ? "-" : (ra.werGlobal * 100).toFixed(1) + "%"} dg=$${dg.usd.toFixed(4)} llm=$${rec.llmUsd.toFixed(3)} | ${String(jr.motivo ?? "").slice(0, 120)} ${hard.length ? "| HARD: " + hard.join("; ").slice(0, 200) : ""}${caidas.length ? " | INFRA " + caidas.join(",") : ""}`);
}
const uso1 = (await usoRealOpenRouter()) ?? uso0;
const ran = results.filter((r) => ESCENARIOS.some((e) => e.id === r.id));
console.log(`\nRESUMEN rep=${REP} (audio real, ruido=${NIVEL_RUIDO}): Deepgram ${JSON.stringify(dg.resumen())} | ${ran.filter((r) => r.veredicto === "PASA").length}/${ran.length} PASAN | gasto de esta corrida (OpenRouter /key delta) $${(uso1 - uso0).toFixed(3)}${cortado ? ` | CORTADO por tope $${CORTE}; pendientes ${pendientes}` : ""}`);
appendFileSync(`${ARCHIVO}.gasto.jsonl`, JSON.stringify({ rep: REP, usoInicio: uso0, usoFin: uso1, deltaUsd: uso1 - uso0, dgUsd: dg.usd, dg: dg.resumen(), cuentaPropiaUsd: llmAcum + gasto.usd, agenteUsd: llmAcum, clienteJuezUsd: gasto.usd, cortado, pendientes, ts: new Date().toISOString() }) + "\n");
await s.stop();
process.exit(cortado ? 3 : 0);
