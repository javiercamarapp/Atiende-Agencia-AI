// Panel de devolución de IVA -- hallazgo de auditoría (severidad ALTA, "Siete
// módulos con ruta HTTP real y sin UI", penúltima porción tras vencimientos/
// declaraciones/nómina/conciliación/migración de catálogo): devolucion-iva.ts
// expone GET /facturas/:periodo y 7 POST (diot, conciliacion, saldo-favor,
// congruencia, solicitud, plazo-resolucion, papel-trabajo) sobre el motor
// completo de @atiende/domain-despachos/devolucion-iva/, pero ningún cliente
// web ni página los usaba. Esta página cierra el gap con un flujo guiado de 8
// pasos, en el MISMO orden en que la ruta HTTP los declara -- cada paso
// alimenta al siguiente con los datos que ya calculó (facturas -> DIOT ->
// conciliación -> saldo a favor -> congruencia -> solicitud -> plazo de
// resolución -> papel de trabajo), nunca captura suelta sin relación.
//
// Ninguna "solicitud de devolución" se persiste server-side en esta fase (ver
// cabecera de devolucion-iva.ts): el resultado del paso 6 se muestra tal cual,
// es responsabilidad de quien opera el despacho archivarlo donde corresponda.
//
// Presentación (ronda de design system): los objetos de estilo inline
// (inputStyle/labelStyle/sectionStyle/buttonPrimary/buttonSecondary/cellInput)
// se sustituyeron por Card/Input/Label/Button/Badge/Table de @atiende/ui. Los 8
// pasos siguen apilados en el mismo orden (NO son pestañas): cada uno consume el
// resultado del anterior y el contador los recorre en secuencia, así que
// esconderlos detrás de un switcher rompería el flujo guiado real.
import { useState } from "react";
import type { FormEvent } from "react";
import { Calculator, CalendarClock, CheckCircle2, ClipboardList, Download, FileSpreadsheet, ListChecks, Lock, Plus, Send, Trash2 } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  EstadoVacio,
  FormField,
  Input,
  Label,
  NativeSelect,
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
} from "@atiende/ui";
import {
  fetchFacturasPeriodoDevolucionIva,
  postCongruenciaDevolucionIva,
  postConciliacionDevolucionIva,
  postDiotDevolucionIva,
  postPapelTrabajoDevolucionIva,
  postPlazoResolucionDevolucionIva,
  postSaldoFavorDevolucionIva,
  postSolicitudDevolucionIva,
} from "../lib/devolucion-iva-client.ts";
import type {
  ClasificacionIva,
  CongruenciaDiotCfdiDeclaracion,
  ConciliacionDeclaracionSaldo,
  ConciliacionDiotDeclaracion,
  ConciliacionFacturaDiot,
  DeclaracionMensualIva,
  DiotEntryIva,
  FacturaCfdiIva,
  MontoDevolucion,
  PapelTrabajoDevolucionIva,
  SolicitudDevolucion,
  TipoFacturaIva,
} from "../lib/devolucion-iva-client.ts";
import { formatMoney } from "../lib/format.ts";
import { ESTATUS_VERIFICACION_TONES } from "../lib/status-tones.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo conjunto que DEVOLUCION_IVA_ROLES (@atiende/domain-despachos/roles.ts)
// -- las 8 rutas de devolucion-iva.ts exigen este rol en CADA llamada, mismo
// criterio que Conciliacion.tsx: cosmético, el servidor rechazaría igual.
const DEVOLUCION_IVA_ROLES = new Set(["admin", "contador"]);

const TIPO_FACTURA_OPTIONS: readonly TipoFacturaIva[] = ["Ingreso", "Egreso", "Traslado", "Nómina", "Pago"];
const CATEGORIA_OPTIONS: readonly ClasificacionIva[] = ["acreditable_100", "acreditable_proporcional", "no_acreditable"];
const CATEGORIA_LABELS: Record<ClasificacionIva, string> = { acreditable_100: "Acreditable 100%", acreditable_proporcional: "Acreditable proporcional", no_acreditable: "No acreditable" };

interface FacturaFila {
  readonly key: string;
  uuid: string;
  rfcEmisor: string;
  nombreEmisor: string;
  rfcReceptor: string;
  fecha: string;
  subtotal: string;
  iva: string;
  total: string;
  tipo: TipoFacturaIva;
  categoria: ClasificacionIva;
  proporcionalidad: string;
  referenciaComplementoPago: string;
}

let facturaSeq = 0;
function nuevaFacturaFila(base?: Partial<FacturaFila>): FacturaFila {
  facturaSeq += 1;
  return {
    key: `fac-${facturaSeq}`,
    uuid: "",
    rfcEmisor: "",
    nombreEmisor: "",
    rfcReceptor: "",
    fecha: "",
    subtotal: "",
    iva: "",
    total: "",
    tipo: "Ingreso",
    categoria: "acreditable_100",
    proporcionalidad: "1",
    referenciaComplementoPago: "",
    ...base,
  };
}

function facturaDelServidorAFila(f: FacturaCfdiIva): FacturaFila {
  return nuevaFacturaFila({
    uuid: f.uuid,
    rfcEmisor: f.rfcEmisor,
    nombreEmisor: f.nombreEmisor ?? "",
    rfcReceptor: f.rfcReceptor,
    fecha: f.fecha,
    subtotal: f.subtotal !== undefined ? String(f.subtotal) : "",
    iva: f.iva !== undefined ? String(f.iva) : "",
    total: f.total !== undefined ? String(f.total) : "",
    tipo: f.tipo ?? "Ingreso",
    categoria: f.categoria ?? "acreditable_100",
    proporcionalidad: f.proporcionalidad !== undefined ? String(f.proporcionalidad) : "1",
    referenciaComplementoPago: f.referenciaComplementoPago ?? "",
  });
}

function filaAFactura(f: FacturaFila): FacturaCfdiIva | null {
  const uuid = f.uuid.trim();
  const rfcEmisor = f.rfcEmisor.trim();
  const rfcReceptor = f.rfcReceptor.trim();
  const fecha = f.fecha.trim();
  if (!uuid || !rfcEmisor || !rfcReceptor || !fecha) return null;
  const subtotal = f.subtotal.trim() ? Number(f.subtotal) : undefined;
  const iva = f.iva.trim() ? Number(f.iva) : undefined;
  const total = f.total.trim() ? Number(f.total) : undefined;
  const proporcionalidad = f.proporcionalidad.trim() ? Number(f.proporcionalidad) : undefined;
  return {
    uuid,
    rfcEmisor: rfcEmisor.toUpperCase(),
    nombreEmisor: f.nombreEmisor.trim() || undefined,
    rfcReceptor: rfcReceptor.toUpperCase(),
    fecha,
    subtotal: subtotal !== undefined && Number.isFinite(subtotal) ? subtotal : undefined,
    iva: iva !== undefined && Number.isFinite(iva) ? iva : undefined,
    total: total !== undefined && Number.isFinite(total) ? total : undefined,
    tipo: f.tipo,
    categoria: f.categoria,
    proporcionalidad: proporcionalidad !== undefined && Number.isFinite(proporcionalidad) ? proporcionalidad : undefined,
    referenciaComplementoPago: f.referenciaComplementoPago.trim() || null,
  };
}

interface DeclaracionFila {
  readonly key: string;
  mes: string;
  año: string;
  ivaCobrado: string;
  ivaPagado: string;
  saldoFavor: string;
  saldoContra: string;
}

let declaracionSeq = 0;
function nuevaDeclaracionFila(): DeclaracionFila {
  declaracionSeq += 1;
  return { key: `decl-${declaracionSeq}`, mes: "", año: "", ivaCobrado: "", ivaPagado: "", saldoFavor: "", saldoContra: "" };
}

function filaADeclaracion(d: DeclaracionFila): DeclaracionMensualIva | null {
  const mes = d.mes.trim() ? Number(d.mes) : NaN;
  const año = d.año.trim() ? Number(d.año) : NaN;
  if (!Number.isFinite(mes) || !Number.isFinite(año)) return null;
  return {
    mes,
    año,
    ivaCobrado: d.ivaCobrado.trim() ? Number(d.ivaCobrado) || 0 : 0,
    ivaPagado: d.ivaPagado.trim() ? Number(d.ivaPagado) || 0 : 0,
    saldoFavor: d.saldoFavor.trim() ? Number(d.saldoFavor) || 0 : 0,
    saldoContra: d.saldoContra.trim() ? Number(d.saldoContra) || 0 : 0,
  };
}

function FacturasEditor({ filas, setFilas }: { filas: readonly FacturaFila[]; setFilas: (f: readonly FacturaFila[]) => void }) {
  function actualizar<K extends keyof FacturaFila>(key: string, campo: K, valor: FacturaFila[K]) {
    setFilas(filas.map((f) => (f.key === key ? { ...f, [campo]: valor } : f)));
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <Table className="min-w-[1200px]">
          <TableHeader>
            <TableRow>
              <TableHead>UUID *</TableHead>
              <TableHead>RFC emisor *</TableHead>
              <TableHead>Emisor</TableHead>
              <TableHead>RFC receptor *</TableHead>
              <TableHead>Fecha *</TableHead>
              <TableHead>Subtotal</TableHead>
              <TableHead>IVA</TableHead>
              <TableHead>Total</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Categoría</TableHead>
              <TableHead>Proporc.</TableHead>
              <TableHead>UUID REP</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filas.map((f) => (
              <TableRow key={f.key}>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-uuid-${f.key}`} className="sr-only">
                    UUID
                  </Label>
                  <Input id={`fac-uuid-${f.key}`} type="text" value={f.uuid} onChange={(e) => actualizar(f.key, "uuid", e.target.value)} className="w-40 font-mono" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-rfc-em-${f.key}`} className="sr-only">
                    RFC emisor
                  </Label>
                  <Input id={`fac-rfc-em-${f.key}`} type="text" value={f.rfcEmisor} onChange={(e) => actualizar(f.key, "rfcEmisor", e.target.value.toUpperCase())} className="w-28" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-emisor-${f.key}`} className="sr-only">
                    Emisor
                  </Label>
                  <Input id={`fac-emisor-${f.key}`} type="text" value={f.nombreEmisor} onChange={(e) => actualizar(f.key, "nombreEmisor", e.target.value)} className="w-40" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-rfc-rec-${f.key}`} className="sr-only">
                    RFC receptor
                  </Label>
                  <Input id={`fac-rfc-rec-${f.key}`} type="text" value={f.rfcReceptor} onChange={(e) => actualizar(f.key, "rfcReceptor", e.target.value.toUpperCase())} className="w-28" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-fecha-${f.key}`} className="sr-only">
                    Fecha
                  </Label>
                  <Input id={`fac-fecha-${f.key}`} type="date" value={f.fecha} onChange={(e) => actualizar(f.key, "fecha", e.target.value)} className="w-32" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-subtotal-${f.key}`} className="sr-only">
                    Subtotal
                  </Label>
                  <Input id={`fac-subtotal-${f.key}`} type="number" step="0.01" value={f.subtotal} onChange={(e) => actualizar(f.key, "subtotal", e.target.value)} className="w-24" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-iva-${f.key}`} className="sr-only">
                    IVA
                  </Label>
                  <Input id={`fac-iva-${f.key}`} type="number" step="0.01" value={f.iva} onChange={(e) => actualizar(f.key, "iva", e.target.value)} className="w-24" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-total-${f.key}`} className="sr-only">
                    Total
                  </Label>
                  <Input id={`fac-total-${f.key}`} type="number" step="0.01" value={f.total} onChange={(e) => actualizar(f.key, "total", e.target.value)} className="w-24" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-tipo-${f.key}`} className="sr-only">
                    Tipo
                  </Label>
                  <NativeSelect id={`fac-tipo-${f.key}`} value={f.tipo} onChange={(e) => actualizar(f.key, "tipo", e.target.value as TipoFacturaIva)} wrapperClassName="w-28">
                    {TIPO_FACTURA_OPTIONS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </NativeSelect>
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-categoria-${f.key}`} className="sr-only">
                    Categoría
                  </Label>
                  <NativeSelect id={`fac-categoria-${f.key}`} value={f.categoria} onChange={(e) => actualizar(f.key, "categoria", e.target.value as ClasificacionIva)} wrapperClassName="w-40">
                    {CATEGORIA_OPTIONS.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORIA_LABELS[c]}
                      </option>
                    ))}
                  </NativeSelect>
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-proporc-${f.key}`} className="sr-only">
                    Proporcionalidad
                  </Label>
                  <Input
                    id={`fac-proporc-${f.key}`}
                    type="number"
                    step="0.01"
                    min={0}
                    max={1}
                    value={f.proporcionalidad}
                    onChange={(e) => actualizar(f.key, "proporcionalidad", e.target.value)}
                    className="w-[70px]"
                  />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-rep-${f.key}`} className="sr-only">
                    UUID del complemento de pago
                  </Label>
                  <Input
                    id={`fac-rep-${f.key}`}
                    type="text"
                    value={f.referenciaComplementoPago}
                    onChange={(e) => actualizar(f.key, "referenciaComplementoPago", e.target.value)}
                    placeholder="UUID del REP"
                    className="w-36 font-mono"
                  />
                </TableCell>
                <TableCell className="p-1.5">
                  <Button type="button" variant="destructive" onClick={() => setFilas(filas.filter((r) => r.key !== f.key))}>
                    <Trash2 />
                    Quitar
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => setFilas([...filas, nuevaFacturaFila()])}>
          <Plus />
          Agregar factura
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Sin UUID REP (complemento de pago), el IVA de esa factura no cuenta como efectivamente pagado (LIVA Art. 5 fracc. III). Este lote alimenta DIOT, conciliación, congruencia y el papel de trabajo de abajo.
      </p>
    </div>
  );
}

function DeclaracionesEditor({ filas, setFilas }: { filas: readonly DeclaracionFila[]; setFilas: (f: readonly DeclaracionFila[]) => void }) {
  function actualizar(key: string, campo: keyof DeclaracionFila, valor: string) {
    setFilas(filas.map((d) => (d.key === key ? { ...d, [campo]: valor } : d)));
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <Table className="min-w-[640px]">
          <TableHeader>
            <TableRow>
              <TableHead>Mes *</TableHead>
              <TableHead>Año *</TableHead>
              <TableHead>IVA cobrado</TableHead>
              <TableHead>IVA pagado</TableHead>
              <TableHead>Saldo a favor</TableHead>
              <TableHead>Saldo a cargo</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filas.map((d) => (
              <TableRow key={d.key}>
                <TableCell className="p-1.5">
                  <Label htmlFor={`decl-mes-${d.key}`} className="sr-only">
                    Mes
                  </Label>
                  <Input id={`decl-mes-${d.key}`} type="number" min={1} max={12} value={d.mes} onChange={(e) => actualizar(d.key, "mes", e.target.value)} className="w-[70px]" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`decl-anio-${d.key}`} className="sr-only">
                    Año
                  </Label>
                  <Input id={`decl-anio-${d.key}`} type="number" value={d.año} onChange={(e) => actualizar(d.key, "año", e.target.value)} className="w-20" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`decl-cobrado-${d.key}`} className="sr-only">
                    IVA cobrado
                  </Label>
                  <Input id={`decl-cobrado-${d.key}`} type="number" step="0.01" value={d.ivaCobrado} onChange={(e) => actualizar(d.key, "ivaCobrado", e.target.value)} className="w-24" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`decl-pagado-${d.key}`} className="sr-only">
                    IVA pagado
                  </Label>
                  <Input id={`decl-pagado-${d.key}`} type="number" step="0.01" value={d.ivaPagado} onChange={(e) => actualizar(d.key, "ivaPagado", e.target.value)} className="w-24" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`decl-favor-${d.key}`} className="sr-only">
                    Saldo a favor
                  </Label>
                  <Input id={`decl-favor-${d.key}`} type="number" step="0.01" value={d.saldoFavor} onChange={(e) => actualizar(d.key, "saldoFavor", e.target.value)} className="w-24" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`decl-contra-${d.key}`} className="sr-only">
                    Saldo a cargo
                  </Label>
                  <Input id={`decl-contra-${d.key}`} type="number" step="0.01" value={d.saldoContra} onChange={(e) => actualizar(d.key, "saldoContra", e.target.value)} className="w-24" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Button type="button" variant="destructive" onClick={() => setFilas(filas.filter((r) => r.key !== d.key))}>
                    <Trash2 />
                    Quitar
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => setFilas([...filas, nuevaDeclaracionFila()])}>
          <Plus />
          Agregar declaración
        </Button>
      </div>
    </div>
  );
}

// Mismo semáforo de siempre (verde = match, rojo = mismatch/missing, gris = cualquier otro estatus que devuelva el motor).
function EstatusBadge({ status }: { status: string }) {
  return <StatusBadge tone={statusTone(ESTATUS_VERIFICACION_TONES, status)}>{status}</StatusBadge>;
}

export function DevolucionIvaPage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const puedeGestionar = DEVOLUCION_IVA_ROLES.has(role);

  const [periodo, setPeriodo] = useState("");

  // -- Paso 1: facturas del periodo ------------------------------------------
  const [facturaFilas, setFacturaFilas] = useState<readonly FacturaFila[]>([nuevaFacturaFila()]);
  const facturas = facturaFilas.map(filaAFactura).filter((f): f is FacturaCfdiIva => f !== null);
  const [cargandoFacturas, setCargandoFacturas] = useState(false);
  const [errorFacturas, setErrorFacturas] = useState<string | null>(null);
  const [clasificacionResumen, setClasificacionResumen] = useState<{ acreditable100: number; acreditableProporcional: number; noAcreditable: number } | null>(null);

  async function handleCargarFacturas() {
    setErrorFacturas(null);
    if (!/^\d{4}-\d{2}$/.test(periodo)) {
      setErrorFacturas("Captura el periodo en formato YYYY-MM antes de cargar las facturas ingeridas.");
      return;
    }
    setCargandoFacturas(true);
    try {
      const { facturas: encontradas, clasificacion } = await fetchFacturasPeriodoDevolucionIva(fetch, apiBaseUrl, token, propertyId, periodo);
      if (encontradas.length > 0) setFacturaFilas(encontradas.map(facturaDelServidorAFila));
      setClasificacionResumen({
        acreditable100: clasificacion.acreditable_100.length,
        acreditableProporcional: clasificacion.acreditable_proporcional.length,
        noAcreditable: clasificacion.no_acreditable.length,
      });
      if (encontradas.length === 0) setErrorFacturas("No hay CFDI ya ingeridos para este periodo. Captúralas manualmente abajo.");
    } catch (err) {
      setErrorFacturas(err instanceof Error ? err.message : "No se pudieron cargar las facturas del periodo.");
    } finally {
      setCargandoFacturas(false);
    }
  }

  // -- Paso 2: DIOT ------------------------------------------------------
  const [diotLoading, setDiotLoading] = useState(false);
  const [diotError, setDiotError] = useState<string | null>(null);
  const [diotEntries, setDiotEntries] = useState<readonly DiotEntryIva[] | null>(null);
  const [diotErrores, setDiotErrores] = useState<readonly string[]>([]);

  async function handleGenerarDiot() {
    setDiotError(null);
    if (facturas.length === 0) {
      setDiotError("Captura al menos una factura con UUID/RFC emisor/RFC receptor/fecha.");
      return;
    }
    setDiotLoading(true);
    try {
      const { diotEntries: entries, errores } = await postDiotDevolucionIva(fetch, apiBaseUrl, token, propertyId, facturas, periodo.trim() || undefined);
      setDiotEntries(entries);
      setDiotErrores(errores);
    } catch (err) {
      setDiotError(err instanceof Error ? err.message : "No se pudo generar la DIOT.");
    } finally {
      setDiotLoading(false);
    }
  }

  // -- Declaraciones (alimentan conciliación/saldo/congruencia/solicitud) ----
  const [declaracionFilas, setDeclaracionFilas] = useState<readonly DeclaracionFila[]>([nuevaDeclaracionFila()]);
  const declaraciones = declaracionFilas.map(filaADeclaracion).filter((d): d is DeclaracionMensualIva => d !== null);

  // -- Paso 3: conciliación ------------------------------------------------
  const [conciliacionLoading, setConciliacionLoading] = useState(false);
  const [conciliacionError, setConciliacionError] = useState<string | null>(null);
  const [facturasVsDiot, setFacturasVsDiot] = useState<readonly ConciliacionFacturaDiot[] | null>(null);
  const [diotVsDeclaracion, setDiotVsDeclaracion] = useState<readonly ConciliacionDiotDeclaracion[] | null>(null);

  async function handleConciliar() {
    setConciliacionError(null);
    if (!diotEntries) {
      setConciliacionError("Genera la DIOT (paso 2) antes de conciliar.");
      return;
    }
    setConciliacionLoading(true);
    try {
      const { facturasVsDiot: fvd, diotVsDeclaracion: dvd } = await postConciliacionDevolucionIva(fetch, apiBaseUrl, token, propertyId, facturas, diotEntries, declaraciones);
      setFacturasVsDiot(fvd);
      setDiotVsDeclaracion(dvd);
    } catch (err) {
      setConciliacionError(err instanceof Error ? err.message : "No se pudo conciliar.");
    } finally {
      setConciliacionLoading(false);
    }
  }

  // -- Paso 4: saldo a favor -----------------------------------------------
  const [saldoLoading, setSaldoLoading] = useState(false);
  const [saldoError, setSaldoError] = useState<string | null>(null);
  const [saldoFavor, setSaldoFavor] = useState<number | null>(null);
  const [montoDevolucion, setMontoDevolucion] = useState<MontoDevolucion | null>(null);
  const [saldoVerificacion, setSaldoVerificacion] = useState<ConciliacionDeclaracionSaldo | null>(null);

  async function handleCalcularSaldo() {
    setSaldoError(null);
    if (declaraciones.length === 0) {
      setSaldoError("Captura al menos una declaración mensual con mes y año.");
      return;
    }
    setSaldoLoading(true);
    try {
      const { saldoFavor: sf, montoDevolucion: md, verificacion } = await postSaldoFavorDevolucionIva(fetch, apiBaseUrl, token, propertyId, declaraciones);
      setSaldoFavor(sf);
      setMontoDevolucion(md);
      setSaldoVerificacion(verificacion);
    } catch (err) {
      setSaldoError(err instanceof Error ? err.message : "No se pudo calcular el saldo a favor.");
    } finally {
      setSaldoLoading(false);
    }
  }

  // -- Paso 5: congruencia --------------------------------------------------
  const [tolerancia, setTolerancia] = useState("1");
  const [congruenciaLoading, setCongruenciaLoading] = useState(false);
  const [congruenciaError, setCongruenciaError] = useState<string | null>(null);
  const [congruencia, setCongruencia] = useState<CongruenciaDiotCfdiDeclaracion | null>(null);

  async function handleVerificarCongruencia() {
    setCongruenciaError(null);
    if (!periodo.trim()) {
      setCongruenciaError("Captura el periodo (YYYY-MM) arriba antes de verificar congruencia.");
      return;
    }
    setCongruenciaLoading(true);
    try {
      const resultado = await postCongruenciaDevolucionIva(fetch, apiBaseUrl, token, propertyId, periodo.trim(), facturas, diotEntries ?? [], declaraciones, tolerancia.trim() ? Number(tolerancia) : undefined);
      setCongruencia(resultado);
    } catch (err) {
      setCongruenciaError(err instanceof Error ? err.message : "No se pudo verificar la congruencia.");
    } finally {
      setCongruenciaLoading(false);
    }
  }

  // -- Paso 6: solicitud -----------------------------------------------------
  const [cuentaBanco, setCuentaBanco] = useState("");
  const [clabe, setClabe] = useState("");
  const [documentosTexto, setDocumentosTexto] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [solicitudLoading, setSolicitudLoading] = useState(false);
  const [solicitudError, setSolicitudError] = useState<string | null>(null);
  const [solicitud, setSolicitud] = useState<SolicitudDevolucion | null>(null);

  async function handlePrepararSolicitud(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSolicitudError(null);
    if (!periodo.trim()) {
      setSolicitudError("Captura el periodo (YYYY-MM) arriba.");
      return;
    }
    if (!montoDevolucion) {
      setSolicitudError("Calcula el saldo a favor (paso 4) antes de preparar la solicitud.");
      return;
    }
    setSolicitudLoading(true);
    try {
      const documentos = documentosTexto
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d.length > 0);
      const resultado = await postSolicitudDevolucionIva(
        fetch,
        apiBaseUrl,
        token,
        propertyId,
        periodo.trim(),
        { montoDevolucionSugerido: montoDevolucion.montoDevolucionSugerido },
        {
          cuentaBanco: cuentaBanco.trim() || undefined,
          clabe: clabe.trim() || undefined,
          documentos: documentos.length > 0 ? documentos : undefined,
          tenantId: tenantId.trim() || undefined,
          facturas,
          diotEntries: diotEntries ?? undefined,
          declaraciones,
        },
      );
      setSolicitud(resultado);
    } catch (err) {
      setSolicitudError(err instanceof Error ? err.message : "No se pudo preparar la solicitud.");
    } finally {
      setSolicitudLoading(false);
    }
  }

  // -- Paso 7: plazo de resolución -------------------------------------------
  const [fechaPresentacion, setFechaPresentacion] = useState("");
  const [hayDictamenOGarantia, setHayDictamenOGarantia] = useState(false);
  const [plazoLoading, setPlazoLoading] = useState(false);
  const [plazoError, setPlazoError] = useState<string | null>(null);
  const [fechaLimite, setFechaLimite] = useState<string | null>(null);

  async function handleCalcularPlazo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPlazoError(null);
    setPlazoLoading(true);
    try {
      const { fechaLimite: limite } = await postPlazoResolucionDevolucionIva(fetch, apiBaseUrl, token, propertyId, fechaPresentacion, hayDictamenOGarantia);
      setFechaLimite(limite);
    } catch (err) {
      setPlazoError(err instanceof Error ? err.message : "No se pudo calcular el plazo de resolución.");
    } finally {
      setPlazoLoading(false);
    }
  }

  // -- Paso 8: papel de trabajo ------------------------------------------
  const [documentosSoporteTexto, setDocumentosSoporteTexto] = useState("");
  const [papelLoading, setPapelLoading] = useState(false);
  const [papelError, setPapelError] = useState<string | null>(null);
  const [papel, setPapel] = useState<PapelTrabajoDevolucionIva | null>(null);

  async function handleGenerarPapel() {
    setPapelError(null);
    if (!periodo.trim()) {
      setPapelError("Captura el periodo (YYYY-MM) arriba.");
      return;
    }
    setPapelLoading(true);
    try {
      const documentosSoporte = documentosSoporteTexto
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d.length > 0);
      const resultado = await postPapelTrabajoDevolucionIva(fetch, apiBaseUrl, token, propertyId, periodo.trim(), facturas, diotEntries ?? undefined, declaraciones, {
        tenantId: tenantId.trim() || undefined,
        documentosSoporte,
      });
      setPapel(resultado);
    } catch (err) {
      setPapelError(err instanceof Error ? err.message : "No se pudo generar el papel de trabajo.");
    } finally {
      setPapelLoading(false);
    }
  }

  if (!puedeGestionar) {
    return (
      <PageContainer className="[&>*]:min-w-0">
        <PageHeader titulo="Devolución de IVA" descripcion="Flujo guiado del papel de trabajo de devolución de IVA." />
        <EstadoVacio icon={Lock} titulo="Sin permiso" mensaje={`Esta función requiere rol admin o contador. Tu rol actual (${role}) no puede correr el flujo de devolución de IVA -- el servidor lo rechazaría igual.`} />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="[&>*]:min-w-0">
      <PageHeader titulo="Devolución de IVA" descripcion="Flujo guiado del papel de trabajo de devolución de IVA: facturas del periodo → DIOT → conciliación → saldo a favor → congruencia (REQ-IVA-010) → solicitud → plazo de resolución (Art. 22 CFF) → papel de trabajo." />

      <Card>
        <CardHeader>
          <CardTitle>Periodo</CardTitle>
        </CardHeader>
        <CardContent>
          <FormField label="Periodo (YYYY-MM)" required className="w-44">
            <Input id="iva-periodo" type="month" value={periodo} onChange={(e) => setPeriodo(e.target.value)} />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>1. Facturas del periodo</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {errorFacturas && <Callout tone="danger">{errorFacturas}</Callout>}
          <div>
            <Button type="button" onClick={() => void handleCargarFacturas()} loading={cargandoFacturas}>
              <Download />
              Cargar CFDI ya ingeridos del periodo
            </Button>
          </div>
          {clasificacionResumen && (
            <div className="flex gap-5 text-sm text-foreground">
              <span>
                <strong>Acreditable 100%:</strong> {clasificacionResumen.acreditable100}
              </span>
              <span>
                <strong>Acreditable proporcional:</strong> {clasificacionResumen.acreditableProporcional}
              </span>
              <span>
                <strong>No acreditable:</strong> {clasificacionResumen.noAcreditable}
              </span>
            </div>
          )}
          <FacturasEditor filas={facturaFilas} setFilas={setFacturaFilas} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. DIOT</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {diotError && <Callout tone="danger">{diotError}</Callout>}
          <div>
            <Button type="button" onClick={() => void handleGenerarDiot()} loading={diotLoading}>
              <FileSpreadsheet />
              Generar DIOT
            </Button>
          </div>
          {diotErrores.length > 0 && (
            <div className="flex flex-col gap-1">
              {diotErrores.map((e, i) => (
                <Callout key={i} tone="danger">
                  {e}
                </Callout>
              ))}
            </div>
          )}
          {diotEntries && diotEntries.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>RFC tercero</TableHead>
                    <TableHead>Nombre</TableHead>
                    <TableHead>Monto neto</TableHead>
                    <TableHead>IVA trasladado</TableHead>
                    <TableHead>IVA acreditable</TableHead>
                    <TableHead># CFDI</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {diotEntries.map((e, i) => (
                    <TableRow key={i}>
                      <TableCell className="p-2 font-mono">{e.rfcTercero}</TableCell>
                      <TableCell className="p-2">{e.nombre || "—"}</TableCell>
                      <TableCell className="p-2 tabular-nums">{formatMoney(e.montoNeto)}</TableCell>
                      <TableCell className="p-2 tabular-nums">{formatMoney(e.ivaTrasladado)}</TableCell>
                      <TableCell className="p-2 tabular-nums">{formatMoney(e.ivaAcreditable)}</TableCell>
                      <TableCell className="p-2 tabular-nums">{e.foliosFiscales.length}</TableCell>
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
          <CardTitle>Declaraciones mensuales</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">Captura las declaraciones mensuales de IVA ya presentadas -- alimentan conciliación, saldo a favor, congruencia y solicitud.</p>
          <DeclaracionesEditor filas={declaracionFilas} setFilas={setDeclaracionFilas} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Conciliación (facturas ↔ DIOT ↔ declaración)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {conciliacionError && <Callout tone="danger">{conciliacionError}</Callout>}
          <div>
            <Button type="button" onClick={() => void handleConciliar()} loading={conciliacionLoading}>
              <ListChecks />
              Conciliar
            </Button>
          </div>
          {facturasVsDiot && (
            <div>
              <p className="mb-1 text-xs font-medium text-foreground">Facturas vs DIOT</p>
              <div className="overflow-x-auto rounded-xl border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Factura</TableHead>
                      <TableHead>Estatus</TableHead>
                      <TableHead>Detalle</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {facturasVsDiot.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="p-2 font-mono text-xs">{r.facturaUuid}</TableCell>
                        <TableCell className="p-2">
                          <EstatusBadge status={r.status} />
                        </TableCell>
                        <TableCell className="p-2 text-muted-foreground">{r.detalles}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
          {diotVsDeclaracion && diotVsDeclaracion.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-foreground">DIOT vs declaración</p>
              <div className="overflow-x-auto rounded-xl border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>IVA DIOT</TableHead>
                      <TableHead>IVA declaración</TableHead>
                      <TableHead>Diferencia</TableHead>
                      <TableHead>Estatus</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {diotVsDeclaracion.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="p-2 tabular-nums">{formatMoney(r.diotIvaTotal)}</TableCell>
                        <TableCell className="p-2 tabular-nums">{formatMoney(r.declaracionIvaAcreditable)}</TableCell>
                        <TableCell className="p-2 tabular-nums">{formatMoney(r.diferencia)}</TableCell>
                        <TableCell className="p-2">
                          <EstatusBadge status={r.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>4. Saldo a favor / monto de devolución</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {saldoError && <Callout tone="danger">{saldoError}</Callout>}
          <div>
            <Button type="button" onClick={() => void handleCalcularSaldo()} loading={saldoLoading}>
              <Calculator />
              Calcular saldo a favor
            </Button>
          </div>
          {montoDevolucion && (
            <div className="flex flex-col gap-1.5 text-sm text-foreground">
              <div className="flex flex-wrap gap-5">
                <span>
                  <strong>Saldo a favor:</strong> {formatMoney(saldoFavor ?? 0)}
                </span>
                <span>
                  <strong>Monto de devolución sugerido:</strong> {formatMoney(montoDevolucion.montoDevolucionSugerido)}
                </span>
                <span>
                  <strong>Periodo más antiguo:</strong> {montoDevolucion.periodoMasAntiguo ?? "—"}
                </span>
              </div>
              {saldoVerificacion && (
                <div className="flex items-center gap-2">
                  <strong>Verificación:</strong>
                  <EstatusBadge status={saldoVerificacion.consistente ? "match" : "mismatch"} />
                  <span className="text-muted-foreground">diferencia {formatMoney(saldoVerificacion.diferencia)}</span>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                El factor de actualización (INPC) y la verificación de prescripción de 5 años son placeholders documentados del motor -- no sustituyen la actualización fiscal real.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>5. Congruencia DIOT ↔ CFDI ↔ declaración (REQ-IVA-010)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <FormField label="Tolerancia (MXN)" className="w-44">
            <Input id="iva-tolerancia" type="number" step="0.01" value={tolerancia} onChange={(e) => setTolerancia(e.target.value)} />
          </FormField>
          {congruenciaError && <Callout tone="danger">{congruenciaError}</Callout>}
          <div>
            <Button type="button" onClick={() => void handleVerificarCongruencia()} loading={congruenciaLoading}>
              <CheckCircle2 />
              Verificar congruencia
            </Button>
          </div>
          {congruencia && (
            <div className="flex flex-col gap-1.5 text-sm text-foreground">
              <div className="flex items-center gap-2">
                <strong>{congruencia.congruente ? "Congruente" : "No congruente"}</strong>
                <EstatusBadge status={congruencia.congruente ? "match" : "mismatch"} />
              </div>
              <div className="flex flex-wrap gap-5">
                <span>CFDI: {formatMoney(congruencia.totalCfdiIvaAcreditable)}</span>
                <span>DIOT: {formatMoney(congruencia.totalDiotIvaAcreditable)}</span>
                <span>Declaración: {formatMoney(congruencia.totalDeclaracionIvaPagado)}</span>
                <span>Diferencia máxima: {formatMoney(congruencia.diferenciaMaxima)}</span>
              </div>
              {!congruencia.diotExiste && <p className="text-destructive">No existe DIOT registrada para el periodo.</p>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>6. Solicitud de devolución</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Usa el monto sugerido del paso 4. Por encima de ${" "}
            10,001 MXN, el servidor exige congruencia (paso 5) para dejarla lista para envío -- si no es congruente, queda "requiere aclaración". No se persiste: archívala donde corresponda.
          </p>
          <form onSubmit={handlePrepararSolicitud} className="flex max-w-lg flex-col gap-3">
            <FormField label="Cuenta bancaria (opcional)">
              <Input id="sol-cuenta" type="text" value={cuentaBanco} onChange={(e) => setCuentaBanco(e.target.value)} />
            </FormField>
            <FormField label="CLABE (opcional, 18 dígitos)">
              <Input id="sol-clabe" type="text" value={clabe} onChange={(e) => setClabe(e.target.value)} />
            </FormField>
            <FormField label="Documentos soporte (separados por coma)">
              <Input id="sol-documentos" type="text" value={documentosTexto} onChange={(e) => setDocumentosTexto(e.target.value)} placeholder="cfdi.zip, diot.txt, declaraciones.pdf" />
            </FormField>
            <FormField label="Tenant ID (opcional)">
              <Input id="sol-tenant" type="text" value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
            </FormField>
            {solicitudError && <Callout tone="danger">{solicitudError}</Callout>}
            <div>
              <Button type="submit" loading={solicitudLoading}>
                <Send />
                Preparar solicitud
              </Button>
            </div>
          </form>
          {solicitud && (
            <div className="flex flex-col gap-1.5 text-sm text-foreground">
              <div className="flex flex-wrap gap-5">
                <span>
                  <strong>Folio:</strong> <span className="font-mono">{solicitud.solicitudId}</span>
                </span>
                <span>
                  <strong>Monto solicitado:</strong> {formatMoney(solicitud.montoSolicitado)}
                </span>
                <span>
                  <strong>Status:</strong> {solicitud.status}
                </span>
              </div>
              {solicitud.estado === "lista_para_envio" ? (
                <Callout tone="success">Lista para envío.</Callout>
              ) : (
                <Callout tone="warning">
                  Requiere aclaración: {solicitud.motivoAclaracion}
                </Callout>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>7. Plazo de resolución (Art. 22 CFF)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form onSubmit={handleCalcularPlazo} className="flex max-w-sm flex-col gap-3">
            <FormField label="Fecha de presentación" required>
              <Input id="plazo-fecha" type="date" value={fechaPresentacion} onChange={(e) => setFechaPresentacion(e.target.value)} required />
            </FormField>
            <Checkbox checked={hayDictamenOGarantia} onChange={(e) => setHayDictamenOGarantia(e.target.checked)} label="Hay dictamen de contador público registrado o garantía del interés fiscal (plazo de 20 días hábiles en vez de 40)" />
            {plazoError && <Callout tone="danger">{plazoError}</Callout>}
            <div>
              <Button type="submit" loading={plazoLoading}>
                <CalendarClock />
                Calcular plazo
              </Button>
            </div>
          </form>
          {fechaLimite && (
            <p className="text-sm text-foreground">
              <strong>Fecha límite de resolución:</strong> {fechaLimite}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>8. Papel de trabajo</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <FormField label="Documentos soporte (separados por coma)" className="max-w-md">
            <Input
              id="papel-documentos"
              type="text"
              value={documentosSoporteTexto}
              onChange={(e) => setDocumentosSoporteTexto(e.target.value)}
              placeholder="cfdi.zip, diot.txt, estados_cuenta.pdf"
            />
          </FormField>
          {papelError && <Callout tone="danger">{papelError}</Callout>}
          <div>
            <Button type="button" onClick={() => void handleGenerarPapel()} loading={papelLoading}>
              <ClipboardList />
              Generar papel de trabajo
            </Button>
          </div>
          {papel && (
            <div className="flex flex-col gap-3 text-sm text-foreground">
              <div className="flex flex-wrap gap-5">
                <span>
                  <strong>Facturas:</strong> {papel.metadata.totalFacturas}
                </span>
                <span>
                  <strong>Entradas DIOT:</strong> {papel.metadata.totalDiotEntries}
                </span>
                <span>
                  <strong>Declaraciones:</strong> {papel.metadata.totalDeclaraciones}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <p className="font-medium">1. Resumen del periodo</p>
                <div className="flex flex-wrap gap-4 text-muted-foreground">
                  <span>Subtotal: {formatMoney(papel.secciones["1_resumen_periodo"].resumenFacturas.totalSubtotal)}</span>
                  <span>IVA trasladado: {formatMoney(papel.secciones["1_resumen_periodo"].resumenFacturas.totalIvaTrasladado)}</span>
                  <span>Total: {formatMoney(papel.secciones["1_resumen_periodo"].resumenFacturas.totalGravado)}</span>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <p className="font-medium">3. Conciliación CFDI ↔ DIOT</p>
                <span className="text-muted-foreground">
                  {papel.secciones["3_conciliacion_cfdi_diot"].matches}/{papel.secciones["3_conciliacion_cfdi_diot"].totalFacturas} conciliadas ({papel.secciones["3_conciliacion_cfdi_diot"].tasaConciliacion}%)
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <p className="font-medium">5. Cálculo de saldo</p>
                <span className="text-muted-foreground">
                  Saldo a favor: {formatMoney(papel.secciones["5_calculo_saldo"].saldoAFavor)} · Monto sugerido: {formatMoney(papel.secciones["5_calculo_saldo"].montoDevolucion.montoDevolucionSugerido)}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <p className="font-medium">6. Documentos soporte</p>
                <div className="flex flex-wrap gap-3 text-muted-foreground">
                  <span className="inline-flex items-center gap-1">CFDI: <StatusBadge tone={papel.secciones["6_documentos_soporte"].checklist.cfdiCompra ? "success" : "danger"}>{papel.secciones["6_documentos_soporte"].checklist.cfdiCompra ? "Sí" : "No"}</StatusBadge></span>
                  <span className="inline-flex items-center gap-1">DIOT: <StatusBadge tone={papel.secciones["6_documentos_soporte"].checklist.diot ? "success" : "danger"}>{papel.secciones["6_documentos_soporte"].checklist.diot ? "Sí" : "No"}</StatusBadge></span>
                  <span className="inline-flex items-center gap-1">Declaraciones: <StatusBadge tone={papel.secciones["6_documentos_soporte"].checklist.declaraciones ? "success" : "danger"}>{papel.secciones["6_documentos_soporte"].checklist.declaraciones ? "Sí" : "No"}</StatusBadge></span>
                  <span className="inline-flex items-center gap-1">Estados de cuenta: <StatusBadge tone={papel.secciones["6_documentos_soporte"].checklist.estadosCuenta ? "success" : "danger"}>{papel.secciones["6_documentos_soporte"].checklist.estadosCuenta ? "Sí" : "No"}</StatusBadge></span>
                  <span className="inline-flex items-center gap-1">Balanza: <StatusBadge tone={papel.secciones["6_documentos_soporte"].checklist.balanza ? "success" : "danger"}>{papel.secciones["6_documentos_soporte"].checklist.balanza ? "Sí" : "No"}</StatusBadge></span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{papel.secciones["7_no_discrepancia_fiscal_depositos"].advertenciaFiscal}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
