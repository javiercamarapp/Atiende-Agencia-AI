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
import { Calculator, CalendarClock, CheckCircle2, ClipboardList, Download, FileSpreadsheet, ListChecks, Plus, Send, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
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
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo conjunto que DEVOLUCION_IVA_ROLES (@atiende/domain-despachos/roles.ts)
// -- las 8 rutas de devolucion-iva.ts exigen este rol en CADA llamada, mismo
// criterio que Conciliacion.tsx: cosmético, el servidor rechazaría igual.
const DEVOLUCION_IVA_ROLES = new Set(["admin", "contador"]);

// Clases compartidas por los `<select>` nativos que se quedan nativos (el
// design system no exporta un Select propio): misma anatomía que `Input`.
const SELECT_CELL_CLASS =
  "h-9 rounded-md border border-input bg-background px-2 text-xs text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

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
        <Table className="min-w-[1200px] text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="h-9">UUID *</TableHead>
              <TableHead className="h-9">RFC emisor *</TableHead>
              <TableHead className="h-9">Emisor</TableHead>
              <TableHead className="h-9">RFC receptor *</TableHead>
              <TableHead className="h-9">Fecha *</TableHead>
              <TableHead className="h-9">Subtotal</TableHead>
              <TableHead className="h-9">IVA</TableHead>
              <TableHead className="h-9">Total</TableHead>
              <TableHead className="h-9">Tipo</TableHead>
              <TableHead className="h-9">Categoría</TableHead>
              <TableHead className="h-9">Proporc.</TableHead>
              <TableHead className="h-9">UUID REP</TableHead>
              <TableHead className="h-9" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filas.map((f) => (
              <TableRow key={f.key}>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-uuid-${f.key}`} className="sr-only">
                    UUID
                  </Label>
                  <Input id={`fac-uuid-${f.key}`} type="text" value={f.uuid} onChange={(e) => actualizar(f.key, "uuid", e.target.value)} className="h-9 w-40 font-mono text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-rfc-em-${f.key}`} className="sr-only">
                    RFC emisor
                  </Label>
                  <Input id={`fac-rfc-em-${f.key}`} type="text" value={f.rfcEmisor} onChange={(e) => actualizar(f.key, "rfcEmisor", e.target.value.toUpperCase())} className="h-9 w-28 text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-emisor-${f.key}`} className="sr-only">
                    Emisor
                  </Label>
                  <Input id={`fac-emisor-${f.key}`} type="text" value={f.nombreEmisor} onChange={(e) => actualizar(f.key, "nombreEmisor", e.target.value)} className="h-9 w-40 text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-rfc-rec-${f.key}`} className="sr-only">
                    RFC receptor
                  </Label>
                  <Input id={`fac-rfc-rec-${f.key}`} type="text" value={f.rfcReceptor} onChange={(e) => actualizar(f.key, "rfcReceptor", e.target.value.toUpperCase())} className="h-9 w-28 text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-fecha-${f.key}`} className="sr-only">
                    Fecha
                  </Label>
                  <Input id={`fac-fecha-${f.key}`} type="date" value={f.fecha} onChange={(e) => actualizar(f.key, "fecha", e.target.value)} className="h-9 w-32 text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-subtotal-${f.key}`} className="sr-only">
                    Subtotal
                  </Label>
                  <Input id={`fac-subtotal-${f.key}`} type="number" step="0.01" value={f.subtotal} onChange={(e) => actualizar(f.key, "subtotal", e.target.value)} className="h-9 w-24 text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-iva-${f.key}`} className="sr-only">
                    IVA
                  </Label>
                  <Input id={`fac-iva-${f.key}`} type="number" step="0.01" value={f.iva} onChange={(e) => actualizar(f.key, "iva", e.target.value)} className="h-9 w-24 text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-total-${f.key}`} className="sr-only">
                    Total
                  </Label>
                  <Input id={`fac-total-${f.key}`} type="number" step="0.01" value={f.total} onChange={(e) => actualizar(f.key, "total", e.target.value)} className="h-9 w-24 text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-tipo-${f.key}`} className="sr-only">
                    Tipo
                  </Label>
                  <select id={`fac-tipo-${f.key}`} value={f.tipo} onChange={(e) => actualizar(f.key, "tipo", e.target.value as TipoFacturaIva)} className={`${SELECT_CELL_CLASS} w-28`}>
                    {TIPO_FACTURA_OPTIONS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`fac-categoria-${f.key}`} className="sr-only">
                    Categoría
                  </Label>
                  <select id={`fac-categoria-${f.key}`} value={f.categoria} onChange={(e) => actualizar(f.key, "categoria", e.target.value as ClasificacionIva)} className={`${SELECT_CELL_CLASS} w-40`}>
                    {CATEGORIA_OPTIONS.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORIA_LABELS[c]}
                      </option>
                    ))}
                  </select>
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
                    className="h-9 w-[70px] text-xs"
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
                    className="h-9 w-36 font-mono text-xs"
                  />
                </TableCell>
                <TableCell className="p-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 border-destructive/40 px-3 text-xs text-destructive hover:border-destructive"
                    onClick={() => setFilas(filas.filter((r) => r.key !== f.key))}
                  >
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
      <p className="text-[11px] text-muted-foreground">
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
        <Table className="min-w-[640px] text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="h-9">Mes *</TableHead>
              <TableHead className="h-9">Año *</TableHead>
              <TableHead className="h-9">IVA cobrado</TableHead>
              <TableHead className="h-9">IVA pagado</TableHead>
              <TableHead className="h-9">Saldo a favor</TableHead>
              <TableHead className="h-9">Saldo a cargo</TableHead>
              <TableHead className="h-9" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filas.map((d) => (
              <TableRow key={d.key}>
                <TableCell className="p-1.5">
                  <Label htmlFor={`decl-mes-${d.key}`} className="sr-only">
                    Mes
                  </Label>
                  <Input id={`decl-mes-${d.key}`} type="number" min={1} max={12} value={d.mes} onChange={(e) => actualizar(d.key, "mes", e.target.value)} className="h-9 w-[70px] text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`decl-anio-${d.key}`} className="sr-only">
                    Año
                  </Label>
                  <Input id={`decl-anio-${d.key}`} type="number" value={d.año} onChange={(e) => actualizar(d.key, "año", e.target.value)} className="h-9 w-20 text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`decl-cobrado-${d.key}`} className="sr-only">
                    IVA cobrado
                  </Label>
                  <Input id={`decl-cobrado-${d.key}`} type="number" step="0.01" value={d.ivaCobrado} onChange={(e) => actualizar(d.key, "ivaCobrado", e.target.value)} className="h-9 w-24 text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`decl-pagado-${d.key}`} className="sr-only">
                    IVA pagado
                  </Label>
                  <Input id={`decl-pagado-${d.key}`} type="number" step="0.01" value={d.ivaPagado} onChange={(e) => actualizar(d.key, "ivaPagado", e.target.value)} className="h-9 w-24 text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`decl-favor-${d.key}`} className="sr-only">
                    Saldo a favor
                  </Label>
                  <Input id={`decl-favor-${d.key}`} type="number" step="0.01" value={d.saldoFavor} onChange={(e) => actualizar(d.key, "saldoFavor", e.target.value)} className="h-9 w-24 text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`decl-contra-${d.key}`} className="sr-only">
                    Saldo a cargo
                  </Label>
                  <Input id={`decl-contra-${d.key}`} type="number" step="0.01" value={d.saldoContra} onChange={(e) => actualizar(d.key, "saldoContra", e.target.value)} className="h-9 w-24 text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 border-destructive/40 px-3 text-xs text-destructive hover:border-destructive"
                    onClick={() => setFilas(filas.filter((r) => r.key !== d.key))}
                  >
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

// Mismo semáforo que las píldoras inline originales (verde = match, rojo =
// mismatch/missing, gris = cualquier otro estatus que devuelva el motor).
const ESTATUS_BADGE: Record<string, { variant: "destructive" | "outline"; className?: string }> = {
  match: { variant: "outline", className: "border-transparent bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400" },
  mismatch: { variant: "destructive" },
  missing: { variant: "destructive" },
};

function EstatusBadge({ status }: { status: string }) {
  const { variant, className } = ESTATUS_BADGE[status] ?? { variant: "outline" as const, className: "border-transparent bg-muted text-muted-foreground" };
  return (
    <Badge variant={variant} className={className}>
      {status}
    </Badge>
  );
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
      <div className="flex flex-col gap-2 px-1">
        <h1 className="font-display text-xl font-semibold text-foreground">Devolución de IVA</h1>
        <p role="alert" className="text-destructive text-sm">
          Esta función requiere rol admin o contador. Tu rol actual ({role}) no puede correr el flujo de devolución de IVA -- el servidor lo rechazaría igual.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 px-1">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground">Devolución de IVA</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Flujo guiado del papel de trabajo de devolución de IVA: facturas del periodo → DIOT → conciliación → saldo a favor → congruencia (REQ-IVA-010) → solicitud → plazo de resolución (Art. 22 CFF) → papel de trabajo.
        </p>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px]">Periodo</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex w-44 flex-col gap-1.5">
            <Label htmlFor="iva-periodo">Periodo (YYYY-MM) *</Label>
            <Input id="iva-periodo" type="month" value={periodo} onChange={(e) => setPeriodo(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px]">1. Facturas del periodo</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {errorFacturas && (
            <p role="alert" className="text-destructive text-sm">
              {errorFacturas}
            </p>
          )}
          <div>
            <Button type="button" onClick={() => void handleCargarFacturas()} disabled={cargandoFacturas}>
              <Download />
              {cargandoFacturas ? "Cargando…" : "Cargar CFDI ya ingeridos del periodo"}
            </Button>
          </div>
          {clasificacionResumen && (
            <div className="flex gap-5 text-[13px] text-foreground">
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
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px]">2. DIOT</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {diotError && (
            <p role="alert" className="text-destructive text-sm">
              {diotError}
            </p>
          )}
          <div>
            <Button type="button" onClick={() => void handleGenerarDiot()} disabled={diotLoading}>
              <FileSpreadsheet />
              {diotLoading ? "Generando…" : "Generar DIOT"}
            </Button>
          </div>
          {diotErrores.length > 0 && (
            <div className="flex flex-col gap-1">
              {diotErrores.map((e, i) => (
                <p key={i} role="alert" className="text-destructive text-xs">
                  {e}
                </p>
              ))}
            </div>
          )}
          {diotEntries && diotEntries.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-border">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-9">RFC tercero</TableHead>
                    <TableHead className="h-9">Nombre</TableHead>
                    <TableHead className="h-9">Monto neto</TableHead>
                    <TableHead className="h-9">IVA trasladado</TableHead>
                    <TableHead className="h-9">IVA acreditable</TableHead>
                    <TableHead className="h-9"># CFDI</TableHead>
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
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px]">Declaraciones mensuales</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">Captura las declaraciones mensuales de IVA ya presentadas -- alimentan conciliación, saldo a favor, congruencia y solicitud.</p>
          <DeclaracionesEditor filas={declaracionFilas} setFilas={setDeclaracionFilas} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px]">3. Conciliación (facturas ↔ DIOT ↔ declaración)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {conciliacionError && (
            <p role="alert" className="text-destructive text-sm">
              {conciliacionError}
            </p>
          )}
          <div>
            <Button type="button" onClick={() => void handleConciliar()} disabled={conciliacionLoading}>
              <ListChecks />
              {conciliacionLoading ? "Conciliando…" : "Conciliar"}
            </Button>
          </div>
          {facturasVsDiot && (
            <div>
              <p className="mb-1 text-xs font-semibold text-foreground">Facturas vs DIOT</p>
              <div className="overflow-x-auto rounded-xl border border-border">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="h-9">Factura</TableHead>
                      <TableHead className="h-9">Estatus</TableHead>
                      <TableHead className="h-9">Detalle</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {facturasVsDiot.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="p-2 font-mono text-[11px]">{r.facturaUuid}</TableCell>
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
              <p className="mb-1 text-xs font-semibold text-foreground">DIOT vs declaración</p>
              <div className="overflow-x-auto rounded-xl border border-border">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="h-9">IVA DIOT</TableHead>
                      <TableHead className="h-9">IVA declaración</TableHead>
                      <TableHead className="h-9">Diferencia</TableHead>
                      <TableHead className="h-9">Estatus</TableHead>
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
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px]">4. Saldo a favor / monto de devolución</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {saldoError && (
            <p role="alert" className="text-destructive text-sm">
              {saldoError}
            </p>
          )}
          <div>
            <Button type="button" onClick={() => void handleCalcularSaldo()} disabled={saldoLoading}>
              <Calculator />
              {saldoLoading ? "Calculando…" : "Calcular saldo a favor"}
            </Button>
          </div>
          {montoDevolucion && (
            <div className="flex flex-col gap-1.5 text-[13px] text-foreground">
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
              <p className="text-[11px] text-muted-foreground">
                El factor de actualización (INPC) y la verificación de prescripción de 5 años son placeholders documentados del motor -- no sustituyen la actualización fiscal real.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px]">5. Congruencia DIOT ↔ CFDI ↔ declaración (REQ-IVA-010)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex w-44 flex-col gap-1.5">
            <Label htmlFor="iva-tolerancia">Tolerancia (MXN)</Label>
            <Input id="iva-tolerancia" type="number" step="0.01" value={tolerancia} onChange={(e) => setTolerancia(e.target.value)} />
          </div>
          {congruenciaError && (
            <p role="alert" className="text-destructive text-sm">
              {congruenciaError}
            </p>
          )}
          <div>
            <Button type="button" onClick={() => void handleVerificarCongruencia()} disabled={congruenciaLoading}>
              <CheckCircle2 />
              {congruenciaLoading ? "Verificando…" : "Verificar congruencia"}
            </Button>
          </div>
          {congruencia && (
            <div className="flex flex-col gap-1.5 text-[13px] text-foreground">
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
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px]">6. Solicitud de devolución</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Usa el monto sugerido del paso 4. Por encima de ${" "}
            10,001 MXN, el servidor exige congruencia (paso 5) para dejarla lista para envío -- si no es congruente, queda "requiere aclaración". No se persiste: archívala donde corresponda.
          </p>
          <form onSubmit={handlePrepararSolicitud} className="flex max-w-lg flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sol-cuenta">Cuenta bancaria (opcional)</Label>
              <Input id="sol-cuenta" type="text" value={cuentaBanco} onChange={(e) => setCuentaBanco(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sol-clabe">CLABE (opcional, 18 dígitos)</Label>
              <Input id="sol-clabe" type="text" value={clabe} onChange={(e) => setClabe(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sol-documentos">Documentos soporte (separados por coma)</Label>
              <Input id="sol-documentos" type="text" value={documentosTexto} onChange={(e) => setDocumentosTexto(e.target.value)} placeholder="cfdi.zip, diot.txt, declaraciones.pdf" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sol-tenant">Tenant ID (opcional)</Label>
              <Input id="sol-tenant" type="text" value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
            </div>
            {solicitudError && (
              <p role="alert" className="text-destructive text-sm">
                {solicitudError}
              </p>
            )}
            <div>
              <Button type="submit" disabled={solicitudLoading}>
                <Send />
                {solicitudLoading ? "Preparando…" : "Preparar solicitud"}
              </Button>
            </div>
          </form>
          {solicitud && (
            <div className="flex flex-col gap-1.5 text-[13px] text-foreground">
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
                <p className="rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-green-800 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-400">Lista para envío.</p>
              ) : (
                <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
                  Requiere aclaración: {solicitud.motivoAclaracion}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px]">7. Plazo de resolución (Art. 22 CFF)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form onSubmit={handleCalcularPlazo} className="flex max-w-sm flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plazo-fecha">Fecha de presentación *</Label>
              <Input id="plazo-fecha" type="date" value={fechaPresentacion} onChange={(e) => setFechaPresentacion(e.target.value)} required />
            </div>
            <label className="flex items-start gap-2 text-[13px] text-foreground">
              <input
                type="checkbox"
                checked={hayDictamenOGarantia}
                onChange={(e) => setHayDictamenOGarantia(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-primary"
              />
              Hay dictamen de contador público registrado o garantía del interés fiscal (plazo de 20 días hábiles en vez de 40)
            </label>
            {plazoError && (
              <p role="alert" className="text-destructive text-sm">
                {plazoError}
              </p>
            )}
            <div>
              <Button type="submit" disabled={plazoLoading}>
                <CalendarClock />
                {plazoLoading ? "Calculando…" : "Calcular plazo"}
              </Button>
            </div>
          </form>
          {fechaLimite && (
            <p className="text-[13px] text-foreground">
              <strong>Fecha límite de resolución:</strong> {fechaLimite}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px]">8. Papel de trabajo</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex max-w-md flex-col gap-1.5">
            <Label htmlFor="papel-documentos">Documentos soporte (separados por coma)</Label>
            <Input
              id="papel-documentos"
              type="text"
              value={documentosSoporteTexto}
              onChange={(e) => setDocumentosSoporteTexto(e.target.value)}
              placeholder="cfdi.zip, diot.txt, estados_cuenta.pdf"
            />
          </div>
          {papelError && (
            <p role="alert" className="text-destructive text-sm">
              {papelError}
            </p>
          )}
          <div>
            <Button type="button" onClick={() => void handleGenerarPapel()} disabled={papelLoading}>
              <ClipboardList />
              {papelLoading ? "Generando…" : "Generar papel de trabajo"}
            </Button>
          </div>
          {papel && (
            <div className="flex flex-col gap-3 text-[13px] text-foreground">
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
                <p className="font-semibold">1. Resumen del periodo</p>
                <div className="flex flex-wrap gap-4 text-muted-foreground">
                  <span>Subtotal: {formatMoney(papel.secciones["1_resumen_periodo"].resumenFacturas.totalSubtotal)}</span>
                  <span>IVA trasladado: {formatMoney(papel.secciones["1_resumen_periodo"].resumenFacturas.totalIvaTrasladado)}</span>
                  <span>Total: {formatMoney(papel.secciones["1_resumen_periodo"].resumenFacturas.totalGravado)}</span>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <p className="font-semibold">3. Conciliación CFDI ↔ DIOT</p>
                <span className="text-muted-foreground">
                  {papel.secciones["3_conciliacion_cfdi_diot"].matches}/{papel.secciones["3_conciliacion_cfdi_diot"].totalFacturas} conciliadas ({papel.secciones["3_conciliacion_cfdi_diot"].tasaConciliacion}%)
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <p className="font-semibold">5. Cálculo de saldo</p>
                <span className="text-muted-foreground">
                  Saldo a favor: {formatMoney(papel.secciones["5_calculo_saldo"].saldoAFavor)} · Monto sugerido: {formatMoney(papel.secciones["5_calculo_saldo"].montoDevolucion.montoDevolucionSugerido)}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <p className="font-semibold">6. Documentos soporte</p>
                <div className="flex flex-wrap gap-3 text-muted-foreground">
                  <span>CFDI: {papel.secciones["6_documentos_soporte"].checklist.cfdiCompra ? "✓" : "✗"}</span>
                  <span>DIOT: {papel.secciones["6_documentos_soporte"].checklist.diot ? "✓" : "✗"}</span>
                  <span>Declaraciones: {papel.secciones["6_documentos_soporte"].checklist.declaraciones ? "✓" : "✗"}</span>
                  <span>Estados de cuenta: {papel.secciones["6_documentos_soporte"].checklist.estadosCuenta ? "✓" : "✗"}</span>
                  <span>Balanza: {papel.secciones["6_documentos_soporte"].checklist.balanza ? "✓" : "✗"}</span>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">{papel.secciones["7_no_discrepancia_fiscal_depositos"].advertenciaFiscal}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
