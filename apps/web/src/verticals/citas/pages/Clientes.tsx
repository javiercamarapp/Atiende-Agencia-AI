// Clientes del panel de citas (Fase 5) — lista paginada con búsqueda + ficha con
// citas próximas reales (customers-client.ts). El cliente se crea/actualiza solo
// implícitamente al reservar (upsertCustomer, Fase 1) — el panel nunca crea/edita
// un cliente directamente.
//
// Presentación real (Fase de diseño): la lista artesanal de `<Link style={{…}}>` y
// los botones de paginación con hex en línea se cambian por los primitivos reales
// de @atiende/ui (Card/Table/Input/Button) — la lógica de paginación, búsqueda y
// fetch de arriba es exactamente la misma.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, CalendarClock, ChevronLeft, ChevronRight, Mail, Pencil, Search, Users } from "lucide-react";
import {
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useT,
} from "@atiende/ui";
import { citasClientes } from "@atiende/ui/i18n/citas/clientes";
import { citasComun } from "@atiende/ui/i18n/citas/comun";
import { fetchCustomerDetail, fetchCustomers, updateCustomerEmail } from "../lib/customers-client.ts";
import type { CustomerDetail, CustomerSummary } from "../lib/customers-client.ts";
import { formatDateTime } from "../lib/format.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

const PAGE_SIZE = 20;

export function ClientesListPage({ apiBaseUrl, token, propertyId, orgSlug }: CitasShellContext) {
  const t = useT(citasComun, citasClientes);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [customers, setCustomers] = useState<readonly CustomerSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetchCustomers(fetch, apiBaseUrl, token, propertyId, { limit: PAGE_SIZE, offset, search: search || undefined })
      .then((page) => {
        if (cancelado) return;
        setCustomers(page.items);
        setTotal(page.total);
        setNextOffset(page.nextOffset);
      })
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : t("citas.clientes.errorLista")));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, offset, search]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-xl font-semibold text-foreground">{t("citas.clientes.titulo")}</h1>
        <div className="relative min-w-[220px]">
          <Label htmlFor="citas-clientes-buscar" className="sr-only">
            {t("citas.clientes.buscar")}
          </Label>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="citas-clientes-buscar"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
            placeholder={t("citas.clientes.buscarPlaceholder")}
            className="pl-9"
          />
        </div>
      </header>

      {error && <EstadoError mensaje={error} />}
      {!customers && !error && <EstadoCargando etiqueta={t("citas.clientes.cargandoLista")} />}
      {customers && customers.length === 0 && (
        <EstadoVacio icon={Users} mensaje={search ? t("citas.clientes.sinCoincidencias") : t("citas.clientes.sinClientes")} />
      )}

      {customers && customers.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("citas.clientes.col.cliente")}</TableHead>
                  <TableHead className="text-right">{t("citas.clientes.col.contacto")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-semibold text-foreground">
                      <Link to={`/citas/${orgSlug}/clientes/${c.id}`} className="hover:underline">
                        {c.fullName}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {c.phone}
                      {c.email ? ` · ${c.email}` : ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {customers && customers.length > 0 && (
        <footer className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>
            {t("citas.clientes.rango", { desde: offset + 1, hasta: offset + customers.length, total })}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>
              <ChevronLeft aria-hidden />
              {t("citas.anterior")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => nextOffset !== null && setOffset(nextOffset)} disabled={nextOffset === null}>
              {t("citas.siguiente")}
              <ChevronRight aria-hidden />
            </Button>
          </div>
        </footer>
      )}
    </div>
  );
}

export interface ClienteFichaPageProps extends CitasShellContext {
  readonly customerId: string;
}

export function ClienteFichaPage({ apiBaseUrl, token, propertyId, orgSlug, customerId }: ClienteFichaPageProps) {
  const t = useT(citasComun, citasClientes);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fase 6 §2 (seguimiento, "citas-sync-errores-visibles") — edición del correo
  // OPCIONAL del cliente: `citas.customers.email` existía desde Fase 1 pero nunca
  // era editable después de la primera reserva. Relevante para calendar-sync.ts:
  // Cal.com puede exigir el correo del cliente para sincronizar una cita; sin
  // esto, el staff no tenía forma de agregárselo a un cliente que ya existía sin
  // uno (ver Agenda.tsx, botón "Reintentar sincronización").
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetchCustomerDetail(fetch, apiBaseUrl, token, propertyId, customerId)
      .then((d) => !cancelado && setDetail(d))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : t("citas.clientes.errorFicha")));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, customerId]);

  function startEditingEmail() {
    setEmailInput(detail?.customer.email ?? "");
    setEmailError(null);
    setEditingEmail(true);
  }

  async function handleSaveEmail(e: FormEvent) {
    e.preventDefault();
    setSavingEmail(true);
    setEmailError(null);
    try {
      const updated = await updateCustomerEmail(fetch, apiBaseUrl, token, propertyId, customerId, emailInput.trim() || null);
      setDetail((prev) => (prev ? { ...prev, customer: updated } : prev));
      setEditingEmail(false);
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : t("citas.clientes.errorCorreo"));
    } finally {
      setSavingEmail(false);
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <Button asChild variant="ghost" size="sm" className="w-fit px-2 text-muted-foreground">
        <Link to={`/citas/${orgSlug}/clientes`}>
          <ArrowLeft aria-hidden />
          {t("citas.clientes.volver")}
        </Link>
      </Button>
      {error && <EstadoError mensaje={error} />}
      {!detail && !error && <EstadoCargando etiqueta={t("citas.clientes.cargandoFicha")} />}
      {detail && (
        <>
          <header>
            <h1 className="font-display text-xl font-semibold text-foreground">{detail.customer.fullName}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{detail.customer.phone}</p>
            {editingEmail ? (
              <form onSubmit={handleSaveEmail} className="mt-2 flex flex-wrap items-center gap-2">
                <Label htmlFor="citas-cliente-correo" className="sr-only">
                  {t("citas.clientes.correoCliente")}
                </Label>
                <Input
                  id="citas-cliente-correo"
                  type="email"
                  placeholder={t("citas.correoOpcional")}
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  className="h-9 max-w-xs"
                  autoFocus
                />
                <Button type="submit" size="sm" disabled={savingEmail}>
                  {savingEmail ? t("citas.clientes.guardando") : t("citas.clientes.guardar")}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setEditingEmail(false)} disabled={savingEmail}>
                  {t("citas.cancelar")}
                </Button>
              </form>
            ) : (
              <button
                type="button"
                onClick={startEditingEmail}
                className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                <Mail aria-hidden className="size-3.5" />
                {detail.customer.email ?? t("citas.clientes.agregarCorreo")}
                <Pencil aria-hidden className="size-3" />
              </button>
            )}
            {emailError && (
              <p role="alert" className="mt-1 text-sm text-destructive">
                {emailError}
              </p>
            )}
          </header>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-xs uppercase tracking-[0.06em] text-muted-foreground">{t("citas.clientes.proximas")}</CardTitle>
            </CardHeader>
            <CardContent>
              {detail.upcomingAppointments.length === 0 ? (
                <EstadoVacio icon={CalendarClock} mensaje={t("citas.clientes.sinProximas")} />
              ) : (
                <div className="flex flex-col gap-2">
                  {detail.upcomingAppointments.map((apt) => (
                    <div key={apt.id} className="rounded-lg border border-border bg-card p-3">
                      <p className="text-sm font-semibold text-foreground">{apt.serviceName ?? t("citas.servicioDesconocido")}</p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {formatDateTime(apt.startsAt)} · {apt.providerName ?? t("citas.proveedorDesconocido")}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
