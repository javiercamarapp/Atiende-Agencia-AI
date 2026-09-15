import { describe, expect, it } from "vitest";
import { persistPropertyId, readPersistedPropertyId } from "../src/verticals/hoteles/lib/property-selection.ts";
import type { SessionStorageLike } from "../src/verticals/hoteles/lib/auth-client.ts";

function fakeStorage(): SessionStorageLike {
  const map = new Map<string, string>();
  return {
    setItem: (k, v) => void map.set(k, v),
    getItem: (k) => map.get(k) ?? null,
    removeItem: (k) => void map.delete(k),
  };
}

function throwingStorage(): SessionStorageLike {
  return {
    setItem: () => {
      throw new Error("storage bloqueado");
    },
    getItem: () => {
      throw new Error("storage bloqueado");
    },
    removeItem: () => {
      throw new Error("storage bloqueado");
    },
  };
}

// Hallazgo de auditoría (severidad ALTA, "cadena con 2+ hoteles solo opera el
// primero"): HotelesShell.tsx fijaba `propertyId` a `properties[0]` sin selector ni
// persistencia. Estos tests cubren la persistencia (mismo patrón que
// apps/web/tests/despachos-property-selection.spec.ts) -- resolveActivePropertyId
// en sí (qué hotel queda activo dado lo persistido) ya está cubierta en
// apps/web/tests/hoteles-discovery-client.spec.ts, donde vive esa función.
describe("persistPropertyId / readPersistedPropertyId (hoteles)", () => {
  it("guarda y relee el hotel activo real (round-trip) bajo una llave por organización", () => {
    const storage = fakeStorage();
    persistPropertyId(storage, "cadena-hotelera-uno", "p1");
    expect(readPersistedPropertyId(storage, "cadena-hotelera-uno")).toBe("p1");
  });

  it("dos organizaciones de hoteles en el mismo navegador no se pisan la selección", () => {
    const storage = fakeStorage();
    persistPropertyId(storage, "org-a", "hotel-a1");
    persistPropertyId(storage, "org-b", "hotel-b1");
    expect(readPersistedPropertyId(storage, "org-a")).toBe("hotel-a1");
    expect(readPersistedPropertyId(storage, "org-b")).toBe("hotel-b1");
  });

  it("null si nunca se guardó nada para esa organización", () => {
    const storage = fakeStorage();
    expect(readPersistedPropertyId(storage, "org-sin-seleccion")).toBeNull();
  });

  it("cambiar de hotel sobrescribe la selección previa de la misma organización -- esto es lo que sobrevive a navegar entre páginas del panel", () => {
    const storage = fakeStorage();
    persistPropertyId(storage, "cadena-hotelera-uno", "hotel-a");
    persistPropertyId(storage, "cadena-hotelera-uno", "hotel-b");
    expect(readPersistedPropertyId(storage, "cadena-hotelera-uno")).toBe("hotel-b");
  });

  it("storage que falla al leer -> null, nunca lanza (ej. modo privado que bloquea localStorage)", () => {
    expect(readPersistedPropertyId(throwingStorage(), "cadena-hotelera-uno")).toBeNull();
  });

  it("storage que falla al escribir -> no lanza (best-effort, ver comentario de cabecera)", () => {
    expect(() => persistPropertyId(throwingStorage(), "cadena-hotelera-uno", "hotel-a")).not.toThrow();
  });
});
