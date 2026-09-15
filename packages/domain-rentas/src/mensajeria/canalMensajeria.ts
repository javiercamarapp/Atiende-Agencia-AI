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
 * Adaptador simulado — SOLO para pruebas/desarrollo (ver `apps/api/tests/
 * rentas-fixtures.ts`, que lo inyecta como `deps.rentasCanalMensajeria`). Hallazgo de
 * auditoría (severidad CRÍTICA, "la mensajería de rentas es un simulador que nunca
 * toca un canal real"): antes de este cambio, `mensajeria-borradores.ts` instanciaba
 * ESTA clase directamente en la ruta `POST .../aprobar`, así que TODO mensaje
 * "enviado" en producción real también pasaba por aquí — ningún mensaje salía nunca
 * de verdad, y el estado quedaba en `enviado` como si sí hubiera salido. Ahora la ruta
 * recibe el canal vía `deps.rentasCanalMensajeria(canal)` (inyectado, nunca
 * construido inline) — en producción resuelve a `CanalMensajeriaPartnerPendiente`
 * (ver más abajo), NUNCA a este simulador.
 *
 * `obtenerEstadoConexion` SIEMPRE reporta `"simulador"`, nunca `"produccion"` — un
 * simulador nunca puede disfrazarse de canal real (mismo principio que
 * ../sync/calendar-sync-port.ts::FakeIcalFeedPort frente a RealIcalFeedPort, aplicado
 * aquí a mensajería).
 *
 * `enviarMensajeAprobado` no hace ninguna llamada de red — solo registra el envío
 * como si el canal lo hubiera confirmado al instante, para que la ruta HTTP
 * (mensajeria-borradores.ts) pueda completar la transición `aprobado -> enviado` de
 * punta a punta en pruebas sin depender de credenciales de ningún canal.
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

/** Lanzado por `CanalMensajeriaPartnerPendiente.enviarMensajeAprobado` — NUNCA por
 * `SimuladorCanalMensajeria`. `mensajeria-borradores.ts::traducirErrorMensajeria` lo
 * traduce a 503 `service_unavailable` (mismo criterio que
 * `GeneracionBorradorIAFallidaError`/`hotelesCfdiPort` — ver
 * `packages/mcp-servers/cfdi/src/adapters/finkok-adapter.ts::PortUnavailableError`):
 * lanzado ANTES de que la ruta escriba nada en `rentas.borrador_mensaje`/
 * `rentas.mensaje` (ver `mensajeria-borradores.ts::POST .../aprobar`), así que el
 * borrador se queda exactamente en el estado que tenía antes de este intento (típico:
 * `pendiente_aprobacion`) — NUNCA se marca `enviado` sin que el canal haya confirmado
 * nada de verdad. */
export class CanalMensajeriaNoConfiguradoError extends Error {
  constructor(
    readonly canal: CanalMensajeriaCodigo,
    message: string,
  ) {
    super(message);
    this.name = "CanalMensajeriaNoConfiguradoError";
  }
}

/** Variable de entorno que llevaría la credencial del partner de mensajería de cada
 * canal. A diferencia de WhatsApp Graph API (@atiende/whatsapp-gateway, que citas/
 * hoteles/restaurantes SÍ conectan real con un único `WHATSAPP_ACCESS_TOKEN` de
 * sistema), Airbnb/Vrbo/Booking.com exigen cada uno su propio acuerdo de partner API
 * dado de alta por canal (no una API key pública que cualquiera pueda generar) —
 * ninguno está configurado en este monorepo hoy. Nombradas aquí para que
 * `obtenerEstadoConexion`/el mensaje de error sean accionables (qué falta
 * exactamente), no solo "no configurado" a secas. */
const VARIABLE_ENTORNO_POR_CANAL: Readonly<Record<CanalMensajeriaCodigo, string>> = {
  airbnb: "AIRBNB_MESSAGING_API_TOKEN",
  vrbo: "VRBO_MESSAGING_API_TOKEN",
  booking: "BOOKING_MESSAGING_API_TOKEN",
};

function tieneCredencialPartner(canal: CanalMensajeriaCodigo): boolean {
  const variable = VARIABLE_ENTORNO_POR_CANAL[canal];
  return Boolean(process.env[variable]?.trim());
}

/**
 * Adaptador de PRODUCCIÓN real — esqueleto HONESTO, mismo criterio exacto que
 * `FinkokAdapter`/`SwSapienAdapter` (packages/mcp-servers/cfdi/src/adapters/*.ts):
 * sin la credencial del partner de este canal, `obtenerEstadoConexion()` reporta
 * `"partner_pendiente"` (nunca `"produccion"`) y `enviarMensajeAprobado` SIEMPRE
 * lanza `CanalMensajeriaNoConfiguradoError` — el mensaje NUNCA se marca enviado sin
 * que un canal real lo haya confirmado. Con la credencial presente, este adaptador
 * TAMPOCO fabrica un envío: ningún cliente HTTP real de la Messaging API de Airbnb/
 * Vrbo/Booking.com existe todavía en este monorepo (a diferencia de
 * `MetaGraphWhatsAppClient` para WhatsApp) — inventar una llamada a un endpoint no
 * verificado sería el mismo error que este cambio corrige, solo que disfrazado de
 * "real". Este archivo es el lugar donde conectar esa llamada HTTP el día que exista
 * una credencial real y la forma verificada del endpoint de alguno de los 3
 * partners.
 */
export class CanalMensajeriaPartnerPendiente implements CanalMensajeria {
  readonly capacidades: MessagingChannelCapabilities = { recepcionMensajes: true, envioMensajes: true };

  constructor(readonly nombreCanal: CanalMensajeriaCodigo) {}

  obtenerEstadoConexion(): EstadoConexionCanalMensajeria {
    return tieneCredencialPartner(this.nombreCanal) ? "sandbox" : "partner_pendiente";
  }

  async enviarMensajeAprobado(entrada: EntradaEnviarMensajeAprobado): Promise<ResultadoEnvioMensaje> {
    void entrada;
    if (!tieneCredencialPartner(this.nombreCanal)) {
      const variable = VARIABLE_ENTORNO_POR_CANAL[this.nombreCanal];
      throw new CanalMensajeriaNoConfiguradoError(
        this.nombreCanal,
        `El canal "${this.nombreCanal}" no tiene una integración de mensajería real conectada en este entorno ` +
          `(falta ${variable} — requiere un acuerdo de partner API con ${this.nombreCanal}, no solo una API key). ` +
          `El mensaje NO se envió; ningún estado se persiste hasta que el canal esté conectado de verdad.`,
      );
    }
    throw new CanalMensajeriaNoConfiguradoError(
      this.nombreCanal,
      `Se detectó una credencial para "${this.nombreCanal}", pero este monorepo todavía no tiene un cliente HTTP real ` +
        `de su Messaging API conectado (ver el comentario de cabecera de esta clase). El mensaje NO se envió.`,
    );
  }
}
