// Puerto de lectura/escritura de los ajustes del agente por organizacion (migración 055) y su adaptador Postgres.
// REGLA DURA de compatibilidad con la base SIN migrar: mergear despliega el codigo y la migracion no se aplica sola. Toda operacion corre en la
// transaccion UNICA del request (o del turno de WhatsApp), donde un error de Postgres la deja abortada (25P02): por eso va con SAVEPOINT
// (`runWithSavepointFallback`). Lecturas -> `disponible: false` con los valores por omision (el agente se comporta exactamente como antes);
// escrituras -> `AjustesNoDisponiblesError` (503 honesto en la ruta).
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { AJUSTES_AGENTE_POR_DEFECTO } from "./ajustes.ts";
import type { AjustesAgente } from "./ajustes.ts";
import { esEstiloHabla, esPresetAmbiente, esRitmoHabla, esVolumenTecleo } from "@atiende/voice-core";

export interface LecturaAjustes {
  /** false = la base todavia no tiene la migración 055 (se devuelven los valores por omision). */
  readonly disponible: boolean;
  /** true = la organizacion ya guardo ajustes propios. */
  readonly configurados: boolean;
  readonly valor: AjustesAgente;
  readonly actualizadoEn: string | null;
  /** false = la base tiene la migración 055 pero NO la 087: ambiente con presets, tecleo y naturalidad no se pueden guardar ni leer (valores por omision). */
  readonly ambienteDisponible: boolean;
}

export class AjustesNoDisponiblesError extends Error {
  constructor(message = "Los ajustes del agente todavia no estan disponibles en esta base de datos.") {
    super(message);
    this.name = "AjustesNoDisponiblesError";
  }
}

export class AjustesRechazadosError extends Error {
  constructor(message = "No tienes permiso para cambiar los ajustes del agente de esta organizacion.") {
    super(message);
    this.name = "AjustesRechazadosError";
  }
}

export interface AjustesAgenteRepository {
  leer(organizationId: string): Promise<LecturaAjustes>;
  /** Reemplaza los ajustes completos (ya validados). Lanza `AjustesNoDisponiblesError` en una base sin migrar y `AjustesRechazadosError` si la base niega el permiso. */
  guardar(organizationId: string, actorUserId: string, ajustes: AjustesAgente): Promise<LecturaAjustes>;
}

export const LECTURA_AJUSTES_POR_OMISION: LecturaAjustes = Object.freeze({ disponible: false, configurados: false, valor: AJUSTES_AGENTE_POR_DEFECTO, actualizadoEn: null, ambienteDisponible: false });

function code(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}
/** Tabla, columna o funcion de la migración 055 inexistente. */
const esBaseSinMigrar = (err: unknown): boolean => ["42P01", "42703", "42883"].includes(code(err) ?? "");
/** Ademas de "sin migrar": 42501 (RLS/permiso denegado) es un rechazo conocido. */
const esErrorEscrituraConocido = (err: unknown): boolean => esBaseSinMigrar(err) || code(err) === "42501";

interface FilaAjustes {
  whatsapp_model: string | null;
  whatsapp_temperature: string | number | null;
  voice_cascade_model: string | null;
  voice_temperature: string | number | null;
  voice_pace: string;
  voice_style: string;
  voice_background: boolean;
  voice_background_volume: number;
  voice_background_preset?: string;
  voice_typing?: boolean;
  voice_typing_volume?: number;
  voice_humanize?: boolean;
  updated_at: Date | string;
}

const COLUMNAS_BASE = "whatsapp_model, whatsapp_temperature, voice_cascade_model, voice_temperature, voice_pace, voice_style, voice_background, voice_background_volume";
/** Columnas de la migración 087 (ambiente con presets, tecleo y naturalidad). En una base con la 055 pero sin la 087 se lee y escribe solo lo anterior. */
const COLUMNAS_087 = "voice_background_preset, voice_typing, voice_typing_volume, voice_humanize";
const COLUMNAS = `${COLUMNAS_BASE}, ${COLUMNAS_087}, updated_at`;
const COLUMNAS_SIN_087 = `${COLUMNAS_BASE}, updated_at`;

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

export function ajustesDeFila(f: FilaAjustes): AjustesAgente {
  return {
    whatsappModelo: f.whatsapp_model,
    whatsappTemperatura: num(f.whatsapp_temperature),
    vozModeloCascada: f.voice_cascade_model,
    vozTemperatura: num(f.voice_temperature),
    // Una fila escrita directo en la base con un valor fuera de la lista no rompe al agente: cae al valor por omision.
    vozRitmo: esRitmoHabla(f.voice_pace) ? f.voice_pace : AJUSTES_AGENTE_POR_DEFECTO.vozRitmo,
    vozEstilo: esEstiloHabla(f.voice_style) ? f.voice_style : AJUSTES_AGENTE_POR_DEFECTO.vozEstilo,
    vozFondoActivo: f.voice_background === true,
    vozFondoVolumen: f.voice_background_volume,
    // Una fila leida SIN las columnas de la 087 (base sin esa migración) o con un valor fuera de lista cae al valor por omision.
    vozFondoPreset: esPresetAmbiente(f.voice_background_preset) ? f.voice_background_preset : AJUSTES_AGENTE_POR_DEFECTO.vozFondoPreset,
    vozTecleoActivo: f.voice_typing === true,
    vozTecleoVolumen: esVolumenTecleo(f.voice_typing_volume) ? f.voice_typing_volume : AJUSTES_AGENTE_POR_DEFECTO.vozTecleoVolumen,
    vozHumanizar: f.voice_humanize === true,
  };
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

let advertido = false;
function advertirNoDisponible(err: unknown): void {
  if (advertido) return;
  advertido = true;
  console.warn(
    "PostgresAjustesAgenteRepository: la tabla de ajustes del agente todavia no existe en esta base (SQLSTATE 42P01/42703/42883) -- " +
      "aplica packages/domain-restaurantes/migrations/055_ajustes_agente_modelo_voz_fondo.sql y, para ambiente/tecleo/naturalidad, 087_ajustes_agente_ambiente_tecleo_humano.sql (o sus espejos en supabase/migrations/). El agente sigue con los valores de siempre.",
    err,
  );
}

export class PostgresAjustesAgenteRepository implements AjustesAgenteRepository {
  constructor(private readonly db: TenantDbSession) {}

  async leer(organizationId: string): Promise<LecturaAjustes> {
    return runWithSavepointFallback<LecturaAjustes>({
      session: this.db,
      savepointName: "sp_ajustes_agente_read",
      primary: async () => {
        const { rows } = await this.db.query<FilaAjustes>(`select ${COLUMNAS} from restaurantes.agent_runtime_settings where organization_id = $1;`, [organizationId]);
        const f = rows[0];
        return f
          ? { disponible: true, configurados: true, valor: ajustesDeFila(f), actualizadoEn: iso(f.updated_at), ambienteDisponible: true }
          : { disponible: true, configurados: false, valor: AJUSTES_AGENTE_POR_DEFECTO, actualizadoEn: null, ambienteDisponible: true };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async (err) => {
        // Primero la base con la 055 pero SIN la 087: se leen los ajustes de siempre y lo nuevo queda en sus valores por omision.
        return runWithSavepointFallback<LecturaAjustes>({
          session: this.db,
          savepointName: "sp_ajustes_agente_read_sin_087",
          primary: async () => {
            const { rows } = await this.db.query<FilaAjustes>(`select ${COLUMNAS_SIN_087} from restaurantes.agent_runtime_settings where organization_id = $1;`, [organizationId]);
            const f = rows[0];
            return f
              ? { disponible: true, configurados: true, valor: ajustesDeFila(f), actualizadoEn: iso(f.updated_at), ambienteDisponible: false }
              : { disponible: true, configurados: false, valor: AJUSTES_AGENTE_POR_DEFECTO, actualizadoEn: null, ambienteDisponible: false };
          },
          isRecoverable: esBaseSinMigrar,
          fallback: async (err2) => {
            advertirNoDisponible(err2 ?? err);
            return LECTURA_AJUSTES_POR_OMISION;
          },
        });
      },
    });
  }

  async guardar(organizationId: string, actorUserId: string, a: AjustesAgente): Promise<LecturaAjustes> {
    return runWithSavepointFallback<LecturaAjustes>({
      session: this.db,
      savepointName: "sp_ajustes_agente_write",
      primary: async () => {
        const { rows } = await this.db.query<FilaAjustes>(
          `insert into restaurantes.agent_runtime_settings
             (organization_id, whatsapp_model, whatsapp_temperature, voice_cascade_model, voice_temperature, voice_pace, voice_style, voice_background, voice_background_volume,
              voice_background_preset, voice_typing, voice_typing_volume, voice_humanize, updated_by, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
           on conflict (organization_id) do update set
             whatsapp_model = excluded.whatsapp_model,
             whatsapp_temperature = excluded.whatsapp_temperature,
             voice_cascade_model = excluded.voice_cascade_model,
             voice_temperature = excluded.voice_temperature,
             voice_pace = excluded.voice_pace,
             voice_style = excluded.voice_style,
             voice_background = excluded.voice_background,
             voice_background_volume = excluded.voice_background_volume,
             voice_background_preset = excluded.voice_background_preset,
             voice_typing = excluded.voice_typing,
             voice_typing_volume = excluded.voice_typing_volume,
             voice_humanize = excluded.voice_humanize,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at
           returning ${COLUMNAS};`,
          [organizationId, a.whatsappModelo, a.whatsappTemperatura, a.vozModeloCascada, a.vozTemperatura, a.vozRitmo, a.vozEstilo, a.vozFondoActivo, a.vozFondoVolumen, a.vozFondoPreset, a.vozTecleoActivo, a.vozTecleoVolumen, a.vozHumanizar, actorUserId],
        );
        const f = rows[0]!;
        return { disponible: true, configurados: true, valor: ajustesDeFila(f), actualizadoEn: iso(f.updated_at), ambienteDisponible: true };
      },
      isRecoverable: esErrorEscrituraConocido,
      fallback: async (err) => {
        if (code(err) === "42501") throw new AjustesRechazadosError();
        // Base con la 055 pero SIN la 087: lo de siempre se guarda; si el cliente pidio algo de lo nuevo (distinto del valor por omision) se dice la verdad (503) en vez de perderlo en silencio.
        const pideLoNuevo =
          a.vozFondoPreset !== AJUSTES_AGENTE_POR_DEFECTO.vozFondoPreset || a.vozTecleoActivo !== AJUSTES_AGENTE_POR_DEFECTO.vozTecleoActivo || a.vozTecleoVolumen !== AJUSTES_AGENTE_POR_DEFECTO.vozTecleoVolumen || a.vozHumanizar !== AJUSTES_AGENTE_POR_DEFECTO.vozHumanizar;
        if (code(err) !== "42703" || pideLoNuevo) {
          advertirNoDisponible(err);
          throw new AjustesNoDisponiblesError(pideLoNuevo && code(err) === "42703" ? "El ambiente con presets, el tecleo y la naturalidad requieren aplicar la migración 087 (ajustes del agente); el resto de los ajustes no cambió." : undefined);
        }
        return runWithSavepointFallback<LecturaAjustes>({
          session: this.db,
          savepointName: "sp_ajustes_agente_write_sin_087",
          primary: async () => {
            const { rows } = await this.db.query<FilaAjustes>(
              `insert into restaurantes.agent_runtime_settings
                 (organization_id, whatsapp_model, whatsapp_temperature, voice_cascade_model, voice_temperature, voice_pace, voice_style, voice_background, voice_background_volume, updated_by, updated_at)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
               on conflict (organization_id) do update set
                 whatsapp_model = excluded.whatsapp_model, whatsapp_temperature = excluded.whatsapp_temperature, voice_cascade_model = excluded.voice_cascade_model,
                 voice_temperature = excluded.voice_temperature, voice_pace = excluded.voice_pace, voice_style = excluded.voice_style,
                 voice_background = excluded.voice_background, voice_background_volume = excluded.voice_background_volume,
                 updated_by = excluded.updated_by, updated_at = excluded.updated_at
               returning ${COLUMNAS_SIN_087};`,
              [organizationId, a.whatsappModelo, a.whatsappTemperatura, a.vozModeloCascada, a.vozTemperatura, a.vozRitmo, a.vozEstilo, a.vozFondoActivo, a.vozFondoVolumen, actorUserId],
            );
            const f = rows[0]!;
            return { disponible: true, configurados: true, valor: ajustesDeFila(f), actualizadoEn: iso(f.updated_at), ambienteDisponible: false };
          },
          isRecoverable: esErrorEscrituraConocido,
          fallback: async (err2) => {
            if (esBaseSinMigrar(err2)) {
              advertirNoDisponible(err2);
              throw new AjustesNoDisponiblesError();
            }
            throw new AjustesRechazadosError();
          },
        });
      },
    });
  }
}

/** Adaptador en memoria para pruebas de rutas. `migrada = false` simula la base sin la migración 055; `rechazar` simula que RLS niega la escritura. */
export class InMemoryAjustesAgenteRepository implements AjustesAgenteRepository {
  migrada = true;
  /** false = base con la 055 pero sin la 087. */
  ambienteMigrado = true;
  rechazar = false;
  private readonly filas = new Map<string, { valor: AjustesAgente; actualizadoEn: string; actor: string }>();
  readonly escrituras: { organizationId: string; actorUserId: string; ajustes: AjustesAgente }[] = [];

  async leer(organizationId: string): Promise<LecturaAjustes> {
    if (!this.migrada) return LECTURA_AJUSTES_POR_OMISION;
    const f = this.filas.get(organizationId);
    return f ? { disponible: true, configurados: true, valor: f.valor, actualizadoEn: f.actualizadoEn, ambienteDisponible: this.ambienteMigrado } : { disponible: true, configurados: false, valor: AJUSTES_AGENTE_POR_DEFECTO, actualizadoEn: null, ambienteDisponible: this.ambienteMigrado };
  }

  async guardar(organizationId: string, actorUserId: string, ajustes: AjustesAgente): Promise<LecturaAjustes> {
    if (!this.migrada) throw new AjustesNoDisponiblesError();
    if (this.rechazar) throw new AjustesRechazadosError();
    if (!this.ambienteMigrado && (ajustes.vozFondoPreset !== AJUSTES_AGENTE_POR_DEFECTO.vozFondoPreset || ajustes.vozTecleoActivo || ajustes.vozHumanizar || ajustes.vozTecleoVolumen !== AJUSTES_AGENTE_POR_DEFECTO.vozTecleoVolumen)) throw new AjustesNoDisponiblesError();
    const actualizadoEn = new Date().toISOString();
    this.filas.set(organizationId, { valor: ajustes, actualizadoEn, actor: actorUserId });
    this.escrituras.push({ organizationId, actorUserId, ajustes });
    return { disponible: true, configurados: true, valor: ajustes, actualizadoEn, ambienteDisponible: this.ambienteMigrado };
  }
}
