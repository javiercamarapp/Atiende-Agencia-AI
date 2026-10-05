// Gancho `guardiaCliente` del controlador: una guardia DETERMINISTA de la vertical sobre lo que dice el cliente (citas: crisis). Debe actuar ANTES
// del modelo (el texto no se le manda), decir su texto tal cual, escalar con la herramienta de la vertical y cerrar como `escalado` aunque la
// llamada ya hubiera logrado su objetivo. Sin guardia, el comportamiento es el de siempre.
import { describe, expect, it } from "vitest";
import type { ReglasCierreLlamada, RegistroToolsVoz, TransporteTools } from "../src/index.ts";
import { correrGuionConAdaptador, type AdaptadorSimulador, type GuionLlamada, type MemoriaObservable, type MundoBase } from "../src/simulador/index.ts";

type R = "cita_agendada";
const REGLAS: ReglasCierreLlamada<R> = { herramientaObjetivo: "agendar_cita", resultadoObjetivo: "cita_agendada", herramientaEscalar: "pasar_a_persona" };
const REGISTRO: RegistroToolsVoz = {
  definiciones: () => [
    { name: "agendar_cita", description: "Agenda.", parameters: { type: "object", properties: {} } },
    { name: "pasar_a_persona", description: "Persona.", parameters: { type: "object", properties: { motivo: { type: "string" }, resumen: { type: "string" } } } },
  ],
  herramientasInciertas: [],
  mensajeIncierto: "",
};
interface Mundo extends MundoBase {
  readonly escaladas: { motivo: string; resumen: string }[];
}
const memoria = (): MemoriaObservable => {
  const m = new Map<string, unknown>();
  return { observar: (n, r) => void m.set(n, r), ultimo: (n) => m.get(n) };
};
const base: AdaptadorSimulador<R, MemoriaObservable, Mundo> = {
  reglas: REGLAS,
  registro: REGISTRO,
  construirEscalacion: (motivo, resumen) => ({ nombre: "pasar_a_persona", args: { motivo, resumen } }),
  canonicalizarTelefono: (t) => t,
  sipFromPorDefecto: "<sip:+5219990000000@x.invalid>",
  crearMundo: () => ({ organizationId: "o", propertyId: "p", escaladas: [] }),
  crearMemoria: memoria,
  transporte: (mundo): TransporteTools => async (nombre, args) => {
    if (nombre === "agendar_cita") return { resultado: { id: "c1" }, entidadId: "c1" };
    mundo.escaladas.push({ motivo: String(args.motivo), resumen: String(args.resumen) });
    return { resultado: { ok: true }, entidadId: null };
  },
};
const conGuardia: AdaptadorSimulador<R, MemoriaObservable, Mundo> = {
  ...base,
  guardiaCliente: () => ({ evaluar: (t) => (/no quiero seguir/i.test(t) ? { texto: "Texto de ayuda tal cual.", motivo: "crisis", resumen: "senal de seguridad" } : null) }),
};
type Guion = GuionLlamada<R, object, MemoriaObservable>;

const NORMAL: Guion = {
  id: "G01",
  titulo: "normal",
  rasgos: [],
  turnos: [{ kind: "voz", cliente: "Quiero una cita", agente: [{ dice: "Claro." }] }],
  esperado: { resultado: "abandonado" },
};
const CRISIS: Guion = {
  id: "G02",
  titulo: "crisis a media llamada",
  rasgos: [],
  turnos: [
    { kind: "voz", cliente: "Quiero una cita", agente: [{ dice: "Claro, ¿para cuándo?" }] },
    // Si el modelo recibiera el texto, el cerebro guionado agendaria una cita: no debe ocurrir.
    { kind: "voz", cliente: "La verdad es que no quiero seguir", agente: [{ tool: "agendar_cita", args: {} }, { dice: "Listo." }] },
  ],
  esperado: { resultado: "escalado" },
};

describe("guardiaCliente del controlador", () => {
  it("sin guardia no cambia nada: ninguna escalada ni texto dicho", async () => {
    const l = await correrGuionConAdaptador(base, NORMAL);
    expect(l.mundo.escaladas).toEqual([]);
    expect(l.textosGuardia).toEqual([]);
  });

  it("con guardia, una frase normal no la activa", async () => {
    const l = await correrGuionConAdaptador(conGuardia, NORMAL);
    expect(l.textosGuardia).toEqual([]);
    expect(l.mundo.escaladas).toEqual([]);
  });

  it("al activarse dice el texto tal cual, escala con el motivo, cierra como escalado y el modelo no recibe la frase", async () => {
    const l = await correrGuionConAdaptador(conGuardia, CRISIS);
    expect(l.textosGuardia).toEqual(["Texto de ayuda tal cual."]);
    expect(l.mundo.escaladas).toEqual([{ motivo: "crisis", resumen: "senal de seguridad" }]);
    expect(l.resultado).toBe("escalado");
    expect(l.tools.map((t) => t.nombre)).not.toContain("agendar_cita");
    // Solo el motivo llega al log; nunca lo que dijo el cliente.
    expect(JSON.stringify(l.logs)).not.toContain("no quiero seguir");
    expect(l.logs.some((x) => x.evento === "guardia_cliente" && x.campos.motivo === "crisis")).toBe(true);
  });

  it("una guardia de seguridad pesa mas que un cierre exitoso: con la cita ya agendada el resultado sigue siendo escalado", async () => {
    const guion: Guion = {
      id: "G03",
      titulo: "cita agendada y luego crisis",
      rasgos: [],
      turnos: [
        { kind: "voz", cliente: "Agéndeme", agente: [{ tool: "agendar_cita", args: {} }, { dice: "Listo." }] },
        { kind: "voz", cliente: "No quiero seguir", agente: [{ dice: "..." }] },
      ],
      esperado: { resultado: "escalado" },
    };
    const l = await correrGuionConAdaptador(conGuardia, guion);
    expect(l.resultado).toBe("escalado");
    expect(l.mundo.escaladas).toHaveLength(1);
  });
});
