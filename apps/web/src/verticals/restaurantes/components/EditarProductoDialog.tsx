// Editar un producto del catálogo desde el panel (import-orig-14): nombre, descripción, precio base, categoría, alias o palabras
// clave y si se vende en ESTA sucursal. «Desactivar» no borra nada: apaga el producto en la sucursal (branch_products, lo que
// consulta el agente) y conserva su descripción y sus alias para cuando se vuelva a encender.
import { useEffect, useState } from "react";
import { Button, Callout, FormDialog, FormField, Input, Selector, Switch, Textarea } from "@atiende/ui";
import { AliasChips } from "./AliasChips.tsx";
import { setBranchAvailability, updateProduct } from "../lib/catalog-client.ts";
import type { Category, Product } from "../lib/catalog-client.ts";

export interface EditarProductoDialogProps {
  /** `null` = cerrado. */
  readonly producto: Product | null;
  readonly categorias: readonly Category[];
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly onCerrar: () => void;
  /** Se llamó al guardar: el padre recarga el catálogo. También tras un guardado parcial (para no mostrar datos viejos). */
  readonly onGuardado: () => void | Promise<void>;
}

function mismosAlias(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function EditarProductoDialog({ producto, categorias, apiBaseUrl, token, propertyId, onCerrar, onGuardado }: EditarProductoDialogProps) {
  const [nombre, setNombre] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [precio, setPrecio] = useState("");
  const [categoriaId, setCategoriaId] = useState("");
  const [alias, setAlias] = useState<readonly string[]>([]);
  const [seVende, setSeVende] = useState(false);
  // «Dejar de venderlo»: apagado definitivo de un producto agotado «solo por hoy» (cancela su reposición automática).
  const [dejarDeVender, setDejarDeVender] = useState(false);
  const [borradorAlias, setBorradorAlias] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const [errores, setErrores] = useState<{ nombre?: string; precio?: string }>({});

  // Cada apertura parte de los datos reales del producto (el componente queda montado entre usos).
  useEffect(() => {
    if (!producto) return;
    setNombre(producto.name);
    setDescripcion(producto.description ?? "");
    setPrecio(String(producto.price));
    setCategoriaId(producto.categoryId ?? "");
    setAlias(producto.searchKeywords);
    setSeVende(producto.branch?.isAvailable ?? false);
    setDejarDeVender(false);
    setBorradorAlias("");
    setErrorGeneral(null);
    setErrores({});
    setGuardando(false);
  }, [producto]);

  const agotadoHasta = producto?.branch?.agotadoHasta ?? null;

  async function guardar() {
    if (!producto) return;
    const precioNum = Number(precio);
    const faltantes = {
      nombre: nombre.trim() ? undefined : "Escribe el nombre del producto.",
      precio: precio.trim() !== "" && Number.isFinite(precioNum) && precioNum >= 0 ? undefined : "Escribe un precio base válido (0 o más).",
    };
    setErrores(faltantes);
    if (faltantes.nombre || faltantes.precio) return;
    if (borradorAlias.trim() !== "") {
      setErrorGeneral(`Tienes un alias sin agregar («${borradorAlias.trim()}»): presiona Enter para agregarlo o bórralo.`);
      return;
    }

    // Solo viaja lo que cambió: un guardado sin cambios no escribe nada ni ensucia la bitácora.
    const patch: Parameters<typeof updateProduct>[5] = {};
    if (nombre.trim() !== producto.name) patch.name = nombre.trim();
    if (precioNum !== producto.price) patch.price = precioNum;
    const descNueva = descripcion.trim() === "" ? null : descripcion.trim();
    if (descNueva !== (producto.description ?? null)) patch.description = descNueva;
    if ((categoriaId || null) !== producto.categoryId) patch.categoryId = categoriaId || null;
    if (!mismosAlias(alias, producto.searchKeywords)) patch.searchKeywords = alias;
    // Un producto agotado «solo por hoy» ya está apagado: sin «Dejar de venderlo» no hay nada que mandar y el cron lo repondría.
    const apagarDefinitivo = dejarDeVender && !seVende;
    const cambiaSucursal = seVende !== (producto.branch?.isAvailable ?? false) || apagarDefinitivo;

    if (Object.keys(patch).length === 0 && !cambiaSucursal) {
      onCerrar();
      return;
    }
    setGuardando(true);
    setErrorGeneral(null);
    let guardoCatalogo = false;
    try {
      if (Object.keys(patch).length > 0) {
        await updateProduct(fetch, apiBaseUrl, token, propertyId, producto.id, patch);
        guardoCatalogo = true;
      }
      if (cambiaSucursal) await setBranchAvailability(fetch, apiBaseUrl, token, propertyId, producto.id, { isAvailable: seVende });
      await onGuardado();
      onCerrar();
    } catch (err) {
      const base = err instanceof Error ? err.message : "No se pudo guardar el producto.";
      setErrorGeneral(guardoCatalogo && cambiaSucursal ? `Se guardaron los datos del producto, pero no se pudo cambiar su disponibilidad en esta sucursal: ${base}` : base);
      // Si ya se escribió algo, el catálogo de fondo debe reflejarlo aunque el diálogo siga abierto.
      if (guardoCatalogo) await onGuardado();
    } finally {
      setGuardando(false);
    }
  }

  return (
    <FormDialog
      open={producto !== null}
      onOpenChange={(abierto) => {
        if (!abierto) onCerrar();
      }}
      titulo={producto ? `Editar ${producto.name}` : "Editar producto"}
      subtitulo="Nombre, descripción, categoría, alias y disponibilidad llegan al agente en cuanto guardas. El precio base no cambia el de los pedidos ya hechos ni el de cada sucursal."
      anchoClase="max-w-2xl"
      onGuardar={() => void guardar()}
      guardando={guardando}
      textoBotonGuardar="Guardar cambios"
      bloquearCierre={guardando}
    >
      <div className="grid gap-3">
        {errorGeneral && <Callout tone="danger">{errorGeneral}</Callout>}
        <FormField label="Nombre" required error={errores.nombre}>
          <Input value={nombre} onChange={(e) => setNombre(e.target.value)} disabled={guardando} />
        </FormField>
        <FormField label="Descripción" hint="Qué lleva o cómo se sirve. El agente también busca aquí.">
          <Textarea rows={3} value={descripcion} onChange={(e) => setDescripcion(e.target.value)} disabled={guardando} />
        </FormField>
        <FormField label="Precio base" required error={errores.precio} hint="El precio en cada sucursal se cambia en la tabla del catálogo.">
          <Input type="number" min={0} step="0.01" value={precio} onChange={(e) => setPrecio(e.target.value)} disabled={guardando} />
        </FormField>
        <FormField label="Categoría">
          <Selector value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)} disabled={guardando}>
            <option value="">Sin categoría</option>
            {categorias.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Selector>
        </FormField>
        <AliasChips alias={alias} onChange={setAlias} disabled={guardando} onBorradorChange={setBorradorAlias} />
        {agotadoHasta && (
          <Callout tone="warning">
            <div className="grid gap-2">
              <p>
                {dejarDeVender
                  ? "Se dejará de vender: no volverá solo a la venta. Guarda para aplicarlo."
                  : `Agotado hasta el ${agotadoHasta}: vuelve a la venta solo.`}
              </p>
              {!dejarDeVender && !seVende && (
                <div>
                  <Button type="button" size="sm" variant="outline" disabled={guardando} onClick={() => setDejarDeVender(true)}>
                    Dejar de venderlo
                  </Button>
                </div>
              )}
            </div>
          </Callout>
        )}
        <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
          <div className="grid gap-0.5">
            <label htmlFor="producto-se-vende" className="text-sm font-medium text-foreground">
              Se vende en esta sucursal
            </label>
            <p className="text-xs text-muted-foreground">Apagado, el agente deja de ofrecerlo. No se borra: conserva su descripción y sus alias.</p>
          </div>
          <Switch
            id="producto-se-vende"
            checked={seVende}
            onCheckedChange={(v) => {
              setSeVende(v);
              if (v) setDejarDeVender(false);
            }}
            disabled={guardando}
          />
        </div>
      </div>
    </FormDialog>
  );
}
