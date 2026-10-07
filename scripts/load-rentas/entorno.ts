// Fixtures y fabrica de conexiones de la carga de rentas (Rn-P3-14). Conecta como superusuario (RLS no es lo que se mide aqui: eso lo
// cubren los scripts/verify-rentas-*/).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { envolver, type Conexion } from "./comun.ts";

export const ZONA = "America/Mexico_City";

export function urlBaseDatos(): string {
  const url = process.env["LOAD_RENTAS_DATABASE_URL"];
  if (!url) throw new Error("falta LOAD_RENTAS_DATABASE_URL (usa scripts/load-rentas/run.sh, que levanta un Postgres efimero migrado)");
  return url;
}

export async function nuevaConexion(): Promise<{ cliente: pg.Client; db: Conexion }> {
  const cliente = new pg.Client({ connectionString: urlBaseDatos() });
  await cliente.connect();
  return { cliente, db: envolver(cliente) };
}

/** Ejecuta `fn` en su propia conexion y transaccion (BEGIN/COMMIT, ROLLBACK si lanza), como una sesion de sistema por unidad. */
export async function enTransaccion<T>(fn: (db: Conexion) => Promise<T>): Promise<T> {
  const { cliente, db } = await nuevaConexion();
  try {
    await cliente.query("BEGIN");
    // La sesion de sistema del cron corre como `authenticated` sin auth.uid(); aqui es superusuario (bypass de RLS) a proposito.
    const r = await fn(db);
    await cliente.query("COMMIT");
    return r;
  } catch (e) {
    await cliente.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await cliente.end();
  }
}

export interface Tenant {
  organizationId: string;
  propertyId: string;
  canalIds: Record<string, string>;
}

/** Una organizacion/propiedad nueva por escenario (aislamiento entre escenarios sin recrear el cluster). */
export async function crearTenant(db: Conexion, etiqueta: string): Promise<Tenant> {
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  await db.query(`insert into core.organization (id, vertical, name, slug) values ($1, 'rentas', $2, $3)`, [organizationId, `Org carga ${etiqueta}`, `org-carga-${etiqueta}-${organizationId.slice(0, 8)}`]);
  await db.query(`insert into core.property (id, organization_id, vertical, name) values ($1, $2, 'rentas', $3)`, [propertyId, organizationId, `Propiedad carga ${etiqueta}`]);
  await db.query(`insert into rentas.property_config (property_id, organization_id, zona_horaria, moneda) values ($1, $2, $3, 'MXN') on conflict (property_id) do nothing`, [propertyId, organizationId, ZONA]);
  const canales = await db.query<{ id: string; codigo: string }>(`select id, codigo from rentas.canal`);
  return { organizationId, propertyId, canalIds: Object.fromEntries(canales.rows.map((c) => [c.codigo, c.id])) };
}

export async function crearUnidades(db: Conexion, t: Tenant, n: number, prefijo: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await db.query<{ id: string }>(
      `insert into rentas.unidad (organization_id, property_id, name, duracion_minima_noches) values ($1, $2, $3, 1) returning id`,
      [t.organizationId, t.propertyId, `${prefijo} ${i}`],
    );
    ids.push(r.rows[0]!.id);
  }
  return ids;
}
