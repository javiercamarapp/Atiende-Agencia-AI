import { describe, expect, it } from "vitest";
import { persistPropertyId, readPersistedPropertyId } from "../src/verticals/despachos/lib/property-selection.ts";
import type { SessionStorageLike } from "../src/verticals/despachos/lib/auth-client.ts";

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

// Hallazgo de auditoría (severidad ALTA, "el selector real de contribuyente de la
// Fase 10 (DespachosShell.tsx) vive en un useState que se resetea cada vez que se
// navega"): un contador que elige el contribuyente B en CFDI y navega a
// Declaraciones volvía a ver los datos del contribuyente A (el primero) sin ningún
// aviso, porque App.tsx monta una instancia NUEVA de DespachosShell por cada una de
// sus 14 rutas Despachos*Route. Estos tests cubren la persistencia (mismo patrón
// que apps/web/tests/rentas-property-selection.spec.ts) -- resolveActivePropertyId
// en sí (qué contribuyente queda activo dado lo persistido) ya está cubierta en
// apps/web/tests/despachos-admin-client.spec.ts, donde vive esa función.
describe("persistPropertyId / readPersistedPropertyId (despachos)", () => {
  it("guarda y relee el contribuyente activo real (round-trip) bajo una llave por organización", () => {
    const storage = fakeStorage();
    persistPropertyId(storage, "despacho-fiscal-uno", "p1");
    expect(readPersistedPropertyId(storage, "despacho-fiscal-uno")).toBe("p1");
  });

  it("dos organizaciones de despachos en el mismo navegador no se pisan la selección", () => {
    const storage = fakeStorage();
    persistPropertyId(storage, "org-a", "contribuyente-a1");
    persistPropertyId(storage, "org-b", "contribuyente-b1");
    expect(readPersistedPropertyId(storage, "org-a")).toBe("contribuyente-a1");
    expect(readPersistedPropertyId(storage, "org-b")).toBe("contribuyente-b1");
  });

  it("null si nunca se guardó nada para esa organización", () => {
    const storage = fakeStorage();
    expect(readPersistedPropertyId(storage, "org-sin-seleccion")).toBeNull();
  });

  it("cambiar de contribuyente sobrescribe la selección previa de la misma organización -- esto es lo que sobrevive a navegar de CFDI a Declaraciones", () => {
    const storage = fakeStorage();
    persistPropertyId(storage, "despacho-fiscal-uno", "contribuyente-a");
    persistPropertyId(storage, "despacho-fiscal-uno", "contribuyente-b");
    expect(readPersistedPropertyId(storage, "despacho-fiscal-uno")).toBe("contribuyente-b");
  });

  it("storage que falla al leer -> null, nunca lanza (ej. modo privado que bloquea localStorage)", () => {
    expect(readPersistedPropertyId(throwingStorage(), "despacho-fiscal-uno")).toBeNull();
  });

  it("storage que falla al escribir -> no lanza (best-effort, ver comentario de cabecera)", () => {
    expect(() => persistPropertyId(throwingStorage(), "despacho-fiscal-uno", "contribuyente-a")).not.toThrow();
  });
});
