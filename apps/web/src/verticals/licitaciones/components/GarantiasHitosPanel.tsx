// L-27 -- pestana "Garantias y hitos" de la post-adjudicacion: plazos de firma y de entrega de garantia, garantias
// (cumplimiento, anticipo, vicios ocultos) con vigencia, hitos con responsable, convenios modificatorios con historial y
// bitacora de cambios. TODO lo que se ve sale de `.../contract/post-award` (apps/api/.../postAdjudicacion.ts); el servidor
// valida, calcula los plazos en dias habiles con el calendario efectivo (L-22) y aplica la maquina de estados y los roles.
// Aqui los controles que el servidor rechazaria igual solo se ocultan (cosmetico): el servidor SIEMPRE decide.
//
// Estados honestos: cargando, error, vacio, "base sin la migracion 035" (nada editable) y "sin contrato registrado".
// Descartar o cancelar un dialogo NUNCA escribe: cada escritura vive solo en el boton de confirmar/guardar.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarClock, CircleDollarSign, ListChecks, ShieldCheck } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, FormDialog, FormField, Input, NativeSelect, StatCard, StatusBadge, Textarea, statusTone, useConfirm } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";
import { formatDateTime } from "../lib/format.ts";
import {
  CONVENIO_TIPO_LABELS,
  GARANTIA_ESTADO_LABELS,
  GARANTIA_TIPO_LABELS,
  actualizarGarantia,
  actualizarHito,
  crearConvenio,
  crearGarantia,
  crearHito,
  fetchPostAward,
  fetchPostAwardBitacora,
  fetchResponsables,
  guardarPlazos,
  nuevaClaveIdempotencia,
} from "../lib/post-adjudicacion-client.ts";
import type { BitacoraEntrada, ConvenioRecord, ConvenioTipo, GarantiaRecord, GarantiaTipo, HitoRecord, PostAwardOverview, Responsable } from "../lib/post-adjudicacion-client.ts";
import { GARANTIA_ESTADO_TONES, HITO_ESTADO_TONES } from "../lib/status-tones.ts";
import { TWO_FACTOR_UNAVAILABLE, fetchTwoFactorStatus, requestStepUpToken, secondFactorFromText } from "../lib/two-factor-client.ts";
import type { TwoFactorStatus } from "../lib/two-factor-client.ts";

export interface GarantiasHitosPanelProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly tenderId: string;
}

const BITACORA_ENTIDAD_LABELS: Readonly<Record<BitacoraEntrada["entidad"], string>> = { plazos: "Plazos", garantia: "Garantía", hito: "Hito", convenio: "Convenio" };
const BITACORA_ACCION_LABELS: Readonly<Record<BitacoraEntrada["accion"], string>> = { crear: "Alta", editar: "Edición", cambio_estado: "Cambio de estado" };

/** "125000.5" -> "$125,000.50" sin `toLocale*String`: el monto ya viene exacto del servidor como cadena decimal. */
function formatoMonto(monto: string): string {
  const negativo = monto.startsWith("-");
  const [entero = "0", fraccion = "00"] = (negativo ? monto.slice(1) : monto).split(".");
  const miles = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negativo ? "-" : ""}$${miles}.${fraccion.padEnd(2, "0").slice(0, 2)}`;
}

function textoVencimiento(g: GarantiaRecord): string {
  const d = g.vigencia.diasParaVencer;
  if (g.estado !== "entregada") return "";
  if (d < 0) return `vencida hace ${-d} ${-d === 1 ? "día" : "días"}`;
  if (d === 0) return "vence hoy";
  return `vence en ${d} ${d === 1 ? "día" : "días"}`;
}

export function GarantiasHitosPanel({ apiBaseUrl, token, propertyId, tenderId }: GarantiasHitosPanelProps) {
  const { confirmar, dialogo } = useConfirm();
  const [data, setData] = useState<PostAwardOverview | null>(null);
  const [bitacora, setBitacora] = useState<readonly BitacoraEntrada[]>([]);
  const [responsables, setResponsables] = useState<readonly Responsable[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [accionError, setAccionError] = useState<string | null>(null);
  const [twoFactor, setTwoFactor] = useState<TwoFactorStatus>(TWO_FACTOR_UNAVAILABLE);

  const cargar = useCallback(async () => {
    const overview = await fetchPostAward(fetch, apiBaseUrl, token, propertyId, tenderId);
    setData(overview);
    if (overview.available) {
      const [b, r] = await Promise.all([
        fetchPostAwardBitacora(fetch, apiBaseUrl, token, propertyId, tenderId).catch(() => [] as readonly BitacoraEntrada[]),
        fetchResponsables(fetch, apiBaseUrl, token, propertyId, tenderId).catch(() => [] as readonly Responsable[]),
      ]);
      setBitacora(b);
      setResponsables(r);
    }
  }, [apiBaseUrl, token, propertyId, tenderId]);

  useEffect(() => {
    let vivo = true;
    setData(null);
    setLoadError(null);
    cargar().catch((err: unknown) => {
      if (vivo) setLoadError(err instanceof Error ? err.message : "No se pudo cargar el seguimiento de garantías e hitos.");
    });
    return () => {
      vivo = false;
    };
  }, [cargar]);

  useEffect(() => {
    let vivo = true;
    void fetchTwoFactorStatus(fetch, apiBaseUrl, token).then((s) => {
      if (vivo) setTwoFactor(s);
    });
    return () => {
      vivo = false;
    };
  }, [apiBaseUrl, token]);

  const nombreResponsable = useMemo(() => new Map(responsables.map((r) => [r.userId, r.nombre])), [responsables]);

  // ---- Plazos ----
  const [plazosAbierto, setPlazosAbierto] = useState(false);
  const [pFallo, setPFallo] = useState("");
  const [pFirmaDias, setPFirmaDias] = useState("");
  const [pFirmado, setPFirmado] = useState("");
  const [pGarantiaDias, setPGarantiaDias] = useState("");
  const [plazosError, setPlazosError] = useState<string | null>(null);
  const [plazosGuardando, setPlazosGuardando] = useState(false);

  function abrirPlazos() {
    const p = data?.plazos;
    setPFallo(p?.falloNotificadoEn ?? "");
    setPFirmaDias(p?.plazoFirmaDias != null ? String(p.plazoFirmaDias) : "");
    setPFirmado(p?.firmadoEn ?? "");
    setPGarantiaDias(p?.plazoGarantiaDias != null ? String(p.plazoGarantiaDias) : "");
    setPlazosError(null);
    setPlazosAbierto(true);
  }

  async function guardarPlazosForm() {
    const dias = (t: string, campo: string): number | null | "mal" => {
      if (t.trim() === "") return null;
      const n = Number(t);
      if (!Number.isInteger(n) || n < 1 || n > 90) {
        setPlazosError(`${campo}: escribe un número entero de días hábiles entre 1 y 90.`);
        return "mal";
      }
      return n;
    };
    const firma = dias(pFirmaDias, "Plazo de firma");
    if (firma === "mal") return;
    const garantia = dias(pGarantiaDias, "Plazo de entrega de garantía");
    if (garantia === "mal") return;
    setPlazosError(null);
    setPlazosGuardando(true);
    try {
      const r = await guardarPlazos(fetch, apiBaseUrl, token, propertyId, tenderId, { falloNotificadoEn: pFallo || null, plazoFirmaDias: firma, firmadoEn: pFirmado || null, plazoGarantiaDias: garantia });
      setPlazosAbierto(false);
      await cargar();
      setAviso(r.garantiasActualizadas > 0 ? `Plazos guardados. La fecha límite de ${r.garantiasActualizadas} garantía(s) pendiente(s) se recalculó.` : "Plazos guardados.");
    } catch (err) {
      setPlazosError(err instanceof Error ? err.message : "No se pudieron guardar los plazos.");
    } finally {
      setPlazosGuardando(false);
    }
  }

  // ---- Garantias ----
  interface GarantiaForm {
    readonly id: string | null;
    readonly clave: string;
  }
  const [gForm, setGForm] = useState<GarantiaForm | null>(null);
  const [gTipo, setGTipo] = useState<GarantiaTipo>("cumplimiento");
  const [gMonto, setGMonto] = useState("");
  const [gPorcentaje, setGPorcentaje] = useState("");
  const [gAfianzadora, setGAfianzadora] = useState("");
  const [gPoliza, setGPoliza] = useState("");
  const [gDesde, setGDesde] = useState("");
  const [gHasta, setGHasta] = useState("");
  const [gLimite, setGLimite] = useState("");
  const [gNotas, setGNotas] = useState("");
  const [gError, setGError] = useState<string | null>(null);
  const [gGuardando, setGGuardando] = useState(false);

  function abrirGarantia(g: GarantiaRecord | null) {
    setGForm({ id: g?.id ?? null, clave: nuevaClaveIdempotencia() });
    setGTipo(g?.tipo ?? "cumplimiento");
    setGMonto(g?.monto ?? "");
    setGPorcentaje(g?.porcentaje != null ? String(g.porcentaje) : "");
    setGAfianzadora(g?.afianzadora ?? "");
    setGPoliza(g?.numeroPoliza ?? "");
    setGDesde(g?.vigenciaDesde ?? "");
    setGHasta(g?.vigenciaHasta ?? "");
    setGLimite(g?.fechaLimiteEntrega ?? "");
    setGNotas(g?.notas ?? "");
    setGError(null);
  }

  async function guardarGarantiaForm() {
    if (!gForm) return;
    if (!/^\d+(\.\d{1,2})?$/.test(gMonto.trim())) return setGError('El monto debe ser una cantidad válida, p. ej. "125000.50".');
    if (!gDesde || !gHasta) return setGError("Declara el inicio y el fin de la vigencia.");
    if (gHasta < gDesde) return setGError("El fin de la vigencia no puede ser anterior al inicio.");
    let porcentaje: number | null = null;
    if (gPorcentaje.trim() !== "") {
      porcentaje = Number(gPorcentaje);
      if (!Number.isFinite(porcentaje) || porcentaje < 0.01 || porcentaje > 100) return setGError("El porcentaje debe estar entre 0.01 y 100.");
    }
    setGError(null);
    setGGuardando(true);
    try {
      if (gForm.id) {
        await actualizarGarantia(fetch, apiBaseUrl, token, propertyId, tenderId, gForm.id, {
          monto: gMonto.trim(),
          porcentaje,
          afianzadora: gAfianzadora.trim() || null,
          numeroPoliza: gPoliza.trim() || null,
          vigenciaDesde: gDesde,
          vigenciaHasta: gHasta,
          fechaLimiteEntrega: gLimite || null,
          notas: gNotas.trim() || null,
        });
      } else {
        await crearGarantia(
          fetch,
          apiBaseUrl,
          token,
          propertyId,
          tenderId,
          { tipo: gTipo, monto: gMonto.trim(), porcentaje, afianzadora: gAfianzadora.trim() || null, numeroPoliza: gPoliza.trim() || null, vigenciaDesde: gDesde, vigenciaHasta: gHasta, ...(gLimite ? { fechaLimiteEntrega: gLimite } : {}), notas: gNotas.trim() || null },
          gForm.clave,
        );
      }
      setGForm(null);
      await cargar();
      setAviso(gForm.id ? "Garantía actualizada." : "Garantía registrada.");
    } catch (err) {
      setGError(err instanceof Error ? err.message : "No se pudo guardar la garantía.");
    } finally {
      setGGuardando(false);
    }
  }

  // Marcar entregada: pide la fecha real de entrega (no se asume).
  const [entregaId, setEntregaId] = useState<string | null>(null);
  const [entregaFecha, setEntregaFecha] = useState("");
  const [entregaError, setEntregaError] = useState<string | null>(null);
  const [entregaGuardando, setEntregaGuardando] = useState(false);

  async function marcarEntregada() {
    if (!entregaId) return;
    if (!entregaFecha) return setEntregaError("Declara la fecha en que se entregó la garantía.");
    setEntregaError(null);
    setEntregaGuardando(true);
    try {
      await actualizarGarantia(fetch, apiBaseUrl, token, propertyId, tenderId, entregaId, { estado: "entregada", entregadaEn: entregaFecha });
      setEntregaId(null);
      await cargar();
      setAviso("Garantía marcada como entregada.");
    } catch (err) {
      setEntregaError(err instanceof Error ? err.message : "No se pudo marcar la garantía como entregada.");
    } finally {
      setEntregaGuardando(false);
    }
  }

  async function cambiarEstadoGarantia(g: GarantiaRecord, estado: "liberada" | "ejecutada") {
    setAccionError(null);
    const ok = await confirmar({
      titulo: estado === "liberada" ? "Liberar la garantía" : "Registrar la ejecución de la garantía",
      descripcion:
        estado === "liberada"
          ? `Se liberará la garantía de ${GARANTIA_TIPO_LABELS[g.tipo].toLowerCase()} por ${formatoMonto(g.monto)}. Una garantía liberada ya no se edita.`
          : `Se registrará que la garantía de ${GARANTIA_TIPO_LABELS[g.tipo].toLowerCase()} por ${formatoMonto(g.monto)} fue ejecutada. Una garantía ejecutada ya no se edita.`,
      tono: estado === "ejecutada" ? "danger" : "default",
      confirmar: estado === "liberada" ? "Liberar" : "Registrar ejecución",
    });
    if (!ok) return;
    try {
      await actualizarGarantia(fetch, apiBaseUrl, token, propertyId, tenderId, g.id, { estado });
      await cargar();
      setAviso(estado === "liberada" ? "Garantía liberada." : "Ejecución registrada.");
    } catch (err) {
      setAccionError(err instanceof Error ? err.message : "No se pudo cambiar el estado de la garantía.");
    }
  }

  // ---- Hitos ----
  interface HitoForm {
    readonly id: string | null;
    readonly clave: string;
  }
  const [hForm, setHForm] = useState<HitoForm | null>(null);
  const [hTitulo, setHTitulo] = useState("");
  const [hDescripcion, setHDescripcion] = useState("");
  const [hResponsable, setHResponsable] = useState("");
  const [hFecha, setHFecha] = useState("");
  const [hError, setHError] = useState<string | null>(null);
  const [hGuardando, setHGuardando] = useState(false);

  function abrirHito(h: HitoRecord | null) {
    setHForm({ id: h?.id ?? null, clave: nuevaClaveIdempotencia() });
    setHTitulo(h?.titulo ?? "");
    setHDescripcion(h?.descripcion ?? "");
    setHResponsable(h?.responsableId ?? "");
    setHFecha(h?.fechaCompromiso ?? "");
    setHError(null);
  }

  async function guardarHitoForm() {
    if (!hForm) return;
    if (hTitulo.trim().length < 3) return setHError("El título debe tener al menos 3 caracteres.");
    if (!hResponsable) return setHError("Elige a la persona responsable del hito.");
    if (!hFecha) return setHError("Declara la fecha comprometida.");
    setHError(null);
    setHGuardando(true);
    try {
      if (hForm.id) {
        await actualizarHito(fetch, apiBaseUrl, token, propertyId, tenderId, hForm.id, { titulo: hTitulo.trim(), descripcion: hDescripcion.trim() || null, responsableId: hResponsable, fechaCompromiso: hFecha });
      } else {
        await crearHito(fetch, apiBaseUrl, token, propertyId, tenderId, { titulo: hTitulo.trim(), descripcion: hDescripcion.trim() || null, responsableId: hResponsable, fechaCompromiso: hFecha }, hForm.clave);
      }
      setHForm(null);
      await cargar();
      setAviso(hForm.id ? "Hito actualizado." : "Hito registrado.");
    } catch (err) {
      setHError(err instanceof Error ? err.message : "No se pudo guardar el hito.");
    } finally {
      setHGuardando(false);
    }
  }

  async function cambiarEstadoHito(h: HitoRecord, estado: "cumplido" | "cancelado") {
    setAccionError(null);
    const ok = await confirmar({
      titulo: estado === "cumplido" ? "Marcar el hito como cumplido" : "Cancelar el hito",
      descripcion: estado === "cumplido" ? `“${h.titulo}” quedará cumplido con la fecha de hoy. Un hito cumplido ya no se edita.` : `“${h.titulo}” quedará cancelado y ya no se edita.`,
      tono: estado === "cancelado" ? "danger" : "default",
      confirmar: estado === "cumplido" ? "Marcar cumplido" : "Cancelar hito",
      cancelar: "Volver",
    });
    if (!ok) return;
    try {
      await actualizarHito(fetch, apiBaseUrl, token, propertyId, tenderId, h.id, { estado });
      await cargar();
      setAviso(estado === "cumplido" ? "Hito marcado como cumplido." : "Hito cancelado.");
    } catch (err) {
      setAccionError(err instanceof Error ? err.message : "No se pudo actualizar el hito.");
    }
  }

  // ---- Convenios ----
  const [cAbierto, setCAbierto] = useState(false);
  const claveConvenio = useRef("");
  const [cTipo, setCTipo] = useState<ConvenioTipo>("plazo");
  const [cMonto, setCMonto] = useState("");
  const [cFin, setCFin] = useState("");
  const [cFirma, setCFirma] = useState("");
  const [cMotivo, setCMotivo] = useState("");
  const [cCodigo, setCCodigo] = useState("");
  const [cError, setCError] = useState<string | null>(null);
  const [cGuardando, setCGuardando] = useState(false);

  function abrirConvenio() {
    claveConvenio.current = nuevaClaveIdempotencia();
    setCTipo("plazo");
    setCMonto("");
    setCFin("");
    setCFirma("");
    setCMotivo("");
    setCCodigo("");
    setCError(null);
    setCAbierto(true);
  }

  async function guardarConvenioForm() {
    const conMonto = cTipo !== "plazo";
    const conFin = cTipo !== "monto";
    if (conMonto && !/^-?\d+(\.\d{1,2})?$/.test(cMonto.trim())) return setCError('El ajuste debe ser una cantidad válida con signo, p. ej. "12000.00" o "-5000.00".');
    if (conMonto && Number(cMonto) === 0) return setCError("El ajuste de monto no puede ser cero.");
    if (conFin && !cFin) return setCError("Declara la nueva fecha de fin de vigencia del contrato.");
    if (!cFirma) return setCError("Declara la fecha de firma del convenio.");
    if (cMotivo.trim().length < 3) return setCError("Escribe el motivo del convenio.");
    const necesitaStepUp = twoFactor.available && twoFactor.enabled;
    const factor = necesitaStepUp ? secondFactorFromText(cCodigo) : null;
    if (necesitaStepUp && !factor) return setCError("Escribe el código de 6 dígitos de tu app de autenticación (o un código de respaldo).");
    setCError(null);
    setCGuardando(true);
    try {
      const stepUpToken = factor ? await requestStepUpToken(fetch, apiBaseUrl, token, "contract_sensitive", factor) : null;
      await crearConvenio(fetch, apiBaseUrl, token, propertyId, tenderId, { tipo: cTipo, ...(conMonto ? { montoDelta: cMonto.trim() } : {}), ...(conFin ? { nuevaFechaFin: cFin } : {}), fechaFirma: cFirma, motivo: cMotivo.trim() }, claveConvenio.current, stepUpToken);
      setCAbierto(false);
      await cargar();
      setAviso("Convenio modificatorio registrado. Queda en el historial y el contrato ya refleja la nueva vigencia.");
    } catch (err) {
      setCError(err instanceof Error ? err.message : "No se pudo registrar el convenio.");
    } finally {
      setCGuardando(false);
    }
  }

  // ---- Columnas ----
  const puedeEscribir = data?.available === true && data.puedeEscribir;
  const puedeDecidir = data?.available === true && data.puedeDecidir;

  const columnasGarantias: DataTableColumna<GarantiaRecord>[] = [
    {
      id: "tipo",
      encabezado: "Garantía",
      principal: true,
      valorOrden: (g) => g.tipo,
      celda: (g) => (
        <div>
          <p className="font-medium text-foreground">{GARANTIA_TIPO_LABELS[g.tipo]}</p>
          <p className="text-xs text-muted-foreground">{[g.afianzadora, g.numeroPoliza ? `Póliza ${g.numeroPoliza}` : null].filter(Boolean).join(" · ") || "Sin afianzadora ni póliza"}</p>
        </div>
      ),
    },
    { id: "monto", encabezado: "Monto", alinear: "right", celda: (g) => <span className="whitespace-nowrap">{formatoMonto(g.monto)}{g.porcentaje != null ? ` · ${g.porcentaje}%` : ""}</span> },
    {
      id: "vigencia",
      encabezado: "Vigencia",
      valorOrden: (g) => g.vigenciaHasta,
      celda: (g) => (
        <div className="whitespace-nowrap">
          <p>
            {formatFechaSolo(g.vigenciaDesde)} – {formatFechaSolo(g.vigenciaHasta)}
          </p>
          {textoVencimiento(g) ? <p className={g.vigencia.vencidaPorFecha ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{textoVencimiento(g)}</p> : null}
        </div>
      ),
    },
    {
      id: "estado",
      encabezado: "Estado",
      valorOrden: (g) => g.vigencia.estadoEfectivo,
      celda: (g) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge tone={statusTone(GARANTIA_ESTADO_TONES, g.vigencia.estadoEfectivo)}>{GARANTIA_ESTADO_LABELS[g.vigencia.estadoEfectivo]}</StatusBadge>
          {g.estado === "pendiente_entrega" && g.fechaLimiteEntrega ? (
            <span className={g.vigencia.entregaVencida ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {g.vigencia.entregaVencida ? "Entrega vencida" : "Entregar antes del"} {formatFechaSolo(g.fechaLimiteEntrega)}
            </span>
          ) : null}
          {g.entregadaEn ? <span className="text-xs text-muted-foreground">Entregada {formatFechaSolo(g.entregadaEn)}</span> : null}
        </div>
      ),
    },
    {
      id: "acciones",
      encabezado: "Acciones",
      etiqueta: "Acciones de la garantía",
      ocultarEnTarjeta: false,
      celda: (g) => {
        const final = g.estado === "liberada" || g.estado === "ejecutada";
        if (final || !puedeEscribir) return <span className="text-xs text-muted-foreground">{final ? "Cerrada" : "—"}</span>;
        return (
          <div className="flex flex-wrap gap-1.5">
            <Button type="button" size="sm" variant="outline" onClick={() => abrirGarantia(g)}>
              Editar
            </Button>
            {g.estado === "pendiente_entrega" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setEntregaId(g.id);
                  setEntregaFecha(data?.hoy ?? "");
                  setEntregaError(null);
                }}
              >
                Marcar entregada
              </Button>
            ) : null}
            {puedeDecidir && g.estado !== "pendiente_entrega" ? (
              <>
                <Button type="button" size="sm" variant="outline" onClick={() => void cambiarEstadoGarantia(g, "liberada")}>
                  Liberar
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => void cambiarEstadoGarantia(g, "ejecutada")}>
                  Ejecutada
                </Button>
              </>
            ) : null}
          </div>
        );
      },
    },
  ];

  const columnasHitos: DataTableColumna<HitoRecord>[] = [
    {
      id: "titulo",
      encabezado: "Hito",
      principal: true,
      valorOrden: (h) => h.titulo,
      celda: (h) => (
        <div>
          <p className="font-medium text-foreground">{h.titulo}</p>
          {h.descripcion ? <p className="text-xs text-muted-foreground">{h.descripcion}</p> : null}
        </div>
      ),
    },
    { id: "responsable", encabezado: "Responsable", celda: (h) => (h.responsableId ? (nombreResponsable.get(h.responsableId) ?? "Miembro del equipo") : "Sin responsable (baja del equipo)") },
    {
      id: "fecha",
      encabezado: "Fecha comprometida",
      valorOrden: (h) => h.fechaCompromiso,
      celda: (h) => (
        <div className="whitespace-nowrap">
          <p>{formatFechaSolo(h.fechaCompromiso)}</p>
          {h.vigencia.vencido ? <p className="text-xs text-destructive">{h.vigencia.diasDeRetraso} {h.vigencia.diasDeRetraso === 1 ? "día" : "días"} de retraso</p> : null}
          {h.cumplidoEn ? <p className="text-xs text-muted-foreground">Cumplido {formatFechaSolo(h.cumplidoEn)}</p> : null}
        </div>
      ),
    },
    { id: "estado", encabezado: "Estado", valorOrden: (h) => h.vigencia.estadoEfectivo, celda: (h) => <StatusBadge tone={statusTone(HITO_ESTADO_TONES, h.vigencia.estadoEfectivo)}>{h.vigencia.estadoEfectivo === "vencido" ? "Vencido" : h.estado === "pendiente" ? "Pendiente" : h.estado === "cumplido" ? "Cumplido" : "Cancelado"}</StatusBadge> },
    {
      id: "acciones",
      encabezado: "Acciones",
      etiqueta: "Acciones del hito",
      celda: (h) =>
        h.estado !== "pendiente" || !puedeEscribir ? (
          <span className="text-xs text-muted-foreground">{h.estado !== "pendiente" ? "Cerrado" : "—"}</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <Button type="button" size="sm" variant="outline" onClick={() => abrirHito(h)}>
              Editar
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void cambiarEstadoHito(h, "cumplido")}>
              Cumplido
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void cambiarEstadoHito(h, "cancelado")}>
              Cancelar
            </Button>
          </div>
        ),
    },
  ];

  const columnasConvenios: DataTableColumna<ConvenioRecord>[] = [
    { id: "numero", encabezado: "No.", principal: true, valorOrden: (c) => c.numero, celda: (c) => `Convenio ${c.numero}` },
    { id: "tipo", encabezado: "Tipo", celda: (c) => CONVENIO_TIPO_LABELS[c.tipo] },
    { id: "monto", encabezado: "Ajuste de monto", alinear: "right", celda: (c) => (c.montoDelta ? <span className="whitespace-nowrap">{formatoMonto(c.montoDelta)}</span> : "—") },
    {
      id: "plazo",
      encabezado: "Vigencia del contrato",
      celda: (c) => (c.nuevaFechaFin ? <span className="whitespace-nowrap">{c.fechaFinAnterior ? `${formatFechaSolo(c.fechaFinAnterior)} → ` : ""}{formatFechaSolo(c.nuevaFechaFin)}</span> : "—"),
    },
    { id: "firma", encabezado: "Firma", valorOrden: (c) => c.fechaFirma, celda: (c) => formatFechaSolo(c.fechaFirma) },
    { id: "motivo", encabezado: "Motivo", celda: (c) => c.motivo },
  ];

  if (loadError) return <EstadoError mensaje={loadError} onReintentar={() => void cargar().catch((err: unknown) => setLoadError(err instanceof Error ? err.message : "No se pudo cargar."))} />;
  if (!data) return <EstadoCargando lineas={3} etiqueta="Cargando garantías e hitos…" />;
  if (!data.available) {
    return (
      <Callout tone="warning" titulo="Garantías, hitos y convenios: aún no disponibles">
        Este seguimiento requiere la migración 035 de licitaciones, que todavía no está aplicada en este ambiente. Mientras tanto no hay nada que registrar aquí; la cobranza y las inconformidades siguen funcionando.
      </Callout>
    );
  }

  const garantias = data.garantias ?? [];
  const hitos = data.hitos ?? [];
  const convenios = data.convenios ?? [];
  const resumen = data.resumen;
  const calculados = data.plazosCalculados;

  return (
    <div className="flex flex-col gap-4">
      {aviso ? <Callout tone="success" titulo="Listo">{aviso}</Callout> : null}
      {accionError ? (
        <p role="alert" className="text-sm text-destructive">
          {accionError}
        </p>
      ) : null}

      {resumen ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard icon={ShieldCheck} label="Garantías entregadas" value={String(resumen.garantiasEntregadas)} nota={`${resumen.garantiasPendientes} pendiente(s) de entrega`} />
          <StatCard icon={AlertTriangle} label="Por vencer o vencidas" value={String(resumen.garantiasPorVencer + resumen.garantiasVencidas + resumen.garantiasEntregaVencida)} nota={`${resumen.garantiasPorVencer} por vencer · ${resumen.garantiasVencidas} vencida(s) · ${resumen.garantiasEntregaVencida} sin entregar a tiempo`} />
          <StatCard icon={ListChecks} label="Hitos vencidos" value={String(resumen.hitosVencidos)} nota={`${resumen.hitosPendientes} pendiente(s)`} />
          <StatCard icon={CircleDollarSign} label="Ajuste de monto acumulado" value={formatoMonto(resumen.ajusteDeMontoAcumulado)} nota={`${convenios.length} convenio(s)`} />
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">Plazos de firma y de entrega de garantía</CardTitle>
              <CardDescription>Los días los declaras según las bases o el fallo; las fechas límite se cuentan en días hábiles con el calendario de días inhábiles.</CardDescription>
            </div>
            {puedeEscribir ? (
              <Button type="button" size="sm" variant="outline" onClick={abrirPlazos}>
                Editar plazos
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <StatCard
              icon={CalendarClock}
              label="Límite para firmar el contrato"
              value={calculados?.fechaLimiteFirma ? formatFechaSolo(calculados.fechaLimiteFirma) : "—"}
              nota={calculados?.fechaLimiteFirma ? (calculados.firmaVencida ? "Venció sin fecha de firma registrada" : data.plazos?.firmadoEn ? `Firmado el ${formatFechaSolo(data.plazos.firmadoEn)}` : "Pendiente de firma") : undefined}
              sinDato={calculados?.fechaLimiteFirma ? undefined : "Declara la fecha de notificación del fallo y los días de plazo."}
            />
            <StatCard
              icon={CalendarClock}
              label="Límite para entregar la garantía"
              value={calculados?.fechaLimiteEntregaGarantia ? formatFechaSolo(calculados.fechaLimiteEntregaGarantia) : "—"}
              sinDato={calculados?.fechaLimiteEntregaGarantia ? undefined : "Declara la fecha de firma y los días de plazo."}
            />
          </div>
          <Callout tone="info" titulo="Validar con abogado">
            {calculados?.nota} {calculados?.calendarioNota}
          </Callout>
          {(calculados?.avisos ?? []).map((a) => (
            <Callout key={a} tone="warning">
              {a}
            </Callout>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">Garantías del contrato</CardTitle>
              <CardDescription>Cumplimiento, anticipo y vicios ocultos, con afianzadora, póliza y vigencia. Liberar o registrar la ejecución es una decisión: la toman owner, admin y analista.</CardDescription>
            </div>
            {puedeEscribir ? (
              <Button type="button" size="sm" onClick={() => abrirGarantia(null)}>
                Nueva garantía
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          <DataTable
            etiqueta="Garantías del contrato"
            columnas={columnasGarantias}
            filas={garantias}
            obtenerId={(g) => g.id}
            atributosFila={(g) => ({ "data-garantia-id": g.id })}
            vacio={{ titulo: "Sin garantías registradas", mensaje: "Registra las garantías del contrato para seguir su vigencia y recibir avisos antes de que venzan." }}
            paginacion={{ tamano: 10 }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">Hitos del contrato</CardTitle>
              <CardDescription>Cada hito tiene una persona responsable del equipo y una fecha comprometida; si pasa sin cumplirse se avisa en la campana.</CardDescription>
            </div>
            {puedeEscribir ? (
              <Button type="button" size="sm" onClick={() => abrirHito(null)} disabled={responsables.length === 0}>
                Nuevo hito
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          <DataTable
            etiqueta="Hitos del contrato"
            columnas={columnasHitos}
            filas={hitos}
            obtenerId={(h) => h.id}
            atributosFila={(h) => ({ "data-hito-id": h.id })}
            vacio={{ titulo: "Sin hitos registrados", mensaje: "Registra los entregables y fechas comprometidas del contrato, cada uno con su responsable." }}
            paginacion={{ tamano: 10 }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">Convenios modificatorios</CardTitle>
              <CardDescription>Ajustes de monto y plazo con su historial inmutable: nada se edita ni se borra. Registrarlos es una decisión sensible: owner, admin y analista, con confirmación en dos pasos si la tienes activa.</CardDescription>
            </div>
            {puedeDecidir ? (
              <Button type="button" size="sm" onClick={abrirConvenio}>
                Registrar convenio
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          <DataTable
            etiqueta="Convenios modificatorios"
            columnas={columnasConvenios}
            filas={convenios}
            obtenerId={(c) => c.id}
            vacio={{ titulo: "Sin convenios modificatorios", mensaje: "Cuando se firme un convenio que cambie el monto o el plazo del contrato, regístralo aquí." }}
            paginacion={{ tamano: 10 }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bitácora de cambios</CardTitle>
          <CardDescription>Registro automático e inalterable de cada alta y cada cambio de plazos, garantías, hitos y convenios.</CardDescription>
        </CardHeader>
        <CardContent>
          {bitacora.length === 0 ? (
            <p className="text-sm text-muted-foreground">Todavía no hay cambios registrados.</p>
          ) : (
            <ul className="divide-y rounded-md border text-sm">
              {bitacora.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 p-2.5">
                  <span>
                    <span className="font-medium">{BITACORA_ENTIDAD_LABELS[b.entidad]}</span> · {BITACORA_ACCION_LABELS[b.accion]}
                    {typeof b.detalle.estado === "string" ? <span className="text-muted-foreground"> · {String(b.detalle.estado).replaceAll("_", " ")}</span> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatDateTime(b.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <FormDialog
        open={plazosAbierto}
        onOpenChange={(abierto) => !abierto && !plazosGuardando && setPlazosAbierto(false)}
        titulo="Plazos de firma y de entrega de garantía"
        subtitulo="Los días son hábiles. Déjalos vacíos si todavía no los conoces: no se calcula ninguna fecha sin datos."
        anchoClase="max-w-2xl"
        onGuardar={() => void guardarPlazosForm()}
        guardando={plazosGuardando}
        textoBotonGuardar="Guardar plazos"
        bloquearCierre={plazosGuardando}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Fallo notificado el">
            <Input type="date" value={pFallo} onChange={(e) => setPFallo(e.target.value)} />
          </FormField>
          <FormField label="Días hábiles para firmar" hint="Entre 1 y 90, según las bases o el fallo.">
            <Input inputMode="numeric" value={pFirmaDias} onChange={(e) => setPFirmaDias(e.target.value)} />
          </FormField>
          <FormField label="Contrato firmado el">
            <Input type="date" value={pFirmado} onChange={(e) => setPFirmado(e.target.value)} />
          </FormField>
          <FormField label="Días hábiles para entregar la garantía" hint="Se cuentan desde la firma.">
            <Input inputMode="numeric" value={pGarantiaDias} onChange={(e) => setPGarantiaDias(e.target.value)} />
          </FormField>
        </div>
        {plazosError ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {plazosError}
          </p>
        ) : null}
      </FormDialog>

      <FormDialog
        open={gForm !== null}
        onOpenChange={(abierto) => !abierto && !gGuardando && setGForm(null)}
        titulo={gForm?.id ? "Editar garantía" : "Nueva garantía"}
        subtitulo="El monto va en pesos con hasta dos decimales. La vigencia se vigila y avisa 30 días antes de terminar."
        anchoClase="max-w-2xl"
        onGuardar={() => void guardarGarantiaForm()}
        guardando={gGuardando}
        textoBotonGuardar={gForm?.id ? "Guardar cambios" : "Registrar garantía"}
        bloquearCierre={gGuardando}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Tipo" required>
            <NativeSelect value={gTipo} onChange={(e) => setGTipo(e.target.value as GarantiaTipo)} disabled={gForm?.id != null}>
              {(Object.keys(GARANTIA_TIPO_LABELS) as GarantiaTipo[]).map((t) => (
                <option key={t} value={t}>
                  {GARANTIA_TIPO_LABELS[t]}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Monto (MXN)" required>
            <Input inputMode="decimal" value={gMonto} onChange={(e) => setGMonto(e.target.value)} placeholder="125000.50" />
          </FormField>
          <FormField label="Porcentaje del contrato (%)" hint="Opcional.">
            <Input inputMode="decimal" value={gPorcentaje} onChange={(e) => setGPorcentaje(e.target.value)} placeholder="10" />
          </FormField>
          <FormField label="Afianzadora">
            <Input value={gAfianzadora} onChange={(e) => setGAfianzadora(e.target.value)} maxLength={200} />
          </FormField>
          <FormField label="Número de póliza">
            <Input value={gPoliza} onChange={(e) => setGPoliza(e.target.value)} maxLength={100} />
          </FormField>
          <FormField label="Fecha límite de entrega" hint="Vacía en cumplimiento: se calcula de los plazos del contrato si ya los declaraste.">
            <Input type="date" value={gLimite} onChange={(e) => setGLimite(e.target.value)} />
          </FormField>
          <FormField label="Vigencia desde" required>
            <Input type="date" value={gDesde} onChange={(e) => setGDesde(e.target.value)} />
          </FormField>
          <FormField label="Vigencia hasta" required>
            <Input type="date" value={gHasta} onChange={(e) => setGHasta(e.target.value)} />
          </FormField>
          <FormField label="Notas" className="sm:col-span-2">
            <Textarea value={gNotas} onChange={(e) => setGNotas(e.target.value)} rows={2} maxLength={1000} />
          </FormField>
        </div>
        {gError ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {gError}
          </p>
        ) : null}
      </FormDialog>

      <FormDialog
        open={entregaId !== null}
        onOpenChange={(abierto) => !abierto && !entregaGuardando && setEntregaId(null)}
        titulo="Marcar garantía como entregada"
        subtitulo="Declara la fecha real en que se entregó la fianza a la convocante."
        anchoClase="max-w-lg"
        onGuardar={() => void marcarEntregada()}
        guardando={entregaGuardando}
        textoBotonGuardar="Marcar entregada"
        bloquearCierre={entregaGuardando}
      >
        <FormField label="Fecha de entrega" required>
          <Input type="date" value={entregaFecha} onChange={(e) => setEntregaFecha(e.target.value)} />
        </FormField>
        {entregaError ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {entregaError}
          </p>
        ) : null}
      </FormDialog>

      <FormDialog
        open={hForm !== null}
        onOpenChange={(abierto) => !abierto && !hGuardando && setHForm(null)}
        titulo={hForm?.id ? "Editar hito" : "Nuevo hito"}
        subtitulo="El responsable es una persona del equipo de tu organización."
        anchoClase="max-w-2xl"
        onGuardar={() => void guardarHitoForm()}
        guardando={hGuardando}
        textoBotonGuardar={hForm?.id ? "Guardar cambios" : "Registrar hito"}
        bloquearCierre={hGuardando}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Título" required className="sm:col-span-2">
            <Input value={hTitulo} onChange={(e) => setHTitulo(e.target.value)} maxLength={200} />
          </FormField>
          <FormField label="Responsable" required>
            <NativeSelect value={hResponsable} onChange={(e) => setHResponsable(e.target.value)}>
              <option value="">Elige a una persona</option>
              {responsables.map((r) => (
                <option key={r.userId} value={r.userId}>
                  {r.nombre}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Fecha comprometida" required>
            <Input type="date" value={hFecha} onChange={(e) => setHFecha(e.target.value)} />
          </FormField>
          <FormField label="Descripción" className="sm:col-span-2">
            <Textarea value={hDescripcion} onChange={(e) => setHDescripcion(e.target.value)} rows={2} maxLength={1000} />
          </FormField>
        </div>
        {hError ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {hError}
          </p>
        ) : null}
      </FormDialog>

      <FormDialog
        open={cAbierto}
        onOpenChange={(abierto) => !abierto && !cGuardando && setCAbierto(false)}
        titulo="Registrar convenio modificatorio"
        subtitulo="Queda en el historial y no se puede editar ni borrar. Si cambia el plazo, el contrato toma la nueva fecha de fin."
        anchoClase="max-w-2xl"
        onGuardar={() => void guardarConvenioForm()}
        guardando={cGuardando}
        textoBotonGuardar="Registrar convenio"
        bloquearCierre={cGuardando}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Tipo" required>
            <NativeSelect value={cTipo} onChange={(e) => setCTipo(e.target.value as ConvenioTipo)}>
              {(Object.keys(CONVENIO_TIPO_LABELS) as ConvenioTipo[]).map((t) => (
                <option key={t} value={t}>
                  {CONVENIO_TIPO_LABELS[t]}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Fecha de firma del convenio" required>
            <Input type="date" value={cFirma} onChange={(e) => setCFirma(e.target.value)} />
          </FormField>
          {cTipo !== "plazo" ? (
            <FormField label="Ajuste de monto (MXN)" required hint="Positivo = incremento; negativo = reducción.">
              <Input inputMode="decimal" value={cMonto} onChange={(e) => setCMonto(e.target.value)} placeholder="-5000.00" />
            </FormField>
          ) : null}
          {cTipo !== "monto" ? (
            <FormField label="Nueva fecha de fin del contrato" required>
              <Input type="date" value={cFin} onChange={(e) => setCFin(e.target.value)} />
            </FormField>
          ) : null}
          <FormField label="Motivo" required className="sm:col-span-2">
            <Textarea value={cMotivo} onChange={(e) => setCMotivo(e.target.value)} rows={2} maxLength={1000} />
          </FormField>
          {twoFactor.available && twoFactor.enabled ? (
            <FormField label="Código de verificación en dos pasos" required hint="Código de tu app de autenticación (o uno de respaldo): es una acción sensible." className="sm:col-span-2">
              <Input value={cCodigo} onChange={(e) => setCCodigo(e.target.value)} autoComplete="one-time-code" placeholder="6 dígitos, o un código de respaldo" />
            </FormField>
          ) : null}
        </div>
        {cError ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {cError}
          </p>
        ) : null}
      </FormDialog>
      {dialogo}
    </div>
  );
}
