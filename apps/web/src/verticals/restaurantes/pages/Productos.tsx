// Productos/Categorías (Fase 5) — CRUD real: alta/edición de categoría y producto,
// y activar/desactivar+precio de un producto EN esta sucursal (branch_products, la
// fuente real de precio/disponibilidad que ya consulta el flujo de pedido/agente —
// ver admin-catalog.ts).
//
// Presentación real desde esta ronda: los `style={{...}}` inline de antes pasan a los
// primitivos de `@atiende/ui` — `Card`/`CardHeader`/`CardContent` para los dos
// formularios de alta, `Input`/`Label` para sus campos (el `<select>` sigue siendo
// nativo, solo restilado con tokens), `Button` para enviar, `Badge` para las
// categorías existentes y para el estado "Disponible / No disponible", y `Table` para
// el catálogo. TODO el CRUD/estado de abajo es el MISMO: solo cambia el JSX.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
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
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const SELECT_CLASES =
  "h-11 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

function formatMoney(n: number): string {
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function ProductosPage({ apiBaseUrl, token, propertyId }: RestaurantesShellContext) {
  const [categories, setCategories] = useState<readonly Category[] | null>(null);
  const [products, setProducts] = useState<readonly Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

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
    <div className="flex flex-col gap-5 p-6">
      <h1 className="m-0 font-display text-xl font-semibold text-foreground">Productos y categorías</h1>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle className="text-sm font-semibold">Nueva categoría</CardTitle>
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
              <Badge key={c.id} variant="secondary">
                {c.name}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle className="text-sm font-semibold">Nuevo producto</CardTitle>
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
              <select
                id="restaurantes-producto-categoria"
                value={newProdCategoryId}
                onChange={(e) => setNewProdCategoryId(e.target.value)}
                className={SELECT_CLASES}
              >
                <option value="">Sin categoría</option>
                {categories?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
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
                          <span className="text-[11px] text-muted-foreground">(precio base {formatMoney(p.price)}, nunca dado de alta aquí)</span>
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
                      <input
                        type="checkbox"
                        aria-label={`Marcar ${p.name} como popular`}
                        checked={p.isPopular}
                        onChange={() => void handleTogglePopular(p)}
                        disabled={savingId === p.id}
                        className="h-4 w-4 accent-primary"
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
