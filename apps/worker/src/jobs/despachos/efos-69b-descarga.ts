// runEfos69bDescarga -- D-28: cron MENSUAL que baja la lista 69-B (adaptador `Efos69bSource`, normalmente HttpEfos69bSource),
// la ingiere con `runEfos69bIngestion` (idempotente por SHA-256 y periodo: la misma edicion dos veces = 'sin_cambios') y, si la
// edicion es nueva o corregida, emite `despachos.efos.alerta` por cada CFDI YA ingerido cuyo emisor figura como presunto/definitivo.
//
// La clave de dedupe de la alerta es el id del CFDI (la misma que usa la ingesta manual): un CFDI ya avisado no se vuelve a avisar
// aunque la lista se re-ingiera. Las alertas salen en una transaccion POR property.
import { CronSatNoDisponibleError, EfosUnavailableError, Efos69bFormatoError } from "@atiende/domain-despachos";
import { mensajeDeError } from "./cron-comun.ts";
import type { WithUnidadCronSat } from "./cron-comun.ts";
import { runEfos69bIngestion } from "./efos-69b-ingestion.ts";
import type { Efos69bSource, WithDespachosRepoSistema } from "./efos-69b-ingestion.ts";

const TOPE_ALERTAS = 2000;

export interface Efos69bDescargaResultado {
  readonly estado: "ok" | "no_disponible" | "fallo";
  readonly periodo: string;
  readonly resultado: "insertada" | "sin_cambios" | "reemplazada" | null;
  readonly filas: number;
  readonly descartadas: number;
  readonly alertasEmitidas: number;
  readonly alertasFallidas: number;
  /** Motivo legible cuando `estado` es 'fallo' o 'no_disponible' (sin datos del archivo). */
  readonly detalle?: string;
}

export async function runEfos69bDescarga(withRepo: WithDespachosRepoSistema, withUnidad: WithUnidadCronSat, source: Efos69bSource, periodo: string): Promise<Efos69bDescargaResultado> {
  const base = { periodo, filas: 0, descartadas: 0, alertasEmitidas: 0, alertasFallidas: 0 };
  let ingesta;
  try {
    ingesta = await runEfos69bIngestion(withRepo, source, periodo);
  } catch (err) {
    if (err instanceof EfosUnavailableError) return { ...base, estado: "no_disponible", resultado: null, detalle: err.message };
    if (err instanceof Efos69bFormatoError) return { ...base, estado: "fallo", resultado: null, detalle: `archivo invalido: ${err.message}` };
    return { ...base, estado: "fallo", resultado: null, detalle: mensajeDeError(err) };
  }
  const parcial = { periodo, resultado: ingesta.resultado, filas: ingesta.filas, descartadas: ingesta.descartadas.length };
  if (ingesta.resultado === "sin_cambios") return { ...parcial, estado: "ok", alertasEmitidas: 0, alertasFallidas: 0 };

  let afectados;
  try {
    afectados = await withUnidad((u) => u.repo.listarEfosAfectadosSistema(TOPE_ALERTAS));
  } catch (err) {
    return { ...parcial, estado: "fallo", alertasEmitidas: 0, alertasFallidas: 0, detalle: `ingesta ok, alertas no calculadas: ${mensajeDeError(err)}` };
  }
  if (afectados === null) return { ...parcial, estado: "no_disponible", alertasEmitidas: 0, alertasFallidas: 0, detalle: "Las alertas requieren la migracion 022." };

  const porProperty = new Map<string, typeof afectados>();
  for (const a of afectados) porProperty.set(a.propertyId, [...(porProperty.get(a.propertyId) ?? []), a]);

  let emitidas = 0;
  let fallidas = 0;
  for (const grupo of porProperty.values()) {
    try {
      await withUnidad(async ({ notificar }) => {
        for (const a of grupo) {
          await notificar({ evento: "despachos.efos.alerta", organizationId: a.organizationId, propertyId: a.propertyId, clave: a.invoiceId, entidadTipo: "invoice", entidadId: a.invoiceId });
        }
      });
      emitidas += grupo.length;
    } catch (err) {
      if (err instanceof CronSatNoDisponibleError) break;
      fallidas += grupo.length;
    }
  }
  return { ...parcial, estado: "ok", alertasEmitidas: emitidas, alertasFallidas: fallidas };
}
