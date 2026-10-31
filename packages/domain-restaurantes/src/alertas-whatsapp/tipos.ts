// Alertas de WhatsApp al gerente/encargado por sucursal (PM PR-3). Tipos y puertos; la decision es pura (`decision.ts`) y el barrido vive en `servicio.ts`.
export type TipoAlerta = "escalada" | "sin_respuesta";

export interface DestinatarioAlerta {
  /** Telefono tal como lo capturo el dueno; se normaliza con `toWhatsAppRecipient` al decidir. */
  readonly telefono: string;
  readonly nombre?: string;
  readonly rol?: string;
}

export interface VentanaHorario {
  /** 0 = domingo ... 6 = sabado (zona de la sucursal). */
  readonly dias: readonly number[];
  /** "HH:MM". Si `desde` > `hasta` la ventana cruza la medianoche y pertenece al dia en que empieza. */
  readonly desde: string;
  readonly hasta: string;
}

/** Datos que el DUENO debe aportar por sucursal (ver migracion 103). */
export interface AlertaSucursalConfig {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly sucursalNombre: string;
  readonly activa: boolean;
  /** phone_number_id (Meta) del numero que ENVIA los avisos. */
  readonly phoneNumberIdAviso: string | null;
  readonly plantillaNombre: string | null;
  readonly plantillaIdioma: string;
  readonly plantillaAprobada: boolean;
  readonly zonaHoraria: string;
  /** `null` = a cualquier hora. */
  readonly horario: readonly VentanaHorario[] | null;
  readonly minutosSinRespuesta: number;
  readonly destinatarios: readonly DestinatarioAlerta[];
}

export interface AlertaCandidata {
  readonly tipo: TipoAlerta;
  /** Clave de dedupe de la alerta (prefijo `h:` = toma pendiente, `c:` = conversacion con el ultimo mensaje del cliente). */
  readonly clave: string;
  readonly entidadId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly desde: Date;
  readonly minutos: number;
}

export type MotivoDegradacion = "alertas_apagadas" | "sin_destinatarios" | "destinatarios_invalidos" | "sin_numero_aviso" | "sin_plantilla" | "plantilla_no_aprobada" | "fuera_de_horario";

export type DecisionAlerta =
  | { readonly accion: "enviar"; readonly destinatarios: readonly string[] }
  | { readonly accion: "panel"; readonly motivo: MotivoDegradacion };

export type EstadoRegistro = "encolada" | "degradada_panel" | "omitida";

export interface RegistroAlerta {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly tipo: TipoAlerta;
  readonly clave: string;
  /** Hash del telefono destino; "" = decision sobre la alerta completa. */
  readonly destinoHash: string;
  readonly estado: EstadoRegistro;
  readonly motivo: string | null;
}

export interface Lectura<T> {
  readonly disponible: boolean;
  readonly valor: T;
}

export interface AlertasRepositorio {
  candidatas(ahora: Date, limite: number): Promise<Lectura<readonly AlertaCandidata[]>>;
  leerConfig(organizationId: string, propertyId: string): Promise<AlertaSucursalConfig | null>;
  /** `true` = registro nuevo; `false` = ya existia (dedupe). */
  registrar(r: RegistroAlerta): Promise<boolean>;
}

/** Cola de salida hacia WhatsApp (en produccion: `messaging_outbox`, idempotente por `dedupeKey`). NUNCA envia directo. */
export interface AlertasOutboxPort {
  encolar(organizationId: string, dedupeKey: string, payload: Readonly<Record<string, unknown>>): Promise<void>;
}

/** Avisos en el panel (campana): el piso al que se degrada todo. */
export interface AlertasPanelPort {
  degradada(c: AlertaCandidata, motivo: MotivoDegradacion): Promise<void>;
  sinRespuesta(c: AlertaCandidata): Promise<void>;
}
