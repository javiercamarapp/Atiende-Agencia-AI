import type { CanalMensajeriaCodigo } from "./tipos.ts";

/**
 * Contrato de canal de mensajería — port ACOTADO de rentas/packages/domain/src/
 * mensajeria/canalMensajeria.ts. El origen extendía un `ChannelAdapter` genérico
 * (packages/domain/src/channelAdapter.ts) compartido con disponibilidad/tarifas; ese
 * concepto genérico nunca se portó a domain-rentas (la sincronización de
 * disponibilidad de este monorepo es iCal-only, ver ../sync/*, sin ningún adaptador
 * de canal API con estado de conexión) — así que `EstadoConexionCanal`/
 * `MessagingChannelCapabilities` se declaran aquí, acotados a mensajería, en vez de
 * arrastrar un archivo entero de conceptos (push de disponibilidad/tarifas) que este
 * paquete no usa. Mismo principio del origen (estado honesto: nunca reportar
 * "produccion" sin evidencia verificable) se preserva íntegro.
 */
export type EstadoConexionCanalMensajeria = "no_conectado" | "simulador" | "partner_pendiente" | "sandbox" | "produccion";

export interface MessagingChannelCapabilities {
  /** Soporta recibir mensajes entrantes del huésped por push/pull del canal. */
  recepcionMensajes: boolean;
  /** Soporta enviar mensajes salientes aprobados por un humano. */
  envioMensajes: boolean;
}

export interface ResultadoEnvioMensaje {
  readonly enviadoEn: string;
  readonly idExternoMensaje: string | null;
}

export interface EntradaEnviarMensajeAprobado {
  readonly borradorId: string;
  readonly texto: string;
  /** Usuario humano que aprobó este borrador — nunca `null`/`undefined`: el llamador
   * (apps/api) solo puede construir este objeto después de
   * `colaAprobacion.marcarEnviadoTrasAprobacion`. */
  readonly aprobadoPor: string;
  /** Identificadores del canal real (ej. `property_id`/`conversation_id` de
   * Booking.com) — `undefined` para `SimuladorCanalMensajeria` (no los necesita). Un
   * adaptador real que los requiera lanza un error tipado si faltan, en vez de
   * adivinar o construir una URL inválida en silencio. */
  readonly idExternoPropiedad?: string;
  readonly idExternoConversacion?: string;
}

export interface CanalMensajeria {
  readonly nombreCanal: CanalMensajeriaCodigo;
  readonly capacidades: MessagingChannelCapabilities;
  obtenerEstadoConexion(): EstadoConexionCanalMensajeria | Promise<EstadoConexionCanalMensajeria>;
  enviarMensajeAprobado(entrada: EntradaEnviarMensajeAprobado): Promise<ResultadoEnvioMensaje>;
}

/**
 * Adaptador simulado — hoy el ÚNICO adaptador real de este paquete: ningún canal
 * (Airbnb/Vrbo/Booking) está conectado todavía (packages/domain-rentas no declara
 * ningún cliente HTTP de mensajería de canal). `obtenerEstadoConexion` SIEMPRE
 * reporta `"simulador"`, nunca `"produccion"` — un simulador nunca puede disfrazarse
 * de canal real (mismo principio que ../sync/calendar-sync-port.ts::FakeIcalFeedPort
 * frente a RealIcalFeedPort, aplicado aquí a mensajería).
 *
 * `enviarMensajeAprobado` no hace ninguna llamada de red — solo registra el envío
 * como si el canal lo hubiera confirmado al instante, para que la ruta HTTP
 * (mensajeria-borradores.ts) pueda completar la transición `aprobado -> enviado` de
 * punta a punta en desarrollo/pruebas sin depender de credenciales de ningún canal.
 */
export class SimuladorCanalMensajeria implements CanalMensajeria {
  readonly capacidades: MessagingChannelCapabilities = { recepcionMensajes: true, envioMensajes: true };

  constructor(readonly nombreCanal: CanalMensajeriaCodigo) {}

  obtenerEstadoConexion(): EstadoConexionCanalMensajeria {
    return "simulador";
  }

  async enviarMensajeAprobado(entrada: EntradaEnviarMensajeAprobado): Promise<ResultadoEnvioMensaje> {
    if (!entrada.aprobadoPor) {
      // Defensa adicional en tiempo de ejecución — el tipo ya hace `aprobadoPor`
      // obligatorio, pero un caller en JS puro (o un cast) podría saltárselo.
      throw new Error("SimuladorCanalMensajeria.enviarMensajeAprobado: aprobadoPor es obligatorio");
    }
    return { enviadoEn: new Date().toISOString(), idExternoMensaje: null };
  }
}
