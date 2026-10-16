// CFO-07 · contrato entre `CfoLayout` y cada pestaña del registro (`paginas.ts`), más los ayudantes del drill-down a la lista de pedidos.
// CFO-08 agrega sus pestañas al registro y recibe exactamente estas props.
import type { AlcanceVista, FiltroPedidosDetalle } from "@atiende/domain-restaurantes/cfo";
import type { ContextoCfo } from "./cfo-client.ts";
import type { FiltrosCfo } from "./filtros-url.ts";

export interface CfoPaginaProps {
  readonly api: ContextoCfo;
  readonly role: string;
  readonly orgSlug: string;
  /** `/restaurantes/:orgSlug` */
  readonly base: string;
  readonly filtros: FiltrosCfo;
  readonly alcance: AlcanceVista;
  readonly setFiltros: (cambios: Partial<FiltrosCfo>) => void;
  /** Abre la lista de pedidos (sin PII) que respalda una cifra; el estado vive en la URL (`?pedidos=1&...`). */
  readonly abrirPedidos: (filtro: FiltroPedidosDetalle) => void;
  /** Slugs de las pestañas registradas: una acción que apunta a otra no se enlaza (no hay enlaces muertos). */
  readonly pestanasDisponibles: ReadonlySet<string>;
}

const CLAVES_TEXTO = ["canal", "source", "status", "payment_method", "producto_ref"] as const;
const CLAVES_BOOL = ["es_venta", "es_compensacion", "con_descuento", "entrega_tarde"] as const;
const CLAVES_ENTERO = ["hora_local", "dow_negocio"] as const;
const CLAVES_DRILL: readonly string[] = [...CLAVES_TEXTO, ...CLAVES_BOOL, ...CLAVES_ENTERO];

export function pedidosAbiertos(sp: URLSearchParams): boolean {
  return sp.get("pedidos") === "1";
}

/** Filtro del detalle de pedidos a partir de la URL (solo las llaves que el API acepta). */
export function filtroDeParams(sp: URLSearchParams): FiltroPedidosDetalle {
  const out: Record<string, string | boolean | number> = {};
  for (const k of CLAVES_TEXTO) {
    const v = sp.get(k);
    if (v) out[k] = v.slice(0, 100);
  }
  for (const k of CLAVES_BOOL) {
    const v = sp.get(k);
    if (v === "1" || v === "true") out[k] = true;
    else if (v === "0" || v === "false") out[k] = false;
  }
  for (const k of CLAVES_ENTERO) {
    const v = sp.get(k);
    // Mismos límites que el API: hora 0..23, día de negocio 1..7 (lo demás se ignora en vez de mandarlo y recibir un 422).
    if (v !== null && /^\d{1,2}$/.test(v) && Number(v) >= (k === "dow_negocio" ? 1 : 0) && Number(v) <= (k === "dow_negocio" ? 7 : 23)) out[k] = Number(v);
  }
  return out as FiltroPedidosDetalle;
}

export function quitarDrill(sp: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(sp);
  out.delete("pedidos");
  for (const k of CLAVES_DRILL) out.delete(k);
  return out;
}

export function aplicarDrill(sp: URLSearchParams, filtro: FiltroPedidosDetalle): URLSearchParams {
  const out = quitarDrill(sp);
  out.set("pedidos", "1");
  for (const [k, v] of Object.entries(filtro)) {
    if (v === undefined) continue;
    out.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }
  return out;
}

const DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"] as const;
const ESTADOS: Readonly<Record<string, string>> = { cancelado: "Cancelados", entregado: "Entregados", completado: "Completados", no_recogido: "No recogidos" };

/** Texto legible de cada llave activa del filtro (para el encabezado de la lista de pedidos). */
export function describirFiltro(f: FiltroPedidosDetalle): string[] {
  const out: string[] = [];
  if (f.canal) out.push(f.canal === "domicilio" ? "A domicilio" : f.canal === "recoger" ? "Para recoger" : `Canal ${f.canal}`);
  if (f.source) out.push(`Origen: ${f.source === "voice" ? "voz" : f.source === "whatsapp" ? "WhatsApp" : f.source}`);
  if (f.status) out.push(ESTADOS[f.status] ?? `Estado ${f.status}`);
  if (f.payment_method) out.push(f.payment_method === "efectivo" ? "Pagados en efectivo" : f.payment_method === "tarjeta" ? "Pagados con tarjeta" : `Pago ${f.payment_method}`);
  if (f.producto_ref) out.push("De un producto");
  if (f.es_venta === true) out.push("Solo ventas");
  if (f.es_compensacion === true) out.push("Compensaciones");
  if (f.con_descuento === true) out.push("Con descuento");
  if (f.entrega_tarde === true) out.push("Entrega tardía");
  if (f.dow_negocio !== undefined) out.push(`Día: ${DIAS[f.dow_negocio - 1] ?? f.dow_negocio}`);
  if (f.hora_local !== undefined) out.push(`Hora: ${f.hora_local} h`);
  return out;
}

/**
 * La acción de un hallazgo trae una ruta relativa (`/cfo/ventas?sucursal=…&desde=…&hasta=…[&status=…]`). Devuelve el enlace
 * dentro de la app conservando comparar/vista, o null si la pestaña de destino aún no existe (el texto se muestra sin enlace).
 */
export function enlaceDeAccion(ruta: string, base: string, filtros: FiltrosCfo, disponibles: ReadonlySet<string>): string | null {
  const m = /^\/cfo\/([a-z0-9-]+)(?:\?(.*))?$/.exec(ruta);
  if (!m || !disponibles.has(m[1]!)) return null;
  const q = new URLSearchParams(m[2] ?? "");
  const out = new URLSearchParams();
  out.set("desde", q.get("desde") ?? filtros.desde);
  out.set("hasta", q.get("hasta") ?? filtros.hasta);
  out.set("comparar", filtros.comparar);
  const sucursal = q.get("sucursal");
  if (sucursal) out.set("sucursales", sucursal);
  else if (filtros.sucursales) out.set("sucursales", filtros.sucursales.join(","));
  const filtroDrill = filtroDeParams(q);
  if (Object.keys(filtroDrill).length > 0) {
    out.set("pedidos", "1");
    for (const k of CLAVES_DRILL) {
      const v = q.get(k);
      if (v !== null) out.set(k, v);
    }
  }
  return `${base}/cfo/${m[1]}?${out.toString()}`;
}
