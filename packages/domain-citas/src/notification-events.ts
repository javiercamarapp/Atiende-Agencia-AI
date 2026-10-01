// Eventos de notificacion in-app de citas (REGLA DE NOTIFICACIONES, 1-oct). El productor compartido que escribe en
// `core.notification` todavia no existe en main (PL-34 / UNI-NOTIF): hasta entonces el dominio solo DESCRIBE el evento
// (tipo, severidad, categoria, enlace a la pantalla origen, clave de dedupe, sin PII) y lo devuelve en el resumen de la
// corrida; quien conecte el productor lo escribe tal cual. Nada aqui inventa una tabla ni un canal propio.

export type SeveridadNotificacion = "info" | "atencion" | "critica";

/** Por que un recordatorio de 24 h no se pudo enviar. Ninguno lleva datos del cliente. */
export type MotivoRecordatorioFallido =
  /** Un error real (de base de datos o del envio) aislo la cita; el cron la reintenta en la siguiente corrida. */
  | "error_interno"
  /** El recordatorio esta activo pero la cita no tiene ningun canal: sin WhatsApp conectado o sin telefono, y sin correo. */
  | "sin_canal";

export interface EventoRecordatorioFallido {
  readonly tipo: "citas.recordatorio_fallido";
  readonly severidad: SeveridadNotificacion;
  readonly categoria: "recordatorios";
  /** Pantalla origen dentro del panel de citas (ruta relativa a `/citas/:orgSlug/`). */
  readonly enlace: "agenda";
  /** Una notificacion por cita y motivo: las corridas repetidas del cron no la duplican. */
  readonly dedupeKey: string;
  readonly organizationId: string;
  readonly appointmentId: string;
  readonly motivo: MotivoRecordatorioFallido;
}

export function eventoRecordatorioFallido(organizationId: string, appointmentId: string, motivo: MotivoRecordatorioFallido): EventoRecordatorioFallido {
  return {
    tipo: "citas.recordatorio_fallido",
    severidad: motivo === "error_interno" ? "atencion" : "info",
    categoria: "recordatorios",
    enlace: "agenda",
    dedupeKey: `citas.recordatorio_fallido:${appointmentId}:${motivo}`,
    organizationId,
    appointmentId,
    motivo,
  };
}
