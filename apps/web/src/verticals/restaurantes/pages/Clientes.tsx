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
import { Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, Input, Label, PageContainer } from "@atiende/ui";
import { Search } from "lucide-react";
import { fetchCustomers } from "../lib/customers-client.ts";
import type { CustomerSummary } from "../lib/customers-client.ts";
import { BotonExportar } from "../components/BotonExportar.tsx";
import { urlExportarClientes } from "../lib/exportar-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

export function ClientesListPage({ apiBaseUrl, token, propertyId, orgSlug, role }: RestaurantesShellContext) {
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
    <PageContainer padding="none">
      <h1 className="sr-only">Clientes</h1>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-xs">
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
        {/* R-17: exporta TODOS los clientes que coinciden con la búsqueda vigente (no solo los 50 en pantalla). Solo owner/admin. */}
        <BotonExportar role={role} token={token} urlPara={(formato) => urlExportarClientes(apiBaseUrl, propertyId, formato, search || undefined)} />
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
                <p className="mt-1 text-sm text-muted-foreground">
                  {c.phone} · {c.orderCount} pedido{c.orderCount === 1 ? "" : "s"}
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </PageContainer>
  );
}

// La ficha completa (Cliente 360, migracion 049) vive en ClienteFicha.tsx.
export { ClienteFichaPage } from "./ClienteFicha.tsx";
export type { ClienteFichaPageProps } from "./ClienteFicha.tsx";
