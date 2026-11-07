// H-P3-03 -- adaptadores Postgres de los mensajes al huesped (migracion 046).
//
// REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: la sesion es UNA transaccion (del request o de la unidad del cron); un error de Postgres
// (42P01/42883/42703) la dejaria ABORTADA (25P02). Toda degradacion corre bajo SAVEPOINT (runWithSavepointFallback): las lecturas de staff
// devuelven `disponible: false`, las escrituras lanzan `MensajesHuespedUnavailableError` (503) y el catalogo de plantillas ausente se lee como
// "no se puede saber". `listarCandidatos` NO degrada aqui: lanza y el ejecutor lo trata como "no disponible aun" (una transaccion por unidad).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { EmitirMensajeEntrada, MensajesHuespedSistemaRepository, MensajesHuespedStaffRepository } from "./repository.ts";
import { claveCatalogoPlantilla, eventoDeClaveCatalogo, type PlantillaWhatsappAprobada, type PlantillaWhatsappInput, type PlantillaWhatsappRecord } from "./plantillas.ts";
import {
  EVENTOS_MENSAJE_HUESPED,
  MensajesHuespedAccessDeniedError,
  MensajesHuespedUnavailableError,
  activoPorOmision,
  type CandidatoMensajeHuesped,
  type ConfigEventoHuesped,
  type EntradaConfigEvento,
  type EventoMensajeHuesped,
  type FilaHistorialMensaje,
  type ResultadoMensajes,
} from "./tipos.ts";

type Instante = Date | string;
const iso = (v: Instante): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const isoOrNull = (v: Instante | null): string | null => (v === null ? null : iso(v));
const sqlState = (err: unknown): string | undefined => (err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined);

/** Aviso estructurado SIN datos del huesped. */
function advertirNoMigrado(contexto: string, err: unknown): void {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "warn", evento: "mensajes_huesped_no_migrado", contexto, sqlstate: sqlState(err) ?? null }));
}

interface CandidatoRow {
  evento: EventoMensajeHuesped;
  ref_tipo: CandidatoMensajeHuesped["refTipo"];
  ref_id: string;
  organization_id: string;
  property_id: string;
  propiedad_nombre: string;
  org_slug: string;
  zona_horaria: string;
  huesped_nombre: string | null;
  telefono: string | null;
  correo: string | null;
  llegada: string;
  salida: string;
  total_centavos: string | number | null;
  vence_en: Instante | null;
  disparo_en: Instante;
  phone_number_id: string | null;
  whatsapp_habilitado: boolean;
  ultima_entrada_en: Instante | null;
  ventana_inicio: string;
  ventana_fin: string;
  resena_url: string | null;
  horas_antes: number | null;
}

export class PostgresMensajesHuespedSistemaRepository implements MensajesHuespedSistemaRepository {
  constructor(private readonly db: TenantDbSession) {}

  async listarCandidatos(ahora: Date, limite: number, opciones: { readonly propertyId?: string; readonly refId?: string } = {}): Promise<readonly CandidatoMensajeHuesped[]> {
    const { rows } = await this.db.query<CandidatoRow>(
      `select evento, ref_tipo, ref_id, organization_id, property_id, propiedad_nombre, org_slug, zona_horaria, huesped_nombre, telefono, correo,
              to_char(llegada, 'YYYY-MM-DD') as llegada, to_char(salida, 'YYYY-MM-DD') as salida, total_centavos, vence_en, disparo_en,
              phone_number_id, whatsapp_habilitado, ultima_entrada_en, ventana_inicio, ventana_fin, resena_url, horas_antes
         from hoteles.sistema_candidatos_mensajes_huesped($1::timestamptz, $2::int, $3::uuid, $4::uuid);`,
      [ahora.toISOString(), limite, opciones.propertyId ?? null, opciones.refId ?? null],
    );
    return rows.map((r) => ({
      evento: r.evento,
      refTipo: r.ref_tipo,
      refId: r.ref_id,
      organizationId: r.organization_id,
      propertyId: r.property_id,
      propiedadNombre: r.propiedad_nombre,
      orgSlug: r.org_slug,
      zonaHoraria: r.zona_horaria,
      huespedNombre: r.huesped_nombre,
      telefono: r.telefono,
      correo: r.correo,
      llegada: r.llegada,
      salida: r.salida,
      totalCentavos: r.total_centavos === null ? null : Number(r.total_centavos),
      venceEn: isoOrNull(r.vence_en),
      disparoEn: iso(r.disparo_en),
      phoneNumberId: r.phone_number_id,
      whatsappHabilitado: r.whatsapp_habilitado === true,
      ultimaEntradaEn: isoOrNull(r.ultima_entrada_en),
      ventanaInicio: r.ventana_inicio,
      ventanaFin: r.ventana_fin,
      resenaUrl: r.resena_url,
      horasAntes: r.horas_antes,
    }));
  }

  async resolverPlantilla(organizationId: string, evento: EventoMensajeHuesped): Promise<PlantillaWhatsappAprobada | null | undefined> {
    return runWithSavepointFallback<PlantillaWhatsappAprobada | null | undefined>({
      session: this.db,
      savepointName: "sp_hoteles_mh_plantilla_resolver",
      primary: async () => {
        const { rows } = await this.db.query<{ nombre: string; idioma: string; variables: string[] }>(`select nombre, idioma, variables from core.whatsapp_plantilla_resolver($1, $2);`, [organizationId, claveCatalogoPlantilla(evento)]);
        const row = rows[0];
        return row ? { name: row.nombre, language: row.idioma, variables: row.variables } : null;
      },
      // Catalogo (migracion 0050) pendiente: "no se puede saber" -> el mensaje sale por correo o queda no enviado, nunca un error.
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: (err) => {
        advertirNoMigrado("resolverPlantilla", err);
        return Promise.resolve(undefined);
      },
    });
  }

  async emitir(e: EmitirMensajeEntrada): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string | null }>(`select hoteles.sistema_emitir_mensaje_huesped($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9::jsonb) as id;`, [
      e.propertyId,
      e.evento,
      e.refTipo,
      e.refId,
      e.canal,
      e.motivo,
      e.eventType,
      e.dedupeKey,
      e.payload === null ? null : JSON.stringify(e.payload),
    ]);
    return rows[0]?.id ?? null;
  }

  async slugAviso(propertyId: string): Promise<string | null> {
    return runWithSavepointFallback<string | null>({
      session: this.db,
      savepointName: "sp_hoteles_mh_slug_aviso",
      primary: async () => {
        const { rows } = await this.db.query<{ slug: string | null }>(`select hoteles.sistema_slug_aviso($1::uuid) as slug;`, [propertyId]);
        return rows[0]?.slug ?? null;
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: (err) => {
        advertirNoMigrado("slugAviso", err);
        return Promise.resolve(null);
      },
    });
  }
}

interface ConfigRow {
  evento: EventoMensajeHuesped;
  activo: boolean;
  horas_antes: number | null;
  resena_url: string | null;
  actualizado_en: Instante;
}

interface HistorialRow {
  out_id: string;
  out_evento: EventoMensajeHuesped;
  out_ref_tipo: FilaHistorialMensaje["refTipo"];
  out_ref_id: string;
  out_estado: FilaHistorialMensaje["estado"];
  out_canal: FilaHistorialMensaje["canal"];
  out_motivo: FilaHistorialMensaje["motivo"];
  out_envio: string | null;
  out_error_clase: string | null;
  out_creado_en: Instante;
}

function configPorOmision(evento: EventoMensajeHuesped): ConfigEventoHuesped {
  return { evento, activo: activoPorOmision(evento), horasAntes: null, resenaUrl: null, configurada: false, actualizadoEn: null };
}

const aConfig = (r: ConfigRow): ConfigEventoHuesped => ({ evento: r.evento, activo: r.activo, horasAntes: r.horas_antes, resenaUrl: r.resena_url, configurada: true, actualizadoEn: iso(r.actualizado_en) });

export class PostgresMensajesHuespedStaffRepository implements MensajesHuespedStaffRepository {
  constructor(private readonly db: TenantDbSession) {}

  async listarConfig(propertyId: string): Promise<ResultadoMensajes<readonly ConfigEventoHuesped[]>> {
    return runWithSavepointFallback<ResultadoMensajes<readonly ConfigEventoHuesped[]>>({
      session: this.db,
      savepointName: "sp_hoteles_mh_config_listar",
      primary: async () => {
        const { rows } = await this.db.query<ConfigRow>(`select evento, activo, horas_antes, resena_url, actualizado_en from hoteles.mensaje_huesped_config where property_id = $1;`, [propertyId]);
        const porEvento = new Map(rows.map((r) => [r.evento, aConfig(r)] as const));
        return { disponible: true, valor: EVENTOS_MENSAJE_HUESPED.map((e) => porEvento.get(e) ?? configPorOmision(e)) };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: (err) => {
        advertirNoMigrado("listarConfig", err);
        return Promise.resolve({ disponible: false });
      },
    });
  }

  async guardarConfig(propertyId: string, evento: EventoMensajeHuesped, e: EntradaConfigEvento): Promise<ConfigEventoHuesped> {
    return runWithSavepointFallback<ConfigEventoHuesped>({
      session: this.db,
      savepointName: "sp_hoteles_mh_config_guardar",
      primary: async () => {
        // organization_id, autor y marcas de tiempo las pone el trigger; el GRANT de columna solo deja escribir estas.
        const { rows } = await this.db.query<ConfigRow>(
          `insert into hoteles.mensaje_huesped_config (property_id, evento, activo, horas_antes, resena_url)
           values ($1, $2, $3, $4, $5)
           on conflict (property_id, evento) do update set activo = excluded.activo, horas_antes = excluded.horas_antes, resena_url = excluded.resena_url
           returning evento, activo, horas_antes, resena_url, actualizado_en;`,
          [propertyId, evento, e.activo, e.horasAntes, e.resenaUrl],
        );
        return aConfig(rows[0] as ConfigRow);
      },
      isRecoverable: (err) => isMigrationPendingError(err) || sqlState(err) === "42501",
      fallback: (err) => {
        if (sqlState(err) === "42501") return Promise.reject(new MensajesHuespedAccessDeniedError());
        advertirNoMigrado("guardarConfig", err);
        return Promise.reject(new MensajesHuespedUnavailableError("configurar los mensajes automaticos"));
      },
    });
  }

  async historial(propertyId: string, limite: number): Promise<ResultadoMensajes<readonly FilaHistorialMensaje[]>> {
    return runWithSavepointFallback<ResultadoMensajes<readonly FilaHistorialMensaje[]>>({
      session: this.db,
      savepointName: "sp_hoteles_mh_historial",
      primary: async () => {
        const { rows } = await this.db.query<HistorialRow>(`select * from hoteles.historial_mensajes_huesped($1::uuid, $2::int);`, [propertyId, limite]);
        return {
          disponible: true,
          valor: rows.map((r) => ({ id: r.out_id, evento: r.out_evento, refTipo: r.out_ref_tipo, refId: r.out_ref_id, estado: r.out_estado, canal: r.out_canal, motivo: r.out_motivo, envio: r.out_envio, errorClase: r.out_error_clase, creadoEn: iso(r.out_creado_en) })),
        };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: (err) => {
        advertirNoMigrado("historial", err);
        return Promise.resolve({ disponible: false });
      },
    });
  }

  async listarPlantillas(organizationId: string): Promise<ResultadoMensajes<readonly PlantillaWhatsappRecord[]>> {
    return runWithSavepointFallback<ResultadoMensajes<readonly PlantillaWhatsappRecord[]>>({
      session: this.db,
      savepointName: "sp_hoteles_mh_plantillas_listar",
      primary: async () => {
        // La RLS de core.whatsapp_plantilla solo deja ver las filas a owner/admin de la organizacion: otro rol recibe una lista vacia.
        const { rows } = await this.db.query<{ evento: string; nombre: string; idioma: string; variables: string[]; estado: PlantillaWhatsappRecord["estado"]; aprobada_en: Instante | null; updated_at: Instante }>(
          `select evento, nombre, idioma, variables, estado, aprobada_en, updated_at from core.whatsapp_plantilla where organization_id = $1 and vertical = 'hoteles' order by evento;`,
          [organizationId],
        );
        const valor: PlantillaWhatsappRecord[] = [];
        for (const r of rows) {
          const evento = eventoDeClaveCatalogo(r.evento);
          if (evento) valor.push({ evento, nombre: r.nombre, idioma: r.idioma, variables: r.variables, estado: r.estado, aprobadaEn: isoOrNull(r.aprobada_en), actualizadaEn: iso(r.updated_at) });
        }
        return { disponible: true, valor };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: (err) => {
        advertirNoMigrado("listarPlantillas", err);
        return Promise.resolve({ disponible: false });
      },
    });
  }

  async guardarPlantilla(organizationId: string, evento: EventoMensajeHuesped, v: PlantillaWhatsappInput): Promise<"saved" | "forbidden" | "unavailable"> {
    return runWithSavepointFallback<"saved" | "forbidden" | "unavailable">({
      session: this.db,
      savepointName: "sp_hoteles_mh_plantilla_guardar",
      primary: async () => {
        // creado_por = auth.uid(): la policy de INSERT lo exige y solo un owner/admin de la organizacion pasa el WITH CHECK (42501 si no).
        await this.db.query(
          `insert into core.whatsapp_plantilla (organization_id, vertical, evento, nombre, idioma, variables, estado, creado_por)
           values ($1, 'hoteles', $2, $3, $4, $5::text[], $6, auth.uid())
           on conflict (organization_id, vertical, evento) do update set nombre = excluded.nombre, idioma = excluded.idioma, variables = excluded.variables, estado = excluded.estado;`,
          [organizationId, claveCatalogoPlantilla(evento), v.nombre, v.idioma, v.variables, v.estado],
        );
        return "saved";
      },
      isRecoverable: (err) => isMigrationPendingError(err) || sqlState(err) === "42501",
      fallback: (err) => {
        if (sqlState(err) === "42501") return Promise.resolve("forbidden");
        advertirNoMigrado("guardarPlantilla", err);
        return Promise.resolve("unavailable");
      },
    });
  }

  async eliminarPlantilla(organizationId: string, evento: EventoMensajeHuesped): Promise<"deleted" | "not_found" | "forbidden" | "unavailable"> {
    return runWithSavepointFallback<"deleted" | "not_found" | "forbidden" | "unavailable">({
      session: this.db,
      savepointName: "sp_hoteles_mh_plantilla_eliminar",
      primary: async () => {
        const { rows } = await this.db.query<{ id: string }>(`delete from core.whatsapp_plantilla where organization_id = $1 and vertical = 'hoteles' and evento = $2 returning id;`, [organizationId, claveCatalogoPlantilla(evento)]);
        return rows.length > 0 ? "deleted" : "not_found";
      },
      isRecoverable: (err) => isMigrationPendingError(err) || sqlState(err) === "42501",
      fallback: (err) => {
        if (sqlState(err) === "42501") return Promise.resolve("forbidden");
        advertirNoMigrado("eliminarPlantilla", err);
        return Promise.resolve("unavailable");
      },
    });
  }
}
