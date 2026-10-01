// @vitest-environment jsdom
//
// UNI-5 (piezas de Resumen identicas a Likida): render, a11y y medidas contra la spec. jsdom no
// calcula layout, asi que "<= 1 px" se comprueba donde SI es verificable: (1) las clases de cada pieza
// son las literales de Likida (spec §6.2/§7.1), (2) esas clases resuelven, con los tokens REALES de
// index.css, a los px medidos en Likida (11 / 12 / 13 / 20 px, 15 y 13 px de iconos) y (3) el odometro
// pinta tableros de 33x45 / 20x27 con fuente 29 / 18 y radio 7 / 5.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { Activity } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentRunCard,
  BarraAccionesInferior,
  Odometro,
  PillLink,
  RadioSegmentado,
  ResumenLayout,
  ResumenSeccion,
  SectionLabel,
  TileLink,
  avanceHaciaMeta,
  ODOMETRO_VOLTEO_MS,
} from "../src/index";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const aqui = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(aqui, "../src/index.css"), "utf8");

/** Tamano de un token `--text-*` en px (rem de 16 px). */
function px(token: string): number {
  const m = css.match(new RegExp(`${token}:\\s*([\\d.]+)rem;`));
  if (!m) throw new Error(`token ${token} no encontrado`);
  return Number(m[1]) * 16;
}

let raices: Array<{ root: Root; el: HTMLElement }> = [];
function montar(ui: ReactElement, ruta = "/") {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const envolver = (x: ReactElement) => createElement(MemoryRouter, { initialEntries: [ruta] }, x);
  act(() => root.render(envolver(ui)));
  raices.push({ root, el });
  return { el, rerender: (x: ReactElement) => act(() => root.render(envolver(x))) };
}
afterEach(() => {
  for (const r of raices) {
    act(() => r.root.unmount());
    r.el.remove();
  }
  raices = [];
  vi.useRealTimers();
});

describe("medidas frente a la spec de Likida (<= 1 px)", () => {
  it("los tokens de tipografia resuelven a los px de Likida", () => {
    expect(px("--text-eyebrow")).toBe(11); // SectionLabel (text-[11px])
    expect(px("--text-ui")).toBe(13); // titulos de tile / ficha (text-[13px])
    expect(Math.abs(px("--text-pill") - 12.5)).toBeLessThanOrEqual(1); // RadioSegmentado (text-[12.5px])
    expect(px("--text-xs")).toBe(12); // descripcion, meta, PillLink (12 px)
    expect(px("--text-xl")).toBe(20); // h1 del saludo (text-[20px])
    expect(px("--text-2xs")).toBe(10); // pie "sin medir" (text-[10px])
  });

  it("SectionLabel = etiqueta-mono 11 px mayusculas gris", () => {
    const { el } = montar(<SectionLabel>Orquestación de agentes</SectionLabel>);
    const h = el.querySelector("h2")!;
    expect(h.className).toBe("etiqueta-mono text-eyebrow font-medium uppercase text-muted-foreground");
    expect(h.textContent).toBe("Orquestación de agentes");
  });

  it("SectionLabel acepta otro elemento y un id", () => {
    const { el } = montar(<SectionLabel as="p" id="x">Hola</SectionLabel>);
    expect(el.querySelector("p#x")).not.toBeNull();
  });

  it("TileLink: clases literales de consola.tsx:291-300, iconos de 15 y 13 px", () => {
    const { el } = montar(<TileLink to="/agentes" icon={Activity} titulo="Agente de voz" descripcion="12 llamadas este mes" />);
    const a = el.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("/agentes");
    expect(a.className).toBe("flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:bg-canvas");
    const [icono, flecha] = Array.from(a.querySelectorAll("svg"));
    expect(icono!.getAttribute("class")).toContain("size-[15px]");
    expect(icono!.getAttribute("class")).toContain("mt-0.5");
    expect(icono!.getAttribute("stroke-width")).toBe("1.75");
    expect(flecha!.getAttribute("class")).toContain("size-[13px]");
    expect(flecha!.getAttribute("class")).toContain("ml-auto");
    expect(a.querySelector("span")!.className).toBe("truncate text-ui font-medium text-foreground");
    expect(a.querySelector("p")!.className).toBe("mt-0.5 text-xs text-muted-foreground");
    // Los iconos son decorativos: el nombre accesible del enlace es su texto.
    expect(a.querySelectorAll('svg[aria-hidden="true"]').length).toBe(2);
    expect(a.textContent).toBe("Agente de voz12 llamadas este mes");
  });

  it("TileLink sin descripcion ni badge no pinta huecos; con badge lo coloca antes de la flecha", () => {
    const { el } = montar(<TileLink to="/a" icon={Activity} titulo="A" />);
    expect(el.querySelector("p")).toBeNull();
    const m2 = montar(<TileLink to="/a" icon={Activity} titulo="A" badge={<b data-testid="b">2</b>} />);
    const fila = m2.el.querySelector("a > div > div")!;
    const hijos = Array.from(fila.children).map((c) => c.tagName);
    expect(hijos).toEqual(["SPAN", "SPAN", "svg"]);
    expect(m2.el.querySelector('[data-testid="b"]')).not.toBeNull();
  });

  it("PillLink: pildora de 12 px con flecha de 12 px y destino real", () => {
    const { el } = montar(<PillLink to="/superadmin/cfo">Ver Dashboard CFO</PillLink>);
    const a = el.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("/superadmin/cfo");
    expect(a.className).toBe(
      "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground-2 transition-colors hover:bg-canvas",
    );
    const flecha = a.querySelector("svg")!;
    expect(flecha.getAttribute("class")).toContain("size-3");
    expect(flecha.getAttribute("aria-hidden")).toBe("true");
    expect(a.textContent).toBe("Ver Dashboard CFO");
  });

  it("BarraAccionesInferior: pegajosa sobre la barra de 63 px + safe-area en movil, bottom-0 en md", () => {
    const { el } = montar(<BarraAccionesInferior><button type="button">Guardar</button></BarraAccionesInferior>);
    const b = el.querySelector('[data-testid="barra-acciones-inferior"]')!;
    expect(b.className).toContain("sticky");
    expect(b.className).toContain("bottom-[calc(63px+var(--safe-area-bottom))]");
    expect(b.className).toContain("md:bottom-0");
    expect(b.className).toContain("bg-sunken");
    expect(b.className).toContain("pt-3");
    expect(b.className).toContain("pb-4");
    expect(b.querySelector("button")!.textContent).toBe("Guardar");
  });
});

describe("AgentRunCard", () => {
  it("con corrida: nombre, StatusBadge a la derecha, meta y ficha", () => {
    const { el } = montar(<AgentRunCard nombre="Conciliación" estado={{ tone: "success", etiqueta: "Completada" }} meta="2 oct 09:00 · cron" href="/superadmin/agentes/conciliacion" />);
    const card = el.firstElementChild!;
    expect(card.className).toBe("rounded-lg border border-border bg-card px-3 py-2.5");
    expect(card.querySelector("span")!.className).toBe("truncate text-ui font-medium text-foreground");
    const badge = card.querySelector("[data-tone]")!;
    expect(badge.getAttribute("data-tone")).toBe("success");
    expect(badge.className).toContain("ml-auto");
    expect(badge.textContent).toBe("Completada");
    const meta = card.querySelector("p")!;
    expect(meta.className).toBe("mt-1 text-xs text-muted-foreground");
    expect(meta.textContent).toBe("2 oct 09:00 · cron — ver ficha");
    const ficha = meta.querySelector("a")!;
    expect(ficha.getAttribute("href")).toBe("/superadmin/agentes/conciliacion");
    expect(ficha.className).toBe("font-medium underline");
  });

  it("sin corrida: 'Sin corridas registradas.' y NINGUNA ficha ni estado inventados", () => {
    const { el } = montar(<AgentRunCard nombre="WhatsApp" href="/x" />);
    expect(el.querySelector("[data-tone]")).toBeNull();
    expect(el.querySelector("a")).toBeNull();
    const p = el.querySelector("p")!;
    expect(p.textContent).toBe("Sin corridas registradas.");
    expect(p.className).toBe("mt-1 text-xs text-faint");
  });

  it("con corrida pero sin ficha no pinta el enlace", () => {
    const { el } = montar(<AgentRunCard nombre="Voz" estado={{ tone: "danger", etiqueta: "Falló" }} meta="hoy" />);
    expect(el.querySelector("a")).toBeNull();
    expect(el.querySelector("p")!.textContent).toBe("hoy");
  });
});

describe("RadioSegmentado", () => {
  const OPCIONES = [
    { id: "aprobar", rotulo: "Aprobar" },
    { id: "ajustar", rotulo: "Ajustar" },
    { id: "rechazar", rotulo: "Rechazar" },
  ] as const;

  function Controlado({ inicial = "aprobar" }: { inicial?: "aprobar" | "ajustar" | "rechazar" }) {
    const [v, setV] = useState<"aprobar" | "ajustar" | "rechazar">(inicial);
    return <RadioSegmentado name="accion" label="Qué hacer" opciones={OPCIONES} value={v} onChange={setV} />;
  }

  it("radiogroup con nombre accesible y un radio real sr-only por opcion", () => {
    const { el } = montar(<Controlado />);
    const grupo = el.querySelector('[role="radiogroup"]')!;
    expect(grupo.getAttribute("aria-label")).toBe("Qué hacer");
    const radios = Array.from(grupo.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios.map((r) => r.value)).toEqual(["aprobar", "ajustar", "rechazar"]);
    expect(new Set(radios.map((r) => r.name))).toEqual(new Set(["accion"]));
    for (const r of radios) expect(r.className).toBe("sr-only");
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
  });

  it("pildora activa en azul de marca e inactiva con hairline; 12.5 px, rounded-lg", () => {
    const { el } = montar(<Controlado />);
    const [a, b] = Array.from(el.querySelectorAll("label"));
    expect(a!.className).toContain("bg-primary text-primary-foreground");
    expect(a!.className).toContain("text-pill");
    expect(a!.className).toContain("font-medium");
    expect(a!.className).toContain("rounded-lg");
    expect(a!.className).toContain("px-3");
    expect(a!.className).toContain("py-1.5");
    expect(b!.className).toContain("border border-border bg-card");
    expect(b!.className).not.toContain("bg-primary");
  });

  it("elegir otra opcion llama a onChange y mueve el estado activo", () => {
    const { el } = montar(<Controlado />);
    const radios = el.querySelectorAll<HTMLInputElement>("input");
    act(() => radios[1]!.click());
    expect(radios[1]!.checked).toBe(true);
    expect(el.querySelectorAll("label")[1]!.className).toContain("bg-primary");
    expect(el.querySelectorAll("label")[0]!.className).not.toContain("bg-primary");
  });

  it("disabled bloquea los radios", () => {
    const onChange = vi.fn();
    const { el } = montar(<RadioSegmentado name="n" label="g" opciones={OPCIONES} value="aprobar" onChange={onChange} disabled />);
    for (const r of Array.from(el.querySelectorAll("input"))) expect(r.disabled).toBe(true);
    act(() => el.querySelectorAll("input")[1]!.click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("el foco visible se pinta en el label (regla de index.css) con anillo de 3 px", () => {
    expect(css).toMatch(/label:has\(> input\.sr-only:focus-visible\)\s*\{\s*outline:\s*3px solid hsl\(var\(--ring\)\);\s*outline-offset:\s*2px;/);
  });
});

describe("Odometro", () => {
  const digitos = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('[data-testid="odometro-digito"]'));

  it("lg: tableros de 33x45, fuente 29, radio 7 y prefijo de 23 px", () => {
    const { el } = montar(<Odometro valor={1234} digitos={7} prefijo="$" etiqueta="MRR — META $1,000,000" tamano="lg" />);
    const ds = digitos(el);
    expect(ds.map((d) => d.textContent)).toEqual(["0", "0", "0", "1", "2", "3", "4"]);
    for (const d of ds) {
      expect(d.style.width).toBe("33px");
      expect(d.style.height).toBe("45px");
      expect(d.style.borderRadius).toBe("7px");
      expect((d.querySelector("span") as HTMLElement).style.fontSize).toBe("29px");
      expect(d.className).toContain("odometro-digito");
    }
    const prefijo = el.querySelector('[data-testid="odometro"] span[aria-hidden="true"]') as HTMLElement;
    expect(prefijo.textContent).toBe("$");
    expect(prefijo.style.fontSize).toBe("23px");
  });

  it("md: 20x27, fuente 18, radio 5, prefijo 16", () => {
    const { el } = montar(<Odometro valor={5} digitos={2} prefijo="$" etiqueta="X" />);
    const d = digitos(el)[0]!;
    expect([d.style.width, d.style.height, d.style.borderRadius]).toEqual(["20px", "27px", "5px"]);
    expect((d.querySelector("span") as HTMLElement).style.fontSize).toBe("18px");
  });

  it("los tokens del tablero y la raya central existen en index.css (#262626 -> #141414, 1 px 50 %)", () => {
    expect(css).toMatch(/--odometro-a:\s*#262626;/);
    expect(css).toMatch(/--odometro-b:\s*#141414;/);
    expect(css).toMatch(/\.odometro-digito\s*\{[^}]*linear-gradient\(180deg, var\(--odometro-a\), var\(--odometro-b\)\)/);
    const { el } = montar(<Odometro valor={1} digitos={1} etiqueta="X" />);
    const raya = el.querySelector(".odometro-raya")!;
    expect(raya.className).toContain("h-px");
    expect(css).toMatch(/\.odometro-raya\s*\{\s*background:\s*var\(--odometro-raya\)/);
  });

  it("solo en >= sm (hidden sm:flex) y rotulo de 12 px semibold mayusculas", () => {
    const { el } = montar(<Odometro valor={10} digitos={2} etiqueta="MRR" />);
    const raiz = el.querySelector('[data-testid="odometro"]')!;
    expect(raiz.className).toBe("hidden shrink-0 flex-col items-end gap-2 sm:flex");
    const rotulo = Array.from(raiz.querySelectorAll("span")).find((s) => s.textContent === "MRR")!;
    expect(rotulo.className).toBe("whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-muted-foreground");
  });

  it("a11y: un solo nombre accesible con el total y los digitos ocultos al lector", () => {
    const { el } = montar(<Odometro valor={1000000} digitos={7} prefijo="$" etiqueta="MRR" />);
    const raiz = el.querySelector('[data-testid="odometro"]')!;
    expect(raiz.getAttribute("role")).toBe("group");
    expect(raiz.getAttribute("aria-label")).toBe("MRR: $1,000,000");
    for (const d of digitos(el)) expect(d.getAttribute("aria-hidden")).toBe("true");
  });

  it("valor null = '—' con el motivo; nunca un cero", () => {
    const { el } = montar(<Odometro valor={null} digitos={7} prefijo="$" etiqueta="MRR" sinDato="algún plan sin precio" />);
    expect(digitos(el)).toHaveLength(0);
    expect(el.textContent).toContain("—");
    expect(el.textContent).toContain("algún plan sin precio");
    expect(el.textContent).not.toContain("0");
    expect(el.querySelector('[data-testid="odometro"]')!.getAttribute("aria-label")).toBe("MRR: algún plan sin precio");
  });

  it("valores no medibles (NaN, negativo) caen al estado sin dato", () => {
    expect(montar(<Odometro valor={Number.NaN} digitos={3} etiqueta="A" />).el.textContent).toContain("sin medir");
    expect(montar(<Odometro valor={-5} digitos={3} etiqueta="B" />).el.textContent).toContain("sin medir");
  });

  it("valor 0 real SI se pinta como ceros (medido) y no como sin dato", () => {
    const { el } = montar(<Odometro valor={0} digitos={3} etiqueta="MRR" />);
    expect(digitos(el).map((d) => d.textContent)).toEqual(["0", "0", "0"]);
  });

  it("meta: barra azul con el avance real y porcentaje; sin meta no hay barra", () => {
    const { el } = montar(<Odometro valor={250000} digitos={7} prefijo="$" etiqueta="MRR — META $1,000,000" meta={1_000_000} />);
    const barra = el.querySelector('[role="progressbar"]')!;
    expect(barra.getAttribute("aria-valuenow")).toBe("25");
    expect(barra.getAttribute("aria-label")).toBe("Avance hacia la meta");
    const relleno = el.querySelector('[data-testid="odometro-avance"]') as HTMLElement;
    expect(relleno.className).toContain("bg-primary");
    expect(relleno.style.width).toBe("25%");
    expect(el.textContent).toContain("25% de la meta");
    expect(montar(<Odometro valor={5} digitos={1} etiqueta="X" />).el.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("avanceHaciaMeta acota a 0-100", () => {
    expect(avanceHaciaMeta(2_000_000, 1_000_000)).toBe(100);
    expect(avanceHaciaMeta(0, 1_000_000)).toBe(0);
    expect(avanceHaciaMeta(333_334, 1_000_000)).toBe(33);
  });

  it("el volteo de 420 ms: aparece la hoja al cambiar el digito y se retira sola", () => {
    vi.useFakeTimers();
    const m = montar(<Odometro valor={1} digitos={2} etiqueta="X" />);
    expect(m.el.querySelector('[data-testid="odometro-hoja"]')).toBeNull();
    m.rerender(<Odometro valor={2} digitos={2} etiqueta="X" />);
    const hoja = m.el.querySelector('[data-testid="odometro-hoja"]')!;
    expect(hoja.textContent).toBe("1");
    act(() => {
      vi.advanceTimersByTime(ODOMETRO_VOLTEO_MS - 1);
    });
    expect(m.el.querySelector('[data-testid="odometro-hoja"]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(m.el.querySelector('[data-testid="odometro-hoja"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("la animacion dura 420 ms y se apaga con prefers-reduced-motion", () => {
    expect(ODOMETRO_VOLTEO_MS).toBe(420);
    expect(css).toMatch(/\.odometro-hoja\s*\{[^}]*animation:\s*reloj-flip 420ms/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.odometro-hoja\s*\{\s*animation:\s*none/);
  });
});

describe("ResumenLayout", () => {
  it("cabecera: h1 de 20 px 'saludo, nombre', subtitulo de 13 px y destacado a la derecha", () => {
    const { el } = montar(<ResumenLayout saludo="Buenas tardes" nombre="Javier" subtitulo="Todo Atiende en una pantalla" destacado={<span data-testid="dest">D</span>} />);
    const h1 = el.querySelector("h1")!;
    expect(h1.textContent).toBe("Buenas tardes, Javier");
    expect(h1.className).toBe("truncate font-display text-xl font-semibold text-foreground");
    expect(el.querySelector("h1 + p")!.className).toBe("mt-1 truncate text-ui text-muted-foreground");
    expect(el.querySelectorAll("h1")).toHaveLength(1);
    const cab = h1.parentElement!.parentElement!;
    expect(cab.className).toBe("flex min-w-0 flex-col gap-2.5 pb-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3");
    expect(cab.lastElementChild!.className).toBe("flex shrink-0 items-center gap-2.5 sm:pt-1");
    expect(el.querySelector('[data-testid="dest"]')).not.toBeNull();
  });

  it("sin destacado, kpis, acciones ni hijos solo pinta la cabecera (nada vacio)", () => {
    const { el } = montar(<ResumenLayout saludo="Hola" nombre="Ana" />);
    expect(el.querySelector("h1 + p")).toBeNull();
    expect(el.querySelector(".space-y-2\\.5")).toBeNull();
    expect(el.querySelector(".grid")).toBeNull();
  });

  it("cuerpo: space-y-2.5, rejilla de KPIs 2/4 col gap-2, pildoras a la derecha, luego secciones", () => {
    const { el } = montar(
      <ResumenLayout
        saludo="Hola"
        nombre="Ana"
        kpis={[<div key="a">k1</div>, <div key="b">k2</div>]}
        acciones={<PillLink to="/x">Ver x</PillLink>}
      >
        <ResumenSeccion titulo="Orquestación de agentes">
          <TileLink to="/a" icon={Activity} titulo="A" />
        </ResumenSeccion>
      </ResumenLayout>,
    );
    const cuerpo = el.querySelector(".space-y-2\\.5")!;
    const hijos = Array.from(cuerpo.children);
    expect(hijos[0]!.className).toBe("grid grid-cols-2 gap-2 md:grid-cols-4");
    expect(hijos[1]!.className).toBe("flex flex-wrap justify-end gap-2");
    expect(hijos[2]!.className).toContain("p-3");
    expect(hijos[0]!.textContent).toBe("k1k2");
  });

  it("ResumenSeccion: region con nombre accesible = su rotulo y rejilla de 1/2/3 col gap-1.5", () => {
    const { el } = montar(
      <ResumenSeccion titulo="Operación">
        <TileLink to="/a" icon={Activity} titulo="A" />
      </ResumenSeccion>,
    );
    const region = el.querySelector('[role="region"]')!;
    const rotulo = region.querySelector("h2")!;
    expect(region.getAttribute("aria-labelledby")).toBe(rotulo.id);
    expect(rotulo.id).not.toBe("");
    expect(region.className).toContain("p-3");
    expect(region.className).toContain("rounded-lg");
    expect(rotulo.nextElementSibling!.className).toBe("mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3");
  });
});
