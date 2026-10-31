// Plantilla de restaurantes (Fase A): esquema de configuracion de UN restaurante. Es puro dato versionado (sin red ni fs): de aqui salen el
// prompt de WhatsApp, el comportamiento de voz y el seed. Los datos de clientes finales NUNCA entran aqui (solo datos del negocio).
import type { HorarioSucursal } from "../horarios.ts";

export const ESQUEMA_RESTAURANTE_VERSION = 1 as const;

export interface MarcaConfig {
  readonly nombre: string;
  /** Nombre del asistente; `null` = "el asistente virtual" (sin nombre propio). */
  readonly agente: string | null;
  /** Saludo propio fijo (R-10); `null` = segun la hora del dia. */
  readonly saludo: string | null;
  /** Tiempos de entrega y de recoger en texto corto (lo que el agente puede decir; nunca inventa otros). */
  readonly tiempoEntrega: string;
}

export interface NegocioConfig {
  /** "taquería", "pizzería", "café"... */
  readonly giro: string;
  /** Articulo en minuscula que lleva el giro en espanol. */
  readonly articuloGiro: "la" | "el";
  /** Ciudad con estado si aplica ("Mérida, Yucatán"). */
  readonly ciudad: string;
  /** Zona horaria IANA. */
  readonly zonaHoraria: string;
}

export interface SucursalConfig {
  readonly slug: string;
  readonly nombre: string;
  readonly direccion: string | null;
  readonly telefono: string | null;
  readonly activa: boolean;
  /** `false` = solo recoger. */
  readonly reparte: boolean;
  /** Mismo formato que `branch_policy.horario`; vacio = sin horario capturado (advertencia). */
  readonly horario: HorarioSucursal;
}

export interface ProductoConfig {
  readonly nombre: string;
  readonly categoria: string;
  readonly descripcion?: string | null;
  /** Precio entero en pesos, el de todas las sucursales salvo `precioPorSucursal`. */
  readonly precio: number;
  readonly precioPorSucursal?: Readonly<Record<string, number>>;
  readonly alias?: readonly string[];
  readonly esAlcohol?: boolean;
  readonly popular?: boolean;
}

export interface MenuConfig {
  readonly categorias: readonly string[];
  readonly productos: readonly ProductoConfig[];
}

export interface PromocionConfig {
  readonly codigo: string;
  readonly nombre: string;
  readonly tipo: "bogo" | "cortesia";
  /** 0 = domingo ... 6 = sabado. */
  readonly dias: readonly number[];
  readonly canales: readonly ("domicilio" | "recoger")[];
  readonly productos: readonly string[];
  readonly descripcion: string;
  /** Slugs de sucursal; vacio/ausente = todas. */
  readonly sucursales?: readonly string[];
}

export interface ConocimientoConfig {
  readonly titulo: string;
  readonly texto: string;
  readonly tipo: "politica" | "faq" | "aviso_temporal";
}

export interface PoliticasConfig {
  /** Minimo a domicilio en pesos enteros. */
  readonly pedidoMinimoDomicilio: number;
  /** Fase A solo soporta 0 ("sin costo de envio"): el prompt lo afirma y el agente nunca cobra envio. */
  readonly costoEnvio: 0;
  readonly propina: "nunca" | "preguntar";
  readonly transferencia: "no" | "si";
  /** Promos en una frase para el prompt; `null` = las de PM por omision (solo para la instancia PM). */
  readonly promosTexto: string | null;
  readonly salsasTexto: string | null;
  /** Umbral de pedido grande en texto corto; `null` = el de PM por omision. */
  readonly pedidoGrandeTexto: string | null;
  readonly urlFacturacion: string | null;
  /** Motivos de escalacion apagados (solo los desactivables). */
  readonly motivosDesactivados: readonly string[];
}

export interface RestauranteConfig {
  readonly schemaVersion: typeof ESQUEMA_RESTAURANTE_VERSION;
  readonly slug: string;
  readonly marca: MarcaConfig;
  readonly negocio: NegocioConfig;
  readonly sucursales: readonly SucursalConfig[];
  readonly menu: MenuConfig;
  readonly politicas: PoliticasConfig;
  readonly promociones: readonly PromocionConfig[];
  readonly conocimiento: readonly ConocimientoConfig[];
  readonly voz: { readonly habilitada: boolean };
}
