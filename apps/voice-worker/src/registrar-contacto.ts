// Aviso de «devolver la llamada» cuando el CEREBRO SUELTO falla y el worker le dice al cliente que una persona le devolvera la llamada (error tecnico, presupuesto 409 agotado,
// 400/401/409 de bug). Sin esto nadie queda avisado: el servidor solo registra el aviso en sus propios cierres (tope, dos fallos del modelo). Usa el endpoint suelto
// `registrar-contacto` del repo atiende-restaurantes (CONTRATO-HERRAMIENTAS.md): POST con `x-atiende-tool-secret`, motivo de lista cerrada (`otro`), `conversation_id` = call_id
// (idempotente por conversacion + motivo + hash del mensaje) y el telefono confirmado de la llamada.
//
// Nunca bloquea el colgado (se llama sin await y tiene su propio tiempo maximo), nunca lanza, y los logs llevan solo codigos: ni telefono, ni secreto, ni texto.
import type { AvisoPerdido } from "./cerebro-voz-turno.ts";

export interface OpcionesRegistroAviso {
  /** URL de `registrar-contacto`. */
  readonly url: string;
  /** `VOICE_TOOL_SECRET` (header `x-atiende-tool-secret`): nunca se registra. */
  readonly secreto: string;
  readonly callId: string;
  readonly fetchFn?: typeof fetch;
  readonly log?: (evento: string, campos?: Readonly<Record<string, unknown>>) => void;
  /** Tiempo maximo de cada intento (ms). Por omision 8000. */
  readonly timeoutMs?: number;
}

/** `${base}/voz-turno` -> `${base}/registrar-contacto`; null si la URL no termina en `/voz-turno`. */
export function urlRegistrarContactoDe(urlVozTurno: string): string | null {
  const m = /^(.*)\/voz-turno\/?$/.exec(urlVozTurno.trim());
  return m ? `${m[1]}/registrar-contacto` : null;
}

export interface RegistroAviso {
  /** Registra el aviso (una sola vez por llamada). Devuelve la promesa para poder esperarla al terminar la llamada; nunca rechaza. */
  registrar(aviso: AvisoPerdido): Promise<void>;
}

export function crearRegistroAviso(o: OpcionesRegistroAviso): RegistroAviso {
  const fetchFn = o.fetchFn ?? fetch;
  const log = (evento: string, campos: Readonly<Record<string, unknown>> = {}): void => o.log?.(evento, campos);
  let enviado: Promise<void> | null = null;
  const intentar = async (aviso: AvisoPerdido & { telefono: string }): Promise<number | "red"> => {
    const limite = new AbortController();
    const id = setTimeout(() => limite.abort(), o.timeoutMs ?? 8000);
    try {
      const res = await fetchFn(o.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-atiende-tool-secret": o.secreto },
        body: JSON.stringify({
          customer_name: "Cliente de llamada",
          customer_phone: aviso.telefono,
          motivo: "otro",
          conversation_id: o.callId,
          message: `Llamada no atendida por falla del asistente de voz (${aviso.causa}). Devolver la llamada.`,
        }),
        signal: limite.signal,
      });
      return res.status;
    } catch {
      return "red";
    } finally {
      clearTimeout(id);
    }
  };
  return {
    registrar(aviso) {
      if (enviado) return enviado;
      enviado = (async () => {
        const telefono = aviso.telefono;
        if (telefono === null) {
          log("aviso_devolver_llamada_sin_telefono", { motivo: aviso.motivo, razon: aviso.causa });
          return;
        }
        // Idempotente en el servidor (conversation_id + motivo + mensaje): un reintento ante red/5xx no duplica.
        for (let n = 1; n <= 2; n += 1) {
          const estado = await intentar({ ...aviso, telefono });
          if (typeof estado === "number" && estado >= 200 && estado < 300) {
            log("aviso_devolver_llamada_registrado", { motivo: aviso.motivo, razon: aviso.causa });
            return;
          }
          if (estado === 401) {
            // Secreto de herramientas incorrecto: es configuracion rota, no una falla pasajera. Evento propio para alertar.
            log("aviso_devolver_llamada_config_rota", { codigo: "401", mensaje: "VOICE_TOOL_SECRET incorrecto" });
            return;
          }
          if (typeof estado === "number" && estado < 500) {
            log("aviso_devolver_llamada_rechazado", { codigo: String(estado) });
            return;
          }
          log("aviso_devolver_llamada_fallo", { codigo: String(estado), intento: n });
        }
      })();
      return enviado;
    },
  };
}
