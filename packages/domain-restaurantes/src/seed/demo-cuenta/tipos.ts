// Cuenta DEMO ficticia de cadena (marca inventada, NO copiada de Los Taquitos de PM): tipos de la DEFINICION DE DATOS versionada.
// La definicion es puro dato tipado (sin red ni fs); `plan.ts` la valida y la convierte en un plan, `sql.ts` en un bloque plpgsql idempotente
// y `volumen.ts` genera el volumen ficticio con el motor real de pedidos. Nada de esto escribe en ninguna base por si solo.

/** Ids cortos de sucursal dentro de la definicion (llave de precios y de colonias). */
export type SucursalId = "MTY1" | "MTY2" | "GDL1" | "CDMX1" | "PUE1" | "TIJ1";

/** Alergenos de declaracion que el menu informa por platillo (para que el agente no invente). */
export type Alergeno = "gluten" | "lacteos" | "huevo" | "soya" | "frutos secos" | "cacahuate" | "sulfitos" | "mostaza" | "ajonjoli" | "pescado" | "mariscos" | "apio";

export interface TurnoDef {
  readonly dias: readonly number[];
  readonly abre: string;
  readonly cierra: string;
}

export interface MarcaDef {
  readonly nombre: string;
  readonly nombreCorto: string;
  readonly slogan: string;
  readonly dominio: string;
  /** Correos ficticios en el dominio reservado `.example`. */
  readonly correos: { readonly contacto: string; readonly pedidos: string; readonly facturas: string; readonly eventos: string; readonly privacidad: string };
  readonly telefonoOficina: string;
  /** Colores de marca (hex); el esquema todavia no los guarda: solo documentacion para la personalizacion futura. */
  readonly colores: { readonly primario: string; readonly secundario: string; readonly acento: string };
  readonly historia: string;
}

export interface OrganizacionDef {
  readonly slug: string;
  /** Nombre comercial de la organizacion (la carga como demo le agrega " (demo)"). */
  readonly nombre: string;
  readonly version: string;
}

export interface ColoniaDef {
  readonly nombre: string;
  /** Sucursal(es) que reparten a la colonia; la primera es la mas cercana. */
  readonly sucursales: readonly SucursalId[];
  /** Distancia ficticia en km a la sucursal mas cercana (<= radio de reparto de esa sucursal). */
  readonly km: number;
}

export interface SucursalDef {
  readonly id: SucursalId;
  readonly nombre: string;
  readonly slug: string;
  readonly ciudad: string;
  readonly estado: string;
  readonly zonaHoraria: string;
  readonly direccion: string;
  readonly telefono: string;
  /** Aproximadas al centro de la colonia (no de un negocio real). */
  readonly lat: number;
  readonly lng: number;
  readonly horario: readonly TurnoDef[];
  readonly horarioTexto: string;
  readonly pedidoMinimoDomicilio: number;
  readonly pedidoMinimoRecoger: number | null;
  readonly propina: "nunca" | "siempre" | "solo_tarjeta";
  readonly radioRepartoKm: number;
  readonly tiempoEntrega: string;
  /** Peso relativo del volumen de pedidos de la sucursal. */
  readonly pesoVolumen: number;
  /** Fraccion de pedidos para recoger en la sucursal. */
  readonly fraccionRecoger: number;
  readonly acepta_domicilio: boolean;
  /** Dias (0 domingo a 6 sabado) en que reparte; null = todos los que abre. */
  readonly diasDomicilio: readonly number[] | null;
  readonly nota?: string;
}

export interface ProductoDef {
  readonly nombre: string;
  readonly categoria: string;
  /** Precio base en pesos (lista de Monterrey); cada sucursal lo ajusta por su factor de ciudad salvo `precios`. */
  readonly precio: number;
  readonly descripcion: string;
  readonly ingredientes: readonly string[];
  readonly alergenos: readonly Alergeno[];
  readonly popular?: boolean;
  readonly esAlcohol?: boolean;
  /** Sucursales donde NO se vende. */
  readonly noSeVendeEn?: readonly SucursalId[];
  /** Sucursales donde esta AGOTADO hoy (existe en el catalogo pero no se puede pedir). */
  readonly agotadoEn?: readonly SucursalId[];
  /** Precio propio por sucursal (en vez del factor de ciudad). */
  readonly precios?: Readonly<Partial<Record<SucursalId, number>>>;
  /** Alias con los que la gente pide el producto (una palabra en minusculas). */
  readonly alias?: readonly string[];
  /** Fraccion de kilo de OTRO producto "— 1 kg": su precio es el del kilo de la misma sucursal por la fraccion. */
  readonly fraccionKg?: { readonly base: string; readonly gramos: number };
}

export interface ModificadorDef {
  readonly id: string;
  readonly nombre: string;
  readonly aplicaA: readonly string[];
  readonly tipo: "sin" | "extra" | "termino" | "tamano" | "tortilla";
  /** Opciones validas (p. ej. los terminos de la carne). */
  readonly opciones: readonly string[];
  readonly min: number;
  readonly max: number;
  readonly nota: string;
}

export interface PromocionDef {
  readonly codigo: string;
  readonly nombre: string;
  readonly tipo: "bogo" | "cortesia" | "percentage";
  readonly dias: readonly number[];
  readonly canales: readonly ("domicilio" | "recoger")[];
  readonly productos?: readonly string[];
  readonly cortesiaProductos?: readonly string[];
  readonly cortesiaCantidad?: number;
  readonly porcentaje?: number;
  readonly montoMinimo?: number;
  readonly sucursales?: readonly SucursalId[];
  readonly descripcion: string;
}

export interface ConocimientoDef {
  readonly titulo: string;
  readonly texto: string;
  readonly tipo: "politica" | "faq" | "aviso_temporal";
  readonly prioridad: number;
}

export interface AgenteDef {
  readonly nombre: string;
  readonly tono: "calido_cercano" | "formal_directo" | "profesional_neutro" | "divertido_desenfadado";
  readonly saludo: string;
  readonly salsas: string;
  readonly promociones: string;
  readonly tiempoEntrega: string;
  readonly umbralPedidoGrande: string;
  readonly esperaRafagasSegundos: number;
  readonly reglasDuras: readonly string[];
}

export interface PoliticasDef {
  readonly pago: readonly string[];
  readonly propina: string;
  readonly pedidoGrande: string;
  readonly tiemposPreparacion: string;
  readonly cobertura: string;
  readonly alcoholDomicilio: string;
  readonly privacidad: string;
  readonly facturacion: string;
}

export interface DemoCuentaDef {
  readonly organizacion: OrganizacionDef;
  readonly marca: MarcaDef;
  readonly sucursales: readonly SucursalDef[];
  readonly colonias: readonly ColoniaDef[];
  readonly categorias: readonly string[];
  readonly productos: readonly ProductoDef[];
  readonly modificadores: readonly ModificadorDef[];
  readonly promociones: readonly PromocionDef[];
  readonly politicas: PoliticasDef;
  readonly conocimiento: readonly ConocimientoDef[];
  readonly agente: AgenteDef;
  /** Factor de precio por sucursal sobre la lista base. */
  readonly factorPrecio: Readonly<Record<SucursalId, number>>;
}

/** Rango propio de telefonos ficticios de ESTA cuenta dentro del prefijo de volumen `0001` (ver `telefonos.ts`). */
export const DEMO_CUENTA_PREFIJO = "0001";
export const DEMO_CUENTA_SUBRANGO_INICIO = 500_000;
export const DEMO_CUENTA_SUBRANGO_FIN = 599_999;
