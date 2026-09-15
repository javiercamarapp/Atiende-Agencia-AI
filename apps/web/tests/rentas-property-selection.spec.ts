import { describe, expect, it } from "vitest";
import { persistPropertyId, readPersistedPropertyId, resolveActivePropertyId } from "../src/verticals/rentas/lib/property-selection.ts";
import type { SessionStorageLike } from "../src/verticals/rentas/lib/auth-client.ts";

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

describe("persistPropertyId / readPersistedPropertyId", () => {
  it("guarda y relee la property activa real (round-trip) bajo una llave por organización", () => {
    const storage = fakeStorage();
    persistPropertyId(storage, "casas-del-mar", "prop-1");
    expect(readPersistedPropertyId(storage, "casas-del-mar")).toBe("prop-1");
  });

  it("dos organizaciones en el mismo navegador no se pisan la selección", () => {
    const storage = fakeStorage();
    persistPropertyId(storage, "org-a", "prop-a1");
    persistPropertyId(storage, "org-b", "prop-b1");
    expect(readPersistedPropertyId(storage, "org-a")).toBe("prop-a1");
    expect(readPersistedPropertyId(storage, "org-b")).toBe("prop-b1");
  });

  it("null si nunca se guardó nada para esa organización", () => {
    const storage = fakeStorage();
    expect(readPersistedPropertyId(storage, "org-sin-seleccion")).toBeNull();
  });

  it("cambiar de property sobrescribe la selección previa de la misma organización", () => {
    const storage = fakeStorage();
    persistPropertyId(storage, "casas-del-mar", "prop-1");
    persistPropertyId(storage, "casas-del-mar", "prop-2");
    expect(readPersistedPropertyId(storage, "casas-del-mar")).toBe("prop-2");
  });

  it("storage que falla al leer -> null, nunca lanza (ej. modo privado que bloquea localStorage)", () => {
    expect(readPersistedPropertyId(throwingStorage(), "casas-del-mar")).toBeNull();
  });

  it("storage que falla al escribir -> no lanza (best-effort, ver comentario de cabecera)", () => {
    expect(() => persistPropertyId(throwingStorage(), "casas-del-mar", "prop-1")).not.toThrow();
  });
});

describe("resolveActivePropertyId", () => {
  const properties = [
    { propertyId: "prop-1" },
    { propertyId: "prop-2" },
    { propertyId: "prop-3" },
  ];

  it("usa la property persistida cuando sigue siendo válida", () => {
    expect(resolveActivePropertyId(properties, "prop-2")).toBe("prop-2");
  });

  it("cae a la primera de la lista cuando no hay nada persistido", () => {
    expect(resolveActivePropertyId(properties, null)).toBe("prop-1");
  });

  it("cae a la primera de la lista cuando la persistida ya no es una property real de la organización (reasignación de staff, property dada de baja)", () => {
    expect(resolveActivePropertyId(properties, "prop-de-otra-organizacion")).toBe("prop-1");
  });
});
