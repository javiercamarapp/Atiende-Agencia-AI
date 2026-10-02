import type { ArcoDerecho, ArcoEstado, ArcoEstadoDestino, EntradaSolicitudArco, EventoArco, FiltroSolicitudesArco, PaginaSolicitudesArco, ResultadoCambioEstadoArco, ResultadoRegistroArco } from "./tipos.ts";

/** Puerto de las solicitudes ARCO de rentas. Separado del resto a proposito: tablas de la migracion 028, que pueden no existir aun. */
export interface RentasPrivacidadRepository {
  listar(organizationId: string, filtro: FiltroSolicitudesArco, pagina: { limit: number; offset: number }): Promise<PaginaSolicitudesArco>;
  /** `null` = base sin migrar. Lista vacia si la solicitud no existe o no es de la organizacion. */
  listarEventos(organizationId: string, solicitudId: string): Promise<readonly EventoArco[] | null>;
  registrar(organizationId: string, entrada: EntradaSolicitudArco): Promise<ResultadoRegistroArco>;
  cambiarEstado(organizationId: string, solicitudId: string, estado: ArcoEstadoDestino, nota: string | null): Promise<ResultadoCambioEstadoArco>;
}

export type { ArcoDerecho, ArcoEstado };
