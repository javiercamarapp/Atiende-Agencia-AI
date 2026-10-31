// Interruptor de emergencia UNIFICADO (migracion 103): apaga el agente de WhatsApp Y el de voz de una sucursal (o de toda la organizacion) y deja pasar todo a
// humanos. Una sola fuente de verdad (`restaurantes.interruptor_emergencia`) que leen los DOS canales:
//   * WhatsApp: `handleInboundWhatsAppMessage` (arg `interruptor`) -> sin modelo, texto fijo + toma de handoff para una persona.
//   * Voz: `/internal/restaurantes/voz/llamada/contexto` -> `habilitado = false` (el worker dice el saludo pregrabado y deja callback).
// Falla ABIERTO en la lectura (un error al leer nunca deja a un cliente sin atencion), pero la ESCRITURA falla cerrada con un error explicito.
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";

export interface EstadoInterruptor {
  readonly apagado: boolean;
  /** `false` = la base no tiene la migracion 103 (estado honesto "no disponible aun"). */
  readonly disponible: boolean;
}

/** Puerto de lectura que usan los canales. */
export interface InterruptorEmergenciaPort {
  estaApagado(organizationId: string, propertyId: string | null): Promise<boolean>;
}

/** Decision pura que comparten los dos canales: el agente atiende solo si su propio control lo permite Y el interruptor de emergencia esta encendido. */
export function agenteDebeAtender(controlPropioActivo: boolean, interruptorApagado: boolean): boolean {
  return controlPropioActivo && !interruptorApagado;
}

/** Lee el interruptor sin lanzar nunca: ante cualquier fallo devuelve `false` (encendido, como hasta hoy). */
export async function interruptorApagadoSeguro(port: InterruptorEmergenciaPort | undefined, organizationId: string, propertyId: string | null): Promise<boolean> {
  if (!port) return false;
  try {
    return await port.estaApagado(organizationId, propertyId);
  } catch {
    return false;
  }
}

/** Doble en memoria con el mismo contrato que el adaptador Postgres (alcance organizacion/sucursal). Solo para pruebas. */
export class InMemoryInterruptorEmergencia implements InterruptorEmergenciaPort {
  private readonly filas = new Map<string, { apagado: boolean; motivo: string | null; actor: string }>();
  readonly historial: { organizationId: string; propertyId: string | null; apagado: boolean; motivo: string | null; actor: string }[] = [];
  /** Simula una lectura que falla (base caida): debe fallar abierto. */
  fallaLectura = false;

  private clave(organizationId: string, propertyId: string | null): string {
    return `${organizationId}:${propertyId ?? "*"}`;
  }

  fijar(organizationId: string, propertyId: string | null, apagado: boolean, actor: string, motivo: string | null = null): boolean {
    const k = this.clave(organizationId, propertyId);
    const previo = this.filas.get(k)?.apagado ?? false;
    this.filas.set(k, { apagado, motivo, actor });
    this.historial.push({ organizationId, propertyId, apagado, motivo, actor });
    return previo;
  }

  async estaApagado(organizationId: string, propertyId: string | null): Promise<boolean> {
    if (this.fallaLectura) throw new Error("lectura no disponible");
    if (this.filas.get(this.clave(organizationId, null))?.apagado) return true;
    return propertyId !== null && this.filas.get(this.clave(organizationId, propertyId))?.apagado === true;
  }
}

function esBaseSinMigrar(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42501" || code === "42883" || code === "42P01" || code === "42703";
}

/** Adaptador Postgres de lectura (funcion `restaurantes.interruptor_apagado`, 103). Base sin migrar = encendido. */
export function crearInterruptorPostgres(db: TenantDbSession): InterruptorEmergenciaPort {
  return {
    async estaApagado(organizationId, propertyId) {
      return (await pgEstadoInterruptor(db, organizationId, propertyId)).apagado;
    },
  };
}

export async function pgEstadoInterruptor(db: TenantDbSession, organizationId: string, propertyId: string | null): Promise<EstadoInterruptor> {
  return runWithSavepointFallback<EstadoInterruptor>({
    session: db,
    savepointName: "sp_restaurantes_interruptor_lectura",
    primary: async () => {
      const { rows } = await db.query<{ apagado: boolean }>(`select restaurantes.interruptor_apagado($1::uuid, $2::uuid) as apagado;`, [organizationId, propertyId]);
      return { apagado: rows[0]?.apagado === true, disponible: true };
    },
    isRecoverable: esBaseSinMigrar,
    fallback: async () => ({ apagado: false, disponible: false }),
  });
}

export class InterruptorNoDisponibleError extends Error {
  constructor() {
    super("El interruptor de emergencia todavia no esta disponible en esta base (falta aplicar la migracion 103).");
    this.name = "InterruptorNoDisponibleError";
  }
}

/** Fija el interruptor (solo owner/admin; la autoridad es la base). Devuelve el valor ANTERIOR. Lanza `InterruptorNoDisponibleError` contra la base sin migrar. */
export async function pgFijarInterruptor(db: TenantDbSession, input: { readonly organizationId: string; readonly propertyId: string | null; readonly apagado: boolean; readonly motivo: string | null }): Promise<boolean> {
  return runWithSavepointFallback<boolean>({
    session: db,
    savepointName: "sp_restaurantes_interruptor_escritura",
    primary: async () => {
      const { rows } = await db.query<{ previo: boolean }>(`select restaurantes.interruptor_fijar($1::uuid, $2::uuid, $3::boolean, $4::text) as previo;`, [input.organizationId, input.propertyId, input.apagado, input.motivo]);
      return rows[0]?.previo === true;
    },
    isRecoverable: (err) => {
      const code = (err as { code?: string } | null)?.code;
      return code === "42883" || code === "42P01" || code === "42703";
    },
    fallback: async () => {
      throw new InterruptorNoDisponibleError();
    },
  });
}

/** Estado de todas las filas de la organizacion para el panel (sucursal null = toda la organizacion). */
export async function pgListarInterruptores(db: TenantDbSession, organizationId: string): Promise<{ readonly disponible: boolean; readonly filas: readonly { readonly propertyId: string | null; readonly apagado: boolean; readonly motivo: string | null; readonly actualizadoEn: string }[] }> {
  return runWithSavepointFallback<{ readonly disponible: boolean; readonly filas: readonly { readonly propertyId: string | null; readonly apagado: boolean; readonly motivo: string | null; readonly actualizadoEn: string }[] }>({
    session: db,
    savepointName: "sp_restaurantes_interruptor_lista",
    primary: async () => {
      const { rows } = await db.query<{ property_id: string | null; apagado: boolean; motivo: string | null; updated_at: Date | string }>(
        `select property_id, apagado, motivo, updated_at from restaurantes.interruptor_emergencia where organization_id = $1 and apagado;`,
        [organizationId],
      );
      return { disponible: true, filas: rows.map((r) => ({ propertyId: r.property_id, apagado: r.apagado, motivo: r.motivo, actualizadoEn: new Date(r.updated_at).toISOString() })) };
    },
    isRecoverable: esBaseSinMigrar,
    fallback: async () => ({ disponible: false, filas: [] }),
  });
}
