// R-16 -- preferencias de AVISOS del staff de restaurantes (migracion 043). Acceso SQL en un modulo propio (no
// engorda postgres-repository.ts): cada funcion recibe la sesion del request (la del usuario autenticado, con su
// `auth.uid()` real) y llama a las funciones `security definer` de la migracion, que son quienes autorizan.
//
// Que se puede apagar: SOLO los tipos de `EVENTOS_AVISO` (todos con productor conectado en el catalogo de
// notificaciones, ver `avisos-preferencias.spec.ts`). Sin fila = encendido (default de owner/admin/staff).
//
// Base sin migrar (SQLSTATE 42883/42P01/42703): las lecturas devuelven `disponible: false` (la UI muestra un estado
// honesto, nunca un 500) y las escrituras lanzan `AvisosNoDisponiblesError` (la ruta responde 503). Todo corre dentro
// de un SAVEPOINT (`runWithSavepointFallback`): la sesion del request es UNA sola transaccion y un error de Postgres
// la dejaria abortada para lo que siga.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";

export interface EventoAviso {
  readonly tipo: string;
  readonly etiqueta: string;
  readonly descripcion: string;
  /** `true` solo si el navegador reproduce un sonido real para este aviso (hoy: el sondeo de pedidos nuevos). */
  readonly sonidoAplica: boolean;
}

/** Avisos que cada persona puede apagar. Cada `tipo` es un id del catalogo de notificaciones (@atiende/db). */
export const EVENTOS_AVISO: readonly EventoAviso[] = [
  { tipo: "restaurantes.pedido.nuevo", etiqueta: "Pedido nuevo", descripcion: "Entra un pedido por WhatsApp o voz.", sonidoAplica: true },
  { tipo: "restaurantes.handoff.solicitado", etiqueta: "Cliente pide a una persona", descripcion: "El agente deriva una conversación a atención humana.", sonidoAplica: false },
  { tipo: "restaurantes.callback.pendiente", etiqueta: "Devolver llamada", descripcion: "Un cliente dejó su contacto para que le devuelvan la llamada.", sonidoAplica: false },
  { tipo: "restaurantes.pedido.entrega_tardia", etiqueta: "Entrega tardía", descripcion: "Un pedido pasó de su hora prometida y sigue sin entregarse.", sonidoAplica: false },
  { tipo: "restaurantes.pedido.programado_por_vencer", etiqueta: "Programado por vencer", descripcion: "Un pedido programado está por llegar a su hora sin estar listo o sin repartidor.", sonidoAplica: false },
  { tipo: "restaurantes.pedido.incidencia_repartidor", etiqueta: "Incidencia del repartidor", descripcion: "Un repartidor marcó un problema con un pedido.", sonidoAplica: false },
  { tipo: "restaurantes.voz.llamada_escalada", etiqueta: "Llamada escalada", descripcion: "El agente de voz pasó una llamada a una persona.", sonidoAplica: false },
];

export const TIPOS_AVISO: ReadonlySet<string> = new Set(EVENTOS_AVISO.map((e) => e.tipo));

/** Minutos de gracia por defecto de la alerta de entrega tardia cuando la sucursal no configuro uno (misma constante que la migracion 043). */
export const UMBRAL_ENTREGA_TARDIA_DEFECTO_MIN = 45;
export const UMBRAL_ENTREGA_TARDIA_MIN = 10;
export const UMBRAL_ENTREGA_TARDIA_MAX = 240;

export interface PreferenciaAviso {
  readonly userId: string;
  readonly tipo: string;
  readonly enabled: boolean;
  readonly sonido: boolean;
}

export interface UmbralSucursal {
  readonly propertyId: string;
  readonly nombre: string;
  /** `null` = sin configurar (se usa `UMBRAL_ENTREGA_TARDIA_DEFECTO_MIN`). */
  readonly entregaTardiaMin: number | null;
}

/** La base aun no tiene la migracion 043: la escritura no se puede aplicar (la ruta responde 503). */
export class AvisosNoDisponiblesError extends Error {
  constructor() {
    super("Los avisos por persona aún no están disponibles en esta base de datos.");
    this.name = "AvisosNoDisponiblesError";
  }
}
/** El usuario no tiene permiso para esa preferencia/umbral (owner/admin editan las de su equipo; cada quien las suyas). */
export class AvisosPermisoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvisosPermisoError";
  }
}
/** Dato invalido (tipo fuera de catalogo, minutos fuera de rango). */
export class AvisosValidacionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvisosValidacionError";
  }
}

function sqlstate(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

function traducir(err: unknown): never {
  const code = sqlstate(err);
  const mensaje = err instanceof Error ? err.message : String(err);
  if (code === "42501") throw new AvisosPermisoError(mensaje.replace(/^[a-z_]+: /, ""));
  if (code === "22023") throw new AvisosValidacionError(mensaje.replace(/^[a-z_]+: /, ""));
  throw err;
}

/** Preferencias guardadas (solo las que se apartan del default). `todos: true` exige owner/admin (el equipo completo). */
export async function listarPreferenciasAvisos(
  session: TenantDbSession,
  organizationId: string,
  options: { readonly todos?: boolean } = {},
): Promise<{ readonly disponible: boolean; readonly filas: readonly PreferenciaAviso[] }> {
  try {
    return await runWithSavepointFallback<{ readonly disponible: boolean; readonly filas: readonly PreferenciaAviso[] }>({
      session,
      primary: async () => {
        const { rows } = await session.query<{ user_id: string; tipo: string; enabled: boolean; sonido: boolean }>(
          `select user_id, tipo, enabled, sonido from core.list_notification_preferences($1::uuid, $2::boolean);`,
          [organizationId, options.todos === true],
        );
        return {
          disponible: true,
          filas: rows.filter((r) => TIPOS_AVISO.has(r.tipo)).map((r) => ({ userId: r.user_id, tipo: r.tipo, enabled: r.enabled, sonido: r.sonido })),
        };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ disponible: false, filas: [] }),
    });
  } catch (err) {
    return traducir(err);
  }
}

/** Guarda la preferencia de `userId` (null = la propia). Lanza `AvisosNoDisponiblesError` contra la base sin migrar. */
export async function guardarPreferenciaAviso(
  session: TenantDbSession,
  input: { readonly organizationId: string; readonly userId: string | null; readonly tipo: string; readonly enabled: boolean; readonly sonido: boolean },
): Promise<void> {
  if (!TIPOS_AVISO.has(input.tipo)) throw new AvisosValidacionError("Ese aviso no existe en restaurantes.");
  try {
    await runWithSavepointFallback<void>({
      session,
      primary: async () => {
        await session.query(`select core.set_notification_preference($1::uuid, $2::uuid, $3, $4::boolean, $5::boolean);`, [
          input.organizationId,
          input.userId,
          input.tipo,
          input.enabled,
          input.sonido,
        ]);
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => {
        throw new AvisosNoDisponiblesError();
      },
    });
  } catch (err) {
    if (err instanceof AvisosNoDisponiblesError) throw err;
    return traducir(err);
  }
}

/** Sucursales activas de la organizacion con su umbral de entrega tardia (null = sin configurar). */
export async function listarUmbralesEntrega(
  session: TenantDbSession,
  organizationId: string,
): Promise<{ readonly disponible: boolean; readonly sucursales: readonly UmbralSucursal[] }> {
  try {
    return await runWithSavepointFallback<{ readonly disponible: boolean; readonly sucursales: readonly UmbralSucursal[] }>({
      session,
      primary: async () => {
        const { rows } = await session.query<{ property_id: string; name: string; entrega_tardia_min: number | null }>(
          `select p.id as property_id, p.name, c.entrega_tardia_min
             from core.property p
             left join restaurantes.sucursal_avisos_config c on c.property_id = p.id
            where p.organization_id = $1::uuid and p.vertical = 'restaurantes' and p.status = 'active'
            order by p.name, p.id;`,
          [organizationId],
        );
        return { disponible: true, sucursales: rows.map((r) => ({ propertyId: r.property_id, nombre: r.name, entregaTardiaMin: r.entrega_tardia_min })) };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ disponible: false, sucursales: [] }),
    });
  } catch (err) {
    return traducir(err);
  }
}

/** Fija los minutos de gracia de la entrega tardia de UNA sucursal (owner/admin, validado por la base). */
export async function guardarUmbralEntrega(session: TenantDbSession, propertyId: string, minutos: number): Promise<void> {
  if (!Number.isInteger(minutos) || minutos < UMBRAL_ENTREGA_TARDIA_MIN || minutos > UMBRAL_ENTREGA_TARDIA_MAX) {
    throw new AvisosValidacionError(`Los minutos deben ser un entero entre ${UMBRAL_ENTREGA_TARDIA_MIN} y ${UMBRAL_ENTREGA_TARDIA_MAX}.`);
  }
  try {
    await runWithSavepointFallback<void>({
      session,
      primary: async () => {
        await session.query(`select restaurantes.set_umbral_entrega_tardia($1::uuid, $2::integer);`, [propertyId, minutos]);
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => {
        throw new AvisosNoDisponiblesError();
      },
    });
  } catch (err) {
    if (err instanceof AvisosNoDisponiblesError) throw err;
    return traducir(err);
  }
}
