// Telefono del llamante: de donde sale y cuando NO se puede confiar en el. El caller ID (SIP From) viaja al token firmado de la llamada y de ahi a las
// herramientas (Cliente 360, pedido, callbacks); si es el equivocado, el pedido y el historial caerian en otro "cliente". Con un desvio condicional de la linea de
// la sucursal (Telmex/Telcel/conmutador) puede ocurrir que la red RE-ORIGINE la llamada y el `From` que llega al puente sea el numero de la SUCURSAL (o el del
// propio puente), no el del cliente. Esto no esta verificado para la red mexicana (investigacion de voz, 4-oct): la guarda es obligatoria hasta que la primera
// llamada real desviada demuestre lo contrario (capturar el INVITE: docs/VOZ-ACTIVACION.md).
//
// Regla: el telefono es CONFIABLE solo si hay un `From` valido que no coincide con (1) ningun numero de la tabla DNIS (los numeros puente), (2) ninguna linea de la
// sucursal declarada en `numerosSucursal`, ni (3) el numero que aparece en el encabezado de desvio (`Diversion` / `History-Info`: la linea que desvio, que es la de la
// sucursal). En cualquier otro caso (vacio, anonimo o uno de esos numeros) se trata como "sin telefono confiable": el agente PIDE el telefono al cliente y lo confirma.
import { extraerTelefonoSipFrom } from "@atiende/domain-restaurantes";
import { normalizarNumero } from "./config.ts";
import type { EntradaDnis } from "./config.ts";

export type MotivoTelefonoNoConfiable = "sin_from" | "anonimo" | "numero_puente" | "numero_sucursal" | "numero_de_desvio";

export interface ResolucionTelefono {
  /** Telefono canonico de 10 digitos SOLO si es confiable; null si hay que pedirlo al cliente. */
  readonly telefono: string | null;
  readonly confiable: boolean;
  readonly motivo: "ok" | MotivoTelefonoNoConfiable;
  /** La llamada trae encabezado de desvio. */
  readonly desviada: boolean;
}

/** Numeros (10 digitos) que aparecen como URI `sip:`/`tel:` en un encabezado `Diversion` o `History-Info` (puede traer varias entradas separadas por coma). */
export function numerosDeCabeceraDesvio(cabecera: string | null | undefined): string[] {
  if (typeof cabecera !== "string" || cabecera.trim() === "" || cabecera.length > 1024) return [];
  const encontrados = new Set<string>();
  for (const m of cabecera.matchAll(/(?:sips?|tel):\s*\+?([0-9][0-9\s().-]{6,})(?=[@;>?,\s]|$)/gi)) {
    const n = normalizarNumero(m[1]);
    if (n) encontrados.add(n);
  }
  return [...encontrados];
}

export interface EntradaResolucion {
  readonly sipFrom: string | null;
  readonly desviadaDesde: string | null;
  readonly entrada: EntradaDnis;
  /** Todos los numeros puente de la tabla DNIS (claves, normalizadas a 10 digitos). */
  readonly numerosPuente: ReadonlySet<string>;
}

export function resolverTelefonoLlamante(e: EntradaResolucion): ResolucionTelefono {
  const desviada = typeof e.desviadaDesde === "string" && e.desviadaDesde.trim() !== "";
  const noConfiable = (motivo: MotivoTelefonoNoConfiable): ResolucionTelefono => ({ telefono: null, confiable: false, motivo, desviada });
  if (e.sipFrom === null || e.sipFrom.trim() === "") return noConfiable("sin_from");
  const telefono = extraerTelefonoSipFrom(e.sipFrom);
  if (telefono === null) return noConfiable("anonimo");
  const clave = normalizarNumero(telefono);
  if (clave !== null) {
    if (e.numerosPuente.has(clave)) return noConfiable("numero_puente");
    if (e.entrada.numerosSucursal.includes(clave)) return noConfiable("numero_sucursal");
    if (numerosDeCabeceraDesvio(e.desviadaDesde).includes(clave)) return noConfiable("numero_de_desvio");
  }
  return { telefono, confiable: true, motivo: "ok", desviada };
}

/** Herramienta que solo existe en el worker (no en el registro de la API) mientras el caller ID no es confiable. */
export const TOOL_CONFIRMAR_TELEFONO = "confirmar_telefono_llamante";

export const DEFINICION_CONFIRMAR_TELEFONO = {
  name: TOOL_CONFIRMAR_TELEFONO,
  description:
    "Registra el teléfono de 10 dígitos que el CLIENTE le dictó y que ya le repitió y confirmó. Úsela UNA vez, antes de cualquier otra herramienta. Sin esto, cotizar y crear_pedido no funcionan en esta llamada. El número dictado sirve para el pedido y el aviso, pero NO identifica al cliente: buscar_cliente y historial_pedidos responden como cliente nuevo y no hay pedidos que repetir.",
  parameters: {
    type: "object",
    properties: { numero: { type: "string", description: "Los 10 dígitos que dictó el cliente, sin lada de país (ej. 9991234567)." } },
    required: ["numero"],
  },
} as const;

/** Anexo a la instruccion cuando el caller ID no sirve: el agente pide y confirma el telefono antes de tomar el pedido. El texto del cliente nunca decide la sucursal. */
export const INSTRUCCION_TELEFONO_NO_CONFIABLE = `# TELÉFONO DEL CLIENTE (esta llamada)
La línea no nos dio el teléfono del cliente. Después del saludo y del aviso, y ANTES de cotizar o tomar el pedido:
1. Pídale su número a 10 dígitos para el pedido.
2. Repítaselo en grupos de 3-3-4 y pídale que lo confirme.
3. Con su confirmación, llame ${TOOL_CONFIRMAR_TELEFONO} con ese número.
Ese número solo sirve para el pedido y el aviso: no identifica al cliente, así que no ofrezca "lo de siempre" ni mencione direcciones o pedidos anteriores. Mientras no lo registre, ninguna otra herramienta funciona. Si el cliente no quiere dar su teléfono, dígale con amabilidad que sin él no puede tomar el pedido por teléfono y despídase.`;
