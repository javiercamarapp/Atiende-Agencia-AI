// Adaptador Postgres del importador y del perfil historico (migracion 140). Todas las llamadas corren en un SAVEPOINT: contra una base sin
// la migracion devuelven `undefined` ("no disponible aun") y el agente se comporta como antes. Sin PII en logs ni en errores.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { runWithSavepointFallback } from "@atiende/db";
import type { ExistenteHistorico, PlanImportacion, PuertoHistorico } from "./importador.ts";
import type { EntradaPerfil } from "./perfil.ts";

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown, fb = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : fb);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Funcion, tabla o columna inexistente: la base todavia no tiene la migracion 140. */
export function esBaseSinMigrar140(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42883" || code === "42P01" || code === "42703";
}

/** JSON de `cliente_perfil_historico` -> entrada del perfil. Valores fuera de catalogo se descartan (no se confia en la base a ciegas). */
export function mapPerfilHistorico(raw: Json): EntradaPerfil {
  const h = (raw.historico ?? {}) as Json;
  const canal = h.canal === "domicilio" || h.canal === "recoger" ? h.canal : null;
  const pago = h.pago === "efectivo" || h.pago === "tarjeta" ? h.pago : null;
  const tortilla = h.tortilla === "maiz" || h.tortilla === "harina" || h.tortilla === "mixta" ? h.tortilla : null;
  const quejas = arr(h.quejas).filter((q): q is "demora" | "faltante" | "cobro" | "salsas" | "cancelado" | "equivocado" | "otra" => ["demora", "faltante", "cobro", "salsas", "cancelado", "equivocado", "otra"].includes(q));
  return {
    nombre: str(raw.nombre),
    domicilios: (Array.isArray(raw.domicilios) ? (raw.domicilios as Json[]) : []).map((d) => ({
      etiqueta: str(d.etiqueta),
      colonia: str(d.colonia),
      importado: d.importado === true,
      ultimoUso: str(d.ultimo_uso),
      coloniaInferida: d.colonia_inferida === true,
      sinColonia: d.sin_colonia === true,
    })),
    historico: {
      canal,
      pago,
      tortilla,
      salsas: arr(h.salsas),
      omisiones: arr(h.omisiones),
      favoritos: arr(h.favoritos),
      pedidos: num(h.pedidos),
      gastoMxn: num(h.gasto_mxn),
      ticketMxn: h.ticket_mxn === null || h.ticket_mxn === undefined ? null : num(h.ticket_mxn),
      primerPedido: str(h.primer_pedido),
      ultimoPedido: str(h.ultimo_pedido),
      quejas,
      revisionHumana: h.revision_humana === true,
    },
  };
}

/** Lectura de SISTEMA por telefono. `null` = sin historial importado; `undefined` = base sin migrar. */
export async function getPerfilHistorico(db: TenantDbSession, organizationId: string, phone: string): Promise<EntradaPerfil | null | undefined> {
  return runWithSavepointFallback<EntradaPerfil | null | undefined>({
    session: db,
    savepointName: "sp_historico_perfil",
    primary: async () => {
      const { rows } = await db.query<{ r: unknown }>(`select restaurantes.cliente_perfil_historico($1, $2) as r;`, [organizationId, phone]);
      const raw = rows[0]?.r;
      return raw && typeof raw === "object" ? mapPerfilHistorico(raw as Json) : null;
    },
    isRecoverable: esBaseSinMigrar140,
    fallback: async () => undefined,
  });
}

function filaParaSql(c: PlanImportacion["acciones"][number]["cliente"]): Json {
  return {
    fila: c.fila, telefono: c.telefono, nombre: c.nombre, direccion: c.direccion, colonia: c.colonia, canal: c.canal, pago: c.pago, tortilla: c.tortilla,
    salsas: c.salsas, omisiones: c.omisiones, favoritos: c.favoritos, pedidos: c.pedidos, gasto_mxn: c.gastoMxn, ticket_mxn: c.ticketMxn,
    primer_pedido: c.primerPedido, ultimo_pedido: c.ultimoPedido, estado: c.estado, quejas: c.quejas, banderas: c.banderas, huella: c.huella,
  };
}

/**
 * Puerto Postgres del importador. Corre con una sesion de un owner/admin (la funcion lo exige). `existentes` hace una vista previa en base
 * (p_aplicar=false) para que el plan local y el de la base coincidan; `aplicar` ejecuta la misma funcion con p_aplicar=true.
 * Lanza si la base no tiene la migracion 140 (el importador no puede degradar en silencio).
 */
export class PuertoHistoricoPostgres implements PuertoHistorico {
  constructor(private readonly db: TenantDbSession) {}

  async existentes(organizationId: string, telefonos: readonly string[]): Promise<ReadonlyMap<string, ExistenteHistorico>> {
    const m = new Map<string, ExistenteHistorico>();
    if (telefonos.length === 0) return m;
    const { rows } = await this.db.query<{ phone: string; id: string; huella: string | null; suprimido: boolean }>(
      `select c.phone, c.id, h.huella,
              exists (select 1 from restaurantes.import_historico_supresion s
                       where s.organization_id = c.organization_id
                         and s.phone_hash = encode(sha256(convert_to(c.organization_id::text || ':' || c.phone, 'utf8')), 'hex')) as suprimido
         from restaurantes.customers c
         left join restaurantes.customer_historial_resumen h on h.customer_id = c.id
        where c.organization_id = $1 and c.phone = any($2::text[])`,
      [organizationId, [...telefonos]],
    );
    for (const r of rows) m.set(r.phone, { customerId: r.id, huella: r.huella, suprimido: r.suprimido });
    // Suprimidos que ya no tienen cliente: se detectan por hash.
    const { rows: sup } = await this.db.query<{ phone: string }>(
      `select t.phone from unnest($2::text[]) as t(phone)
        where exists (select 1 from restaurantes.import_historico_supresion s
                       where s.organization_id = $1::uuid and s.phone_hash = encode(sha256(convert_to($1::text || ':' || t.phone, 'utf8')), 'hex'))`,
      [organizationId, [...telefonos]],
    );
    for (const s of sup) if (!m.has(s.phone)) m.set(s.phone, { customerId: null, huella: null, suprimido: true });
    return m;
  }

  async aplicar(organizationId: string, plan: PlanImportacion): Promise<void> {
    const filas = plan.acciones.map((a) => filaParaSql(a.cliente));
    if (filas.length === 0) return;
    await this.db.query(`select restaurantes.importar_historial($1, $2, true, $3::jsonb);`, [organizationId, plan.archivoSha256, JSON.stringify(filas)]);
  }
}
