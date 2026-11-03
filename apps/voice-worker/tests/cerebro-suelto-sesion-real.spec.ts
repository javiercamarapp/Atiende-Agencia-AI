// Integracion: el cerebro suelto (puerto LLM de `CerebroSuelto`) dentro de la SesionCascadaV2 REAL (voice-core) con dobles de STT y TTS y un `voz-turno` falso.
// Usa el patron real de aborto/cadena de la sesion (parcial no vacio -> interrumpir -> aborta el LLM; final -> turno encadenado) en vez de imitarlo a mano.
import { describe, expect, it } from "vitest";
import { crearProveedorCascadaV2 } from "@atiende/voice-core";
import type { AperturaLlamada, ManejadoresSesion, VozSesionLlamada } from "@atiende/voice-core";
import { CerebroSuelto, VigiaSilencio } from "../src/cerebro-suelto.ts";
import { TEXTO_PENDIENTE, TEXTO_SILENCIO } from "../src/cerebro-voz-turno.ts";

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const APERTURA: AperturaLlamada = { instruccion: "x", voiceId: "Kore", herramientas: [] };

interface Peticion { seq: number; texto: string }
type EventosStt = { parcial(t: string): void; turnoFinal(t: string): void; hablaIniciada(): void; caido(c: string): void };

async function montar(servidor: (p: Peticion) => Promise<Record<string, unknown>>, extra: { huerfanoMs?: number; ahora?: () => number } = {}) {
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
    tts: { abrir: async () => ({ sintetizar: async function* (texto: string) { hablado.push(texto); yield Uint8Array.from([1, 0]); }, cerrar: async () => undefined }) },
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

describe("cerebro suelto dentro de la SesionCascadaV2 real", () => {
  it("barge-in: el cliente interrumpe mientras el servidor procesa; el total se habla antes de la respuesta nueva y el texto va como seq 2", async () => {
    const { stt, prov, peticiones, hablado } = await montar(async (p) => {
      if (p.seq === 1) { await dormir(60); return { texto: "Son dos tacos, su total es 80 pesos.", pedido_id: null, turno: 1 }; }
      return { texto: "Agregué la coca.", pedido_id: null, turno: 2 };
    });
    stt.turnoFinal("dos tacos");
    await dormir(10);
    stt.parcial("ah y");
    stt.turnoFinal("ah y agrega una coca");
    await dormir(150);
    await prov.inactivo();
    expect(peticiones).toEqual([{ seq: 1, texto: "dos tacos" }, { seq: 2, texto: "ah y agrega una coca" }]);
    expect(hablado.join(" ")).toContain("su total es 80 pesos");
    expect(hablado.join(" ").indexOf("80 pesos")).toBeLessThan(hablado.join(" ").indexOf("Agregué la coca"));
  });

  it("cierre blando: tras la despedida con pedido el cliente dice «espera, falta algo»: no se cuelga y su texto llega al servidor", async () => {
    const { stt, prov, peticiones, eventos, cerebro } = await montar(async (p) => (p.seq === 1 ? { texto: "Listo, su pedido quedó. Gracias, buen provecho.", pedido_id: "P1", turno: 1 } : { texto: "Dígame, ¿qué falta?", pedido_id: "P1", turno: 2 }));
    stt.turnoFinal("a domicilio");
    await dormir(40);
    await prov.inactivo();
    expect(eventos).toContain("colgar:despedida_con_pedido");
    stt.turnoFinal("espera, falta algo");
    await dormir(40);
    await prov.inactivo();
    expect(peticiones.map((p) => p.seq)).toEqual([1, 2]);
    expect(eventos).toContain("reabrir");
    expect(cerebro.cierre).toBeNull();
  });

  it("ruido sin texto final: un parcial aborta el turno en vuelo, nadie lo reemplaza y tras huerfanoMs la respuesta retenida se habla sin otra peticion", async () => {
    const { stt, prov, peticiones, hablado, eventos } = await montar(async () => { await dormir(60); return { texto: "Su total es 80 pesos.", pedido_id: null, turno: 1 }; }, { huerfanoMs: 30 });
    stt.turnoFinal("dos tacos");
    await dormir(10);
    stt.parcial("mm");
    await dormir(250);
    await prov.inactivo();
    expect(eventos).toContain("huerfano");
    expect(peticiones).toHaveLength(1);
    expect(hablado.join(" ")).toContain("80 pesos");
  });

  it("vigia de silencio: ~8 s sin voz manda [silencio] como un turno mas por la sesion real, y no mientras hay un turno en curso", async () => {
    let reloj = 1_000_000;
    const { stt, prov, sesion, cerebro, peticiones } = await montar(async (p) => { if (p.seq === 1) await dormir(40); return { texto: p.texto === TEXTO_SILENCIO ? "¿Sigue ahí?" : "Claro.", pedido_id: null, turno: p.seq }; }, { ahora: () => reloj });
    const vigia = new VigiaSilencio({ umbralMs: 8000, ocupado: () => cerebro.ocupado || cerebro.cierre !== null, ultimaActividad: () => cerebro.ultimaActividad, ahora: () => reloj, disparar: () => sesion.enviarTexto(TEXTO_SILENCIO) });
    stt.turnoFinal("hola");
    await dormir(5);
    vigia.registrar(9000);
    expect(peticiones.map((p) => p.texto)).not.toContain(TEXTO_SILENCIO);
    await dormir(80);
    await prov.inactivo();
    reloj += 9000;
    vigia.registrar(10_000);
    await dormir(40);
    await prov.inactivo();
    expect(peticiones.map((p) => p.texto)).toEqual(["hola", TEXTO_SILENCIO]);
  });
});
