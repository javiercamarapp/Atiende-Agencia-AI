// Saludo no interrumpible (053, `branch_voice_config.mensaje_inicial_interrumpible`): con la bandera en false el barge-in se ignora mientras suena
// el saludo (el aviso de asistente virtual y grabacion se escucha completo, P37) y vuelve a funcionar desde el segundo turno del agente. Con la bandera
// en true (o ausente) todo queda como antes. Maquina pura + controlador completo con una sesion falsa.
import { describe, expect, it } from "vitest";
import { CallStateMachine } from "../src/voz/llamada/maquina.ts";
import type { AccionLlamada, EventoLlamada } from "../src/voz/llamada/maquina.ts";
import { ControladorLlamada } from "../src/voz/llamada/controlador.ts";
import { crearEjecutorTools } from "../src/voz/llamada/ejecutor-tools.ts";
import type { ManejadoresSesion } from "../src/voz/llamada/sesion.ts";

function correr(eventos: readonly EventoLlamada[], opciones?: { saludoInterrumpible?: boolean }) {
  const m = new CallStateMachine(undefined, opciones);
  const acciones: AccionLlamada[] = [];
  for (const e of eventos) acciones.push(...m.recibir(e));
  return acciones;
}
const conectada: EventoLlamada = { tipo: "conectada" };
const habla: EventoLlamada = { tipo: "usuario_habla" };
const agenteEmpieza: EventoLlamada = { tipo: "agente_empieza" };
const agenteTermina: EventoLlamada = { tipo: "agente_termina" };
const CORTAR: AccionLlamada = { tipo: "cortar_audio_agente" };

describe("maquina de la llamada: saludo no interrumpible", () => {
  it("por omision (o true) el cliente SI corta el saludo, como siempre", () => {
    expect(correr([conectada, agenteEmpieza, habla])).toEqual([CORTAR]);
    expect(correr([conectada, agenteEmpieza, habla], { saludoInterrumpible: true })).toEqual([CORTAR]);
  });

  it("con false: barge-in del cliente durante el saludo (aunque insista) NO corta el audio", () => {
    expect(correr([conectada, agenteEmpieza, habla, habla, habla], { saludoInterrumpible: false })).toEqual([]);
  });

  it("con false: cuando el saludo termina, el barge-in vuelve a funcionar en los turnos siguientes", () => {
    const acciones = correr([conectada, agenteEmpieza, habla, agenteTermina, agenteEmpieza, habla], { saludoInterrumpible: false });
    expect(acciones).toEqual([CORTAR]);
  });

  it("con false: la proteccion es SOLO del primer turno del agente; una caida del proveedor en pleno saludo la libera", () => {
    expect(correr([conectada, agenteEmpieza, { tipo: "proveedor_cae" }, { tipo: "proveedor_vuelve" }, agenteEmpieza, habla], { saludoInterrumpible: false })).toEqual([
      { tipo: "reconectar", intento: 1, esperaMs: 400 },
      CORTAR,
    ]);
  });

  it("con false: el cliente que habla ANTES de que el agente empiece no cambia nada (no hay audio que cortar)", () => {
    expect(correr([conectada, habla, agenteEmpieza], { saludoInterrumpible: false })).toEqual([]);
  });
});

describe("controlador de la llamada: el audio del saludo no se corta", () => {
  async function llamada(saludoInterrumpible: boolean | undefined) {
    let manejadores!: ManejadoresSesion;
    let interrupciones = 0;
    let cortes = 0;
    const ctrl = new ControladorLlamada({
      callId: "c1",
      propertyId: "p",
      organizationId: "o",
      abrirSesion: async (_apertura, h) => {
        manejadores = h;
        return { enviarTexto: () => undefined, interrumpir: () => void (interrupciones += 1), cerrar: async () => undefined };
      },
      ejecutor: crearEjecutorTools({ transporte: async () => ({ resultado: { ok: true }, orderId: null }), timeoutMs: 100 }),
      instruccion: "x",
      voiceId: "Kore",
      reproducir: () => undefined,
      cortarAudio: () => void (cortes += 1),
      dormir: async () => undefined,
      ...(saludoInterrumpible === undefined ? {} : { saludoInterrumpible }),
    });
    await ctrl.iniciar({ habilitado: true, gastoMesMicroUsd: 0, topeMensualMicroUsd: null });
    return { ctrl, h: () => manejadores, interrupciones: () => interrupciones, cortes: () => cortes };
  }

  it("barge-in del cliente en el segundo 1 del saludo: con false no se corta ni se interrumpe al proveedor; en el segundo turno si", async () => {
    const t = await llamada(false);
    t.h().agenteDijo("Le atiende el asistente virtual de Los Taquitos de PM. Esta llamada puede ser grabada.");
    await t.ctrl.vacio();
    await t.ctrl.usuarioHabla();
    await t.ctrl.vacio();
    expect(t.cortes()).toBe(0);
    expect(t.interrupciones()).toBe(0);

    t.h().agenteTermino();
    await t.ctrl.vacio();
    t.h().agenteDijo("¿Qué le gustaría ordenar?");
    await t.ctrl.vacio();
    await t.ctrl.usuarioHabla();
    await t.ctrl.vacio();
    expect(t.cortes()).toBe(1);
  });

  it("sin la bandera (comportamiento anterior) el mismo barge-in SI corta el saludo", async () => {
    const t = await llamada(undefined);
    t.h().agenteDijo("Le atiende el asistente virtual de Los Taquitos de PM.");
    await t.ctrl.vacio();
    await t.ctrl.usuarioHabla();
    await t.ctrl.vacio();
    expect(t.cortes()).toBe(1);
  });
});
