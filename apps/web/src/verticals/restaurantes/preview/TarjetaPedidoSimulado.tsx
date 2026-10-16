// Tarjeta del pedido SIMULADO que devuelve `crear_pedido` en la prueba del agente (chat y voz): folio PRUEBA-xxxx, renglones y el
// total que calculo el servidor. El pedido NO existe en la base; la etiqueta fija lo dice. Mismos componentes de @atiende/ui que el resto
// del panel (tarjetas compactas, sin estilos nuevos).
import { Card, CardContent, CardHeader, CardTitle, StatusBadge } from "@atiende/ui";
import { formatMoney } from "../dashboard-client.ts";
import type { PedidoSimulado } from "../lib/voz-client.ts";

/** `compacta` (chat de WhatsApp): solo renglones y total; el folio y la insignia «Prueba» ya salen una vez en el mensaje de sistema que la antecede. */
export function TarjetaPedidoSimulado({ pedido, compacta = false }: { readonly pedido: PedidoSimulado; readonly compacta?: boolean }) {
  return (
    <Card data-testid="tarjeta-pedido-simulado">
      {compacta ? null : (
        <CardHeader className="flex flex-row items-center justify-between gap-2 p-4 pb-2">
          <CardTitle className="text-sm">Pedido simulado {pedido.folio}</CardTitle>
          <StatusBadge tone="warning" dot={false}>Prueba</StatusBadge>
        </CardHeader>
      )}
      <CardContent className={compacta ? "space-y-2 p-4 text-sm" : "space-y-2 p-4 pt-0 text-sm"}>
        {pedido.sucursal ? <p className="text-xs text-muted-foreground">{pedido.sucursal}</p> : null}
        <ul className="space-y-1">
          {pedido.renglones.map((r, i) => (
            <li key={`${r.nombre}-${i}`} className="flex justify-between gap-3">
              <span>
                {r.cantidad} × {r.nombre}
              </span>
              <span className="tabular-nums">{formatMoney(r.precio * r.cantidad)}</span>
            </li>
          ))}
        </ul>
        <p className="flex justify-between border-t border-border pt-2 font-medium">
          <span>Total del servidor</span>
          <span className="tabular-nums">{formatMoney(pedido.total)}</span>
        </p>
        {compacta ? null : <p className="text-xs text-muted-foreground">Prueba: no se crean pedidos ni se avisa a nadie.</p>}
      </CardContent>
    </Card>
  );
}
