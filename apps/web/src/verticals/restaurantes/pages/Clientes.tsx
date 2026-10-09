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
  Button,
  Callout,
  Card,
  CardContent,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormField,
  Input,
  Label,
  Selector,
  PageContainer,
  StatCard,
  StatusBadge,
  formatMoney,
  statusTone,
} from "@atiende/ui";
import { Crown, Receipt, Repeat, Search, Upload, Users } from "lucide-react";
import { fetchBranches } from "../dashboard-client.ts";
import type { BranchOption } from "../dashboard-client.ts";
import { fetchCarteraKpis, fetchCustomers } from "../lib/customers-client.ts";
import type { CarteraKpisWire, CustomerSummary, CustomerTier, FrecuenciaCliente } from "../lib/customers-client.ts";
import { ImportarClientesDialog } from "../components/ImportarClientesDialog.tsx";
import { CUSTOMER_TIER_META, CUSTOMER_TIER_TONES, tierBadgeClase } from "../lib/status-tones.ts";
import { BotonExportar } from "../components/BotonExportar.tsx";
import { urlExportarClientes } from "../lib/exportar-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const NIVELES: readonly CustomerTier[] = ["BLACK", "PLATINUM", "GOLD", "BLUE"];
const DIAS_SIN_PEDIR: readonly number[] = [30, 60, 90];
const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "staff"]);

function diasDesde(iso: string | null): number | null {
  return iso === null ? null : Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));
}

export function ClientesListPage({ apiBaseUrl, token, propertyId, orgSlug, role }: RestaurantesShellContext) {
  const [search, setSearch] = useState("");
  const [nivel, setNivel] = useState<CustomerTier | "">("");
  const [frecuencia, setFrecuencia] = useState<FrecuenciaCliente | "">("");
  const [inactivoDias, setInactivoDias] = useState<number | "">("");
  const [branchId, setBranchId] = useState("");
  const [sucursales, setSucursales] = useState<readonly BranchOption[]>([]);
  const [customers, setCustomers] = useState<readonly CustomerSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filtrosDisponibles, setFiltrosDisponibles] = useState(true);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kpis, setKpis] = useState<CarteraKpisWire | null>(null);
  const [importando, setImportando] = useState(false);
  const [version, setVersion] = useState(0);
  const puedeImportar = ADMIN_ROLES.has(role);

  const filtrosActivos = { nivel: nivel || undefined, frecuencia: frecuencia || undefined, inactivoDias: inactivoDias || undefined, branchId: branchId || undefined };

  useEffect(() => {
    let cancelado = false;
    fetchBranches(fetch, apiBaseUrl, token, orgSlug)
      .then((b) => !cancelado && setSucursales(Array.isArray(b) ? b : []))
      .catch(() => !cancelado && setSucursales([]));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, orgSlug]);

  // KPIs de cartera (no dependen de los filtros). Sin respuesta no se pintan: nunca tumban la lista.
  useEffect(() => {
    let cancelado = false;
    fetchCarteraKpis(fetch, apiBaseUrl, token, propertyId)
      .then((k) => !cancelado && setKpis(k))
      .catch(() => !cancelado && setKpis(null));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, version]);

  useEffect(() => {
    let cancelado = false;
    setError(null);
    fetchCustomers(fetch, apiBaseUrl, token, propertyId, { search: search || undefined, limit: 50, ...filtrosActivos })
      .then((page) => {
        if (cancelado) return;
        setCustomers(page.customers);
        setNextCursor(page.nextCursor);
        setFiltrosDisponibles(page.filtrosDisponibles !== false);
      })
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : "No se pudieron cargar los clientes."));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, search, nivel, frecuencia, inactivoDias, branchId, version]);

  async function verMas() {
    if (!nextCursor) return;
    setCargandoMas(true);
    try {
      const page = await fetchCustomers(fetch, apiBaseUrl, token, propertyId, { search: search || undefined, limit: 50, cursor: nextCursor, ...filtrosActivos });
      setCustomers((previos) => [...(previos ?? []), ...page.customers]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar más clientes.");
    } finally {
      setCargandoMas(false);
    }
  }

  const hayFiltros = nivel !== "" || frecuencia !== "" || inactivoDias !== "" || branchId !== "" || search !== "";
  const k = kpis && kpis.disponible ? kpis : null;

  return (
    <PageContainer padding="none">
      <h1 className="sr-only">Clientes</h1>

      {k && (
        <section aria-label="Resumen de la cartera" className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]" data-testid="cartera-kpis">
          <StatCard icon={Users} label="Clientes" value={String(k.total ?? 0)} nota="Cartera total" variante="neutra" />
          <StatCard icon={Repeat} label="Recurrentes" value={String(k.recurrentes ?? 0)} nota="2 pedidos o más" variante="neutra" />
          <StatCard
            icon={Receipt}
            label="Ticket promedio"
            value={k.ticketPromedio === null || k.ticketPromedio === undefined ? "—" : `$${formatMoney(k.ticketPromedio)}`}
            nota={k.ticketPromedio === null || k.ticketPromedio === undefined ? "Aún no hay pedidos" : "Pedidos vigentes"}
            variante="neutra"
          />
          <StatCard
            icon={Crown}
            label="Cliente más frecuente"
            value={k.masFrecuente ? `${k.masFrecuente.pedidos} pedidos` : "—"}
            nota={
              k.masFrecuente
                ? `${k.masFrecuente.nombre ?? "Sin nombre"} (${k.masFrecuente.telefonoEnmascarado})${k.masFrecuente.diasDesdeUltimoPedido === null ? "" : ` · último pedido hace ${k.masFrecuente.diasDesdeUltimoPedido} d`}`
                : "Nadie ha pedido todavía"
            }
            variante="neutra"
          />
        </section>
      )}
      {kpis && !kpis.disponible && (
        <Callout tone="neutral" titulo="Resumen de cartera no disponible aún" data-testid="cartera-kpis-sin-migracion">
          Requiere la migración 054 de restaurantes en esta base de datos.
        </Callout>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
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
          <FormField label="Nivel">
            <Selector id="restaurantes-clientes-nivel" size="sm" value={nivel} onChange={(e) => setNivel(e.target.value as CustomerTier | "")} wrapperClassName="w-auto min-w-36">
              <option value="">Todos los niveles</option>
              {NIVELES.map((n) => (
                <option key={n} value={n}>
                  {CUSTOMER_TIER_META[n].label}
                </option>
              ))}
            </Selector>
          </FormField>
          <FormField label="Frecuencia">
            <Selector id="restaurantes-clientes-frecuencia" size="sm" value={frecuencia} onChange={(e) => setFrecuencia(e.target.value as FrecuenciaCliente | "")} wrapperClassName="w-auto min-w-40">
              <option value="">Cualquiera</option>
              <option value="una_vez">Con 1 pedido</option>
              <option value="recurrentes">Recurrentes (2 o más)</option>
            </Selector>
          </FormField>
          <FormField label="Sin pedir en">
            <Selector id="restaurantes-clientes-inactivo" size="sm" value={String(inactivoDias)} onChange={(e) => setInactivoDias(e.target.value === "" ? "" : Number(e.target.value))} wrapperClassName="w-auto min-w-36">
              <option value="">Cualquier momento</option>
              {DIAS_SIN_PEDIR.map((d) => (
                <option key={d} value={d}>
                  {d} días
                </option>
              ))}
            </Selector>
          </FormField>
          {sucursales.length > 1 && (
            <FormField label="Sucursal">
              <Selector id="restaurantes-clientes-sucursal" size="sm" value={branchId} onChange={(e) => setBranchId(e.target.value)} wrapperClassName="w-auto min-w-40">
                <option value="">Todas las sucursales</option>
                {sucursales.map((b) => (
                  <option key={b.propertyId} value={b.propertyId}>
                    {b.name}
                  </option>
                ))}
              </Selector>
            </FormField>
          )}
        </div>
        <div className="flex items-end gap-2">
          {puedeImportar && (
            <Button type="button" size="sm" variant="outline" onClick={() => setImportando(true)}>
              <Upload className="mr-1 h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Importar clientes
            </Button>
          )}
          {/* R-17: exporta TODOS los clientes que coinciden con la búsqueda vigente (no solo los 50 en pantalla). Solo owner/admin. */}
          <BotonExportar role={role} token={token} urlPara={(formato) => urlExportarClientes(apiBaseUrl, propertyId, formato, search || undefined)} />
        </div>
      </div>

      {!filtrosDisponibles && (
        <Callout tone="neutral" titulo="Filtros de cartera no disponibles aún" data-testid="clientes-filtros-sin-migracion">
          Los filtros por nivel, frecuencia, días sin pedir y sucursal requieren la migración 054 de restaurantes en esta base de datos.
        </Callout>
      )}
      {error && <EstadoError mensaje={error} />}
      {!customers && !error && <EstadoCargando etiqueta="Cargando clientes…" />}
      {customers && customers.length === 0 && filtrosDisponibles && <EstadoVacio mensaje={hayFiltros ? "Ningún cliente coincide con estos filtros." : "Todavía no hay clientes: aparecen con su primer pedido o al importar tu cartera."} />}

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
        {customers?.map((c) => {
          const dias = diasDesde(c.lastOrderAt);
          return (
            <Link
              key={c.id}
              to={`/restaurantes/${orgSlug}/clientes/${c.id}`}
              className="block rounded-lg no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <Card className="h-full transition-colors hover:bg-muted/50">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="m-0 font-semibold text-foreground">{c.name ?? c.phone}</p>
                    {c.tier && (
                      <StatusBadge dot={false} tone={statusTone(CUSTOMER_TIER_TONES, c.tier)} className={`gap-1 px-2 py-0.5 ${tierBadgeClase(c.tier) ?? ""}`}>
                        <span aria-hidden>{CUSTOMER_TIER_META[c.tier].glyph}</span>
                        {CUSTOMER_TIER_META[c.tier].label}
                      </StatusBadge>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {c.phone} · {c.orderCount} pedido{c.orderCount === 1 ? "" : "s"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{dias === null ? "Aún no ha pedido" : dias === 0 ? "Pidió hoy" : `Último pedido hace ${dias} d`}</p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
      {nextCursor && (
        <div className="flex justify-center">
          <Button type="button" size="sm" variant="outline" onClick={() => void verMas()} loading={cargandoMas}>
            Ver más clientes
          </Button>
        </div>
      )}

      <ImportarClientesDialog open={importando} onOpenChange={setImportando} apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} onTerminado={() => setVersion((v) => v + 1)} />
    </PageContainer>
  );
}

// La ficha completa (Cliente 360, migracion 049) vive en ClienteFicha.tsx.
export { ClienteFichaPage } from "./ClienteFicha.tsx";
export type { ClienteFichaPageProps } from "./ClienteFicha.tsx";
