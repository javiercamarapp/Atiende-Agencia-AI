// Doble en memoria del repositorio de reportes: un contenedor sembrable (los tests de
// ruta siembran unidades/reservas; la SQL real se verifica contra Postgres en
// scripts/verify-rentas-reportes-acceso).
import { rangosSeSuperponen } from "../fechas.ts";
import type { RangoFechas } from "../tipos.ts";
import type { DatosReporte, FiltrosReporte, RentasReportesRepository } from "./repository.ts";
import type { ReservaParaReporte, UnidadParaReporte } from "./tipos.ts";

export class InMemoryRentasReportesRepository implements RentasReportesRepository {
  moneda = "MXN";
  zonaHoraria = "America/Merida";
  financieroDisponible = true;
  readonly unidades: UnidadParaReporte[] = [];
  readonly reservas: ReservaParaReporte[] = [];

  async cargarDatosReporte(_propertyId: string, periodo: RangoFechas, filtros: FiltrosReporte): Promise<DatosReporte> {
    const unidades = this.unidades.filter((u) => (!filtros.unidadId || u.id === filtros.unidadId) && (!filtros.ownerId || u.ownerId === filtros.ownerId));
    const ids = new Set(unidades.map((u) => u.id));
    const reservas = this.reservas
      .filter((r) => ids.has(r.unidadId) && (!filtros.canal || r.canal === filtros.canal) && rangosSeSuperponen({ inicio: r.inicio, fin: r.fin }, periodo))
      .map((r) => (this.financieroDisponible ? r : { ...r, financiero: null }));
    return { moneda: this.moneda, zonaHoraria: this.zonaHoraria, unidades, reservas, financieroDisponible: this.financieroDisponible };
  }
}
