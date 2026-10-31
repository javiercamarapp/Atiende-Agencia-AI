// Analítica del dueño (F7) · tipos compartidos por el dominio, la API y el panel. Sin dependencias de Node (la web importa este subpath).
// Los montos van en CENTAVOS enteros; los tiempos en minutos (o segundos donde el nombre lo dice); los porcentajes, en 0..100 con un decimal.
// Nada de PII: ni nombres, ni teléfonos, ni direcciones, ni ids de cliente.

export interface SucursalAnalitica {
  readonly propertyId: string;
  readonly nombre: string;
}

export interface ParamsAnalitica {
  readonly organizationId: string;
  /** null = todas las que el actor puede ver (la base lo valida de nuevo). */
  readonly propertyIds: readonly string[] | null;
  readonly desde: string;
  readonly hasta: string;
}

export type Lectura<T> = { readonly disponible: true; readonly datos: T } | { readonly disponible: false };

// ---- Demanda (analitica_demanda) ---------------------------------------------------------------------------------------------------------
export interface CeldaMatriz {
  readonly propertyId: string;
  /** ISO: 1 = lunes … 7 = domingo (día de negocio). */
  readonly dow: number;
  readonly hora: number;
  readonly canal: string;
  readonly source: string;
  readonly pedidos: number;
  readonly netaCentavos: number;
}
export interface SemanaCruda { readonly propertyId: string; readonly semana: string; readonly dias: number; readonly pedidos: number; readonly netaCentavos: number }
export interface TicketCrudo { readonly propertyId: string; readonly canal: string; readonly pedidos: number; readonly netaCentavos: number; readonly medianaCentavos: number | null; readonly p90Centavos: number | null }
export interface PagoCrudo { readonly propertyId: string; readonly formaPago: string; readonly pedidos: number; readonly netaCentavos: number }
export interface PromesaCruda {
  readonly propertyId: string;
  readonly domicilios: number;
  readonly entregados: number;
  readonly conPromesa: number;
  readonly aTiempo: number;
  readonly sinPromesa: number;
  readonly sinCierre: number;
  readonly realMedianaMin: number | null;
  readonly prometidoMedianaMin: number | null;
  readonly desvioMedianaMin: number | null;
}
export interface TotalCrudo { readonly propertyId: string; readonly pedidos: number; readonly netaCentavos: number }
export interface DemandaCruda {
  readonly matriz: readonly CeldaMatriz[];
  readonly semanas: readonly SemanaCruda[];
  readonly ticket: readonly TicketCrudo[];
  readonly pago: readonly PagoCrudo[];
  readonly promesa: readonly PromesaCruda[];
  readonly totales: readonly TotalCrudo[];
  readonly diasConVenta: number;
}

// ---- Zonas (analitica_zonas) -------------------------------------------------------------------------------------------------------------
export const ETIQUETA_SIN_COLONIA = "sin colonia / recoge";
export const ETIQUETA_OTRAS = "(otras)";
export const K_ZONAS = 5;
export interface ZonaCruda {
  readonly propertyId: string;
  readonly colonia: string;
  readonly pedidos: number;
  readonly domicilios: number;
  readonly recogidas: number;
  readonly netaCentavos: number;
  readonly clientes: number;
  readonly entregados: number;
  readonly sinCierre: number;
  readonly medianaMin: number | null;
  readonly p90Min: number | null;
  readonly masDe60: number;
}

// ---- Productos y combos (analitica_productos) ---------------------------------------------------------------------------------------------
export interface ProductoCrudo {
  readonly propertyId: string;
  readonly productoRef: string;
  readonly nombre: string;
  readonly categoria: string;
  readonly unidades: number;
  readonly ingresoCentavos: number;
  readonly pedidos: number;
  readonly costoUnitarioCentavos: number | null;
  readonly margenCentavos: number | null;
}
export interface ParCrudo {
  readonly propertyId: string;
  readonly productoA: string;
  readonly productoB: string;
  readonly nombreA: string;
  readonly nombreB: string;
  readonly juntos: number;
  readonly pedidosA: number;
  readonly pedidosB: number;
  readonly pedidosTotal: number;
  readonly enMenu: boolean;
  readonly promocionCodigo: string | null;
}
export interface ProductosCrudo { readonly productos: readonly ProductoCrudo[]; readonly pares: readonly ParCrudo[]; readonly costosCargados: number }

// ---- Ratios (analitica_ratios) ------------------------------------------------------------------------------------------------------------
export interface VentanaRecompra { readonly elegibles: number; readonly recompraron: number }
export interface FilaRatiosCruda {
  /** null = el conjunto de las sucursales consultadas. */
  readonly propertyId: string | null;
  readonly pedidos: number;
  readonly netaCentavos: number;
  readonly ticketCentavos: number | null;
  readonly clientes: number;
  readonly pedidosConCliente: number;
  readonly clientesNuevos: number;
  readonly recompra: { readonly d14: VentanaRecompra; readonly d30: VentanaRecompra; readonly d60: VentanaRecompra };
  readonly cancelados: number;
  readonly grandes: number;
  readonly convChats: number;
  readonly convConPedido: number;
  readonly convEscaladas: number;
  readonly vozLlamadas: number;
  readonly vozConPedido: number;
  readonly vozEscaladas: number;
  readonly respN: number;
  readonly respMedianaSeg: number | null;
  readonly respP90Seg: number | null;
  readonly respHasta5min: number;
  readonly respAgenteN: number;
  readonly respHumanoN: number;
  readonly conversacionesAgente: number;
  readonly costoTotalCentavos: number | null;
  readonly costoPorConversacionCentavos: number | null;
}
export interface RatiosCrudo { readonly filas: readonly FilaRatiosCruda[]; readonly grandeCentavos: number }
