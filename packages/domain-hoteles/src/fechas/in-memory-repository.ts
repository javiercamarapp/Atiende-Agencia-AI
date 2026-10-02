// Espejo en memoria de PostgresCambioFechasRepository (H-28) para tests de ruta, construido sobre `InMemoryHotelesRepository`
// (misma fuente de verdad de reservas, inventario y folios que el resto de las pruebas). NO emula RLS/GRANT/triggers (eso lo cubre
// scripts/verify-hoteles-fechas-lista-espera contra Postgres real); SI replica las reglas de negocio de
// `hoteles.change_reservation_dates` y la degradacion "base sin migrar" (`migrated: false` => 503).
import type { InMemoryHotelesRepository } from "../in-memory-repository.ts";
import { nightsBetween } from "../quote.ts";
import type { CambioFechasRepository } from "./repository.ts";
import {
  CambioFechasConflictError,
  CambioFechasInvalidInputError,
  CambioFechasNotFoundError,
  CambioFechasUnavailableError,
  type AplicarCambioFechasInput,
  type CambioFechasAplicado,
  type DisponibilidadTipo,
} from "./tipos.ts";

const ACTIVAS = new Set(["confirmada", "check_in", "en_estancia"]);

export class InMemoryCambioFechasRepository implements CambioFechasRepository {
  /** `false` simula una base SIN la migracion 041 (aplicarCambio lanza 503). */
  migrated: boolean;
  readonly bitacora: (CambioFechasAplicado & { motivo: string | null })[] = [];

  constructor(
    private readonly hoteles: InMemoryHotelesRepository,
    opts: { readonly migrated?: boolean } = {},
  ) {
    this.migrated = opts.migrated ?? true;
  }

  async cargarDisponibilidad(propertyId: string, roomTypeId: string, desde: string, hasta: string): Promise<DisponibilidadTipo> {
    return this.hoteles.readAvailability(propertyId, roomTypeId, desde, hasta);
  }

  async aplicarCambio(i: AplicarCambioFechasInput): Promise<CambioFechasAplicado> {
    if (!this.migrated) throw new CambioFechasUnavailableError("cambiar las fechas");
    const res = await this.hoteles.findReservation(i.propertyId, i.reservationId);
    if (!res) throw new CambioFechasNotFoundError("Reserva");
    if (res.checkInDate !== i.esperadaEntrada || res.checkOutDate !== i.esperadaSalida) {
      throw new CambioFechasConflictError("Las fechas de la reserva cambiaron mientras tanto: recarga y vuelve a intentar.", "reserva_modificada");
    }
    if (!ACTIVAS.has(res.status)) throw new CambioFechasConflictError(`La reserva esta en estado ${res.status}`, "reserva_no_modificable");
    if (i.nuevaSalida <= i.nuevaEntrada || i.nuevoTotalNeto < 0 || i.penalidad < 0) throw new CambioFechasInvalidInputError("Parametros invalidos.");
    if (i.nuevaEntrada === res.checkInDate && i.nuevaSalida === res.checkOutDate) throw new CambioFechasInvalidInputError("sin_cambio: las fechas son las mismas");
    const enCasa = res.status === "check_in" || res.status === "en_estancia";
    if (enCasa && i.nuevaEntrada !== res.checkInDate) throw new CambioFechasInvalidInputError("llegada_no_modificable: con el huesped en casa solo se cambia la salida");

    // Noches ya posteadas por el night-audit: no se tocan.
    const folios = await this.hoteles.listFoliosByReservation(i.propertyId, i.reservationId);
    for (const f of folios) {
      for (const c of await this.hoteles.listChargesForCfdi(f.id)) {
        if (c.concept === "hospedaje" && c.stayDate && c.reversesChargeId === null && (c.stayDate < i.nuevaEntrada || c.stayDate >= i.nuevaSalida)) {
          throw new CambioFechasConflictError("Hay noches ya cargadas al folio fuera de las fechas nuevas.", "noches_posteadas");
        }
      }
    }
    if (res.roomId) {
      const otras = await this.hoteles.listReservations(i.propertyId);
      if (otras.some((o) => o.id !== res.id && o.roomId === res.roomId && ACTIVAS.has(o.status) && o.checkInDate < i.nuevaSalida && o.checkOutDate > i.nuevaEntrada)) {
        throw new CambioFechasConflictError("La habitacion asignada tiene otra reserva en las fechas nuevas.", "habitacion_ocupada");
      }
    }

    const viejas = new Set(nightsBetween(res.checkInDate, res.checkOutDate));
    const nuevas = new Set(nightsBetween(i.nuevaEntrada, i.nuevaSalida));
    const aReservar = [...nuevas].filter((n) => !viejas.has(n)).sort();
    const aLiberar = [...viejas].filter((n) => !nuevas.has(n)).sort();
    const reservadas: string[] = [];
    try {
      for (const n of aReservar) {
        await this.hoteles.bookAvailability(i.propertyId, res.roomTypeId, n, 1);
        reservadas.push(n);
      }
    } catch (err) {
      for (const n of reservadas) await this.hoteles.releaseAvailability(i.propertyId, res.roomTypeId, n, 1);
      if (err instanceof Error && err.message.startsWith("sin_disponibilidad")) throw new CambioFechasConflictError(err.message, "sin_disponibilidad");
      throw err;
    }
    for (const n of aLiberar) await this.hoteles.releaseAvailability(i.propertyId, res.roomTypeId, n, 1);
    this.hoteles.updateReservationDates(i.propertyId, i.reservationId, i.nuevaEntrada, i.nuevaSalida, i.nuevoTotalNeto);
    const aplicado: CambioFechasAplicado = {
      reservationId: res.id,
      entradaAnterior: res.checkInDate,
      salidaAnterior: res.checkOutDate,
      entradaNueva: i.nuevaEntrada,
      salidaNueva: i.nuevaSalida,
      totalNeto: i.nuevoTotalNeto,
      nochesLiberadas: aLiberar.length,
      nochesReservadas: aReservar.length,
      penalidad: i.penalidad,
    };
    this.bitacora.push({ ...aplicado, motivo: i.motivo });
    return aplicado;
  }
}
