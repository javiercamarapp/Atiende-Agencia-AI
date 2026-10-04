// Panel de contabilidad electrónica SAT (Anexo 24) -- hallazgo de auditoría:
// el motor completo (catálogo de cuentas XML, balanza XML, paquete completo
// con hash SHA-1) ya existía en @atiende/domain-despachos con tests, pero
// ninguna ruta HTTP ni pantalla lo exponía. Obligación fiscal MENSUAL real de
// un despacho -- la plantilla de cierre mensual ya lista esta generación como
// categoría "electronica" (tarea "contabilidad_elect", ver
// CierreMensualDetalle.tsx) sin poder generarla desde el producto hasta esta
// pantalla.
//
// Flujo: 1) periodo (ejercicio/mes/RFC/razón social) + asientos contables del
// mes (el catálogo usa el default Anexo 24 del SAT, cargado de
// GET /catalogo-base) -> 2) "Generar paquete completo" corre el motor
// (catálogo + balanza + hashes, estado inicial "listo_para_timbrar") -> 3) el
// contador puede descargar cada XML y, si el paquete quedó bien, confirmar el
// estado "listo para timbrar" (idempotente). Ningún paquete se persiste
// server-side en esta fase (ver cabecera de contabilidad-electronica.ts en
// apps/api): el estado que se muestra es el que devolvió la última llamada.
//
// Presentación (ronda de design system): los objetos de estilo inline
// (inputStyle/labelStyle/sectionStyle/buttonPrimary/buttonSecondary) se
// sustituyeron por Card/Input/Label/Button/Table de @atiende/ui. Ni el flujo,
// ni el estado, ni las llamadas cambian.
import { useEffect, useState } from "react";
import { Download, FileCog, Lock, Plus, Trash2 } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoVacio,
  FormField,
  Input,
  Label,
  PageContainer,
  PageHeader,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  notify,
  useConfirm,
} from "@atiende/ui";
import {
  fetchCatalogoBaseContabilidadElectronica,
  postPaqueteContabilidadElectronica,
  postListoParaTimbrarContabilidadElectronica,
} from "../lib/contabilidad-electronica-client.ts";
import type { AsientoContable, CuentaAnexo24, EstadoPaqueteContabilidad, PaqueteContabilidadElectronica } from "../lib/contabilidad-electronica-client.ts";
import { formatMoney } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo conjunto que CONTABILIDAD_ELECTRONICA_ROLES (@atiende/domain-despachos/
// roles.ts) -- la ruta exige este rol en cada llamada; esto es cosmético
// (ocultar botones que el servidor rechazaría igual), mismo criterio que
// DevolucionIva.tsx/Conciliacion.tsx.
const CONTABILIDAD_ELECTRONICA_ROLES = new Set(["admin", "contador"]);

const ESTADO_LABELS: Record<EstadoPaqueteContabilidad, string> = {
  borrador: "Borrador",
  listo_para_timbrar: "Listo para timbrar",
  timbrado: "Timbrado",
  enviado: "Enviado",
};

interface AsientoFila {
  readonly key: string;
  cuenta: string;
  debe: string;
  haber: string;
  fecha: string;
}

let asientoSeq = 0;
function nuevaAsientoFila(): AsientoFila {
  asientoSeq += 1;
  return { key: `as-${asientoSeq}`, cuenta: "", debe: "", haber: "", fecha: "" };
}

function filaAAsiento(a: AsientoFila): AsientoContable | null {
  const cuenta = a.cuenta.trim();
  if (!cuenta) return null;
  return {
    cuenta,
    debe: a.debe.trim() ? Number(a.debe) : undefined,
    haber: a.haber.trim() ? Number(a.haber) : undefined,
    fecha: a.fecha.trim() || null,
  };
}

function descargarXml(nombre: string, xml: string) {
  const blob = new Blob([xml], { type: "application/xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function AsientosEditor({ filas, setFilas }: { filas: readonly AsientoFila[]; setFilas: (f: readonly AsientoFila[]) => void }) {
  function actualizar(key: string, campo: keyof AsientoFila, valor: string) {
    setFilas(filas.map((a) => (a.key === key ? { ...a, [campo]: valor } : a)));
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <Table className="min-w-[560px] text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Cuenta *</TableHead>
              <TableHead>Debe</TableHead>
              <TableHead>Haber</TableHead>
              <TableHead>Fecha</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filas.map((a) => (
              <TableRow key={a.key}>
                <TableCell className="p-1.5">
                  <Label htmlFor={`asiento-cuenta-${a.key}`} className="sr-only">
                    Cuenta
                  </Label>
                  <Input id={`asiento-cuenta-${a.key}`} type="text" value={a.cuenta} onChange={(e) => actualizar(a.key, "cuenta", e.target.value)} placeholder="1101" className="w-28" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`asiento-debe-${a.key}`} className="sr-only">
                    Debe
                  </Label>
                  <Input id={`asiento-debe-${a.key}`} type="number" step="0.01" value={a.debe} onChange={(e) => actualizar(a.key, "debe", e.target.value)} className="w-28" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`asiento-haber-${a.key}`} className="sr-only">
                    Haber
                  </Label>
                  <Input id={`asiento-haber-${a.key}`} type="number" step="0.01" value={a.haber} onChange={(e) => actualizar(a.key, "haber", e.target.value)} className="w-28" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`asiento-fecha-${a.key}`} className="sr-only">
                    Fecha
                  </Label>
                  <Input id={`asiento-fecha-${a.key}`} type="date" value={a.fecha} onChange={(e) => actualizar(a.key, "fecha", e.target.value)} className="w-36" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Button type="button" variant="destructive" onClick={() => setFilas(filas.filter((r) => r.key !== a.key))}>
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
        <Button type="button" variant="outline" size="sm" onClick={() => setFilas([...filas, nuevaAsientoFila()])}>
          <Plus />
          Agregar asiento
        </Button>
      </div>
    </div>
  );
}

export function ContabilidadElectronicaPage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const { confirmar, dialogo } = useConfirm();
  const puedeGestionar = CONTABILIDAD_ELECTRONICA_ROLES.has(role);

  const now = new Date();
  const [ejercicio, setEjercicio] = useState(String(now.getFullYear()));
  const [mes, setMes] = useState(String(now.getMonth() + 1));
  const [rfc, setRfc] = useState("");
  const [razonSocial, setRazonSocial] = useState("");

  const [catalogoBase, setCatalogoBase] = useState<readonly CuentaAnexo24[] | null>(null);
  const [catalogoError, setCatalogoError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetchCatalogoBaseContabilidadElectronica(fetch, apiBaseUrl, token, propertyId)
      .then((c) => {
        if (!cancelado) setCatalogoBase(c);
      })
      .catch((err) => {
        if (!cancelado) setCatalogoError(err instanceof Error ? err.message : "No se pudo cargar el catálogo base.");
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  const [asientoFilas, setAsientoFilas] = useState<readonly AsientoFila[]>([nuevaAsientoFila()]);
  const asientos = asientoFilas.map(filaAAsiento).filter((a): a is AsientoContable => a !== null);

  const [generando, setGenerando] = useState(false);
  const [generarError, setGenerarError] = useState<string | null>(null);
  const [paquete, setPaquete] = useState<PaqueteContabilidadElectronica | null>(null);

  const [confirmando, setConfirmando] = useState(false);
  const [confirmarError, setConfirmarError] = useState<string | null>(null);

  async function handleGenerarPaquete() {
    setGenerarError(null);
    const ejercicioNum = Number(ejercicio);
    const mesNum = Number(mes);
    if (!Number.isFinite(ejercicioNum)) return setGenerarError("Ejercicio: captura un año válido.");
    if (!Number.isFinite(mesNum) || mesNum < 1 || mesNum > 12) return setGenerarError("Mes: captura un valor entre 1 y 12.");
    if (asientos.length === 0) return setGenerarError("Captura al menos un asiento contable con cuenta.");
    setGenerando(true);
    try {
      const resultado = await postPaqueteContabilidadElectronica(fetch, apiBaseUrl, token, propertyId, {
        ejercicio: ejercicioNum,
        mes: mesNum,
        rfc: rfc.trim() || undefined,
        razonSocial: razonSocial.trim() || undefined,
        asientos,
      });
      setPaquete(resultado);
    } catch (err) {
      setGenerarError(err instanceof Error ? err.message : "No se pudo generar el paquete de contabilidad electrónica.");
    } finally {
      setGenerando(false);
    }
  }

  async function handleMarcarListoParaTimbrar() {
    if (!paquete) return;
    const ok = await confirmar({
      titulo: "Confirmar listo para timbrar",
      descripcion: `El paquete de ${paquete.periodo} pasará a «Listo para timbrar». Revisa que la balanza cuadre y que los XML sean los correctos.`,
      confirmar: "Confirmar",
    });
    if (!ok) return;
    setConfirmarError(null);
    setConfirmando(true);
    try {
      const { estado } = await postListoParaTimbrarContabilidadElectronica(fetch, apiBaseUrl, token, propertyId, paquete.estado);
      setPaquete({ ...paquete, estado });
      notify.success("Paquete confirmado como listo para timbrar.");
    } catch (err) {
      setConfirmarError(err instanceof Error ? err.message : "No se pudo confirmar el estado del paquete.");
    } finally {
      setConfirmando(false);
    }
  }

  if (!puedeGestionar) {
    return (
      <PageContainer className="[&>*]:min-w-0">
        <PageHeader titulo="Contabilidad electrónica" descripcion="Catálogo, balanza y paquete del Anexo 24 del SAT." />
        <EstadoVacio icon={Lock} titulo="Sin permiso" mensaje={`Esta función requiere rol admin o contador. Tu rol actual (${role}) no puede generar la contabilidad electrónica -- el servidor lo rechazaría igual.`} />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="[&>*]:min-w-0">
      <PageHeader
        titulo="Contabilidad electrónica"
        descripcion={`Catálogo de cuentas XML, balanza de comprobación XML y paquete completo (con hash SHA-1) del Anexo 24 del SAT${catalogoBase ? ` · ${catalogoBase.length} cuentas en el catálogo base` : ""}.`}
      />
      {!catalogoBase && !catalogoError && <EstadoCargando etiqueta="Cargando catálogo base del SAT…" lineas={1} />}
      {catalogoError && <Callout tone="danger">{catalogoError}</Callout>}

      <Card>
        <CardHeader>
          <CardTitle>Periodo</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <FormField label="Ejercicio" required className="w-32">
            <Input id="ce-ejercicio" type="number" value={ejercicio} onChange={(e) => setEjercicio(e.target.value)} />
          </FormField>
          <FormField label="Mes" required className="w-28">
            <Input id="ce-mes" type="number" min={1} max={12} value={mes} onChange={(e) => setMes(e.target.value)} />
          </FormField>
          <FormField label="RFC (opcional)" className="w-52">
            <Input id="ce-rfc" type="text" value={rfc} onChange={(e) => setRfc(e.target.value.toUpperCase())} />
          </FormField>
          <FormField label="Razón social (opcional)" className="w-64">
            <Input id="ce-razon" type="text" value={razonSocial} onChange={(e) => setRazonSocial(e.target.value)} />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Asientos contables del mes</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Captura los movimientos (cuenta + debe/haber) que alimentan la balanza de comprobación del periodo. Un asiento sin fecha nunca se excluye por periodo.
          </p>
          <AsientosEditor filas={asientoFilas} setFilas={setAsientoFilas} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Generar paquete completo</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {generarError && <Callout tone="danger">{generarError}</Callout>}
          <div>
            <Button type="button" onClick={() => void handleGenerarPaquete()} loading={generando}>
              <FileCog />
              Generar catálogo + balanza + paquete
            </Button>
          </div>

          {paquete && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-5 text-sm text-foreground">
                <span>
                  <strong>Periodo:</strong> {paquete.periodo}
                </span>
                <span className="flex items-center gap-1.5">
                  <strong>Estado:</strong>
                  <StatusBadge tone="info">{ESTADO_LABELS[paquete.estado] ?? paquete.estado}</StatusBadge>
                </span>
                <span>
                  <strong>Balanza cuadrada:</strong> {paquete.balanza.cuadrada ? "Sí" : "No"}
                </span>
                <span>
                  <strong>Generado:</strong> {paquete.generadoEn}
                </span>
              </div>

              {!paquete.balanza.cuadrada && (
                <Callout tone="danger">La balanza no cuadra (total debe ≠ total haber). Revisa los asientos antes de timbrar.</Callout>
              )}
              {paquete.resumenBalanza.saldosAnomalos.length > 0 && (
                <Callout tone="warning">
                  Cuentas con saldo anómalo: {paquete.resumenBalanza.saldosAnomalos.join(", ")}.
                </Callout>
              )}

              <div className="flex flex-wrap gap-5">
                <div className="flex flex-col items-start gap-1.5">
                  <p className="text-sm font-medium text-foreground">Catálogo de cuentas</p>
                  <span className="text-xs text-muted-foreground">
                    {paquete.catalogo.cuentas} cuentas · SHA-1 <span className="font-mono">{paquete.catalogo.sha1}</span>
                  </span>
                  <Button type="button" variant="outline" size="sm" onClick={() => descargarXml(`catalogo-cuentas-${paquete.periodo}.xml`, paquete.catalogo.xml)}>
                    <Download />
                    Descargar catálogo XML
                  </Button>
                </div>
                <div className="flex flex-col items-start gap-1.5">
                  <p className="text-sm font-medium text-foreground">Balanza de comprobación</p>
                  <span className="text-xs text-muted-foreground">
                    {paquete.balanza.cuentas} cuentas · SHA-1 <span className="font-mono">{paquete.balanza.sha1}</span>
                  </span>
                  <Button type="button" variant="outline" size="sm" onClick={() => descargarXml(`balanza-comprobacion-${paquete.periodo}.xml`, paquete.balanza.xml)}>
                    <Download />
                    Descargar balanza XML
                  </Button>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-border">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Cuenta</TableHead>
                      <TableHead>Descripción</TableHead>
                      <TableHead>Saldo inicial</TableHead>
                      <TableHead>Debe</TableHead>
                      <TableHead>Haber</TableHead>
                      <TableHead>Saldo final</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paquete.resumenBalanza.lineas.map((l) => (
                      <TableRow key={l.cuenta}>
                        <TableCell className="p-2 font-mono">{l.cuenta}</TableCell>
                        <TableCell className="p-2">{l.descripcion}</TableCell>
                        <TableCell className="p-2 tabular-nums">{formatMoney(Number(l.saldoInicial))}</TableCell>
                        <TableCell className="p-2 tabular-nums">{formatMoney(Number(l.debe))}</TableCell>
                        <TableCell className="p-2 tabular-nums">{formatMoney(Number(l.haber))}</TableCell>
                        <TableCell className="p-2 tabular-nums">{formatMoney(Number(l.saldoFinal))}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell className="p-2 font-semibold" colSpan={3}>
                        Totales
                      </TableCell>
                      <TableCell className="p-2 font-semibold tabular-nums">{formatMoney(Number(paquete.resumenBalanza.totalDebe))}</TableCell>
                      <TableCell className="p-2 font-semibold tabular-nums">{formatMoney(Number(paquete.resumenBalanza.totalHaber))}</TableCell>
                      <TableCell className="p-2" />
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>

              {confirmarError && <Callout tone="danger">{confirmarError}</Callout>}
              <div>
                <Button type="button" onClick={() => void handleMarcarListoParaTimbrar()} loading={confirmando} disabled={paquete.estado !== "listo_para_timbrar"}>
                  {paquete.estado === "listo_para_timbrar" ? "Confirmar listo para timbrar" : `Estado actual: ${ESTADO_LABELS[paquete.estado] ?? paquete.estado}`}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      {dialogo}
    </PageContainer>
  );
}
