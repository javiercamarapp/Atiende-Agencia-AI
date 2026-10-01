// Mapeo producto de Atiende <-> codigo de SoftRestaurant.
//
// Hoy el menu de PM cargado en Atiende es provisional y NO trae codigos del POS
// (`pm/brechas.md` A1: el dueño exportara el catalogo con codigos/modificadores).
// Este modulo es la pieza PURA que, cuando llegue el catalogo real (o el
// `syncCatalog` del adaptador real), convierte renglones de pedido en renglones de
// comanda. Un producto sin codigo NUNCA se inventa: se reporta en `sinCodigo` y el
// outbox manda la comanda a captura manual.
import type { CatalogoPos, ItemComanda, ModificadorComanda, SucursalPos } from "./types.ts";

export interface EntradaMapaProducto {
  /** `restaurantes.products.id` de Atiende. */
  readonly productId: string;
  readonly codigo: string;
  /** null/undefined = aplica a todas las sucursales. */
  readonly sucursal?: SucursalPos | null;
}

export interface ResolverCodigosPos {
  codigoDeProducto(productId: string, sucursal: SucursalPos): string | null;
  productoDeCodigo(codigo: string, sucursal: SucursalPos): string | null;
}

/** Mapa en memoria. Una entrada especifica de sucursal gana sobre la general. */
export class MapaProductoCodigo implements ResolverCodigosPos {
  private readonly porProducto = new Map<string, string>();
  private readonly porCodigo = new Map<string, string>();

  constructor(entradas: readonly EntradaMapaProducto[] = []) {
    for (const e of entradas) this.agregar(e);
  }

  agregar(e: EntradaMapaProducto): void {
    if (!e.codigo.trim()) throw new Error("MapaProductoCodigo: codigo vacio");
    const sucursal = e.sucursal ?? "*";
    this.porProducto.set(`${e.productId}|${sucursal}`, e.codigo);
    this.porCodigo.set(`${e.codigo}|${sucursal}`, e.productId);
  }

  codigoDeProducto(productId: string, sucursal: SucursalPos): string | null {
    return this.porProducto.get(`${productId}|${sucursal}`) ?? this.porProducto.get(`${productId}|*`) ?? null;
  }

  productoDeCodigo(codigo: string, sucursal: SucursalPos): string | null {
    return this.porCodigo.get(`${codigo}|${sucursal}`) ?? this.porCodigo.get(`${codigo}|*`) ?? null;
  }
}

/** Resolver vacio: ningun producto tiene codigo (estado real de hoy). */
export const RESOLVER_SIN_CODIGOS: ResolverCodigosPos = {
  codigoDeProducto: () => null,
  productoDeCodigo: () => null,
};

function normalizarNombre(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface ResultadoConstruirMapa {
  readonly mapa: MapaProductoCodigo;
  /** Productos de Atiende para los que el catalogo del POS no tiene un nombre igual. */
  readonly sinCodigo: readonly string[];
  /** Codigos del POS que ningun producto de Atiende reclamo. */
  readonly codigosSinProducto: readonly string[];
}

/**
 * Empareja catalogo del POS con productos de Atiende por nombre normalizado
 * (sin acentos/mayusculas/puntuacion). Solo empareja coincidencias EXACTAS tras
 * normalizar; si dos items del POS normalizan al mismo nombre, no empareja ninguno
 * (ambiguo) y los deja en `codigosSinProducto`. Sugerencia para el sync inicial; el
 * dueño debe revisar `sinCodigo` antes de prender el modo activo.
 */
export function construirMapaDesdeCatalogo(
  catalogo: CatalogoPos,
  productos: readonly { readonly id: string; readonly name: string }[],
): ResultadoConstruirMapa {
  const porNombre = new Map<string, string[]>();
  for (const item of catalogo.items) {
    const key = normalizarNombre(item.nombre);
    porNombre.set(key, [...(porNombre.get(key) ?? []), item.codigo]);
  }
  const mapa = new MapaProductoCodigo();
  const usados = new Set<string>();
  const sinCodigo: string[] = [];
  for (const p of productos) {
    const candidatos = porNombre.get(normalizarNombre(p.name));
    if (candidatos && candidatos.length === 1) {
      mapa.agregar({ productId: p.id, codigo: candidatos[0]!, sucursal: catalogo.sucursal });
      usados.add(candidatos[0]!);
    } else {
      sinCodigo.push(p.id);
    }
  }
  const codigosSinProducto = catalogo.items.map((i) => i.codigo).filter((c) => !usados.has(c));
  return { mapa, sinCodigo, codigosSinProducto };
}

export interface RenglonPedidoParaComanda {
  readonly productId: string;
  readonly cantidad: number;
  readonly modificadores?: readonly ModificadorComanda[];
  readonly nota?: string;
}

export type ResultadoRenglones =
  | { readonly ok: true; readonly items: readonly ItemComanda[] }
  | { readonly ok: false; readonly productosSinCodigo: readonly string[] };

/** Convierte renglones de pedido a items de comanda, o lista los productos sin codigo POS. */
export function renglonesAItemsComanda(
  renglones: readonly RenglonPedidoParaComanda[],
  sucursal: SucursalPos,
  resolver: ResolverCodigosPos,
): ResultadoRenglones {
  const items: ItemComanda[] = [];
  const faltan: string[] = [];
  for (const r of renglones) {
    const codigo = resolver.codigoDeProducto(r.productId, sucursal);
    if (!codigo) {
      faltan.push(r.productId);
      continue;
    }
    items.push({ codigo, cantidad: r.cantidad, modificadores: r.modificadores ?? [], ...(r.nota ? { nota: r.nota } : {}) });
  }
  return faltan.length > 0 ? { ok: false, productosSinCodigo: faltan } : { ok: true, items };
}
