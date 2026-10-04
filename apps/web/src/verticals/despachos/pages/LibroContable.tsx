// D-24 -- Libro contable del cliente activo: polizas con folio (manuales o armadas desde un CFDI persistido), reversa, balanza
// derivada, catalogo de cuentas y el paquete de contabilidad electronica del mes. Datos reales: rutas de
// apps/api/.../despachos/libro.ts (migracion 020); el servidor y la base validan de verdad (cuadre, periodo cerrado, folio,
// roles). Esta pantalla solo da retroalimentacion inmediata y oculta acciones que el servidor rechazaria. Todo en centavos.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Download, FilePlus2, FileText, Plus, RotateCcw, Trash2 } from "lucide-react";
import {
  Button,
  Callout,
  DataTable,
  EstadoCargando,
  EstadoError,
  FormDialog,
  FormField,
  Input,
  NativeSelect,
  PageContainer,
  PageHeader,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@atiende/ui";
import {
  centavosAPesos,
  dinero,
  erroresPoliza,
  ETIQUETA_ORIGEN_POLIZA,
  ETIQUETA_TIPO_POLIZA,
  fetchBalanza,
  fetchCfdiLibro,
  fetchCuentas,
  fetchPaquete,
  fetchPoliza,
  fetchPolizas,
  guardarCuenta,
  PARTIDA_VACIA,
  periodoActual,
  polizaDesdeCfdi,
  polizaVacia,
  registrarPoliza,
  resumenCuadre,
  reversarPoliza,
  sembrarCatalogo,
  TIPOS_POLIZA,
} from "../lib/libro-client.ts";
import type { BalanzaRespuesta, CfdiLibro, CuentaLibro, PaqueteContabilidad, PartidaFormulario, PolizaDetalle, PolizaFormulario, PolizaResumen, TipoPoliza } from "../lib/libro-client.ts";
import { formatFechaSolo, hoyFechaSolo } from "../../../lib/formato-fecha.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Espejo cosmetico de GESTIONAR_LIBRO_ROLES (@atiende/domain-despachos/src/roles.ts); el servidor es la autoridad.
const GESTIONAR_ROLES: ReadonlySet<string> = new Set(["admin", "contador"]);

function descargarTexto(nombre: string, contenido: string, tipo: string): void {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(url);
}

function mensajeDe(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

interface FormularioPolizaProps {
  readonly cuentas: readonly CuentaLibro[];
  readonly inicial: PolizaFormulario;
  readonly guardando: boolean;
  readonly errorServidor: string | null;
  readonly onGuardar: (f: PolizaFormulario) => void;
}

/** Formulario de una poliza manual: partidas en pesos, resumen de cuadre en vivo. */
function FormularioPoliza({ cuentas, inicial, guardando, errorServidor, onGuardar }: FormularioPolizaProps) {
  const [f, setF] = useState<PolizaFormulario>(inicial);
  const [intento, setIntento] = useState(false);
  const validas = useMemo(() => new Set(cuentas.map((c) => c.codigo)), [cuentas]);
  const errores = erroresPoliza(f, validas);
  const cuadre = resumenCuadre(f.partidas);
  const setPartida = (i: number, parcial: Partial<PartidaFormulario>) => setF((prev) => ({ ...prev, partidas: prev.partidas.map((p, j) => (j === i ? { ...p, ...parcial } : p)) }));

  function enviar(e: FormEvent) {
    e.preventDefault();
    setIntento(true);
    if (Object.keys(errores).length > 0 || guardando) return;
    onGuardar(f);
  }

  return (
    <form id="form-poliza" onSubmit={enviar} className="flex flex-col gap-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label="Tipo">
          <NativeSelect id="poliza-tipo" value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value as TipoPoliza })}>
            {TIPOS_POLIZA.map((t) => (
              <option key={t} value={t}>
                {ETIQUETA_TIPO_POLIZA[t]}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField label="Fecha" error={intento ? errores.fecha : undefined}>
          <Input id="poliza-fecha" type="date" value={f.fecha} onChange={(e) => setF({ ...f, fecha: e.target.value })} />
        </FormField>
        <FormField label="Concepto" className="sm:col-span-3" error={intento ? errores.concepto : undefined}>
          <Input id="poliza-concepto" value={f.concepto} maxLength={300} onChange={(e) => setF({ ...f, concepto: e.target.value })} placeholder="Qué registra esta póliza" />
        </FormField>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-foreground">Partidas</legend>
        {f.partidas.map((p, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_7rem_7rem_auto] sm:items-start">
            <NativeSelect aria-label={`Cuenta de la partida ${i + 1}`} value={p.cuenta} onChange={(e) => setPartida(i, { cuenta: e.target.value })}>
              <option value="">Cuenta…</option>
              {cuentas.map((c) => (
                <option key={c.codigo} value={c.codigo}>
                  {c.codigo} · {c.descripcion}
                </option>
              ))}
            </NativeSelect>
            <Input aria-label={`Concepto de la partida ${i + 1}`} value={p.concepto} maxLength={300} onChange={(e) => setPartida(i, { concepto: e.target.value })} placeholder="Concepto (opcional)" />
            <Input aria-label={`Debe de la partida ${i + 1}`} inputMode="decimal" value={p.debe} className="text-right font-mono" onChange={(e) => setPartida(i, { debe: e.target.value })} placeholder="Debe" />
            <Input aria-label={`Haber de la partida ${i + 1}`} inputMode="decimal" value={p.haber} className="text-right font-mono" onChange={(e) => setPartida(i, { haber: e.target.value })} placeholder="Haber" />
            <Button type="button" variant="ghost" size="sm" aria-label={`Quitar la partida ${i + 1}`} disabled={f.partidas.length <= 2} onClick={() => setF((prev) => ({ ...prev, partidas: prev.partidas.filter((_, j) => j !== i) }))}>
              <Trash2 />
            </Button>
            {intento && errores[`partida${i}`] && (
              <p role="alert" className="text-xs font-medium text-destructive sm:col-span-5">
                Partida {i + 1}: {errores[`partida${i}`]}
              </p>
            )}
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="outline" size="sm" disabled={f.partidas.length >= 200} onClick={() => setF((prev) => ({ ...prev, partidas: [...prev.partidas, PARTIDA_VACIA] }))}>
            <Plus />
            Agregar partida
          </Button>
          <p role="status" className={`font-mono text-xs ${cuadre.cuadra ? "text-success" : "text-muted-foreground"}`}>
            Debe {dinero(cuadre.debeCentavos)} · Haber {dinero(cuadre.haberCentavos)} · {cuadre.cuadra ? "Cuadra" : `Diferencia ${dinero(Math.abs(cuadre.diferenciaCentavos))}`}
          </p>
        </div>
        {intento && (errores.cuadre || errores.partidas) && (
          <p role="alert" className="text-xs font-medium text-destructive">
            {errores.cuadre ?? errores.partidas}
          </p>
        )}
      </fieldset>
      {errorServidor && <Callout tone="danger">{errorServidor}</Callout>}
    </form>
  );
}

export function LibroContablePage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const hoy = hoyFechaSolo();
  const [periodo, setPeriodo] = useState(periodoActual(hoy));
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [noDisponible, setNoDisponible] = useState(false);
  const [cuentas, setCuentas] = useState<readonly CuentaLibro[]>([]);
  const [polizas, setPolizas] = useState<readonly PolizaResumen[]>([]);
  const [balanza, setBalanza] = useState<BalanzaRespuesta | null>(null);
  const [cfdi, setCfdi] = useState<{ readonly cfdi: readonly CfdiLibro[]; readonly truncado: boolean } | null>(null);
  const [cfdiError, setCfdiError] = useState<string | null>(null);
  const [nueva, setNueva] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [errorGuardar, setErrorGuardar] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<PolizaDetalle | null>(null);
  const [reversando, setReversando] = useState<PolizaResumen | null>(null);
  const [reversa, setReversa] = useState({ fecha: hoy, concepto: "" });
  const [paquete, setPaquete] = useState<PaqueteContabilidad | null>(null);
  const [paqueteError, setPaqueteError] = useState<string | null>(null);
  const [cuentaNueva, setCuentaNueva] = useState({ codigo: "", descripcion: "", naturaleza: "D" as "D" | "A" });

  const puedeGestionar = GESTIONAR_ROLES.has(role);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    setPaquete(null);
    try {
      // Secuencial a proposito (mismo criterio que el servidor: una sola transaccion por request).
      const c = await fetchCuentas(fetch, apiBaseUrl, token, propertyId);
      setNoDisponible(c.estado === "no_disponible");
      setCuentas(c.cuentas);
      const p = await fetchPolizas(fetch, apiBaseUrl, token, propertyId, periodo);
      setPolizas(p.polizas);
      setBalanza(await fetchBalanza(fetch, apiBaseUrl, token, propertyId, periodo));
      try {
        setCfdi(await fetchCfdiLibro(fetch, apiBaseUrl, token, propertyId, periodo));
        setCfdiError(null);
      } catch (err) {
        setCfdi(null);
        setCfdiError(mensajeDe(err, "No se pudieron cargar los CFDI del periodo."));
      }
    } catch (err) {
      setError(mensajeDe(err, "No se pudo cargar el libro contable."));
    } finally {
      setCargando(false);
    }
  }, [apiBaseUrl, token, propertyId, periodo]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function ejecutar(accion: () => Promise<string>) {
    setAviso(null);
    setError(null);
    try {
      setAviso(await accion());
      await cargar();
    } catch (err) {
      setError(mensajeDe(err, "No se pudo completar la operación."));
    }
  }

  async function guardarPoliza(f: PolizaFormulario) {
    setGuardando(true);
    setErrorGuardar(null);
    try {
      const r = await registrarPoliza(fetch, apiBaseUrl, token, propertyId, f);
      setNueva(false);
      setAviso(`Póliza ${ETIQUETA_TIPO_POLIZA[f.tipo].toLowerCase()} folio ${r.folio} registrada.`);
      await cargar();
    } catch (err) {
      setErrorGuardar(mensajeDe(err, "No se pudo registrar la póliza."));
    } finally {
      setGuardando(false);
    }
  }

  async function abrirDetalle(p: PolizaResumen) {
    try {
      setDetalle(await fetchPoliza(fetch, apiBaseUrl, token, propertyId, p.id));
    } catch (err) {
      setError(mensajeDe(err, "No se pudo cargar la póliza."));
    }
  }

  async function confirmarReversa(e: FormEvent) {
    e.preventDefault();
    if (!reversando || reversa.concepto.trim() === "" || !/^\d{4}-\d{2}-\d{2}$/.test(reversa.fecha)) return;
    const original = reversando;
    setReversando(null);
    await ejecutar(async () => {
      const r = await reversarPoliza(fetch, apiBaseUrl, token, propertyId, original.id, reversa.fecha, reversa.concepto.trim());
      return `Póliza revertida: reversa folio ${r.folio}.`;
    });
  }

  async function generarPaquete() {
    setPaqueteError(null);
    try {
      setPaquete(await fetchPaquete(fetch, apiBaseUrl, token, propertyId, periodo));
    } catch (err) {
      setPaquete(null);
      setPaqueteError(mensajeDe(err, "No se pudo generar el paquete."));
    }
  }

  const periodoValido = /^\d{4}-(0[1-9]|1[0-2])$/.test(periodo);

  return (
    <PageContainer className="[&>*]:min-w-0">
      <PageHeader
        titulo="Libro contable"
        descripcion="Pólizas con folio, balanza de comprobación y catálogo de cuentas del cliente activo."
        acciones={
          <>
            <FormField label="Periodo" className="grid-flow-col items-center gap-2">
              <Input id="libro-periodo" type="month" value={periodo} onChange={(e) => setPeriodo(e.target.value)} className="w-44" />
            </FormField>
            {puedeGestionar && !noDisponible && (
              <Button
                type="button"
                size="sm"
                disabled={!periodoValido || cuentas.length === 0}
                onClick={() => {
                  setErrorGuardar(null);
                  setAviso(null);
                  setNueva(true);
                }}
              >
                <Plus />
                Nueva póliza
              </Button>
            )}
          </>
        }
      />

      {aviso && (
        <Callout tone="success" onDismiss={() => setAviso(null)}>
          {aviso}
        </Callout>
      )}
      {error && <EstadoError mensaje={error} onReintentar={() => void cargar()} />}
      {cargando && polizas.length === 0 && !balanza && <EstadoCargando etiqueta="Cargando libro contable…" />}
      {noDisponible && (
        <Callout tone="warning">
          El libro contable todavía no está disponible en esta base: falta aplicar la migración 020. Hasta entonces no se pueden registrar pólizas.
        </Callout>
      )}

      {!noDisponible && (
        <Tabs defaultValue="polizas" className="flex flex-col gap-3.5">
          <TabsList className="h-auto flex-wrap justify-start">
            <TabsTrigger value="polizas">
              Pólizas
            </TabsTrigger>
            <TabsTrigger value="cfdi">
              CFDI del periodo
            </TabsTrigger>
            <TabsTrigger value="balanza">
              Balanza
            </TabsTrigger>
            <TabsTrigger value="catalogo">
              Catálogo
            </TabsTrigger>
            <TabsTrigger value="electronica">
              Contabilidad electrónica
            </TabsTrigger>
          </TabsList>

          <TabsContent value="polizas" className="mt-0">
            <DataTable
              etiqueta="Pólizas del periodo"
              obtenerId={(p) => p.id}
              filas={polizas}
              paginacion={{ tamano: 15 }}
              vacio={{ mensaje: cuentas.length === 0 ? "Este cliente todavía no tiene catálogo de cuentas: siémbralo en la pestaña Catálogo o registra la primera póliza desde un CFDI." : "No hay pólizas en este periodo." }}
              columnas={[
                { id: "folio", encabezado: "Póliza", principal: true, valorOrden: (p) => p.folio, celda: (p) => <span className="font-mono text-xs">{ETIQUETA_TIPO_POLIZA[p.tipo]} {p.folio}</span> },
                { id: "fecha", encabezado: "Fecha", valorOrden: (p) => p.fecha, celda: (p) => formatFechaSolo(p.fecha) },
                { id: "concepto", encabezado: "Concepto", celda: (p) => <span className="text-foreground">{p.concepto}</span> },
                { id: "origen", encabezado: "Origen", celda: (p) => <span className="text-muted-foreground">{ETIQUETA_ORIGEN_POLIZA[p.origen] ?? p.origen}</span> },
                { id: "total", encabezado: "Total", alinear: "right", valorOrden: (p) => p.totalCentavos, celda: (p) => <span className="font-mono text-xs">{dinero(p.totalCentavos)}</span> },
                { id: "estado", encabezado: "Estado", celda: (p) => (p.reversada ? <StatusBadge tone="warning">Revertida</StatusBadge> : p.origen === "reversa" ? <StatusBadge tone="info">Reversa</StatusBadge> : <StatusBadge tone="success">Vigente</StatusBadge>) },
                {
                  id: "acciones",
                  encabezado: "",
                  ocultarEnTarjeta: false,
                  celda: (p) => (
                    <div className="flex justify-end gap-1.5">
                      <Button type="button" variant="outline" size="sm" onClick={() => void abrirDetalle(p)}>
                        <FileText />
                        Ver
                      </Button>
                      {puedeGestionar && !p.reversada && p.origen !== "reversa" && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setReversa({ fecha: hoy, concepto: `Reversa de ${ETIQUETA_TIPO_POLIZA[p.tipo].toLowerCase()} ${p.folio}` });
                            setReversando(p);
                          }}
                        >
                          <RotateCcw />
                          Revertir
                        </Button>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </TabsContent>

          <TabsContent value="cfdi" className="mt-0 flex flex-col gap-3">
            {cfdiError && <EstadoError mensaje={cfdiError} onReintentar={() => void cargar()} />}
            {cfdi?.truncado && <Callout tone="warning">Se muestran los primeros 500 CFDI del periodo.</Callout>}
            {cfdi && (
              <DataTable
                etiqueta="CFDI del periodo y su póliza"
                obtenerId={(c) => c.id}
                filas={cfdi.cfdi}
                paginacion={{ tamano: 15 }}
                vacio={{ mensaje: "No hay CFDI ingeridos en este periodo." }}
                columnas={[
                  { id: "folio", encabezado: "CFDI", principal: true, celda: (c) => <span className="font-mono text-xs">{c.folioFiscal.slice(0, 8)}…</span> },
                  { id: "tipo", encabezado: "Tipo", celda: (c) => <span className="text-muted-foreground">{c.tipo} · {c.direccion === "emitido" ? "Emitido" : c.direccion === "recibido" ? "Recibido" : "Sin sentido"}</span> },
                  { id: "fecha", encabezado: "Fecha", valorOrden: (c) => c.fecha, celda: (c) => formatFechaSolo(c.fecha) },
                  { id: "total", encabezado: "Total", alinear: "right", celda: (c) => <span className="font-mono text-xs">{dinero(c.totalCentavos)}</span> },
                  {
                    id: "poliza",
                    encabezado: "Póliza",
                    celda: (c) =>
                      c.poliza ? (
                        <StatusBadge tone="success">{ETIQUETA_TIPO_POLIZA[c.poliza.tipo]} {c.poliza.folio}</StatusBadge>
                      ) : c.armable ? (
                        <StatusBadge tone="info">Sin contabilizar</StatusBadge>
                      ) : (
                        <span className="text-xs text-muted-foreground">{c.motivo}</span>
                      ),
                  },
                  {
                    id: "acciones",
                    encabezado: "",
                    celda: (c) =>
                      puedeGestionar && c.armable ? (
                        <Button type="button" variant="outline" size="sm" onClick={() => void ejecutar(async () => `Póliza folio ${(await polizaDesdeCfdi(fetch, apiBaseUrl, token, propertyId, c.id)).folio} registrada.`)}>
                          <FilePlus2 />
                          Contabilizar
                        </Button>
                      ) : null,
                  },
                ]}
              />
            )}
          </TabsContent>

          <TabsContent value="balanza" className="mt-0 flex flex-col gap-3">
            {balanza && balanza.lineas.length > 0 && (
              <Callout tone={balanza.totales.cuadrada ? "success" : "warning"} role="status">
                {balanza.totales.cuadrada ? "La balanza cuadra" : "La balanza NO cuadra"}: debe {dinero(balanza.totales.debeCentavos)} · haber {dinero(balanza.totales.haberCentavos)}.
              </Callout>
            )}
            <DataTable
              etiqueta="Balanza de comprobación"
              obtenerId={(l) => l.cuenta}
              filas={balanza?.lineas ?? []}
              paginacion={{ tamano: 20 }}
              vacio={{ mensaje: "No hay movimientos en este periodo: la balanza se deriva de las pólizas registradas." }}
              columnas={[
                { id: "cuenta", encabezado: "Cuenta", principal: true, valorOrden: (l) => l.cuenta, celda: (l) => <><span className="font-mono text-xs">{l.cuenta}</span> <span className="text-muted-foreground">{l.descripcion}</span></> },
                { id: "ini", encabezado: "Saldo inicial", alinear: "right", celda: (l) => <span className="font-mono text-xs">{dinero(l.saldoInicialCentavos)}</span> },
                { id: "debe", encabezado: "Debe", alinear: "right", celda: (l) => <span className="font-mono text-xs">{dinero(l.debeCentavos)}</span> },
                { id: "haber", encabezado: "Haber", alinear: "right", celda: (l) => <span className="font-mono text-xs">{dinero(l.haberCentavos)}</span> },
                { id: "fin", encabezado: "Saldo final", alinear: "right", celda: (l) => <span className={`font-mono text-xs ${l.saldoFinalCentavos < 0 ? "text-destructive" : ""}`}>{dinero(l.saldoFinalCentavos)}</span> },
              ]}
            />
          </TabsContent>

          <TabsContent value="catalogo" className="mt-0 flex flex-col gap-3">
            {puedeGestionar && cuentas.length === 0 && (
              <Callout tone="info" role="status">
                Este cliente aún no tiene catálogo de cuentas.{" "}
                <Button type="button" size="sm" className="ml-2" onClick={() => void ejecutar(async () => `Catálogo base sembrado (${(await sembrarCatalogo(fetch, apiBaseUrl, token, propertyId)).agregadas} cuentas).`)}>
                  Sembrar catálogo base
                </Button>
              </Callout>
            )}
            {puedeGestionar && (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void ejecutar(async () => {
                    const c = await guardarCuenta(fetch, apiBaseUrl, token, propertyId, { codigo: cuentaNueva.codigo.trim(), descripcion: cuentaNueva.descripcion.trim(), naturaleza: cuentaNueva.naturaleza });
                    setCuentaNueva({ codigo: "", descripcion: "", naturaleza: "D" });
                    return `Cuenta ${c.codigo} guardada.`;
                  });
                }}
              >
                <FormField label="Código">
                  <Input id="cuenta-codigo" value={cuentaNueva.codigo} inputMode="numeric" maxLength={10} className="w-32 font-mono" onChange={(e) => setCuentaNueva({ ...cuentaNueva, codigo: e.target.value.replace(/\D/g, "") })} />
                </FormField>
                <FormField label="Descripción" className="min-w-48 flex-1">
                  <Input id="cuenta-descripcion" value={cuentaNueva.descripcion} maxLength={200} onChange={(e) => setCuentaNueva({ ...cuentaNueva, descripcion: e.target.value })} />
                </FormField>
                <FormField label="Naturaleza">
                  <NativeSelect id="cuenta-naturaleza" value={cuentaNueva.naturaleza} onChange={(e) => setCuentaNueva({ ...cuentaNueva, naturaleza: e.target.value as "D" | "A" })}>
                    <option value="D">Deudora</option>
                    <option value="A">Acreedora</option>
                  </NativeSelect>
                </FormField>
                <Button type="submit" size="sm" variant="outline" disabled={!/^\d{4,10}$/.test(cuentaNueva.codigo) || cuentaNueva.descripcion.trim() === ""}>
                  <Plus />
                  Guardar cuenta
                </Button>
              </form>
            )}
            <DataTable
              etiqueta="Catálogo de cuentas"
              obtenerId={(c) => c.codigo}
              filas={cuentas}
              paginacion={{ tamano: 20 }}
              vacio={{ mensaje: "Sin cuentas." }}
              columnas={[
                { id: "codigo", encabezado: "Código", principal: true, valorOrden: (c) => c.codigo, celda: (c) => <span className="font-mono text-xs">{c.codigo}</span> },
                { id: "descripcion", encabezado: "Descripción", celda: (c) => c.descripcion },
                { id: "naturaleza", encabezado: "Naturaleza", celda: (c) => <span className="text-muted-foreground">{c.naturaleza === "D" ? "Deudora" : "Acreedora"}</span> },
              ]}
            />
          </TabsContent>

          <TabsContent value="electronica" className="mt-0 flex flex-col gap-3">
            <p className="text-ui text-muted-foreground">Genera el catálogo y la balanza de comprobación del mes en XML (contabilidad electrónica), con su huella SHA-1, desde el libro. No se envía al SAT desde Atiende.</p>
            <div>
              <Button type="button" size="sm" disabled={!periodoValido} onClick={() => void generarPaquete()}>
                Generar paquete de {periodo}
              </Button>
            </div>
            {paqueteError && <EstadoError mensaje={paqueteError} />}
            {paquete && (
              <div className="flex flex-col gap-2">
                <Callout tone={paquete.balanza.cuadrada ? "success" : "warning"} role="status">
                  Balanza {paquete.balanza.cuadrada ? "cuadrada" : "descuadrada"}: {paquete.resumen.cuentas} cuentas, debe ${paquete.resumen.totalDebe} · haber ${paquete.resumen.totalHaber}. {paquete.nota}
                </Callout>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => descargarTexto(`catalogo-${paquete.periodo}.xml`, paquete.catalogo.xml, "application/xml")}>
                    <Download />
                    Catálogo XML
                  </Button>
                  <span className="font-mono text-2xs text-muted-foreground">SHA-1 {paquete.catalogo.sha1}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => descargarTexto(`balanza-${paquete.periodo}.xml`, paquete.balanza.xml, "application/xml")}>
                    <Download />
                    Balanza XML
                  </Button>
                  <span className="font-mono text-2xs text-muted-foreground">SHA-1 {paquete.balanza.sha1}</span>
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}

      <FormDialog
        open={nueva}
        onOpenChange={(abrir) => !abrir && !guardando && setNueva(false)}
        titulo="Nueva póliza"
        subtitulo="Captura en pesos; se guarda en centavos. Debe y haber deben cuadrar."
        anchoClase="max-w-4xl"
        bloquearCierre={guardando}
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setNueva(false)} disabled={guardando}>
              Cancelar
            </Button>
            <Button type="submit" form="form-poliza" loading={guardando}>
              Registrar póliza
            </Button>
          </>
        }
      >
        {nueva && <FormularioPoliza cuentas={cuentas} inicial={polizaVacia(periodoValido && periodo === periodoActual(hoy) ? hoy : `${periodo}-01`)} guardando={guardando} errorServidor={errorGuardar} onGuardar={(f) => void guardarPoliza(f)} />}
      </FormDialog>

      <FormDialog
        open={detalle !== null}
        onOpenChange={(abrir) => !abrir && setDetalle(null)}
        titulo={detalle ? `${ETIQUETA_TIPO_POLIZA[detalle.tipo]} ${detalle.folio} · ${formatFechaSolo(detalle.fecha)}` : "Póliza"}
        subtitulo={detalle?.concepto}
        anchoClase="max-w-3xl"
        footer={
          <Button type="button" variant="outline" onClick={() => setDetalle(null)}>
            Cerrar
          </Button>
        }
      >
        {detalle && (
          <DataTable
            etiqueta="Partidas de la póliza"
            obtenerId={(m) => String(m.linea)}
            filas={detalle.movimientos}
            paginacion={false}
            columnas={[
              { id: "cuenta", encabezado: "Cuenta", principal: true, celda: (m) => <span className="font-mono text-xs">{m.cuenta}</span> },
              { id: "concepto", encabezado: "Concepto", celda: (m) => m.concepto || "—" },
              { id: "debe", encabezado: "Debe", alinear: "right", celda: (m) => <span className="font-mono text-xs">{m.debeCentavos ? centavosAPesos(m.debeCentavos) : ""}</span> },
              { id: "haber", encabezado: "Haber", alinear: "right", celda: (m) => <span className="font-mono text-xs">{m.haberCentavos ? centavosAPesos(m.haberCentavos) : ""}</span> },
            ]}
          />
        )}
      </FormDialog>

      <FormDialog
        open={reversando !== null}
        onOpenChange={(abrir) => !abrir && setReversando(null)}
        titulo="Revertir póliza"
        subtitulo={reversando ? `${ETIQUETA_TIPO_POLIZA[reversando.tipo]} ${reversando.folio}: se crea una póliza de diario con las partidas invertidas; la original no se borra.` : undefined}
        anchoClase="max-w-lg"
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setReversando(null)}>
              Cancelar
            </Button>
            <Button type="submit" form="form-reversa" disabled={reversa.concepto.trim() === "" || !/^\d{4}-\d{2}-\d{2}$/.test(reversa.fecha)}>
              Revertir
            </Button>
          </>
        }
      >
        <form id="form-reversa" onSubmit={(e) => void confirmarReversa(e)} className="flex flex-col gap-3">
          <FormField label="Fecha de la reversa">
            <Input id="reversa-fecha" type="date" value={reversa.fecha} onChange={(e) => setReversa({ ...reversa, fecha: e.target.value })} />
          </FormField>
          <FormField label="Concepto">
            <Input id="reversa-concepto" value={reversa.concepto} maxLength={300} onChange={(e) => setReversa({ ...reversa, concepto: e.target.value })} />
          </FormField>
        </form>
      </FormDialog>
    </PageContainer>
  );
}
