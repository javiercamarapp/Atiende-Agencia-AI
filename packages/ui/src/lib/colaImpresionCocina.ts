/**
 * Cola de auto-impresión de cocina (PM PR-7). Lógica PURA: dado el listado de pedidos que
 * el panel ya trae por polling, decide cuáles faltan por imprimir. No hay cola en el
 * servidor (compatible con la base sin migrar): el estado "ya impreso" lo guarda el
 * navegador que imprime (ver apps/web .../lib/ticket-cocina-prefs.ts).
 */

export interface PedidoParaCola {
  readonly id: string;
  readonly status: string;
  readonly createdAt: string;
}

/** Solo los pedidos recién recibidos (`pending`) y aún no impresos, del más antiguo al más
 * nuevo (la cocina los recibe en el orden en que entraron). */
export function pedidosPorImprimir<T extends PedidoParaCola>(pedidos: readonly T[], impresos: ReadonlySet<string>): T[] {
  return pedidos
    .filter((p) => p.status === "pending" && !impresos.has(p.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
