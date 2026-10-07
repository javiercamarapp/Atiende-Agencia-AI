// Taxonomia cerrada de quejas y cancelaciones (autopiloto, A-24/C-13). Las listas viven aqui y en la base (CHECK/validacion de
// `solicitud_resolver` y `pedido_cancelar_cliente`); un motivo fuera de la lista se rechaza SIEMPRE antes de tocar el pedido.

export const MOTIVOS_QUEJA = ["faltante", "equivocado", "frio", "tarde", "trato", "otro"] as const;
export type MotivoQueja = (typeof MOTIVOS_QUEJA)[number];

export const MOTIVOS_CANCELACION = ["cliente_desistio", "sin_producto", "fuera_de_zona", "duplicado", "error_agente", "otro"] as const;
export type MotivoCancelacion = (typeof MOTIVOS_CANCELACION)[number];

export const ETIQUETA_MOTIVO_CANCELACION: Readonly<Record<MotivoCancelacion, string>> = {
  cliente_desistio: "El cliente desistio",
  sin_producto: "Sin producto",
  fuera_de_zona: "Fuera de zona",
  duplicado: "Pedido duplicado",
  error_agente: "Error del agente",
  otro: "Otro",
};

export const ETIQUETA_MOTIVO_QUEJA: Readonly<Record<MotivoQueja, string>> = {
  faltante: "Faltante",
  equivocado: "Producto equivocado",
  frio: "Llego frio",
  tarde: "Llego tarde",
  trato: "Trato",
  otro: "Otro",
};

export function esMotivoCancelacion(valor: unknown): valor is MotivoCancelacion {
  return typeof valor === "string" && (MOTIVOS_CANCELACION as readonly string[]).includes(valor);
}

export function esMotivoQueja(valor: unknown): valor is MotivoQueja {
  return typeof valor === "string" && (MOTIVOS_QUEJA as readonly string[]).includes(valor);
}

/**
 * KPI "precision del agente" = 1 - (cancelaciones `error_agente` + quejas `equivocado` atribuibles a pedidos del agente) / pedidos del
 * agente. `null` sin pedidos del agente (nunca 100 % inventado). Acotado a [0, 1].
 */
export function precisionAgente(input: { readonly pedidosAgente: number; readonly cancelacionesErrorAgente: number; readonly quejasEquivocado: number }): number | null {
  if (!(input.pedidosAgente > 0)) return null;
  const errores = Math.max(0, input.cancelacionesErrorAgente) + Math.max(0, input.quejasEquivocado);
  return Math.min(1, Math.max(0, 1 - errores / input.pedidosAgente));
}

/**
 * Subtipo de una queja a partir de lo que escribio el cliente (lista cerrada `MOTIVOS_QUEJA`). Deterministico: no usa el modelo. Lo ambiguo cae en
 * `otro`; el subtipo solo ordena la bandeja y alimenta la precision del agente, nunca decide una compensacion.
 */
export function subtipoQueja(texto: string): MotivoQueja {
  const t = texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/equivocad|mal armad|no era lo que pedi|me mandaron otr|no es lo que pedi|cambiaron mi pedido/.test(t)) return "equivocado";
  if (/\bfalt(?:o|aron|a|ante|antes)\b|incompleto|no llego (?:la|el|los|las)|sin (?:la|el|los|las) \w+ que pedi/.test(t)) return "faltante";
  if (/\bfri[oa]s?\b|helad[oa]/.test(t)) return "frio";
  if (/llego tarde|tardo|tardaron|demor|mucho tiempo|una hora/.test(t)) return "tarde";
  if (/grosero|mal trato|maltrat|me trataron|descortes|pesimo servicio|mala atencion/.test(t)) return "trato";
  return "otro";
}
