// Cliente de la lista 69-B del SAT (D-04). GET /despachos/:propertyId/efos/alertas
// (apps/api/.../despachos/efos.ts): invoices ya ingeridos cuyo emisor figura hoy como
// presunto/definitivo. `estado: "no_disponible"` significa que la lista aun no esta cargada
// en la base -- NUNCA debe mostrarse como "sin riesgo".
import { fetchJson } from "./admin-client.ts";

export type EfosSituacionAlerta = "presunto" | "definitivo";

export interface EfosListaEstado {
  readonly estado: "disponible" | "no_disponible";
  readonly periodo: string | null;
  readonly filas: number | null;
  readonly ingestadoEn: string | null;
}

export interface EfosAlerta {
  readonly invoiceId: string;
  readonly folioFiscal: string;
  readonly rfcEmisor: string;
  readonly emisorNombre: string | null;
  readonly fecha: string;
  readonly total: number;
  readonly situacion: EfosSituacionAlerta;
  readonly periodoLista: string;
}

export interface EfosAlertasRespuesta {
  readonly lista: EfosListaEstado;
  readonly estado: "disponible" | "no_disponible";
  readonly alertas: readonly EfosAlerta[];
}

export async function fetchEfosAlertas(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<EfosAlertasRespuesta> {
  return fetchJson<EfosAlertasRespuesta>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/efos/alertas`, token);
}

/** Texto de la tarjeta segun el estado real (puro, probado sin DOM). */
export function resumenEfos(r: EfosAlertasRespuesta): { readonly tono: "neutro" | "ok" | "alerta"; readonly mensaje: string } {
  if (r.estado === "no_disponible") {
    return { tono: "neutro", mensaje: "La lista 69-B del SAT aún no está cargada en este sistema: no se puede descartar riesgo en tus CFDI." };
  }
  if (r.alertas.length === 0) {
    return { tono: "ok", mensaje: `Ningún emisor de tus CFDI figura como presunto o definitivo en la lista 69-B (edición ${r.lista.periodo ?? "vigente"}).` };
  }
  const definitivos = r.alertas.filter((a) => a.situacion === "definitivo").length;
  return { tono: "alerta", mensaje: `${r.alertas.length} CFDI de emisores en la lista 69-B${definitivos > 0 ? ` (${definitivos} DEFINITIVO${definitivos === 1 ? "" : "S"})` : ""}: revísalos antes de deducir o acreditar IVA.` };
}
