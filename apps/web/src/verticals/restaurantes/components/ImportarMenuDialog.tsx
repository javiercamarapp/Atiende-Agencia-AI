// Importar menu (alta autoservicio): subir PDF, foto o CSV -> borrador que el dueño REVISA y corrige (nombre, categoria, precio,
// incluir o no) -> guardar. Todo es real: la lectura llama a POST .../admin/menu/importar/extraer (modelo barato con ZDR para PDF/foto,
// parser para CSV; no escribe nada) y el guardado a .../guardar (categorias + productos + precio en ESTA sucursal, sin duplicar).
// Nada se guarda sin precio: las filas con duda «Sin precio» quedan sin marcar hasta que el dueño escribe uno.
import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button, Callout, Checkbox, DataTable, FormDialog, Input, Label, StatusBadge } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { aBase64, ARCHIVO_MENU_MAX_BYTES, ETIQUETA_DUDA, extraerMenu, guardarMenu } from "../lib/menu-importar-client.ts";
import type { BorradorMenu, DudaImportacion, ResultadoImportacionMenu } from "../lib/menu-importar-client.ts";

export interface ImportarMenuDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly fetchImpl?: typeof fetch;
  /** Al guardar: la pagina recarga su catalogo. */
  readonly onTerminado: () => void;
}

interface Fila {
  readonly id: number;
  nombre: string;
  categoria: string;
  descripcion: string | null;
  precio: string;
  incluir: boolean;
  readonly dudas: readonly DudaImportacion[];
}

function filasDe(b: BorradorMenu): Fila[] {
  return b.productos.map((p, i) => ({
    id: i,
    nombre: p.nombre,
    categoria: p.categoria,
    descripcion: p.descripcion,
    precio: p.precio === null ? "" : String(p.precio),
    incluir: p.precio !== null && !p.dudas.includes("duplicado"),
    dudas: p.dudas,
  }));
}

function precioValido(t: string): number | null {
  const n = Number(t.replace(/[$,\s]/g, ""));
  return t.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? Math.round(n * 100) / 100 : null;
}

export function ImportarMenuDialog({ open, onOpenChange, apiBaseUrl, token, propertyId, fetchImpl = fetch, onTerminado }: ImportarMenuDialogProps) {
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ResultadoImportacionMenu | null>(null);
  const [trabajando, setTrabajando] = useState<"leyendo" | "guardando" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function reiniciar() {
    setFilas(null);
    setAviso(null);
    setResultado(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function elegirArchivo(f: File | undefined) {
    if (!f) return;
    setError(null);
    if (f.size > ARCHIVO_MENU_MAX_BYTES) {
      setError("El archivo pesa más de 3 MB: sube una foto más ligera o un PDF con menos páginas.");
      return;
    }
    setTrabajando("leyendo");
    try {
      const esCsv = /\.(csv|tsv|txt)$/i.test(f.name) || f.type === "text/csv";
      const entrada = esCsv ? { csv: await f.text() } : { archivo: { nombre: f.name, base64: aBase64(new Uint8Array(await f.arrayBuffer())) } };
      const { borrador } = await extraerMenu(fetchImpl, apiBaseUrl, token, propertyId, entrada);
      setFilas(filasDe(borrador));
      const partes: string[] = [];
      if (borrador.ilegibles > 0) partes.push(`${borrador.ilegibles} renglones no se pudieron leer`);
      if (borrador.recortado) partes.push("el menú tiene más de 300 productos: se muestran los primeros 300");
      setAviso(partes.length > 0 ? `Ojo: ${partes.join("; ")}.` : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pudimos leer el archivo.");
    } finally {
      setTrabajando(null);
    }
  }

  function cambiar(id: number, cambios: Partial<Fila>) {
    setFilas((prev) => (prev ? prev.map((f) => (f.id === id ? { ...f, ...cambios } : f)) : prev));
  }

  const columnas: readonly DataTableColumna<Fila>[] = [
    { id: "incluir", encabezado: "Guardar", celda: (f) => <Checkbox checked={f.incluir} onChange={(e) => cambiar(f.id, { incluir: e.target.checked })} aria-label={`Guardar ${f.nombre}`} /> },
    {
      id: "nombre",
      encabezado: "Producto",
      principal: true,
      celda: (f) => (
        <div className="flex flex-col gap-1">
          <Input value={f.nombre} onChange={(e) => cambiar(f.id, { nombre: e.target.value })} aria-label="Producto" maxLength={160} />
          {f.descripcion && <span className="text-xs text-muted-foreground">{f.descripcion}</span>}
        </div>
      ),
    },
    { id: "categoria", encabezado: "Categoría", celda: (f) => <Input value={f.categoria} onChange={(e) => cambiar(f.id, { categoria: e.target.value })} aria-label="Categoría" maxLength={120} /> },
    { id: "precio", encabezado: "Precio", className: "w-28", celda: (f) => <Input value={f.precio} inputMode="decimal" onChange={(e) => cambiar(f.id, { precio: e.target.value })} aria-label={`Precio de ${f.nombre}`} /> },
    {
      id: "dudas",
      encabezado: "Revisar",
      celda: (f) => (
        <div className="flex flex-wrap gap-1">
          {f.dudas.map((d) => (
            <StatusBadge key={d} tone={d === "sin_precio" ? "warning" : "neutral"}>
              {ETIQUETA_DUDA[d]}
            </StatusBadge>
          ))}
        </div>
      ),
    },
  ];

  const marcadas = (filas ?? []).filter((f) => f.incluir);
  const invalidas = marcadas.filter((f) => precioValido(f.precio) === null || f.nombre.trim().length < 2);

  async function guardar() {
    if (marcadas.length === 0 || invalidas.length > 0) return;
    setTrabajando("guardando");
    setError(null);
    try {
      const r = await guardarMenu(
        fetchImpl,
        apiBaseUrl,
        token,
        propertyId,
        marcadas.map((f) => ({ nombre: f.nombre.trim(), categoria: f.categoria.trim(), descripcion: f.descripcion, precio: precioValido(f.precio)! })),
      );
      setResultado(r);
      onTerminado();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el menú.");
    } finally {
      setTrabajando(null);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !trabajando) reiniciar();
        onOpenChange(o);
      }}
      titulo="Importar menú"
      subtitulo="Sube tu menú en PDF, foto o CSV. Lo leemos, revisas cada producto y precio, y solo entonces se guarda en esta sucursal."
      anchoClase="max-w-5xl"
      bloquearCierre={trabajando !== null}
      footer={
        resultado ? (
          <Button type="button" className="rounded-full px-6" onClick={() => onOpenChange(false)}>
            Cerrar
          </Button>
        ) : (
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => onOpenChange(false)} disabled={trabajando !== null}>
              Cancelar
            </Button>
            <Button type="button" className="rounded-full px-6" onClick={() => void guardar()} disabled={!filas || marcadas.length === 0 || invalidas.length > 0 || trabajando !== null} loading={trabajando === "guardando"}>
              <Upload />
              {`Guardar ${marcadas.length} ${marcadas.length === 1 ? "producto" : "productos"}`}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {!filas && !resultado && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="menu-import-archivo">Archivo (PDF, JPG, PNG, WebP o CSV; hasta 3 MB)</Label>
            <input
              id="menu-import-archivo"
              ref={inputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp,.csv,.tsv,.txt,application/pdf,image/*,text/csv"
              className="block w-full text-sm text-foreground file:mr-3 file:rounded-full file:border file:border-border file:bg-canvas file:px-3 file:py-1.5 file:text-xs file:font-medium"
              onChange={(e) => void elegirArchivo(e.target.files?.[0])}
              disabled={trabajando !== null}
            />
            <p className="m-0 text-xs text-muted-foreground">CSV: encabezado con al menos «nombre» y «precio» (opcionales: categoria, descripcion, paquete, incluye).</p>
            {trabajando === "leyendo" && <p className="m-0 text-xs text-muted-foreground">Leyendo tu menú… puede tardar hasta 20 segundos.</p>}
          </div>
        )}

        {error && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {error}
          </p>
        )}
        {aviso && <Callout tone="warning">{aviso}</Callout>}

        {filas && !resultado && (
          <div className="flex flex-col gap-2" data-testid="menu-revision">
            <p className="m-0 text-sm text-foreground">
              {filas.length} productos leídos · {marcadas.length} marcados para guardar
              {invalidas.length > 0 ? ` · ${invalidas.length} marcados sin precio o nombre válido` : ""}. Revisa los precios contra tu menú: los que no pudimos leer
              quedan vacíos y sin marcar.
            </p>
            <DataTable etiqueta="Productos leídos del menú" columnas={columnas} filas={filas} obtenerId={(f) => String(f.id)} paginacion={{ tamano: 25 }} vista="tabla" />
          </div>
        )}

        {resultado && (
          <div className="flex flex-col gap-2" data-testid="menu-resultado">
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Productos nuevos (a la venta en esta sucursal)</dt>
              <dd className="m-0 font-semibold text-foreground">{resultado.creados}</dd>
              <dt className="text-muted-foreground">Omitidos (ya existían)</dt>
              <dd className="m-0 text-foreground">{resultado.omitidos}</dd>
              <dt className="text-muted-foreground">Categorías nuevas</dt>
              <dd className="m-0 text-foreground">{resultado.categoriasCreadas}</dd>
            </dl>
          </div>
        )}
      </div>
    </FormDialog>
  );
}
