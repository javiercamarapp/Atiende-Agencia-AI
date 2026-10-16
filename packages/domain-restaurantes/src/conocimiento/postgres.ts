// Acceso a Postgres del conocimiento del negocio y del interruptor del agente de WhatsApp (migracion 053). REGLA DURA de compatibilidad con
// la base SIN migrar: mergear despliega el codigo al instante y la 053 no se aplica sola. Todo corre dentro de la transaccion UNICA del
// request (`withAppSession`): un error de Postgres la deja abortada (25P02), por eso cada operacion usa `runWithSavepointFallback`.
// LECTURAS degradan a "sin conocimiento" / "agente encendido" (42P01/42703/42883/42501); ESCRITURAS lanzan `RestaurantesConfigUnavailableError`
// (503 honesto en la ruta), nunca un 500 ni una escritura a medias.
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { RestaurantesConfigUnavailableError } from "../repository.ts";
import type { ConocimientoEntrada, ConocimientoEstado, ConocimientoLectura, ConocimientoOrigen, ConocimientoPatch, ConocimientoTipo, NuevaConocimientoEntrada } from "./types.ts";

function esBaseSinMigrar(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42501" || code === "42883" || code === "42P01" || code === "42703";
}

const advertidas = new Set<string>();
function advertir(que: string, err: unknown): void {
  if (advertidas.has(que)) return;
  advertidas.add(que);
  console.warn(
    `conocimiento/postgres: ${que} todavia no esta disponible en esta base (SQLSTATE 42501/42883/42P01/42703) -- aplica ` +
      "packages/domain-restaurantes/migrations/053_conocimiento_negocio_y_control_agente.sql (o su espejo en supabase/migrations/).",
    err,
  );
}

interface FilaConocimiento {
  id: string;
  organization_id: string;
  property_id: string | null;
  reemplaza_id: string | null;
  titulo: string;
  texto: string;
  tipo: ConocimientoTipo;
  prioridad: number;
  vigente_desde: string | null;
  vigente_hasta: string | null;
  activo: boolean;
  estado: ConocimientoEstado;
  origen: ConocimientoOrigen;
  version: number;
  creado_por: string | null;
  actualizado_por: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const COLUMNAS = `id, organization_id, property_id, reemplaza_id, titulo, texto, tipo, prioridad,
  to_char(vigente_desde, 'YYYY-MM-DD') as vigente_desde, to_char(vigente_hasta, 'YYYY-MM-DD') as vigente_hasta,
  activo, estado, origen, version, creado_por, actualizado_por, created_at, updated_at`;

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function mapFila(r: FilaConocimiento): ConocimientoEntrada {
  return {
    id: r.id,
    organizationId: r.organization_id,
    propertyId: r.property_id,
    reemplazaId: r.reemplaza_id,
    titulo: r.titulo,
    texto: r.texto,
    tipo: r.tipo,
    prioridad: Number(r.prioridad),
    vigenteDesde: r.vigente_desde,
    vigenteHasta: r.vigente_hasta,
    activo: r.activo === true,
    estado: r.estado,
    origen: r.origen,
    version: Number(r.version),
    creadoPor: r.creado_por,
    actualizadoPor: r.actualizado_por,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/** Todas las entradas de la organizacion (borradores incluidos) para el panel. `disponible: false` contra la base sin migrar. */
export async function pgListarConocimiento(db: TenantDbSession, organizationId: string): Promise<ConocimientoLectura> {
  return runWithSavepointFallback<ConocimientoLectura>({
    session: db,
    savepointName: "sp_restaurantes_conocimiento_lista",
    primary: async () => {
      const { rows } = await db.query<FilaConocimiento>(
        `select ${COLUMNAS} from restaurantes.conocimiento_negocio where organization_id = $1 order by prioridad desc, updated_at desc limit 500;`,
        [organizationId],
      );
      return { disponible: true, entradas: rows.map(mapFila) };
    },
    isRecoverable: esBaseSinMigrar,
    fallback: async (err) => {
      advertir("conocimiento_negocio", err);
      return { disponible: false, entradas: [] };
    },
  });
}

/** Lo que ve el agente: publicado y activo, general o de la sucursal (la vigencia por fecha local la decide `listarConocimientoVigente`). `[]` contra la base sin migrar. */
export async function pgListarConocimientoPublicado(db: TenantDbSession, organizationId: string, propertyId: string | null): Promise<readonly ConocimientoEntrada[]> {
  return runWithSavepointFallback<readonly ConocimientoEntrada[]>({
    session: db,
    savepointName: "sp_restaurantes_conocimiento_agente",
    primary: async () => {
      const { rows } = await db.query<FilaConocimiento>(
        `select ${COLUMNAS} from restaurantes.conocimiento_negocio
         where organization_id = $1 and activo = true and estado = 'publicado' and (property_id is null or property_id = $2)
         order by prioridad desc, updated_at desc limit 200;`,
        [organizationId, propertyId],
      );
      return rows.map(mapFila);
    },
    isRecoverable: esBaseSinMigrar,
    fallback: async (err) => {
      advertir("conocimiento_negocio", err);
      return [];
    },
  });
}

export async function pgCrearConocimiento(db: TenantDbSession, organizationId: string, actorId: string, input: NuevaConocimientoEntrada): Promise<ConocimientoEntrada> {
  return runWithSavepointFallback<ConocimientoEntrada>({
    session: db,
    savepointName: "sp_restaurantes_conocimiento_alta",
    primary: async () => {
      const { rows } = await db.query<FilaConocimiento>(
        `insert into restaurantes.conocimiento_negocio
           (organization_id, property_id, reemplaza_id, titulo, texto, tipo, prioridad, vigente_desde, vigente_hasta, activo, estado, origen, version, creado_por, actualizado_por, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10, $11, $12, 1, $13, $13, now())
         returning ${COLUMNAS};`,
        [
          organizationId,
          input.propertyId ?? null,
          input.reemplazaId ?? null,
          input.titulo,
          input.texto,
          input.tipo,
          input.prioridad ?? 50,
          input.vigenteDesde ?? null,
          input.vigenteHasta ?? null,
          input.activo ?? true,
          input.estado ?? "publicado",
          input.origen ?? "manual",
          actorId,
        ],
      );
      return mapFila(rows[0]!);
    },
    isRecoverable: esBaseSinMigrar,
    fallback: (err) => {
      advertir("conocimiento_negocio", err);
      throw new RestaurantesConfigUnavailableError();
    },
  });
}

/** Edita una entrada (suma 1 a la version). `null` si no existe o es de otra organizacion (RLS filtra). */
export async function pgActualizarConocimiento(db: TenantDbSession, organizationId: string, actorId: string, id: string, patch: ConocimientoPatch): Promise<ConocimientoEntrada | null> {
  const sets: string[] = [];
  const params: unknown[] = [organizationId, id];
  const poner = (col: string, valor: unknown, cast = ""): void => {
    params.push(valor);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (patch.reemplazaId !== undefined) poner("reemplaza_id", patch.reemplazaId);
  if (patch.titulo !== undefined) poner("titulo", patch.titulo);
  if (patch.texto !== undefined) poner("texto", patch.texto);
  if (patch.tipo !== undefined) poner("tipo", patch.tipo);
  if (patch.prioridad !== undefined) poner("prioridad", patch.prioridad);
  if (patch.vigenteDesde !== undefined) poner("vigente_desde", patch.vigenteDesde, "::date");
  if (patch.vigenteHasta !== undefined) poner("vigente_hasta", patch.vigenteHasta, "::date");
  if (patch.activo !== undefined) poner("activo", patch.activo);
  if (patch.estado !== undefined) poner("estado", patch.estado);
  poner("actualizado_por", actorId);
  return runWithSavepointFallback<ConocimientoEntrada | null>({
    session: db,
    savepointName: "sp_restaurantes_conocimiento_edicion",
    primary: async () => {
      const { rows } = await db.query<FilaConocimiento>(
        `update restaurantes.conocimiento_negocio set ${sets.join(", ")}, version = version + 1, updated_at = now()
         where organization_id = $1 and id = $2 returning ${COLUMNAS};`,
        params,
      );
      return rows[0] ? mapFila(rows[0]) : null;
    },
    isRecoverable: esBaseSinMigrar,
    fallback: (err) => {
      advertir("conocimiento_negocio", err);
      throw new RestaurantesConfigUnavailableError();
    },
  });
}

export async function pgBorrarConocimiento(db: TenantDbSession, organizationId: string, id: string): Promise<boolean> {
  return runWithSavepointFallback<boolean>({
    session: db,
    savepointName: "sp_restaurantes_conocimiento_baja",
    primary: async () => {
      const { rows } = await db.query<{ id: string }>(`delete from restaurantes.conocimiento_negocio where organization_id = $1 and id = $2 returning id;`, [organizationId, id]);
      return rows.length > 0;
    },
    isRecoverable: esBaseSinMigrar,
    fallback: (err) => {
      advertir("conocimiento_negocio", err);
      throw new RestaurantesConfigUnavailableError();
    },
  });
}

/** `true` (encendido, como hasta hoy) si la sucursal no tiene fila o la base no esta migrada. Lo lee el webhook ANTES de llamar al modelo. */
export async function pgAgenteWhatsappActivo(db: TenantDbSession, propertyId: string): Promise<boolean> {
  return runWithSavepointFallback<boolean>({
    session: db,
    savepointName: "sp_restaurantes_wa_control_lectura",
    primary: async () => {
      const { rows } = await db.query<{ agente_activo: boolean }>(`select agente_activo from restaurantes.whatsapp_sucursal_control where property_id = $1;`, [propertyId]);
      return rows[0] ? rows[0].agente_activo !== false : true;
    },
    isRecoverable: esBaseSinMigrar,
    fallback: async (err) => {
      advertir("whatsapp_sucursal_control", err);
      return true;
    },
  });
}

/** Sucursales de la organizacion con el agente apagado (para el panel). `disponible: false` contra la base sin migrar. */
export async function pgListarAgentesApagados(db: TenantDbSession, organizationId: string): Promise<{ readonly disponible: boolean; readonly propertyIdsApagados: readonly string[] }> {
  return runWithSavepointFallback<{ readonly disponible: boolean; readonly propertyIdsApagados: readonly string[] }>({
    session: db,
    savepointName: "sp_restaurantes_wa_control_lista",
    primary: async () => {
      const { rows } = await db.query<{ property_id: string }>(
        `select property_id from restaurantes.whatsapp_sucursal_control where organization_id = $1 and agente_activo = false;`,
        [organizationId],
      );
      return { disponible: true, propertyIdsApagados: rows.map((r) => r.property_id) };
    },
    isRecoverable: esBaseSinMigrar,
    fallback: async (err) => {
      advertir("whatsapp_sucursal_control", err);
      return { disponible: false, propertyIdsApagados: [] };
    },
  });
}

export async function pgFijarAgenteWhatsappActivo(db: TenantDbSession, organizationId: string, propertyId: string, actorId: string, activo: boolean): Promise<void> {
  await runWithSavepointFallback<void>({
    session: db,
    savepointName: "sp_restaurantes_wa_control_escritura",
    primary: async () => {
      await db.query(
        `insert into restaurantes.whatsapp_sucursal_control as c (property_id, organization_id, agente_activo, actualizado_por, updated_at)
         values ($1, $2, $3, $4, now())
         on conflict (property_id) do update set agente_activo = excluded.agente_activo, actualizado_por = excluded.actualizado_por, updated_at = excluded.updated_at
         where c.organization_id = excluded.organization_id;`,
        [propertyId, organizationId, activo, actorId],
      );
    },
    isRecoverable: esBaseSinMigrar,
    fallback: (err) => {
      advertir("whatsapp_sucursal_control", err);
      throw new RestaurantesConfigUnavailableError();
    },
  });
}
