// Estado en memoria de la memoria del cliente (espejo de las tablas/columnas de la migracion 044) para el repositorio en
// memoria. Solo guarda datos; las reglas viven en los metodos del repositorio y en gustos.ts / memoria.ts.
import { randomUUID } from "node:crypto";
import type { CustomerAddress } from "../types.ts";
import type { CustomerPolicy, CustomerPreference } from "./types.ts";

export interface MemAddress extends CustomerAddress {
  readonly id: string;
  accessNotes: string | null;
  mapsUrl: string | null;
  colonia: string | null;
  propertyId: string | null;
  lastUsedAt: string | null;
  timesUsed: number;
  readonly createdAt: string;
  // CustomerAddress es readonly: se reemplaza el objeto completo al marcar predeterminado.
}

export function newMemAddress(address: string, isDefault: boolean): MemAddress {
  return { id: randomUUID(), address, label: null, isDefault, accessNotes: null, mapsUrl: null, colonia: null, propertyId: null, lastUsedAt: null, timesUsed: 0, createdAt: new Date().toISOString() };
}

export class Cliente360Store {
  /** `false` simula la base SIN la migracion 044. */
  supported = true;
  readonly preferences = new Map<string, CustomerPreference[]>();
  readonly closures = new Set<string>();
  readonly fakeOrders = new Set<string>();
  readonly profiles = new Map<string, { dia: number | null; mes: number | null; staffNotes: string | null }>();
  readonly policies = new Map<string, CustomerPolicy>();
}
