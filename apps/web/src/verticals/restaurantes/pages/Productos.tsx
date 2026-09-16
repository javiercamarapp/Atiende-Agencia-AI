// Productos/Categorías (Fase 5) — CRUD real: alta/edición de categoría y producto,
// y activar/desactivar+precio de un producto EN esta sucursal (branch_products, la
// fuente real de precio/disponibilidad que ya consulta el flujo de pedido/agente —
// ver admin-catalog.ts). Estilos inline, sin design system nuevo.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { EstadoCargando, EstadoError, EstadoVacio } from "@atiende/ui";
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
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Productos y categorías</h1>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
        <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}>Nueva categoría</p>
        <form onSubmit={handleCreateCategory} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input placeholder="Nombre (ej. Postres)" value={newCatName} onChange={(e) => setNewCatName(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }} />
          <input placeholder="slug (ej. postres)" value={newCatSlug} onChange={(e) => setNewCatSlug(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }} />
          <button type="submit" disabled={creatingCategory} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer" }}>
            {creatingCategory ? "Creando…" : "Crear categoría"}
          </button>
        </form>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
          {categories?.map((c) => (
            <span key={c.id} style={{ fontSize: 12, padding: "3px 10px", borderRadius: 999, background: "#f3f4f6", color: "#374151" }}>
              {c.name}
            </span>
          ))}
        </div>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
        <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}>Nuevo producto</p>
        <form onSubmit={handleCreateProduct} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input placeholder="Nombre" value={newProdName} onChange={(e) => setNewProdName(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }} />
          <input placeholder="Precio base" type="number" min={0} step="0.01" value={newProdPrice} onChange={(e) => setNewProdPrice(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, width: 120 }} />
          <select value={newProdCategoryId} onChange={(e) => setNewProdCategoryId(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}>
            <option value="">Sin categoría</option>
            {categories?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button type="submit" disabled={creatingProduct} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer" }}>
            {creatingProduct ? "Creando…" : "Crear producto"}
          </button>
        </form>
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "#9ca3af" }}>Un producto recién creado NO aparece en el pedido/agente hasta activarlo abajo en esta sucursal.</p>
      </section>

      {!products && !error && <EstadoCargando etiqueta="Cargando catálogo…" />}
      {products && products.length === 0 && <EstadoVacio mensaje="Este negocio todavía no tiene productos en su catálogo." />}

      {products && products.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280", borderBottom: "1px solid #e5e7eb" }}>
                <th style={{ padding: "6px 8px" }}>Producto</th>
                <th style={{ padding: "6px 8px" }}>Categoría</th>
                <th style={{ padding: "6px 8px" }}>Precio en esta sucursal</th>
                <th style={{ padding: "6px 8px" }}>Disponible aquí</th>
                <th style={{ padding: "6px 8px" }}>Popular</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "8px" }}>{p.name}</td>
                  <td style={{ padding: "8px", color: "#6b7280" }}>{p.categoryName ?? "—"}</td>
                  <td style={{ padding: "8px" }}>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      defaultValue={p.branch?.price ?? p.price}
                      onBlur={(e) => void handlePriceChange(p, e.target.value)}
                      disabled={savingId === p.id}
                      style={{ width: 90, padding: "4px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}
                    />
                    {p.branch === null && <span style={{ marginLeft: 6, fontSize: 11, color: "#9ca3af" }}>(precio base {formatMoney(p.price)}, nunca dado de alta aquí)</span>}
                  </td>
                  <td style={{ padding: "8px" }}>
                    <button
                      onClick={() => void handleToggleAvailability(p)}
                      disabled={savingId === p.id}
                      style={{
                        padding: "4px 10px",
                        borderRadius: 999,
                        border: "1px solid " + (p.branch?.isAvailable ? "#166534" : "#d1d5db"),
                        background: p.branch?.isAvailable ? "#dcfce7" : "#f3f4f6",
                        color: p.branch?.isAvailable ? "#166534" : "#6b7280",
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                    >
                      {p.branch?.isAvailable ? "Disponible" : "No disponible"}
                    </button>
                  </td>
                  <td style={{ padding: "8px" }}>
                    <input type="checkbox" checked={p.isPopular} onChange={() => void handleTogglePopular(p)} disabled={savingId === p.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
