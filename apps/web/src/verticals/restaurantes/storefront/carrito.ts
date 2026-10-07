// Logica PURA del carrito del storefront (sin React, sin red): agregar/quitar, paquetes ("orden de 3"),
// tortilla de tacos, avisos de reglas duras ANTES de cotizar (el servidor las vuelve a aplicar siempre:
// esto solo evita ofrecer un boton que el servidor rechazaria). Los totales de aqui son una ESTIMACION de
// pantalla; el total que se cobra es el que devuelve la cotizacion del servidor.
import type { CategoriaMenu, Canal, MetodoPago, ProductoMenu, Tortilla } from "./storefront-client.ts";

export interface RenglonCarrito {
  readonly producto: ProductoMenu;
  /** Numero de ordenes/unidades que ve el cliente (con packSize 3, 2 = 6 piezas). */
  readonly cantidad: number;
  readonly tortilla: Tortilla | null;
}

export type Carrito = readonly RenglonCarrito[];

export const CANTIDAD_MAXIMA = 20;

const claveDe = (id: string, tortilla: Tortilla | null) => `${id}|${tortilla ?? ""}`;

/** Agrega una unidad; un producto "hoy no hay" nunca entra, ni uno que exige tortilla sin elegirla. */
export function agregar(carrito: Carrito, producto: ProductoMenu, tortilla: Tortilla | null = null): Carrito {
  if (!producto.available) return carrito;
  if (producto.requiresTortilla && !tortilla) return carrito;
  const tortillaFinal = producto.requiresTortilla ? tortilla : null;
  const clave = claveDe(producto.id, tortillaFinal);
  const existente = carrito.find((r) => claveDe(r.producto.id, r.tortilla) === clave);
  if (!existente) return [...carrito, { producto, cantidad: 1, tortilla: tortillaFinal }];
  return carrito.map((r) => (r === existente ? { ...r, cantidad: Math.min(CANTIDAD_MAXIMA, r.cantidad + 1) } : r));
}

export function cambiarCantidad(carrito: Carrito, id: string, tortilla: Tortilla | null, cantidad: number): Carrito {
  const clave = claveDe(id, tortilla);
  if (!Number.isFinite(cantidad) || cantidad < 1) return carrito.filter((r) => claveDe(r.producto.id, r.tortilla) !== clave);
  return carrito.map((r) => (claveDe(r.producto.id, r.tortilla) === clave ? { ...r, cantidad: Math.min(CANTIDAD_MAXIMA, Math.floor(cantidad)) } : r));
}

export function subtotal(carrito: Carrito): number {
  return Math.round(carrito.reduce((suma, r) => suma + r.producto.price * r.cantidad, 0) * 100) / 100;
}

export function piezasDe(r: RenglonCarrito): number {
  return r.cantidad * (r.producto.packSize && r.producto.packSize > 1 ? r.producto.packSize : 1);
}

/** Renglones en el formato del servidor: `requested_quantity` son PIEZAS (ordenes x piezas por orden). */
export function aItemsApi(carrito: Carrito): Array<{ product_id: string; requested_quantity: number; tortilla?: Tortilla }> {
  return carrito.map((r) => ({ product_id: r.producto.id, requested_quantity: piezasDe(r), ...(r.tortilla ? { tortilla: r.tortilla } : {}) }));
}

export const hayAlcohol = (carrito: Carrito): boolean => carrito.some((r) => r.producto.requiresAdultConfirmation);
export const productosNoDomicilio = (carrito: Carrito): RenglonCarrito[] => carrito.filter((r) => r.producto.noDomicilio);

export interface AvisoCarrito {
  readonly codigo: "no_domicilio" | "minimo" | "vacio";
  readonly mensaje: string;
  /** true = impide pedir en este canal hasta resolverlo. */
  readonly bloquea: boolean;
}

/** Avisos de reglas duras para el canal elegido (carrito mixto incluido: alcohol + comida a domicilio). */
export function avisos(carrito: Carrito, canal: Canal, minimoDomicilio: number | null, minimoRecoger: number | null): AvisoCarrito[] {
  const out: AvisoCarrito[] = [];
  if (carrito.length === 0) return [{ codigo: "vacio", mensaje: "Tu carrito está vacío.", bloquea: true }];
  if (canal === "domicilio") {
    const prohibidos = productosNoDomicilio(carrito);
    if (prohibidos.length > 0) {
      out.push({
        codigo: "no_domicilio",
        mensaje: `${prohibidos.map((r) => r.producto.name).join(", ")} no se vende${prohibidos.length > 1 ? "n" : ""} a domicilio. Quítalo${prohibidos.length > 1 ? "s" : ""} o cambia a recoger en sucursal.`,
        bloquea: true,
      });
    }
  }
  const minimo = canal === "domicilio" ? minimoDomicilio : minimoRecoger;
  const parcial = subtotal(carrito);
  if (minimo !== null && parcial < minimo) {
    out.push({
      codigo: "minimo",
      mensaje: `El pedido mínimo ${canal === "domicilio" ? "a domicilio" : "para recoger"} es de $${minimo}. Te faltan $${Math.round((minimo - parcial) * 100) / 100}.${canal === "domicilio" ? " Agrega algo más o elige recoger." : ""}`,
      bloquea: true,
    });
  }
  return out;
}

/** Propina: solo con tarjeta (politica "solo_tarjeta"); "siempre" la permite con cualquier pago; "nunca"/null no. */
export function propinaPermitida(politica: "nunca" | "siempre" | "solo_tarjeta" | null, pago: MetodoPago | null): boolean {
  if (politica === "siempre") return true;
  if (politica === "solo_tarjeta") return pago === "tarjeta";
  return false;
}

/** Id de sesion de compra para la maquina de estados del servidor (16-64 caracteres [A-Za-z0-9_-]). */
export function nuevoIdSesion(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

export function formatoPesos(valor: number): string {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: Number.isInteger(valor) ? 0 : 2 }).format(valor);
}

export const ETIQUETA_ESTADO: Record<string, string> = {
  pending: "Recibido",
  preparando: "Preparando tu pedido",
  en_camino: "En camino",
  entregado: "Entregado",
  completado: "Completado",
  cancelado: "Cancelado",
  problema: "Tuvimos una incidencia",
  // Estados del canal recoger (y del pedido programado): sin etiqueta, el cliente veria la clave interna justo cuando debe ir por su pedido.
  listo_para_recoger: "Listo para recoger",
  no_recogido: "No se recogió a tiempo",
  programado: "Programado",
};

/** Minusculas y sin acentos, para buscar "jamon" y encontrar "Jamón". */
export function normalizarBusqueda(texto: string): string {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/** Total de piezas del carrito (suma de cantidades), para el contador de la barra inferior. */
export function totalArticulos(carrito: Carrito): number {
  return carrito.reduce((suma, r) => suma + r.cantidad, 0);
}

/**
 * Filtro LOCAL del menu (sin red) por nombre y descripcion. Cada palabra del texto debe aparecer; las categorias sin
 * coincidencias desaparecen. Texto vacio = el menu completo.
 */
export function filtrarMenu(categorias: readonly CategoriaMenu[], texto: string): CategoriaMenu[] {
  const palabras = normalizarBusqueda(texto).split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return [...categorias];
  return categorias
    .map((c) => ({ ...c, items: c.items.filter((p) => {
      const pajar = normalizarBusqueda(`${p.name} ${p.description ?? ""}`);
      return palabras.every((w) => pajar.includes(w));
    }) }))
    .filter((c) => c.items.length > 0);
}
