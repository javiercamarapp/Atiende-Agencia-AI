// emitirNotificacion -- UNICO punto de escritura de core.notification desde TypeScript. Llama a
// `core.emit_notification` (migracion 0039), que resuelve destinatarios, aplica dedupe, tope de volumen y
// retencion en la base. Este helper agrega lo que SQL no sabe: toma titulo/cuerpo/severidad/roles/enlace/
// vigencia del CATALOGO (nunca texto libre del llamador) y valida que los parametros no puedan colar PII.
//
// Contrato de seguridad y de compatibilidad:
//   * NUNCA lanza ni rompe el flujo de negocio que lo invoca: una notificacion es best-effort. Devuelve un
//     estado explicito.
//   * Base sin migrar (SQLSTATE 42883/42P01/42703): estado "no_disponible", sin error. El INSERT/SELECT
//     corre dentro de un SAVEPOINT (`runWithSavepointFallback`): en una transaccion compartida un error de
//     Postgres la deja abortada (25P02) y el COMMIT haria ROLLBACK de TODO lo escrito por el request; con
//     SAVEPOINT + ROLLBACK TO SAVEPOINT la sesion queda utilizable para lo que siga.
//   * Cualquier otro error de Postgres tambien se contiene dentro del SAVEPOINT y se reporta como "error".
//   * Sin PII: los parametros solo pueden ser numeros o codigos cortos (letras, digitos, `_ . : -`, sin
//     espacios); un nombre, correo, telefono con espacios o texto libre se rechaza antes de tocar la base.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { runWithSavepointFallback } from "../savepoint-fallback.ts";
import { isMigrationPendingError } from "../sql-errors.ts";
import { eventoPorId } from "./catalogo.ts";
import type { SeveridadNotificacion } from "./catalogo.ts";

export type ParametroNotificacion = string | number;

export interface EmitirNotificacionInput {
  /** Id del catalogo, p. ej. "hoteles.ticket.sla_vencido". */
  readonly evento: string;
  /** null solo para eventos de ambito superadmin (plataforma). */
  readonly organizationId: string | null;
  readonly propertyId?: string | null;
  /** Sufijo de dedupe (p. ej. el dia `2026-10-01` o el id de la entidad). La clave real es `<evento>:<clave>`. */
  readonly clave: string;
  readonly parametros?: Readonly<Record<string, ParametroNotificacion>>;
  readonly entidadTipo?: string | null;
  readonly entidadId?: string | null;
  /** Sube o baja la severidad del catalogo para ESTA emision (p. ej. una alerta con severidad propia). */
  readonly severidad?: SeveridadNotificacion;
}

export type EstadoEmision = "emitida" | "sin_nuevas" | "no_disponible" | "invalida" | "error";

export interface ResultadoEmision {
  readonly estado: EstadoEmision;
  /** Destinatarios nuevos. 0 = "sin_nuevas": ya existia (dedupe), no habia a quien notificar o se alcanzo el tope de volumen. */
  readonly destinatarios: number;
  readonly detalle?: string;
  /** Solo con `estado: "error"`: SQLSTATE del fallo (sin mensaje), para que quien llama decida si es transitorio y se reintenta. */
  readonly codigo?: string;
}

const PARAMETRO_CODIGO_RE = /^[A-Za-z0-9_.:-]{1,40}$/;
const CLAVE_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
/** Id de entidad admitido en el enlace (uuid o codigo corto): nada que pueda alterar la ruta (sin `/`, `?`, `#` ni espacios). */
const ENTIDAD_ENLACE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** El catalogo puede llevar `{entidadId}` en el enlace (p. ej. el detalle de un CFDI): se sustituye aqui, ANTES de la base, que solo
 *  resuelve `{orgSlug}`. Devuelve null si la plantilla lo pide y no hay un id valido: se rechaza la emision en vez de enlazar mal. */
function resolverEnlace(plantilla: string, entidadId: string | null | undefined): string | null {
  if (!plantilla.includes("{entidadId}")) return plantilla;
  if (!entidadId || !ENTIDAD_ENLACE_RE.test(entidadId)) return null;
  return plantilla.replaceAll("{entidadId}", entidadId);
}

function renderizar(plantilla: string, parametros: Readonly<Record<string, ParametroNotificacion>>, declarados: readonly string[]): string {
  return plantilla.replace(/\{(\w+)\}/g, (_m, nombre: string) => {
    if (!declarados.includes(nombre)) throw new Error(`parametro no declarado en el catalogo: ${nombre}`);
    const v = parametros[nombre];
    if (v === undefined) throw new Error(`falta el parametro ${nombre}`);
    return String(v);
  });
}

function validarParametros(parametros: Readonly<Record<string, ParametroNotificacion>>): void {
  for (const [nombre, valor] of Object.entries(parametros)) {
    if (typeof valor === "number") {
      if (!Number.isFinite(valor)) throw new Error(`parametro ${nombre}: numero no finito`);
    } else if (typeof valor !== "string" || !PARAMETRO_CODIGO_RE.test(valor)) {
      throw new Error(`parametro ${nombre}: solo numeros o codigos cortos sin espacios (sin PII)`);
    }
  }
}

function sqlstate(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

export async function emitirNotificacion(session: TenantDbSession, input: EmitirNotificacionInput): Promise<ResultadoEmision> {
  const evento = eventoPorId(input.evento);
  if (!evento) return { estado: "invalida", destinatarios: 0, detalle: `evento fuera del catalogo: ${input.evento}` };
  if ((evento.ambito === "superadmin") !== (input.organizationId === null)) {
    return { estado: "invalida", destinatarios: 0, detalle: "organizationId debe ser null solo en eventos de superadmin" };
  }
  if (!CLAVE_RE.test(input.clave)) return { estado: "invalida", destinatarios: 0, detalle: "clave de dedupe invalida" };

  const enlace = resolverEnlace(evento.enlace, input.entidadId);
  if (enlace === null) return { estado: "invalida", destinatarios: 0, detalle: "el enlace del evento requiere un entidadId valido" };

  let titulo: string;
  let cuerpo: string | null;
  try {
    const parametros = input.parametros ?? {};
    validarParametros(parametros);
    titulo = renderizar(evento.titulo, parametros, evento.parametros);
    cuerpo = evento.cuerpo === null ? null : renderizar(evento.cuerpo, parametros, evento.parametros);
  } catch (err) {
    return { estado: "invalida", destinatarios: 0, detalle: err instanceof Error ? err.message : String(err) };
  }

  try {
    const filas = await runWithSavepointFallback<number | null>({
      session,
      primary: async () => {
        const { rows } = await session.query<{ emit_notification: number }>(
          `select core.emit_notification($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11, $12::text[], make_interval(days => $13::int)) as emit_notification;`,
          [
            input.organizationId,
            input.propertyId ?? null,
            evento.id,
            evento.categoria,
            input.severidad ?? evento.severidad,
            titulo,
            cuerpo,
            enlace,
            input.entidadTipo ?? null,
            input.entidadId ?? null,
            `${evento.id}:${input.clave}`,
            evento.roles.length > 0 ? [...evento.roles] : null,
            evento.venceDias,
          ],
        );
        return rows[0]?.emit_notification ?? 0;
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => null,
    });
    if (filas === null) return { estado: "no_disponible", destinatarios: 0 };
    return filas > 0 ? { estado: "emitida", destinatarios: filas } : { estado: "sin_nuevas", destinatarios: 0 };
  } catch (err) {
    const code = sqlstate(err);
    return { estado: "error", destinatarios: 0, detalle: `${code ?? "sin_codigo"}: ${err instanceof Error ? err.message : String(err)}`, ...(code ? { codigo: code } : {}) };
  }
}
