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
import { CalendarClock, CheckCircle2, ExternalLink, TrendingUp, TriangleAlert } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormDialog,
  FormField,
  Input,
  NativeSelect,
  notify,
  PageContainer,
  PageHeader,
  StatusBadge,
  statusTone,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useConfirm,
} from "@atiende/ui";
import {
  barrerVencimientos,
  calcularVencimientos,
  completarVencimiento,
  escalarVencimiento,
  fetchVencimientos,
} from "../lib/vencimientos-client.ts";
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
  const { confirmar, dialogo } = useConfirm();
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

  async function handleCalcular() {
    setCalcError(null);
    if (!Number.isInteger(calcMes) || calcMes < 1 || calcMes > 12) {
      setCalcError("Mes inválido.");
      return;
    }
    setCalculando(true);
    try {
      await calcularVencimientos(fetch, apiBaseUrl, token, propertyId, { year: calcAnio, month: calcMes, regimenFiscal: calcRegimen });
      setShowCalcularForm(false);
      notify.success("Vencimientos del periodo calculados.");
      await load();
    } catch (err) {
      setCalcError(err instanceof Error ? err.message : "No se pudieron calcular los vencimientos del periodo.");
    } finally {
      setCalculando(false);
    }
  }

  async function handleBarrido() {
    const ok = await confirmar({
      titulo: "Escalar vencidos y por vencer",
      descripcion: "Se escalarán todos los vencimientos que ya tocan y se encolarán los correos al equipo. No se puede deshacer.",
      confirmar: "Escalar",
    });
    if (!ok) return;
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
    const ok = await confirmar({
      titulo: "Marcar vencimiento como completado",
      descripcion: `${deadline.tipo} · ${deadline.periodo}. Queda registrado como presentado y no se puede deshacer.`,
      confirmar: "Marcar completado",
    });
    if (!ok) return;
    setRowState(deadline.id, { loading: true });
    try {
      await completarVencimiento(fetch, apiBaseUrl, token, propertyId, deadline.id, comprobanteUrl);
      setRowState(deadline.id, { loading: false });
      notify.success("Marcado como completado.");
      await load();
    } catch (err) {
      setRowState(deadline.id, { loading: false });
      notify.error(err instanceof Error ? err.message : "No se pudo marcar como completado.");
    }
  }

  async function handleEscalar(deadline: FiscalDeadline) {
    const ok = await confirmar({
      titulo: "Escalar vencimiento",
      descripcion: `${deadline.tipo} · ${deadline.periodo}. Se escalará y se encolará un correo al equipo. No se puede deshacer.`,
      confirmar: "Escalar",
    });
    if (!ok) return;
    setRowState(deadline.id, { loading: true });
    try {
      const resultado = await escalarVencimiento(fetch, apiBaseUrl, token, propertyId, deadline.id);
      const correos = resultado.notificacion.correosEncolados;
      const mensaje = correos > 0 ? `Escalado (${resultado.escalamiento.nivel}). ${correos} correo(s) encolado(s) al equipo.` : `Escalado (${resultado.escalamiento.nivel}). Sin correo enviado (sin destinatarios elegibles).`;
      setRowState(deadline.id, { loading: false });
      notify.success(mensaje);
      await load();
    } catch (err) {
      setRowState(deadline.id, { loading: false });
      notify.error(err instanceof Error ? err.message : "No se pudo escalar el vencimiento.");
    }
  }

  return (
    <PageContainer className="[&>*]:min-w-0">
      <PageHeader
        titulo="Vencimientos fiscales"
        descripcion="ISR, IVA, DIOT, nómina, balanza y declaración anual, con fecha límite en día hábil (art. 12 CFF), prioridad y escalamiento."
        acciones={
          puedeGestionar ? (
            <>
              <Button variant="outline" size="sm" onClick={() => void handleBarrido()} loading={barriendo}>
                <TrendingUp />
                Escalar vencidos y por vencer
              </Button>
              <Button size="sm" onClick={() => setShowCalcularForm(true)}>
                <CalendarClock />
                Calcular vencimientos del periodo
              </Button>
            </>
          ) : undefined
        }
      />

      {barridoMsg && <Callout tone={barridoMsg.isError ? "danger" : "info"}>{barridoMsg.text}</Callout>}

      <FormDialog
        open={showCalcularForm}
        onOpenChange={(abierto) => {
          if (!calculando) setShowCalcularForm(abierto);
        }}
        titulo="Calcular vencimientos"
        subtitulo="Genera las obligaciones del régimen elegido con fecha límite en día hábil. Las que dependen de un plazo por confirmar quedan marcadas para validar con el fiscalista."
        anchoClase="max-w-lg"
        onGuardar={() => void handleCalcular()}
        guardando={calculando}
        textoBotonGuardar="Calcular"
        bloquearCierre={calculando}
      >
        <div className="grid gap-3">
          <FormField label="Año" required>
            <Input id="venc-anio" type="number" value={calcAnio} onChange={(e) => setCalcAnio(Number(e.target.value))} />
          </FormField>
          <FormField label="Mes" required>
            <NativeSelect id="venc-mes" value={calcMes} onChange={(e) => setCalcMes(Number(e.target.value))}>
              {MESES.slice(1).map((nombre, i) => (
                <option key={i + 1} value={i + 1}>
                  {nombre}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Régimen fiscal" required>
            <NativeSelect id="venc-regimen" value={calcRegimen} onChange={(e) => setCalcRegimen(e.target.value)}>
              {REGIMENES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          {calcError && <Callout tone="danger">{calcError}</Callout>}
        </div>
      </FormDialog>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      <FormField label="Filtrar por estado" className="w-fit">
        <NativeSelect id="venc-filtro-estado" value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value as EstadoVencimiento | "")} wrapperClassName="w-auto min-w-44">
          {ESTADO_FILTROS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </NativeSelect>
      </FormField>

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
                      <TableCell className="font-semibold text-foreground">
                        {d.tipo}
                        <div className="max-w-56 text-xs font-normal text-muted-foreground">{d.fundamento}</div>
                        {d.validarConFiscalista && (
                          <div className="mt-1 inline-flex items-center gap-1 text-xs font-normal text-warning">
                            <TriangleAlert className="h-3 w-3" strokeWidth={1.75} />
                            Validar con fiscalista
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{d.periodo}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {/* `fechaLimite`/`fechaPresentacion` son columnas `date` (solo día,
                            001_despachos_schema.sql) -- `formatFechaSolo` evita que se
                            pinten un día antes en America/Mexico_City (mismo bug real
                            corregido en Cobranza.tsx, ver apps/web/src/lib/formato-fecha.ts). */}
                        {formatFechaSolo(d.fechaLimite)}
                        <div className="text-xs text-muted-foreground">{d.diasRestantes < 0 ? `${-d.diasRestantes} día(s) de atraso` : d.diasRestantes === 0 ? "vence hoy" : `vence en ${d.diasRestantes} día(s)`}</div>
                      </TableCell>
                      <TableCell>
                        <PrioridadBadge prioridad={d.prioridad} />
                      </TableCell>
                      <TableCell>
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
                      </TableCell>
                      {puedeGestionar && (
                        <TableCell>
                          {!finalizado && (
                            <div className="flex min-w-56 flex-col gap-1.5">
                              <FormField label="Comprobante (URL, opcional)">
                                <Input
                                  id={`venc-comprobante-${d.id}`}
                                  type="text"
                                  placeholder="https://…"
                                  value={comprobanteDrafts[d.id] ?? ""}
                                  onChange={(e) => setComprobanteDrafts((prev) => ({ ...prev, [d.id]: e.target.value }))}
                                />
                              </FormField>
                              <div className="flex gap-1.5">
                                <Button type="button" variant="outline" onClick={() => void handleCompletar(d)} loading={rowState?.loading}>
                                  <CheckCircle2 />
                                  Marcar completado
                                </Button>
                                {d.estado !== "escalado" && (
                                  <Button type="button" variant="outline" onClick={() => void handleEscalar(d)} disabled={rowState?.loading}>
                                    <TrendingUp />
                                    Escalar
                                  </Button>
                                )}
                              </div>
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
      {dialogo}
    </PageContainer>
  );
}
