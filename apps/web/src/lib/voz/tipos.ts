// Tipos de la vista previa de llamada COMPARTIDOS por las verticales con agente de voz (restaurantes, hoteles...): la sesion que emite la API del
// panel de cada vertical. Los tokens son efimeros y de un solo uso, nunca una API key de la plataforma.

/** Sesión de vista previa emitida por la API: tokens efímeros y de un solo uso, nunca una API key. */
export interface SesionPreviewVoz {
  readonly sesionId: string;
  readonly proveedor: string;
  readonly modelo: string;
  readonly voiceId: string;
  readonly websocketUrl: string;
  readonly tokenProveedor: string;
  readonly tokenPreview: string;
  readonly expiraEn: string;
}
