// Productos/Categorías (Fase 5) — CRUD real: alta/edición de categoría y producto,
// y activar/desactivar+precio de un producto EN esta sucursal (branch_products, la
// fuente real de precio/disponibilidad que ya consulta el flujo de pedido/agente —
// ver admin-catalog.ts).
//
// Presentación real desde esta ronda: los `style={{...}}` inline de antes pasan a los
// primitivos de `@atiende/ui` — `Card`/`CardHeader`/`CardContent` para los dos
// formularios de alta, `Input`/`Label`/`NativeSelect` para sus campos, `Checkbox` para las marcas, `Button` para enviar, `Badge` para las
// categorías existentes y para el estado "Disponible / No disponible", y `Table` para
// el catálogo. TODO el CRUD/estado de abajo es el MISMO: solo cambia el JSX.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  NativeSelect,
  PageContainer,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  formatMoney,
  StatusBadge,
} from "@atiende/ui";
import { FolderPlus, Plus } from "lucide-react";
import {
  createCategory,
  createProduct,
  fetchCategories,
  fetchProducts,
  setBranchAvailability,
  updateProduct,
} from "../lib/catalog-client.ts";
import type { Category, Product } from "../lib/catalog-client.ts";
import { fetchNoDomicilio, setNoDomicilio } from "../lib/modelo-pm-client.ts";
import type { NoDomicilioMarks } from "../lib/modelo-pm-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

export function ProductosPage({ apiBaseUrl, token, propertyId }: RestaurantesShellContext) {
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

  const [newProdName, setNewProdName] = useState("");
  const [newProdPrice, setNewProdPrice] = useState("");
  const [newProdCategoryId, setNewProdCategoryId] = useState("");
  const [creatingProduct, setCreatingProduct] = useState(false);

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

  async function handleCreateCategory(e: FormEvent) {
    e.preventDefault();
    if (!newCatName.trim() || !newCatSlug.trim()) return;
    setCreatingCategory(true);
    setError(null);
    try {
      await createCategory(fetch, apiBaseUrl, token, propertyId, { name: newCatName.trim(), slug: newCatSlug.trim() });
      setNewCatName("");
      setNewCatSlug("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear la categoría.");
    } finally {
      setCreatingCategory(false);
    }
  }

  async function handleCreateProduct(e: FormEvent) {
    e.preventDefault();
    const price = Number(newProdPrice);
    if (!newProdName.trim() || !Number.isFinite(price) || price < 0) return;
    setCreatingProduct(true);
    setError(null);
    try {
      await createProduct(fetch, apiBaseUrl, token, propertyId, { name: newProdName.trim(), price, categoryId: newProdCategoryId || null });
      setNewProdName("");
      setNewProdPrice("");
      setNewProdCategoryId("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el producto.");
    } finally {
      setCreatingProduct(false);
    }
  }

  async function handleToggleAvailability(product: Product) {
    setSavingId(product.id);
    setError(null);
    try {
      const nextAvailable = !(product.branch?.isAvailable ?? false);
      const price = product.branch?.price ?? product.price;
      await setBranchAvailability(fetch, apiBaseUrl, token, propertyId, product.id, { price, isAvailable: nextAvailable });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar la disponibilidad.");
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

      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle>Nueva categoría</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <form onSubmit={handleCreateCategory} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="restaurantes-categoria-nombre" className="text-xs text-muted-foreground">
                Nombre
              </Label>
              <Input
                id="restaurantes-categoria-nombre"
                placeholder="Nombre (ej. Postres)"
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                className="w-auto min-w-[200px]"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="restaurantes-categoria-slug" className="text-xs text-muted-foreground">
                Slug
              </Label>
              <Input
                id="restaurantes-categoria-slug"
                placeholder="slug (ej. postres)"
                value={newCatSlug}
                onChange={(e) => setNewCatSlug(e.target.value)}
                className="w-auto min-w-[180px]"
              />
            </div>
            <Button type="submit" disabled={creatingCategory}>
              <FolderPlus />
              {creatingCategory ? "Creando…" : "Crear categoría"}
            </Button>
          </form>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {categories?.map((c) => (
              <StatusBadge key={c.id} tone="neutral" dot={false}>
                {c.name}
              </StatusBadge>
            ))}
          </div>
          {marks && categories && categories.length > 0 && (
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
                    disabled={savingId === c.id}
                  />
                ))}
              </div>
            </fieldset>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle>Nuevo producto</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <form onSubmit={handleCreateProduct} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="restaurantes-producto-nombre" className="text-xs text-muted-foreground">
                Nombre
              </Label>
              <Input
                id="restaurantes-producto-nombre"
                placeholder="Nombre"
                value={newProdName}
                onChange={(e) => setNewProdName(e.target.value)}
                className="w-auto min-w-[200px]"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="restaurantes-producto-precio" className="text-xs text-muted-foreground">
                Precio base
              </Label>
              <Input
                id="restaurantes-producto-precio"
                placeholder="Precio base"
                type="number"
                min={0}
                step="0.01"
                value={newProdPrice}
                onChange={(e) => setNewProdPrice(e.target.value)}
                className="w-[120px]"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="restaurantes-producto-categoria" className="text-xs text-muted-foreground">
                Categoría
              </Label>
              <NativeSelect
                id="restaurantes-producto-categoria"
                value={newProdCategoryId}
                onChange={(e) => setNewProdCategoryId(e.target.value)}
                wrapperClassName="w-auto min-w-44"
              >
                <option value="">Sin categoría</option>
                {categories?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button type="submit" disabled={creatingProduct}>
              <Plus />
              {creatingProduct ? "Creando…" : "Crear producto"}
            </Button>
          </form>
          <CardDescription className="mt-2 text-xs">
            Un producto recién creado NO aparece en el pedido/agente hasta activarlo abajo en esta sucursal.
          </CardDescription>
        </CardContent>
      </Card>

      {!products && !error && <EstadoCargando etiqueta="Cargando catálogo…" />}
      {products && products.length === 0 && <EstadoVacio mensaje="Este negocio todavía no tiene productos en su catálogo." />}

      {products && products.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableCaption className="sr-only">Catálogo de productos de esta sucursal</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Producto</TableHead>
                  <TableHead>Categoría</TableHead>
                  <TableHead>Precio en esta sucursal</TableHead>
                  <TableHead>Disponible aquí</TableHead>
                  <TableHead>Popular</TableHead>
                  {marks && <TableHead>No a domicilio</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium text-foreground">{p.name}</TableCell>
                    <TableCell className="text-muted-foreground">{p.categoryName ?? "—"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          aria-label={`Precio de ${p.name} en esta sucursal`}
                          defaultValue={p.branch?.price ?? p.price}
                          onBlur={(e) => void handlePriceChange(p, e.target.value)}
                          disabled={savingId === p.id}
                          className="h-9 w-[100px]"
                        />
                        {p.branch === null && (
                          <span className="text-xs text-muted-foreground">(precio base ${formatMoney(p.price)}, nunca dado de alta aquí)</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        size="sm"
                        variant={p.branch?.isAvailable ? "default" : "outline"}
                        className="h-9 text-xs"
                        onClick={() => void handleToggleAvailability(p)}
                        disabled={savingId === p.id}
                      >
                        {p.branch?.isAvailable ? "Disponible" : "No disponible"}
                      </Button>
                    </TableCell>
                    <TableCell>
                      <Checkbox
                        aria-label={`Marcar ${p.name} como popular`}
                        checked={p.isPopular}
                        onChange={() => void handleTogglePopular(p)}
                        disabled={savingId === p.id}
                      />
                    </TableCell>
                    {marks && (
                      <TableCell>
                        <Checkbox
                          aria-label={`${p.name}: no se vende a domicilio`}
                          checked={marks.productIds.includes(p.id)}
                          onChange={() => void handleToggleNoDomicilio("productos", p.id, marks.productIds.includes(p.id))}
                          disabled={savingId === p.id}
                        />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </PageContainer>
  );
}
