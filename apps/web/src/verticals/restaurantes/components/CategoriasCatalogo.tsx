// Renglón de categorías del catálogo (import-orig-14): renombrar y reordenar con `updateCategory`. El orden es el que ve el
// cliente en el menú (display_order). Quien no edita el catálogo (staff) ve las categorías como fichas, sin controles.
import { useEffect, useState } from "react";
import { Button, Callout, FormDialog, FormField, Input, StatusBadge, useT } from "@atiende/ui";
import { restaurantesProductos } from "@atiende/ui/i18n/restaurantes/productos";
import { ArrowDown, ArrowUp, Pencil } from "lucide-react";
import { updateCategory } from "../lib/catalog-client.ts";
import type { Category } from "../lib/catalog-client.ts";

export interface CategoriasCatalogoProps {
  readonly categorias: readonly Category[];
  readonly puedeEditar: boolean;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Recarga el catálogo; también se llama tras un reordenamiento a medias para no mostrar un orden falso. */
  readonly onCambio: () => void | Promise<void>;
}

export function CategoriasCatalogo({ categorias, puedeEditar, apiBaseUrl, token, propertyId, onCambio }: CategoriasCatalogoProps) {
  const t = useT(restaurantesProductos);
  const [ocupadaId, setOcupadaId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<Category | null>(null);
  const [nombre, setNombre] = useState("");
  const [errorNombre, setErrorNombre] = useState<string | undefined>(undefined);
  const [errorDialogo, setErrorDialogo] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (!editando) return;
    setNombre(editando.name);
    setErrorNombre(undefined);
    setErrorDialogo(null);
  }, [editando]);

  if (!puedeEditar) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {categorias.map((c) => (
          <StatusBadge key={c.id} tone="neutral" dot={false}>
            {c.name}
          </StatusBadge>
        ))}
      </div>
    );
  }

  async function renombrar() {
    if (!editando) return;
    const limpio = nombre.trim();
    if (!limpio) {
      setErrorNombre(t("restaurantes.productos.error.nombreCategoria"));
      return;
    }
    if (limpio === editando.name) {
      setEditando(null);
      return;
    }
    setGuardando(true);
    setErrorDialogo(null);
    try {
      await updateCategory(fetch, apiBaseUrl, token, propertyId, editando.id, { name: limpio });
      setEditando(null);
      await onCambio();
    } catch (err) {
      setErrorDialogo(err instanceof Error ? err.message : t("restaurantes.productos.cat.errorRenombrar"));
    } finally {
      setGuardando(false);
    }
  }

  // El orden se guarda como display_order = posición. Solo se escriben las categorías cuyo número cambia (puede haber varias con el
  // mismo 0 heredado del alta), una por una: si una falla se recarga para mostrar el orden real que quedó.
  async function mover(indice: number, hacia: -1 | 1) {
    const destino = indice + hacia;
    if (destino < 0 || destino >= categorias.length) return;
    const nuevoOrden = [...categorias];
    const [movida] = nuevoOrden.splice(indice, 1);
    nuevoOrden.splice(destino, 0, movida!);
    setOcupadaId(movida!.id);
    setError(null);
    try {
      for (const [pos, c] of nuevoOrden.entries()) {
        if (c.displayOrder !== pos) await updateCategory(fetch, apiBaseUrl, token, propertyId, c.id, { displayOrder: pos });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.productos.cat.errorReordenar"));
    } finally {
      await onCambio();
      setOcupadaId(null);
    }
  }

  return (
    <>
      {error && <Callout tone="danger">{error}</Callout>}
      <ul className="grid gap-1" aria-label={t("restaurantes.productos.cat.orden")}>
        {categorias.map((c, i) => (
          <li key={c.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5">
            <span className="text-sm font-medium text-foreground">{c.name}</span>
            <span className="flex items-center gap-0.5">
              <Button type="button" size="icon-sm" variant="ghost" aria-label={t("restaurantes.productos.cat.subir", { nombre: c.name })} disabled={ocupadaId !== null || i === 0} onClick={() => void mover(i, -1)}>
                <ArrowUp className="h-4 w-4" strokeWidth={1.75} />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t("restaurantes.productos.cat.bajar", { nombre: c.name })}
                disabled={ocupadaId !== null || i === categorias.length - 1}
                onClick={() => void mover(i, 1)}
              >
                <ArrowDown className="h-4 w-4" strokeWidth={1.75} />
              </Button>
              <Button type="button" size="icon-sm" variant="ghost" aria-label={t("restaurantes.productos.cat.renombrarAria", { nombre: c.name })} disabled={ocupadaId !== null} onClick={() => setEditando(c)}>
                <Pencil className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            </span>
          </li>
        ))}
      </ul>

      <FormDialog
        open={editando !== null}
        onOpenChange={(abierto) => {
          if (!abierto) setEditando(null);
        }}
        titulo={t("restaurantes.productos.cat.renombrar")}
        subtitulo={t("restaurantes.productos.cat.renombrarSub")}
        anchoClase="max-w-2xl"
        onGuardar={() => void renombrar()}
        guardando={guardando}
        textoBotonGuardar={t("restaurantes.productos.cat.guardarNombre")}
        bloquearCierre={guardando}
      >
        <div className="grid gap-3">
          {errorDialogo && <Callout tone="danger">{errorDialogo}</Callout>}
          <FormField label={t("restaurantes.productos.nombre")} required error={errorNombre}>

            <Input value={nombre} onChange={(e) => setNombre(e.target.value)} disabled={guardando} />
          </FormField>
        </div>
      </FormDialog>
    </>
  );
}
