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
  /** wa.me de la sucursal con texto prellenado (R-38); null/ausente = sin numero valido: no se muestra el boton. */
  readonly whatsappUrl?: string | null;
  /** null = sin horario configurado: no se afirma abierto ni cerrado. */
  readonly abiertoAhora: boolean | null;
  readonly cierraA: string | null;
  readonly proximaApertura: { readonly dia: string; readonly hora: string; readonly hoy: boolean } | null;
  readonly pedidoMinimoDomicilio: number | null;
  readonly pedidoMinimoRecoger: number | null;
  readonly propinaPolitica: "nunca" | "siempre" | "solo_tarjeta" | null;
  readonly zonasReparto: readonly string[];
  /** false = la sucursal no reparte (solo recoger). Ausente en un servidor anterior: se asume que reparte. */
  readonly aceptaDomicilio?: boolean;
  /** "Domicilio vie-dom" cuando reparte solo algunos dias. */
  readonly domicilioTexto?: string | null;
}

/** Una sucursal del directorio publico (`/pedir/:org/sucursales`). */
export interface SucursalDirectorio {
  readonly slug: string;
  readonly name: string;
  readonly address: string | null;
  readonly phone: string | null;
  readonly horario: ReadonlyArray<{ readonly dias: readonly number[]; readonly abre: string; readonly cierra: string }> | null;
  readonly abiertoAhora: boolean | null;
  readonly pideEnLinea: boolean;
  readonly soloRecoger: boolean;
  readonly insigniaDomicilio: string | null;
  readonly deTemporada: boolean;
  readonly soloInformativa: boolean;
  readonly comoLlegarUrl: string | null;
}

/** Respuesta de `POST .../sucursal-sugerida`. */
export type SugerenciaSucursal =
  | { readonly tipo: "reparte"; readonly sucursal: { readonly slug: string; readonly name: string }; readonly zona: string; readonly distanciaKm: number; readonly mensaje: string }
  | { readonly tipo: "solo_recoger"; readonly sucursal: { readonly slug: string; readonly name: string }; readonly zona: string; readonly distanciaKm: number; readonly mensaje: string }
  | { readonly tipo: "cercana"; readonly sucursal: { readonly slug: string; readonly name: string }; readonly distanciaKm: number; readonly mensaje: string }
  | { readonly tipo: "sin_resultado"; readonly mensaje: string };

/** Seccion "Encargados y transferencias" del aviso de privacidad (BORRADOR pendiente de revision legal). */
export interface SeccionEncargados {
  readonly borrador: true;
  readonly revisionLegalPendiente: true;
  readonly aviso: string;
  readonly encargados: ReadonlyArray<{ readonly id: string; readonly proveedor: string; readonly finalidad: string; readonly pais: string }>;
}

/** Marca publica del restaurante (R-38). Todo opcional: sin marca guardada la portada es generica con el nombre. */
export interface MarcaPublica {
  readonly titular: string | null;
  readonly eslogan: string | null;
  readonly about: string | null;
  readonly portadaUrl: string | null;
  readonly logoUrl: string | null;
  readonly instagramUrl: string | null;
  readonly facebookUrl: string | null;
  readonly tiktokUrl: string | null;
}

/** Promocion que el motor aplica sola a un pedido para recoger (R-38). */
export interface PromocionPublica {
  readonly id: string;
  readonly nombre: string;
  readonly descripcion: string | null;
  readonly beneficio: string;
  readonly canal: "recoger";
  readonly pedidoMinimo: number | null;
  /** 0=domingo..6=sabado; null = todos los dias. */
  readonly dias: readonly number[] | null;
  readonly horaInicio: string | null;
  readonly horaFin: string | null;
  readonly vigenteHasta: string | null;
  /** Slugs de las sucursales donde vale; null = todas. */
  readonly sucursales: readonly string[] | null;
}

export interface RestaurantePublico {
  readonly restaurante: { readonly slug: string; readonly nombre: string };
  readonly sucursales: SucursalPublica[];
  /** Ausente en un servidor anterior a R-38. */
  readonly marca?: MarcaPublica;
  readonly promociones?: readonly PromocionPublica[];
}

/** Solicitud de evento/catering (R-43). `sitioWeb` es el honeypot: debe ir vacio (un campo oculto que una persona no ve). */
export interface DatosEvento {
  readonly nombre: string;
  readonly telefono: string;
  readonly fechaEvento: string;
  readonly personas: number;
  readonly sucursal: string;
  readonly comentario?: string;
  readonly aceptaAviso: boolean;
  readonly sitioWeb?: string;
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

export type EstadoPedido = "pending" | "preparando" | "en_camino" | "entregado" | "cancelado" | "completado" | "problema" | "listo_para_recoger" | "no_recogido" | "programado";

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
    /** Motivo de la maquina de estados del servidor (p. ej. "cotizacion_vencida"), o del cliente ("red", "tiempo_agotado",
     * "respuesta_invalida"), si lo hubo. */
    readonly motivo?: string,
    /** Rastreo del pedido que esta sesion YA tiene registrado (el servidor lo manda con `ya_registrado`). */
    readonly rastreoToken?: string,
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
  /** Casilla del aviso de privacidad: el servidor la exige y guarda la evidencia (version del aviso, fecha, canal `web`). */
  readonly aceptaAviso: boolean;
  /** Casilla OPCIONAL y desmarcada: promociones por WhatsApp (consentimiento de marketing). Solo `true` se envia. */
  readonly aceptaPromociones?: boolean;
}

function enc(v: string): string {
  return encodeURIComponent(v);
}

/** Tope de espera de cada peticion: sin el, un servidor colgado dejaba el dialogo de confirmacion girando para siempre. */
export const TIEMPO_MAXIMO_MS = 20_000;

export const MENSAJE_RED = "No pudimos conectar con el restaurante. Revisa tu internet e inténtalo de nuevo.";
export const MENSAJE_TIEMPO_AGOTADO = "La solicitud tardó demasiado. Revisa tu conexión y vuelve a pulsar «Revisar pedido»: si tu pedido ya se había registrado, te lo mostraremos sin duplicarlo.";
export const MENSAJE_RESPUESTA_INVALIDA = "Recibimos una respuesta inesperada del servidor. Inténtalo de nuevo en un momento.";

/** Una peticion con tope de tiempo. Un fallo de red (el navegador rechaza con TypeError "Failed to fetch") o un timeout
 * se traducen a un `StorefrontError` con mensaje en espanol: nunca se le muestra al cliente el texto crudo del navegador. */
async function pedir(fetchImpl: typeof fetch, url: string, init: RequestInit | undefined, tiempoMs: number): Promise<Response> {
  const control = new AbortController();
  let agotado = false;
  const reloj = setTimeout(() => {
    agotado = true;
    control.abort();
  }, tiempoMs);
  try {
    return await fetchImpl(url, { ...init, signal: control.signal });
  } catch {
    if (agotado) throw new StorefrontError(MENSAJE_TIEMPO_AGOTADO, 0, "tiempo_agotado");
    throw new StorefrontError(MENSAJE_RED, 0, "red");
  } finally {
    clearTimeout(reloj);
  }
}

async function leer<T>(res: Response, fallback: string): Promise<T> {
  if (res.ok) {
    try {
      return (await res.json()) as T;
    } catch {
      // 200 que no es JSON (pagina de un proxy/CDN o de mantenimiento): mensaje generico, no el SyntaxError del navegador.
      throw new StorefrontError(MENSAJE_RESPUESTA_INVALIDA, res.status, "respuesta_invalida");
    }
  }
  let message = fallback;
  let motivo: string | undefined;
  let rastreoToken: string | undefined;
  try {
    const body = (await res.json()) as { message?: unknown; motivo?: unknown; ya_registrado?: unknown; rastreo_token?: unknown };
    if (typeof body.message === "string" && body.message) message = body.message;
    if (typeof body.motivo === "string") motivo = body.motivo;
    if (body.ya_registrado === true && typeof body.rastreo_token === "string") rastreoToken = body.rastreo_token;
  } catch {
    // cuerpo no JSON: se conserva el mensaje generico
  }
  if (res.status === 429) message = "Demasiados intentos seguidos. Espera un minuto e inténtalo de nuevo.";
  throw new StorefrontError(message, res.status, motivo, rastreoToken);
}

export function crearClienteStorefront(apiBaseUrl: string, orgSlug: string, fetchImpl: typeof fetch = (...a) => fetch(...a), tiempoMaximoMs: number = TIEMPO_MAXIMO_MS) {
  const raiz = `${apiBaseUrl.replace(/\/+$/, "")}/v1/restaurantes/${enc(orgSlug)}/storefront`;
  const get = (path: string) => pedir(fetchImpl, `${raiz}${path}`, undefined, tiempoMaximoMs);
  const post = (path: string, body: unknown) => pedir(fetchImpl, `${raiz}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, tiempoMaximoMs);
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
    async sucursales(): Promise<RestaurantePublico> {
      return leer(await get(""), "No pudimos cargar el restaurante.");
    },
    async directorio(): Promise<{ restaurante: { slug: string; nombre: string }; sucursales: SucursalDirectorio[] }> {
      return leer(await get("/directorio"), "No pudimos cargar las sucursales.");
    },
    async zonas(): Promise<{ zonas: string[] }> {
      return leer(await get("/zonas"), "No pudimos cargar las colonias.");
    },
    /** Las coordenadas viajan en el cuerpo del POST (nunca en la URL) y el servidor no las guarda. */
    async sucursalSugerida(entrada: { colonia: string } | { lat: number; lng: number }): Promise<{ sugerencia: SugerenciaSucursal }> {
      return leer(await post("/sucursal-sugerida", entrada), "No pudimos sugerir una sucursal.");
    },
    async privacidad(): Promise<{ encargados: SeccionEncargados }> {
      return leer(await get("/privacidad"), "No pudimos cargar los encargados del aviso de privacidad.");
    },
    async menu(branchSlug: string): Promise<{ sucursal: SucursalPublica | null; categorias: CategoriaMenu[]; marca?: MarcaPublica }> {
      return leer(await get(`/${enc(branchSlug)}/menu`), "No pudimos cargar el menú.");
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
          acepta_aviso_privacidad: cliente.aceptaAviso === true,
          acepta_promociones: cliente.aceptaPromociones === true ? true : undefined,
        }),
        "No pudimos registrar tu pedido.",
      );
    },
    async enviarEvento(d: DatosEvento): Promise<{ recibido: boolean }> {
      return leer(
        await post("/eventos", {
          nombre: d.nombre,
          telefono: d.telefono,
          fechaEvento: d.fechaEvento,
          personas: d.personas,
          sucursal: d.sucursal,
          comentario: d.comentario?.trim() || undefined,
          aceptaAviso: d.aceptaAviso,
          sitio_web: d.sitioWeb ?? "",
        }),
        "No pudimos enviar tu solicitud.",
      );
    },
    async rastreo(token: string): Promise<RastreoPedido> {
      return leer(await get(`/track/${enc(token)}`), "No encontramos ese pedido.");
    },
  };
}

export type ClienteStorefront = ReturnType<typeof crearClienteStorefront>;
