// Log de la llamada SIN datos personales. Dos defensas: (1) lista cerrada de campos que pueden aparecer (nada de texto
// del cliente, direcciones, telefonos ni nombres: solo ids opacos, estados, conteos y duraciones) y (2) los valores de
// texto que si se permiten pasan por `redactarPII`. La transcripcion NO se loguea; se guarda aparte, redactada
// (`redactarTranscripcion`), en `voice_turn`.
import { createHash } from "node:crypto";
import { redactarTranscripcion } from "../transcripcion.ts";

const CAMPOS_PERMITIDOS = new Set([
  "estado", "resultado", "motivo", "mensaje", "herramienta", "ok", "timeout", "ms", "intento", "esperaMs", "razon",
  "costoMicroUsd", "segundos", "proveedor", "codigo", "propertyId", "organizationId", "callRef",
]);

const TELEFONO_RE = /(?<!\d)(?:\+?52[\s-]?1?[\s-]?)?(?:\(?\d{2,3}\)?[\s.-]?)\d{3,4}[\s.-]?\d{4}(?!\d)/g;
const CORREO_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DIRECCION_RE = /\b(calle|c\.|av\.?|avenida|calzada|prolongaci[oó]n|andador|privada|colonia|col\.|fraccionamiento|fracc\.)\s+[^,;\n]{1,60}/gi;

export function redactarPII(texto: string): string {
  return redactarTranscripcion(texto).replace(CORREO_RE, "[CORREO]").replace(DIRECCION_RE, "[DIRECCION]").replace(TELEFONO_RE, "[TELEFONO]");
}

/** Referencia opaca y estable de una llamada para correlacionar logs sin exponer el id del proveedor. */
export function referenciaLlamada(callId: string): string {
  return createHash("sha256").update(callId).digest("hex").slice(0, 12);
}

export type CamposLog = Readonly<Record<string, unknown>>;
export type SumideroLog = (linea: { readonly evento: string; readonly campos: Readonly<Record<string, string | number | boolean>> }) => void;

export function eventoSinPII(sumidero: SumideroLog, evento: string, campos: CamposLog = {}): void {
  const limpio: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(campos)) {
    if (!CAMPOS_PERMITIDOS.has(k)) continue;
    if (typeof v === "string") limpio[k] = redactarPII(v).slice(0, 120);
    else if (typeof v === "number" && Number.isFinite(v)) limpio[k] = v;
    else if (typeof v === "boolean") limpio[k] = v;
  }
  sumidero({ evento, campos: limpio });
}
