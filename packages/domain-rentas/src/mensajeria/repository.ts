// Puerto de acceso a datos de mensajería — mismo patrón dual de adaptador que
// ../repository.ts/../owner-portal/repository.ts: un puerto TS explícito,
// DELIBERADAMENTE AUTOCONTENIDO (no se fusiona en `RentasRepository`), mismo criterio
// que `RentasOwnerPortalRepository`/`RentasCalendarSyncRepository`: cada lote de
// dominio con su propio recorte de tablas, para que se pueda leer/probar sin arrastrar
// el repository gigante de calendario/pricing/finanzas.
//
// A diferencia de `crearReservaConfirmada`/`cancelarOcupacion` (que reciben el
// `TenantDbSession` directo por structural typing), la transición de aprobación de un
// borrador SÍ se envuelve aquí (`marcarBorradorAprobadoYEnviado`) porque, a diferencia
// del anti-doble-reserva (que depende del EXCLUDE de Postgres), la máquina de estados
// de ./colaAprobacion.ts es un cálculo puro en TypeScript sin ninguna garantía nativa
// de base de datos que la respalde — la ruta HTTP calcula la transición con las
// funciones puras de ./colaAprobacion.ts y ./politica.ts, y este repositorio solo
// persiste el resultado ya validado (ver mensajeria-borradores.ts).
import type { CanalMensajeriaCodigo } from "./tipos.ts";
import type {
  BorradorRecord,
  ConversacionRecord,
  MarcarBorradorAprobadoYEnviadoInput,
  MarcarBorradorRechazadoInput,
  MensajeRecord,
  NewBorradorInput,
  NewConversacionInput,
  NewMensajeInput,
  NewPlantillaInput,
  PlantillaRecord,
  UpdatePlantillaInput,
} from "./types.ts";

export interface RentasMensajeriaRepository {
  // ---- Conversaciones ----
  insertConversacion(input: NewConversacionInput): Promise<ConversacionRecord>;
  findConversacion(propertyId: string, conversacionId: string): Promise<ConversacionRecord | null>;
  listConversaciones(propertyId: string, unidadId?: string): Promise<readonly ConversacionRecord[]>;

  // ---- Mensajes ----
  insertMensaje(input: NewMensajeInput): Promise<MensajeRecord>;
  /** Defensa en profundidad: exige que el mensaje pertenezca a la conversación
   * indicada, nunca confía en que el cliente "sabe" que `mensajeEntranteId` calza con
   * `conversacionId` (mismo criterio que `findOcupacion` de ../repository.ts). */
  findMensajeEntrante(conversacionId: string, mensajeId: string): Promise<MensajeRecord | null>;
  listMensajes(conversacionId: string): Promise<readonly MensajeRecord[]>;

  // ---- Borradores / cola de aprobación (H-059) ----
  insertBorrador(input: NewBorradorInput): Promise<BorradorRecord>;
  findBorrador(propertyId: string, borradorId: string): Promise<BorradorRecord | null>;
  listBorradores(propertyId: string, conversacionId: string): Promise<readonly BorradorRecord[]>;
  /** Única operación de escritura que deja un borrador en `estado: "enviado"` — el
   * repositorio NUNCA expone un `marcarEnviado` genérico sin los datos de aprobación,
   * espejo del principio de ./colaAprobacion.ts::marcarEnviadoTrasAprobacion. */
  marcarBorradorAprobadoYEnviado(input: MarcarBorradorAprobadoYEnviadoInput): Promise<BorradorRecord>;
  marcarBorradorRechazado(input: MarcarBorradorRechazadoInput): Promise<BorradorRecord>;
  /** Dejar un rastro de auditoría (`actualizado_en`) de un intento de envío
   * automático rechazado, sin cambiar `estado` — ver
   * ./colaAprobacion.ts::intentarEnvioAutomatico y el REQ correspondiente en
   * apps/api/tests/rentas-mensajeria.spec.ts. */
  tocarBorradorParaAuditoria(borradorId: string): Promise<void>;

  // ---- Plantillas (H-056) ----
  listPlantillas(organizationId: string, filtro?: { evento?: string; idioma?: string; canal?: CanalMensajeriaCodigo | null }): Promise<readonly PlantillaRecord[]>;
  findPlantilla(organizationId: string, id: string): Promise<PlantillaRecord | null>;
  insertPlantilla(input: NewPlantillaInput): Promise<PlantillaRecord>;
  updatePlantilla(input: UpdatePlantillaInput): Promise<PlantillaRecord | null>;
}

export type {
  BorradorRecord,
  ConversacionRecord,
  GeneradoPorBorrador,
  MarcarBorradorAprobadoYEnviadoInput,
  MarcarBorradorRechazadoInput,
  MensajeRecord,
  NewBorradorInput,
  NewConversacionInput,
  NewMensajeInput,
  NewPlantillaInput,
  PlantillaRecord,
  UpdatePlantillaInput,
} from "./types.ts";
