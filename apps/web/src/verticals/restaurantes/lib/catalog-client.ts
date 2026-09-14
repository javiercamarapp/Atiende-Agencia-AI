// Lógica de datos de Productos/Categorías (Fase 5) — CRUD real sobre
// apps/api/src/routes/verticals/restaurantes/admin-catalog.ts.
import { fetchJson, sendJson } from "./admin-client.ts";

export interface Category {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly displayOrder: number;
}

export interface BranchProductState {
  readonly propertyId: string;
  readonly productId: string;
  readonly price: number;
  readonly isAvailable: boolean;
}

export interface Product {
  readonly id: string;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly price: number;
  readonly imageUrl: string | null;
  readonly isPopular: boolean;
  readonly isAvailable: boolean;
  readonly displayOrder: number;
  readonly searchKeywords: readonly string[];
  readonly branch: BranchProductState | null;
}

export async function fetchCategories(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly Category[]> {
  const body = await fetchJson<{ categories: readonly Category[] }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/categories`, token);
  return body.categories;
}

export async function createCategory(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: { name: string; slug: string }): Promise<Category> {
  const body = await sendJson<{ category: Category }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/categories`, token, "POST", input);
  return body.category;
}

export async function updateCategory(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  categoryId: string,
  patch: { name?: string; slug?: string },
): Promise<Category> {
  const body = await sendJson<{ category: Category }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/categories/${categoryId}`, token, "PATCH", patch);
  return body.category;
}

export async function fetchProducts(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly Product[]> {
  const body = await fetchJson<{ products: readonly Product[] }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/products`, token);
  return body.products;
}

export interface NewProductInput {
  readonly name: string;
  readonly price: number;
  readonly categoryId?: string | null;
  readonly description?: string | null;
}

export async function createProduct(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: NewProductInput): Promise<Product> {
  const body = await sendJson<{ product: Product }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/products`, token, "POST", input);
  return body.product;
}

export async function updateProduct(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  productId: string,
  patch: { name?: string; price?: number; categoryId?: string | null; description?: string | null; isPopular?: boolean },
): Promise<Product> {
  const body = await sendJson<{ product: Product }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/products/${productId}`, token, "PATCH", patch);
  return body.product;
}

export async function setBranchAvailability(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  productId: string,
  patch: { price?: number; isAvailable?: boolean },
): Promise<BranchProductState> {
  const body = await sendJson<{ branch: BranchProductState }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/products/${productId}/branch-availability`, token, "PATCH", patch);
  return body.branch;
}
