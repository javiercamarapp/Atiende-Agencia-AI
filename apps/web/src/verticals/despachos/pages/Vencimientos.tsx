// Panel de vencimientos fiscales -- hallazgo de auditoría (severidad ALTA,
// "Siete módulos con ruta HTTP real y sin UI"): vencimientos.ts expone
// GET /vencimientos, POST /vencimientos/calcular, POST /:id/completar y
// POST /:id/escalar (este último ya dispara notificación real por correo,
// ver @atiende/domain-despachos::tryEnqueueEscalationEmail), pero ningún
// cliente web ni página los usaba. Esta página cierra el gap: lectura de las
// obligaciones fiscales del despacho (ISR/IVA/DIOT/Nómina/balanza/anual con día
// hábil, art. 12 CFF -- motor 100% determinista, ver vencimientos/calendario-fiscal.ts), el
// cálculo de un nuevo periodo, y las 2 acciones reales por vencimiento
// (marcar completado con comprobante opcional, escalar). El escalamiento en
// sí SIEMPRE exige revisión humana (CFF art. 89, ver decidirEscalamiento) --
// esta UI nunca decide una fecha límite fiscal, solo dispara el motor
// existente y muestra su resultado.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { CalendarClock, CheckCircle2, ExternalLink, TrendingUp, TriangleAlert } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  DataTable,
  CardDescription,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  NativeSelect,
  PageContainer,
  StatusBadge,
  statusTone,
} from "@atiende/ui";
import {
  barrerVencimientos,
  calcularVencimientos,
  completarVencimiento,
  escalarVencimiento,
  fetchVencimientos,
} from "../lib/vencimientos-client.ts";
import type { DataTableColumna } from "@atiende/ui";
import type { EstadoVencimiento, FiscalDeadline } from "../lib/vencimientos-client.ts";
import { formatEstadoVencimiento, formatPrioridadVencimiento } from "../lib/format.ts";
import { VENCIMIENTO_PRIORIDAD_TONES, VENCIMIENTO_ESTADO_TONES } from "../lib/status-tones.ts";
import { formatFechaSolo, hoyFechaSolo } from "../../../lib/formato-fecha.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const GESTIONAR_ROLES = new Set(["admin", "contador"]);

const ESTADO_FILTROS: ReadonlyArray<{ value: EstadoVencimiento | ""; label: string }> = [
  { value: "", label: "Todos los estados" },
  { value: "pendiente", label: "Pendiente" },
  { value: "en_proceso", label: "En proceso" },
  { value: "vencido", label: "Vencido" },
  { value: "escalado", label: "Escalado" },
  { value: "completado", label: "Completado" },
];

function PrioridadBadge({ prioridad }: { prioridad: FiscalDeadline["prioridad"] }) {
  return <StatusBadge tone={statusTone(VENCIMIENTO_PRIORIDAD_TONES, prioridad)}>{formatPrioridadVencimiento(prioridad)}</StatusBadge>;
}

function EstadoBadge({ estado }: { estado: EstadoVencimiento }) {
  return <StatusBadge tone={statusTone(VENCIMIENTO_ESTADO_TONES, estado)}>{formatEstadoVencimiento(estado)}</StatusBadge>;
}

interface RowActionState {
  readonly loading: boolean;
  readonly message: string | null;
  readonly isError: boolean;
}

// Catálogo c_RegimenFiscal (SAT) con calendario modelado por el motor.
const REGIMENES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "601", label: "601 · General de Ley Personas Morales" },
  { value: "603", label: "603 · Personas Morales con Fines no Lucrativos" },
  { value: "605", label: "605 · Sueldos y Salarios" },
  { value: "606", label: "606 · Arrendamiento" },
  { value: "607", label: "607 · Enajenación o Adquisición de Bienes" },
  { value: "608", label: "608 · Demás ingresos" },
  { value: "611", label: "611 · Ingresos por Dividendos" },
  { value: "612", label: "612 · Personas Físicas con Actividades Empresariales y Profesionales" },
  { value: "614", label: "614 · Ingresos por intereses" },
  { value: "615", label: "615 · Ingresos por obtención de premios" },
  { value: "616", label: "616 · Sin obligaciones fiscales" },
  { value: "620", label: "620 · Sociedades Cooperativas de Producción" },
  { value: "621", label: "621 · Incorporación Fiscal" },
  { value: "622", label: "622 · Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras" },
  { value: "623", label: "623 · Opcional para Grupos de Sociedades" },
  { value: "624", label: "624 · Coordinados" },
  { value: "625", label: "625 · Plataformas Tecnológicas" },
  { value: "626", label: "626 · Régimen Simplificado de Confianza" },
];

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
  const [calcRegimen, setCalcRegimen] = useState("601");
  const [barridoMsg, setBarridoMsg] = useState<{ text: string; isError: boolean } | null>(null);
  const [barriendo, setBarriendo] = useState(false);
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
      await calcularVencimientos(fetch, apiBaseUrl, token, propertyId, { year: calcAnio, month: calcMes, regimenFiscal: calcRegimen });
      setShowCalcularForm(false);
      await load();
    } catch (err) {
      setCalcError(err instanceof Error ? err.message : "No se pudieron calcular los vencimientos del periodo.");
    } finally {
      setCalculando(false);
    }
  }

  async function handleBarrido() {
    setBarridoMsg(null);
    setBarriendo(true);
    try {
      const r = await barrerVencimientos(fetch, apiBaseUrl, token, propertyId);
      const correos = r.escalados.reduce((n, e) => n + e.correosEncolados, 0);
      const fallos = r.fallidos.length > 0 ? ` ${r.fallidos.length} no se pudo(ieron) escalar.` : "";
      setBarridoMsg({
        text: r.escalados.length > 0 ? `Se escalaron ${r.escalados.length} vencimiento(s) (${correos} correo(s) encolado(s)).${fallos}` : `Nada nuevo que escalar: ${r.yaEscalados} ya escalado(s), ${r.aunNoToca} aún con plazo.${fallos}`,
        isError: r.fallidos.length > 0,
      });
      await load();
    } catch (err) {
      setBarridoMsg({ text: err instanceof Error ? err.message : "No se pudo ejecutar el barrido de escalamiento.", isError: true });
    } finally {
      setBarriendo(false);
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

  const columnasVencimientos: DataTableColumna<FiscalDeadline>[] = [
    {
      id: "tipo",
      encabezado: "Tipo",
      principal: true,
      valorOrden: (d) => d.tipo,
      celda: (d) => (
        <div className="font-semibold text-foreground">
          {d.tipo}
          <div className="max-w-56 text-xs font-normal text-muted-foreground">{d.fundamento}</div>
          {d.validarConFiscalista && (
            <div className="mt-1 inline-flex items-center gap-1 text-xs font-normal text-warning">
              <TriangleAlert className="h-3 w-3" strokeWidth={1.75} />
              Validar con fiscalista
            </div>
          )}
        </div>
      ),
    },
    { id: "periodo", encabezado: "Periodo", valorOrden: (d) => d.periodo, celda: (d) => <span className="text-muted-foreground">{d.periodo}</span> },
    {
      id: "fechaLimite",
      encabezado: "Fecha límite",
      valorOrden: (d) => d.fechaLimite,
      celda: (d) => (
        <div className="text-muted-foreground">
          {/* `fechaLimite`/`fechaPresentacion` son columnas `date` (solo día, 001_despachos_schema.sql): `formatFechaSolo`
              evita que se pinten un día antes en America/Mexico_City (ver apps/web/src/lib/formato-fecha.ts). */}
          {formatFechaSolo(d.fechaLimite)}
          <div className="text-xs text-muted-foreground">{d.diasRestantes < 0 ? `${-d.diasRestantes} día(s) de atraso` : d.diasRestantes === 0 ? "vence hoy" : `vence en ${d.diasRestantes} día(s)`}</div>
        </div>
      ),
    },
    { id: "prioridad", encabezado: "Prioridad", valorOrden: (d) => d.diasRestantes, celda: (d) => <PrioridadBadge prioridad={d.prioridad} /> },
    {
      id: "estado",
      encabezado: "Estado",
      valorOrden: (d) => d.estado,
      celda: (d) => {
        const finalizado = d.estado === "completado";
        return (
          <>
            <EstadoBadge estado={d.estado} />
            {finalizado && d.fechaPresentacion && <div className="mt-1 text-xs text-muted-foreground">Presentado {formatFechaSolo(d.fechaPresentacion)}</div>}
            {finalizado && d.comprobanteUrl && (
              <div className="mt-0.5 text-xs">
                <a href={d.comprobanteUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline underline-offset-2">
                  Ver comprobante
                  <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
                </a>
              </div>
            )}
          </>
        );
      },
    },
    ...(puedeGestionar
      ? [
          {
            id: "acciones",
            encabezado: "Acciones",
            celda: (d: FiscalDeadline) => {
              const rowState = rowActions[d.id];
              const finalizado = d.estado === "completado";
              return (
                <>
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
                            <span className={`text-xs ${rowState.isError ? "text-destructive" : "text-success"}`} role={rowState.isError ? "alert" : undefined}>
                              {rowState.message}
                            </span>
                          )}
                        </div>
                      )}
                </>
              );
            },
          } satisfies DataTableColumna<FiscalDeadline>,
        ]
      : []),
  ];

  return (
    <PageContainer padding="none" className="gap-4 [&>*]:min-w-0">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground">Vencimientos fiscales</h1>
          <p className="mt-1 text-sm text-muted-foreground">ISR, IVA, DIOT, Nómina, balanza y declaración anual -- fecha límite en día hábil (art. 12 CFF), con prioridad y escalamiento.</p>
        </div>
        {puedeGestionar && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void handleBarrido()} disabled={barriendo}>
              <TrendingUp />
              {barriendo ? "Escalando…" : "Escalar vencidos y por vencer"}
            </Button>
          <Button variant={showCalcularForm ? "outline" : "default"} size="sm" onClick={() => setShowCalcularForm((v) => !v)}>
            <CalendarClock />
            {showCalcularForm ? "Cancelar" : "Calcular vencimientos del periodo"}
          </Button>
          </div>
        )}
      </header>

      {barridoMsg && (
        <p role={barridoMsg.isError ? "alert" : "status"} className={barridoMsg.isError ? "text-destructive text-sm" : "text-sm text-muted-foreground"}>
          {barridoMsg.text}
        </p>
      )}

      {/* Panel inline plegable (no overlay): dos campos que el staff llena
          mirando la tabla de vencimientos de abajo. Solo cambia la piel. */}
      {showCalcularForm && (
        <Card className="max-w-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Calcular vencimientos</CardTitle>
            <CardDescription>Genera las obligaciones del régimen elegido con fecha límite en día hábil. Las que dependen de un plazo por confirmar quedan marcadas para validar con el fiscalista.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCalcular} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="venc-anio">Año *</Label>
                <Input id="venc-anio" type="number" value={calcAnio} onChange={(e) => setCalcAnio(Number(e.target.value))} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="venc-mes">Mes *</Label>
                <NativeSelect
                  id="venc-mes"
                  value={calcMes}
                  onChange={(e) => setCalcMes(Number(e.target.value))}
                >
                  {MESES.slice(1).map((nombre, i) => (
                    <option key={i + 1} value={i + 1}>
                      {nombre}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="venc-regimen">Régimen fiscal *</Label>
                <NativeSelect id="venc-regimen" value={calcRegimen} onChange={(e) => setCalcRegimen(e.target.value)}>
                  {REGIMENES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </NativeSelect>
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
        <Label htmlFor="venc-filtro-estado" className="text-sm text-foreground">
          Filtrar por estado
        </Label>
        <NativeSelect
          id="venc-filtro-estado"
          value={filtroEstado}
          onChange={(e) => setFiltroEstado(e.target.value as EstadoVencimiento | "")}
          size="sm"
          wrapperClassName="w-auto min-w-44"
        >
          {ESTADO_FILTROS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </NativeSelect>
      </div>

      {loading && !vencimientos && <EstadoCargando etiqueta="Cargando vencimientos…" />}

      {vencimientos && vencimientos.length === 0 && !loading && (
        <EstadoVacio mensaje={`No hay vencimientos fiscales registrados${filtroEstado ? " con ese estado" : ""} todavía.`} />
      )}

      {vencimientos && vencimientos.length > 0 && (
        <DataTable etiqueta="Vencimientos fiscales" columnas={columnasVencimientos} filas={vencimientos} obtenerId={(d) => d.id} atributosFila={(d) => ({ "data-vencimiento-id": d.id })} />
      )}
    </PageContainer>
  );
}
