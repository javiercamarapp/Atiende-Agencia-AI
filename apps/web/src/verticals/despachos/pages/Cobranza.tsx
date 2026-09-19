// Panel de cobranza (Fase 10) -- hallazgo de auditoría (severidad ALTA):
// "Cobranza tiene motor + persistencia completos (aging/score de
// cobrabilidad/proyección/resumen ejecutivo, más el correo real de
// recordatorio construido en la ronda 2) pero cero rutas HTTP y cero UI".
// Antes de esta fase, el ÚNICO camino para disparar un recordatorio de
// cobranza era el barrido interno de worker
// (`POST /internal/despachos/cobranza-reminders`, gateado por secreto
// compartido) -- ningún humano podía ni ver la cartera ni mandar un
// recordatorio fuera de su fecha exacta. Esta página cierra las 2 mitades del
// gap: lectura real de la cartera (resumen ejecutivo + tabla con aging/score
// ya calculados por `@atiende/domain-despachos::resumenCobranza`) y las 3
// acciones reales que el repositorio ya soportaba sin ruta
// (registerReceivable/markReceivablePaid/el envío real de recordatorio, ver
// cobranza-client.ts).
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { AlarmClock, AlertTriangle, CheckCircle2, Clock, HandCoins, Hourglass, Send, TrendingUp, Wallet } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
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
} from "@atiende/ui";
import { ModalFormularioLateral } from "../../../components/ModalFormularioLateral.tsx";
import { fetchInvoices } from "../lib/cfdi-client.ts";
import type { InvoiceSummary } from "../lib/cfdi-client.ts";
import {
  COBRANZA_REMINDER_STAGES,
  enviarRecordatorioCobranza,
  fetchCuentasCobranza,
  fetchResumenCobranza,
  marcarCuentaPagada,
  registrarCuentaCobranza,
} from "../lib/cobranza-client.ts";
import type { CobranzaAgeBucket, CobranzaReminderStage, CuentaCobranza, ResumenCobranza } from "../lib/cobranza-client.ts";
import { formatDate, formatMoney } from "../lib/format.ts";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const GESTIONAR_ROLES = new Set(["admin", "contador"]);

const BUCKET_LABELS: Record<CobranzaAgeBucket, string> = { "0-30": "0-30 días", "31-60": "31-60 días", "61-90": "61-90 días", "90+": "90+ días" };
// Mismo gradiente semántico de las píldoras inline originales (verde → ámbar →
// naranja → rojo conforme envejece la cuenta), ahora sobre el `Badge` real.
const BUCKET_BADGE: Record<CobranzaAgeBucket, { variant: "destructive" | "outline"; className?: string }> = {
  "0-30": { variant: "outline", className: "border-transparent bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400" },
  "31-60": { variant: "outline", className: "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-400" },
  "61-90": { variant: "outline", className: "border-transparent bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-400" },
  "90+": { variant: "destructive" },
};
const BUCKET_ICONS: Record<CobranzaAgeBucket, typeof Clock> = {
  "0-30": Clock,
  "31-60": Hourglass,
  "61-90": AlarmClock,
  "90+": AlertTriangle,
};
const STAGE_LABELS: Record<CobranzaReminderStage, string> = {
  pre_vencimiento: "Recordatorio amigable (7 días antes)",
  vencimiento: "Vence hoy",
  recordatorio_formal: "Primer recordatorio formal (+7 días)",
  segundo_recordatorio: "Segundo recordatorio (+30 días)",
  escalamiento: "Escalamiento a gerencia (+60 días)",
};

function BucketBadge({ bucket }: { bucket: CobranzaAgeBucket }) {
  const { variant, className } = BUCKET_BADGE[bucket];
  return (
    <Badge variant={variant} className={className}>
      {BUCKET_LABELS[bucket]}
    </Badge>
  );
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = score >= 0.7 ? "text-green-700 dark:text-green-400" : score >= 0.4 ? "text-amber-700 dark:text-amber-400" : "text-destructive";
  const fill = score >= 0.7 ? "bg-green-600 dark:bg-green-500" : score >= 0.4 ? "bg-amber-500" : "bg-destructive";
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full ${fill}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs tabular-nums ${color}`}>{pct}%</span>
    </div>
  );
}

function ResumenCards({ resumen }: { resumen: ResumenCobranza }) {
  const buckets: readonly CobranzaAgeBucket[] = ["0-30", "31-60", "61-90", "90+"];
  return (
    <div className="flex flex-col gap-3">
      {/* Mosaico de KPI sobre el `StatCard` real (mismas 6 cifras, mismas notas). */}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(170px,1fr))]">
        <StatCard icon={Wallet} label="Cartera pendiente" value={formatMoney(resumen.totalCartera)} nota={`${resumen.totalCount} cuenta(s)`} />
        <StatCard icon={TrendingUp} label="Cobro esperado" value={formatMoney(resumen.totalEsperado)} nota={`${resumen.tasaRecuperacionEsperada}% tasa esperada`} />
        {buckets.map((b) => (
          <StatCard
            key={b}
            icon={BUCKET_ICONS[b]}
            label={BUCKET_LABELS[b]}
            value={formatMoney(resumen.porAntiguedad[b].monto)}
            nota={`${resumen.porAntiguedad[b].count} · ${resumen.porAntiguedad[b].porcentaje}%`}
          />
        ))}
      </div>
      {resumen.alertas.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {resumen.alertas.map((a, i) => (
            <p key={i} role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
              {a}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

interface RowActionState {
  readonly loading: boolean;
  readonly message: string | null;
  readonly isError: boolean;
}

export function CobranzaPage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const [cuentas, setCuentas] = useState<readonly CuentaCobranza[] | null>(null);
  const [resumen, setResumen] = useState<ResumenCobranza | null>(null);
  const [invoicesElegibles, setInvoicesElegibles] = useState<readonly InvoiceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [soloPendientes, setSoloPendientes] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [invoiceId, setInvoiceId] = useState("");
  const [fechaVencimiento, setFechaVencimiento] = useState("");
  const [clienteNombre, setClienteNombre] = useState("");
  const [clienteEmail, setClienteEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [rowActions, setRowActions] = useState<Record<string, RowActionState>>({});
  const [stageChoice, setStageChoice] = useState<Record<string, CobranzaReminderStage | "">>({});

  const puedeGestionar = GESTIONAR_ROLES.has(role);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [cuentasRes, resumenRes, invoicesRes] = await Promise.all([
        fetchCuentasCobranza(fetch, apiBaseUrl, token, propertyId, soloPendientes ? { pendiente: true } : undefined),
        fetchResumenCobranza(fetch, apiBaseUrl, token, propertyId),
        fetchInvoices(fetch, apiBaseUrl, token, propertyId),
      ]);
      setCuentas(cuentasRes);
      setResumen(resumenRes);
      setInvoicesElegibles(invoicesRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la cartera de cobranza.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel -- este proyecto no tiene
    // eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId, soloPendientes]);

  // Invoices tipo 'I' que todavía no tienen una cuenta por cobrar registrada
  // -- las únicas que puede elegir el formulario de "registrar cuenta".
  const invoiceIdsConCuenta = useMemo(() => new Set((cuentas ?? []).map((c) => c.invoiceId)), [cuentas]);
  const invoicesDisponibles = useMemo(() => invoicesElegibles.filter((inv) => inv.tipo === "I" && !invoiceIdsConCuenta.has(inv.id)), [invoicesElegibles, invoiceIdsConCuenta]);

  async function handleRegistrar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!invoiceId) {
      setFormError("Elige un CFDI de tipo Ingreso.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaVencimiento)) {
      setFormError("Fecha de vencimiento inválida.");
      return;
    }
    setSubmitting(true);
    try {
      await registrarCuentaCobranza(fetch, apiBaseUrl, token, propertyId, {
        invoiceId,
        fechaVencimiento,
        clienteNombre: clienteNombre.trim() || null,
        clienteEmail: clienteEmail.trim() || null,
      });
      setShowForm(false);
      setInvoiceId("");
      setFechaVencimiento("");
      setClienteNombre("");
      setClienteEmail("");
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo registrar la cuenta por cobrar.");
    } finally {
      setSubmitting(false);
    }
  }

  function setRowState(id: string, state: RowActionState) {
    setRowActions((prev) => ({ ...prev, [id]: state }));
  }

  async function handleMarcarPagada(cuenta: CuentaCobranza) {
    setRowState(cuenta.id, { loading: true, message: null, isError: false });
    try {
      await marcarCuentaPagada(fetch, apiBaseUrl, token, propertyId, cuenta.id, { montoPagado: cuenta.monto });
      setRowState(cuenta.id, { loading: false, message: "Marcada como pagada.", isError: false });
      await load();
    } catch (err) {
      setRowState(cuenta.id, { loading: false, message: err instanceof Error ? err.message : "No se pudo marcar como pagada.", isError: true });
    }
  }

  async function handleEnviarRecordatorio(cuenta: CuentaCobranza) {
    const stage = stageChoice[cuenta.id] || undefined;
    setRowState(cuenta.id, { loading: true, message: null, isError: false });
    try {
      const resultado = await enviarRecordatorioCobranza(fetch, apiBaseUrl, token, propertyId, cuenta.id, stage || undefined);
      const etiqueta = STAGE_LABELS[resultado.etapa] ?? resultado.etapa;
      const mensaje = resultado.enviado ? `Recordatorio enviado (${etiqueta}).` : `Evento registrado (${etiqueta}), pero esta cuenta no tiene correo de contacto capturado.`;
      setRowState(cuenta.id, { loading: false, message: mensaje, isError: !resultado.enviado });
    } catch (err) {
      setRowState(cuenta.id, { loading: false, message: err instanceof Error ? err.message : "No se pudo enviar el recordatorio.", isError: true });
    }
  }

  return (
    <div className="flex flex-col gap-4 px-1">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground">Cobranza</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Cartera por antigüedad, score de cobrabilidad y recordatorios reales por correo.</p>
        </div>
        {puedeGestionar && (
          <Button variant={showForm ? "outline" : "default"} size="sm" onClick={() => setShowForm((v) => !v)}>
            <HandCoins />
            {showForm ? "Cancelar" : "Registrar cuenta por cobrar"}
          </Button>
        )}
      </header>

      {/* El formulario de alta pasó del panel inline al `ModalFormularioLateral`
          compartido (4 campos + selector de CFDI: exactamente la forma de
          "formulario en riel lateral" para la que existe ese shell). El estado
          `showForm` y `handleRegistrar` son los mismos de antes. */}
      {showForm && (
        <ModalFormularioLateral
          open
          onOpenChange={(abierto) => {
            if (!abierto) setShowForm(false);
          }}
          titulo="Registrar cuenta por cobrar"
          subtitulo="Ata un CFDI de ingreso a una fecha de vencimiento para que entre a la cartera y al calendario de recordatorios."
          anchoClase="max-w-3xl"
          footer={
            <Button type="submit" form="cobranza-registrar" disabled={submitting} className="rounded-full px-6">
              {submitting ? "Registrando…" : "Registrar cuenta"}
            </Button>
          }
        >
          <form id="cobranza-registrar" onSubmit={handleRegistrar} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cobranza-cfdi">CFDI (tipo Ingreso) *</Label>
              <select
                id="cobranza-cfdi"
                value={invoiceId}
                onChange={(e) => setInvoiceId(e.target.value)}
                required
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <option value="">Selecciona un CFDI…</option>
                {invoicesDisponibles.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.folioFiscal.slice(0, 13)}… · {inv.emisorNombre ?? inv.rfcEmisor} · {formatMoney(inv.total)}
                  </option>
                ))}
              </select>
              {invoicesDisponibles.length === 0 && <span className="text-xs text-muted-foreground">No hay CFDI de ingreso sin cuenta por cobrar todavía.</span>}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cobranza-vencimiento">Fecha de vencimiento *</Label>
              <Input id="cobranza-vencimiento" type="date" value={fechaVencimiento} onChange={(e) => setFechaVencimiento(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cobranza-cliente">Nombre del cliente (opcional)</Label>
              <Input id="cobranza-cliente" type="text" value={clienteNombre} onChange={(e) => setClienteNombre(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cobranza-email">Correo de contacto (opcional -- sin esto no se puede enviar recordatorio real)</Label>
              <Input id="cobranza-email" type="email" value={clienteEmail} onChange={(e) => setClienteEmail(e.target.value)} />
            </div>
            {formError && (
              <p role="alert" className="text-destructive text-sm">
                {formError}
              </p>
            )}
          </form>
        </ModalFormularioLateral>
      )}

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {loading && !resumen && <EstadoCargando etiqueta="Cargando cobranza…" />}

      {resumen && <ResumenCards resumen={resumen} />}

      <label className="flex items-center gap-2 text-[13px] text-foreground">
        <input type="checkbox" checked={soloPendientes} onChange={(e) => setSoloPendientes(e.target.checked)} className="h-4 w-4 rounded border-border accent-primary" />
        Solo cuentas pendientes de cobro
      </label>

      {cuentas && cuentas.length === 0 && !loading && (
        <EstadoVacio mensaje={soloPendientes ? "No hay cuentas por cobrar pendientes." : "Todavía no hay ninguna cuenta por cobrar registrada."} />
      )}

      {cuentas && cuentas.length > 0 && (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Factura</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Monto</TableHead>
                  <TableHead>Vence</TableHead>
                  <TableHead>Antigüedad</TableHead>
                  <TableHead>Score</TableHead>
                  <TableHead>Estatus</TableHead>
                  {puedeGestionar && <TableHead>Acciones</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {cuentas.map((cuenta) => {
                  const rowState = rowActions[cuenta.id];
                  return (
                    <TableRow key={cuenta.id} className="align-top">
                      <TableCell className="font-mono text-xs">{cuenta.facturaId ? `${cuenta.facturaId.slice(0, 13)}…` : "—"}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {cuenta.clienteNombre ?? "Sin nombre"}
                        <div className="text-[11px] text-muted-foreground">{cuenta.clienteEmail ?? "sin correo capturado"}</div>
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{formatMoney(cuenta.monto)}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {/* `fechaVencimiento` es columna `date` (solo día, sin hora) --
                            `formatFechaSolo` (no `formatDate`) evita que se pinte un día
                            antes en America/Mexico_City (bug real corregido de raíz, ver
                            apps/web/src/lib/formato-fecha.ts). `pagadoEn` abajo SÍ es un
                            timestamp real (`timestamptz`) y se queda con `formatDate`. */}
                        {formatFechaSolo(cuenta.fechaVencimiento)}
                        <div className="text-[11px] text-muted-foreground">{cuenta.diasVencido > 0 ? `${cuenta.diasVencido} días de atraso` : cuenta.diasVencido < 0 ? `vence en ${-cuenta.diasVencido} días` : "vence hoy"}</div>
                      </TableCell>
                      <TableCell>
                        <BucketBadge bucket={cuenta.bucket} />
                      </TableCell>
                      <TableCell>
                        <ScoreBar score={cuenta.score} />
                      </TableCell>
                      <TableCell>
                        {cuenta.pagadoEn ? (
                          <Badge variant="outline" className="border-transparent bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400">
                            Pagada {formatDate(cuenta.pagadoEn)}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-transparent bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-400">
                            Pendiente
                          </Badge>
                        )}
                      </TableCell>
                      {puedeGestionar && (
                        <TableCell>
                          {!cuenta.pagadoEn && (
                            <div className="flex min-w-56 flex-col gap-1.5">
                              <div className="flex gap-1.5">
                                <Label htmlFor={`cobranza-etapa-${cuenta.id}`} className="sr-only">
                                  Etapa del recordatorio
                                </Label>
                                <select
                                  id={`cobranza-etapa-${cuenta.id}`}
                                  value={stageChoice[cuenta.id] ?? ""}
                                  onChange={(e) => setStageChoice((prev) => ({ ...prev, [cuenta.id]: e.target.value as CobranzaReminderStage | "" }))}
                                  className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                >
                                  <option value="">Etapa sugerida</option>
                                  {COBRANZA_REMINDER_STAGES.map((s) => (
                                    <option key={s} value={s}>
                                      {STAGE_LABELS[s]}
                                    </option>
                                  ))}
                                </select>
                                <Button type="button" variant="outline" size="sm" className="h-9 px-3 text-xs" onClick={() => void handleEnviarRecordatorio(cuenta)} disabled={rowState?.loading}>
                                  <Send />
                                  {rowState?.loading ? "…" : "Enviar recordatorio"}
                                </Button>
                              </div>
                              <Button type="button" variant="outline" size="sm" className="h-9 px-3 text-xs" onClick={() => void handleMarcarPagada(cuenta)} disabled={rowState?.loading}>
                                <CheckCircle2 />
                                Marcar pagada
                              </Button>
                              {rowState?.message && (
                                <span className={`text-[11px] ${rowState.isError ? "text-destructive" : "text-green-700 dark:text-green-400"}`} role={rowState.isError ? "alert" : undefined}>
                                  {rowState.message}
                                </span>
                              )}
                            </div>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
