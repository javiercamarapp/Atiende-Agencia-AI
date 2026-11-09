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
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormField,
  Input,
  Label,
  Selector,
  PageContainer,
  SectionLabel,
  StatCard,
  StatusBadge,
  formatMoney,
  statusTone,
  useT,
} from "@atiende/ui";
import { restaurantesClientes } from "@atiende/ui/i18n/restaurantes/clientes";
import { Crown, Receipt, Repeat, Search, Upload, Users } from "lucide-react";
import { fetchBranches } from "../dashboard-client.ts";
import type { BranchOption } from "../dashboard-client.ts";
import { fetchCarteraKpis, fetchCustomers, fetchDistribucionTier } from "../lib/customers-client.ts";
import type { CarteraKpisWire, CustomerSummary, DistribucionTierWire, CustomerTier, FrecuenciaCliente } from "../lib/customers-client.ts";
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
  const t = useT(restaurantesClientes);
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
  const [distribucion, setDistribucion] = useState<DistribucionTierWire | null | "error">(null);
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

  // Distribucion por nivel (cartera completa de la organizacion). Si falla, se dice «no disponible» sin tumbar la lista.
  useEffect(() => {
    let cancelado = false;
    fetchDistribucionTier(fetch, apiBaseUrl, token, propertyId)
      .then((d) => !cancelado && setDistribucion(d))
      .catch(() => !cancelado && setDistribucion("error"));
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
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : t("restaurantes.clientes.errorCargar")));
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
      setError(err instanceof Error ? err.message : t("restaurantes.clientes.errorCargarMas"));
    } finally {
      setCargandoMas(false);
    }
  }

  const hayFiltros = nivel !== "" || frecuencia !== "" || inactivoDias !== "" || branchId !== "" || search !== "";
  const k = kpis && kpis.disponible ? kpis : null;

  return (
    <PageContainer padding="none">
      <h1 className="sr-only">{t("restaurantes.clientes.titulo")}</h1>

      {k && (
        <section aria-label={t("restaurantes.clientes.kpis.aria")} className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]" data-testid="cartera-kpis">
          <StatCard icon={Users} label={t("restaurantes.clientes.kpis.clientes")} value={String(k.total ?? 0)} nota={t("restaurantes.clientes.kpis.carteraTotal")} variante="neutra" />
          <StatCard icon={Repeat} label={t("restaurantes.clientes.kpis.recurrentes")} value={String(k.recurrentes ?? 0)} nota={t("restaurantes.clientes.kpis.recurrentesNota")} variante="neutra" />
          <StatCard
            icon={Receipt}
            label={t("restaurantes.clientes.kpis.ticket")}
            value={k.ticketPromedio === null || k.ticketPromedio === undefined ? "—" : `$${formatMoney(k.ticketPromedio)}`}
            nota={t(k.ticketPromedio === null || k.ticketPromedio === undefined ? "restaurantes.clientes.kpis.sinPedidos" : "restaurantes.clientes.kpis.pedidosVigentes")}
            variante="neutra"
          />
          <StatCard
            icon={Crown}
            label={t("restaurantes.clientes.kpis.masFrecuente")}
            value={k.masFrecuente ? t("restaurantes.clientes.kpis.nPedidos", { n: k.masFrecuente.pedidos }) : "—"}
            nota={
              k.masFrecuente
                ? `${k.masFrecuente.nombre ?? t("restaurantes.clientes.sinNombre")} (${k.masFrecuente.telefonoEnmascarado})${k.masFrecuente.diasDesdeUltimoPedido === null ? "" : t("restaurantes.clientes.kpis.ultimoPedidoHace", { dias: k.masFrecuente.diasDesdeUltimoPedido })}`
                : t("restaurantes.clientes.kpis.nadie")
            }
            variante="neutra"
          />
        </section>
      )}
      <section aria-labelledby="clientes-distribucion-titulo" className="flex flex-wrap items-center gap-2" data-testid="distribucion-tier">
        <SectionLabel as="h2" id="clientes-distribucion-titulo">
          {t("restaurantes.clientes.distribucion.titulo")}
        </SectionLabel>
        {distribucion === null && (
          <span role="status" className="text-xs text-muted-foreground">
            {t("restaurantes.clientes.distribucion.cargando")}
          </span>
        )}
        {distribucion === "error" && (
          <span role="status" className="text-xs text-muted-foreground">
            {t("restaurantes.clientes.distribucion.noDisponible")}
          </span>
        )}
        {distribucion !== null && distribucion !== "error" && (
          <>
            {NIVELES.map((n) => (
              <StatusBadge key={n} dot={false} tone={statusTone(CUSTOMER_TIER_TONES, n)} className={`gap-1 px-2 py-0.5 ${tierBadgeClase(n) ?? ""}`}>
                <span aria-hidden>{CUSTOMER_TIER_META[n].glyph}</span>
                {CUSTOMER_TIER_META[n].label} · {distribucion[n]}
              </StatusBadge>
            ))}
            {distribucion.withoutTier > 0 && <span className="text-xs text-muted-foreground">{t("restaurantes.clientes.distribucion.sinNivel", { n: distribucion.withoutTier })}</span>}
            {distribucion.metric === "sin_datos" && <span className="text-xs text-muted-foreground">{t("restaurantes.clientes.distribucion.sinDatos")}</span>}
            {distribucion.metric === "frecuencia" && (
              <span className="text-xs text-muted-foreground" data-testid="distribucion-tier-nota">
                {t("restaurantes.clientes.distribucion.porFrecuencia")}
              </span>
            )}
            <span className="text-xs text-muted-foreground">{t("restaurantes.clientes.distribucion.noCambia")}</span>
          </>
        )}
      </section>
      {kpis && !kpis.disponible && (
        <Callout tone="neutral" titulo={t("restaurantes.clientes.kpisNoDisponible")} data-testid="cartera-kpis-sin-migracion">
          {t("restaurantes.clientes.requiereMigracion")}
        </Callout>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full max-w-xs">
            <Label htmlFor="restaurantes-clientes-buscar" className="mb-1.5 block text-xs text-muted-foreground">
              {t("restaurantes.clientes.buscar")}
            </Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
              <Input
                id="restaurantes-clientes-buscar"
                placeholder={t("restaurantes.clientes.buscarPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
          <FormField label={t("restaurantes.clientes.filtro.nivel")}>
            <Selector id="restaurantes-clientes-nivel" size="sm" value={nivel} onChange={(e) => setNivel(e.target.value as CustomerTier | "")} wrapperClassName="w-auto min-w-36">
              <option value="">{t("restaurantes.clientes.filtro.todosNiveles")}</option>
              {NIVELES.map((n) => (
                <option key={n} value={n}>
                  {CUSTOMER_TIER_META[n].label}
                </option>
              ))}
            </Selector>
          </FormField>
          <FormField label={t("restaurantes.clientes.filtro.frecuencia")}>
            <Selector id="restaurantes-clientes-frecuencia" size="sm" value={frecuencia} onChange={(e) => setFrecuencia(e.target.value as FrecuenciaCliente | "")} wrapperClassName="w-auto min-w-40">
              <option value="">{t("restaurantes.clientes.filtro.cualquiera")}</option>
              <option value="una_vez">{t("restaurantes.clientes.filtro.unaVez")}</option>
              <option value="recurrentes">{t("restaurantes.clientes.filtro.recurrentes")}</option>
            </Selector>
          </FormField>
          <FormField label={t("restaurantes.clientes.filtro.sinPedirEn")}>
            <Selector id="restaurantes-clientes-inactivo" size="sm" value={String(inactivoDias)} onChange={(e) => setInactivoDias(e.target.value === "" ? "" : Number(e.target.value))} wrapperClassName="w-auto min-w-36">
              <option value="">{t("restaurantes.clientes.filtro.cualquierMomento")}</option>
              {DIAS_SIN_PEDIR.map((d) => (
                <option key={d} value={d}>
                  {t("restaurantes.clientes.filtro.dias", { d })}
                </option>
              ))}
            </Selector>
          </FormField>
          {sucursales.length > 1 && (
            <FormField label={t("restaurantes.clientes.filtro.sucursal")}>
              <Selector id="restaurantes-clientes-sucursal" size="sm" value={branchId} onChange={(e) => setBranchId(e.target.value)} wrapperClassName="w-auto min-w-40">
                <option value="">{t("restaurantes.clientes.filtro.todasSucursales")}</option>
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
              {t("restaurantes.clientes.importar")}
            </Button>
          )}
          {/* R-17: exporta TODOS los clientes que coinciden con la búsqueda vigente (no solo los 50 en pantalla). Solo owner/admin. */}
          <BotonExportar role={role} token={token} urlPara={(formato) => urlExportarClientes(apiBaseUrl, propertyId, formato, search || undefined)} />
        </div>
      </div>

      {!filtrosDisponibles && (
        <Callout tone="neutral" titulo={t("restaurantes.clientes.filtrosNoDisponibles")} data-testid="clientes-filtros-sin-migracion">
          {t("restaurantes.clientes.filtrosRequieren")}
        </Callout>
      )}
      {error && <EstadoError mensaje={error} onReintentar={() => setVersion((v) => v + 1)} />}
      {!customers && !error && <EstadoCargando etiqueta={t("restaurantes.clientes.cargando")} />}
      {customers && customers.length === 0 && filtrosDisponibles && <EstadoVacio mensaje={t(hayFiltros ? "restaurantes.clientes.vacioFiltros" : "restaurantes.clientes.vacio")} />}

      {customers && customers.length > 0 && (
        <section aria-labelledby="clientes-lista-titulo" className="flex flex-col gap-2">
          <h2 id="clientes-lista-titulo" className="sr-only">
            {t("restaurantes.clientes.lista")}
          </h2>
          <SectionLabel as="p" className="px-1">
            <span data-testid="clientes-total">{t(nextCursor ? "restaurantes.clientes.totalHayMas" : "restaurantes.clientes.totalEnTotal", { count: customers.length })}</span>
          </SectionLabel>
          <Card className="overflow-hidden p-0">
            <ul className="m-0 list-none divide-y divide-dashed divide-border p-0">
              {customers.map((c) => {
                const dias = diasDesde(c.lastOrderAt);
                const resumenPedidos = `${t("restaurantes.clientes.pedidos", { count: c.orderCount })} · ${dias === null ? t("restaurantes.clientes.aunNoPide") : dias === 0 ? t("restaurantes.clientes.pidioHoy") : t("restaurantes.clientes.haceDias", { dias })}`;
                return (
                  <li key={c.id}>
                    <Link
                      to={`/restaurantes/${orgSlug}/clientes/${c.id}`}
                      className="flex items-center gap-3 px-3 py-2.5 no-underline transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <Users className="size-4" strokeWidth={1.75} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui font-medium text-foreground">{c.name ?? c.phone}</span>
                        <span className="block truncate text-xs text-muted-foreground">{c.phone}</span>
                        <span className="block truncate text-xs text-muted-foreground sm:hidden">{resumenPedidos}</span>
                      </span>
                      <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{resumenPedidos}</span>
                      {c.tier && (
                        <StatusBadge dot={false} tone={statusTone(CUSTOMER_TIER_TONES, c.tier)} className={`shrink-0 gap-1 px-2 py-0.5 ${tierBadgeClase(c.tier) ?? ""}`}>
                          <span aria-hidden>{CUSTOMER_TIER_META[c.tier].glyph}</span>
                          {CUSTOMER_TIER_META[c.tier].label}
                        </StatusBadge>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        </section>
      )}
      {nextCursor && (
        <div className="flex justify-center">
          <Button type="button" size="sm" variant="outline" onClick={() => void verMas()} loading={cargandoMas}>
            {t("restaurantes.clientes.verMas")}

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
