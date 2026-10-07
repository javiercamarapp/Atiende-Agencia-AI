// Adaptador Postgres de `WhatsappKpiRepository` (migracion 040). REGLA DURA de compatibilidad con la base SIN migrar: mergear
// despliega el codigo al instante y la 040 no se aplica sola. La consulta corre dentro de la transaccion UNICA del request
// (`withAppSession`): un error de Postgres la deja abortada (25P02), por eso usa `runWithSavepointFallback` y degrada a
// `disponible: false` (42883 funcion inexistente, 42P01 tabla, 42703 columna).
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { WhatsappEntregaDia, WhatsappKpiDia, WhatsappKpiLectura, WhatsappKpiRepository } from "./kpi.ts";

function code(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

function esBaseSinMigrar(err: unknown): boolean {
  const c = code(err);
  return c === "42P01" || c === "42703" || c === "42883";
}

let advertido = false;
function advertirNoDisponible(err: unknown): void {
  if (advertido) return;
  advertido = true;
  console.warn(
    "PostgresWhatsappKpiRepository: la funcion restaurantes.whatsapp_kpis_diarios todavia no existe en esta base (SQLSTATE 42P01/42703/42883) -- " +
      "aplica packages/domain-restaurantes/migrations/040_whatsapp_kpis_diarios.sql (o su espejo en supabase/migrations/).",
    err,
  );
}

const num = (v: string | number): number => Number(v);
const numNull = (v: string | number | null): number | null => (v === null ? null : Number(v));

interface Row {
  fecha: string;
  zona_horaria: string;
  conversaciones: number;
  conversaciones_con_pedido: number;
  conversaciones_con_handoff: number;
  pedidos: number;
  handoffs: number;
  pedidos_org: number | null;
  org_es_demo: boolean;
  costo_llm_org_micro_usd: string | number | null;
  costo_llm_org_centavos_mxn: string | number | null;
}

function mapRow(r: Row): WhatsappKpiDia {
  return {
    fecha: r.fecha,
    zonaHoraria: r.zona_horaria,
    conversaciones: num(r.conversaciones),
    conversacionesConPedido: num(r.conversaciones_con_pedido),
    conversacionesConHandoff: num(r.conversaciones_con_handoff),
    pedidos: num(r.pedidos),
    handoffs: num(r.handoffs),
    pedidosOrg: numNull(r.pedidos_org),
    orgEsDemo: r.org_es_demo === true,
    costoLlmOrgMicroUsd: numNull(r.costo_llm_org_micro_usd),
    costoLlmOrgCentavosMxn: numNull(r.costo_llm_org_centavos_mxn),
  };
}

export class PostgresWhatsappKpiRepository implements WhatsappKpiRepository {
  constructor(private readonly db: TenantDbSession) {}

  async getKpisDiarios(organizationId: string, propertyId: string, desde: string, hasta: string): Promise<WhatsappKpiLectura<readonly WhatsappKpiDia[]>> {
    return runWithSavepointFallback<WhatsappKpiLectura<readonly WhatsappKpiDia[]>>({
      session: this.db,
      savepointName: "sp_whatsapp_kpi_diarios_read",
      primary: async () => {
        const { rows } = await this.db.query<Row>(
          `select to_char(fecha, 'YYYY-MM-DD') as fecha, zona_horaria, conversaciones, conversaciones_con_pedido, conversaciones_con_handoff,
                  pedidos, handoffs, pedidos_org, org_es_demo, costo_llm_org_micro_usd, costo_llm_org_centavos_mxn
             from restaurantes.whatsapp_kpis_diarios($1, $2, $3::date, $4::date)
            order by fecha;`,
          [organizationId, propertyId, desde, hasta],
        );
        return { disponible: true, valor: rows.map(mapRow) };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async (err) => {
        advertirNoDisponible(err);
        return { disponible: false, valor: [] };
      },
    });
  }
  async getEntregaDiaria(organizationId: string, propertyId: string, desde: string, hasta: string): Promise<WhatsappKpiLectura<readonly WhatsappEntregaDia[]>> {
    interface FilaEntrega {
      fecha: string;
      enviados: number;
      entregados: number;
      leidos: number;
      fallidos: number;
      sin_estado: number;
      fallos_por_motivo: Record<string, number> | null;
    }
    // Misma regla que getKpisDiarios: transaccion unica del request -> SAVEPOINT; la funcion es de la migracion 066.
    return runWithSavepointFallback<WhatsappKpiLectura<readonly WhatsappEntregaDia[]>>({
      session: this.db,
      savepointName: "sp_whatsapp_entrega_diaria_read",
      primary: async () => {
        const { rows } = await this.db.query<FilaEntrega>(
          `select to_char(fecha, 'YYYY-MM-DD') as fecha, enviados, entregados, leidos, fallidos, sin_estado, fallos_por_motivo
             from restaurantes.whatsapp_entrega_diaria($1, $2, $3::date, $4::date)
            order by fecha;`,
          [organizationId, propertyId, desde, hasta],
        );
        return {
          disponible: true,
          valor: rows.map((r) => ({
            fecha: r.fecha,
            enviados: num(r.enviados),
            entregados: num(r.entregados),
            leidos: num(r.leidos),
            fallidos: num(r.fallidos),
            sinEstado: num(r.sin_estado),
            fallosPorMotivo: Object.fromEntries(Object.entries(r.fallos_por_motivo ?? {}).map(([k, v]) => [k, Number(v)])),
          })),
        };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async () => ({ disponible: false, valor: [] }),
    });
  }
}
