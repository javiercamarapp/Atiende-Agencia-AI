// Puerto de la bandeja de conversaciones (H-20). El actor viaja en cada llamada para el espejo en memoria (que no tiene
// `auth.uid()`); el adaptador Postgres lo ignora: la identidad y el rol los resuelve la base desde la sesion (migracion 043).
import type {
  ConversacionActor,
  ConversacionBandeja,
  ConversacionDetalle,
  ConversacionModo,
  ConversacionesFiltro,
  ResponderResultado,
  TomarResultado,
} from "./tipos.ts";

export interface ConversacionesRepository {
  listar(actor: ConversacionActor, propertyId: string, filtro: ConversacionesFiltro): Promise<ConversacionBandeja>;
  /** `disponible: false` = base sin la 043. `valor: null` = no existe (o es de otra property). */
  detalle(actor: ConversacionActor, propertyId: string, conversationId: string): Promise<{ readonly disponible: boolean; readonly valor: ConversacionDetalle | null }>;
  leer(actor: ConversacionActor, propertyId: string, conversationId: string): Promise<void>;
  tomar(actor: ConversacionActor, propertyId: string, conversationId: string, reasignar: boolean): Promise<TomarResultado>;
  devolver(actor: ConversacionActor, propertyId: string, conversationId: string): Promise<ConversacionModo>;
  cerrar(actor: ConversacionActor, propertyId: string, conversationId: string): Promise<ConversacionModo>;
  agregarNota(actor: ConversacionActor, propertyId: string, conversationId: string, texto: string): Promise<string>;
  responder(actor: ConversacionActor, propertyId: string, conversationId: string, texto: string): Promise<ResponderResultado>;
}
