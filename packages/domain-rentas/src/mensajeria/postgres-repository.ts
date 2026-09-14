// PostgresRentasMensajeriaRepository -- adaptador de producción de
// `RentasMensajeriaRepository`, sobre el `TenantDbSession` genérico de
// `@atiende/core-tenancy` (mismo contrato que `PostgresRentasRepository`/
// `PostgresRentasOwnerPortalRepository`). Contra el esquema de
// `supabase/migrations/*_009_rentas_mensajeria_schema.sql`.
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { RentasMensajeriaRepository } from "./repository.ts";
import type { CanalMensajeriaCodigo, DireccionMensaje, EstadoBorrador, EventoPlantilla, IdiomaMensaje, OrigenMensaje } from "./tipos.ts";
import type {
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

interface ConversacionRow {
  id: string;
  organization_id: string;
  property_id: string;
  unidad_id: string;
  canal_codigo: CanalMensajeriaCodigo;
  ocupacion_id: string | null;
  huesped_minimo_id: string | null;
  propiedad_nombre: string;
  huesped_nombre: string | null;
  fecha_check_in: string | null;
  fecha_check_out: string | null;
  reserva_confirmada: boolean;
  creado_en: string;
}

function mapConversacion(r: ConversacionRow): ConversacionRecord {
  return {
    id: r.id,
    organizationId: r.organization_id,
    propertyId: r.property_id,
    unidadId: r.unidad_id,
    canal: r.canal_codigo,
    ocupacionId: r.ocupacion_id,
    huespedMinimoId: r.huesped_minimo_id,
    propiedadNombre: r.propiedad_nombre,
    huespedNombre: r.huesped_nombre,
    fechaCheckIn: r.fecha_check_in,
    fechaCheckOut: r.fecha_check_out,
    reservaConfirmada: r.reserva_confirmada,
    creadoEn: r.creado_en,
  };
}

const CONVERSACION_SELECT = `id, organization_id, property_id, unidad_id, canal_codigo, ocupacion_id, huesped_minimo_id,
   propiedad_nombre, huesped_nombre, fecha_check_in::text as fecha_check_in, fecha_check_out::text as fecha_check_out,
   reserva_confirmada, creado_en::text as creado_en`;

interface MensajeRow {
  id: string;
  conversacion_id: string;
  direccion: DireccionMensaje;
  origen: OrigenMensaje;
  texto: string;
  redactado: boolean;
  creado_en: string;
}

function mapMensaje(r: MensajeRow): MensajeRecord {
  return { id: r.id, conversacionId: r.conversacion_id, direccion: r.direccion, origen: r.origen, texto: r.texto, redactado: r.redactado, creadoEn: r.creado_en };
}

const MENSAJE_SELECT = `id, conversacion_id, direccion, origen, texto, redactado, creado_en::text as creado_en`;

interface BorradorRow {
  id: string;
  conversacion_id: string;
  mensaje_entrante_id: string | null;
  canal_codigo: CanalMensajeriaCodigo;
  texto: string;
  estado: EstadoBorrador;
  generado_por: GeneradoPorBorrador;
  redactado: boolean;
  aprobado_por: string | null;
  aprobado_en: string | null;
  rechazado_por: string | null;
  rechazado_en: string | null;
  motivo_rechazo: string | null;
  mensaje_enviado_id: string | null;
  creado_en: string;
  actualizado_en: string;
}

function mapBorrador(r: BorradorRow): BorradorRecord {
  return {
    id: r.id,
    conversacionId: r.conversacion_id,
    mensajeEntranteId: r.mensaje_entrante_id,
    canal: r.canal_codigo,
    texto: r.texto,
    estado: r.estado,
    generadoPor: r.generado_por,
    redactado: r.redactado,
    aprobadoPor: r.aprobado_por,
    aprobadoEn: r.aprobado_en,
    rechazadoPor: r.rechazado_por,
    rechazadoEn: r.rechazado_en,
    motivoRechazo: r.motivo_rechazo,
    mensajeEnviadoId: r.mensaje_enviado_id,
    creadoEn: r.creado_en,
    actualizadoEn: r.actualizado_en,
  };
}

const BORRADOR_SELECT = `id, conversacion_id, mensaje_entrante_id, canal_codigo, texto, estado, generado_por, redactado,
   aprobado_por, aprobado_en::text as aprobado_en, rechazado_por, rechazado_en::text as rechazado_en, motivo_rechazo,
   mensaje_enviado_id, creado_en::text as creado_en, actualizado_en::text as actualizado_en`;

// Misma proyección que BORRADOR_SELECT, con el prefijo de tabla `b.` explícito para
// las dos queries que hacen JOIN a `rentas.conversacion` (findBorrador/listBorradores)
// -- evitar transformar BORRADOR_SELECT con un split/join de string, frágil ante
// cualquier cambio de formato de esa constante.
const BORRADOR_SELECT_JOIN = `b.id, b.conversacion_id, b.mensaje_entrante_id, b.canal_codigo, b.texto, b.estado, b.generado_por, b.redactado,
   b.aprobado_por, b.aprobado_en::text as aprobado_en, b.rechazado_por, b.rechazado_en::text as rechazado_en, b.motivo_rechazo,
   b.mensaje_enviado_id, b.creado_en::text as creado_en, b.actualizado_en::text as actualizado_en`;

interface PlantillaRow {
  id: string;
  organization_id: string;
  evento: EventoPlantilla;
  idioma: IdiomaMensaje;
  canal_codigo: CanalMensajeriaCodigo | null;
  cuerpo: string;
  aprobada_por_tenant: boolean;
  activa: boolean;
  creado_en: string;
  actualizado_en: string;
}

function mapPlantilla(r: PlantillaRow): PlantillaRecord {
  return {
    id: r.id,
    organizationId: r.organization_id,
    evento: r.evento,
    idioma: r.idioma,
    canal: r.canal_codigo,
    cuerpo: r.cuerpo,
    aprobadaPorTenant: r.aprobada_por_tenant,
    activa: r.activa,
    creadoEn: r.creado_en,
    actualizadoEn: r.actualizado_en,
  };
}

const PLANTILLA_SELECT = `id, organization_id, evento, idioma, canal_codigo, cuerpo, aprobada_por_tenant, activa,
   creado_en::text as creado_en, actualizado_en::text as actualizado_en`;

export class PostgresRentasMensajeriaRepository implements RentasMensajeriaRepository {
  constructor(private readonly db: TenantDbSession) {}

  // ---- Conversaciones ----

  async insertConversacion(input: NewConversacionInput): Promise<ConversacionRecord> {
    const { rows } = await this.db.query<ConversacionRow>(
      `insert into rentas.conversacion
         (organization_id, property_id, unidad_id, canal_codigo, ocupacion_id, huesped_minimo_id,
          propiedad_nombre, huesped_nombre, fecha_check_in, fecha_check_out, reserva_confirmada)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning ${CONVERSACION_SELECT};`,
      [
        input.organizationId,
        input.propertyId,
        input.unidadId,
        input.canal,
        input.ocupacionId ?? null,
        input.huespedMinimoId ?? null,
        input.propiedadNombre,
        input.huespedNombre ?? null,
        input.fechaCheckIn ?? null,
        input.fechaCheckOut ?? null,
        input.reservaConfirmada ?? false,
      ],
    );
    return mapConversacion(rows[0]!);
  }

  async findConversacion(propertyId: string, conversacionId: string): Promise<ConversacionRecord | null> {
    const { rows } = await this.db.query<ConversacionRow>(`select ${CONVERSACION_SELECT} from rentas.conversacion where id = $1 and property_id = $2;`, [conversacionId, propertyId]);
    return rows[0] ? mapConversacion(rows[0]) : null;
  }

  async listConversaciones(propertyId: string, unidadId?: string): Promise<readonly ConversacionRecord[]> {
    const { rows } = await this.db.query<ConversacionRow>(
      `select ${CONVERSACION_SELECT} from rentas.conversacion where property_id = $1 and ($2::uuid is null or unidad_id = $2) order by creado_en desc;`,
      [propertyId, unidadId ?? null],
    );
    return rows.map(mapConversacion);
  }

  // ---- Mensajes ----

  async insertMensaje(input: NewMensajeInput): Promise<MensajeRecord> {
    const { rows } = await this.db.query<MensajeRow>(
      `insert into rentas.mensaje (conversacion_id, direccion, origen, texto, redactado)
       values ($1, $2, $3, $4, $5)
       returning ${MENSAJE_SELECT};`,
      [input.conversacionId, input.direccion, input.origen, input.texto, input.redactado ?? false],
    );
    return mapMensaje(rows[0]!);
  }

  async findMensajeEntrante(conversacionId: string, mensajeId: string): Promise<MensajeRecord | null> {
    const { rows } = await this.db.query<MensajeRow>(`select ${MENSAJE_SELECT} from rentas.mensaje where id = $1 and conversacion_id = $2 and direccion = 'entrante';`, [mensajeId, conversacionId]);
    return rows[0] ? mapMensaje(rows[0]) : null;
  }

  async listMensajes(conversacionId: string): Promise<readonly MensajeRecord[]> {
    const { rows } = await this.db.query<MensajeRow>(`select ${MENSAJE_SELECT} from rentas.mensaje where conversacion_id = $1 order by creado_en asc;`, [conversacionId]);
    return rows.map(mapMensaje);
  }

  // ---- Borradores ----

  async insertBorrador(input: NewBorradorInput): Promise<BorradorRecord> {
    const { rows } = await this.db.query<BorradorRow>(
      `insert into rentas.borrador_mensaje (conversacion_id, mensaje_entrante_id, canal_codigo, texto, generado_por)
       values ($1, $2, $3, $4, $5)
       returning ${BORRADOR_SELECT};`,
      [input.conversacionId, input.mensajeEntranteId ?? null, input.canal, input.texto, input.generadoPor],
    );
    return mapBorrador(rows[0]!);
  }

  // `propertyId` se resuelve vía join a `rentas.conversacion` -- `borrador_mensaje` no
  // guarda property_id propio (RLS real también resuelve por el mismo join, ver
  // migración) -- defensa en profundidad idéntica al resto del repositorio, nunca
  // confía en que el cliente "sabe" que el borrador pertenece a esta property.
  async findBorrador(propertyId: string, borradorId: string): Promise<BorradorRecord | null> {
    const { rows } = await this.db.query<BorradorRow>(
      `select ${BORRADOR_SELECT_JOIN}
       from rentas.borrador_mensaje b
       join rentas.conversacion c on c.id = b.conversacion_id
       where b.id = $1 and c.property_id = $2;`,
      [borradorId, propertyId],
    );
    return rows[0] ? mapBorrador(rows[0]) : null;
  }

  async listBorradores(propertyId: string, conversacionId: string): Promise<readonly BorradorRecord[]> {
    const { rows } = await this.db.query<BorradorRow>(
      `select ${BORRADOR_SELECT_JOIN}
       from rentas.borrador_mensaje b
       join rentas.conversacion c on c.id = b.conversacion_id
       where b.conversacion_id = $1 and c.property_id = $2
       order by b.creado_en desc;`,
      [conversacionId, propertyId],
    );
    return rows.map(mapBorrador);
  }

  async marcarBorradorAprobadoYEnviado(input: MarcarBorradorAprobadoYEnviadoInput): Promise<BorradorRecord> {
    const { rows } = await this.db.query<BorradorRow>(
      `update rentas.borrador_mensaje
       set estado = 'enviado', texto = $2, redactado = $3, aprobado_por = $4, aprobado_en = now(),
           mensaje_enviado_id = $5, actualizado_en = now()
       where id = $1
       returning ${BORRADOR_SELECT};`,
      [input.id, input.textoFinal, input.redactado, input.aprobadoPor, input.mensajeEnviadoId],
    );
    const row = rows[0];
    if (!row) throw new Error(`Borrador ${input.id} no encontrado`);
    return mapBorrador(row);
  }

  async marcarBorradorRechazado(input: MarcarBorradorRechazadoInput): Promise<BorradorRecord> {
    const { rows } = await this.db.query<BorradorRow>(
      `update rentas.borrador_mensaje
       set estado = 'rechazado', rechazado_por = $2, rechazado_en = now(), motivo_rechazo = $3, actualizado_en = now()
       where id = $1
       returning ${BORRADOR_SELECT};`,
      [input.id, input.rechazadoPor, input.motivo],
    );
    const row = rows[0];
    if (!row) throw new Error(`Borrador ${input.id} no encontrado`);
    return mapBorrador(row);
  }

  async tocarBorradorParaAuditoria(borradorId: string): Promise<void> {
    await this.db.query(`update rentas.borrador_mensaje set actualizado_en = now() where id = $1;`, [borradorId]);
  }

  // ---- Plantillas ----

  async listPlantillas(organizationId: string, filtro?: { evento?: string; idioma?: string; canal?: string | null }): Promise<readonly PlantillaRecord[]> {
    const { rows } = await this.db.query<PlantillaRow>(
      `select ${PLANTILLA_SELECT} from rentas.plantilla_mensaje
       where organization_id = $1
         and ($2::text is null or evento = $2)
         and ($3::text is null or idioma = $3)
         and ($4::boolean is false or canal_codigo is not distinct from $5)
       order by evento, idioma;`,
      [organizationId, filtro?.evento ?? null, filtro?.idioma ?? null, filtro?.canal !== undefined, filtro?.canal ?? null],
    );
    return rows.map(mapPlantilla);
  }

  async findPlantilla(organizationId: string, id: string): Promise<PlantillaRecord | null> {
    const { rows } = await this.db.query<PlantillaRow>(`select ${PLANTILLA_SELECT} from rentas.plantilla_mensaje where id = $1 and organization_id = $2;`, [id, organizationId]);
    return rows[0] ? mapPlantilla(rows[0]) : null;
  }

  async insertPlantilla(input: NewPlantillaInput): Promise<PlantillaRecord> {
    const { rows } = await this.db.query<PlantillaRow>(
      `insert into rentas.plantilla_mensaje (organization_id, evento, idioma, canal_codigo, cuerpo, aprobada_por_tenant, activa)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning ${PLANTILLA_SELECT};`,
      [input.organizationId, input.evento, input.idioma, input.canal, input.cuerpo, input.aprobadaPorTenant ?? false, input.activa ?? true],
    );
    return mapPlantilla(rows[0]!);
  }

  async updatePlantilla(input: UpdatePlantillaInput): Promise<PlantillaRecord | null> {
    const { rows } = await this.db.query<PlantillaRow>(
      `update rentas.plantilla_mensaje
       set cuerpo = coalesce($3, cuerpo),
           aprobada_por_tenant = coalesce($4, aprobada_por_tenant),
           activa = coalesce($5, activa),
           actualizado_en = now()
       where id = $1 and organization_id = $2
       returning ${PLANTILLA_SELECT};`,
      [input.id, input.organizationId, input.cuerpo ?? null, input.aprobadaPorTenant ?? null, input.activa ?? null],
    );
    return rows[0] ? mapPlantilla(rows[0]) : null;
  }
}
