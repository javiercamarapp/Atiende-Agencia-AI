// Seguimiento de un pedido por token (sin login). Solo muestra estado y productos, nunca datos personales.
// Se refresca cada 20 s mientras el pedido no llegue a un estado final. Token invalido/vencido: mensaje uniforme.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Callout, EstadoCargando, EstadoError, StatusBadge } from "@atiende/ui";
import { ETIQUETA_ESTADO, formatoPesos } from "./carrito.ts";
import { crearClienteStorefront, StorefrontError, type EstadoPedido, type RastreoPedido } from "./storefront-client.ts";
import { StorefrontLayout } from "./StorefrontLayout.tsx";
import { useMetaPublica } from "./meta-publica.ts";

const FINALES: readonly EstadoPedido[] = ["entregado", "completado", "cancelado"];
const REFRESCO_MS = 20_000;
const TONO: Record<EstadoPedido, "info" | "warning" | "success" | "danger"> = { pending: "info", preparando: "warning", en_camino: "warning", entregado: "success", completado: "success", cancelado: "danger", problema: "danger" };

export function RastreoPage({ apiBaseUrl, orgSlug, token }: { apiBaseUrl: string; orgSlug: string; token: string }) {
  useMetaPublica({ titulo: "Seguimiento de tu pedido", descripcion: "Estado de tu pedido.", indexable: false });
  const cliente = useMemo(() => crearClienteStorefront(apiBaseUrl, orgSlug), [apiBaseUrl, orgSlug]);
  const [estado, setEstado] = useState<RastreoPedido | "cargando" | "no_encontrado" | { error: string }>("cargando");

  const cargar = useCallback(() => {
    cliente
      .rastreo(token)
      .then(setEstado)
      .catch((e: unknown) => {
        if (e instanceof StorefrontError && e.status === 404) setEstado("no_encontrado");
        else setEstado({ error: e instanceof Error ? e.message : "No pudimos consultar tu pedido." });
      });
  }, [cliente, token]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const final = typeof estado === "object" && "pedido" in estado && estado.pedido ? FINALES.includes(estado.pedido.status) : false;
  useEffect(() => {
    if (final || estado === "no_encontrado" || (typeof estado === "object" && "disponible" in estado && !estado.disponible)) return;
    const t = setInterval(cargar, REFRESCO_MS);
    return () => clearInterval(t);
  }, [cargar, final, estado]);

  return (
    <StorefrontLayout orgSlug={orgSlug}>
      <div className="mx-auto max-w-xl">
        <h1 className="text-2xl font-semibold tracking-tight">Seguimiento de tu pedido</h1>
        <div className="mt-5" aria-live="polite">
          {estado === "cargando" && <EstadoCargando />}
          {estado === "no_encontrado" && (
            <Callout tone="warning" titulo="No encontramos ese pedido">
              El enlace puede haber vencido o estar incompleto. Si acabas de pedir, revisa que copiaste el enlace completo; si tienes dudas, llama a la sucursal.
            </Callout>
          )}
          {typeof estado === "object" && "error" in estado && <EstadoError mensaje={estado.error} onReintentar={cargar} />}
          {typeof estado === "object" && "disponible" in estado && !estado.disponible && (
            <Callout tone="info" titulo="Seguimiento en línea no disponible por ahora">
              {estado.mensaje}
            </Callout>
          )}
          {typeof estado === "object" && "pedido" in estado && estado.pedido && (
            <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <StatusBadge tone={TONO[estado.pedido.status]}>{ETIQUETA_ESTADO[estado.pedido.status] ?? estado.pedido.status}</StatusBadge>
                <span className="text-sm text-muted-foreground">{estado.pedido.branch ?? ""}</span>
              </div>
              <p className="text-sm text-muted-foreground">
                {estado.pedido.canal === "recoger" ? "Lo recoges en la sucursal." : "Va a domicilio."} Pagas {estado.pedido.paymentMethod === "tarjeta" ? "con tarjeta" : estado.pedido.paymentMethod === "efectivo" ? "en efectivo" : ""} en la sucursal.
              </p>
              <ul className="flex flex-col gap-1 text-sm">
                {estado.pedido.items.map((i, idx) => (
                  <li key={`${i.name}-${idx}`}>
                    {i.quantity} × {i.name}
                    {i.tortilla ? ` (${i.tortilla})` : ""}
                  </li>
                ))}
              </ul>
              <p className="flex justify-between border-t border-border pt-3 font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{formatoPesos(estado.pedido.total)}</span>
              </p>
              {!final && <p className="text-xs text-muted-foreground">Esta página se actualiza sola.</p>}
            </div>
          )}
        </div>
        <Button asChild variant="outline" className="mt-6">
          <Link to={`/pedir/${orgSlug}`}>Hacer otro pedido</Link>
        </Button>
      </div>
    </StorefrontLayout>
  );
}
