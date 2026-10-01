// Cliente del storefront PUBLICO de restaurantes (R-09). Sin sesion: no usa tokens ni authed-fetch.
// `fetchImpl` inyectado (mismo criterio que el resto de lib/*.ts) para probar la red sin jsdom.
// Nunca inventa un mensaje cuando el servidor ya mando uno.

export type Canal = "domicilio" | "recoger";
export type Tortilla = "maiz" | "harina" | "mixta";
export type MetodoPago = "efectivo" | "tarjeta";

export interface SucursalPublica {
  readonly slug: string;
  readonly name: string;
  readonly address: string | null;
  readonly phone: string | null;
  /** null = sin horario configurado: no se afirma abierto ni cerrado. */
  readonly abiertoAhora: boolean | null;
  readonly cierraA: string | null;
  readonly proximaApertura: { readonly dia: string; readonly hora: string; readonly hoy: boolean } | null;
  readonly pedidoMinimoDomicilio: number | null;
  readonly pedidoMinimoRecoger: number | null;
  readonly propinaPolitica: "nunca" | "siempre" | "solo_tarjeta" | null;
  readonly zonasReparto: readonly string[];
}

export interface ProductoMenu {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly price: number;
  readonly imageUrl: string | null;
  readonly isPopular: boolean;
  readonly available: boolean;
  readonly packSize: number | null;
  readonly requiresAdultConfirmation: boolean;
  readonly requiresTortilla: boolean;
  readonly noDomicilio: boolean;
}

export interface CategoriaMenu {
  readonly id: string | null;
  readonly name: string;
  readonly items: readonly ProductoMenu[];
}

export interface CotizacionRenglon {
  readonly product_id: string;
  readonly name: string;
  readonly price: number;
  readonly quantity: number;
  readonly tortilla: Tortilla | null;
  readonly line_total: number;
}

export interface Cotizacion {
  readonly quote: {
    readonly lines: readonly CotizacionRenglon[];
    readonly total: number;
    readonly contains_alcohol: boolean;
    readonly pedido_minimo?: number;
    readonly preguntar_propina?: boolean;
    readonly abierto_ahora?: boolean;
  };
  readonly quote_hash: string | null;
  readonly promo: { readonly valida: boolean; readonly codigo: string; readonly descuento: number; readonly totalConDescuento: number; readonly mensaje: string | null } | null;
}

export interface PedidoCreado {
  readonly rastreo_token: string;
  readonly ya_registrado?: boolean;
  readonly estado?: string;
  readonly total?: number;
  readonly canal?: Canal;
  readonly sucursal?: string | null;
  readonly comanda?: { readonly estado: string; readonly folio: string | null; readonly mensaje: string } | null;
}

export type EstadoPedido = "pending" | "preparando" | "en_camino" | "entregado" | "cancelado" | "completado" | "problema";

export interface RastreoPedido {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly pedido?: {
    readonly status: EstadoPedido;
    readonly branch: string | null;
    readonly total: number;
    readonly paymentMethod: MetodoPago | null;
    readonly canal: Canal;
    readonly createdAt: string;
    readonly items: ReadonlyArray<{ readonly name: string; readonly quantity: number; readonly tortilla: Tortilla | null }>;
  };
}

export class StorefrontError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Motivo de la maquina de estados del servidor (p. ej. "cotizacion_vencida"), si lo hubo. */
    readonly motivo?: string,
  ) {
    super(message);
    this.name = "StorefrontError";
  }
}

export interface DatosPedido {
  readonly sessionId: string;
  readonly items: ReadonlyArray<{ readonly product_id: string; readonly requested_quantity: number; readonly tortilla?: Tortilla }>;
  readonly canal: Canal;
  readonly coloniaEntrega?: string;
  readonly metodoPago?: MetodoPago;
  readonly mayorDeEdad?: boolean;
  readonly codigoPromo?: string;
}

export interface DatosCliente {
  readonly nombre: string;
  readonly telefono: string;
  readonly correo?: string;
  readonly direccion?: string;
  readonly notas?: string;
  readonly propina?: number;
}

function enc(v: string): string {
  return encodeURIComponent(v);
}

async function leer<T>(res: Response, fallback: string): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let message = fallback;
  let motivo: string | undefined;
  try {
    const body = (await res.json()) as { message?: unknown; motivo?: unknown };
    if (typeof body.message === "string" && body.message) message = body.message;
    if (typeof body.motivo === "string") motivo = body.motivo;
  } catch {
    // cuerpo no JSON: se conserva el mensaje generico
  }
  if (res.status === 429) message = "Demasiados intentos seguidos. Espera un minuto e inténtalo de nuevo.";
  throw new StorefrontError(message, res.status, motivo);
}

export function crearClienteStorefront(apiBaseUrl: string, orgSlug: string, fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  const raiz = `${apiBaseUrl.replace(/\/+$/, "")}/v1/restaurantes/${enc(orgSlug)}/storefront`;
  const post = (path: string, body: unknown) => fetchImpl(`${raiz}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const cuerpo = (d: DatosPedido) => ({
    session_id: d.sessionId,
    items: d.items,
    canal: d.canal,
    colonia_entrega: d.coloniaEntrega || undefined,
    payment_method: d.metodoPago,
    adult_confirmed: d.mayorDeEdad === true ? true : undefined,
    promo_code: d.canal === "recoger" && d.codigoPromo?.trim() ? d.codigoPromo.trim() : undefined,
  });
  return {
    async sucursales(): Promise<{ restaurante: { slug: string; nombre: string }; sucursales: SucursalPublica[] }> {
      return leer(await fetchImpl(raiz), "No pudimos cargar el restaurante.");
    },
    async menu(branchSlug: string): Promise<{ sucursal: SucursalPublica | null; categorias: CategoriaMenu[] }> {
      return leer(await fetchImpl(`${raiz}/${enc(branchSlug)}/menu`), "No pudimos cargar el menú.");
    },
    async cotizar(branchSlug: string, datos: DatosPedido): Promise<Cotizacion> {
      return leer(await post(`/${enc(branchSlug)}/quote`, cuerpo(datos)), "No pudimos cotizar tu pedido.");
    },
    async confirmar(branchSlug: string, sessionId: string, quoteHash: string | null): Promise<{ confirmado: boolean }> {
      return leer(await post(`/${enc(branchSlug)}/confirm`, { session_id: sessionId, quote_hash: quoteHash ?? undefined }), "No pudimos confirmar tu pedido.");
    },
    async crearPedido(branchSlug: string, datos: DatosPedido, cliente: DatosCliente, quoteHash: string | null): Promise<PedidoCreado> {
      return leer(
        await post(`/${enc(branchSlug)}/orders`, {
          ...cuerpo(datos),
          quote_hash: quoteHash ?? undefined,
          customer_name: cliente.nombre,
          customer_phone: cliente.telefono,
          customer_email: cliente.correo?.trim() || undefined,
          customer_address: datos.canal === "domicilio" ? cliente.direccion : undefined,
          notes: cliente.notas?.trim() || undefined,
          propina: cliente.propina !== undefined && cliente.propina > 0 ? cliente.propina : undefined,
        }),
        "No pudimos registrar tu pedido.",
      );
    },
    async rastreo(token: string): Promise<RastreoPedido> {
      return leer(await fetchImpl(`${raiz}/track/${enc(token)}`), "No encontramos ese pedido.");
    },
  };
}

export type ClienteStorefront = ReturnType<typeof crearClienteStorefront>;
