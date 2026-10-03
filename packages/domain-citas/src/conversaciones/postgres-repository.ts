// Adaptador Postgres de `ConversacionesRepository` y de `HandoffAgentGate` (migracion 031). REGLA DURA de compatibilidad con la base SIN
// migrar: mergear despliega el codigo al instante y la migracion 031 no se aplica sola. Toda consulta corre dentro de la transaccion UNICA
// de un request (`withAppSession`), donde un error de Postgres la deja abortada (25P02) y el COMMIT seria un ROLLBACK silencioso; por eso
// TODA operacion usa `runWithSavepointFallback` (SAVEPOINT / ROLLBACK TO SAVEPOINT) antes de degradar: lecturas -> `disponible: false`,
// escrituras -> `ConversacionesNoDisponibleError` (503), el gate del agente -> "sin toma" (el agente responde como siempre).
import { emitirNotificacion, runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { ConversacionesRepository, HandoffAgentGate } from "./repository.ts";
import {
  ConversacionesConflictoError,
  ConversacionesNoDisponibleError,
  ConversacionesRechazadaError,
  ConversacionesValidacionError,
  HANDOFF_ESTADOS,
  HandoffYaTomadoError,
  SinNumeroWhatsappError,
} from "./types.ts";
import type { BandejaFiltro, BandejaItem, BandejaPagina, ConversacionDetalle, ConversacionesLectura, HandoffDetalle, HandoffEstado, MensajeConversacion, NotaInterna } from "./types.ts";

function code(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** Objeto de la migracion 031 inexistente: tabla, columna o funcion. */
export function esBaseSinMigrar(err: unknown): boolean {
  const c = code(err);
  return c === "42P01" || c === "42703" || c === "42883";
}

/** Rechazos de negocio que la base declara con un SQLSTATE conocido. */
function esRechazoConocido(err: unknown): boolean {
  const c = code(err);
  return esBaseSinMigrar(err) || c === "42501" || c === "55006" || c === "55000" || c === "P0002" || c === "22023" || c === "23514" || c === "23503";
}

let advertido = false;
function advertirNoDisponible(err: unknown): void {
  if (advertido) return;
  advertido = true;
  console.warn(
    "PostgresConversacionesRepository: las tablas/funciones de handoff todavía no existen en esta base (SQLSTATE 42P01/42703/42883) -- " +
      "aplica packages/domain-citas/migrations/031_citas_conversaciones_handoff.sql (o su espejo en supabase/migrations/).",
    err,
  );
}

function aError(err: unknown): never {
  const c = code(err);
  if (esBaseSinMigrar(err)) {
    advertirNoDisponible(err);
    throw new ConversacionesNoDisponibleError();
  }
  if (c === "55006") throw new HandoffYaTomadoError();
  if (c === "55000") throw new ConversacionesConflictoError();
  if (c === "P0002") throw new SinNumeroWhatsappError();
  if (c === "22023" || c === "23514") throw new ConversacionesValidacionError("Dato fuera de rango (revisa el texto del mensaje o de la nota).");
  if (c === "23503") throw new ConversacionesValidacionError("Referencia inexistente (revisa la conversación indicada).");
  throw new ConversacionesRechazadaError();
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const isoOrNull = (v: Date | string | null): string | null => (v === null || v === undefined ? null : iso(v));

interface BandejaRow {
  conversation_id: string;
  property_id: string;
  telefono: string;
  vista_previa: string;
  actividad_at: Date | string;
  estado: string;
  handoff_id: string | null;
  motivo: string | null;
  crisis: boolean;
  solicitada_at: Date | string | null;
  ultimo_cliente_at: Date | string | null;
  tomada_por: string | null;
  tomada_por_nombre: string | null;
  tomada_at: Date | string | null;
  cita_id: string | null;
  cita_inicio: Date | string | null;
  cita_estado: string | null;
  total: string | number;
}

function mapBandeja(r: BandejaRow): BandejaItem {
  return {
    conversationId: r.conversation_id,
    propertyId: r.property_id,
    telefono: r.telefono,
    vistaPrevia: r.vista_previa ?? "",
    actividadAt: iso(r.actividad_at),
    estado: (HANDOFF_ESTADOS as readonly string[]).includes(r.estado) ? (r.estado as HandoffEstado) : "agente",
    handoffId: r.handoff_id,
    motivo: r.motivo,
    crisis: r.crisis === true,
    solicitadaAt: isoOrNull(r.solicitada_at),
    ultimoClienteAt: isoOrNull(r.ultimo_cliente_at),
    tomadaPor: r.tomada_por,
    tomadaPorNombre: r.tomada_por_nombre,
    tomadaAt: isoOrNull(r.tomada_at),
    citaId: r.cita_id,
    citaInicio: isoOrNull(r.cita_inicio),
    citaEstado: r.cita_estado,
  };
}

export class PostgresConversacionesRepository implements ConversacionesRepository {
  constructor(private readonly db: TenantDbSession) {}

  private lectura<T>(savepointName: string, vacio: T, primary: () => Promise<T>): Promise<ConversacionesLectura<T>> {
    return runWithSavepointFallback<ConversacionesLectura<T>>({
      session: this.db,
      savepointName,
      primary: async () => ({ disponible: true, valor: await primary() }),
      isRecoverable: (err) => esBaseSinMigrar(err) || code(err) === "42501",
      fallback: async (err) => {
        if (code(err) === "42501") throw new ConversacionesRechazadaError();
        advertirNoDisponible(err);
        return { disponible: false, valor: vacio };
      },
    });
  }

  private escritura<T>(savepointName: string, primary: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback<T>({ session: this.db, savepointName, primary, isRecoverable: esRechazoConocido, fallback: aError });
  }

  async listarBandeja(organizationId: string, propertyId: string, filtro: BandejaFiltro): Promise<ConversacionesLectura<BandejaPagina>> {
    return this.lectura<BandejaPagina>("sp_citas_conv_bandeja_read", { items: [], total: 0 }, async () => {
      const { rows } = await this.db.query<BandejaRow>(
        `select conversation_id, property_id, telefono, vista_previa, actividad_at, estado, handoff_id, motivo, crisis, solicitada_at,
                ultimo_cliente_at, tomada_por, tomada_por_nombre, tomada_at, cita_id, cita_inicio, cita_estado, total
           from citas.bandeja_conversaciones($1::uuid, $2::uuid, $3::text, $4::int, $5::int);`,
        [organizationId, propertyId, filtro.estado ?? null, filtro.limit ?? 25, filtro.offset ?? 0],
      );
      return { items: rows.map(mapBandeja), total: rows.length > 0 ? Number(rows[0]!.total) : 0 };
    });
  }

  async detalle(organizationId: string, propertyId: string, conversationId: string): Promise<ConversacionesLectura<ConversacionDetalle | null>> {
    return this.lectura<ConversacionDetalle | null>("sp_citas_conv_detalle_read", null, async () => {
      // Pertenencia: la RLS deja leer la conversacion a cualquier miembro de la organizacion; aqui ademas se exige la sucursal (o ninguna).
      const conv = await this.db.query<{ phone: string; messages: unknown; appointment_id: string | null }>(
        `select phone, messages, appointment_id from citas.whatsapp_conversations where id = $1 and organization_id = $2 and (property_id is null or property_id = $3);`,
        [conversationId, organizationId, propertyId],
      );
      const fila = conv.rows[0];
      if (!fila) return null;
      const arr = Array.isArray(fila.messages) ? (fila.messages as Array<Record<string, unknown>>) : [];
      const mensajes: MensajeConversacion[] = arr
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ rol: m.role === "user" ? "cliente" : m.autor === "humano" ? "humano" : "agente", texto: typeof m.content === "string" ? m.content : "" }));
      const h = await this.db.query<{
        handoff_id: string; estado: string; solicitado_por: string; motivo: string | null; crisis: boolean; solicitada_at: Date | string;
        ultimo_cliente_at: Date | string | null; tomada_por: string | null; tomada_por_nombre: string | null; tomada_at: Date | string | null;
      }>(
        `select handoff_id, estado, solicitado_por, motivo, crisis, solicitada_at, ultimo_cliente_at, tomada_por, tomada_por_nombre, tomada_at
           from citas.handoff_detalle($1::uuid, $2::uuid, $3::uuid);`,
        [organizationId, propertyId, conversationId],
      );
      const row = h.rows[0];
      const handoff: HandoffDetalle | null = row
        ? {
            handoffId: row.handoff_id,
            estado: row.estado as HandoffDetalle["estado"],
            solicitadoPor: row.solicitado_por === "staff" ? "staff" : "agente",
            motivo: row.motivo,
            crisis: row.crisis === true,
            solicitadaAt: iso(row.solicitada_at),
            ultimoClienteAt: isoOrNull(row.ultimo_cliente_at),
            tomadaPor: row.tomada_por,
            tomadaPorNombre: row.tomada_por_nombre,
            tomadaAt: isoOrNull(row.tomada_at),
          }
        : null;
      let notas: NotaInterna[] = [];
      if (handoff) {
        const n = await this.db.query<{ id: string; autor_id: string | null; autor_nombre: string | null; texto: string; created_at: Date | string }>(
          `select id, autor_id, autor_nombre, texto, created_at from citas.handoff_notas($1::uuid, $2::uuid, $3::uuid);`,
          [organizationId, propertyId, handoff.handoffId],
        );
        notas = n.rows.map((x) => ({ id: x.id, autorId: x.autor_id, autorNombre: x.autor_nombre, texto: x.texto, createdAt: iso(x.created_at) }));
      }
      return { conversationId, telefono: fila.phone, mensajes, citaId: fila.appointment_id, handoff, notas };
    });
  }

  async tomar(organizationId: string, propertyId: string, conversationId: string): Promise<string> {
    return this.escritura("sp_citas_conv_tomar", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select citas.handoff_tomar($1::uuid, $2::uuid, $3::uuid) as id;`, [organizationId, propertyId, conversationId]);
      return rows[0]!.id;
    });
  }

  async devolver(organizationId: string, propertyId: string, handoffId: string): Promise<boolean> {
    return this.escritura("sp_citas_conv_devolver", async () => {
      const { rows } = await this.db.query<{ ok: boolean }>(`select citas.handoff_devolver($1::uuid, $2::uuid, $3::uuid) as ok;`, [organizationId, propertyId, handoffId]);
      return rows[0]!.ok === true;
    });
  }

  async cerrar(organizationId: string, propertyId: string, handoffId: string): Promise<boolean> {
    return this.escritura("sp_citas_conv_cerrar", async () => {
      const { rows } = await this.db.query<{ ok: boolean }>(`select citas.handoff_cerrar($1::uuid, $2::uuid, $3::uuid) as ok;`, [organizationId, propertyId, handoffId]);
      return rows[0]!.ok === true;
    });
  }

  async agregarNota(organizationId: string, propertyId: string, handoffId: string, texto: string): Promise<string> {
    return this.escritura("sp_citas_conv_nota", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select citas.handoff_agregar_nota($1::uuid, $2::uuid, $3::uuid, $4::text) as id;`, [organizationId, propertyId, handoffId, texto]);
      return rows[0]!.id;
    });
  }

  async responder(organizationId: string, propertyId: string, handoffId: string, texto: string): Promise<string> {
    return this.escritura("sp_citas_conv_responder", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select citas.handoff_responder($1::uuid, $2::uuid, $3::uuid, $4::text) as id;`, [organizationId, propertyId, handoffId, texto]);
      return rows[0]!.id;
    });
  }
}

/** Gate del agente de WhatsApp: corre en la sesion de SISTEMA del webhook. Contra la base sin migrar el agente sigue respondiendo como
 * siempre (nunca falla el turno por esto). */
export class PostgresHandoffAgentGate implements HandoffAgentGate {
  constructor(private readonly db: TenantDbSession) {}

  async estadoParaAgente(organizationId: string, phone: string): Promise<"pendiente" | "tomada" | null> {
    return runWithSavepointFallback<"pendiente" | "tomada" | null>({
      session: this.db,
      savepointName: "sp_citas_handoff_gate_estado",
      primary: async () => {
        const { rows } = await this.db.query<{ estado: string | null }>(`select citas.handoff_whatsapp_estado($1::uuid, $2::text) as estado;`, [organizationId, phone]);
        const e = rows[0]?.estado;
        return e === "pendiente" || e === "tomada" ? e : null;
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async (err) => {
        advertirNoDisponible(err);
        return null;
      },
    });
  }

  async solicitarHumano(input: { readonly organizationId: string; readonly phone: string; readonly motivo: string; readonly crisis: boolean }): Promise<string | null> {
    const id = await runWithSavepointFallback<string | null>({
      session: this.db,
      savepointName: "sp_citas_handoff_gate_solicitar",
      primary: async () => {
        const { rows } = await this.db.query<{ id: string | null }>(`select citas.handoff_solicitar_whatsapp($1::uuid, $2::text, $3::text, $4::boolean) as id;`, [input.organizationId, input.phone, input.motivo, input.crisis]);
        return rows[0]?.id ?? null;
      },
      isRecoverable: (err) => esBaseSinMigrar(err) || code(err) === "42501",
      fallback: async (err) => {
        if (esBaseSinMigrar(err)) advertirNoDisponible(err);
        return null;
      },
    });
    if (id) {
      // Notificacion in-app (productor compartido, `citas.conversacion.handoff`): una por toma (clave = id del handoff, sin PII: texto fijo del
      // catalogo). Una crisis sube a severidad critica. emitirNotificacion nunca lanza y contiene sus errores en un SAVEPOINT.
      await emitirNotificacion(this.db, {
        evento: "citas.conversacion.handoff",
        organizationId: input.organizationId,
        clave: id,
        entidadTipo: "conversation_handoff",
        entidadId: id,
        ...(input.crisis ? { severidad: "critica" as const } : {}),
      });
    }
    return id;
  }
}
