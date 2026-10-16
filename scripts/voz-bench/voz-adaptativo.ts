// Corrida de UN guion de voz con CLIENTE ADAPTATIVO: misma plomeria que `correrGuionConAdaptador` (ControladorLlamada + maquina de estados +
// ejecutor de tools del registro unico sobre el mundo de PM), pero cada turno de voz del cliente lo escribe un LLM independiente (distinto de los
// modelos evaluados) a partir de la INTENCION del guion y de lo que el agente realmente dijo. El guion fijo (`correrGuion`) manda la siguiente frase
// aunque el modelo haya preguntado otra cosa y eso reprobaba a modelos que simplemente pedian el dato antes de cotizar (ver informe).
import { ControladorLlamada } from "../../packages/voice-core/src/llamada/controlador.ts";
import { crearEjecutorTools } from "../../packages/voice-core/src/llamada/ejecutor-tools.ts";
import type { TransporteTools } from "../../packages/voice-core/src/llamada/ejecutor-tools.ts";
import { LIMITES_POR_DEFECTO } from "../../packages/voice-core/src/llamada/maquina.ts";
import { extraerTelefonoSipFrom } from "../../packages/voice-core/src/llamada/sip.ts";
import type { ProveedorSimulable } from "../../packages/voice-core/src/simulador/correr-guion.ts";
import { ADAPTADOR_SIMULADOR_PM } from "../../packages/domain-restaurantes/src/voz/simulador/correr-guion.ts";
import { LIMITES_VOZ_PM } from "../../packages/domain-restaurantes/src/voz/llamada/maquina.ts";
import type { GuionLlamada, LlamadaSimulada } from "../../packages/domain-restaurantes/src/voz/simulador/tipos.ts";

export type PedirCliente = (p: { sistema: string; mensajes: { role: "user" | "assistant"; content: string }[] }) => Promise<string>;

const dormirDe = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_EXTRA = 8;

function sistemaCliente(g: GuionLlamada): string {
  const frases = g.turnos.flatMap((t) => (t.kind === "voz" || t.kind === "confuso" ? [t.cliente] : []));
  return [
    "Usted simula a un CLIENTE que llama por telefono a la taqueria Los Taquitos de PM (Merida, Mexico). Hable en español de Mexico, natural, frases cortas (maximo 25 palabras), como se habla por telefono. Nunca diga que es una simulacion.",
    `Su intencion de llamada (las cosas que usted tiene que decir o pedir, aproximadamente en este orden, con sus datos exactos: nombres, direcciones, cantidades, pago): ${frases.map((f, i) => `(${i + 1}) "${f}"`).join(" ")}`,
    "Reglas: (a) conteste SIEMPRE lo que el agente le pregunte, usando los datos de su intencion; si le preguntan algo que su intencion no cubre, conteste de forma breve y razonable sin inventar pedidos nuevos. (b) Si el agente repite su pedido y coincide con lo que usted pidio, confirme (\"si, esta bien\"); si no coincide, corrijalo. (c) No adelante informacion que el agente no ha pedido, salvo que su intencion la ponga en esa frase. (d) Si el agente se niega a algo (p. ej. cerveza a domicilio) reaccione como cliente: acepte la alternativa que sea coherente con su intencion. (e) Cuando el agente le diga que su pedido YA QUEDO REGISTRADO, o que lo comunica con una persona o que una persona le devolvera la llamada, o se despida, responda exactamente: FIN. Nunca diga FIN si el agente espera una respuesta suya.",
    "Responda SOLO con lo que dice el cliente, sin comillas ni acotaciones.",
  ].join("\n");
}

export async function correrGuionAdaptativo(
  guion: GuionLlamada,
  o: { readonly instruccion: string; readonly voiceId: string; readonly proveedor: (g: GuionLlamada) => ProveedorSimulable; readonly pedirCliente: PedirCliente; /** Espera de calma extra (proveedores con turnos asincronos como Gemini Live). */ readonly estabilizar?: () => Promise<void> },
): Promise<LlamadaSimulada & { readonly turnosVoz: number; readonly extra: number }> {
  const adaptador = ADAPTADOR_SIMULADOR_PM;
  const g: GuionLlamada = { ...guion, limites: { silenciosMax: LIMITES_VOZ_PM.silenciosMax, ...guion.limites } };
  const mundo = adaptador.crearMundo();
  const proveedor = o.proveedor(g);
  const limites = { ...LIMITES_POR_DEFECTO, ...(g.limites ?? {}) };
  const sipFrom = g.sipFrom === undefined ? adaptador.sipFromPorDefecto : g.sipFrom;
  const callId = `sim-${g.id}`;
  const base = adaptador.transporte(mundo, { callId, telefono: extraerTelefonoSipFrom(sipFrom, adaptador.canonicalizarTelefono) });
  const transporte: TransporteTools = g.toolLenta
    ? async (n, a, s, c) => {
        if (n === g.toolLenta!.nombre) await dormirDe(g.toolLenta!.ms);
        return base(n, a, s, c);
      }
    : base;
  const tools: { nombre: string; args: unknown; resultado: unknown }[] = [];
  const pregrabados: never[] = [];
  const logs: LlamadaSimulada["logs"][number][] = [];
  const kpi: unknown[] = [];
  let audioCortado = 0;
  const textosGuardia: string[] = [];
  const guardiaBase = adaptador.guardiaCliente?.(mundo);
  const ctrl = new ControladorLlamada({
    callId, reglas: adaptador.reglas, construirEscalacion: adaptador.construirEscalacion, propertyId: mundo.propertyId, organizationId: mundo.organizationId,
    abrirSesion: proveedor.abrirSesion,
    ...(guardiaBase ? { guardiaCliente: { evaluar: (t: string) => guardiaBase.evaluar(t), decir: (t: string) => void textosGuardia.push(t) } } : {}),
    ejecutor: crearEjecutorTools({ registro: adaptador.registro, transporte, timeoutMs: limites.toolTimeoutMs }),
    instruccion: o.instruccion, voiceId: o.voiceId, limites,
    reproducir: (m) => void pregrabados.push(m as never), cortarAudio: () => void (audioCortado += 1), log: (l) => void logs.push(l), kpi: (e) => void kpi.push(e),
    dormir: async () => undefined, trazarTool: (t) => void tools.push(t),
  });
  const { iniciada } = await ctrl.iniciar({ habilitado: true, gastoMesMicroUsd: 0, topeMensualMicroUsd: null, ...(g.inicio ?? {}) });
  const sync = async () => {
    await proveedor.inactivo();
    await ctrl.vacio();
    await proveedor.inactivo();
    await ctrl.vacio();
    if (o.estabilizar) {
      await o.estabilizar();
      await proveedor.inactivo();
      await ctrl.vacio();
    }
  };
  const sistema = sistemaCliente(g);
  const conv: { role: "user" | "assistant"; content: string }[] = [];
  const ultimoAgente = (): string => {
    const t = ctrl.transcripcion;
    let i = t.length - 1;
    while (i >= 0 && t[i]!.rol !== "agente") i--;
    if (i < 0) return "";
    let j = i;
    while (j > 0 && t[j - 1]!.rol !== "cliente") j--; // unir fragmentos del mismo turno del agente
    return t.slice(j, i + 1).filter((x) => x.rol === "agente").map((x) => x.texto).join("");
  };
  let turnosVoz = 0;
  let extra = 0;
  const hablar = async (intencion: string | null, interrumpe: boolean): Promise<boolean> => {
    const ag = ultimoAgente();
    const pista = intencion === null ? "(El guion ya no tiene mas frases: continue solo si el agente espera respuesta; si no, FIN.)" : `(Su frase prevista en este punto es: "${intencion}". PERO si el agente acaba de preguntarle otra cosa, conteste primero eso con sus datos y deje la frase prevista para cuando corresponda; no se repita ni se queje.)`;
    conv.push({ role: "user", content: `${ag === "" ? "(La llamada acaba de conectarse; el agente aun no habla. Usted saluda y empieza su pedido.)" : `El agente dice: ${ag}`}\n${pista}` });
    let dicho = (await o.pedirCliente({ sistema, mensajes: conv })).trim().replace(/^["“]|["”]$/g, "");
    if (dicho === "") dicho = intencion ?? "FIN";
    conv.push({ role: "assistant", content: dicho });
    if (/^FIN\b/i.test(dicho)) return false;
    turnosVoz += 1;
    if (interrumpe) await ctrl.usuarioHabla();
    await ctrl.usuarioDijo(dicho);
    await sync();
    return true;
  };
  if (iniciada) {
    for (const t of g.turnos) {
      switch (t.kind) {
        case "voz":
          if (!(await hablar(t.cliente, Boolean(t.interrumpe)))) {
            // el cliente simulado cree que ya termino: se deja correr el resto de eventos no verbales
          }
          break;
        case "confuso": await ctrl.usuarioDijo(t.cliente, false); break;
        case "no_entendido": await ctrl.noEntendido(); break;
        case "silencio": await ctrl.silencio(t.ms); break;
        case "ruido": await ctrl.ruido(); break;
        case "dtmf": await ctrl.dtmf(t.digito); break;
        case "tick": await ctrl.tick(t.segundos); break;
        case "costo": await ctrl.costo(t.microUsd); break;
        case "proveedor_cae": proveedor.caer?.(); await sync(); break;
        case "cuelga": await ctrl.clienteCuelga(); break;
      }
      if (ctrl.maquina.estadoActual === "cerrada") break;
    }
    // Turnos extra: el agente sigue esperando algo del cliente (el guion fijo habria colgado aqui).
    while (ctrl.maquina.estadoActual !== "cerrada" && extra < MAX_EXTRA && /\?\s*$/.test(ultimoAgente().trim())) {
      extra += 1;
      if (!(await hablar(null, false))) break;
    }
  }
  await sync();
  if (iniciada && ctrl.maquina.estadoActual !== "cerrada") await ctrl.clienteCuelga();
  const resultado = iniciada ? (ctrl.maquina.resultado ?? "abandonado") : "no_iniciada";
  return { guion: g, mundo, iniciada, resultado, pregrabados, audioCortado, transcripcion: ctrl.transcripcion, tools, logs, kpi, textosGuardia, turnosVoz, extra } as never;
}
