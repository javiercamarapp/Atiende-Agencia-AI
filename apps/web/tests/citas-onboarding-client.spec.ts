// C-06 -- cliente del checklist de primeros pasos: URL, mapeo y preferencias de descartar/posponer (solo navegador).
import { describe, expect, it, vi } from "vitest";
import {
  PREFERENCIAS_VACIAS,
  claveDePreferencias,
  descartarPaso,
  fetchOnboarding,
  guardarPreferencias,
  leerPreferencias,
  ocultoComo,
  posponerPaso,
  reactivarPaso,
  rutaDelPaso,
} from "../src/verticals/citas/lib/onboarding-client.ts";

const AHORA = new Date("2026-10-01T12:00:00.000Z");
const opcional = { id: "precio", requeridoParaPublicar: false, estado: "pendiente" } as const;
const requerido = { id: "horario", requeridoParaPublicar: true, estado: "pendiente" } as const;

function memoria(inicial: Record<string, string> = {}) {
  const datos = { ...inicial };
  return { getItem: (k: string) => datos[k] ?? null, setItem: (k: string, v: string) => void (datos[k] = v), datos };
}

describe("fetchOnboarding", () => {
  it("pide la ruta de la sucursal con el token y devuelve el cuerpo tal cual", async () => {
    const cuerpo = { propertyId: "p1", pasos: [], completados: 0, total: 9, progresoPct: 0, faltanParaPublicar: [], listoParaRecibirCitas: false };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => cuerpo }) as unknown as Response);
    expect(await fetchOnboarding(fetchMock as unknown as typeof fetch, "https://api.test", "tok", "p1")).toEqual(cuerpo);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://api.test/v1/citas/properties/p1/onboarding");
    expect(init.headers.authorization).toBe("Bearer tok");
  });

  it("propaga el mensaje real del servidor ante un 403", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ message: "No tienes permiso para realizar esta acción." }) }) as unknown as Response);
    await expect(fetchOnboarding(fetchMock as unknown as typeof fetch, "https://api.test", "tok", "p1")).rejects.toThrow(/permiso/);
  });
});

describe("rutaDelPaso", () => {
  it("arma el enlace directo dentro del negocio", () => {
    expect(rutaDelPaso("demo", { ruta: "disponibilidad" })).toBe("/citas/demo/disponibilidad");
  });
});

describe("descartar / posponer", () => {
  it("un paso requerido o ya completo nunca se oculta, aunque este marcado", () => {
    const prefs = descartarPaso(PREFERENCIAS_VACIAS, "horario");
    expect(ocultoComo(prefs, requerido, AHORA)).toBeNull();
    expect(ocultoComo(descartarPaso(PREFERENCIAS_VACIAS, "precio"), { ...opcional, estado: "completo" }, AHORA)).toBeNull();
  });

  it("descartar oculta; reactivar lo devuelve", () => {
    const d = descartarPaso(PREFERENCIAS_VACIAS, "precio");
    expect(ocultoComo(d, opcional, AHORA)).toBe("descartado");
    expect(ocultoComo(reactivarPaso(d, "precio"), opcional, AHORA)).toBeNull();
  });

  it("posponer oculta 7 dias y vuelve solo al vencer (borde exacto incluido)", () => {
    const p = posponerPaso(PREFERENCIAS_VACIAS, "precio", AHORA);
    expect(p.pospuestos.precio).toBe("2026-10-08T12:00:00.000Z");
    expect(ocultoComo(p, opcional, new Date("2026-10-08T11:59:59.999Z"))).toBe("pospuesto");
    expect(ocultoComo(p, opcional, new Date("2026-10-08T12:00:00.000Z"))).toBeNull();
  });

  it("posponer un descartado lo saca de descartados y viceversa", () => {
    const d = descartarPaso(PREFERENCIAS_VACIAS, "precio");
    expect(posponerPaso(d, "precio", AHORA).descartados).toEqual([]);
    expect(descartarPaso(posponerPaso(PREFERENCIAS_VACIAS, "precio", AHORA), "precio").pospuestos).toEqual({});
  });

  it("persiste por negocio + sucursal y se recupera", () => {
    const s = memoria();
    const clave = claveDePreferencias("org-1", "prop-1");
    guardarPreferencias(s, clave, posponerPaso(descartarPaso(PREFERENCIAS_VACIAS, "whatsapp"), "precio", AHORA));
    expect(leerPreferencias(s, clave)).toMatchObject({ descartados: ["whatsapp"], pospuestos: { precio: "2026-10-08T12:00:00.000Z" } });
    expect(leerPreferencias(s, claveDePreferencias("org-1", "prop-2"))).toEqual(PREFERENCIAS_VACIAS);
  });

  it("almacenamiento ausente, roto o con basura: no lanza y no oculta nada", () => {
    expect(leerPreferencias(null, "k")).toEqual(PREFERENCIAS_VACIAS);
    expect(leerPreferencias(memoria({ k: "{no es json" }), "k")).toEqual(PREFERENCIAS_VACIAS);
    expect(leerPreferencias(memoria({ k: JSON.stringify({ descartados: [1, "ok"], pospuestos: { a: "no-fecha", b: 5, c: "2026-10-08T12:00:00.000Z" } }) }), "k")).toEqual({ descartados: ["ok"], pospuestos: { c: "2026-10-08T12:00:00.000Z" } });
    const lleno = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
    expect(() => guardarPreferencias(lleno, "k", PREFERENCIAS_VACIAS)).not.toThrow();
  });
});
