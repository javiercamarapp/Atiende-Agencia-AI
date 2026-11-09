// POST /v1/restaurantes/voz/turno -- turno de VOZ del cerebro v2: el worker de voz (Deepgram STT -> esta ruta -> TTS, `VOZ_CEREBRO=suelto`, cliente
// `apps/voice-worker/src/cerebro-voz-turno.ts`) manda lo que dijo el cliente y habla el `texto` que regresa. Mismo contrato que la Edge Function
// `voz-turno` del repo suelto:
//
//   POST {call_id, telefono, texto, seq, aviso_dado?} + header x-voz-turno-secret
//   apertura = seq 0 con texto vacio; turnos = seq 1..n; `[silencio]` cuando el cliente no habla
//   200 {texto, pedido_id, fin, turno, seq_ultimo?}  (seq_ultimo solo en una apertura repetida)
//   409 {error: "...en proceso..." | "...se adelantó..."} = reintentar el MISMO seq; otro 409 = bug del worker (no reintenta)
//   429 + Retry-After (<= 5 s rafaga, > 5 s tope)   503 {fin: true, texto} = interruptor/apagado (hablar y colgar)   400/401 = no reintenta
//
// Autenticacion: `x-voz-turno-secret` es un SECRETO POR SUCURSAL (mismo hash sha256 que `restaurantes.voice_branch_secret`, rotable desde el panel);
// fija organizacion y sucursal. Sin coincidencia: 401. Solo responde a organizaciones con `cerebro_v2 = true` (migracion 190): las demas reciben
// 503 con fin, asi ningun otro tenant cambia. Sin la migracion 191 (o 190/026): 503 con fin y la frase de apagado, nunca 500.
// Interruptor de emergencia: VOZ_TURNO_APAGADO=1 (503 con fin, sin tocar la base ni el modelo).
import { Hono } from "hono";
import { TEXTO_APAGADO_VOZ, turnoVoz, VozTurnoConflictoError, VozTurnoInvalidoError, VozTurnoLimiteError, VozTurnoNoDisponibleError } from "@atiende/domain-restaurantes/voz-turno";
import type { TransaccionVoz } from "@atiende/domain-restaurantes/voz-turno";
import type { AppDeps } from "../../../deps.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { hashVoiceSecret } from "./voice-auth.ts";

export const VOZ_TURNO_RUTA = "/v1/restaurantes/voz/turno";
export const VOZ_TURNO_SECRET_HEADER = "x-voz-turno-secret";

export type ResultadoAuthVozTurno =
  | { readonly estado: "ok"; readonly organizationId: string; readonly propertyId: string; readonly cerebroV2: boolean }
  | { readonly estado: "no_coincide" }
  /** La base no tiene las migraciones del turno de voz (026/190/191). */
  | { readonly estado: "no_disponible" };

/** Puertos de la ruta (produccion: `production/voz-turno-deps.ts`; pruebas: dobles en memoria). */
export interface VozTurnoPuertos {
  /** Interruptor de emergencia (variable de entorno). */
  apagado(): boolean;
  /** Resuelve el secreto (hash sha256) a organizacion + sucursal y lee la bandera cerebro_v2. */
  autenticar(secretHash: string): Promise<ResultadoAuthVozTurno>;
  /** Una transaccion de sistema para la llamada (ver `turnoVoz`). */
  enTransaccion<T>(llamada: { readonly organizationId: string; readonly propertyId: string }, fn: (tx: TransaccionVoz) => Promise<T>): Promise<T>;
}

const apagadoJson = { texto: TEXTO_APAGADO_VOZ, pedido_id: null, fin: true, turno: 0 } as const;

export function restaurantesVozTurnoRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post(VOZ_TURNO_RUTA, async (c) => {
    const secreto = c.req.header(VOZ_TURNO_SECRET_HEADER);
    if (!secreto) return c.json({ error: "No autorizado" }, 401);
    const puertos = deps.vozTurno;
    // Sin gateway LLM o sin cableado: apagado honesto (el worker habla la frase y cuelga).
    if (!puertos || puertos.apagado()) return c.json(apagadoJson, 503);

    const auth = await puertos.autenticar(hashVoiceSecret(secreto));
    if (auth.estado === "no_disponible") {
      logEvent(c, "warn", "restaurantes_voz_turno_no_disponible", { causa: "secreto" });
      return c.json(apagadoJson, 503);
    }
    if (auth.estado === "no_coincide") return c.json({ error: "No autorizado" }, 401);
    if (!auth.cerebroV2) return c.json(apagadoJson, 503);

    const entrada = await readJsonCapped<Record<string, unknown>>(c.req.raw, 8 * 1024);
    const llamada = { organizationId: auth.organizationId, propertyId: auth.propertyId };
    try {
      const respuesta = await turnoVoz(entrada, { ...llamada, enTransaccion: (fn) => puertos.enTransaccion(llamada, fn) });
      logEvent(c, "info", "restaurantes_voz_turno", { organizationId: auth.organizationId, turno: respuesta.turno, fin: respuesta.fin, conPedido: respuesta.pedido_id !== null });
      return c.json(respuesta, 200);
    } catch (err) {
      if (err instanceof VozTurnoInvalidoError) return c.json({ error: err.message }, 400);
      if (err instanceof VozTurnoConflictoError) return c.json({ error: err.message }, 409);
      if (err instanceof VozTurnoLimiteError) return c.json({ error: "Demasiadas solicitudes" }, 429, { "Retry-After": String(err.retryAfterS) });
      if (err instanceof VozTurnoNoDisponibleError) {
        logEvent(c, "warn", "restaurantes_voz_turno_no_disponible", { causa: "hilos" });
        return c.json(apagadoJson, 503);
      }
      throw err;
    }
  });

  return app;
}
