import { PERIOD_PARAMS, resolvePeriod } from "../../src/data-chat/period.js";
import type { DataChatAuditEntry, DataChatAuditSink, DataChatCatalog, DataChatScope, DataChatTool, DataChatToolContext, DataChatToolResult } from "../../src/data-chat/types.js";
import type { Cell } from "../../src/data-chat/sanitize.js";

export const SCOPE_A: DataChatScope = {
  organizationId: "org-a",
  userId: "user-1",
  vertical: "restaurantes",
  verticalRole: "admin",
  allowedPropertyIds: null,
  timezone: "America/Merida",
};

/** 29-sep-2026 23:30 en Mérida (UTC-6) = 30-sep 05:30 UTC: el día UTC ya es "mañana". */
export const NOW = new Date("2026-09-30T05:30:00.000Z");

export class MemoryAudit implements DataChatAuditSink {
  readonly entries: DataChatAuditEntry[] = [];
  async record(entry: DataChatAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

export interface FakeToolOptions {
  readonly rows?: readonly Record<string, Cell>[];
  readonly status?: DataChatToolResult["status"];
  readonly run?: (ctx: DataChatToolContext) => Promise<DataChatToolResult>;
}

export const SALES_COLUMNS = [
  { key: "dia", label: "Día", kind: "text" as const },
  { key: "ventas", label: "Ventas", kind: "mxn" as const },
  { key: "pedidos", label: "Pedidos", kind: "integer" as const },
];

export function salesTool(opts: FakeToolOptions = {}, seen: DataChatToolContext[] = []): DataChatTool {
  return {
    name: "ventas_por_dia",
    label: "Ventas por día",
    description: "Ventas y pedidos por día.",
    params: PERIOD_PARAMS,
    async run(ctx, args) {
      seen.push(ctx);
      if (opts.run) return opts.run(ctx);
      const p = resolvePeriod(args, ctx.now, ctx.scope.timezone);
      if (!p.ok) return { status: p.kind === "needs_clarification" ? "needs_clarification" : "error", message: p.message, source: "Pedidos", scopeLabel: "", columns: [], rows: [] };
      const rows = opts.rows ?? [
        { dia: "2026-09-28", ventas: 1500.5, pedidos: 12 },
        { dia: "2026-09-29", ventas: 980, pedidos: 8 },
      ];
      return {
        status: opts.status ?? (rows.length ? "ok" : "empty"),
        source: "Pedidos (sin cancelados)",
        periodLabel: p.period.label,
        scopeLabel: "todas tus sucursales",
        columns: SALES_COLUMNS,
        rows,
        chart: { kind: "bar", x: "dia", y: "ventas" },
        summary: "Ventas del periodo: $2,480.50 MXN en 20 pedidos.",
      };
    },
  };
}

export function catalogOf(...tools: DataChatTool[]): DataChatCatalog {
  return { vertical: "restaurantes", domain: "un restaurante", tools };
}
