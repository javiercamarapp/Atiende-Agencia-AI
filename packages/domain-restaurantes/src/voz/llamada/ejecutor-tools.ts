// Ejecutor de herramientas de la llamada. Reglas que impone (defensa en profundidad; el servidor las vuelve a aplicar):
//   * SOLO corren las tools del REGISTRO UNICO para el canal de voz (`toolDefinitionsForChannel("voz")`); un nombre
//     inventado por el modelo nunca llega al servidor y se responde como error;
//   * el telefono NUNCA se toma de los argumentos: se quitan las claves que parezcan un telefono (el numero sale del token
//     de llamada, firmado con el caller ID del SIP From);
//   * cada llamada tiene TIMEOUT: pasado el limite se responde un error honesto al modelo y se marca `timeout` para la
//     maquina de la llamada. Un `crear_pedido` que expira queda como resultado INCIERTO (el servidor puede haberlo
//     registrado): se le dice al modelo que no lo asegure al cliente y se ofrece verificacion por una persona;
//   * se mide la latencia de cada tool (alimenta el p95 de KPI, `voice_event`).
import { AGENT_TOOL_DEFINITIONS, executeAgentToolSafely, toolDefinitionsForChannel, VOICE_TOOL_HTTP_PATHS } from "../../agent-tools/registry.ts";
import type { AgentToolContext, AgentToolDefinition, AgentToolName } from "../../agent-tools/registry.ts";
import type { RestaurantesRepository } from "../../repository.ts";

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
export type TransporteTools = (nombre: AgentToolName, args: Readonly<Record<string, unknown>>, senal: AbortSignal) => Promise<{ readonly resultado: unknown; readonly orderId: string | null }>;

const CLAVES_TELEFONO_RE = /^(phone|telefono|tel|celular|customer_?phone|caller_?(id|phone))$/i;

export function sanearArgumentos(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return {};
  const limpio: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (!CLAVES_TELEFONO_RE.test(k)) limpio[k] = v;
  return limpio;
}

export interface EjecutorToolsOpciones {
  readonly transporte: TransporteTools;
  readonly timeoutMs: number;
  readonly ahora?: () => number;
}

export interface EjecutorTools {
  definiciones(): readonly AgentToolDefinition[];
  ejecutar(nombre: string, args: unknown): Promise<ResultadoTool>;
}

export function crearEjecutorTools(opts: EjecutorToolsOpciones): EjecutorTools {
  const ahora = opts.ahora ?? Date.now;
  const permitidas = new Set<string>(toolDefinitionsForChannel("voz").map((t) => t.name));
  return {
    definiciones: () => toolDefinitionsForChannel("voz"),
    async ejecutar(nombre, args) {
      const t0 = ahora();
      if (!permitidas.has(nombre) || !AGENT_TOOL_DEFINITIONS.some((t) => t.name === nombre)) {
        return { resultado: { error: `Herramienta desconocida: ${nombre}` }, ok: false, timeout: false, orderId: null, latenciaMs: 0 };
      }
      const control = new AbortController();
      let temporizador: ReturnType<typeof setTimeout> | undefined;
      const expira = new Promise<"timeout">((resolve) => {
        temporizador = setTimeout(() => {
          control.abort();
          resolve("timeout");
        }, opts.timeoutMs);
      });
      try {
        const salida = await Promise.race([opts.transporte(nombre as AgentToolName, sanearArgumentos(args), control.signal), expira]);
        const latenciaMs = Math.max(0, ahora() - t0);
        if (salida === "timeout") {
          const incierto = nombre === "crear_pedido";
          return {
            resultado: {
              error: incierto
                ? "No se pudo confirmar si el pedido quedó registrado. No le asegure al cliente que quedó; dígale que una persona verificará su pedido."
                : "La herramienta tardó demasiado. Pida un momento al cliente e intente una vez más o pase con una persona.",
              timeout: true,
              ...(incierto ? { incierto: true } : {}),
            },
            ok: false,
            timeout: true,
            orderId: null,
            latenciaMs,
          };
        }
        const conError = typeof salida.resultado === "object" && salida.resultado !== null && "error" in salida.resultado;
        return { resultado: salida.resultado, ok: !conError, timeout: false, orderId: conError ? null : salida.orderId, latenciaMs };
      } catch {
        if (control.signal.aborted) return { resultado: { error: "La herramienta tardó demasiado.", timeout: true }, ok: false, timeout: true, orderId: null, latenciaMs: Math.max(0, ahora() - t0) };
        return { resultado: { error: "Error interno al ejecutar la herramienta" }, ok: false, timeout: false, orderId: null, latenciaMs: Math.max(0, ahora() - t0) };
      } finally {
        if (temporizador) clearTimeout(temporizador);
      }
    },
  };
}

/** Transporte EN PROCESO: llama al registro unico sobre un repositorio (simulador y pruebas; nunca produccion). */
export function transporteEnProceso(repo: RestaurantesRepository, ctx: AgentToolContext): TransporteTools {
  return async (nombre, args) => {
    const salida = await executeAgentToolSafely(repo, ctx, nombre, args as Record<string, unknown>);
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
  const fetchFn = opts.fetchFn ?? fetch;
  let base = opts.baseUrl;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const raiz = `${base}/v1/restaurantes/${encodeURIComponent(opts.orgSlug)}`;
  return async (nombre, args, senal) => {
    const respuesta = await fetchFn(`${raiz}${VOICE_TOOL_HTTP_PATHS[nombre]}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-atiende-call-token": opts.callToken },
      body: JSON.stringify(args),
      signal: senal,
    });
    let cuerpo: unknown;
    try {
      cuerpo = await respuesta.json();
    } catch {
      cuerpo = null;
    }
    if (!respuesta.ok) {
      const mensaje = typeof cuerpo === "object" && cuerpo !== null && "message" in cuerpo && typeof (cuerpo as { message: unknown }).message === "string" ? (cuerpo as { message: string }).message : `HTTP ${respuesta.status}`;
      return { resultado: { error: mensaje }, orderId: null };
    }
    const orderId = nombre === "crear_pedido" && typeof cuerpo === "object" && cuerpo !== null ? ((cuerpo as { order?: { id?: unknown } }).order?.id as string | undefined) ?? null : null;
    return { resultado: cuerpo, orderId: typeof orderId === "string" ? orderId : null };
  };
}
