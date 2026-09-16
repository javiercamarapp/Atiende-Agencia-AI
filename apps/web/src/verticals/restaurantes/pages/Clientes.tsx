// Clientes (Fase 5) — lista + búsqueda + ficha real (tier/direcciones/"lo de
// siempre") sobre exactamente lo que customers.ts ya calcula — ver
// admin-customers.ts. Nunca inventa campos nuevos.
//
// Presentación real desde esta ronda: los `style={{...}}` inline de antes pasan a
// los primitivos que `@atiende/ui` ya exporta (`Card` para cada cliente de la lista
// y para los bloques de la ficha, `Input` para la búsqueda, `Badge` para el tier,
// `Button` para volver) — mismo acabado que RestaurantesShell.tsx. La lógica de
// fetch/estado de abajo es idéntica: solo cambia el JSX.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
} from "@atiende/ui";
import { ArrowLeft, Search } from "lucide-react";
import { fetchCustomerDetail, fetchCustomers } from "../lib/customers-client.ts";
import type { CustomerDetail, CustomerSummary, CustomerTier } from "../lib/customers-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

/** Mismos 4 tiers de siempre (label/glifo idénticos); el color deja de ser un hex
 * suelto y pasa a clases de token que funcionan en claro y oscuro. */
const TIER_META: Record<CustomerTier, { label: string; glyph: string; clase: string }> = {
  BLACK: { label: "Black", glyph: "♛", clase: "border-transparent bg-foreground text-background" },
  PLATINUM: { label: "Platinum", glyph: "◆", clase: "border-border bg-muted text-muted-foreground" },
  GOLD: { label: "Gold", glyph: "★", clase: "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200" },
  BLUE: { label: "Blue", glyph: "●", clase: "border-transparent bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200" },
};

export function ClientesListPage({ apiBaseUrl, token, propertyId, orgSlug }: RestaurantesShellContext) {
  const [search, setSearch] = useState("");
  const [customers, setCustomers] = useState<readonly CustomerSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetchCustomers(fetch, apiBaseUrl, token, propertyId, { search: search || undefined, limit: 50 })
      .then((page) => !cancelado && setCustomers(page.customers))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : "No se pudieron cargar los clientes."));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, search]);

  return (
    <div className="flex flex-col gap-4 p-6">
      <h1 className="m-0 font-display text-xl font-semibold text-foreground">Clientes</h1>

      <div className="max-w-xs">
        <Label htmlFor="restaurantes-clientes-buscar" className="mb-1.5 block text-xs text-muted-foreground">
          Buscar
        </Label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
          <Input
            id="restaurantes-clientes-buscar"
            placeholder="Buscar por nombre o teléfono…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {error && <EstadoError mensaje={error} />}
      {!customers && !error && <EstadoCargando etiqueta="Cargando clientes…" />}
      {customers && customers.length === 0 && <EstadoVacio mensaje="No se encontraron clientes." />}

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
        {customers?.map((c) => (
          <Link
            key={c.id}
            to={`/restaurantes/${orgSlug}/clientes/${c.id}`}
            className="block rounded-lg no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardContent className="p-4">
                <p className="m-0 font-semibold text-foreground">{c.name ?? c.phone}</p>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {c.phone} · {c.orderCount} pedido{c.orderCount === 1 ? "" : "s"}
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

export interface ClienteFichaPageProps extends RestaurantesShellContext {
  readonly customerId: string;
}

export function ClienteFichaPage({ apiBaseUrl, token, propertyId, orgSlug, customerId }: ClienteFichaPageProps) {
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetchCustomerDetail(fetch, apiBaseUrl, token, propertyId, customerId)
      .then((d) => !cancelado && setDetail(d))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : "No se pudo cargar el cliente."));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, customerId]);

  return (
    <div className="flex max-w-xl flex-col gap-4 p-6">
      <Button asChild variant="ghost" size="sm" className="self-start px-2 text-muted-foreground">
        <Link to={`/restaurantes/${orgSlug}/clientes`}>
          <ArrowLeft />
          Volver a clientes
        </Link>
      </Button>

      {error && <EstadoError mensaje={error} />}
      {!detail && !error && <EstadoCargando etiqueta="Cargando cliente…" />}
      {detail?.isNew && <EstadoVacio mensaje="Este cliente todavía no tiene ningún pedido registrado." />}

      {detail && !detail.isNew && (
        <>
          <div className="flex items-center gap-2.5">
            <h1 className="m-0 font-display text-xl font-semibold text-foreground">{detail.name ?? "Sin nombre"}</h1>
            {detail.tier && (
              <Badge variant="outline" className={`gap-1.5 px-2.5 py-1 font-medium ${TIER_META[detail.tier].clase}`}>
                <span aria-hidden>{TIER_META[detail.tier].glyph}</span>
                {TIER_META[detail.tier].label}
              </Badge>
            )}
          </div>

          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Pedidos totales</dt>
            <dd className="m-0 text-foreground">{detail.orderCount}</dd>
          </dl>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-[13px] font-semibold">Direcciones guardadas</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              {detail.addresses.length === 0 ? (
                <p className="m-0 text-[13px] text-muted-foreground">Sin direcciones guardadas.</p>
              ) : (
                <ul className="m-0 list-disc pl-5 text-[13px] text-foreground">
                  {detail.addresses.map((a, i) => (
                    <li key={i}>
                      {a.address} {a.isDefault && <span className="text-muted-foreground">(principal)</span>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-[13px] font-semibold">Lo que más pide</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              {detail.frequentItems.length === 0 ? (
                <p className="m-0 text-[13px] text-muted-foreground">Sin historial suficiente todavía.</p>
              ) : (
                <ul className="m-0 list-disc pl-5 text-[13px] text-foreground">
                  {detail.frequentItems.map((item, i) => (
                    <li key={i}>
                      {item.quantity}× {item.name}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {detail.agentNotes.length > 0 && (
            <section className="rounded-lg border border-dashed border-border p-3">
              <p className="m-0 mb-1.5 text-xs font-semibold text-muted-foreground">Notas para el agente</p>
              {detail.agentNotes.map((note, i) => (
                <p key={i} className="mt-1 text-[13px] text-foreground">
                  {note}
                </p>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
