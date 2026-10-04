// Alerta in-app de superadmin `superadmin.salud.cron_sin_latido`: hay crons de alta frecuencia (cadencia <= 15 min, ver
// `./health.ts::CADENCIA_ALTA_FRECUENCIA_MIN`) que NUNCA dejaron un latido en `core.cron_heartbeat`, es decir, el scheduler de Vercel no
// los esta invocando (tipicamente CRON_SECRET distinto de INTERNAL_SECRET, o un plan sin crons frecuentes). Sin esto, esa falla es
// silenciosa: los pedidos programados no pasan a cocina y los WhatsApp fallidos no se reintentan, y nadie se entera.
//
// La llama el cron diario de resumen (`../routes/internal/resumen-diario.ts`). Una por dia (clave de dedupe = fecha UTC), con texto sin
// PII: solo el NUMERO de crons afectados. Best-effort: NUNCA lanza ni altera la respuesta del cron que la invoca. Cada paso abre SU
// PROPIA transaccion de sistema (`withAppSession({ userId: null })`: la lectura de latidos del repo de resumen y la emision), asi que
// el 42883/42P01 de una base sin migrar no deja abortada ninguna transaccion que se siga usando; contra esa base la lectura falla y no se
// emite nada (no hay forma honesta de saber si hay latidos).
import { emitirNotificacion } from "@atiende/db";
import type { AppDeps } from "../deps.ts";
import { contarCronsAltaFrecuenciaSinLatido } from "./health.ts";

export type ResultadoAlertaCronsSinLatido =
  | { readonly estado: "emitida"; readonly cantidad: number }
  | { readonly estado: "sin_problema" }
  | { readonly estado: "no_medido" }
  | { readonly estado: "no_emitida"; readonly cantidad: number };

export async function alertarCronsSinLatidoBestEffort(deps: AppDeps, ahora: Date = new Date()): Promise<ResultadoAlertaCronsSinLatido> {
  let cantidad: number;
  try {
    cantidad = contarCronsAltaFrecuenciaSinLatido(await deps.resumenDiarioRepo.listCronHeartbeatsForSystem());
  } catch {
    return { estado: "no_medido" };
  }
  if (cantidad === 0) return { estado: "sin_problema" };
  try {
    const r = await deps.engine.withAppSession({ userId: null }, (db) =>
      emitirNotificacion(db, { evento: "superadmin.salud.cron_sin_latido", organizationId: null, clave: ahora.toISOString().slice(0, 10), parametros: { cantidad } }),
    );
    // `sin_nuevas` = ya se aviso hoy (dedupe de la base); a efectos de este resultado cuenta como emitida.
    return r.estado === "emitida" || r.estado === "sin_nuevas" ? { estado: "emitida", cantidad } : { estado: "no_emitida", cantidad };
  } catch {
    return { estado: "no_emitida", cantidad };
  }
}
