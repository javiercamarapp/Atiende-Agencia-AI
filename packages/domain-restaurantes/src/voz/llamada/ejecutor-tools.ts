// Ejecutor de herramientas de la llamada de restaurantes: el nucleo (permitidas, saneo de telefono, timeout, latencia, resultado incierto)
// es de @atiende/voice-core; aqui se conecta al REGISTRO UNICO de tools de restaurantes (`toolDefinitionsForChannel("voz")`) y se conserva
// el vocabulario historico (`orderId`) del transporte y del resultado.
import {
  crearEjecutorTools as crearEjecutorCore,
  sanearArgumentos,
  transporteHttp as transporteHttpCore,
} from "@atiende/voice-core";
import type { ContextoEjecucionTool, EjecutorTools as EjecutorCore, RegistroToolsVoz, ResultadoTool as ResultadoCore, TransporteTools as TransporteCore } from "@atiende/voice-core";
import { executeAgentToolSafely, toolDefinitionsForChannel, VOICE_TOOL_HTTP_PATHS } from "../../agent-tools/registry.ts";
import type { AgentToolContext, AgentToolDefinition, AgentToolName } from "../../agent-tools/registry.ts";
import type { RestaurantesRepository } from "../../repository.ts";

export { sanearArgumentos };

export interface ResultadoTool {
  /** Lo que se devuelve al modelo. */
  readonly resultado: unknown;
  /** El servidor no devolvio un error. */
  readonly ok: boolean;
  readonly timeout: boolean;
  readonly orderId: string | null;
  readonly latenciaMs: number;
}

/** Como se ejecuta de verdad una tool: en proceso (simulador/pruebas) o por HTTP contra la API (worker). */
export type TransporteTools = (nombre: AgentToolName, args: Readonly<Record<string, unknown>>, senal: AbortSignal, contexto?: ContextoEjecucionTool) => Promise<{ readonly resultado: unknown; readonly orderId: string | null }>;

export interface EjecutorToolsOpciones {
  readonly transporte: TransporteTools;
  readonly timeoutMs: number;
  readonly ahora?: () => number;
}

export interface EjecutorTools {
  definiciones(): readonly AgentToolDefinition[];
  ejecutar(nombre: string, args: unknown, contexto?: ContextoEjecucionTool): Promise<ResultadoTool>;
}

/** Registro de tools de voz de restaurantes: solo las del registro unico para el canal `voz`; `crear_pedido` que expira queda incierto. */
export const REGISTRO_TOOLS_PM: RegistroToolsVoz = {
  definiciones: () => toolDefinitionsForChannel("voz"),
  herramientasInciertas: ["crear_pedido"],
  mensajeIncierto: "No se pudo confirmar si el pedido quedó registrado. No le asegure al cliente que quedó; dígale que una persona verificará su pedido.",
};

/** Herramientas del registro de voz que SOLO leen (sin estado de pedido ni efectos): el escalon de Gemini puede correrlas en paralelo cuando el modelo las pide juntas al
 * inicio de un turno. `repetir_pedido` NO esta: arma un pedido a partir del historial (toca el estado del flujo). */
export const HERRAMIENTAS_VOZ_SOLO_LECTURA: ReadonlySet<string> = new Set(["buscar_cliente", "historial_pedidos", "consultar_sucursal", "buscar_sucursal_cercana", "buscar_producto"]);

export function crearEjecutorTools(opts: EjecutorToolsOpciones): EjecutorTools {
  const core = crearEjecutorCore({
    registro: REGISTRO_TOOLS_PM,
    timeoutMs: opts.timeoutMs,
    ...(opts.ahora ? { ahora: opts.ahora } : {}),
    transporte: async (nombre, args, senal, contexto) => {
      const salida = await opts.transporte(nombre as AgentToolName, args, senal, contexto);
      return { resultado: salida.resultado, entidadId: salida.orderId };
    },
  });
  return {
    definiciones: () => core.definiciones() as readonly AgentToolDefinition[],
    async ejecutar(nombre, args, contexto) {
      const r = await core.ejecutar(nombre, args, contexto);
      return aResultadoPm(r);
    },
  };
}

function aResultadoPm(r: ResultadoCore): ResultadoTool {
  return { resultado: r.resultado, ok: r.ok, timeout: r.timeout, orderId: r.entidadId, latenciaMs: r.latenciaMs };
}

/** Adapta el ejecutor de restaurantes (`orderId`) al contrato del core (`entidadId`). */
export function comoEjecutorCore(e: EjecutorTools): EjecutorCore {
  return {
    definiciones: () => e.definiciones(),
    async ejecutar(nombre, args, contexto) {
      const r = await e.ejecutar(nombre, args, contexto);
      return { resultado: r.resultado, ok: r.ok, timeout: r.timeout, entidadId: r.orderId, latenciaMs: r.latenciaMs };
    },
  };
}

/** Transporte EN PROCESO: llama al registro unico sobre un repositorio (simulador y pruebas; nunca produccion). */
export function transporteEnProceso(repo: RestaurantesRepository, ctx: AgentToolContext): TransporteTools {
  return async (nombre, args, _senal, contexto) => {
    // El turno del cliente lo pone el controlador de la llamada (no el modelo): con el, la maquina del pedido exige que la
    // confirmacion llegue en un turno posterior a la cotizacion, igual que en WhatsApp.
    const flow = ctx.flow && contexto?.turno != null ? { ...ctx.flow, turn: String(contexto.turno) } : ctx.flow;
    const salida = await executeAgentToolSafely(repo, { ...ctx, ...(flow ? { flow } : {}) }, nombre, args as Record<string, unknown>);
    return { resultado: salida.result, orderId: salida.orderId };
  };
}

export interface TransporteHttpOpciones {
  readonly baseUrl: string;
  readonly orgSlug: string;
  /** Token firmado de la llamada (`x-atiende-call-token`); lleva org, sucursal, callId y el telefono del SIP From. */
  readonly callToken: string;
  readonly fetchFn?: typeof fetch;
}

/** Transporte HTTP del worker: mismas rutas que el manifiesto del registro (`VOICE_TOOL_HTTP_PATHS`), sin secretos en el cuerpo. */
export function transporteHttp(opts: TransporteHttpOpciones): TransporteTools {
  let base = opts.baseUrl;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const core: TransporteCore = transporteHttpCore({
    raiz: `${base}/v1/restaurantes/${encodeURIComponent(opts.orgSlug)}`,
    ruta: (nombre) => VOICE_TOOL_HTTP_PATHS[nombre as AgentToolName],
    cabeceras: { "x-atiende-call-token": opts.callToken },
    entidadId: (nombre, cuerpo) => (nombre === "crear_pedido" && typeof cuerpo === "object" && cuerpo !== null ? (((cuerpo as { order?: { id?: unknown } }).order?.id as string | undefined) ?? null) : null),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
  });
  return async (nombre, args, senal, contexto) => {
    const salida = await core(nombre, args, senal, contexto);
    return { resultado: salida.resultado, orderId: salida.entidadId };
  };
}
