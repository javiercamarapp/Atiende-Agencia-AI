// Acceso SQL a las credenciales de Meta por organizacion (migracion 0090). Esta capa no elige la sesion: la lectura de sistema
// corre en `withAppSession({ userId: null })` y lo del superadmin en `withAppSession({ userId: callerId })` (caller-binding en SQL).
// Base sin migrar (42P01/42883/42703): lectura de sistema -> lista vacia (todo sigue con la plataforma); superadmin -> `no_migrada`.
// Cada llamada corre en SAVEPOINT (`runWithSavepointFallback`), asi un error nunca aborta la transaccion de quien llama.
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { FilaCredencialSistema } from "./resolutor.ts";

const SQLSTATE_NO_MIGRADO = new Set(["42P01", "42883", "42703"]);

export function esCredencialesMetaNoMigrada(err: unknown): boolean {
  const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && SQLSTATE_NO_MIGRADO.has(code);
}

function avisarNoMigrada(contexto: string): void {
  console.warn(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      evento: "whatsapp_meta_credenciales_no_migrada",
      contexto,
    }),
  );
}

const ms = (v: Date | string | null): number | null => (v === null ? null : new Date(v).getTime());

export async function leerCredencialesParaSistema(db: TenantDbSession): Promise<readonly FilaCredencialSistema[]> {
  return runWithSavepointFallback<readonly FilaCredencialSistema[]>({
    session: db,
    savepointName: "sp_whatsapp_meta_sistema",
    primary: async () => {
      const { rows } = await db.query<FilaCredencialSistema>(
        "select id, organization_id, app_id, waba_id, app_secret_cifrado, access_token_cifrado, verify_token_hash, phone_number_ids from core.whatsapp_meta_credenciales_para_sistema();",
      );
      return rows.map((r) => ({
        ...r,
        phone_number_ids: r.phone_number_ids ?? [],
      }));
    },
    isRecoverable: esCredencialesMetaNoMigrada,
    fallback: async () => {
      avisarNoMigrada("credenciales_para_sistema");
      return [];
    },
  });
}

export interface CredencialMetaResumen {
  readonly id: string;
  readonly etiqueta: string;
  readonly appId: string;
  readonly wabaId: string;
  readonly tieneVerifyToken: boolean;
  readonly activa: boolean;
  readonly creadaEnMs: number | null;
  readonly secretoRotadoEnMs: number | null;
  readonly tokenRotadoEnMs: number | null;
  readonly actualizadaEnMs: number | null;
  readonly revocadaEnMs: number | null;
  readonly numeros: number;
}

export interface NumeroMetaResumen {
  readonly propertyId: string | null;
  readonly propertyNombre: string | null;
  readonly propertyEstado: string | null;
  readonly phoneNumberId: string | null;
  readonly credencialId: string | null;
  readonly origen: "sucursal" | "organizacion" | "credencial";
}

export type LecturaSuperadmin =
  | {
      readonly disponible: true;
      readonly credenciales: readonly CredencialMetaResumen[];
      readonly numeros: readonly NumeroMetaResumen[];
    }
  | { readonly disponible: false };

export async function listarParaSuperadmin(db: TenantDbSession, callerId: string, organizationId: string): Promise<LecturaSuperadmin> {
  return runWithSavepointFallback<LecturaSuperadmin>({
    session: db,
    savepointName: "sp_whatsapp_meta_listar",
    primary: async () => {
      const cred = await db.query<{
        id: string;
        etiqueta: string;
        app_id: string;
        waba_id: string;
        tiene_verify_token: boolean;
        activa: boolean;
        creada_en: Date | string | null;
        secreto_rotado_en: Date | string | null;
        token_rotado_en: Date | string | null;
        actualizada_en: Date | string | null;
        revocada_en: Date | string | null;
        numeros: number;
      }>(
        "select id, etiqueta, app_id, waba_id, tiene_verify_token, activa, creada_en, secreto_rotado_en, token_rotado_en, actualizada_en, revocada_en, numeros from core.whatsapp_meta_listar_credenciales($1, $2);",
        [callerId, organizationId],
      );
      const nums = await db.query<{
        property_id: string | null;
        property_nombre: string | null;
        property_estado: string | null;
        phone_number_id: string | null;
        credencial_id: string | null;
        origen: NumeroMetaResumen["origen"];
      }>("select property_id, property_nombre, property_estado, phone_number_id, credencial_id, origen from core.whatsapp_meta_listar_numeros($1, $2);", [
        callerId,
        organizationId,
      ]);
      return {
        disponible: true as const,
        credenciales: cred.rows.map((r) => ({
          id: r.id,
          etiqueta: r.etiqueta,
          appId: r.app_id,
          wabaId: r.waba_id,
          tieneVerifyToken: r.tiene_verify_token,
          activa: r.activa,
          creadaEnMs: ms(r.creada_en),
          secretoRotadoEnMs: ms(r.secreto_rotado_en),
          tokenRotadoEnMs: ms(r.token_rotado_en),
          actualizadaEnMs: ms(r.actualizada_en),
          revocadaEnMs: ms(r.revocada_en),
          numeros: Number(r.numeros),
        })),
        numeros: nums.rows.map((r) => ({
          propertyId: r.property_id,
          propertyNombre: r.property_nombre,
          propertyEstado: r.property_estado,
          phoneNumberId: r.phone_number_id,
          credencialId: r.credencial_id,
          origen: r.origen,
        })),
      };
    },
    isRecoverable: esCredencialesMetaNoMigrada,
    fallback: async () => {
      avisarNoMigrada("listar_para_superadmin");
      return { disponible: false as const };
    },
  });
}

/** Resultado de una escritura: `ok`, `no_migrada` o el SQLSTATE de negocio que la funcion lanzo (la ruta lo traduce). */
export type ResultadoEscritura<T = void> =
  { readonly estado: "ok"; readonly valor: T } | { readonly estado: "no_migrada" } | { readonly estado: "rechazada"; readonly sqlstate: string };

async function escribir<T>(
  db: TenantDbSession,
  nombre: string,
  sql: string,
  params: readonly unknown[],
  leer: (rows: readonly Record<string, unknown>[]) => T,
): Promise<ResultadoEscritura<T>> {
  return runWithSavepointFallback<ResultadoEscritura<T>>({
    session: db,
    savepointName: `sp_whatsapp_meta_${nombre}`,
    primary: async () => {
      const { rows } = await db.query<Record<string, unknown>>(sql, [...params]);
      return { estado: "ok" as const, valor: leer(rows) };
    },
    isRecoverable: (err) => esCredencialesMetaNoMigrada(err) || esRechazoDeNegocio(err),
    fallback: async (err) => {
      if (esCredencialesMetaNoMigrada(err)) {
        avisarNoMigrada(nombre);
        return { estado: "no_migrada" as const };
      }
      return {
        estado: "rechazada" as const,
        sqlstate: String((err as { code?: unknown }).code),
      };
    },
  });
}

/** SQLSTATE que las funciones de la 0090 lanzan a proposito (validacion, permiso, no existe, duplicado, check). */
const SQLSTATE_NEGOCIO = new Set(["22023", "42501", "P0002", "23505", "23514", "23503"]);
function esRechazoDeNegocio(err: unknown): boolean {
  const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && SQLSTATE_NEGOCIO.has(code);
}

export function registrarCredencial(
  db: TenantDbSession,
  p: {
    callerId: string;
    credencialId: string;
    organizationId: string;
    etiqueta: string;
    appId: string;
    wabaId: string;
    appSecretCifrado: string;
    accessTokenCifrado: string;
    verifyTokenHash: string | null;
  },
): Promise<ResultadoEscritura> {
  return escribir(
    db,
    "registrar",
    "select core.whatsapp_meta_registrar_credencial($1, $2, $3, $4, $5, $6, $7, $8, $9);",
    [p.callerId, p.credencialId, p.organizationId, p.etiqueta, p.appId, p.wabaId, p.appSecretCifrado, p.accessTokenCifrado, p.verifyTokenHash],
    () => undefined,
  );
}

export function rotarCredencial(
  db: TenantDbSession,
  p: {
    callerId: string;
    credencialId: string;
    organizationId: string;
    etiqueta: string | null;
    appSecretCifrado: string | null;
    accessTokenCifrado: string | null;
    verifyTokenHash: string | null;
    quitarVerifyToken: boolean;
  },
): Promise<ResultadoEscritura> {
  return escribir(
    db,
    "rotar",
    "select core.whatsapp_meta_rotar_credencial($1, $2, $3, $4, $5, $6, $7, $8);",
    [p.callerId, p.credencialId, p.organizationId, p.etiqueta, p.appSecretCifrado, p.accessTokenCifrado, p.verifyTokenHash, p.quitarVerifyToken],
    () => undefined,
  );
}

export function revocarCredencial(
  db: TenantDbSession,
  p: {
    callerId: string;
    credencialId: string;
    organizationId: string;
    motivo: string;
  },
): Promise<ResultadoEscritura<number>> {
  return escribir(
    db,
    "revocar",
    "select core.whatsapp_meta_revocar_credencial($1, $2, $3, $4) as liberados;",
    [p.callerId, p.credencialId, p.organizationId, p.motivo],
    (rows) => Number(rows[0]?.liberados ?? 0),
  );
}

export function asignarNumero(
  db: TenantDbSession,
  p: {
    callerId: string;
    organizationId: string;
    phoneNumberId: string;
    credencialId: string | null;
    propertyId: string | null;
  },
): Promise<ResultadoEscritura> {
  return escribir(
    db,
    "asignar",
    "select core.whatsapp_meta_asignar_numero($1, $2, $3, $4, $5);",
    [p.callerId, p.organizationId, p.phoneNumberId, p.credencialId, p.propertyId],
    () => undefined,
  );
}
