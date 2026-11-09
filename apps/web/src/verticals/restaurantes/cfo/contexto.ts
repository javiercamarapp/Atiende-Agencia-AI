// CFO-07 · contrato entre `CfoLayout` y cada pestaña del registro (`paginas.ts`), más los ayudantes del drill-down a la lista de pedidos.
// CFO-08 agrega sus pestañas al registro y recibe exactamente estas props.
import type { AlcanceVista, FiltroPedidosDetalle } from "@atiende/domain-restaurantes/cfo";
import type { ContextoCfo } from "./cfo-client.ts";
import type { FiltrosCfo } from "./filtros-url.ts";
import { traductorActivo } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { restaurantesCfo } from "@atiende/ui/i18n/restaurantes/cfo";

const tr = traductorActivo(restaurantesCfo);

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

const ESTADOS: Readonly<Record<string, Clave>> = {
  cancelado: "restaurantes.cfo.drill.cancelado",
  entregado: "restaurantes.cfo.drill.entregado",
  completado: "restaurantes.cfo.drill.completado",
  no_recogido: "restaurantes.cfo.drill.no_recogido",
};
const DIAS: readonly Clave[] = ["restaurantes.cfo.dia.1", "restaurantes.cfo.dia.2", "restaurantes.cfo.dia.3", "restaurantes.cfo.dia.4", "restaurantes.cfo.dia.5", "restaurantes.cfo.dia.6", "restaurantes.cfo.dia.7"];

/** Texto legible (en el idioma activo) de cada llave activa del filtro (para el encabezado de la lista de pedidos). */
export function describirFiltro(f: FiltroPedidosDetalle): string[] {
  const out: string[] = [];
  if (f.canal) out.push(f.canal === "domicilio" ? tr("restaurantes.cfo.drill.domicilio") : f.canal === "recoger" ? tr("restaurantes.cfo.drill.recoger") : tr("restaurantes.cfo.drill.canal", { canal: f.canal }));
  if (f.source) out.push(tr("restaurantes.cfo.drill.origen", { origen: f.source === "voice" ? tr("restaurantes.cfo.drill.voz") : f.source === "whatsapp" ? "WhatsApp" : f.source }));
  if (f.status) {
    const clave = ESTADOS[f.status];
    out.push(clave ? tr(clave) : tr("restaurantes.cfo.drill.estado", { estado: f.status }));
  }
  if (f.payment_method) out.push(f.payment_method === "efectivo" ? tr("restaurantes.cfo.drill.efectivo") : f.payment_method === "tarjeta" ? tr("restaurantes.cfo.drill.tarjeta") : tr("restaurantes.cfo.drill.pago", { pago: f.payment_method }));
  if (f.producto_ref) out.push(tr("restaurantes.cfo.drill.producto"));
  if (f.es_venta === true) out.push(tr("restaurantes.cfo.drill.soloVentas"));
  if (f.es_compensacion === true) out.push(tr("restaurantes.cfo.drill.compensaciones"));
  if (f.con_descuento === true) out.push(tr("restaurantes.cfo.drill.conDescuento"));
  if (f.entrega_tarde === true) out.push(tr("restaurantes.cfo.drill.entregaTarde"));
  if (f.dow_negocio !== undefined) {
    const dia = DIAS[f.dow_negocio - 1];
    out.push(tr("restaurantes.cfo.drill.dia", { dia: dia ? tr(dia) : f.dow_negocio }));
  }
  if (f.hora_local !== undefined) out.push(tr("restaurantes.cfo.drill.hora", { hora: f.hora_local }));
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
