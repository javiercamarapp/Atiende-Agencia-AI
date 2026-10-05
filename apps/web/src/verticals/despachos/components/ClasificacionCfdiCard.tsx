// D-P3-13 -- clasificacion contable de UN CFDI: lo que el sistema decidio (categoria, confianza, de donde salio y por que), el historial (cada correccion
// es una fila nueva) y, para admin/contador, la correccion con "recordar para este emisor". Sin LLM. Contra la base sin migrar dice la verdad en vez de inventar una categoria.
import { useEffect, useState } from "react";
import { Check, Tags } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, Checkbox, DataTable, EstadoCargando, Input, Label, NativeSelect, StatusBadge, notify } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { corregirCategoriaCfdi, ETIQUETA_METODO_CLASIFICACION, fetchCatalogoClasificacion, formatConfianza } from "../lib/clasificacion-client.ts";
import type { CatalogoClasificacion, ClasificacionVista } from "../lib/clasificacion-client.ts";
import type { InvoiceSummary } from "../lib/cfdi-client.ts";
import { formatDate } from "../lib/format.ts";

// Espejo cosmetico de BOOKKEEPING_ROLES (el servidor decide).
const CORREGIR_ROLES = new Set(["admin", "contador"]);

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly role: string;
  readonly invoice: InvoiceSummary;
  /** Despues de guardar: la pagina vuelve a pedir el CFDI (clasificacion e historial nuevos). */
  readonly onCambio: () => void | Promise<void>;
}

function tonoConfianza(c: ClasificacionVista): "success" | "warning" | "danger" {
  if (c.empate) return "danger";
  if (c.porPersona) return "success";
  return (c.confianza ?? 0) >= 0.7 ? "success" : "warning";
}

export function ClasificacionCfdiCard({ apiBaseUrl, token, propertyId, role, invoice, onCambio }: Props) {
  const puedeCorregir = CORREGIR_ROLES.has(role);
  const [catalogo, setCatalogo] = useState<CatalogoClasificacion | null>(null);
  const [catalogoError, setCatalogoError] = useState<string | null>(null);
  const [categoria, setCategoria] = useState("");
  const [cuenta, setCuenta] = useState("");
  const [recordar, setRecordar] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!puedeCorregir || invoice.clasificacionEstado === "no_disponible") return;
    let cancelado = false;
    fetchCatalogoClasificacion(fetch, apiBaseUrl, token, propertyId).then(
      (c) => {
        if (!cancelado) setCatalogo(c);
      },
      (err: unknown) => {
        if (!cancelado) setCatalogoError(err instanceof Error ? err.message : "No se pudo cargar el catálogo de categorías.");
      },
    );
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, puedeCorregir, invoice.clasificacionEstado]);

  const actual = invoice.clasificacion ?? null;
  const historial = invoice.clasificacionHistorial ?? [];

  async function guardar() {
    if (categoria === "") return;
    setGuardando(true);
    setError(null);
    try {
      await corregirCategoriaCfdi(fetch, apiBaseUrl, token, propertyId, invoice.id, { categoria, cuenta: cuenta.trim() || null, guardarRegla: recordar });
      notify.success(recordar ? "Categoría guardada. Los siguientes CFDI de este emisor la usarán." : "Categoría guardada.");
      setCategoria("");
      setCuenta("");
      setRecordar(false);
      await onCambio();
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : "No se pudo guardar la categoría.";
      setError(mensaje);
    } finally {
      setGuardando(false);
    }
  }

  const columnas: DataTableColumna<ClasificacionVista & { clave: string }>[] = [
    { id: "fecha", encabezado: "Fecha", principal: true, valorOrden: (c) => c.creadaEn, celda: (c) => formatDate(c.creadaEn) },
    { id: "categoria", encabezado: "Categoría", celda: (c) => c.nombre },
    { id: "confianza", encabezado: "Confianza", alinear: "right", valorOrden: (c) => c.confianza, celda: (c) => <span className="tabular-nums">{formatConfianza(c.confianza)}</span> },
    { id: "origen", encabezado: "Origen", celda: (c) => <span className="text-muted-foreground">{c.porPersona ? "Persona" : "Sistema"} · {ETIQUETA_METODO_CLASIFICACION[c.metodo] ?? c.metodo}</span> },
  ];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 pb-3">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Tags className="h-4 w-4" strokeWidth={1.75} />
          Clasificación contable
        </CardTitle>
        {actual && <StatusBadge tone={tonoConfianza(actual)}>{actual.empate ? "Empate: revisar" : formatConfianza(actual.confianza)}</StatusBadge>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {invoice.clasificacionEstado === "no_disponible" && (
          <p role="status" className="text-sm text-muted-foreground">
            La clasificación contable aún no está disponible en este ambiente: falta aplicar la migración 026 (hasta entonces la categoría de arriba es la de siempre).
          </p>
        )}
        {invoice.clasificacionEstado !== "no_disponible" && !actual && (
          <p role="status" className="text-sm text-muted-foreground">
            Este comprobante no se clasifica solo (nota de crédito, traslado o pago) o se ingirió antes de la clasificación automática. {puedeCorregir ? "Puedes indicar su categoría abajo." : ""}
          </p>
        )}
        {actual && (
          <div className="flex flex-col gap-1 text-sm">
            <p className="text-foreground">
              <span className="font-medium">{actual.nombre}</span>
              {actual.cuenta ? <span className="text-muted-foreground"> · cuenta {actual.cuenta}</span> : null}
            </p>
            <p className="text-xs text-muted-foreground">
              {actual.porPersona ? "Indicada por una persona" : "Decidida por el sistema"} · {ETIQUETA_METODO_CLASIFICACION[actual.metodo] ?? actual.metodo}
              {actual.razon ? ` · ${actual.razon}` : ""}
            </p>
            {actual.empate && <p className="text-xs text-destructive">Dos categorías tienen la misma evidencia: el sistema nunca elige una por su cuenta, por eso este CFDI está en la cola de revisión.</p>}
          </div>
        )}

        {puedeCorregir && invoice.clasificacionEstado !== "no_disponible" && (
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            {catalogoError && (
              <p role="alert" className="text-sm text-destructive">
                {catalogoError}
              </p>
            )}
            {!catalogo && !catalogoError && <EstadoCargando etiqueta="Cargando categorías…" lineas={1} />}
            {catalogo && (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="clasif-categoria" className="text-xs text-muted-foreground">
                      Nueva categoría
                    </Label>
                    <NativeSelect id="clasif-categoria" size="sm" value={categoria} onChange={(e) => setCategoria(e.target.value)} wrapperClassName="w-64">
                      <option value="">Elige una categoría…</option>
                      {catalogo.categorias.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.nombre}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="clasif-cuenta" className="text-xs text-muted-foreground">
                      Cuenta de cargo (opcional)
                    </Label>
                    <Input id="clasif-cuenta" type="text" inputMode="numeric" placeholder="6020300" value={cuenta} onChange={(e) => setCuenta(e.target.value)} className="h-9 w-36 text-xs" />
                  </div>
                  <Button type="button" size="sm" onClick={() => void guardar()} disabled={guardando || categoria === ""} loading={guardando} loadingText="Guardando…">
                    <Check />
                    Guardar categoría
                  </Button>
                </div>
                <Checkbox checked={recordar} onChange={(e) => setRecordar(e.target.checked)} label="Recordar para este emisor (los siguientes CFDI de este RFC saldrán con esta categoría)" />
              </>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        )}
        {!puedeCorregir && <p className="text-xs text-muted-foreground">Tu rol no puede corregir la categoría (solo admin/contador).</p>}

        {historial.length > 1 && (
          <div className="border-t border-border pt-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Historial</h3>
            <DataTable etiqueta="Historial de clasificación del CFDI" columnas={columnas} filas={historial.map((h, i) => ({ ...h, clave: `${h.creadaEn}-${i}` }))} obtenerId={(h) => h.clave} paginacion={false} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
