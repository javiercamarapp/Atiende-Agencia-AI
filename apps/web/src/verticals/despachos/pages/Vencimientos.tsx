// Panel de vencimientos fiscales -- hallazgo de auditoría (severidad ALTA,
// "Siete módulos con ruta HTTP real y sin UI"): vencimientos.ts expone
// GET /vencimientos, POST /vencimientos/calcular, POST /:id/completar y
// POST /:id/escalar (este último ya dispara notificación real por correo,
// ver @atiende/domain-despachos::tryEnqueueEscalationEmail), pero ningún
// cliente web ni página los usaba. Esta página cierra el gap: lectura de las
// obligaciones fiscales del despacho (ISR/IVA/DIOT/Nómina, día 17 del mes
// siguiente -- motor 100% determinista, ver vencimientos/engine.ts), el
// cálculo de un nuevo periodo, y las 2 acciones reales por vencimiento
// (marcar completado con comprobante opcional, escalar). El escalamiento en
// sí SIEMPRE exige revisión humana (CFF art. 89, ver decidirEscalamiento) --
// esta UI nunca decide una fecha límite fiscal, solo dispara el motor
// existente y muestra su resultado.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { CalendarClock, CheckCircle2, ExternalLink, TrendingUp } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
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
} from "@atiende/ui";
import {
  calcularVencimientos,
  completarVencimiento,
  escalarVencimiento,
  fetchVencimientos,
} from "../lib/vencimientos-client.ts";
import type { EstadoVencimiento, FiscalDeadline } from "../lib/vencimientos-client.ts";
import { formatEstadoVencimiento, formatPrioridadVencimiento } from "../lib/format.ts";
import { formatFechaSolo, hoyFechaSolo } from "../../../lib/formato-fecha.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const GESTIONAR_ROLES = new Set(["admin", "contador"]);

// Misma carga semántica exacta que las píldoras inline originales, ahora sobre
// el `Badge` real de @atiende/ui (`variant` donde hay token semántico; escala
// neutra de Tailwind para verde/ámbar/naranja, igual que StatCard).
type BadgeSpec = { variant: "default" | "secondary" | "destructive" | "outline"; className?: string };

const PRIORIDAD_BADGE: Record<FiscalDeadline["prioridad"], BadgeSpec> = {
  critica: { variant: "destructive" },
  alta: { variant: "outline", className: "border-transparent bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-400" },
  media: { variant: "outline", className: "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-400" },
  baja: { variant: "outline", className: "border-transparent bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400" },
};

const ESTADO_BADGE: Record<EstadoVencimiento, BadgeSpec> = {
  pendiente: { variant: "outline", className: "border-transparent bg-muted text-muted-foreground" },
  en_proceso: { variant: "secondary" },
  completado: { variant: "outline", className: "border-transparent bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400" },
  vencido: { variant: "destructive" },
  escalado: { variant: "outline", className: "border-transparent bg-amber-200 text-amber-900 dark:bg-amber-500/20 dark:text-amber-300" },
};

const ESTADO_FILTROS: ReadonlyArray<{ value: EstadoVencimiento | ""; label: string }> = [
  { value: "", label: "Todos los estados" },
  { value: "pendiente", label: "Pendiente" },
  { value: "en_proceso", label: "En proceso" },
  { value: "vencido", label: "Vencido" },
  { value: "escalado", label: "Escalado" },
  { value: "completado", label: "Completado" },
];

function PrioridadBadge({ prioridad }: { prioridad: FiscalDeadline["prioridad"] }) {
  const { variant, className } = PRIORIDAD_BADGE[prioridad];
  return (
    <Badge variant={variant} className={className}>
      {formatPrioridadVencimiento(prioridad)}
    </Badge>
  );
}

function EstadoBadge({ estado }: { estado: EstadoVencimiento }) {
  const { variant, className } = ESTADO_BADGE[estado];
  return (
    <Badge variant={variant} className={className}>
      {formatEstadoVencimiento(estado)}
    </Badge>
  );
}

interface RowActionState {
  readonly loading: boolean;
  readonly message: string | null;
  readonly isError: boolean;
}

const MESES = ["", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

export function VencimientosPage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const [vencimientos, setVencimientos] = useState<readonly FiscalDeadline[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filtroEstado, setFiltroEstado] = useState<EstadoVencimiento | "">("");

  // Bug real (hallazgo de auditoría a4, dimensión web-contrato, severidad baja):
  // precargar con `new Date().getUTCFullYear()`/`getUTCMonth()` usa el día UTC del
  // navegador, no el día de calendario del negocio. `calcAnio`/`calcMes` SIEMPRE
  // viajan explícitos a `calcularVencimientos` (vencimientos-client.ts los tipa
  // obligatorios), así que el default de negocio que el servidor ya calcula con
  // `hoyFechaNegocio()` (apps/api/.../despachos/vencimientos.ts) es inalcanzable
  // desde esta pantalla -- el último día del mes por la tarde/noche CDMX (18:00-23:59,
  // 00:00-05:59 UTC del día siguiente) precargaba el MES SIGUIENTE (y el 31-dic el AÑO
  // siguiente). `hoyFechaSolo()` (apps/web/src/lib/formato-fecha.ts) da el día de
  // calendario en America/Mexico_City -- mismo helper que Dashboard.tsx/Pl.tsx.
  // Inicializador lazy: solo se usa como valor inicial de useState, así que no
  // hace falta recalcular `hoyFechaSolo()` (construye un Intl.DateTimeFormat) en
  // cada render.
  const [showCalcularForm, setShowCalcularForm] = useState(false);
  const [calcAnio, setCalcAnio] = useState(() => Number(hoyFechaSolo().slice(0, 4)));
  const [calcMes, setCalcMes] = useState(() => Number(hoyFechaSolo().slice(5, 7)));
  const [calcError, setCalcError] = useState<string | null>(null);
  const [calculando, setCalculando] = useState(false);

  const [comprobanteDrafts, setComprobanteDrafts] = useState<Record<string, string>>({});
  const [rowActions, setRowActions] = useState<Record<string, RowActionState>>({});

  const puedeGestionar = GESTIONAR_ROLES.has(role);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchVencimientos(fetch, apiBaseUrl, token, propertyId, filtroEstado ? { estado: filtroEstado } : undefined);
      setVencimientos(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los vencimientos fiscales.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel -- este proyecto no tiene
    // eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId, filtroEstado]);

  async function handleCalcular(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCalcError(null);
    if (!Number.isInteger(calcMes) || calcMes < 1 || calcMes > 12) {
      setCalcError("Mes inválido.");
      return;
    }
    setCalculando(true);
    try {
      await calcularVencimientos(fetch, apiBaseUrl, token, propertyId, { year: calcAnio, month: calcMes });
      setShowCalcularForm(false);
      await load();
    } catch (err) {
      setCalcError(err instanceof Error ? err.message : "No se pudieron calcular los vencimientos del periodo.");
    } finally {
      setCalculando(false);
    }
  }

  function setRowState(id: string, state: RowActionState) {
    setRowActions((prev) => ({ ...prev, [id]: state }));
  }

  async function handleCompletar(deadline: FiscalDeadline) {
    const comprobanteUrl = comprobanteDrafts[deadline.id]?.trim() || null;
    setRowState(deadline.id, { loading: true, message: null, isError: false });
    try {
      await completarVencimiento(fetch, apiBaseUrl, token, propertyId, deadline.id, comprobanteUrl);
      setRowState(deadline.id, { loading: false, message: "Marcado como completado.", isError: false });
      await load();
    } catch (err) {
      setRowState(deadline.id, { loading: false, message: err instanceof Error ? err.message : "No se pudo marcar como completado.", isError: true });
    }
  }

  async function handleEscalar(deadline: FiscalDeadline) {
    setRowState(deadline.id, { loading: true, message: null, isError: false });
    try {
      const resultado = await escalarVencimiento(fetch, apiBaseUrl, token, propertyId, deadline.id);
      const correos = resultado.notificacion.correosEncolados;
      const mensaje = correos > 0 ? `Escalado (${resultado.escalamiento.nivel}). ${correos} correo(s) encolado(s) al staff.` : `Escalado (${resultado.escalamiento.nivel}). Sin correo enviado (sin destinatarios elegibles).`;
      setRowState(deadline.id, { loading: false, message: mensaje, isError: false });
      await load();
    } catch (err) {
      setRowState(deadline.id, { loading: false, message: err instanceof Error ? err.message : "No se pudo escalar el vencimiento.", isError: true });
    }
  }

  return (
    <div className="flex flex-col gap-4 px-1">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground">Vencimientos fiscales</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">ISR, IVA, DIOT y Nómina -- fecha límite día 17 del mes siguiente, prioridad y escalamiento automáticos.</p>
        </div>
        {puedeGestionar && (
          <Button variant={showCalcularForm ? "outline" : "default"} size="sm" onClick={() => setShowCalcularForm((v) => !v)}>
            <CalendarClock />
            {showCalcularForm ? "Cancelar" : "Calcular vencimientos del periodo"}
          </Button>
        )}
      </header>

      {/* Panel inline plegable (no overlay): dos campos que el staff llena
          mirando la tabla de vencimientos de abajo. Solo cambia la piel. */}
      {showCalcularForm && (
        <Card className="max-w-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Calcular vencimientos</CardTitle>
            <CardDescription>Genera las 4 obligaciones estándar (ISR/IVA/DIOT/Nómina) con fecha límite el día 17 del mes siguiente.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCalcular} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="venc-anio">Año *</Label>
                <Input id="venc-anio" type="number" value={calcAnio} onChange={(e) => setCalcAnio(Number(e.target.value))} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="venc-mes">Mes *</Label>
                <select
                  id="venc-mes"
                  value={calcMes}
                  onChange={(e) => setCalcMes(Number(e.target.value))}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {MESES.slice(1).map((nombre, i) => (
                    <option key={i + 1} value={i + 1}>
                      {nombre}
                    </option>
                  ))}
                </select>
              </div>
              {calcError && (
                <p role="alert" className="text-destructive text-sm">
                  {calcError}
                </p>
              )}
              <Button type="submit" disabled={calculando} className="w-full">
                {calculando ? "Calculando…" : "Calcular"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      <div className="flex items-center gap-2">
        <Label htmlFor="venc-filtro-estado" className="text-[13px] text-foreground">
          Filtrar por estado
        </Label>
        <select
          id="venc-filtro-estado"
          value={filtroEstado}
          onChange={(e) => setFiltroEstado(e.target.value as EstadoVencimiento | "")}
          className="h-9 rounded-md border border-input bg-background px-2 text-[13px] text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {ESTADO_FILTROS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      {loading && !vencimientos && <EstadoCargando etiqueta="Cargando vencimientos…" />}

      {vencimientos && vencimientos.length === 0 && !loading && (
        <EstadoVacio mensaje={`No hay vencimientos fiscales registrados${filtroEstado ? " con ese estado" : ""} todavía.`} />
      )}

      {vencimientos && vencimientos.length > 0 && (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Periodo</TableHead>
                  <TableHead>Fecha límite</TableHead>
                  <TableHead>Prioridad</TableHead>
                  <TableHead>Estado</TableHead>
                  {puedeGestionar && <TableHead>Acciones</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {vencimientos.map((d) => {
                  const rowState = rowActions[d.id];
                  const finalizado = d.estado === "completado";
                  return (
                    <TableRow key={d.id} className="align-top">
                      <TableCell className="font-semibold text-foreground">{d.tipo}</TableCell>
                      <TableCell className="text-muted-foreground">{d.periodo}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {/* `fechaLimite`/`fechaPresentacion` son columnas `date` (solo día,
                            001_despachos_schema.sql) -- `formatFechaSolo` evita que se
                            pinten un día antes en America/Mexico_City (mismo bug real
                            corregido en Cobranza.tsx, ver apps/web/src/lib/formato-fecha.ts). */}
                        {formatFechaSolo(d.fechaLimite)}
                        <div className="text-[11px] text-muted-foreground">{d.diasRestantes < 0 ? `${-d.diasRestantes} día(s) de atraso` : d.diasRestantes === 0 ? "vence hoy" : `vence en ${d.diasRestantes} día(s)`}</div>
                      </TableCell>
                      <TableCell>
                        <PrioridadBadge prioridad={d.prioridad} />
                      </TableCell>
                      <TableCell>
                        <EstadoBadge estado={d.estado} />
                        {finalizado && d.fechaPresentacion && <div className="mt-1 text-[11px] text-muted-foreground">Presentado {formatFechaSolo(d.fechaPresentacion)}</div>}
                        {finalizado && d.comprobanteUrl && (
                          <div className="mt-0.5 text-[11px]">
                            <a href={d.comprobanteUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline underline-offset-2">
                              Ver comprobante
                              <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
                            </a>
                          </div>
                        )}
                      </TableCell>
                      {puedeGestionar && (
                        <TableCell>
                          {!finalizado && (
                            <div className="flex min-w-56 flex-col gap-1.5">
                              <Label htmlFor={`venc-comprobante-${d.id}`} className="sr-only">
                                URL de comprobante
                              </Label>
                              <Input
                                id={`venc-comprobante-${d.id}`}
                                type="text"
                                placeholder="URL de comprobante (opcional)"
                                value={comprobanteDrafts[d.id] ?? ""}
                                onChange={(e) => setComprobanteDrafts((prev) => ({ ...prev, [d.id]: e.target.value }))}
                                className="h-9 text-xs"
                              />
                              <div className="flex gap-1.5">
                                <Button type="button" variant="outline" size="sm" className="h-9 px-3 text-xs" onClick={() => void handleCompletar(d)} disabled={rowState?.loading}>
                                  <CheckCircle2 />
                                  {rowState?.loading ? "…" : "Marcar completado"}
                                </Button>
                                {d.estado !== "escalado" && (
                                  <Button type="button" variant="outline" size="sm" className="h-9 px-3 text-xs" onClick={() => void handleEscalar(d)} disabled={rowState?.loading}>
                                    <TrendingUp />
                                    Escalar
                                  </Button>
                                )}
                              </div>
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
