// Transportes de las herramientas de voz de hoteles hacia el servidor.
//  * HTTP (worker de voz): mismas rutas que ya existian, `POST /v1/hoteles/:propertyId/voz/...`, autenticadas con el secreto dedicado POR PROPERTY
//    (`hoteles.voice_agent_config.tool_webhook_secret`, H-H05) en la cabecera `x-atiende-tool-secret`. El TELEFONO sale del SIP From de la llamada
//    (lo inyecta el transporte DESPUES de que el ejecutor del core quito cualquier telefono que escribiera el modelo): nunca de lo que dice el modelo.
//  * En proceso (simulador y pruebas): llama directo a `ejecutarToolVozHoteles`, el mismo codigo que ejecutan las rutas.
import { transporteHttp as transporteHttpCore } from "@atiende/voice-core";
import type { TransporteTools } from "@atiende/voice-core";
import { esToolVozHoteles, ejecutarToolVozHoteles, rutaToolVozHoteles } from "./tools-servidor.ts";
import type { ReservasVozContexto } from "./tools-servidor.ts";

export interface TransporteHttpHotelesOpciones {
  /** Origen de la API (sin barra final). */
  readonly baseUrl: string;
  readonly propertyId: string;
  /** Secreto dedicado de la property (cabecera, nunca en el cuerpo). */
  readonly toolSecret: string;
  /** Telefono canonico de la llamada (del SIP From); null = llamante anonimo (solo consultas). */
  readonly telefono: string | null;
  readonly llamadaId: string;
  readonly fetchFn?: typeof fetch;
}

export function transporteHttpHoteles(opts: TransporteHttpHotelesOpciones): TransporteTools {
  let base = opts.baseUrl;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const core = transporteHttpCore({
    raiz: `${base}/v1/hoteles/${encodeURIComponent(opts.propertyId)}/voz`,
    ruta: (nombre) => (esToolVozHoteles(nombre) ? rutaToolVozHoteles(nombre) : `/desconocida/${encodeURIComponent(nombre)}`),
    cabeceras: { "x-atiende-tool-secret": opts.toolSecret },
    entidadId: (nombre, cuerpo) => (nombre === "crear_pre_reserva" && typeof cuerpo === "object" && cuerpo !== null && !("error" in cuerpo) ? (((cuerpo as { pre_reserva_id?: unknown }).pre_reserva_id as string | undefined) ?? null) : null),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
  });
  return (nombre, args, senal) => core(nombre, { ...args, ...(opts.telefono ? { telefono: opts.telefono } : {}), llamada_id: opts.llamadaId }, senal);
}

export function transporteEnProcesoHoteles(ctx: Omit<ReservasVozContexto, "telefono" | "llamadaId">, llamada: { readonly telefono: string | null; readonly llamadaId: string }): TransporteTools {
  return (nombre, args) => ejecutarToolVozHoteles({ ...ctx, telefono: llamada.telefono ?? "", llamadaId: llamada.llamadaId }, nombre, args);
}
