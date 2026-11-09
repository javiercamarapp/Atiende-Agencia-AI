// i18n ES/EN: idioma activo fuera de React (P2-4 de la revision #744/#748). Los formateadores sin hook (formatMoney, resolverFormato,
// <Cifra>) delegan en crearFormatos(idiomaActivo()) y las etiquetas de los `lib/*.ts` (traductorActivo / etiquetasTraducidas) siguen al
// idioma que fija IdiomaProvider. En espanol todo debe dar EXACTAMENTE lo de antes (es-MX, mismos textos).
import { afterEach, describe, expect, it } from "vitest";
import { fijarIdiomaActivo, idiomaActivo, localeActivo } from "../src/i18n/activo.ts";
import { cargarIdioma } from "../src/i18n/mensajes/index.ts";
import { etiquetasTraducidas, traductorActivo } from "../src/i18n/traductor-activo.ts";
import { restaurantesComun } from "../src/i18n/mensajes/restaurantes/comun.ts";
import { formatMoney } from "../src/lib/formatMoney.ts";
import { numeroEsMx, resolverFormato } from "../src/lib/formato-preset.ts";

afterEach(() => fijarIdiomaActivo("es"));

describe("idioma activo", () => {
  it("por omision es espanol de Mexico", () => {
    expect(idiomaActivo()).toBe("es");
    expect(localeActivo()).toBe("es-MX");
  });

  it("formatMoney y resolverFormato dan byte a byte lo de siempre en espanol", () => {
    for (const v of [0, 1234.5, -98765.432, 1e7]) {
      expect(formatMoney(v)).toBe(v.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
      expect(formatMoney(v, 0)).toBe(v.toLocaleString("es-MX", { minimumFractionDigits: 0, maximumFractionDigits: 0 }));
      expect(numeroEsMx(v, 1)).toBe(v.toLocaleString("es-MX", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
      expect(resolverFormato("numero")(v)).toBe(v.toLocaleString("es-MX", { maximumFractionDigits: 2 }));
    }
    expect(resolverFormato("mxn")(1234.5)).toBe("$1,234.50");
  });

  it("con la consola en ingles formatean en en-US", () => {
    fijarIdiomaActivo("en");
    expect(localeActivo()).toBe("en-US");
    expect(formatMoney(1234.5)).toBe((1234.5).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    expect(resolverFormato("entero")(1234.4)).toBe("1,234");
  });
});

describe("traductorActivo / etiquetasTraducidas", () => {
  it("traducen al idioma activo y registran el espanol sin efectos al importar", async () => {
    const tr = traductorActivo(restaurantesComun);
    expect(tr("restaurantes.estado.pending")).toBe("Recibido");
    await cargarIdioma("en");
    fijarIdiomaActivo("en");
    expect(tr("restaurantes.estado.pending")).toBe("Received");
  });

  it("el mapa se lee como un Record normal y traduce en cada lectura", async () => {
    const mapa = etiquetasTraducidas<"pending" | "en_camino">(["pending", "en_camino"], (s) => `restaurantes.estado.${s}` as const, restaurantesComun);
    expect(mapa.pending).toBe("Recibido");
    expect(Object.entries(mapa)).toEqual([
      ["pending", "Recibido"],
      ["en_camino", "En camino"],
    ]);
    await cargarIdioma("en");
    fijarIdiomaActivo("en");
    expect({ ...mapa }).toEqual({ pending: "Received", en_camino: "On the way" });
    expect(Object.isFrozen(mapa)).toBe(true);
  });
});
