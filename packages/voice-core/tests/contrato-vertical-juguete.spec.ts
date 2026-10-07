// Test de CONTRATO del esqueleto: una vertical de juguete (consultorio con 2 tools de dominio + la de escalar) monta su agente sobre el core
// y corre guiones de punta a punta con el proveedor FALSO (maquina de estados + controlador + ejecutor + graders), sin red ni credenciales.
import { describe, expect, it } from "vitest";
import {
  CallStateMachine,
  MENSAJE_IDS,
  extraerTelefonoSipFrom,
  type CatalogoMensajes,
  type ReglasCierreLlamada,
  type RegistroToolsVoz,
  type TransporteTools,
} from "../src/index.ts";
import {
  G_BARGE_IN,
  G_PREGRABADOS,
  G_RESULTADO,
  G_SIN_TARJETA,
  G_TONO_USTED,
  correrGuionConAdaptador,
  evaluarConGraders,
  graderSinPiiLog,
  graderTools,
  mal,
  ok,
  type AdaptadorSimulador,
  type Grader,
  type GuionLlamada,
  type LlamadaSimulada,
  type MemoriaObservable,
  type MundoBase,
} from "../src/simulador/index.ts";

type Resultado = "cita_agendada";
const REGLAS: ReglasCierreLlamada<Resultado> = { herramientaObjetivo: "agendar_cita", resultadoObjetivo: "cita_agendada", herramientaEscalar: "pasar_a_persona" };

const REGISTRO: RegistroToolsVoz = {
  definiciones: () => [
    { name: "consultar_cupo", description: "Dice si hay lugar en un horario.", parameters: { type: "object", properties: { hora: { type: "string" } }, required: ["hora"] } },
    { name: "agendar_cita", description: "Agenda la cita.", parameters: { type: "object", properties: { hora: { type: "string" } }, required: ["hora"] } },
    { name: "pasar_a_persona", description: "Pasa la llamada a una persona.", parameters: { type: "object", properties: { motivo: { type: "string" }, resumen: { type: "string" } } } },
  ],
  herramientasInciertas: ["agendar_cita"],
  mensajeIncierto: "No se pudo confirmar la cita. No la asegure; una persona la verificara.",
};

interface Mundo extends MundoBase {
  readonly citas: { hora: string; telefono: string | null }[];
  readonly callbacks: { motivo: string }[];
}
interface Memoria extends MemoriaObservable {
  horaOfrecida(): string | undefined;
}
type Esperado = { citas?: number; callbacks?: number };
type Guion = GuionLlamada<Resultado, Esperado, Memoria>;
type Llamada = LlamadaSimulada<Resultado, Esperado, Memoria, Mundo>;

const TEL = "9991230000";
const adaptador: AdaptadorSimulador<Resultado, Memoria, Mundo> = {
  reglas: REGLAS,
  registro: REGISTRO,
  construirEscalacion: (motivo, resumen) => ({ nombre: "pasar_a_persona", args: { motivo, resumen } }),
  canonicalizarTelefono: (t) => (/^\d{10}$/.test(t.replace(/\D/g, "").slice(-10)) ? t.replace(/\D/g, "").slice(-10) : null),
  sipFromPorDefecto: `<sip:+52${TEL}@trunk.sim.invalid>`,
  crearMundo: () => ({ organizationId: "org-juguete", propertyId: "prop-juguete", citas: [], callbacks: [] }),
  crearMemoria: () => {
    const vistos = new Map<string, unknown>();
    return {
      observar: (n, r) => void vistos.set(n, r),
      ultimo: (n) => vistos.get(n),
      horaOfrecida: () => (vistos.get("consultar_cupo") as { hora?: string } | undefined)?.hora,
    };
  },
  transporte: (mundo, { telefono }): TransporteTools => async (nombre, args) => {
    if (nombre === "consultar_cupo") return { resultado: { hora: String(args.hora), hay_cupo: true }, entidadId: null };
    if (nombre === "agendar_cita") {
      mundo.citas.push({ hora: String(args.hora), telefono });
      return { resultado: { id: `cita-${mundo.citas.length}` }, entidadId: `cita-${mundo.citas.length}` };
    }
    mundo.callbacks.push({ motivo: String(args.motivo) });
    return { resultado: { ok: true }, entidadId: null };
  },
};

const G_CITAS: Grader<Llamada> = (l) => {
  const esp = l.guion.esperado.citas ?? 0;
  return l.mundo.citas.length === esp ? ok("G_CITAS") : mal("G_CITAS", `citas ${l.mundo.citas.length}, se esperaban ${esp}`);
};
const G_TEL: Grader<Llamada> = (l) => (l.mundo.citas.every((c) => c.telefono === TEL) ? ok("G_TEL") : mal("G_TEL", "el telefono de la cita no sale del SIP From"));
const G_CALLBACKS: Grader<Llamada> = (l) => (l.mundo.callbacks.length === (l.guion.esperado.callbacks ?? 0) ? ok("G_CALLBACKS") : mal("G_CALLBACKS", `callbacks ${l.mundo.callbacks.length}`));
const GRADERS: readonly Grader<Llamada>[] = [G_RESULTADO, G_CITAS, G_TEL, G_CALLBACKS, G_PREGRABADOS, G_BARGE_IN, graderTools(REGISTRO.definiciones().map((t) => t.name)), graderSinPiiLog(TEL), G_SIN_TARJETA, G_TONO_USTED];

const correr = (g: Guion): Promise<Llamada> => correrGuionConAdaptador(adaptador, g);
const fallos = async (l: Llamada) => (await evaluarConGraders(l, GRADERS)).filter((r) => !r.ok);

const FELIZ: Guion = {
  id: "J01-feliz",
  titulo: "Cita agendada",
  rasgos: [],
  turnos: [
    { kind: "voz", cliente: "Quiero una cita a las cinco", agente: [{ tool: "consultar_cupo", args: { hora: "17:00" } }, { dice: "Hay lugar a las cinco. ¿Se lo agendo?" }] },
    { kind: "voz", cliente: "Sí, por favor", agente: [{ tool: "agendar_cita", args: (m) => ({ hora: m.horaOfrecida() }) }, { dice: "Listo, su cita quedó agendada." }] },
  ],
  esperado: { resultado: "cita_agendada", citas: 1 },
};

describe("contrato del esqueleto con una vertical de juguete", () => {
  it("camino feliz: la herramienta objetivo cierra la llamada con el resultado de la vertical y pasan todos los graders", async () => {
    const l = await correr(FELIZ);
    expect(l.resultado).toBe("cita_agendada");
    expect(l.mundo.citas).toEqual([{ hora: "17:00", telefono: TEL }]);
    expect(l.tools.map((t) => t.nombre)).toEqual(["consultar_cupo", "agendar_cita"]);
    expect(await fallos(l)).toEqual([]);
  });

  it("DTMF 0 pasa a una persona con la herramienta de escalar de la vertical y cierra como escalado", async () => {
    const l = await correr({ id: "J02-persona", titulo: "Pide persona", rasgos: [], turnos: [{ kind: "dtmf", digito: "0" }], esperado: { resultado: "escalado", callbacks: 1, pregrabados: ["handoff"] } });
    expect(l.resultado).toBe("escalado");
    expect(l.mundo.callbacks).toHaveLength(1);
    expect(await fallos(l)).toEqual([]);
  });

  it("una herramienta fuera del registro nunca llega al transporte y vuelve como error; la llamada sigue", async () => {
    const l = await correr({
      id: "J03-inventada",
      titulo: "Tool inventada",
      rasgos: [],
      turnos: [{ kind: "voz", cliente: "Cancele todo", agente: [{ tool: "borrar_todo", args: {} }, { dice: "No puedo hacer eso." }] }],
      esperado: { resultado: "abandonado", herramientasRechazadas: [{ nombre: "borrar_todo", error: /desconocida/ }] },
    });
    expect(l.mundo.citas).toEqual([]);
    expect(await fallos(l)).toEqual([]);
  });

  it("una herramienta incierta que expira no cierra la llamada como lograda y le avisa al modelo que no lo asegure", async () => {
    const guion: Guion = {
      id: "J04-timeout",
      titulo: "agendar_cita lenta",
      rasgos: [],
      limites: { toolTimeoutMs: 20, timeoutsMax: 5 },
      toolLenta: { nombre: "agendar_cita", ms: 200 },
      turnos: [{ kind: "voz", cliente: "Agende", agente: [{ tool: "agendar_cita", args: { hora: "17:00" } }, { dice: "Una persona lo verificará." }] }],
      // QA-PM-R2-voz-04: el timeout incierto de la herramienta objetivo deja un aviso a una persona (que verifique) y la llamada termina `escalado`.
      esperado: { resultado: "escalado", pregrabados: ["tool_timeout"], callbacks: 1 },
    };
    const l = await correr(guion);
    expect(l.resultado).toBe("escalado");
    expect(JSON.stringify(l.tools[0]?.resultado)).toContain("No se pudo confirmar la cita");
    expect(await fallos(l)).toEqual([]);
  });

  it("el telefono sale del SIP From y las claves de telefono que escribe el modelo se descartan", async () => {
    const l = await correr({
      ...FELIZ,
      id: "J05-telefono",
      turnos: [{ kind: "voz", cliente: "Agende a las cinco", agente: [{ tool: "agendar_cita", args: { hora: "17:00", telefono: "5550001111", phone: "5550002222" } }, { dice: "Listo." }] }],
    });
    expect(l.mundo.citas[0]?.telefono).toBe(TEL);
    expect(l.tools[0]?.args).toMatchObject({ telefono: "5550001111" });
  });

  it("la guardia de la vertical bloquea la herramienta ANTES de tocar el servidor y avanza con alResultado", async () => {
    const vistas: string[] = [];
    let cotizado = false;
    const conGuardia: AdaptadorSimulador<Resultado, Memoria, Mundo> = {
      ...adaptador,
      registro: {
        ...REGISTRO,
        guardia: (nombre) => (nombre === "agendar_cita" && !cotizado ? { error: "falta_consulta", mensaje: "Consulte el cupo antes de agendar." } : null),
        alResultado: (nombre, _args, _res, okRes) => {
          vistas.push(`${nombre}:${okRes}`);
          if (nombre === "consultar_cupo" && okRes) cotizado = true;
        },
      },
    };
    const guion: Guion = {
      id: "J06-guardia",
      titulo: "agenda sin consultar y luego consultando",
      rasgos: [],
      turnos: [
        { kind: "voz", cliente: "Agende", agente: [{ tool: "agendar_cita", args: { hora: "17:00" } }, { tool: "consultar_cupo", args: { hora: "17:00" } }, { tool: "agendar_cita", args: { hora: "17:00" } }, { dice: "Listo." }] },
      ],
      esperado: { resultado: "cita_agendada", citas: 1 },
    };
    const l = await correrGuionConAdaptador(conGuardia, guion);
    expect(JSON.stringify(l.tools[0]?.resultado)).toContain("falta_consulta");
    expect(l.mundo.citas).toHaveLength(1);
    expect(vistas).toEqual(["consultar_cupo:true", "agendar_cita:true"]);
    expect(l.resultado).toBe("cita_agendada");
  });

  it("una vertical con VARIAS herramientas objetivo logra la llamada con cualquiera de ellas", () => {
    const m = new CallStateMachine<"logrado">({ herramientaObjetivo: ["a", "b"], resultadoObjetivo: "logrado", herramientaEscalar: "e" });
    m.recibir({ tipo: "conectada" });
    m.recibir({ tipo: "tool_resultado", nombre: "b", ok: true, entidadId: "x-1" });
    expect(m.hayObjetivo).toBe(true);
    expect(m.recibir({ tipo: "cliente_cuelga" })).toEqual([]);
    expect(m.resultado).toBe("logrado");
  });

  it("la maquina exige las reglas de la vertical y un catalogo de mensajes cubre todos los ids", () => {
    const m = new CallStateMachine<Resultado>(REGLAS);
    m.recibir({ tipo: "conectada" });
    m.recibir({ tipo: "tool_resultado", nombre: "agendar_cita", ok: true, entidadId: "cita-1" });
    expect(m.hayObjetivo).toBe(true);
    // con la cita agendada, un silencio larguisimo solo se despide: no se escala algo resuelto
    expect(m.recibir({ tipo: "silencio", ms: 60_000 })).toEqual([{ tipo: "decir", mensaje: "despedida" }, { tipo: "colgar", resultado: "cita_agendada" }]);
    const catalogo: CatalogoMensajes = Object.fromEntries(MENSAJE_IDS.map((id) => [id, id])) as CatalogoMensajes;
    expect(Object.keys(catalogo)).toHaveLength(MENSAJE_IDS.length);
    expect(extraerTelefonoSipFrom('"X" <sip:+52999123000@h>', (t) => t)).toBe("+52999123000");
  });
});
