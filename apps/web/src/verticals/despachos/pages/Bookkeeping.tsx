// Panel de bookkeeping / auto-clasificador de pólizas -- hallazgo de auditoría
// (severidad ALTA, "Siete módulos con ruta HTTP real y sin UI" -- última porción,
// cierra 7/7 junto con devolución de IVA construida en paralelo): bookkeeping.ts
// expone GET /catalogo, POST /clasificar, POST /poliza, POST /ajuste y POST
// /overrides/sugerencias sobre el motor determinista de
// @atiende/domain-despachos/bookkeeping/* (puerto de b2b_ai/features/bookkeeping/,
// SIN el nivel ML -- ver clasificador.ts), pero ningún cliente web ni página los
// usaba. Esta página cierra el gap.
//
// Flujo: 1) captura el lote de CFDI a clasificar (tabla editable, mismo patrón
// exacto que la tabla de movimientos de Conciliacion.tsx) + el historial de
// overrides humanos ya conocido (usado tanto por /clasificar como prioridad
// máxima, como por /overrides/sugerencias para agregarlos); 2) clasifica el lote
// -- el resultado queda en una tabla editable (el contador puede corregir la
// categoría antes de generar pólizas, exactamente el override que este mismo
// módulo aprende); 3) genera + valida pólizas contables sobre esas
// clasificaciones; 4) registra ajustes manuales (diario) fuera del flujo de CFDI;
// 5) ve las sugerencias de override agregadas por RFC. El catálogo de cuentas SAT
// se carga aparte, de solo lectura, como referencia.
//
// Presentación (ronda de design system): los objetos de estilo inline
// (inputStyle/labelStyle/sectionStyle/buttonPrimary/buttonSecondary) se
// sustituyeron por Card/Input/Label/Button/Badge/Table de @atiende/ui. Las
// secciones siguen apiladas en el mismo orden (NO son pestañas): 2 consume la
// clasificación de 1 y 4 consume la tabla de overrides de arriba.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Calculator, ChevronDown, ChevronUp, FileStack, Lightbulb, ListChecks, Plus, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
import {
  clasificarCfdisBookkeeping,
  fetchCatalogoBookkeeping,
  fetchSugerenciasOverridesBookkeeping,
  generarAjusteBookkeeping,
  generarPolizasBookkeeping,
} from "../lib/bookkeeping-client.ts";
import type {
  CatalogoBookkeeping,
  CfdiClasificarInput,
  CfdiClassification,
  EntradaAjusteInput,
  OverrideRecord,
  PolizaContable,
  PolizaResultado,
  SuggestionRetraining,
  TipoCfdiBookkeeping,
} from "../lib/bookkeeping-client.ts";
import { formatMoney } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo conjunto que BOOKKEEPING_ROLES (@atiende/domain-despachos/roles.ts) --
// las 5 rutas de bookkeeping.ts exigen este rol en CADA llamada, así que -- mismo
// criterio que Conciliacion.tsx -- aquí no hay vista degradada para otros roles:
// el servidor rechazaría cualquier acción igual. Cosmético -- nunca la única
// barrera.
const BOOKKEEPING_ROLES = new Set(["admin", "contador"]);

const TIPOS_CFDI: readonly TipoCfdiBookkeeping[] = ["I", "E", "T", "P", "N"];
const TIPO_CFDI_LABELS: Record<TipoCfdiBookkeeping, string> = { I: "Ingreso", E: "Egreso", T: "Traslado", P: "Pago", N: "Nómina" };

// Clases compartidas por los `<select>` nativos que se quedan nativos (el
// design system no exporta un Select propio): misma anatomía que `Input`.
const SELECT_CELL_CLASS =
  "h-9 rounded-md border border-input bg-background px-2 text-xs text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

// Verde de éxito: misma escala neutra de Tailwind que ya usa StatCard para sus
// notas positivas (el preset no trae token semántico de éxito).
const VERDE_BADGE = "border-transparent bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400";

// -- Fila: CFDI a clasificar -----------------------------------------------

interface CfdiFila {
  readonly key: string;
  cfdiUuid: string;
  rfcEmisor: string;
  rfcReceptor: string;
  descripcion: string;
  subtotal: string;
  iva: string;
  total: string;
  tasaIva: string;
  tipoCfdi: TipoCfdiBookkeeping;
}

let cfdiSeq = 0;
function nuevaCfdiFila(): CfdiFila {
  cfdiSeq += 1;
  return { key: `cfdi-${cfdiSeq}`, cfdiUuid: "", rfcEmisor: "", rfcReceptor: "", descripcion: "", subtotal: "", iva: "", total: "", tasaIva: "0.16", tipoCfdi: "I" };
}

function cfdiFilaAInput(f: CfdiFila): CfdiClasificarInput | null {
  const cfdiUuid = f.cfdiUuid.trim();
  const rfcEmisor = f.rfcEmisor.trim();
  if (!cfdiUuid || !rfcEmisor) return null;
  return {
    cfdiUuid,
    rfcEmisor: rfcEmisor.toUpperCase(),
    rfcReceptor: f.rfcReceptor.trim() ? f.rfcReceptor.trim().toUpperCase() : undefined,
    descripcion: f.descripcion.trim() || undefined,
    subtotal: f.subtotal.trim() ? Number(f.subtotal) : undefined,
    iva: f.iva.trim() ? Number(f.iva) : undefined,
    total: f.total.trim() ? Number(f.total) : undefined,
    tasaIva: f.tasaIva.trim() ? Number(f.tasaIva) : undefined,
    tipoCfdi: f.tipoCfdi,
  };
}

// -- Fila: override humano ---------------------------------------------------

interface OverrideFila {
  readonly key: string;
  cfdiUuid: string;
  rfcEmisor: string;
  newCategoria: string;
  tenantId: string;
}

let overrideSeq = 0;
function nuevaOverrideFila(): OverrideFila {
  overrideSeq += 1;
  return { key: `ov-${overrideSeq}`, cfdiUuid: "", rfcEmisor: "", newCategoria: "", tenantId: "" };
}

function overrideFilaAInput(f: OverrideFila): OverrideRecord | null {
  const cfdiUuid = f.cfdiUuid.trim();
  const rfcEmisor = f.rfcEmisor.trim();
  const newCategoria = f.newCategoria.trim();
  if (!cfdiUuid || !rfcEmisor || !newCategoria) return null;
  return { cfdiUuid, rfcEmisor: rfcEmisor.toUpperCase(), newCategoria, tenantId: f.tenantId.trim() };
}

// -- Fila: entrada de ajuste manual ------------------------------------------

interface AjusteEntryFila {
  readonly key: string;
  cuenta: string;
  debe: string;
  haber: string;
  concepto: string;
}

let ajusteSeq = 0;
function nuevaAjusteFila(): AjusteEntryFila {
  ajusteSeq += 1;
  return { key: `adj-${ajusteSeq}`, cuenta: "", debe: "", haber: "", concepto: "" };
}

function ajusteFilaAInput(f: AjusteEntryFila): EntradaAjusteInput | null {
  const cuenta = f.cuenta.trim();
  if (!cuenta) return null;
  const debe = f.debe.trim() ? Number(f.debe) : undefined;
  const haber = f.haber.trim() ? Number(f.haber) : undefined;
  return { cuenta, debe, haber, concepto: f.concepto.trim() || undefined };
}

function ConfidenceBadge({ confidence, needsHumanReview }: { confidence: number; needsHumanReview: boolean }) {
  // Mismo semáforo que la píldora inline original: ámbar si requiere revisión,
  // verde si la confianza es alta, azul (secondary) en el resto.
  const className = needsHumanReview
    ? "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-400"
    : confidence >= 0.85
      ? VERDE_BADGE
      : undefined;
  return (
    <Badge variant={className ? "outline" : "secondary"} className={className}>
      {(confidence * 100).toFixed(0)}% {needsHumanReview ? "· revisar" : ""}
    </Badge>
  );
}

function PolizaCard({ resultado }: { resultado: PolizaResultado }) {
  const { poliza, errores } = resultado;
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong className="text-[13px] text-foreground">CFDI {resultado.cfdiUuid}</strong>
          {poliza &&
            (poliza.cuadrada ? (
              <Badge variant="outline" className={VERDE_BADGE}>
                Cuadrada
              </Badge>
            ) : (
              <Badge variant="destructive">Desbalanceada</Badge>
            ))}
        </div>
        {errores.length > 0 && (
          <ul className="m-0 list-disc pl-5 text-xs text-destructive">
            {errores.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
        {poliza && (
          <div className="overflow-x-auto">
            <Table className="min-w-[480px] text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead className="h-9">Cuenta</TableHead>
                  <TableHead className="h-9">Concepto</TableHead>
                  <TableHead className="h-9">Debe</TableHead>
                  <TableHead className="h-9">Haber</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {poliza.lineas.map((l, i) => (
                  <TableRow key={i}>
                    <TableCell className="p-1.5 font-mono">{l.cuenta}</TableCell>
                    <TableCell className="p-1.5 text-muted-foreground">{l.concepto}</TableCell>
                    <TableCell className="p-1.5 tabular-nums">{l.debe > 0 ? formatMoney(l.debe) : "—"}</TableCell>
                    <TableCell className="p-1.5 tabular-nums">{l.haber > 0 ? formatMoney(l.haber) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="p-1.5 font-semibold" colSpan={2}>
                    Totales · {poliza.tipo} · {poliza.fecha || "(sin fecha)"}
                  </TableCell>
                  <TableCell className="p-1.5 font-semibold tabular-nums">{formatMoney(poliza.totalDebe)}</TableCell>
                  <TableCell className="p-1.5 font-semibold tabular-nums">{formatMoney(poliza.totalHaber)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function BookkeepingPage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const puedeGestionar = BOOKKEEPING_ROLES.has(role);

  // -- Catálogo de cuentas (solo lectura) ------------------------------------
  const [catalogo, setCatalogo] = useState<CatalogoBookkeeping | null>(null);
  const [catalogoError, setCatalogoError] = useState<string | null>(null);
  const [catalogoFiltro, setCatalogoFiltro] = useState("");
  const [catalogoAbierto, setCatalogoAbierto] = useState(false);

  useEffect(() => {
    if (!puedeGestionar) return;
    let cancelado = false;
    (async () => {
      try {
        const c = await fetchCatalogoBookkeeping(fetch, apiBaseUrl, token, propertyId);
        if (!cancelado) setCatalogo(c);
      } catch (err) {
        if (!cancelado) setCatalogoError(err instanceof Error ? err.message : "No se pudo cargar el catálogo de cuentas.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [puedeGestionar, apiBaseUrl, token, propertyId]);

  const cuentasFiltradas = catalogo
    ? Object.entries(catalogo.catalogoCuentas).filter(([codigo, nombre]) => !catalogoFiltro.trim() || codigo.includes(catalogoFiltro.trim()) || nombre.toLowerCase().includes(catalogoFiltro.trim().toLowerCase()))
    : [];

  // -- Overrides humanos (historial compartido: /clasificar y /overrides/sugerencias) --
  const [overrideFilas, setOverrideFilas] = useState<readonly OverrideFila[]>([]);
  const overridesLote = overrideFilas.map(overrideFilaAInput).filter((o): o is OverrideRecord => o !== null);

  function actualizarOverrideFila(key: string, campo: keyof OverrideFila, valor: string) {
    setOverrideFilas(overrideFilas.map((f) => (f.key === key ? { ...f, [campo]: valor } : f)));
  }

  // -- 1. Clasificar CFDI -----------------------------------------------------
  const [cfdiFilas, setCfdiFilas] = useState<readonly CfdiFila[]>([nuevaCfdiFila()]);
  const [clasifLoading, setClasifLoading] = useState(false);
  const [clasifError, setClasifError] = useState<string | null>(null);
  const [clasificaciones, setClasificaciones] = useState<readonly CfdiClassification[]>([]);

  function actualizarCfdiFila(key: string, campo: keyof CfdiFila, valor: string) {
    setCfdiFilas(cfdiFilas.map((f) => (f.key === key ? { ...f, [campo]: valor } : f)));
  }

  async function handleClasificar() {
    setClasifError(null);
    const cfdis = cfdiFilas.map(cfdiFilaAInput).filter((c): c is CfdiClasificarInput => c !== null);
    if (cfdis.length === 0) {
      setClasifError("Captura al menos un CFDI con UUID y RFC emisor.");
      return;
    }
    setClasifLoading(true);
    try {
      const { clasificaciones: result } = await clasificarCfdisBookkeeping(fetch, apiBaseUrl, token, propertyId, cfdis, overridesLote);
      setClasificaciones(result);
    } catch (err) {
      setClasifError(err instanceof Error ? err.message : "No se pudo clasificar el lote.");
    } finally {
      setClasifLoading(false);
    }
  }

  function corregirCategoria(idx: number, categoria: string) {
    setClasificaciones(clasificaciones.map((c, i) => (i === idx ? { ...c, categoria, needsHumanReview: false } : c)));
  }

  // -- 2. Generar pólizas ------------------------------------------------------
  const [polizaTenantId, setPolizaTenantId] = useState("");
  const [polizaFecha, setPolizaFecha] = useState(() => new Date().toISOString().slice(0, 10));
  const [polizaLoading, setPolizaLoading] = useState(false);
  const [polizaError, setPolizaError] = useState<string | null>(null);
  const [polizas, setPolizas] = useState<readonly PolizaResultado[] | null>(null);

  async function handleGenerarPolizas() {
    setPolizaError(null);
    if (clasificaciones.length === 0) {
      setPolizaError("Clasifica al menos un CFDI primero (sección de arriba).");
      return;
    }
    setPolizaLoading(true);
    try {
      const { polizas: result } = await generarPolizasBookkeeping(fetch, apiBaseUrl, token, propertyId, clasificaciones, polizaTenantId.trim() || undefined, polizaFecha || undefined);
      setPolizas(result);
    } catch (err) {
      setPolizaError(err instanceof Error ? err.message : "No se pudieron generar las pólizas.");
    } finally {
      setPolizaLoading(false);
    }
  }

  // -- 3. Ajuste manual (diario) ------------------------------------------------
  const [ajusteFecha, setAjusteFecha] = useState(() => new Date().toISOString().slice(0, 10));
  const [ajusteConcepto, setAjusteConcepto] = useState("");
  const [ajusteTenantId, setAjusteTenantId] = useState("");
  const [ajusteEntries, setAjusteEntries] = useState<readonly AjusteEntryFila[]>([nuevaAjusteFila(), nuevaAjusteFila()]);
  const [ajusteLoading, setAjusteLoading] = useState(false);
  const [ajusteError, setAjusteError] = useState<string | null>(null);
  const [ajusteResultado, setAjusteResultado] = useState<{ readonly poliza: PolizaContable; readonly errores: readonly string[] } | null>(null);

  function actualizarAjusteFila(key: string, campo: keyof AjusteEntryFila, valor: string) {
    setAjusteEntries(ajusteEntries.map((f) => (f.key === key ? { ...f, [campo]: valor } : f)));
  }
  function eliminarAjusteFila(key: string) {
    setAjusteEntries(ajusteEntries.filter((f) => f.key !== key));
  }

  async function handleAjuste(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAjusteError(null);
    const entries = ajusteEntries.map(ajusteFilaAInput).filter((e): e is EntradaAjusteInput => e !== null);
    if (entries.length < 2) {
      setAjusteError("Captura al menos 2 movimientos (una póliza necesita mínimo un cargo y un abono).");
      return;
    }
    setAjusteLoading(true);
    try {
      const resultado = await generarAjusteBookkeeping(fetch, apiBaseUrl, token, propertyId, ajusteFecha, ajusteConcepto.trim(), entries, ajusteTenantId.trim() || undefined);
      setAjusteResultado(resultado);
    } catch (err) {
      setAjusteError(err instanceof Error ? err.message : "No se pudo registrar el ajuste.");
    } finally {
      setAjusteLoading(false);
    }
  }

  // -- 4. Sugerencias de override -----------------------------------------------
  const [sugerenciasLoading, setSugerenciasLoading] = useState(false);
  const [sugerenciasError, setSugerenciasError] = useState<string | null>(null);
  const [sugerencias, setSugerencias] = useState<readonly SuggestionRetraining[] | null>(null);

  async function handleSugerencias() {
    setSugerenciasError(null);
    if (overridesLote.length === 0) {
      setSugerenciasError("Captura al menos un override humano en la tabla de arriba.");
      return;
    }
    setSugerenciasLoading(true);
    try {
      const { sugerencias: result } = await fetchSugerenciasOverridesBookkeeping(fetch, apiBaseUrl, token, propertyId, overridesLote);
      setSugerencias(result);
    } catch (err) {
      setSugerenciasError(err instanceof Error ? err.message : "No se pudieron calcular las sugerencias.");
    } finally {
      setSugerenciasLoading(false);
    }
  }

  if (!puedeGestionar) {
    return (
      <div className="flex flex-col gap-2 px-1">
        <h1 className="font-display text-xl font-semibold text-foreground">Bookkeeping</h1>
        <p role="alert" className="text-destructive text-sm">
          Esta función requiere rol admin o contador. Tu rol actual ({role}) no puede clasificar CFDI, generar pólizas ni registrar ajustes -- el servidor las rechazaría igual.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 px-1">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground">Bookkeeping</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Auto-clasificador de pólizas: clasifica CFDI por reglas determinísticas (override humano por RFC tiene prioridad máxima), genera + valida pólizas contables, registra ajustes manuales y revisa qué correcciones humanas conviene convertir en override permanente.
        </p>
      </header>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-[15px]">Catálogo de cuentas (SAT)</CardTitle>
          <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setCatalogoAbierto(!catalogoAbierto)} aria-expanded={catalogoAbierto}>
            {catalogoAbierto ? <ChevronUp /> : <ChevronDown />}
            {catalogoAbierto ? "Ocultar" : "Mostrar"}
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {catalogoError && (
            <p role="alert" className="text-destructive text-sm">
              {catalogoError}
            </p>
          )}
          {catalogoAbierto && (
            <>
              {!catalogo ? (
                // Sub-widget anidado dentro del panel plegable: skeletons
                // compactos en vez del bloque acolchado de EstadoCargando.
                <div role="status" aria-busy="true" aria-label="Cargando catálogo de cuentas…" className="space-y-2">
                  <span className="sr-only">Cargando catálogo de cuentas…</span>
                  <Skeleton className="h-9 w-80 rounded-md" />
                  <Skeleton className="h-4 w-full rounded" />
                  <Skeleton className="h-4 w-4/5 rounded" />
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="catalogo-filtro" className="sr-only">
                    Filtrar catálogo de cuentas
                  </Label>
                  <Input
                    id="catalogo-filtro"
                    type="text"
                    placeholder="Filtrar por código o nombre…"
                    value={catalogoFiltro}
                    onChange={(e) => setCatalogoFiltro(e.target.value)}
                    className="max-w-80"
                  />
                  <div className="max-h-64 overflow-auto rounded-lg border border-border">
                    <Table className="text-xs">
                      <TableHeader className="sticky top-0 bg-card">
                        <TableRow>
                          <TableHead className="h-9">Código</TableHead>
                          <TableHead className="h-9">Nombre</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {cuentasFiltradas.map(([codigo, nombre]) => (
                          <TableRow key={codigo}>
                            <TableCell className="p-1.5 font-mono">{codigo}</TableCell>
                            <TableCell className="p-1.5">{nombre}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{Object.keys(catalogo.mapeosDefault).length} mapeos default (tipoCfdi|categoría → cuentas) precargados en el motor.</p>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px]">Overrides humanos conocidos</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Historial de correcciones ya persistidas (este motor no guarda estado propio -- mándalas aquí en cada sesión). Se usan como prioridad máxima al clasificar y para calcular sugerencias de override permanente por RFC.
          </p>
          <div className="overflow-x-auto">
            <Table className="min-w-[640px] text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead className="h-9">CFDI UUID</TableHead>
                  <TableHead className="h-9">RFC emisor</TableHead>
                  <TableHead className="h-9">Categoría corregida</TableHead>
                  <TableHead className="h-9">Tenant (opcional)</TableHead>
                  <TableHead className="h-9" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {overrideFilas.map((f) => (
                  <TableRow key={f.key}>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`ov-uuid-${f.key}`} className="sr-only">
                        CFDI UUID
                      </Label>
                      <Input id={`ov-uuid-${f.key}`} type="text" value={f.cfdiUuid} onChange={(e) => actualizarOverrideFila(f.key, "cfdiUuid", e.target.value)} className="h-9 w-40 text-xs" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`ov-rfc-${f.key}`} className="sr-only">
                        RFC emisor
                      </Label>
                      <Input
                        id={`ov-rfc-${f.key}`}
                        type="text"
                        value={f.rfcEmisor}
                        onChange={(e) => actualizarOverrideFila(f.key, "rfcEmisor", e.target.value.toUpperCase())}
                        className="h-9 w-36 text-xs"
                      />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`ov-categoria-${f.key}`} className="sr-only">
                        Categoría corregida
                      </Label>
                      <Input id={`ov-categoria-${f.key}`} type="text" value={f.newCategoria} onChange={(e) => actualizarOverrideFila(f.key, "newCategoria", e.target.value)} className="h-9 w-44 text-xs" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`ov-tenant-${f.key}`} className="sr-only">
                        Tenant
                      </Label>
                      <Input id={`ov-tenant-${f.key}`} type="text" value={f.tenantId} onChange={(e) => actualizarOverrideFila(f.key, "tenantId", e.target.value)} className="h-9 w-24 text-xs" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-9 border-destructive/40 px-3 text-xs text-destructive hover:border-destructive"
                        onClick={() => setOverrideFilas(overrideFilas.filter((r) => r.key !== f.key))}
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
            <Button type="button" variant="outline" size="sm" onClick={() => setOverrideFilas([...overrideFilas, nuevaOverrideFila()])}>
              <Plus />
              Agregar override
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px]">1. Clasificar CFDI</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="overflow-x-auto">
            <Table className="min-w-[900px] text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead className="h-9">UUID *</TableHead>
                  <TableHead className="h-9">RFC emisor *</TableHead>
                  <TableHead className="h-9">RFC receptor</TableHead>
                  <TableHead className="h-9">Descripción</TableHead>
                  <TableHead className="h-9">Subtotal</TableHead>
                  <TableHead className="h-9">IVA</TableHead>
                  <TableHead className="h-9">Total</TableHead>
                  <TableHead className="h-9">Tasa IVA</TableHead>
                  <TableHead className="h-9">Tipo</TableHead>
                  <TableHead className="h-9" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {cfdiFilas.map((f) => (
                  <TableRow key={f.key}>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`bk-uuid-${f.key}`} className="sr-only">
                        UUID
                      </Label>
                      <Input id={`bk-uuid-${f.key}`} type="text" value={f.cfdiUuid} onChange={(e) => actualizarCfdiFila(f.key, "cfdiUuid", e.target.value)} className="h-9 w-40 text-xs" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`bk-rfc-em-${f.key}`} className="sr-only">
                        RFC emisor
                      </Label>
                      <Input
                        id={`bk-rfc-em-${f.key}`}
                        type="text"
                        value={f.rfcEmisor}
                        onChange={(e) => actualizarCfdiFila(f.key, "rfcEmisor", e.target.value.toUpperCase())}
                        className="h-9 w-32 text-xs"
                      />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`bk-rfc-rec-${f.key}`} className="sr-only">
                        RFC receptor
                      </Label>
                      <Input
                        id={`bk-rfc-rec-${f.key}`}
                        type="text"
                        value={f.rfcReceptor}
                        onChange={(e) => actualizarCfdiFila(f.key, "rfcReceptor", e.target.value.toUpperCase())}
                        className="h-9 w-32 text-xs"
                      />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`bk-desc-${f.key}`} className="sr-only">
                        Descripción
                      </Label>
                      <Input
                        id={`bk-desc-${f.key}`}
                        type="text"
                        value={f.descripcion}
                        onChange={(e) => actualizarCfdiFila(f.key, "descripcion", e.target.value)}
                        placeholder="p.ej. Honorarios enero"
                        className="h-9 w-52 text-xs"
                      />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`bk-subtotal-${f.key}`} className="sr-only">
                        Subtotal
                      </Label>
                      <Input id={`bk-subtotal-${f.key}`} type="number" step="0.01" value={f.subtotal} onChange={(e) => actualizarCfdiFila(f.key, "subtotal", e.target.value)} className="h-9 w-24 text-xs" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`bk-iva-${f.key}`} className="sr-only">
                        IVA
                      </Label>
                      <Input id={`bk-iva-${f.key}`} type="number" step="0.01" value={f.iva} onChange={(e) => actualizarCfdiFila(f.key, "iva", e.target.value)} className="h-9 w-24 text-xs" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`bk-total-${f.key}`} className="sr-only">
                        Total
                      </Label>
                      <Input id={`bk-total-${f.key}`} type="number" step="0.01" value={f.total} onChange={(e) => actualizarCfdiFila(f.key, "total", e.target.value)} className="h-9 w-24 text-xs" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`bk-tasa-${f.key}`} className="sr-only">
                        Tasa de IVA
                      </Label>
                      <Input id={`bk-tasa-${f.key}`} type="number" step="0.01" value={f.tasaIva} onChange={(e) => actualizarCfdiFila(f.key, "tasaIva", e.target.value)} className="h-9 w-20 text-xs" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`bk-tipo-${f.key}`} className="sr-only">
                        Tipo de CFDI
                      </Label>
                      <select id={`bk-tipo-${f.key}`} value={f.tipoCfdi} onChange={(e) => actualizarCfdiFila(f.key, "tipoCfdi", e.target.value)} className={`${SELECT_CELL_CLASS} w-28`}>
                        {TIPOS_CFDI.map((t) => (
                          <option key={t} value={t}>
                            {t} · {TIPO_CFDI_LABELS[t]}
                          </option>
                        ))}
                      </select>
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-9 border-destructive/40 px-3 text-xs text-destructive hover:border-destructive"
                        onClick={() => setCfdiFilas(cfdiFilas.filter((r) => r.key !== f.key))}
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
            <Button type="button" variant="outline" size="sm" onClick={() => setCfdiFilas([...cfdiFilas, nuevaCfdiFila()])}>
              <Plus />
              Agregar CFDI
            </Button>
          </div>
          {clasifError && (
            <p role="alert" className="text-destructive text-sm">
              {clasifError}
            </p>
          )}
          <div>
            <Button type="button" onClick={() => void handleClasificar()} disabled={clasifLoading}>
              <ListChecks />
              {clasifLoading ? "Clasificando…" : "Clasificar lote"}
            </Button>
          </div>

          {clasificaciones.length > 0 && (
            <div>
              <p className="mb-1 mt-2 text-xs font-semibold text-foreground">Resultado ({clasificaciones.length}) -- la categoría es editable antes de generar pólizas</p>
              <div className="overflow-x-auto">
                <Table className="min-w-[720px] text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="h-9">UUID</TableHead>
                      <TableHead className="h-9">RFC emisor</TableHead>
                      <TableHead className="h-9">Categoría</TableHead>
                      <TableHead className="h-9">Confianza</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {clasificaciones.map((c, i) => (
                      <TableRow key={c.cfdiUuid}>
                        <TableCell className="p-1.5 font-mono">{c.cfdiUuid}</TableCell>
                        <TableCell className="p-1.5">{c.rfcEmisor}</TableCell>
                        <TableCell className="p-1.5">
                          <Label htmlFor={`bk-cat-${c.cfdiUuid}`} className="sr-only">
                            Categoría clasificada
                          </Label>
                          <Input id={`bk-cat-${c.cfdiUuid}`} type="text" value={c.categoria} onChange={(e) => corregirCategoria(i, e.target.value)} className="h-9 w-52 text-xs" />
                        </TableCell>
                        <TableCell className="p-1.5">
                          <ConfidenceBadge confidence={c.confidence} needsHumanReview={c.needsHumanReview} />
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
          <CardTitle className="text-[15px]">2. Generar pólizas</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">Genera + valida una póliza por cada CFDI clasificado arriba (sección 1). Si no hay mapeo contable para (tipo, categoría) el resultado trae el error explícito en vez de una póliza a medias.</p>
          <div className="flex flex-wrap gap-3">
            <div className="flex w-52 flex-col gap-1.5">
              <Label htmlFor="poliza-tenant">Tenant (opcional, mapeos custom)</Label>
              <Input id="poliza-tenant" type="text" value={polizaTenantId} onChange={(e) => setPolizaTenantId(e.target.value)} />
            </div>
            <div className="flex w-44 flex-col gap-1.5">
              <Label htmlFor="poliza-fecha">Fecha de la póliza</Label>
              <Input id="poliza-fecha" type="date" value={polizaFecha} onChange={(e) => setPolizaFecha(e.target.value)} />
            </div>
          </div>
          {polizaError && (
            <p role="alert" className="text-destructive text-sm">
              {polizaError}
            </p>
          )}
          <div>
            <Button type="button" onClick={() => void handleGenerarPolizas()} disabled={polizaLoading}>
              <FileStack />
              {polizaLoading ? "Generando…" : "Generar pólizas"}
            </Button>
          </div>
          {polizas && polizas.length > 0 && (
            <div className="flex flex-col gap-2.5">
              {polizas.map((r) => (
                <PolizaCard key={r.cfdiUuid} resultado={r} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px]">3. Registrar ajuste manual (diario)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Póliza de diario fuera del flujo de CFDI (depreciación, provisiones, correcciones). El motor NO garantiza el balance automáticamente aquí -- captura cargos y abonos que ya cuadren; los errores de validación se muestran abajo si no cuadra.
          </p>
          <form onSubmit={handleAjuste} className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-3">
              <div className="flex w-44 flex-col gap-1.5">
                <Label htmlFor="ajuste-fecha">Fecha *</Label>
                <Input id="ajuste-fecha" type="date" value={ajusteFecha} onChange={(e) => setAjusteFecha(e.target.value)} required />
              </div>
              <div className="flex w-64 flex-col gap-1.5">
                <Label htmlFor="ajuste-concepto">Concepto *</Label>
                <Input
                  id="ajuste-concepto"
                  type="text"
                  value={ajusteConcepto}
                  onChange={(e) => setAjusteConcepto(e.target.value)}
                  required
                  placeholder="p.ej. Depreciación mensual equipo de cómputo"
                />
              </div>
              <div className="flex w-44 flex-col gap-1.5">
                <Label htmlFor="ajuste-tenant">Tenant (opcional)</Label>
                <Input id="ajuste-tenant" type="text" value={ajusteTenantId} onChange={(e) => setAjusteTenantId(e.target.value)} />
              </div>
            </div>
            <div className="overflow-x-auto">
              <Table className="min-w-[560px] text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-9">Cuenta *</TableHead>
                    <TableHead className="h-9">Debe</TableHead>
                    <TableHead className="h-9">Haber</TableHead>
                    <TableHead className="h-9">Concepto</TableHead>
                    <TableHead className="h-9" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ajusteEntries.map((f) => (
                    <TableRow key={f.key}>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`adj-cuenta-${f.key}`} className="sr-only">
                          Cuenta
                        </Label>
                        <Input
                          id={`adj-cuenta-${f.key}`}
                          type="text"
                          value={f.cuenta}
                          onChange={(e) => actualizarAjusteFila(f.key, "cuenta", e.target.value)}
                          placeholder="p.ej. 6020300"
                          className="h-9 w-32 text-xs"
                        />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`adj-debe-${f.key}`} className="sr-only">
                          Debe
                        </Label>
                        <Input id={`adj-debe-${f.key}`} type="number" step="0.01" value={f.debe} onChange={(e) => actualizarAjusteFila(f.key, "debe", e.target.value)} className="h-9 w-24 text-xs" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`adj-haber-${f.key}`} className="sr-only">
                          Haber
                        </Label>
                        <Input id={`adj-haber-${f.key}`} type="number" step="0.01" value={f.haber} onChange={(e) => actualizarAjusteFila(f.key, "haber", e.target.value)} className="h-9 w-24 text-xs" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`adj-concepto-${f.key}`} className="sr-only">
                          Concepto
                        </Label>
                        <Input id={`adj-concepto-${f.key}`} type="text" value={f.concepto} onChange={(e) => actualizarAjusteFila(f.key, "concepto", e.target.value)} className="h-9 w-52 text-xs" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-9 border-destructive/40 px-3 text-xs text-destructive hover:border-destructive"
                          onClick={() => eliminarAjusteFila(f.key)}
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
              <Button type="button" variant="outline" size="sm" onClick={() => setAjusteEntries([...ajusteEntries, nuevaAjusteFila()])}>
                <Plus />
                Agregar movimiento
              </Button>
            </div>
            {ajusteError && (
              <p role="alert" className="text-destructive text-sm">
                {ajusteError}
              </p>
            )}
            <div>
              <Button type="submit" disabled={ajusteLoading}>
                <Calculator />
                {ajusteLoading ? "Registrando…" : "Registrar ajuste"}
              </Button>
            </div>
          </form>
          {ajusteResultado && <PolizaCard resultado={{ cfdiUuid: "ajuste manual", poliza: ajusteResultado.poliza, errores: ajusteResultado.errores }} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px]">4. Sugerencias de override</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Agrega el historial de overrides humanos capturado arriba por RFC -- sugiere convertir en override permanente solo cuando hay señal fuerte (2+ correcciones y más de la mitad coinciden en la misma categoría).
          </p>
          {sugerenciasError && (
            <p role="alert" className="text-destructive text-sm">
              {sugerenciasError}
            </p>
          )}
          <div>
            <Button type="button" onClick={() => void handleSugerencias()} disabled={sugerenciasLoading}>
              <Lightbulb />
              {sugerenciasLoading ? "Calculando…" : "Ver sugerencias"}
            </Button>
          </div>
          {sugerencias && sugerencias.length === 0 && (
            <p role="status" className="text-sm text-muted-foreground">
              Sin señal suficiente todavía para sugerir ningún override permanente.
            </p>
          )}
          {sugerencias && sugerencias.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-border">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-9">RFC</TableHead>
                    <TableHead className="h-9">Categoría sugerida</TableHead>
                    <TableHead className="h-9">Coincidencias</TableHead>
                    <TableHead className="h-9">Total correcciones</TableHead>
                    <TableHead className="h-9">Confianza</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sugerencias.map((s) => (
                    <TableRow key={s.rfc}>
                      <TableCell className="p-2 font-mono">{s.rfc}</TableCell>
                      <TableCell className="p-2">{s.suggestedCategoria}</TableCell>
                      <TableCell className="p-2 tabular-nums">{s.overrideCount}</TableCell>
                      <TableCell className="p-2 tabular-nums">{s.totalCorrections}</TableCell>
                      <TableCell className="p-2 tabular-nums">{(s.confidence * 100).toFixed(0)}%</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
