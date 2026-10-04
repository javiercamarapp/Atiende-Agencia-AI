// Transportes de las herramientas de voz de citas hacia el servidor.
//  * HTTP (worker de voz): `POST /v1/citas/:orgSlug/voz/:herramienta`, autenticadas con el secreto de plataforma `x-atiende-tool-secret` (el mismo
//    `VOICE_TOOL_SECRET` de siempre; el negocio sale del `orgSlug` de la ruta). El TELEFONO sale del SIP From de la llamada (lo inyecta el transporte
//    DESPUES de que el ejecutor del core quito cualquier telefono que escribiera el modelo): nunca de lo que dice el modelo.
//  * En proceso (simulador y pruebas): llama directo a `ejecutarToolVozCitas`, el mismo codigo que ejecutan las rutas.
import { transporteHttp as transporteHttpCore } from "@atiende/voice-core";
import type { TransporteTools } from "@atiende/voice-core";
import { ejecutarToolVozCitas, esToolVozCitas, rutaToolVozCitas } from "./tools-servidor.ts";
import type { CitasVozContexto } from "./tools-servidor.ts";

export interface TransporteHttpCitasOpciones {
  /** Origen de la API (sin barra final). */
  readonly baseUrl: string;
  readonly orgSlug: string;
  /** Secreto de plataforma (cabecera, nunca en el cuerpo). */
  readonly toolSecret: string;
  /** Telefono canonico de la llamada (del SIP From); null = llamante anonimo (solo consultas). */
  readonly telefono: string | null;
  readonly llamadaId: string;
  readonly fetchFn?: typeof fetch;
}

export function transporteHttpCitas(opts: TransporteHttpCitasOpciones): TransporteTools {
  let base = opts.baseUrl;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const core = transporteHttpCore({
    raiz: `${base}/v1/citas/${encodeURIComponent(opts.orgSlug)}/voz`,
    ruta: (nombre) => (esToolVozCitas(nombre) ? rutaToolVozCitas(nombre) : `/desconocida/${encodeURIComponent(nombre)}`),
    cabeceras: { "x-atiende-tool-secret": opts.toolSecret },
    entidadId: (nombre, cuerpo) => {
      if (typeof cuerpo !== "object" || cuerpo === null || "error" in cuerpo) return null;
      const cita = (cuerpo as { appointment?: { appointment_id?: unknown } }).appointment;
      return ["crear_cita", "cancelar_cita", "reagendar_cita", "modificar_cita"].includes(nombre) && typeof cita?.appointment_id === "string" ? cita.appointment_id : null;
    },
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
  });
  return (nombre, args, senal) => core(nombre, { ...args, ...(opts.telefono ? { telefono: opts.telefono } : {}), llamada_id: opts.llamadaId }, senal);
}

export function transporteEnProcesoCitas(ctx: Omit<CitasVozContexto, "telefono" | "llamadaId">, llamada: { readonly telefono: string | null; readonly llamadaId: string }): TransporteTools {
  return (nombre, args) => ejecutarToolVozCitas({ ...ctx, telefono: llamada.telefono ?? "", llamadaId: llamada.llamadaId }, nombre, args);
}
