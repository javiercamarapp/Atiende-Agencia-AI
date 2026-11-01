// Tipos y puerto del repositorio del ciclo operativo del pedido (migraciones 170, 171 y 172). Todo dato "no disponible aun" (base sin migrar)
// se expresa con `disponible: false` en las lecturas y con `CicloNoDisponibleError` en las escrituras (la ruta responde 503 honesto, nunca un 500).
import type { ConfigRecordatorio, EncuestaCruda, MotivoOmision, MotivoRechazo, TiemposCrudos } from "./reglas.ts";

export interface LecturaCiclo<T> {
  readonly disponible: boolean;
  readonly valor: T;
}

export class CicloAccesoError extends Error {}
export class CicloValidacionError extends Error {}
export class CicloConflictoError extends Error {}
export class CicloNoEncontradoError extends Error {}
export class CicloNoDisponibleError extends Error {}

export interface ResultadoAceptar {
  readonly resultado: "aceptado" | "ya_aplicado";
  readonly aceptadoAt: string;
  readonly tiempoPrometidoMin: number;
}
export interface ResultadoRechazar {
  readonly resultado: "rechazado" | "ya_aplicado";
  readonly rechazadoAt: string;
  readonly motivo: MotivoRechazo;
}
export interface ResultadoEntregarStaff {
  readonly resultado: "entregado" | "ya_aplicado";
  readonly entregadoAt: string;
  readonly salioAt: string | null;
  readonly minutosDesdeAceptado: number | null;
  readonly tiempoPrometidoMin: number | null;
}

export interface ResultadoDespachar {
  readonly resultado: "despachado" | "ya_aplicado" | "reasignado";
  readonly salioAt: string | null;
  readonly repartidorId: string;
}

export interface ConfigEncuesta {
  readonly habilitada: boolean;
}

export interface CandidatoEncuesta {
  readonly orderId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly customerPhone: string;
  readonly deliveredAt: string;
  readonly zonaHoraria: string | null;
  readonly phoneHash: string;
  readonly ultimoEntranteAt: string | null;
  readonly ultimaEncuestaAt: string | null;
  readonly optOut: boolean;
  readonly consentimiento: boolean;
}

export type EstadoEsperadoEncuesta = "calificacion" | "comentario" | "ninguna";

export interface ResultadoResponderEncuesta {
  readonly resultado: "respondida" | "sin_encuesta";
  readonly encuestaId?: string;
  readonly orderId?: string;
  readonly propertyId?: string;
  readonly orderNumber?: number | null;
}
export interface ResultadoComentarEncuesta {
  readonly resultado: "comentada" | "sin_encuesta";
  readonly encuestaId?: string;
  readonly orderId?: string;
  readonly propertyId?: string;
  readonly calificacion?: number;
}

export interface CandidatoRecordatorio {
  readonly orderId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly orderNumber: number;
  readonly numeroRecordatorio: number;
  readonly maximo: number;
  readonly minutos: number;
}

export interface CicloPedidoRepository {
  // ---- 170: aceptar / rechazar / entregar ----
  aceptar(organizationId: string, orderId: string, minutos: number): Promise<ResultadoAceptar>;
  rechazar(organizationId: string, orderId: string, motivo: MotivoRechazo, nota: string | null): Promise<ResultadoRechazar>;
  /** Asigna el repartidor y marca la SALIDA con hora real en una sola operacion atomica (092: `despachar_pedido`). Lanza `CicloNoDisponibleError` si la 092 no esta aplicada. */
  despachar(organizationId: string, orderId: string, repartidorId: string, etaMin: number): Promise<ResultadoDespachar>;
  entregarStaff(organizationId: string, orderId: string, ocurrioEn: Date | null, cobrado: number | null): Promise<ResultadoEntregarStaff>;
  tiempos(organizationId: string, propertyId: string, desde: Date, hasta: Date): Promise<LecturaCiclo<TiemposCrudos | null>>;
  // ---- 171: encuesta ----
  leerConfigEncuesta(organizationId: string, propertyId: string): Promise<LecturaCiclo<ConfigEncuesta>>;
  guardarConfigEncuesta(organizationId: string, propertyId: string, config: ConfigEncuesta): Promise<void>;
  candidatasEncuesta(ahora: Date, limite: number): Promise<LecturaCiclo<readonly CandidatoEncuesta[]>>;
  /** `true` solo para quien reservo el renglon (una vez por pedido). */
  reservarEncuesta(organizationId: string, orderId: string, phoneHash: string, estado: "enviada" | "omitida", omitidoMotivo: MotivoOmision | null, canal: "texto" | "plantilla" | null): Promise<boolean>;
  estadoEsperadoEncuesta(organizationId: string, phoneHash: string, ahora: Date): Promise<LecturaCiclo<EstadoEsperadoEncuesta>>;
  responderEncuesta(organizationId: string, phoneHash: string, calificacion: number, ahora: Date): Promise<ResultadoResponderEncuesta>;
  comentarEncuesta(organizationId: string, phoneHash: string, comentario: string, ahora: Date): Promise<ResultadoComentarEncuesta>;
  registrarBajaEncuesta(organizationId: string, phoneHash: string): Promise<boolean>;
  metricasEncuesta(organizationId: string, propertyId: string, desde: Date, hasta: Date): Promise<LecturaCiclo<EncuestaCruda | null>>;
  // ---- 172: recordatorios ----
  leerConfigRecordatorio(organizationId: string, propertyId: string): Promise<LecturaCiclo<ConfigRecordatorio>>;
  guardarConfigRecordatorio(organizationId: string, propertyId: string, config: ConfigRecordatorio): Promise<void>;
  candidatosRecordatorio(ahora: Date): Promise<LecturaCiclo<readonly CandidatoRecordatorio[]>>;
}
