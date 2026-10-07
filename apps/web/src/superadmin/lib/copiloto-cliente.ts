// Cliente del Copiloto de PLATAFORMA (superadmin) contra las rutas reales de apps/api (`routes/superadmin-copiloto.ts`):
//   POST/GET /superadmin/copiloto[/estado|/conversaciones...]   -> el transporte generico `crearTransporteCopiloto`, con step-up automatico
//   GET  /superadmin/copiloto/acciones/:propuesta               -> estado de una propuesta de `proponer_accion`
//   POST /superadmin/copiloto/acciones/confirmar                -> confirma apagar/encender un agente (motivo + step-up)
//   POST /superadmin/acciones/intents/:id/confirmar             -> confirma un intent del catalogo (step-up)
// Nada se inventa: cualquier fallo se traduce a un estado honesto. `fetchImpl` es inyectable (las pruebas nunca tocan la red).
import { CopilotoAccionError } from "@atiende/ui";
import type { CopilotoAccionEstado, CopilotoAccionPropuesta, CopilotoAccionVista, CopilotoAccionesCliente, FijadosCliente } from "@atiende/ui";
import { crearClienteFijados } from "../../lib/copiloto/fijados.ts";
import { crearTransporteCopiloto } from "../../lib/copiloto/transporte.ts";
import type { CopilotoTransporteVertical } from "../../lib/copiloto/transporte.ts";
import { fetchConStepUp, solicitarStepUp, stepUpVigente } from "./stepup.ts";

export const RUTA_COPILOTO = "/superadmin/copiloto";
export const RUTA_PENDIENTES = "/superadmin/acciones";

const base = (apiBaseUrl: string): string => apiBaseUrl.replace(/\/$/, "");

function esObjeto(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export type EstadoCopilotoSuperadmin =
  | {
      readonly tipo: "ok";
      readonly disponible: boolean;
      readonly permitido: boolean;
      readonly motivo: "no_activado" | "interruptor_apagado" | "tope_mensual" | null;
      readonly usoMensualPct: number | null;
      readonly propone: boolean;
      /** El servidor ofrece el tablero de fijados (superadmin completo; `finanzas` no). */
      readonly fijados: boolean;
      /** El servidor ofrece "Adjuntar archivo" (superadmin completo; `finanzas` no). */
      readonly adjuntos: boolean;
      readonly stepUpRequerido: boolean;
    }
  | { readonly tipo: "sin_acceso" }
  /** 409: el Copiloto de plataforma no se usa mientras el superadmin impersona a una organizacion. */
  | { readonly tipo: "impersonando"; readonly mensaje: string }
  | { readonly tipo: "error" };

/** GET /superadmin/copiloto/estado. 403 = sin acceso; 409 = impersonando; cualquier otro fallo = "error" (nunca se asume disponible). */
export async function consultarEstadoSuperadmin(apiBaseUrl: string, token: string, senal?: AbortSignal, fetchImpl: typeof fetch = (...args) => fetch(...args)): Promise<EstadoCopilotoSuperadmin> {
  try {
    const stepUp = stepUpVigente(token);
    const res = await fetchImpl(`${base(apiBaseUrl)}${RUTA_COPILOTO}/estado`, {
      headers: { authorization: `Bearer ${token}`, ...(stepUp ? { "x-stepup-token": stepUp } : {}) },
      ...(senal ? { signal: senal } : {}),
    });
    if (res.status === 403) return { tipo: "sin_acceso" };
    if (res.status === 409) {
      const cuerpo: unknown = await res.json().catch(() => null);
      const mensaje = esObjeto(cuerpo) && typeof cuerpo["message"] === "string" ? cuerpo["message"] : "El Copiloto no está disponible mientras impersonas a una organización.";
      return { tipo: "impersonando", mensaje };
    }
    if (!res.ok) return { tipo: "error" };
    const json: unknown = await res.json();
    if (!esObjeto(json) || typeof json["disponible"] !== "boolean") return { tipo: "error" };
    const motivo = json["motivo"] === "no_activado" || json["motivo"] === "interruptor_apagado" || json["motivo"] === "tope_mensual" ? json["motivo"] : null;
    const gasto = esObjeto(json["gastoMes"]) ? json["gastoMes"]["usoPct"] : null;
    const acciones = esObjeto(json["acciones"]) ? json["acciones"]["propone"] : false;
    return {
      tipo: "ok",
      disponible: json["disponible"],
      permitido: json["permitido"] === true,
      motivo,
      usoMensualPct: typeof gasto === "number" && Number.isFinite(gasto) ? Math.min(100, Math.max(0, gasto)) : null,
      propone: acciones === true,
      fijados: json["fijados"] === true,
      adjuntos: json["adjuntos"] === true,
      stepUpRequerido: json["stepUpRequerido"] === true,
    };
  } catch {
    return { tipo: "error" };
  }
}

/** Transporte del chat de plataforma: el generico, con step-up automatico (una consulta financiera sin MFA reciente abre el dialogo y se reintenta). "Fijar" solo se ofrece
 *  cuando el servidor lo declara (`fijados` del estado: superadmin completo); sin eso el boton no se pinta (nunca un boton que responde 403). */
export function crearTransporteSuperadmin(apiBaseUrl: string, token: string, fetchImpl?: typeof fetch, opciones: { readonly fijados?: boolean; readonly adjuntos?: boolean } = {}): CopilotoTransporteVertical {
  const conStepUp: typeof fetch = (input, init) => fetchConStepUp(apiBaseUrl, token, String(input), init ?? {});
  return crearTransporteCopiloto({ baseUrl: `${base(apiBaseUrl)}${RUTA_COPILOTO}`, fetchImpl: fetchImpl ?? conStepUp, token, fijados: opciones.fijados === true, adjuntos: opciones.adjuntos === true });
}

/** Cliente del tablero de fijados de plataforma (`/superadmin/copiloto/pins`): re-ejecuta cada fijado con el step-up de ahora (una consulta financiera sin MFA reciente abre el dialogo y se reintenta). */
export function crearClienteFijadosSuperadmin(apiBaseUrl: string, token: string, fetchImpl?: typeof fetch): FijadosCliente {
  const conStepUp: typeof fetch = (input, init) => fetchConStepUp(apiBaseUrl, token, String(input), init ?? {});
  return crearClienteFijados({ baseUrl: `${base(apiBaseUrl)}${RUTA_COPILOTO}`, fetchImpl: fetchImpl ?? conStepUp, token });
}

const ESTADOS: ReadonlySet<string> = new Set<CopilotoAccionEstado>(["pendiente", "ejecutada", "fallida", "cancelada", "vencida", "archivada"]);

/** Cliente de las tarjetas de accion. `confirmar` pide el step-up ANTES de enviar: si la persona cancela el dialogo no sale ninguna confirmacion. */
export function crearClienteAcciones(apiBaseUrl: string, token: string, fetchImpl: typeof fetch = (...args) => fetch(...args)): CopilotoAccionesCliente {
  const url = (ruta: string): string => `${base(apiBaseUrl)}${ruta}`;
  const cabeceras = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  return {
    enlacePendientes: RUTA_PENDIENTES,

    async consultar(p: CopilotoAccionPropuesta, senal: AbortSignal): Promise<CopilotoAccionVista> {
      const ruta = `${RUTA_COPILOTO}/acciones/${encodeURIComponent(p.propuesta)}${p.clase === "interruptor" && p.agente ? `?agente=${encodeURIComponent(p.agente)}` : ""}`;
      const res = await fetchImpl(url(ruta), { headers: { authorization: `Bearer ${token}` }, signal: senal });
      if (!res.ok) throw new Error("no se pudo consultar la propuesta");
      const json: unknown = await res.json();
      if (!esObjeto(json) || typeof json["estado"] !== "string" || !ESTADOS.has(json["estado"])) throw new Error("respuesta invalida");
      return { estado: json["estado"] as CopilotoAccionEstado, resumen: typeof json["resumen"] === "string" ? json["resumen"] : p.resumen, tipo: typeof json["tipo"] === "string" ? json["tipo"] : p.tipo };
    },

    async confirmar(p, motivo) {
      // 1) Step-up antes de enviar: se pregunta al servidor si hace falta (GET, no ejecuta nada) y, si es asi, se abre el dialogo.
      const estado = await consultarEstadoSuperadmin(apiBaseUrl, token, undefined, fetchImpl);
      if (estado.tipo === "impersonando") throw new CopilotoAccionError("conflicto", estado.mensaje);
      if (estado.tipo === "ok" && estado.stepUpRequerido && !(await solicitarStepUp(apiBaseUrl, token))) throw new CopilotoAccionError("stepup_cancelado");

      // 2) Confirmacion real.
      const esIntent = p.clase === "intent";
      const ruta = esIntent ? `/superadmin/acciones/intents/${encodeURIComponent(p.propuesta)}/confirmar` : `${RUTA_COPILOTO}/acciones/confirmar`;
      const cuerpo = esIntent ? {} : { propuesta: p.propuesta, agente: p.agente ?? "", motivo };
      const res = await fetchConStepUp(apiBaseUrl, token, url(ruta), { method: "POST", headers: cabeceras, body: JSON.stringify(cuerpo) });
      if (res.status === 409) throw new CopilotoAccionError("conflicto");
      if (res.status === 400) throw new CopilotoAccionError("motivo");
      if (res.status === 503) throw new CopilotoAccionError("no_disponible");
      if (res.status === 403) {
        const c: unknown = await res.clone().json().catch(() => null);
        throw new CopilotoAccionError(esObjeto(c) && c["code"] === "stepup_required" ? "stepup_cancelado" : "error");
      }
      if (res.status === 404) throw new CopilotoAccionError("conflicto"); // ajena, inexistente o ya archivada: no se puede ejecutar
      if (!res.ok) throw new CopilotoAccionError("error");
      const json: unknown = await res.json().catch(() => null);
      if (!esIntent) return { estado: "ejecutada" };
      const intent = esObjeto(json) && esObjeto(json["intent"]) ? json["intent"] : null;
      if (intent?.["estado"] === "failed") return { estado: "fallida", ...(typeof intent["error"] === "string" ? { mensaje: intent["error"].slice(0, 200) } : {}) };
      if (intent?.["estado"] === "executed") return { estado: "ejecutada" };
      throw new CopilotoAccionError("error");
    },
  };
}
