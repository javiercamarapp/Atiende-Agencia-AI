// Productos/Categorías (Fase 5) — CRUD real: alta/edición de categoría y producto,
// y activar/desactivar+precio de un producto EN esta sucursal (branch_products, la
// fuente real de precio/disponibilidad que ya consulta el flujo de pedido/agente —
// ver admin-catalog.ts).
//
// Presentación real desde esta ronda: los `style={{...}}` inline de antes pasan a los
// primitivos de `@atiende/ui` — `Card`/`CardHeader`/`CardContent` para los dos
// formularios de alta (UNI-C: ahora `FormDialog`/`FormField` abiertos desde los CTA de cabecera), `Input`/`NativeSelect` para sus campos,
// `Checkbox` para las marcas, `Button` para enviar, `Badge` para las
// categorías existentes y para el estado "Disponible / No disponible", y `Table` para
// el catálogo. TODO el CRUD/estado de abajo es el MISMO: solo cambia el JSX.
import { useEffect, useState } from "react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  DataTable,
  EstadoError,
  FormDialog,
  FormField,
  Input,
  NativeSelect,
  PageContainer,
  Textarea,
  formatMoney,
  notify,
} from "@atiende/ui";
import { FolderPlus, Pencil, Plus } from "lucide-react";
import {
  createCategory,
  createProduct,
  fetchCategories,
  fetchProducts,
  setBranchAvailability,
  updateProduct,
} from "../lib/catalog-client.ts";
import type { Category, Product } from "../lib/catalog-client.ts";
import { AliasChips } from "../components/AliasChips.tsx";
import { CategoriasCatalogo } from "../components/CategoriasCatalogo.tsx";
import { EditarProductoDialog } from "../components/EditarProductoDialog.tsx";
import { marcarAgotadoHastaManana } from "../lib/autopiloto-client.ts";
import { fetchNoDomicilio, setNoDomicilio } from "../lib/modelo-pm-client.ts";
import type { NoDomicilioMarks } from "../lib/modelo-pm-client.ts";
import { puedeEn } from "../lib/permisos.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

export function ProductosPage({ apiBaseUrl, token, propertyId, role }: RestaurantesShellContext) {
  // PL-23: el staff (cajero/cocina) ve el menu y marca agotado/disponible; precios y alta/edicion del catalogo son de owner/admin.
  const puedeEditarCatalogo = puedeEn(role, "catalogo.precio");
  const [categories, setCategories] = useState<readonly Category[] | null>(null);
  const [products, setProducts] = useState<readonly Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  // Marcas "no se vende a domicilio" (modelo PM, migración 023). `null` = no disponibles (base sin
  // migrar o sin permiso): la UI oculta esos controles en vez de mostrar un estado falso.
  const [marks, setMarks] = useState<NoDomicilioMarks | null>(null);

  const [newCatName, setNewCatName] = useState("");
  const [newCatSlug, setNewCatSlug] = useState("");
  const [creatingCategory, setCreatingCategory] = useState(false);
  // Alta de categoría y de producto: FormDialog abierto desde el CTA de cabecera. El error del servidor se pinta DENTRO del diálogo
  // (el global `error` quedaría tapado por el modal); los campos vacíos se marcan en su FormField.
  const [dialogoCategoria, setDialogoCategoria] = useState(false);
  const [errorCategoria, setErrorCategoria] = useState<string | null>(null);
  const [erroresCategoria, setErroresCategoria] = useState<{ nombre?: string; slug?: string }>({});

  const [newProdName, setNewProdName] = useState("");
  const [newProdPrice, setNewProdPrice] = useState("");
  const [newProdCategoryId, setNewProdCategoryId] = useState("");
  const [newProdDescription, setNewProdDescription] = useState("");
  const [newProdAlias, setNewProdAlias] = useState<readonly string[]>([]);
  // Producto abierto en el diálogo de edición (nombre, descripción, categoría, alias, disponibilidad).
  const [productoEditando, setProductoEditando] = useState<Product | null>(null);
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [dialogoProducto, setDialogoProducto] = useState(false);
  const [errorProducto, setErrorProducto] = useState<string | null>(null);
  const [erroresProducto, setErroresProducto] = useState<{ nombre?: string; precio?: string }>({});

  async function load() {
    setError(null);
    try {
      const [cats, prods] = await Promise.all([fetchCategories(fetch, apiBaseUrl, token, propertyId), fetchProducts(fetch, apiBaseUrl, token, propertyId)]);
      setCategories(cats);
      setProducts(prods);
      setMarks(await fetchNoDomicilio(fetch, apiBaseUrl, token, propertyId).catch(() => null));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el catálogo.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  function abrirCategoria() {
    setNewCatName("");
    setNewCatSlug("");
    setErrorCategoria(null);
    setErroresCategoria({});
    setDialogoCategoria(true);
  }

  async function handleCreateCategory() {
    const faltantes = {
      nombre: newCatName.trim() ? undefined : "Escribe el nombre de la categoría.",
      slug: newCatSlug.trim() ? undefined : "Escribe el slug de la categoría.",
    };
    setErroresCategoria(faltantes);
    if (faltantes.nombre || faltantes.slug) return;
    setCreatingCategory(true);
    setErrorCategoria(null);
    setError(null);
    try {
      await createCategory(fetch, apiBaseUrl, token, propertyId, { name: newCatName.trim(), slug: newCatSlug.trim() });
      setNewCatName("");
      setNewCatSlug("");
      setDialogoCategoria(false);
      await load();
    } catch (err) {
      setErrorCategoria(err instanceof Error ? err.message : "No se pudo crear la categoría.");
    } finally {
      setCreatingCategory(false);
    }
  }

  function abrirProducto() {
    setNewProdName("");
    setNewProdPrice("");
    setNewProdCategoryId("");
    setNewProdDescription("");
    setNewProdAlias([]);
    setErrorProducto(null);
    setErroresProducto({});
    setDialogoProducto(true);
  }

  async function handleCreateProduct() {
    const price = Number(newProdPrice);
    const faltantes = {
      nombre: newProdName.trim() ? undefined : "Escribe el nombre del producto.",
      precio: newProdPrice.trim() !== "" && Number.isFinite(price) && price >= 0 ? undefined : "Escribe un precio base válido (0 o más).",
    };
    setErroresProducto(faltantes);
    if (faltantes.nombre || faltantes.precio) return;
    setCreatingProduct(true);
    setErrorProducto(null);
    setError(null);
    try {
      await createProduct(fetch, apiBaseUrl, token, propertyId, {
        name: newProdName.trim(),
        price,
        categoryId: newProdCategoryId || null,
        ...(newProdDescription.trim() ? { description: newProdDescription.trim() } : {}),
        ...(newProdAlias.length > 0 ? { searchKeywords: newProdAlias } : {}),
      });
      setNewProdName("");
      setNewProdPrice("");
      setNewProdCategoryId("");
      setNewProdDescription("");
      setNewProdAlias([]);
      setDialogoProducto(false);
      await load();
    } catch (err) {
      setErrorProducto(err instanceof Error ? err.message : "No se pudo crear el producto.");
    } finally {
      setCreatingProduct(false);
    }
  }

  async function handleToggleAvailability(product: Product) {
    setSavingId(product.id);
    setError(null);
    try {
      const nextAvailable = !(product.branch?.isAvailable ?? false);
      // Solo `isAvailable`: el servidor conserva el precio de la sucursal (o el precio base al dar de alta) y un staff no puede mandar precio.
      await setBranchAvailability(fetch, apiBaseUrl, token, propertyId, product.id, { isAvailable: nextAvailable });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar la disponibilidad.");
    } finally {
      setSavingId(null);
    }
  }

  // Autopiloto (migracion 050): "agotado solo por hoy". El servidor lo deja no disponible y lo repone al cambiar el dia de negocio de la sucursal
  // (zona horaria de la sucursal), con bitacora; el agente ya respeta `is_available`.
  async function handleAgotadoHastaManana(product: Product) {
    setSavingId(product.id);
    setError(null);
    try {
      const r = await marcarAgotadoHastaManana(fetch, apiBaseUrl, token, propertyId, product.id);
      notify.success(`${product.name} queda agotado y se repone solo el ${r.agotadoHasta}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo marcar el producto como agotado.");
    } finally {
      setSavingId(null);
    }
  }

  async function handlePriceChange(product: Product, rawPrice: string) {
    const price = Number(rawPrice);
    if (!Number.isFinite(price) || price < 0) return;
    setSavingId(product.id);
    setError(null);
    try {
      await setBranchAvailability(fetch, apiBaseUrl, token, propertyId, product.id, { price, isAvailable: product.branch?.isAvailable ?? true });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar el precio.");
    } finally {
      setSavingId(null);
    }
  }

  async function handleToggleNoDomicilio(kind: "productos" | "categorias", id: string, current: boolean) {
    setSavingId(id);
    setError(null);
    try {
      await setNoDomicilio(fetch, apiBaseUrl, token, propertyId, kind, id, !current);
      setMarks(await fetchNoDomicilio(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar la regla de domicilio.");
    } finally {
      setSavingId(null);
    }
  }

  async function handleTogglePopular(product: Product) {
    setSavingId(product.id);
    setError(null);
    try {
      await updateProduct(fetch, apiBaseUrl, token, propertyId, product.id, { isPopular: !product.isPopular });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar el producto.");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <PageContainer padding="none">
      <h1 className="sr-only">Productos y categorías</h1>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {puedeEditarCatalogo ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={abrirCategoria}>
            <FolderPlus />
            Nueva categoría
          </Button>
          <Button type="button" onClick={abrirProducto}>
            <Plus />
            Nuevo producto
          </Button>
        </div>
      ) : (
        <Callout tone="info">Puedes marcar productos como agotados o disponibles en esta sucursal. Solo el dueño o un administrador cambia precios y edita el catálogo.</Callout>
      )}

      {categories && (puedeEditarCatalogo || categories.length > 0) && (
        <Card>
          <CardHeader className="p-4 pb-3">
            <CardTitle>Categorías</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {categories.length === 0 ? (
              <p className="text-sm text-muted-foreground">Todavía no hay categorías. Crea la primera con «Nueva categoría».</p>
            ) : (
              <CategoriasCatalogo
                categorias={categories}
                puedeEditar={puedeEditarCatalogo}
                apiBaseUrl={apiBaseUrl}
                token={token}
                propertyId={propertyId}
                onCambio={load}
              />
            )}
            {marks && categories.length > 0 && (
              <fieldset className="mt-3 flex flex-col gap-1.5 border-0 p-0">
                <legend className="mb-1 p-0 text-xs text-muted-foreground">No se vende a domicilio (aplica a todos los productos de la categoría)</legend>
                <div className="flex flex-wrap gap-3">
                  {categories.map((c) => (
                    <Checkbox
                      key={c.id}
                      aria-label={`${c.name}: no se vende a domicilio`}
                      label={c.name}
                      wrapperClassName="text-xs"
                      checked={marks.categoryIds.includes(c.id)}
                      onChange={() => void handleToggleNoDomicilio("categorias", c.id, marks.categoryIds.includes(c.id))}
                      disabled={savingId === c.id || !puedeEditarCatalogo}
                      title={puedeEditarCatalogo ? undefined : "Solo el dueño o un administrador puede cambiar esta regla."}
                    />
                  ))}
                </div>
              </fieldset>
            )}
          </CardContent>
        </Card>
      )}

      {(products || !error) && (
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle>Catálogo</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DataTable<Product>
              etiqueta="catálogo de productos de esta sucursal"
              filas={products ?? []}
              obtenerId={(p) => p.id}
              estado={!products ? "loading" : products.length === 0 ? "empty" : "ok"}
              vacio={{ titulo: "Sin productos", mensaje: "Este negocio todavía no tiene productos en su catálogo." }}
              paginacion={{ tamano: 25 }}
              columnas={[
                { id: "producto", encabezado: "Producto", principal: true, celda: (p) => <span className="font-medium text-foreground">{p.name}</span>, valorOrden: (p) => p.name },
                { id: "categoria", encabezado: "Categoría", celda: (p) => <span className="text-muted-foreground">{p.categoryName ?? "—"}</span>, valorOrden: (p) => p.categoryName },
                {
                  id: "precio",
                  encabezado: "Precio en esta sucursal",
                  celda: (p) =>
                    puedeEditarCatalogo ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          aria-label={`Precio de ${p.name} en esta sucursal`}
                          defaultValue={p.branch?.price ?? p.price}
                          onBlur={(e) => void handlePriceChange(p, e.target.value)}
                          disabled={savingId === p.id}
                          className="w-[100px]"
                        />
                        {p.branch === null && <span className="text-xs text-muted-foreground">(precio base ${formatMoney(p.price)}, nunca dado de alta aquí)</span>}
                      </div>
                    ) : (
                      <span className="text-foreground">${formatMoney(p.branch?.price ?? p.price)}</span>
                    ),
                },
                {
                  id: "disponible",
                  encabezado: "Disponible aquí",
                  celda: (p) => (
                    <Button
                      type="button"
                      size="sm"
                      variant={p.branch?.isAvailable ? "default" : "outline"}
                      onClick={() => void handleToggleAvailability(p)}
                      disabled={savingId === p.id || (!puedeEditarCatalogo && p.branch === null)}
                      title={!puedeEditarCatalogo && p.branch === null ? "Un administrador debe activar este producto en la sucursal primero." : undefined}
                    >
                      {p.branch?.isAvailable ? "Disponible" : "No disponible"}
                    </Button>
                  ),
                },
                {
                  id: "agotado-hoy",
                  encabezado: "Agotado solo por hoy",
                  celda: (p) => (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={savingId === p.id || !p.branch?.isAvailable}
                      title={p.branch?.isAvailable ? "Se repone solo al cambiar el día de la sucursal" : "Ya no está disponible"}
                      onClick={() => void handleAgotadoHastaManana(p)}
                    >
                      Agotado hasta mañana
                    </Button>
                  ),
                },
                {
                  id: "popular",
                  encabezado: "Popular",
                  celda: (p) => <Checkbox aria-label={`Marcar ${p.name} como popular`} checked={p.isPopular} onChange={() => void handleTogglePopular(p)} disabled={savingId === p.id || !puedeEditarCatalogo} />,
                },
                ...(puedeEditarCatalogo
                  ? [
                      {
                        id: "editar",
                        encabezado: "Editar",
                        celda: (p: Product) => (
                          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Editar ${p.name}`} disabled={savingId === p.id} onClick={() => setProductoEditando(p)}>
                            <Pencil className="h-4 w-4" strokeWidth={1.75} />
                          </Button>
                        ),
                      },
                    ]
                  : []),
                ...(marks
                  ? [
                      {
                        id: "no-domicilio",
                        encabezado: "No a domicilio",
                        celda: (p: Product) => (
                          <Checkbox
                            aria-label={`${p.name}: no se vende a domicilio`}
                            checked={marks.productIds.includes(p.id)}
                            onChange={() => void handleToggleNoDomicilio("productos", p.id, marks.productIds.includes(p.id))}
                            disabled={savingId === p.id || !puedeEditarCatalogo}
                          />
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </CardContent>
        </Card>
      )}

      <FormDialog
        open={dialogoCategoria}
        onOpenChange={setDialogoCategoria}
        titulo="Nueva categoría"
        subtitulo="Agrupa productos del catálogo (ej. Postres)."
        anchoClase="max-w-2xl"
        onGuardar={() => void handleCreateCategory()}
        guardando={creatingCategory}
        textoBotonGuardar="Crear categoría"
        bloquearCierre={creatingCategory}
      >
        <div className="grid gap-3">
          {errorCategoria && <Callout tone="danger">{errorCategoria}</Callout>}
          <FormField label="Nombre" required error={erroresCategoria.nombre}>
            <Input placeholder="Nombre (ej. Postres)" value={newCatName} onChange={(e) => setNewCatName(e.target.value)} />
          </FormField>
          <FormField label="Slug" required error={erroresCategoria.slug} hint="Identificador corto en minúsculas, sin espacios (ej. postres).">
            <Input placeholder="slug (ej. postres)" value={newCatSlug} onChange={(e) => setNewCatSlug(e.target.value)} />
          </FormField>
        </div>
      </FormDialog>

      <FormDialog
        open={dialogoProducto}
        onOpenChange={setDialogoProducto}
        titulo="Nuevo producto"
        subtitulo="Un producto recién creado NO aparece en el pedido/agente hasta activarlo en la tabla, en esta sucursal."
        anchoClase="max-w-2xl"
        onGuardar={() => void handleCreateProduct()}
        guardando={creatingProduct}
        textoBotonGuardar="Crear producto"
        bloquearCierre={creatingProduct}
      >
        <div className="grid gap-3">
          {errorProducto && <Callout tone="danger">{errorProducto}</Callout>}
          <FormField label="Nombre" required error={erroresProducto.nombre}>
            <Input placeholder="Nombre" value={newProdName} onChange={(e) => setNewProdName(e.target.value)} />
          </FormField>
          <FormField label="Precio base" required error={erroresProducto.precio}>
            <Input placeholder="Precio base" type="number" min={0} step="0.01" value={newProdPrice} onChange={(e) => setNewProdPrice(e.target.value)} />
          </FormField>
          <FormField label="Descripción" hint="Qué lleva o cómo se sirve. El agente también busca aquí.">
            <Textarea rows={3} value={newProdDescription} onChange={(e) => setNewProdDescription(e.target.value)} />
          </FormField>
          <FormField label="Categoría">
            <NativeSelect value={newProdCategoryId} onChange={(e) => setNewProdCategoryId(e.target.value)}>
              <option value="">Sin categoría</option>
              {categories?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <AliasChips alias={newProdAlias} onChange={setNewProdAlias} disabled={creatingProduct} />
        </div>
      </FormDialog>

      <EditarProductoDialog
        producto={productoEditando}
        categorias={categories ?? []}
        apiBaseUrl={apiBaseUrl}
        token={token}
        propertyId={propertyId}
        onCerrar={() => setProductoEditando(null)}
        onGuardado={load}
      />
    </PageContainer>
  );
}
