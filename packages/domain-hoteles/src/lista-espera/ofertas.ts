// H-12 -- oferta automatica de la lista de espera. Cuando una reserva se cancela o se acorta quedan noches libres: se buscan las
// entradas `activa` compatibles en orden de llegada (FIFO) y se marcan `ofrecida` con vencimiento. Una oferta NO retiene
// inventario (el huesped puede tardar): al aceptar, `book_availability` vuelve a validar el cupo. Para no ofrecer el mismo lugar
// a dos personas a la vez, las ofertas de una misma pasada descuentan localmente las noches que ya prometieron.
import { canBook } from "../overbooking.ts";
import { nightsBetween } from "../quote.ts";
import type { CambioFechasRepository } from "../fechas/repository.ts";
import type { ListaEsperaRepository } from "./repository.ts";
import type { EntradaListaEspera } from "./tipos.ts";

export const HORAS_OFERTA_DEFAULT = 24;
export const HORAS_OFERTA_MAX = 168;

export interface OfrecerLugaresInput {
  readonly lista: ListaEsperaRepository;
  readonly disponibilidad: Pick<CambioFechasRepository, "cargarDisponibilidad">;
  readonly propertyId: string;
  readonly roomTypeId: string;
  /** Noches liberadas: [desde, hasta) en YYYY-MM-DD. */
  readonly desde: string;
  readonly hasta: string;
  readonly ahora: Date;
  readonly horasOferta?: number;
}

function ultimaNoche(salida: string): string {
  return new Date(new Date(`${salida}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
}

/** Marca como ofrecidas las entradas compatibles con las noches liberadas y devuelve las ofrecidas (en orden). */
export async function ofrecerLugaresLiberados(i: OfrecerLugaresInput): Promise<readonly EntradaListaEspera[]> {
  const candidatas = await i.lista.listarActivasCompatibles(i.propertyId, i.roomTypeId, i.desde, i.hasta);
  if (candidatas.length === 0) return [];
  const minimo = candidatas.map((c) => c.checkInDate).sort()[0] as string;
  const maximo = candidatas.map((c) => ultimaNoche(c.checkOutDate)).sort().reverse()[0] as string;
  const disp = await i.disponibilidad.cargarDisponibilidad(i.propertyId, i.roomTypeId, minimo, maximo);
  const reservadas = new Map(disp.noches.map((n) => [n.date, n.bookedRooms]));
  const total = new Map(disp.noches.map((n) => [n.date, n.totalRooms]));

  const horas = Math.min(Math.max(i.horasOferta ?? HORAS_OFERTA_DEFAULT, 1), HORAS_OFERTA_MAX);
  const venceEn = new Date(i.ahora.getTime() + horas * 3_600_000);
  const ofrecidas: EntradaListaEspera[] = [];
  for (const entrada of candidatas) {
    const noches = nightsBetween(entrada.checkInDate, entrada.checkOutDate);
    const cabe = noches.every((n) => total.has(n) && canBook(total.get(n) as number, reservadas.get(n) ?? 0, 1, disp.overbooking));
    if (!cabe) continue;
    ofrecidas.push(await i.lista.ofrecer(i.propertyId, entrada.id, venceEn));
    for (const n of noches) reservadas.set(n, (reservadas.get(n) ?? 0) + 1);
  }
  return ofrecidas;
}
