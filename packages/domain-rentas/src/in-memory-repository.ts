// InMemoryRentasRepository — implementación real (no un mock) de `RentasRepository`,
// con las mismas restricciones de integridad que el DDL real de migrations/002-003
// (p. ej. `reserva_financiero.ocupacion_id UNIQUE`). Sirve para tests determinísticos
// y como fallback dev/CI sin Postgres real — mismo rol que
// `InMemoryHotelesRepository`/`InMemoryRestaurantesRepository`.
//
// Las lecturas/escrituras de calendario (findUnidad/findCanalPorCodigo/findOcupacion/
// insertGuestMinimo/attachGuestToOcupacion/findOcupacionParaMovimiento) delegan a un
// `InMemoryRentasCalendarStore` — el MISMO que usa `InMemoryRentasTenancyEngine` para
// resolver las queries crudas de `aplicacion/reservas.ts` cuando ambos se construyen
// compartiendo una instancia (ver apps/api/tests/rentas-fixtures.ts): en Postgres real
// ambos caminos leen/escriben la misma tabla `rentas.ocupacion`, así que la fixture de
// prueba reproduce esa misma propiedad en vez de mantener dos copias divergentes.
import { randomUUID } from "node:crypto";
import { InMemoryRentasCalendarStore } from "./calendar-store.ts";
import type { RentasRepository } from "./repository.ts";
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

interface StoredReglaComisionCanal {
  propertyId: string | null; // null = regla global del tenant
  canalId: string | null; // null = regla por defecto sin canal específico
  config: ConfiguracionComisionCanal;
}

interface StoredReservaFinanciero {
  id: string;
  organizationId: string;
  propertyId: string;
  ocupacionId: string;
  createdAt: string;
  movimiento: MovimientoFinancieroReserva;
}

export class InMemoryRentasRepository implements RentasRepository {
  private readonly pricingByUnidad = new Map<string, ContextoPricingUnidad>();
  private readonly reglasCanalPricing = new Map<string, ReglaCanal>(); // key: unidadId:canalCodigo
  private readonly reglasComisionCanal: StoredReglaComisionCanal[] = [];
  private readonly reservasFinancieroPorOcupacion = new Map<string, StoredReservaFinanciero>();

  constructor(private readonly calendarStore: InMemoryRentasCalendarStore = new InMemoryRentasCalendarStore()) {}

  // ---- seeding ----

  seedUnidad(unidad: UnidadRecord): void {
    this.calendarStore.seedUnidad(unidad);
  }

  seedPricingContext(unidadId: string, contexto: ContextoPricingUnidad): void {
    this.pricingByUnidad.set(unidadId, contexto);
  }

  seedReglaCanalPricing(unidadId: string, canalCodigo: string, regla: ReglaCanal): void {
    this.reglasCanalPricing.set(`${unidadId}:${canalCodigo}`, regla);
  }

  seedReglaComisionCanal(input: { propertyId: string | null; canalId: string | null; config: ConfiguracionComisionCanal }): void {
    this.reglasComisionCanal.push(input);
  }

  // ---- RentasRepository: calendario (delegado al store compartido) ----

  async findUnidad(propertyId: string, unidadId: string): Promise<UnidadRecord | null> {
    return this.calendarStore.findUnidad(propertyId, unidadId);
  }

  async findCanalPorCodigo(codigo: string): Promise<CanalRecord | null> {
    return this.calendarStore.findCanalPorCodigo(codigo);
  }

  async findOcupacion(propertyId: string, unidadId: string, ocupacionId: string): Promise<OcupacionResumen | null> {
    return this.calendarStore.findOcupacion(propertyId, unidadId, ocupacionId);
  }

  async insertGuestMinimo(input: NewGuestMinimoInput): Promise<{ id: string }> {
    return this.calendarStore.insertGuestMinimo(input);
  }

  async attachGuestToOcupacion(ocupacionId: string, guestMinimoId: string): Promise<void> {
    this.calendarStore.attachGuestToOcupacion(ocupacionId, guestMinimoId);
  }

  // ---- RentasRepository: pricing (solo lectura) ----

  async loadPricingContext(propertyId: string, unidadId: string): Promise<ContextoPricingUnidad | null> {
    const unidad = this.calendarStore.findUnidad(propertyId, unidadId);
    if (!unidad) return null;
    return this.pricingByUnidad.get(unidadId) ?? null;
  }

  async loadReglaCanalPricing(unidadId: string, canalCodigo: string): Promise<ReglaCanal | null> {
    return this.reglasCanalPricing.get(`${unidadId}:${canalCodigo}`) ?? null;
  }

  // ---- RentasRepository: finanzas ----

  async findOcupacionParaMovimiento(propertyId: string, ocupacionId: string): Promise<OcupacionParaMovimiento | null> {
    return this.calendarStore.findOcupacionParaMovimiento(propertyId, ocupacionId);
  }

  async findReglaComisionCanal(propertyId: string, canalId: string | null): Promise<ConfiguracionComisionCanal> {
    // Mismo orden de búsqueda que `buscarReglaComisionCanal` del origen: primero una
    // regla específica de esta property, luego la regla global del tenant
    // (property_id IS NULL) — fail-closed si no hay ninguna configurada.
    const especifica = this.reglasComisionCanal.find((r) => r.propertyId === propertyId && r.canalId === canalId);
    if (especifica) return especifica.config;
    const global = this.reglasComisionCanal.find((r) => r.propertyId === null && r.canalId === canalId);
    if (global) return global.config;
    throw new Error(`No hay rentas.regla_comision_canal configurada para canalId="${canalId}" (ni específica de la property ni global del tenant).`);
  }

  async insertReservaFinanciero(input: NewReservaFinancieroInput): Promise<{ id: string; createdAt: string }> {
    const existente = this.reservasFinancieroPorOcupacion.get(input.ocupacionId);
    if (existente) {
      throw new Error(`reserva_financiero_ocupacion_unidad_id_key: ya existe un movimiento financiero para la ocupación ${input.ocupacionId}.`);
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const movimiento: MovimientoFinancieroReserva = {
      ocupacionUnidadId: input.ocupacionId,
      moneda: input.moneda,
      ingresoBrutoCentavos: input.montoBrutoCentavos,
      montoRecibidoCentavos: input.montoRecibidoCentavos,
      comisionCanalCentavos: input.comisionCanalCentavos,
      comisionCanalFuente: input.comisionCanalFuente,
      comisionGestorCentavos: input.comisionGestorCentavos,
      gastosCentavos: input.gastosCentavos,
      impuestosCentavos: input.impuestosCentavos,
      netoCentavos: input.netoCentavos,
    };
    this.reservasFinancieroPorOcupacion.set(input.ocupacionId, { id, organizationId: input.organizationId, propertyId: input.propertyId, ocupacionId: input.ocupacionId, createdAt, movimiento });
    return { id, createdAt };
  }

  async findReservaFinanciero(propertyId: string, ocupacionId: string): Promise<MovimientoFinancieroReserva | null> {
    const fila = this.reservasFinancieroPorOcupacion.get(ocupacionId);
    if (!fila || fila.propertyId !== propertyId) return null;
    return fila.movimiento;
  }
}
