// Puerto de persistencia de la lista de espera (H-12). Las transiciones validas (activa -> ofrecida | cancelada;
// ofrecida -> aceptada | expirada | cancelada) las impone el trigger de `hoteles.waitlist_entry` (migracion 041); aqui solo se
// piden. Las lecturas degradan contra la base sin migrar; las escrituras lanzan `ListaEsperaUnavailableError` (503).
import type { EntradaListaEspera, EstadoListaEspera, ListadoListaEspera, NuevaEntradaListaEspera } from "./tipos.ts";

export interface ListaEsperaRepository {
  listar(propertyId: string, estado: EstadoListaEspera | null): Promise<ListadoListaEspera>;
  buscar(propertyId: string, id: string): Promise<EntradaListaEspera | null>;
  crear(input: NuevaEntradaListaEspera): Promise<EntradaListaEspera>;
  /** activa | ofrecida -> cancelada. */
  cancelar(propertyId: string, id: string): Promise<EntradaListaEspera>;
  /** activa -> ofrecida con vencimiento `venceEn`. */
  ofrecer(propertyId: string, id: string, venceEn: Date): Promise<EntradaListaEspera>;
  /** ofrecida -> aceptada con la reserva creada. */
  marcarAceptada(propertyId: string, id: string, reservationId: string): Promise<EntradaListaEspera>;
  /** ofrecida con vencimiento ya pasado -> expirada. Devuelve cuantas. Degrada a 0 contra la base sin migrar. */
  expirarVencidas(propertyId: string, ahora: Date): Promise<number>;
  /** Entradas `activa` del tipo cuyo rango [entrada, salida) se traslapa con [desde, hasta), en orden de llegada (FIFO).
   *  Degrada a [] contra la base sin migrar. */
  listarActivasCompatibles(propertyId: string, roomTypeId: string, desde: string, hasta: string): Promise<readonly EntradaListaEspera[]>;
}
