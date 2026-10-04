// Cliente HTTP del worker hacia la API de Atiende. El worker NO tiene acceso a la base: todo pasa por rutas de la API.
//   - Lado "servicio" (INTERNAL_SECRET, cabecera `x-atiende-internal-secret`): contexto de la llamada, conversaciones, turnos, costos, eventos.
//   - Lado "telefonia" (secreto de la sucursal, `x-atiende-tool-secret`): emitir el token de llamada. Las herramientas del agente usan despues el
//     token por llamada (`x-atiende-call-token`) desde `transporteHttp`, nunca el secreto.
// Los errores llevan solo el estado HTTP y un codigo corto: jamas el cuerpo de la respuesta ni los secretos.
import type { TramoLlamada } from "@atiende/voice-core";
import type { VozProveedorFallo } from "@atiende/voice-core";

export class ErrorApi extends Error {
  constructor(
    readonly operacion: string,
    readonly estado: number | null,
  ) {
    super(`api_${operacion}_${estado ?? "red"}`);
  }
  /** La ruta o la base todavia no existen en este despliegue (404/501/503): "no disponible aun", no una falla de la llamada. */
  get noDisponible(): boolean {
    return this.estado === 404 || this.estado === 501 || this.estado === 503;
  }
}

export interface ContextoLlamada {
  readonly habilitado: boolean;
  /** La sucursal ya tiene fila de configuracion de voz. */
  readonly configurada: boolean;
  readonly voiceId: string;
  /** Instruccion completa del agente para ESTA llamada (la arma el servidor con el perfil de PM, el cliente y la hora). */
  readonly instruccion: string;
  /** Gasto de voz del mes de la organizacion (micro-USD); null = no se pudo leer (base sin migrar): no bloquea. */
  readonly gastoMesMicroUsd: number | null;
  /** Hora local (0-23) de la sucursal. */
  readonly horaLocal: number;
}

export interface EntradaIniciarConversacion {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly externalId: string;
  readonly voiceId: string;
  readonly callerPhone: string | null;
  readonly startedAt: string;
}

export interface TurnoRegistro {
  readonly seq: number;
  readonly rol: "cliente" | "agente" | "herramienta";
  readonly texto: string;
  readonly latenciaMs?: number | null;
  readonly costoMicroUsd?: number;
}

export interface OpcionesCliente {
  readonly baseUrl: string;
  readonly internalSecret: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

export class ClienteApi {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly o: OpcionesCliente) {
    this.base = o.baseUrl.replace(/\/+$/, "");
    this.fetchFn = o.fetchFn ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 6_000;
  }

  private async post<T>(operacion: string, ruta: string, cuerpo: unknown, cabeceras: Record<string, string>, intentos = 1): Promise<T> {
    let ultimo: ErrorApi = new ErrorApi(operacion, null);
    for (let i = 0; i < intentos; i++) {
      let res: Response;
      try {
        res = await this.fetchFn(`${this.base}${ruta}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...cabeceras },
          body: JSON.stringify(cuerpo),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        ultimo = new ErrorApi(operacion, null);
        continue;
      }
      if (res.ok) {
        try {
          return (await res.json()) as T;
        } catch {
          throw new ErrorApi(operacion, 502);
        }
      }
      ultimo = new ErrorApi(operacion, res.status);
      // Un 4xx (salvo 408/429) no mejora reintentando.
      if (res.status < 500 && res.status !== 408 && res.status !== 429) throw ultimo;
    }
    throw ultimo;
  }

  private servicio(): Record<string, string> {
    return { "x-atiende-internal-secret": this.o.internalSecret };
  }

  /** Alta de llamada: el token por llamada. `callerPhone` sale del SIP From (nunca del modelo). */
  async pedirToken(e: { orgSlug: string; secreto: string; callId: string; callerPhone: string; branchSlug: string }): Promise<string> {
    const r = await this.post<{ call_token?: unknown }>(
      "call_token",
      `/v1/restaurantes/${encodeURIComponent(e.orgSlug)}/voice/call-token`,
      { call_id: e.callId, caller_phone: e.callerPhone, branch_slug: e.branchSlug },
      { "x-atiende-tool-secret": e.secreto },
      2,
    );
    if (typeof r.call_token !== "string" || r.call_token.length === 0) throw new ErrorApi("call_token", 502);
    return r.call_token;
  }

  async contexto(e: { organizationId: string; propertyId: string; callerPhone: string | null }): Promise<ContextoLlamada> {
    const r = await this.post<Partial<ContextoLlamada>>("contexto", "/internal/restaurantes/voz/llamada/contexto", e, this.servicio(), 2);
    if (typeof r.instruccion !== "string" || typeof r.habilitado !== "boolean" || typeof r.voiceId !== "string" || typeof r.horaLocal !== "number") throw new ErrorApi("contexto", 502);
    return {
      habilitado: r.habilitado,
      configurada: r.configurada === true,
      voiceId: r.voiceId,
      instruccion: r.instruccion,
      gastoMesMicroUsd: typeof r.gastoMesMicroUsd === "number" ? r.gastoMesMicroUsd : null,
      horaLocal: r.horaLocal,
    };
  }

  async iniciarConversacion(e: EntradaIniciarConversacion): Promise<string> {
    const r = await this.post<{ conversationId?: unknown }>(
      "conversacion",
      "/internal/restaurantes/voz/conversaciones",
      { organizationId: e.organizationId, propertyId: e.propertyId, externalId: e.externalId, canal: "llamada", proveedor: "gemini-3.8-live", voiceId: e.voiceId, ...(e.callerPhone ? { callerPhone: e.callerPhone } : {}), startedAt: e.startedAt },
      this.servicio(),
      2,
    );
    if (typeof r.conversationId !== "string") throw new ErrorApi("conversacion", 502);
    return r.conversationId;
  }

  async marcarModoEntrada(e: { organizationId: string; conversationId: string; modo: string; franja: string }): Promise<void> {
    await this.post("modo_entrada", `/internal/restaurantes/voz/conversaciones/${e.conversationId}/modo-entrada`, { organizationId: e.organizationId, modo: e.modo, franja: e.franja }, this.servicio(), 2);
  }

  async registrarTurno(organizationId: string, conversationId: string, t: TurnoRegistro): Promise<void> {
    await this.post(
      "turno",
      `/internal/restaurantes/voz/conversaciones/${conversationId}/turnos`,
      { organizationId, seq: t.seq, rol: t.rol, texto: t.texto, ...(t.latenciaMs !== undefined && t.latenciaMs !== null ? { latenciaMs: Math.round(t.latenciaMs) } : {}), costoMicroUsd: Math.max(0, Math.round(t.costoMicroUsd ?? 0)) },
      this.servicio(),
      2,
    );
  }

  async registrarEvento(e: { organizationId: string; propertyId: string; conversationId: string | null; tipo: "tool_call"; herramienta: string; latenciaMs: number } | { organizationId: string; propertyId: string; conversationId: string | null; tipo: "error_proveedor"; proveedor: VozProveedorFallo; codigo: string }): Promise<void> {
    await this.post("evento", "/internal/restaurantes/voz/eventos", e, this.servicio(), 1);
  }

  /** Costo por escalon (la API arma los eventos de `core.usage_cost_event` desde los tramos, no desde importes del worker). */
  async registrarCosto(e: { organizationId: string; propertyId: string; conversationId: string; llamadaId: string; ocurridoEn: string; tramos: readonly TramoLlamada[] }): Promise<void> {
    await this.post("costo", `/internal/restaurantes/voz/conversaciones/${e.conversationId}/costo`, { organizationId: e.organizationId, propertyId: e.propertyId, llamadaId: e.llamadaId, ocurridoEn: e.ocurridoEn, tramos: e.tramos }, this.servicio(), 2);
  }

  async cerrar(e: { organizationId: string; conversationId: string; resultado: string; orderId: string | null; endedAt: string }): Promise<void> {
    await this.post(
      "cerrar",
      `/internal/restaurantes/voz/conversaciones/${e.conversationId}/cerrar`,
      { organizationId: e.organizationId, resultado: e.resultado, endedAt: e.endedAt, ...(e.orderId ? { orderId: e.orderId } : {}) },
      this.servicio(),
      3,
    );
  }
}
