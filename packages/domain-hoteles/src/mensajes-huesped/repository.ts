// H-P3-03 -- puertos de datos de los mensajes al huesped. Dos puertos a proposito (mismo criterio que rentas): el de SISTEMA (cron y disparo
// post-commit, sesion con auth.uid() NULL, funciones sistema_* de la migracion 046) y el de STAFF (sesion del request con RLS real).
import type { PlantillaWhatsappAprobada, PlantillaWhatsappInput, PlantillaWhatsappRecord } from "./plantillas.ts";
import type {
  CandidatoMensajeHuesped,
  CanalMensaje,
  ConfigEventoHuesped,
  EntradaConfigEvento,
  EventoMensajeHuesped,
  FilaHistorialMensaje,
  MotivoNoEnviado,
  RefTipoMensaje,
  ResultadoMensajes,
} from "./tipos.ts";

export interface EmitirMensajeEntrada {
  readonly propertyId: string;
  readonly evento: EventoMensajeHuesped;
  readonly refTipo: RefTipoMensaje;
  readonly refId: string;
  /** Exactamente uno de `canal` o `motivo`. */
  readonly canal: CanalMensaje | null;
  readonly motivo: MotivoNoEnviado | null;
  readonly eventType: string | null;
  readonly dedupeKey: string | null;
  /** `null` solo para el correo de reserva.confirmada, que ya cubre el correo transaccional de la propia reserva (no se encola otro). */
  readonly payload: Readonly<Record<string, unknown>> | null;
}

export interface MensajesHuespedSistemaRepository {
  /** Lanza (SQLSTATE 42883/42P01/42703) contra una base sin la migracion 046. */
  listarCandidatos(ahora: Date, limite: number, opciones?: { readonly propertyId?: string; readonly refId?: string }): Promise<readonly CandidatoMensajeHuesped[]>;
  /** Plantilla APROBADA del evento en el catalogo de la organizacion; `null` = no hay; `undefined` = el catalogo (migracion 0050) aun no existe. */
  resolverPlantilla(organizationId: string, evento: EventoMensajeHuesped): Promise<PlantillaWhatsappAprobada | null | undefined>;
  /** Toma la marca de idempotencia y, si hay canal, encola. Devuelve el id de la marca o `null` si ya la tenia (otra corrida o instancia gano). */
  emitir(entrada: EmitirMensajeEntrada): Promise<string | null>;
  /** Slug publico de la organizacion de la propiedad (enlace del aviso de privacidad); `null` si no se puede saber. */
  slugAviso(propertyId: string): Promise<string | null>;
}

export interface MensajesHuespedStaffRepository {
  /** Los 8 eventos, con los valores por omision donde no hay fila. */
  listarConfig(propertyId: string): Promise<ResultadoMensajes<readonly ConfigEventoHuesped[]>>;
  /** Lanza `MensajesHuespedUnavailableError` contra una base sin migrar. */
  guardarConfig(propertyId: string, evento: EventoMensajeHuesped, entrada: EntradaConfigEvento): Promise<ConfigEventoHuesped>;
  historial(propertyId: string, limite: number): Promise<ResultadoMensajes<readonly FilaHistorialMensaje[]>>;
  /** Catalogo de plantillas HSM de la organizacion (vertical hoteles). Solo lo ve owner/admin (RLS de core.whatsapp_plantilla). */
  listarPlantillas(organizationId: string): Promise<ResultadoMensajes<readonly PlantillaWhatsappRecord[]>>;
  guardarPlantilla(organizationId: string, evento: EventoMensajeHuesped, valor: PlantillaWhatsappInput): Promise<"saved" | "forbidden" | "unavailable">;
  eliminarPlantilla(organizationId: string, evento: EventoMensajeHuesped): Promise<"deleted" | "not_found" | "forbidden" | "unavailable">;
}
