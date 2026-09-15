import { describe, expect, it } from "vitest";
import { persistPropertyId, readPersistedPropertyId } from "../src/verticals/citas/lib/property-selection.ts";
import type { SessionStorageLike } from "../src/verticals/citas/lib/auth-client.ts";

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

// Hallazgo de auditoría (rubro 19, multi-organización, severidad MEDIA, "negocio de
// citas con 2+ sucursales solo opera la primera"): CitasShell.tsx fijaba
// `propertyId` a `branches[0]!.propertyId` sin selector ni persistencia. Estos tests
// cubren la persistencia (mismo patrón que
// apps/web/tests/hoteles-property-selection.spec.ts) -- resolveActivePropertyId en
// sí (qué sucursal queda activa dado lo persistido) ya está cubierta en
// apps/web/tests/citas-admin-client.spec.ts, donde vive esa función.
describe("persistPropertyId / readPersistedPropertyId (citas)", () => {
  it("guarda y relee la sucursal activa real (round-trip) bajo una llave por organización", () => {
    const storage = fakeStorage();
    persistPropertyId(storage, "clinica-dental-sonrisas", "p1");
    expect(readPersistedPropertyId(storage, "clinica-dental-sonrisas")).toBe("p1");
  });

  it("dos organizaciones de citas en el mismo navegador no se pisan la selección", () => {
    const storage = fakeStorage();
    persistPropertyId(storage, "org-a", "sucursal-a1");
    persistPropertyId(storage, "org-b", "sucursal-b1");
    expect(readPersistedPropertyId(storage, "org-a")).toBe("sucursal-a1");
    expect(readPersistedPropertyId(storage, "org-b")).toBe("sucursal-b1");
  });

  it("null si nunca se guardó nada para esa organización", () => {
    const storage = fakeStorage();
    expect(readPersistedPropertyId(storage, "org-sin-seleccion")).toBeNull();
  });

  it("cambiar de sucursal sobrescribe la selección previa de la misma organización -- esto es lo que sobrevive a navegar entre páginas del panel", () => {
    const storage = fakeStorage();
    persistPropertyId(storage, "clinica-dental-sonrisas", "sucursal-a");
    persistPropertyId(storage, "clinica-dental-sonrisas", "sucursal-b");
    expect(readPersistedPropertyId(storage, "clinica-dental-sonrisas")).toBe("sucursal-b");
  });

  it("storage que falla al leer -> null, nunca lanza (ej. modo privado que bloquea localStorage)", () => {
    expect(readPersistedPropertyId(throwingStorage(), "clinica-dental-sonrisas")).toBeNull();
  });

  it("storage que falla al escribir -> no lanza (best-effort, ver comentario de cabecera)", () => {
    expect(() => persistPropertyId(throwingStorage(), "clinica-dental-sonrisas", "sucursal-a")).not.toThrow();
  });
});
