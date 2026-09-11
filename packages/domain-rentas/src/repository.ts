// Puerto de acceso a datos de domain-rentas — mismo patrón dual de adaptador que
// domain-hoteles/domain-restaurantes: un puerto TS explícito, con un adaptador real en
// memoria (tests determinísticos) y un adaptador real de Postgres (sobre
// TenantDbSession, contra las migraciones de migrations/001-003). Ninguna función de
// negocio de las rutas de apps/api toca SQL directamente para estas operaciones —
// solo pasan por aquí.
//
// Deliberadamente acotado a los 3 flujos elegidos (ver diseño Fase 1 §3): la
// transacción principal de crear/modificar/cancelar una reserva NO se envuelve aquí —
// igual que domain-hoteles no envuelve folioEngine en su repository, aquí tampoco se
// envuelve aplicacion/reservas.ts. La ruta le pasa el `TenantDbSession` directo (que ya
// satisface `EjecutorTransaccional` por structural typing) a
// crearReservaConfirmada/modificarFechasReserva/cancelarOcupacion; este repository solo
// cubre las lecturas/escrituras auxiliares (resolver unidad/canal, adjuntar huésped
// mínimo, pricing de solo lectura, y el movimiento financiero por reserva).
import type {
  CanalRecord,
  ConfiguracionComisionCanal,
  ContextoPricingUnidad,
  MovimientoFinancieroReserva,
  NewGuestMinimoInput,
  NewReservaFinancieroInput,
  OcupacionParaMovimiento,
  OcupacionResumen,
  ReglaCanal,
  UnidadRecord,
} from "./types.ts";

export interface RentasRepository {
  // ---- Calendario / anti-doble-reserva (flujo 1) ----
  findUnidad(propertyId: string, unidadId: string): Promise<UnidadRecord | null>;
  findCanalPorCodigo(codigo: string): Promise<CanalRecord | null>;
  /** Resumen mínimo de una ocupación, usado por la ruta ANTES de invocar
   *  modificarFechasReserva/cancelarOcupacion — defensa en profundidad, nunca confía
   *  en que el cliente "sabe" que una reserva es directa (mismo criterio que
   *  `exigirReservaDirecta` del origen). */
  findOcupacion(propertyId: string, unidadId: string, ocupacionId: string): Promise<OcupacionResumen | null>;
  insertGuestMinimo(input: NewGuestMinimoInput): Promise<{ id: string }>;
  attachGuestToOcupacion(ocupacionId: string, guestMinimoId: string): Promise<void>;

  // ---- Pricing / cotización (flujo 2) — SOLO lectura, ninguna escritura de precio ----
  loadPricingContext(propertyId: string, unidadId: string): Promise<ContextoPricingUnidad | null>;
  loadReglaCanalPricing(unidadId: string, canalCodigo: string): Promise<ReglaCanal | null>;

  // ---- Finanzas / movimiento por reserva (flujo 3) ----
  findOcupacionParaMovimiento(propertyId: string, ocupacionId: string): Promise<OcupacionParaMovimiento | null>;
  /** Resuelve la regla vigente: busca primero una específica de `propertyId`, cae a
   *  la regla global del tenant (`property_id IS NULL`) si no hay una específica —
   *  mismo orden de búsqueda que `buscarReglaComisionCanal` del origen. Lanza si no
   *  hay ninguna regla configurada (fail-closed: nunca asume una comisión de 0%). */
  findReglaComisionCanal(propertyId: string, canalId: string | null): Promise<ConfiguracionComisionCanal>;
  insertReservaFinanciero(input: NewReservaFinancieroInput): Promise<{ id: string; createdAt: string }>;
  findReservaFinanciero(propertyId: string, ocupacionId: string): Promise<MovimientoFinancieroReserva | null>;
}

export type {
  CanalRecord,
  ConfiguracionComisionCanal,
  ContextoPricingUnidad,
  MovimientoFinancieroReserva,
  NewGuestMinimoInput,
  NewReservaFinancieroInput,
  OcupacionParaMovimiento,
  OcupacionResumen,
  ReglaCanal,
  UnidadRecord,
} from "./types.ts";
