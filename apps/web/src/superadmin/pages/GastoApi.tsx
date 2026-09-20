// Control de gasto de API de LLM — primera pieza del "cerebro" de backoffice
// pedido por el dueño. Backend real: GET/PUT /superadmin/gasto-api/*
// (apps/api/src/routes/superadmin-llm-usage.ts, ya verificadas contra las
// funciones security definer de core.llm_usage_daily/core.llm_org_budget/
// core.llm_platform_budget). Mismo patrón de sesión/manejo de errores que
// Prospectos.tsx: sin librerías de gráficas nuevas (el repo no tiene
// ninguna) -- barras simples con CSS para el % de tope usado.
//
// Sin credenciales de LLM configuradas en el ambiente, el gateway real nunca
// se construye (ver production/llm-gateway.ts) así que nunca se registra
// ningún uso -- esta pantalla sigue funcionando igual y muestra ceros reales
// (nunca datos inventados, ver los estados vacíos de abajo).
import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, DollarSign, Gauge, Hash, Pencil } from "lucide-react";
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
  StatCard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  formatMoney,
} from "@atiende/ui";
import { ModalFormularioLateral } from "../../components/ModalFormularioLateral.tsx";
import { hoyFechaSolo, sumarDiasFechaSolo } from "../../lib/formato-fecha.ts";

interface RangoFechas {
  readonly from: string;
  readonly to: string;
}

interface Resumen {
  readonly range: RangoFechas;
  readonly usage: { readonly tokensIn: number; readonly tokensOut: number; readonly costMicroUsd: number; readonly callCount: number; readonly fallbackCallCount: number };
  readonly platformBudget: { readonly monthlyCapMicroUsd: number; readonly alertThresholdPct: number; readonly spendThisMonthMicroUsd: number };
}

interface OrganizacionGasto {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly vertical: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costMicroUsd: number;
  readonly callCount: number;
  readonly monthlyCapMicroUsd: number;
  readonly alertThresholdPct: number;
  readonly spendThisMonthMicroUsd: number;
  readonly pctTopeUsado: number;
}

interface DesgloseFila {
  readonly vertical: string;
  readonly providerId: string;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costMicroUsd: number;
  readonly callCount: number;
}

const NOMBRE_VERTICAL: Record<string, string> = {
  hoteles: "Hoteles",
  restaurantes: "Restaurantes",
  citas: "Citas",
  licitaciones: "Licitaciones",
  despachos: "Despachos",
  rentas: "Rentas vacacionales",
};

function usd(microUsd: number): string {
  return `$${formatMoney(microUsd / 1_000_000, 2)}`;
}

// Bug real (barrido del hallazgo de auditoría a4, mismo patrón exacto que
// Dashboard.tsx/hoteles): `from`/`to` SIEMPRE viajan explícitos en la query
// string de `GET .../gasto-api/*` (`cargar()` de abajo), así que el default
// UTC de `parseDateRange` en el servidor (superadmin-llm-usage.ts) nunca se
// ejecuta desde esta pantalla -- `new Date().toISOString().slice(0, 10)` (día
// UTC) precargaba MAÑANA en vez de HOY entre las 18:00 y las 23:59 hora de
// CDMX (00:00-05:59 UTC). `hoyFechaSolo()`/`sumarDiasFechaSolo()`
// (apps/web/src/lib/formato-fecha.ts) usan el día de calendario en
// America/Mexico_City, nunca el día UTC.
function hoyIso(): string {
  return hoyFechaSolo();
}

function hace30DiasIso(): string {
  return sumarDiasFechaSolo(hoyFechaSolo(), -29);
}

function BarraTope({ pct, alerta }: { readonly pct: number; readonly alerta: boolean }) {
  const anchoPct = Math.min(100, Math.max(0, pct));
  const color = pct >= 100 ? "bg-destructive" : alerta ? "bg-amber-500" : "bg-primary";
  return (
    <div className="flex flex-col gap-1 min-w-[120px]">
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${anchoPct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">{pct.toFixed(1)}% del tope</span>
    </div>
  );
}

async function fetchJson<T>(apiBaseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "No se pudo completar la solicitud.");
  }
  return res.json() as Promise<T>;
}

export function SuperAdminGastoApiPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [from, setFrom] = useState(hace30DiasIso());
  const [to, setTo] = useState(hoyIso());
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [organizaciones, setOrganizaciones] = useState<readonly OrganizacionGasto[] | null>(null);
  const [desglose, setDesglose] = useState<readonly DesgloseFila[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const [editando, setEditando] = useState<OrganizacionGasto | null>(null);
  const [editandoTope, setEditandoTope] = useState("");
  const [editandoAlerta, setEditandoAlerta] = useState("80");
  const [guardando, setGuardando] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [editandoPlataforma, setEditandoPlataforma] = useState(false);
  const [topePlataforma, setTopePlataforma] = useState("");
  const [alertaPlataforma, setAlertaPlataforma] = useState("80");

  async function cargar() {
    setError(null);
    setCargando(true);
    try {
      const qs = `?from=${from}&to=${to}`;
      const [r, orgs, d] = await Promise.all([
        fetchJson<Resumen>(apiBaseUrl, token, `/superadmin/gasto-api/resumen${qs}`),
        fetchJson<{ organizaciones: OrganizacionGasto[] }>(apiBaseUrl, token, `/superadmin/gasto-api/organizaciones${qs}`),
        fetchJson<{ desglose: DesgloseFila[] }>(apiBaseUrl, token, `/superadmin/gasto-api/desglose${qs}`),
      ]);
      setResumen(r);
      setOrganizaciones(orgs.organizaciones);
      setDesglose(d.desglose);
    } catch {
      setError("No se pudo cargar el gasto de API de LLM.");
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    void cargar();
  }, [apiBaseUrl, token, from, to]);

  function abrirEdicion(org: OrganizacionGasto) {
    setEditando(org);
    setEditandoTope(String(org.monthlyCapMicroUsd / 1_000_000));
    setEditandoAlerta(String(org.alertThresholdPct));
    setFormError(null);
  }

  async function guardarTopeOrganizacion(e: FormEvent) {
    e.preventDefault();
    if (!editando) return;
    const monto = Number(editandoTope);
    if (!Number.isFinite(monto) || monto <= 0) {
      setFormError("El tope mensual debe ser un número positivo (USD).");
      return;
    }
    setFormError(null);
    setGuardando(true);
    try {
      await fetchJson(apiBaseUrl, token, `/superadmin/gasto-api/organizaciones/${editando.organizationId}/tope`, {
        method: "PUT",
        body: JSON.stringify({ monthlyCapUsd: monto, alertThresholdPct: Number(editandoAlerta) || 80 }),
      });
      setEditando(null);
      await cargar();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo guardar el tope.");
    } finally {
      setGuardando(false);
    }
  }

  function abrirEdicionPlataforma() {
    if (!resumen) return;
    setTopePlataforma(String(resumen.platformBudget.monthlyCapMicroUsd / 1_000_000));
    setAlertaPlataforma(String(resumen.platformBudget.alertThresholdPct));
    setFormError(null);
    setEditandoPlataforma(true);
  }

  async function guardarTopePlataforma(e: FormEvent) {
    e.preventDefault();
    const monto = Number(topePlataforma);
    if (!Number.isFinite(monto) || monto <= 0) {
      setFormError("El tope global debe ser un número positivo (USD).");
      return;
    }
    setFormError(null);
    setGuardando(true);
    try {
      await fetchJson(apiBaseUrl, token, "/superadmin/gasto-api/plataforma/tope", {
        method: "PUT",
        body: JSON.stringify({ monthlyCapUsd: monto, alertThresholdPct: Number(alertaPlataforma) || 80 }),
      });
      setEditandoPlataforma(false);
      await cargar();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo guardar el tope de plataforma.");
    } finally {
      setGuardando(false);
    }
  }

  if (error && !resumen) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!resumen || !organizaciones || !desglose) return <EstadoCargando etiqueta="Cargando gasto de API de LLM…" />;

  const pctPlataforma = resumen.platformBudget.monthlyCapMicroUsd > 0 ? (resumen.platformBudget.spendThisMonthMicroUsd / resumen.platformBudget.monthlyCapMicroUsd) * 100 : 0;
  const alertaPlataformaActiva = pctPlataforma >= resumen.platformBudget.alertThresholdPct;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Gasto de API de LLM</h1>
          <p className="text-sm text-muted-foreground mt-1">Control de gasto real de las 6 verticales — tokens, costo, proveedor y modelo por organización.</p>
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <div className="flex flex-col gap-1">
            <Label htmlFor="gasto-from" className="text-xs">
              Desde
            </Label>
            <Input id="gasto-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-[160px]" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="gasto-to" className="text-xs">
              Hasta
            </Label>
            <Input id="gasto-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-[160px]" />
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Gasto del periodo" value={usd(resumen.usage.costMicroUsd)} icon={DollarSign} />
        <StatCard label="Llamadas al LLM" value={String(resumen.usage.callCount)} icon={Hash} />
        <StatCard label="Tokens in / out" value={`${resumen.usage.tokensIn.toLocaleString("es-MX")} / ${resumen.usage.tokensOut.toLocaleString("es-MX")}`} icon={Gauge} />
        <StatCard label="Llamadas con fallback" value={String(resumen.usage.fallbackCallCount)} icon={AlertTriangle} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle>Tope global de plataforma (este mes)</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              {usd(resumen.platformBudget.spendThisMonthMicroUsd)} de {usd(resumen.platformBudget.monthlyCapMicroUsd)}
              {alertaPlataformaActiva && (
                <Badge variant="destructive" className="ml-2">
                  Umbral de alerta superado
                </Badge>
              )}
            </p>
          </div>
          <Button variant="outline" className="rounded-full gap-1.5" onClick={abrirEdicionPlataforma}>
            <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
            Editar tope
          </Button>
        </CardHeader>
        <CardContent>
          <BarraTope pct={pctPlataforma} alerta={alertaPlataformaActiva} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Gasto por organización</CardTitle>
        </CardHeader>
        <CardContent>
          {organizaciones.length === 0 ? (
            <EstadoVacio mensaje="Todavía no hay organizaciones dadas de alta en ninguna vertical." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Organización</TableHead>
                    <TableHead>Vertical</TableHead>
                    <TableHead>Gasto del periodo</TableHead>
                    <TableHead>Llamadas</TableHead>
                    <TableHead>Tope usado este mes</TableHead>
                    <TableHead>Tope mensual</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {organizaciones.map((org) => (
                    <TableRow key={org.organizationId}>
                      <TableCell>
                        <span className="font-medium text-foreground">{org.organizationName}</span>
                        <span className="block text-xs text-muted-foreground">{org.organizationSlug}</span>
                      </TableCell>
                      <TableCell>{NOMBRE_VERTICAL[org.vertical] ?? org.vertical}</TableCell>
                      <TableCell>
                        {usd(org.costMicroUsd)}
                        {org.tokensIn + org.tokensOut > 0 && (
                          <span className="block text-xs text-muted-foreground">
                            {org.tokensIn.toLocaleString("es-MX")} in / {org.tokensOut.toLocaleString("es-MX")} out
                          </span>
                        )}
                      </TableCell>
                      <TableCell>{org.callCount}</TableCell>
                      <TableCell>
                        <BarraTope pct={org.pctTopeUsado} alerta={org.pctTopeUsado >= org.alertThresholdPct} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">{usd(org.monthlyCapMicroUsd)}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => abrirEdicion(org)}>
                          <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
                          Editar
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Desglose por proveedor y modelo</CardTitle>
        </CardHeader>
        <CardContent>
          {desglose.length === 0 ? (
            <EstadoVacio mensaje="Sin llamadas al LLM registradas en este rango de fechas todavía." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vertical</TableHead>
                    <TableHead>Proveedor</TableHead>
                    <TableHead>Modelo</TableHead>
                    <TableHead>Tokens in / out</TableHead>
                    <TableHead>Llamadas</TableHead>
                    <TableHead>Costo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {desglose.map((d) => (
                    <TableRow key={`${d.vertical}|${d.providerId}|${d.model}`}>
                      <TableCell>{NOMBRE_VERTICAL[d.vertical] ?? d.vertical}</TableCell>
                      <TableCell>{d.providerId}</TableCell>
                      <TableCell className="text-muted-foreground">{d.model}</TableCell>
                      <TableCell>
                        {d.tokensIn.toLocaleString("es-MX")} / {d.tokensOut.toLocaleString("es-MX")}
                      </TableCell>
                      <TableCell>{d.callCount}</TableCell>
                      <TableCell className="font-medium text-foreground">{usd(d.costMicroUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ModalFormularioLateral
        open={editando !== null}
        onOpenChange={(open) => {
          if (!open) setEditando(null);
        }}
        titulo="Editar tope mensual"
        subtitulo={editando ? `${editando.organizationName} — tope de gasto de API de LLM` : undefined}
        anchoClase="max-w-lg"
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setEditando(null)} disabled={guardando}>
              Cancelar
            </Button>
            <Button type="submit" form="form-tope-organizacion" className="rounded-full px-6" disabled={guardando}>
              {guardando ? "Guardando…" : "Guardar tope"}
            </Button>
          </>
        }
      >
        <form id="form-tope-organizacion" onSubmit={guardarTopeOrganizacion} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tope-organizacion-monto">Tope mensual (USD)</Label>
            <Input id="tope-organizacion-monto" type="number" min="1" step="0.01" value={editandoTope} onChange={(e) => setEditandoTope(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tope-organizacion-alerta">Umbral de alerta (%)</Label>
            <Input id="tope-organizacion-alerta" type="number" min="1" max="100" value={editandoAlerta} onChange={(e) => setEditandoAlerta(e.target.value)} />
          </div>
          {formError && (
            <p role="alert" className="text-[13px] text-destructive">
              {formError}
            </p>
          )}
        </form>
      </ModalFormularioLateral>

      <ModalFormularioLateral
        open={editandoPlataforma}
        onOpenChange={(open) => setEditandoPlataforma(open)}
        titulo="Editar tope global de plataforma"
        subtitulo="Protege el gasto TOTAL entre todas las organizaciones."
        anchoClase="max-w-lg"
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setEditandoPlataforma(false)} disabled={guardando}>
              Cancelar
            </Button>
            <Button type="submit" form="form-tope-plataforma" className="rounded-full px-6" disabled={guardando}>
              {guardando ? "Guardando…" : "Guardar tope"}
            </Button>
          </>
        }
      >
        <form id="form-tope-plataforma" onSubmit={guardarTopePlataforma} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tope-plataforma-monto">Tope mensual global (USD)</Label>
            <Input id="tope-plataforma-monto" type="number" min="1" step="0.01" value={topePlataforma} onChange={(e) => setTopePlataforma(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tope-plataforma-alerta">Umbral de alerta (%)</Label>
            <Input id="tope-plataforma-alerta" type="number" min="1" max="100" value={alertaPlataforma} onChange={(e) => setAlertaPlataforma(e.target.value)} />
          </div>
          {formError && (
            <p role="alert" className="text-[13px] text-destructive">
              {formError}
            </p>
          )}
        </form>
      </ModalFormularioLateral>

      {cargando && <p className="text-xs text-muted-foreground">Actualizando…</p>}
    </div>
  );
}
