// El vocabulario del menu llega al STT: `ControladorLlamada.abrir()` lo pasa a `abrirSesion` (antes no, y Deepgram no recibia keyterms).
import { describe, expect, it } from "vitest";
import { ControladorLlamada, crearEjecutorTools } from "../src/index.ts";
import type { AperturaLlamada, RegistroToolsVoz, VozSesionLlamada } from "../src/index.ts";

const REGLAS = { herramientaObjetivo: "crear_pedido", resultadoObjetivo: "pedido_creado", herramientaEscalar: "escalar_a_humano" } as const;
const REGISTRO: RegistroToolsVoz = { definiciones: () => [{ name: "crear_pedido", description: "x", parameters: { type: "object", properties: {} } }], herramientasInciertas: [], mensajeIncierto: "i" };

async function abrirCon(vocabulario?: readonly string[]): Promise<AperturaLlamada[]> {
  const aperturas: AperturaLlamada[] = [];
  const c = new ControladorLlamada({
    callId: "voc",
    reglas: REGLAS,
    construirEscalacion: () => ({ nombre: "escalar_a_humano", args: {} }),
    propertyId: "p",
    organizationId: "o",
    abrirSesion: async (a): Promise<VozSesionLlamada> => {
      aperturas.push(a);
      return { enviarTexto: () => undefined, interrumpir: () => undefined, cerrar: async () => undefined };
    },
    ejecutor: crearEjecutorTools({ registro: REGISTRO, timeoutMs: 100, transporte: async () => ({ resultado: {}, entidadId: null }) }),
    instruccion: "x",
    voiceId: "Kore",
    reproducir: () => undefined,
    dormir: async () => undefined,
    ...(vocabulario ? { vocabulario } : {}),
  });
  await c.iniciar({ habilitado: true, gastoMesMicroUsd: 0, topeMensualMicroUsd: null });
  return aperturas;
}

describe("controlador: vocabulario del menu al STT", () => {
  it("pasa el vocabulario a la apertura de la sesion", async () => {
    const a = await abrirCon(["gringas", "mestizas", "alambre"]);
    expect(a[0]?.vocabulario).toEqual(["gringas", "mestizas", "alambre"]);
  });
  it("sin vocabulario no manda la clave", async () => {
    const a = await abrirCon();
    expect(a[0] && "vocabulario" in a[0]).toBe(false);
  });
});
