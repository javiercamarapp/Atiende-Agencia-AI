// Perfil 360 del cliente y su uso por el agente. PURO (reloj inyectado). Dos vistas:
//   * PerfilCliente360: lo que ve el STAFF (incluye ticket, frecuencia y categorias de queja; sin calle/numero).
//   * PerfilParaAgente: lo que entra al contexto del agente. NUNCA lleva calle, numero, telefono, gasto, ticket ni quejas
//     (solo un booleano de «cuidado especial»). El agente PROPONE, confirma y acepta de inmediato si el cliente lo cambia.
import { esLoDeSiempre } from "../cliente-360/reconocer-recurrente.ts";
import { sanitizeInlineText } from "../text-sanitize.ts";
import type { CanalHistorico, PagoHistorico, QuejaCategoria, TortillaHistorica } from "./limpieza.ts";

export type Frescura = "fresco" | "viejo" | "caducado";
export type FrecuenciaCliente = "sin_historial" | "unica" | "ocasional" | "regular" | "frecuente";

export const DIAS_FRESCO = 30;
export const DIAS_CADUCO = 180;
const MS_DIA = 86_400_000;

/** `fresco` (<= 30 d y de pedido confirmado), `viejo` (31-180 d o importado), `caducado` (> 180 d). Se calcula, no se guarda. */
export function frescuraDelDato(args: { readonly fecha: string | null; readonly importado: boolean; readonly hoy: Date }): Frescura {
  if (args.fecha === null) return args.importado ? "viejo" : "caducado";
  const t = Date.parse(args.fecha.length === 10 ? `${args.fecha}T00:00:00Z` : args.fecha);
  if (!Number.isFinite(t)) return "caducado";
  const dias = Math.floor((args.hoy.getTime() - t) / MS_DIA);
  if (dias > DIAS_CADUCO) return "caducado";
  if (dias <= DIAS_FRESCO && !args.importado) return "fresco";
  return "viejo";
}

export function diasDesde(fecha: string | null, hoy: Date): number | null {
  if (fecha === null) return null;
  const t = Date.parse(fecha.length === 10 ? `${fecha}T00:00:00Z` : fecha);
  return Number.isFinite(t) ? Math.max(0, Math.floor((hoy.getTime() - t) / MS_DIA)) : null;
}

/** Entrada ya leida de la base (resumen historico + lo aprendido de pedidos reales). Todo opcional. */
export interface EntradaPerfil {
  readonly nombre?: string | null;
  readonly domicilios?: ReadonlyArray<{ readonly etiqueta: string | null; readonly colonia: string | null; readonly importado: boolean; readonly ultimoUso: string | null; readonly coloniaInferida?: boolean; readonly sinColonia?: boolean }>;
  readonly historico?: {
    readonly canal: CanalHistorico | null;
    readonly pago: PagoHistorico | null;
    readonly tortilla: TortillaHistorica | null;
    readonly salsas: readonly string[];
    readonly omisiones: readonly string[];
    readonly favoritos: readonly string[];
    readonly pedidos: number;
    readonly gastoMxn: number;
    readonly ticketMxn: number | null;
    readonly primerPedido: string | null;
    readonly ultimoPedido: string | null;
    readonly quejas: readonly QuejaCategoria[];
    readonly revisionHumana?: boolean;
  };
  /** Gustos aprendidos de pedidos confirmados (ganan sobre el historico). */
  readonly gustosReales?: ReadonlyArray<{ readonly kind: "tortilla" | "salsa" | "omision" | "pago" | "canal"; readonly valor: string; readonly veces: number; readonly ultimaVez: string }>;
  readonly pedidosReales?: number;
  readonly ultimoPedidoReal?: string | null;
  /** Canal por el que escribe hoy (whatsapp | voz | web). */
  readonly canalActual?: string | null;
}

export interface GustoPerfil {
  readonly kind: "tortilla" | "salsa" | "omision" | "pago" | "canal";
  readonly valor: string;
  readonly frescura: Frescura;
  readonly fuente: "pedido" | "importacion";
}

export interface PerfilCliente360 {
  readonly nombre: string | null;
  readonly domicilios: ReadonlyArray<{ readonly etiqueta: string | null; readonly colonia: string | null; readonly frescura: Frescura; readonly requierePin: boolean }>;
  readonly gustos: readonly GustoPerfil[];
  readonly favoritos: readonly string[];
  readonly frecuencia: FrecuenciaCliente;
  readonly pedidosTotales: number;
  readonly pedidosReales: number;
  readonly ultimaCompra: string | null;
  readonly diasDesdeUltimaCompra: number | null;
  readonly ticketMxn: number | null;
  readonly quejas: readonly QuejaCategoria[];
  readonly canalActual: string | null;
  readonly tieneHistorialImportado: boolean;
  readonly revisionHumana: boolean;
}

/** Frecuencia por pedidos y ritmo (pedidos por mes entre primer y ultimo). Umbrales fijos y documentados. */
export function clasificarFrecuencia(pedidos: number, primer: string | null, ultimo: string | null): FrecuenciaCliente {
  if (pedidos <= 0) return "sin_historial";
  if (pedidos === 1) return "unica";
  const meses = primer && ultimo ? Math.max(1, (Date.parse(`${ultimo}T00:00:00Z`) - Date.parse(`${primer}T00:00:00Z`)) / (MS_DIA * 30)) : 1;
  const porMes = pedidos / meses;
  if (porMes >= 2 || pedidos >= 12) return "frecuente";
  if (porMes >= 0.75 || pedidos >= 5) return "regular";
  return "ocasional";
}

export function construirPerfil360(e: EntradaPerfil, hoy: Date): PerfilCliente360 {
  const h = e.historico;
  const gustos = new Map<string, GustoPerfil>();
  const clave = (k: string, v: string) => `${k}\u0000${v}`;
  for (const g of e.gustosReales ?? []) gustos.set(clave(g.kind, g.valor), { kind: g.kind, valor: g.valor, frescura: frescuraDelDato({ fecha: g.ultimaVez, importado: false, hoy }), fuente: "pedido" });
  const fechaImp = h?.ultimoPedido ?? null;
  const impF = frescuraDelDato({ fecha: fechaImp, importado: true, hoy });
  const hayReal = (k: string) => (e.gustosReales ?? []).some((g) => g.kind === k);
  if (h) {
    // Un gusto de pedido real del mismo tipo pisa al importado de valor unico (tortilla, pago, canal).
    if (h.tortilla && !hayReal("tortilla")) gustos.set(clave("tortilla", h.tortilla), { kind: "tortilla", valor: h.tortilla, frescura: impF, fuente: "importacion" });
    if (h.pago && !hayReal("pago")) gustos.set(clave("pago", h.pago), { kind: "pago", valor: h.pago, frescura: impF, fuente: "importacion" });
    if (h.canal && !hayReal("canal")) gustos.set(clave("canal", h.canal), { kind: "canal", valor: h.canal, frescura: impF, fuente: "importacion" });
    if (!hayReal("salsa")) for (const s of h.salsas) gustos.set(clave("salsa", s), { kind: "salsa", valor: s, frescura: impF, fuente: "importacion" });
    if (!hayReal("omision")) for (const o of h.omisiones) gustos.set(clave("omision", o), { kind: "omision", valor: o, frescura: impF, fuente: "importacion" });
  }
  const pedidosReales = e.pedidosReales ?? 0;
  const pedidosTotales = pedidosReales + (h?.pedidos ?? 0);
  const ultimaCompra = [e.ultimoPedidoReal ?? null, h?.ultimoPedido ?? null].filter((x): x is string => x !== null).map((x) => x.slice(0, 10)).sort().pop() ?? null;
  return {
    nombre: e.nombre ? sanitizeInlineText(e.nombre, 80) : null,
    domicilios: (e.domicilios ?? []).map((d) => ({
      etiqueta: d.etiqueta ? sanitizeInlineText(d.etiqueta, 60) : null,
      colonia: d.colonia ? sanitizeInlineText(d.colonia, 80) : null,
      frescura: frescuraDelDato({ fecha: d.ultimoUso, importado: d.importado, hoy }),
      // Colonia inferida, ausente o pendiente: NO se ofrece de memoria; se pide pin/colonia.
      requierePin: d.coloniaInferida === true || d.sinColonia === true || d.colonia === null,
    })),
    gustos: [...gustos.values()],
    favoritos: (h?.favoritos ?? []).map((f) => sanitizeInlineText(f, 80)).filter((f) => f !== ""),
    frecuencia: clasificarFrecuencia(pedidosTotales, h?.primerPedido ?? null, ultimaCompra),
    pedidosTotales,
    pedidosReales,
    ultimaCompra,
    diasDesdeUltimaCompra: diasDesde(ultimaCompra, hoy),
    ticketMxn: h?.ticketMxn ?? null,
    quejas: h?.quejas ?? [],
    canalActual: e.canalActual ?? null,
    tieneHistorialImportado: h !== undefined && (h.pedidos > 0 || h.favoritos.length > 0 || h.tortilla !== null || h.pago !== null),
    revisionHumana: h?.revisionHumana === true,
  };
}

// ---------------------------------------------------------------------------
// Vista para el agente
// ---------------------------------------------------------------------------
export type OfertaLoMismo =
  | { readonly tipo: "pedido_real"; readonly instruccion: string }
  | { readonly tipo: "favoritos"; readonly favoritos: readonly string[]; readonly pregunta: string }
  | { readonly tipo: "ninguna" };

export interface PerfilParaAgente {
  readonly domicilios: ReadonlyArray<{ readonly etiqueta: string | null; readonly colonia: string | null; readonly frescura: Frescura; readonly requierePin: boolean }>;
  readonly gustos: readonly GustoPerfil[];
  readonly favoritos: readonly string[];
  readonly pedidosReales: number;
  readonly tieneHistorialImportado: boolean;
  /** true = hubo una incidencia o queja abierta: tono cuidadoso y sin upsell; JAMAS se menciona. */
  readonly cuidadoEspecial: boolean;
  readonly oferta: OfertaLoMismo;
}

function unirNatural(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

/** Oferta determinista de «¿lo mismo que la vez pasada?». Sin pedido real, SOLO favoritos: el total sale de cotizar_pedido, nunca de montos historicos. */
export function ofertaLoMismo(p: Pick<PerfilCliente360, "pedidosReales" | "favoritos">): OfertaLoMismo {
  if (p.pedidosReales > 0) return { tipo: "pedido_real", instruccion: "Usa historial_pedidos y repetir_pedido: re-cotiza con los precios de HOY y avisa lo que cambió antes de confirmar." };
  const favoritos = p.favoritos.slice(0, 2);
  if (favoritos.length > 0) return { tipo: "favoritos", favoritos, pregunta: `¿Le preparo su favorito, ${unirNatural(favoritos)}?` };
  return { tipo: "ninguna" };
}

export function perfilParaAgente(p: PerfilCliente360): PerfilParaAgente {
  return {
    domicilios: p.domicilios,
    gustos: p.gustos,
    favoritos: p.favoritos,
    pedidosReales: p.pedidosReales,
    tieneHistorialImportado: p.tieneHistorialImportado,
    cuidadoEspecial: p.quejas.length > 0 || p.revisionHumana,
    oferta: ofertaLoMismo(p),
  };
}

function nombreDomicilio(d: PerfilParaAgente["domicilios"][number]): string {
  if (d.etiqueta && d.colonia) return `${d.etiqueta} (${d.colonia})`;
  return d.etiqueta ?? d.colonia ?? "sin etiqueta";
}

const ETIQUETA_FRESCURA: Readonly<Record<Frescura, string>> = { fresco: "reciente", viejo: "de hace tiempo", caducado: "muy viejo" };

/**
 * Lineas del contexto del agente. Vacio si el cliente no tiene historial importado (el prompt y el arnes actuales no cambian).
 * Reglas: no inventar; confirmar siempre lo importado o viejo; aceptar de inmediato el cambio; nunca calle/numero/montos/quejas.
 */
export function lineasPerfilHistorico(p: PerfilParaAgente | undefined | null): string[] {
  if (!p || !p.tieneHistorialImportado) return [];
  const out: string[] = [];
  out.push("Este cliente tiene historial importado de pedidos anteriores (dato VIEJO y no verificado hoy): confirma SIEMPRE antes de usarlo, no lo des por hecho y acepta de inmediato si lo cambia; si no está aquí, pregúntalo, nunca lo completes por probabilidad.");
  const ofrecibles = p.domicilios.filter((d) => !d.requierePin && d.frescura !== "caducado");
  if (ofrecibles.length > 0) out.push(`Domicilio que puedes confirmar (por etiqueta o colonia, nunca calle ni número): «${nombreDomicilio(ofrecibles[0]!)}», ${ETIQUETA_FRESCURA[ofrecibles[0]!.frescura]}.`);
  else if (p.domicilios.length > 0) out.push("Su domicilio guardado es incierto (colonia inferida, faltante o muy viejo): NO lo ofrezcas; pide la colonia o el pin de ubicación.");
  const gustos = p.gustos.filter((g) => g.frescura !== "caducado");
  const tortilla = gustos.find((g) => g.kind === "tortilla");
  const salsas = gustos.filter((g) => g.kind === "salsa").map((g) => g.valor);
  const pago = gustos.find((g) => g.kind === "pago");
  if (tortilla) out.push(`Última tortilla conocida: ${tortilla.valor}. Pregunta "¿${tortilla.valor === "maiz" ? "maíz" : tortilla.valor} como siempre?"; si dice otra, usa la que diga.`);
  if (salsas.length > 0) out.push(`Salsas que solía pedir: ${salsas.join(", ")}. Confírmalas, no las agregues sin preguntar.`);
  if (pago) out.push(`Forma de pago habitual: ${pago.valor}.${pago.valor === "efectivo" ? " Con efectivo SIEMPRE pregunta con cuánto paga." : ""} Confirma, no lo asumas.`);
  if (p.oferta.tipo === "favoritos") {
    out.push(`Si pide «lo mismo», «lo de siempre» o «lo de la vez pasada» y NO tiene pedidos reales registrados, ofrece su favorito con esta pregunta: «${p.oferta.pregunta}». Arma el pedido con buscar_producto y cotizar_pedido; el total sale SOLO de cotizar_pedido. Si el favorito ya no está en el menú, avísalo. Nunca cites montos ni precios de antes.`);
  } else if (p.oferta.tipo === "pedido_real") {
    out.push(p.oferta.instruccion);
  } else {
    out.push("No hay favoritos ni pedido para repetir: si pide «lo de siempre», dile que no lo tienes a la mano y pregúntale qué quiere.");
  }
  if (p.cuidadoEspecial) out.push("Atiéndelo con especial cuidado: no hagas upsell ni menciones incidentes pasados; si él los saca, una disculpa breve y sigue.");
  return out;
}

/**
 * Contexto determinista para un mensaje: si el cliente pide «lo de siempre» devuelve la instruccion exacta del turno;
 * si no, vacio. Pensado para inyectarse junto al prompt sin sumar una herramienta.
 */
export function contextoLoMismoParaMensaje(p: PerfilParaAgente | undefined | null, mensaje: string): string | null {
  if (!p || !esLoDeSiempre(mensaje)) return null;
  switch (p.oferta.tipo) {
    case "pedido_real":
      return `El cliente pidió repetir su pedido. ${p.oferta.instruccion}`;
    case "favoritos":
      return `El cliente pidió «lo de siempre» y solo hay favoritos importados (dato viejo). Pregunta: «${p.oferta.pregunta}» y espera su confirmación antes de cotizar.`;
    default:
      return "El cliente pidió «lo de siempre» pero no hay nada que repetir: pregúntale qué quiere, no inventes.";
  }
}
