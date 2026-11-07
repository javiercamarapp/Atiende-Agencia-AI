// @vitest-environment jsdom
//
// ds3 «cifras y montos premium (sin estilo reloj)»: formato puro (es-MX/en-US, compacto, negativos, «—»), particion del texto que ya
// trae la pagina, la curva de Rovaq y el conteo de <Cifra> (una vez al aparecer, transicion al cambiar, nunca en un re-render con el
// mismo valor, nunca con movimiento reducido, y el DOM siempre termina con el texto final exacto).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CIFRA_CONTEO_MS, Cifra, CifraTexto, KpiTile, StatCard, curvaRovaq, formatearCifra, partesCifra, partirTextoCifra } from "../src/index";
import { Activity } from "lucide-react";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const aqui = dirname(fileURLToPath(import.meta.url));
const cssCifra = readFileSync(join(aqui, "../src/cifra.css"), "utf8");

let root: Root | null = null;
let host: HTMLElement | null = null;
function montar(ui: ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return { el: host, rerender: (x: ReactElement) => act(() => root!.render(x)) };
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("formato puro", () => {
  it("dinero es-MX: miles con coma, 2 decimales, signo de moneda aparte", () => {
    const p = partesCifra(1234567.5, { variante: "dinero" });
    expect(p.texto).toBe("$1,234,567.50");
    expect([p.signo, p.simbolo, p.entero, p.decimales, p.sufijo]).toEqual(["", "$", "1,234,567", ".50", ""]);
    expect(formatearCifra(41.82, { variante: "dinero", moneda: "USD" })).toBe("US$41.82");
    expect(formatearCifra(900, { variante: "dinero", decimales: 0 })).toBe("$900");
  });

  it("en-US usa los mismos separadores; el locale es configurable", () => {
    expect(formatearCifra(1234.5, { variante: "dinero", locale: "en-US" })).toBe("$1,234.50");
    expect(formatearCifra(2_500_000, { variante: "compacto", locale: "en-US" })).toBe("2.5M");
  });

  it("conteo y porcentaje", () => {
    expect(formatearCifra(5400000)).toBe("5,400,000");
    expect(formatearCifra(25, { variante: "porcentaje" })).toBe("25%");
    expect(formatearCifra(12.34, { variante: "porcentaje" })).toBe("12.3%");
    expect(formatearCifra(8, { variante: "porcentaje", conSigno: true })).toBe("+8%");
  });

  it("negativos: el signo menos va primero y aparte («-$1,200.00»)", () => {
    const p = partesCifra(-1200, { variante: "dinero" });
    expect(p.texto).toBe("-$1,200.00");
    expect(p.signo).toBe("-");
    expect(formatearCifra(-8, { variante: "porcentaje", conSigno: true })).toBe("-8%");
    // -0 no pinta «-0».
    expect(formatearCifra(-0)).toBe("0");
  });

  it("null / undefined / NaN / Infinity = «—», jamas 0", () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = partesCifra(v, { variante: "dinero" });
      expect(p.texto).toBe("—");
      expect(p.valor).toBeNull();
    }
  });

  it("compacto: $1.2 M con el valor completo aparte; trunca (no infla) y quita el .0", () => {
    const p = partesCifra(1_234_567, { variante: "compacto", moneda: "MXN" });
    expect(p.texto).toBe("$1.2 M");
    expect(p.completo).toBe("$1,234,567.00");
    expect(formatearCifra(999_999, { variante: "compacto" })).toBe("999.9 k");
    expect(formatearCifra(2_000_000, { variante: "compacto" })).toBe("2 M");
    expect(formatearCifra(3_400_000_000, { variante: "compacto" })).toBe("3.4 mil M");
    // Debajo del umbral (10 000) se pinta completo.
    expect(formatearCifra(9_500, { variante: "compacto" })).toBe("9,500");
    expect(formatearCifra(-1_500_000, { variante: "compacto", moneda: "MXN" })).toBe("-$1.5 M");
  });
});

describe("partirTextoCifra (texto que ya formateo la pagina)", () => {
  it("parte sin cambiar un caracter", () => {
    const casos: Array<[string, string, string, string, string]> = [
      ["$12,500.00", "$", "12,500", ".00", ""],
      ["US$0.0042", "US$", "0", ".0042", ""],
      ["1,400", "", "1,400", "", ""],
      ["25%", "", "25", "", "%"],
      ["$3.4 M", "$", "3", ".4", " M"],
    ];
    for (const [t, simbolo, entero, dec, suf] of casos) {
      const p = partirTextoCifra(t)!;
      expect([p.simbolo, p.entero, p.decimales, p.sufijo]).toEqual([simbolo, entero, dec, suf]);
      expect(`${p.signo}${p.simbolo}${p.entero}${p.decimales}${p.sufijo}`).toBe(t);
    }
    expect(partirTextoCifra("-8%")!.valor).toBe(-8);
    expect(partirTextoCifra("$12,500.50")!.valor).toBe(12500.5);
  });

  it("un texto que no es cifra simple devuelve null (se pinta tal cual)", () => {
    for (const t of ["18 de 24", "318.5 min", "—", "3 h 20 min", "Sin datos"]) expect(partirTextoCifra(t)).toBeNull();
  });
});

describe("<Cifra> y <CifraTexto>", () => {
  it("pinta las piezas con sus clases y la escala de tamano", () => {
    const { el } = montar(<Cifra valor={45231.5} variante="dinero" tamano={28} data-testid="c" />);
    const c = el.querySelector('[data-testid="c"]')!;
    expect(c.textContent).toBe("$45,231.50");
    expect(c.getAttribute("data-tamano")).toBe("28");
    expect(c.querySelector(".cifra-simbolo")!.textContent).toBe("$");
    expect(c.querySelector(".cifra-entero")!.textContent).toBe("45,231");
    expect(c.querySelector(".cifra-decimales")!.textContent).toBe(".50");
    // Nunca mono: ni la clase ni el estilo reloj.
    expect(c.outerHTML).not.toMatch(/font-mono|cifra-mono|odometro/);
  });

  it("compacto lleva el valor completo en el titulo", () => {
    const { el } = montar(<Cifra valor={1_234_567} variante="compacto" moneda="MXN" />);
    const c = el.querySelector(".cifra")!;
    expect(c.textContent).toBe("$1.2 M");
    expect(c.getAttribute("title")).toBe("$1,234,567.00");
  });

  it("null = «—» con clase vacia y el motivo como texto oculto (sin aria-label en un elemento generico)", () => {
    const { el } = montar(<Cifra valor={null} variante="dinero" sinDato="falta la migracion" />);
    const c = el.querySelector(".cifra")!;
    expect(c.className).toContain("cifra-vacia");
    expect(c.getAttribute("aria-label")).toBeNull();
    expect(c.querySelector(".cifra-entero")!.textContent).toBe("—");
    expect(c.querySelector(".sr-only")!.textContent).toContain("falta la migracion");
    expect(c.textContent).not.toContain("0");
  });

  it("CifraTexto conserva el texto exacto; si no es cifra lo deja tal cual", () => {
    expect(montar(<CifraTexto texto="US$41.82" />).el.textContent).toBe("US$41.82");
    act(() => root?.unmount());
    const otro = montar(<CifraTexto texto="18 de 24" />).el;
    expect(otro.textContent).toBe("18 de 24");
    expect(otro.querySelector(".cifra-vacia")).toBeNull();
  });

  it("StatCard y KpiTile pintan su valor con <CifraTexto> (mismo texto, ahora en piezas)", () => {
    const s = montar(<StatCard icon={Activity} label="Ventas" value="$45,231.00" />).el;
    expect(s.querySelector(".ds3-stat-valor .cifra .cifra-simbolo")!.textContent).toBe("$");
    expect(s.querySelector(".ds3-stat-valor")!.textContent).toBe("$45,231.00");
    act(() => root?.unmount());
    const k = montar(<KpiTile icono={<Activity />} etiqueta="Ops" valor={1400} formato="entero" />).el;
    expect(k.querySelector('[data-testid="kpi-tile-valor"]')!.textContent).toBe("1,400");
    expect(k.querySelector('[data-testid="kpi-tile-valor"] .cifra')).not.toBeNull();
  });

  it("delta del StatCard: pildora ds3-delta con su tono (bueno/malo/neutro)", () => {
    const { el } = montar(<StatCard icon={Activity} label="Costo" value="$10" delta={{ pct: 12, bueno: false }} />);
    const d = el.querySelector(".ds3-delta")!;
    expect(d.getAttribute("data-tono")).toBe("malo");
    expect(d.textContent).toContain("12%");
  });
});

describe("movimiento", () => {
  it("curva de Rovaq cubic-bezier(.22,1,.36,1): 0 y 1 en los extremos, monotona y rapida al salir", () => {
    expect(curvaRovaq(0)).toBe(0);
    expect(curvaRovaq(1)).toBe(1);
    let previo = 0;
    for (let t = 0.05; t < 1; t += 0.05) {
      const v = curvaRovaq(t);
      expect(v).toBeGreaterThanOrEqual(previo);
      previo = v;
    }
    expect(curvaRovaq(0.5)).toBeGreaterThan(0.85);
  });

  it("la duracion esta en la ventana de Rovaq (250-360 ms)", () => {
    expect(CIFRA_CONTEO_MS).toBeGreaterThanOrEqual(250);
    expect(CIFRA_CONTEO_MS).toBeLessThanOrEqual(360);
  });

  it("cifra.css: la bandera del conteo solo existe bajo ds3, se apaga con reduced-motion y no hay digitos que ruedan", () => {
    expect(cssCifra).toMatch(/html\[data-diseno="ds3"\] \{ --cifra-conteo: 1; \}/);
    expect(cssCifra).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*html\[data-diseno="ds3"\] \{ --cifra-conteo: 0; \}/);
    expect(cssCifra).toMatch(/cifra-entra 320ms cubic-bezier\(0\.22, 1, 0\.36, 1\)/);
    expect(cssCifra).not.toMatch(/rotateX|font-mono|monospace/);
  });

  describe("conteo de <Cifra>", () => {
    let ahora = 0;
    let cola: Array<FrameRequestCallback> = [];
    const avanzar = (ms: number) => {
      ahora += ms;
      const pendientes = cola;
      cola = [];
      act(() => {
        for (const f of pendientes) f(ahora);
      });
    };
    const terminar = () => {
      for (let i = 0; i < 40 && cola.length; i++) avanzar(16);
    };

    function entorno({ conteo = "1", reducido = false }: { conteo?: string; reducido?: boolean } = {}) {
      ahora = 0;
      cola = [];
      vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => {
        cola.push(f);
        return cola.length;
      });
      vi.stubGlobal("cancelAnimationFrame", () => {
        cola = [];
      });
      vi.spyOn(performance, "now").mockImplementation(() => ahora);
      vi.stubGlobal("matchMedia", (q: string) => ({ matches: reducido && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
      const original = window.getComputedStyle.bind(window);
      vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
        const real = original(el);
        return new Proxy(real, { get: (t, k) => (k === "getPropertyValue" ? (n: string) => (n === "--cifra-conteo" ? conteo : t.getPropertyValue(n)) : Reflect.get(t, k)) });
      });
    }

    beforeEach(() => {
      Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => false });
    });

    it("cuenta UNA vez al aparecer (desde 0) y termina con el texto final exacto", () => {
      entorno();
      const { el } = montar(<Cifra valor={45231.5} variante="dinero" />);
      const entero = el.querySelector(".cifra-entero")!;
      expect(cola.length).toBe(1);
      avanzar(CIFRA_CONTEO_MS / 4);
      const intermedio = entero.textContent!;
      expect(intermedio).not.toBe("45,231");
      expect(Number(intermedio.replace(/,/g, ""))).toBeLessThan(45231);
      terminar();
      expect(el.textContent).toBe("$45,231.50");
      expect((el.querySelector(".cifra") as HTMLElement).style.minWidth).toBe("");
    });

    it("re-render con el mismo valor NO re-anima; un valor nuevo hace una transicion desde el anterior", () => {
      entorno();
      const m = montar(<Cifra valor={100} />);
      terminar();
      m.rerender(<Cifra valor={100} className="otra" />);
      expect(cola.length).toBe(0);
      m.rerender(<Cifra valor={200} />);
      expect(cola.length).toBe(1);
      avanzar(CIFRA_CONTEO_MS / 4);
      const v = Number(m.el.querySelector(".cifra-entero")!.textContent);
      expect(v).toBeGreaterThan(100);
      expect(v).toBeLessThan(200);
      terminar();
      expect(m.el.textContent).toBe("200");
    });

    it("sin la bandera de CSS (--cifra-conteo != 1, es decir fuera de ds3) no hay conteo", () => {
      entorno({ conteo: "" });
      const { el } = montar(<Cifra valor={500} />);
      expect(cola.length).toBe(0);
      expect(el.textContent).toBe("500");
    });

    it("prefers-reduced-motion: la cifra final aparece de una vez", () => {
      entorno({ reducido: true });
      const { el } = montar(<Cifra valor={500} />);
      expect(cola.length).toBe(0);
      expect(el.textContent).toBe("500");
    });

    it("navegador automatizado (webdriver, e2e y capturas): sin conteo", () => {
      entorno();
      Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => true });
      montar(<Cifra valor={500} />);
      expect(cola.length).toBe(0);
    });

    it("animar={false} y «—» nunca cuentan", () => {
      entorno();
      montar(<Cifra valor={500} animar={false} />);
      expect(cola.length).toBe(0);
      act(() => root?.unmount());
      montar(<Cifra valor={null} />);
      expect(cola.length).toBe(0);
    });
  });
});
