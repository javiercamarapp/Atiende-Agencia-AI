// PM R18 (S1 / G1): el cliente ya dijo «si» a un resumen VIGENTE y el turno murio (proveedor caido, tope de tiempo) antes de que el modelo llamara `crear_pedido`.
// En vez de dejar el pedido sin crear («lo registra un companero»), el SERVIDOR arma los dos llamados que el modelo habria hecho (`confirmar_resumen` y `crear_pedido`) con lo
// que ya tiene guardado de la cotizacion que el cliente vio, y los pasa por la MISMA maquina de estados (huella, cierre, pedido grande, horario, idempotencia). Este modulo es
// PURO: solo decide si hay datos completos y arma el input; no escribe nada ni salta ninguna regla. Sin datos completos devuelve el motivo y el flujo sigue como antes.
import type { OrderFlowContext, OrderFlowSnapshot } from "./order-flow.ts";
import { QUOTE_TTL_MS, RELOJ_TOLERANCIA_MS } from "./order-flow.ts";

/** Lo que el modelo mando en `cotizar_pedido` y que `crear_pedido` necesita pero NO viaja en la cotizacion (nombre, direccion, salsas...). Se guarda tal cual en el flujo. */
export interface DatosCierre {
  readonly customerName?: string;
  readonly customerAddress?: string;
  readonly coloniaEntrega?: string;
  readonly indicacionesAcceso?: string;
  readonly referenciasAcceso?: string;
  readonly direccionEtiqueta?: string;
  readonly mapsUrl?: string;
  readonly usarUbicacionCompartida?: boolean;
  readonly notes?: string;
  readonly requestedComplements?: readonly string[];
  readonly omitDefaultComplements?: readonly string[];
  /** Campos de la HUELLA de la cotizacion: se toman SIEMPRE de la ultima cotizacion (no se fusionan con la anterior), porque definen el pedido que el cliente vio. */
  readonly dobleSalsas?: readonly string[];
  readonly adultConfirmed?: boolean;
}

const TEXTOS = [
  ["customer_name", "customerName"],
  ["customer_address", "customerAddress"],
  ["colonia_entrega", "coloniaEntrega"],
  ["indicaciones_acceso", "indicacionesAcceso"],
  ["referencias_acceso", "referenciasAcceso"],
  ["direccion_etiqueta", "direccionEtiqueta"],
  ["maps_url", "mapsUrl"],
  ["notes", "notes"],
] as const;
const LISTAS = [
  ["requested_complements", "requestedComplements"],
  ["omit_default_complements", "omitDefaultComplements"],
] as const;
const MAX_TEXTO = 500;

function texto(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, MAX_TEXTO) : undefined;
}
function lista(v: unknown): readonly string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().slice(0, 80)).slice(0, 20);
  return out.length > 0 ? out : undefined;
}

/**
 * Datos de cierre de una cotizacion: lo que trae su input, fusionado con lo guardado antes (un campo omitido conserva el anterior). Los campos de la huella
 * (`dobleSalsas`, `adultConfirmed`) NO se fusionan: son los de ESTA cotizacion. Puro; nunca lanza.
 */
export function datosCierreDeCotizacion(input: Readonly<Record<string, unknown>>, previo: DatosCierre | undefined): DatosCierre {
  const out: Record<string, unknown> = { ...(previo ?? {}) };
  for (const [wire, clave] of TEXTOS) {
    const v = texto(input[wire]);
    if (v !== undefined) out[clave] = v;
  }
  for (const [wire, clave] of LISTAS) {
    const v = lista(input[wire]);
    if (v !== undefined) out[clave] = v;
  }
  if (input.usar_ubicacion_compartida === true) out.usarUbicacionCompartida = true;
  const doble = lista(input.doble_salsas);
  if (doble !== undefined) out.dobleSalsas = doble;
  else delete out.dobleSalsas;
  if (input.adult_confirmed === true) out.adultConfirmed = true;
  else delete out.adultConfirmed;
  return out as DatosCierre;
}

export type CierreDeterministaPlan =
  | { readonly ok: true; readonly crearPedido: Record<string, unknown> }
  | { readonly ok: false; readonly motivo: "sin_cotizacion" | "vencida" | "sin_renglones" | "sin_pago" | "sin_nombre" | "sin_direccion" | "sin_colonia" | "ya_creado" };

/**
 * Arma el input de `crear_pedido` SOLO con datos que el servidor ya tiene (cotizacion vigente + lo que el modelo mando al cotizar + el nombre de la ficha del cliente). No inventa nada:
 * si falta el nombre, la forma de pago o (a domicilio) la direccion y la colonia, devuelve el motivo y NO se crea el pedido por esta via.
 */
export function planCierreDeterminista(
  snap: OrderFlowSnapshot | null,
  opciones: { readonly ahoraMs: number; readonly nombreDeLaFicha?: string | null; readonly hayUbicacionCompartida?: boolean },
): CierreDeterministaPlan {
  const ctx: OrderFlowContext | null = snap?.context ?? null;
  if (!snap || !ctx || (snap.state !== "cotizado" && snap.state !== "confirmado")) return { ok: false, motivo: snap?.state === "creado" || snap?.state === "creando" ? "ya_creado" : "sin_cotizacion" };
  if (opciones.ahoraMs - ctx.quotedAtMs > QUOTE_TTL_MS || opciones.ahoraMs - ctx.quotedAtMs < -RELOJ_TOLERANCIA_MS) return { ok: false, motivo: "vencida" };
  if (!ctx.quotedItems || ctx.quotedItems.length === 0 || !ctx.quotedBranchSlug) return { ok: false, motivo: "sin_renglones" };
  if (ctx.quotedPago !== "efectivo" && ctx.quotedPago !== "tarjeta") return { ok: false, motivo: "sin_pago" };
  const datos = ctx.datosCierre ?? {};
  const nombre = datos.customerName ?? texto(opciones.nombreDeLaFicha ?? undefined);
  if (!nombre) return { ok: false, motivo: "sin_nombre" };
  const canal = ctx.quotedCanal === "recoger" ? "recoger" : "domicilio";
  if (canal === "domicilio") {
    if (!datos.customerAddress) return { ok: false, motivo: "sin_direccion" };
    if (!datos.coloniaEntrega) return { ok: false, motivo: "sin_colonia" };
  }
  const crearPedido: Record<string, unknown> = {
    branch_slug: ctx.quotedBranchSlug,
    canal,
    customer_name: nombre,
    // Los renglones salen de la cotizacion RESUELTA (id del catalogo, cantidad pedida, tortilla): la misma lista que `bloqueCotizacionVigente` le dicta al modelo.
    items: ctx.quotedItems.map((i) => ({
      product_id: i.id,
      product_name: i.name,
      requested_quantity: i.qty,
      ...(i.tortilla ? { tortilla: i.tortilla } : i.tortillaKilo ? { tortilla: i.tortillaKilo } : {}),
    })),
    payment_method: ctx.quotedPago,
    ...(ctx.quotedPago === "efectivo" && ctx.quotedEfectivoCon !== undefined ? { efectivo_con: ctx.quotedEfectivoCon } : {}),
    ...(ctx.quotedPropinaMxn !== undefined ? { propina: ctx.quotedPropinaMxn } : ctx.quotedPropinaPct !== undefined ? { propina_porcentaje: ctx.quotedPropinaPct } : {}),
    // Politica vigente: con tarjeta a domicilio SIEMPRE se lleva terminal (el resumen que el cliente acepto lo dice).
    ...(ctx.quotedPago === "tarjeta" && canal === "domicilio" ? { llevar_terminal: true } : {}),
    ...(canal === "domicilio" ? { customer_address: datos.customerAddress, colonia_entrega: datos.coloniaEntrega } : {}),
    ...(datos.indicacionesAcceso ? { indicaciones_acceso: datos.indicacionesAcceso.slice(0, 200) } : {}),
    ...(datos.referenciasAcceso ? { referencias_acceso: datos.referenciasAcceso } : {}),
    ...(datos.direccionEtiqueta ? { direccion_etiqueta: datos.direccionEtiqueta } : {}),
    ...(datos.mapsUrl ? { maps_url: datos.mapsUrl } : {}),
    ...(datos.usarUbicacionCompartida && opciones.hayUbicacionCompartida ? { usar_ubicacion_compartida: true } : {}),
    ...(datos.notes ? { notes: datos.notes } : {}),
    ...(datos.requestedComplements ? { requested_complements: [...datos.requestedComplements] } : {}),
    ...(datos.omitDefaultComplements ? { omit_default_complements: [...datos.omitDefaultComplements] } : {}),
    ...(datos.dobleSalsas ? { doble_salsas: [...datos.dobleSalsas] } : {}),
    ...(datos.adultConfirmed ? { adult_confirmed: true } : {}),
    // La hora cotizada la pone el servidor al crear (recoger: `horaRecogida` / `programadoPara` del flujo); no se manda otra.
  };
  return { ok: true, crearPedido };
}
