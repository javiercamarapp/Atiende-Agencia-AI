// Ronda 5 (P2-1): integracion con la SesionCascadaV2 REAL. Mismo montaje que cerebro-suelto-sesion-real.spec.ts. Original: el cerebro suelto (puerto LLM de `CerebroSuelto`) dentro de la SesionCascadaV2 REAL (voice-core) con dobles de STT y TTS y un `voz-turno` falso.
// Usa el patron real de aborto/cadena de la sesion (parcial no vacio -> interrumpir -> aborta el LLM; final -> turno encadenado) en vez de imitarlo a mano.
import { describe, expect, it } from "vitest";
import { crearProveedorCascadaV2 } from "@atiende/voice-core";
import type { AperturaLlamada, ManejadoresSesion, VozSesionLlamada } from "@atiende/voice-core";
import { CerebroSuelto } from "../src/cerebro-suelto.ts";
import { TEXTO_PENDIENTE } from "../src/cerebro-voz-turno.ts";

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const APERTURA: AperturaLlamada = { instruccion: "x", voiceId: "Kore", herramientas: [] };

interface Peticion { seq: number; texto: string }
type EventosStt = { parcial(t: string): void; turnoFinal(t: string): void; hablaIniciada(): void; caido(c: string): void };

async function montar(servidor: (p: Peticion) => Promise<Record<string, unknown>>, extra: { huerfanoMs?: number; ahora?: () => number; ttsLentoMs?: number } = {}) {
  const peticiones: Peticion[] = [];
  const fetchFn = (async (_u: string, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as Peticion;
    peticiones.push({ seq: b.seq, texto: b.texto });
    return new Response(JSON.stringify(await servidor(b)), { status: 200 });
  }) as unknown as typeof fetch;
  const hablado: string[] = [];
  const eventos: string[] = [];
  let sesion: VozSesionLlamada | null = null;
  let stt: EventosStt | null = null;
  const cerebro: CerebroSuelto = new CerebroSuelto({
    url: "https://x.invalid/voz-turno", secreto: "s", callId: "llamada-real-1", telefono: "9991234567", fetchFn, esperar: async () => undefined,
    disparadorApertura: "(saludo)", rellenoMs: 99_999, ...(extra.huerfanoMs !== undefined ? { huerfanoMs: extra.huerfanoMs } : {}), ...(extra.ahora ? { ahora: extra.ahora } : {}),
    alColgar: (m) => eventos.push(`colgar:${m}`),
    alReabrir: () => eventos.push("reabrir"),
    alPendienteHuerfano: () => { eventos.push("huerfano"); sesion?.enviarTexto(TEXTO_PENDIENTE); },
  });
  const prov = crearProveedorCascadaV2({
    deepgramApiKey: null,
    llm: cerebro.puerto,
    stt: { abrir: async (_o, e) => { stt = e as EventosStt; return { enviarAudio: () => undefined, cerrar: async () => undefined }; } },
    tts: { abrir: async () => ({ sintetizar: async function* (texto: string) { hablado.push(texto); yield Uint8Array.from([1, 0]); if (extra.ttsLentoMs) await dormir(extra.ttsLentoMs); }, cerrar: async () => undefined }) },
  });
  const h: ManejadoresSesion = {
    agenteDijo: () => undefined,
    agenteTermino: () => eventos.push("fin"),
    interrumpido: () => eventos.push("interrumpido"),
    ejecutarTool: async () => ({}),
    caido: (r) => eventos.push(`caido:${r}`),
  };
  sesion = await prov.abrirSesion(APERTURA, h);
  return { cerebro, prov, sesion, peticiones, hablado, eventos, stt: stt! as EventosStt };
}

describe("ronda 5 con la sesion real", () => {
  it("P2-1: TEXTO_PENDIENTE sin nada retenido no habla ni reintenta ni dice la frase de respaldo, y no pide nada al servidor", async () => {
    const { prov, sesion, peticiones, hablado } = await montar(async () => ({ texto: "x", pedido_id: null, turno: 1 }));
    sesion.enviarTexto(TEXTO_PENDIENTE);
    await dormir(50);
    await prov.inactivo();
    expect(hablado).toEqual([]);
    expect(peticiones).toHaveLength(0);
  });

  it("P2-1: hayPendiente es verdadero mientras la respuesta del turno abortado sigue retenida y falso cuando ya se hablo", async () => {
    const { cerebro, stt, prov, sesion, hablado } = await montar(async (p) => { await dormir(60); return { texto: "Su total es 80 pesos.", pedido_id: null, turno: p.seq }; }, { huerfanoMs: 99_999 });
    expect(cerebro.hayPendiente).toBe(false);
    stt.turnoFinal("dos tacos");
    await dormir(10);
    stt.parcial("mm");
    await dormir(120); // el servidor ya respondio y nadie hablo la respuesta
    expect(cerebro.hayPendiente).toBe(true);
    sesion.enviarTexto(TEXTO_PENDIENTE);
    await dormir(40);
    await prov.inactivo();
    expect(hablado.join(" ")).toContain("80 pesos");
    expect(cerebro.hayPendiente).toBe(false);
  });
});
