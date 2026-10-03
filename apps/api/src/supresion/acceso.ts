// Acceso a core.supresion_contacto (SA-L-46) desde el API. Ver docs/SUPRESION.md.
//
// FAIL-CLOSED: `crearGuardSupresion` devuelve una funcion que LANZA ante cualquier error de lectura que no
// sea "migracion pendiente"; el despachador interpreta el error como "no se puede verificar -> no se
// contacta". UNICA excepcion documentada: SQLSTATE 42P01/42883/42703 (la tabla o las funciones aun no
// existen porque falta el `db push`): se loguea `supresion_no_migrada` y se permite el envio, para no
// detener los avisos entre el deploy y la migracion.
//
// TRANSACCIONES: la sesion del despachador es UNA transaccion; un error de Postgres la deja abortada. Todo
// acceso corre dentro de `runWithSavepointFallback` (SAVEPOINT / ROLLBACK TO SAVEPOINT).
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { hashearContacto } from "./normalizar.ts";
import type { TipoContacto } from "./normalizar.ts";

export type MotivoSupresion = "baja" | "queja" | "rebote" | "solicitud_arco" | "no_contactar";

const SQLSTATE_NO_MIGRADO = new Set(["42P01", "42883", "42703"]);

/** `true` si el error es "tabla/funcion/columna inexistente" (migracion 0043 pendiente). */
export function esSupresionNoMigrada(err: unknown): boolean {
  const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && SQLSTATE_NO_MIGRADO.has(code);
}

/** Aviso estructurado SIN valores del contacto. */
export function avisarSupresionNoMigrada(contexto: string): void {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "warn", evento: "supresion_no_migrada", contexto }));
}

/** Funcion que decide si un destino esta suprimido: `true` = NO contactar. Lanza si no puede verificarlo. */
export type GuardSupresion = (tipo: TipoContacto, valor: string) => Promise<boolean>;

export function crearGuardSupresion(db: TenantDbSession): GuardSupresion {
  return async (tipo, valor) => {
    const hash = hashearContacto(tipo, valor);
    // Un destino que no se puede interpretar como telefono/correo no se puede comparar contra la lista:
    // sigue el camino anterior (el proveedor lo rechazara como invalido). No es un fallo de lectura.
    if (hash === null) return false;
    return runWithSavepointFallback<boolean>({
      session: db,
      primary: async () => {
        const { rows } = await db.query<{ suprimido: boolean }>("select core.esta_suprimido($1, $2) as suprimido;", [tipo, hash]);
        return rows[0]?.suprimido === true;
      },
      isRecoverable: esSupresionNoMigrada,
      fallback: async () => {
        avisarSupresionNoMigrada("esta_suprimido");
        return false;
      },
    });
  };
}

export type ResultadoRegistro = "registrada" | "ya_existia" | "no_migrada" | "valor_invalido";

/** Registra una supresion (idempotente). `no_migrada` = la base aun no tiene la migracion 0043. */
export async function registrarSupresion(
  db: TenantDbSession,
  input: { readonly tipo: TipoContacto; readonly valor: string; readonly motivo: MotivoSupresion; readonly origen: string; readonly organizationId?: string | null },
): Promise<ResultadoRegistro> {
  const hash = hashearContacto(input.tipo, input.valor);
  if (hash === null) return "valor_invalido";
  return runWithSavepointFallback<ResultadoRegistro>({
    session: db,
    primary: async () => {
      const { rows } = await db.query<{ nueva: boolean }>("select core.registrar_supresion($1, $2, $3, $4, $5) as nueva;", [input.tipo, hash, input.motivo, input.origen, input.organizationId ?? null]);
      return rows[0]?.nueva === true ? "registrada" : "ya_existia";
    },
    isRecoverable: esSupresionNoMigrada,
    fallback: async () => {
      avisarSupresionNoMigrada("registrar_supresion");
      return "no_migrada";
    },
  });
}

export type ResultadoReactivacion = "reactivada" | "sin_baja" | "no_migrada" | "valor_invalido";

/** ALTA (PL-32): quita SOLO la baja voluntaria (motivo `baja`) del contacto; quejas, rebotes, ARCO y "no contactar" no se revierten
 *  por mensaje. `no_migrada` = la base aun no tiene la migracion 0048 (la ALTA cae al camino anterior: el texto sigue al agente). */
export async function reactivarSupresionBaja(db: TenantDbSession, input: { readonly tipo: TipoContacto; readonly valor: string }): Promise<ResultadoReactivacion> {
  const hash = hashearContacto(input.tipo, input.valor);
  if (hash === null) return "valor_invalido";
  return runWithSavepointFallback<ResultadoReactivacion>({
    session: db,
    primary: async () => {
      const { rows } = await db.query<{ quitada: boolean }>("select core.reactivar_supresion_baja($1, $2) as quitada;", [input.tipo, hash]);
      return rows[0]?.quitada === true ? "reactivada" : "sin_baja";
    },
    isRecoverable: esSupresionNoMigrada,
    fallback: async () => {
      avisarSupresionNoMigrada("reactivar_supresion_baja");
      return "no_migrada";
    },
  });
}

/** Guard de correo para `dispatchPendingEmailJobs` de las 6 verticales (`true` = NO contactar). */
export function crearGuardCorreo(db: TenantDbSession): (correo: string) => Promise<boolean> {
  const guard = crearGuardSupresion(db);
  return (correo) => guard("correo", correo);
}

/** Guard de telefono para `WhatsAppOutboundDispatcher.dispatchPending` (`true` = NO contactar). */
export function crearGuardTelefono(db: TenantDbSession): (telefono: string) => Promise<boolean> {
  const guard = crearGuardSupresion(db);
  return (telefono) => guard("telefono", telefono);
}
