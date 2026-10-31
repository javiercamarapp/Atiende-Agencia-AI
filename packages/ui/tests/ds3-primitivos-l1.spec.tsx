// @vitest-environment jsdom
//
// ds3 / L1 (§3.2-§3.5): Card, StatCard, KpiTile, campos, Checkbox, Switch, FormField, Badge, StatusBadge, KindBadge, Tabs y el tope de CargandoLogo.
// jsdom no resuelve var() ni Tailwind, asi que el spec afirma (1) sobre index.css (parseado con postcss) que TODA regla `ds3-*` cuelga de la bandera
// y que cada clase `ds3-*` aparece literal en el codigo (Tailwind solo emite las reglas de `@layer utilities` cuyas clases ve), (2) contrastes AA/no-texto
// de los pares que usan los primitivos, (3) el DOM/ARIA/props de cada componente (APIs publicas intactas) y (4) que cn() no se come los tamanos nuevos.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import postcss, { type AtRule, type Container, type Rule } from "postcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contraste, parseHsl } from "../src/lib/contraste";
import { cn } from "../src/lib/utils";
import { Badge } from "../src/components/ui/badge";
import { Card, Panel, CardHeader, CardTitle, CardContent, CardFooter } from "../src/components/ui/card";
import { Checkbox } from "../src/components/ui/checkbox";
import { FormField } from "../src/components/ui/form-field";
import { Input } from "../src/components/ui/input";
import { KindBadge, KIND_TIPOS } from "../src/components/ui/kind-badge";
import { NativeSelect } from "../src/components/ui/native-select";
import { StatusBadge, STATUS_TONES } from "../src/components/ui/status-badge";
import { Switch } from "../src/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../src/components/ui/tabs";
import { Textarea } from "../src/components/ui/textarea";
import { StatCard } from "../src/components/StatCard";
import { KpiTile } from "../src/components/KpiTile";
import { CargandoLogo } from "../src/components/CargandoLogo";
import { CARGA_TOPE_MS, reiniciarCoordinadorCarga } from "../src/lib/carga-coordinador";
import preset from "../src/tailwind-preset";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const aqui = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(aqui, "../src/index.css"), "utf8");
const raiz = postcss.parse(css);
const BANDERA = 'html[data-diseno="ds3"]';

function archivos(dir: string, salida: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) archivos(p, salida);
    else if (/\.(tsx|ts)$/.test(n)) salida.push(p);
  }
  return salida;
}
const fuente = archivos(join(aqui, "../src")).map((f) => readFileSync(f, "utf8")).join("\n");

// ---- 1. CSS ---------------------------------------------------------------------------------------------------------------------------
const reglasDs3: Rule[] = [];
raiz.walkRules((r) => {
  if (r.selectors.some((s) => /\.ds3-(card|stat|kpi|campo|textarea|native|check|switch|label|field|badge|status|kind|tabs)/.test(s))) reglasDs3.push(r);
});

describe("ds3 L1: CSS de los primitivos", () => {
  it("hay reglas y todas cuelgan de la bandera html[data-diseno=\"ds3\"] (sin ella no cambia nada)", () => {
    expect(reglasDs3.length).toBeGreaterThan(60);
    for (const r of reglasDs3) for (const s of r.selectors) expect(s.trim().startsWith(BANDERA), s).toBe(true);
  });

  it("cada clase ds3-* de las reglas aparece LITERAL en el codigo (si no, Tailwind purga la regla)", () => {
    const clases = new Set<string>();
    for (const r of reglasDs3) for (const m of r.selector.matchAll(/\.(ds3-[a-z0-9-]+)/g)) clases.add(m[1]!);
    const faltan = [...clases].filter((c) => !new RegExp(`(?<![\\w-])${c}(?![\\w-])`).test(fuente));
    expect(faltan).toEqual([]);
  });

  it("ninguna regla ds3 de L1 usa sombra, !important ni anima propiedades de layout", () => {
    for (const r of reglasDs3) {
      r.walkDecls((d) => {
        if (d.prop === "box-shadow") expect(d.value, r.selector).toMatch(/^(none|0 0 0 2px hsl\(var\(--(ring|danger-ink)\)\)|inset 0 -2px 0 hsl\(var\(--action\)\))$/);
        expect(d.important, `${r.selector} ${d.prop}`).toBe(false);
        if (d.prop === "transition-property") expect(d.value).not.toMatch(/width|height|margin|padding|top|left/);
      });
    }
  });

  it("alturas de campo y de interruptor: control-md (campo), 32x18 con perilla de 14 (Switch), caja de 16 (Checkbox), chip de 24", () => {
    const decl = (sel: string, prop: string) => {
      let v = "";
      raiz.walkRules((r) => {
        if (r.selectors.map((s) => s.replace(/\s+/g, " ").trim()).includes(sel)) r.walkDecls(prop, (d) => void (v = d.value));
      });
      return v;
    };
    expect(decl(`${BANDERA} .ds3-switch.ds3-switch`, "width")).toBe("2rem");
    expect(decl(`${BANDERA} .ds3-switch.ds3-switch`, "height")).toBe("1.125rem");
    expect(decl(`${BANDERA} .ds3-switch-perilla.ds3-switch-perilla`, "width")).toBe("0.875rem");
    expect(decl(`${BANDERA} .ds3-check.ds3-check`, "width")).toBe("1rem");
    expect(decl(`${BANDERA} .ds3-stat-chip.ds3-stat-chip, ${BANDERA} .ds3-kpi-chip.ds3-kpi-chip`.split(", ")[0]!, "width")).toBe("1.5rem");
    expect(decl(`${BANDERA} .ds3-badge.ds3-badge`, "height")).toBe("1.25rem");
    expect(decl(`${BANDERA} .ds3-campo.ds3-textarea`, "min-height")).toBe("4rem");
  });

  it("tactil: el campo sube a 16 px (iOS no hace zoom) y Checkbox/Switch ganan area de toque de --target-min", () => {
    let campo16 = false;
    let areas = 0;
    raiz.walkRules((r) => {
      const m = r.parent as Container;
      if (m.type !== "atrule" || (m as AtRule).name !== "media" || !(m as AtRule).params.includes("pointer: coarse")) return;
      if (r.selectors.some((s) => s.includes(".ds3-campo.ds3-campo"))) r.walkDecls("font-size", (d) => void (campo16 = d.value === "1rem"));
      if (r.selectors.some((s) => /ds3-(check-input|switch)\.ds3-(check-input|switch)(::after)?$/.test(s.trim())) && r.toString().includes("--target-min")) areas++;
    });
    expect(campo16).toBe(true);
    expect(areas).toBeGreaterThanOrEqual(2);
  });
});

// ---- 2. Contrastes ----------------------------------------------------------------------------------------------------------------------
function tokens(selector: string): Record<string, string> {
  const t: Record<string, string> = {};
  raiz.walkRules((r) => {
    if ((r.parent as Container).type === "root" || (r.parent as AtRule).name === "layer")
      if (r.selectors.map((s) => s.trim()).includes(selector)) r.walkDecls((d) => void (t[d.prop] = d.value.trim()));
  });
  return t;
}
const claro = { ...tokens(":root"), ...tokens(BANDERA) };
const oscuro = { ...claro, ...tokens(".dark"), ...tokens(`${BANDERA}.dark`) };
const rat = (t: Record<string, string>, a: string, b: string) => contraste(parseHsl(t[a]!), parseHsl(t[b]!));

describe("ds3 L1: contraste AA de los pares que usan los primitivos", () => {
  for (const [modo, t] of [["claro", claro], ["oscuro", oscuro]] as const) {
    it(`${modo}: tinta de cada tono sobre su tinte >= 4,5 (StatusBadge y Badge)`, () => {
      for (const tono of ["success", "warning", "danger", "info"]) expect(rat(t, `--${tono}-ink`, `--${tono}-tint`), tono).toBeGreaterThanOrEqual(4.5);
    });
    it(`${modo}: Badge default (primary-ink sobre primary-soft), neutro (muted-foreground sobre soft) y tab inactiva >= 4,5`, () => {
      expect(rat(t, "--primary-ink", "--primary-soft")).toBeGreaterThanOrEqual(4.5);
      expect(rat(t, "--muted-foreground", "--soft")).toBeGreaterThanOrEqual(4.5);
      expect(rat(t, "--muted-foreground", "--card")).toBeGreaterThanOrEqual(4.5);
      expect(rat(t, "--muted-foreground", "--background")).toBeGreaterThanOrEqual(4.5);
    });
    it(`${modo}: borde de campo (--input) >= 3:1 contra card y contra el fondo; foco (--ring) >= 3:1; subrayado de tab (--action) >= 3:1`, () => {
      expect(rat(t, "--input", "--card")).toBeGreaterThanOrEqual(3);
      expect(rat(t, "--input", "--background")).toBeGreaterThanOrEqual(3);
      expect(rat(t, "--ring", "--card")).toBeGreaterThanOrEqual(3);
      expect(rat(t, "--action", "--card")).toBeGreaterThanOrEqual(3);
    });
    it(`${modo}: error de campo (--danger-ink) sobre card >= 4,5 y borde punteado del KindBadge inferido (--kind-inferred, no texto) >= 3`, () => {
      expect(rat(t, "--danger-ink", "--card")).toBeGreaterThanOrEqual(4.5);
      expect(rat(t, "--kind-inferred", "--card")).toBeGreaterThanOrEqual(3);
    });
  }
  it("filete de Card highlight: las 8 series existen como color de Tailwind (clases estaticas border-t-chart-n)", () => {
    const chart = (preset.theme as { extend: { colors: { chart: Record<string, string> } } }).extend.colors.chart;
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) expect(chart[String(n)]).toBe(`hsl(var(--chart-${n}))`);
  });
});

describe("ds3 L1: cn() conoce los tamanos nuevos", () => {
  it("text-page y text-kpi no se confunden con un color (no descartan ni son descartados por text-foreground)", () => {
    expect(cn("text-page", "text-foreground")).toBe("text-page text-foreground");
    expect(cn("text-kpi", "text-muted-foreground")).toBe("text-kpi text-muted-foreground");
    expect(cn("text-ui", "text-kpi")).toBe("text-kpi");
    expect(cn("text-2xs", "text-faint")).toBe("text-2xs text-faint");
  });
  it("el preset declara page y kpi con respaldo (produccion sin la bandera no queda con var() invalida)", () => {
    const fs = (preset.theme as { extend: { fontSize: Record<string, [string, { lineHeight: string }]> } }).extend.fontSize;
    expect(fs.page![0]).toBe("var(--text-page, 1.25rem)");
    expect(fs.kpi![0]).toContain("var(--text-kpi, ");
  });
});

// ---- 3. DOM / ARIA / props ----------------------------------------------------------------------------------------------------------
let raices: Array<{ root: Root; el: HTMLElement }> = [];
function montar(ui: ReactElement): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(ui));
  raices.push({ root, el });
  return el;
}
beforeEach(() => {
  reiniciarCoordinadorCarga();
});
afterEach(() => {
  for (const { root, el } of raices) {
    act(() => root.unmount());
    el.remove();
  }
  raices = [];
  vi.useRealTimers();
  reiniciarCoordinadorCarga();
});
const h = createElement;

describe("ds3 L1: Card y variantes", () => {
  it("Card conserva la clase `card` (gancho de `.card table`), el reenvio de props y la forma por defecto", () => {
    const el = montar(h(Card, { "data-testid": "c", className: "p-3" }, "x"));
    const c = el.querySelector("[data-testid=c]")!;
    expect(c.classList.contains("card")).toBe(true);
    expect(c.classList.contains("ds3-card")).toBe(true);
    expect(c.classList.contains("p-3")).toBe(true);
    expect(c.hasAttribute("data-variante")).toBe(false);
  });
  it.each([["flush"], ["bare"], ["interactive"], ["highlight"]] as const)("variante %s marca clase y data-variante", (v) => {
    const el = montar(h(Card, { variante: v, "data-testid": "c" }, "x"));
    const c = el.querySelector("[data-testid=c]")!;
    expect(c.classList.contains(`ds3-card-${v}`)).toBe(true);
    expect(c.getAttribute("data-variante")).toBe(v);
  });
  it("highlight con tono usa la clase estatica border-t-chart-n; sin highlight el tono se ignora", () => {
    const a = montar(h(Card, { variante: "highlight", tono: 3, "data-testid": "c" }, "x")).querySelector("[data-testid=c]")!;
    expect(a.classList.contains("border-t-chart-3")).toBe(true);
    const b = montar(h(Card, { tono: 3, "data-testid": "d" }, "x")).querySelector("[data-testid=d]")!;
    expect(b.className).not.toContain("border-t-chart");
  });
  it("anatomia: CardTitle sigue siendo h2 y Panel conserva su etiqueta y relleno", () => {
    const el = montar(h(Panel, { as: "section", relleno: "sm" }, h(CardHeader, null, h(CardTitle, null, "Titulo")), h(CardContent, null, "c"), h(CardFooter, null, "f")));
    expect(el.querySelector("section")!.classList.contains("ds3-card-panel-sm")).toBe(true);
    expect(el.querySelector("h2")!.textContent).toBe("Titulo");
    expect(el.querySelector(".ds3-card-header")).not.toBeNull();
    expect(el.querySelector(".ds3-card-footer")).not.toBeNull();
  });
});

describe("ds3 L1: StatCard y KpiTile", () => {
  const Icono = () => h("svg", { "aria-hidden": true });
  it("StatCard conserva chip, etiqueta, cifra y pie; las clases ds3 estan puestas", () => {
    const el = montar(h(StatCard, { icon: Icono, label: "Ventas", value: "$10", delta: { pct: 5, bueno: true } }));
    expect(el.querySelector("[data-testid=stat-card-chip]")!.classList.contains("ds3-stat-chip")).toBe(true);
    expect(el.querySelector(".ds3-stat-valor")!.textContent).toBe("$10");
    expect(el.querySelector(".ds3-stat-pie")!.textContent).toContain("5%");
    expect(el.querySelector("p.ds3-stat-valor")).not.toBeNull();
  });
  it("StatCard sinDato: guion y aria-label (desconocido nunca es cero)", () => {
    const el = montar(h(StatCard, { icon: Icono, label: "Ventas", value: "$0", sinDato: "Pendiente" }));
    expect(el.querySelector(".ds3-stat-valor")!.textContent).toBe("—");
    expect(el.querySelector(".ds3-stat-valor")!.getAttribute("aria-label")).toBe("Ventas: sin dato");
  });
  it("StatCard cargando: logo en linea con role=status, aria-busy, SIN <p> contenedor del div, y el pie conserva su sitio (invisible, aria-hidden)", () => {
    const el = montar(h(StatCard, { icon: Icono, label: "Ventas", value: "$10", nota: "+3 hoy", cargando: true }));
    const estado = el.querySelector("[role=status]")!;
    expect(estado.getAttribute("aria-label")).toBe("Cargando Ventas");
    expect(estado.getAttribute("data-carga-tamano")).toBe("linea");
    expect(estado.closest("p")).toBeNull();
    expect(el.querySelector(".ds3-stat")!.getAttribute("aria-busy")).toBe("true");
    expect(el.textContent).not.toContain("$10");
    const pie = el.querySelector(".ds3-stat-pie")!;
    expect(pie.className).toContain("invisible");
    expect(pie.getAttribute("aria-hidden")).toBe("true");
  });
  it("KpiTile: no medible = guion; cargando = logo en linea sin cifra; la serie conserva ds3-kpi-spark y la tendencia queda fuera de ella", () => {
    const sinDato = montar(h(KpiTile, { icono: h(Icono), etiqueta: "Ocupacion", valor: null }));
    expect(sinDato.querySelector("[data-testid=kpi-tile-valor]")!.textContent).toBe("—");
    const carga = montar(h(KpiTile, { icono: h(Icono), etiqueta: "Ocupacion", valor: 5, cargando: true }));
    expect(carga.querySelector("[role=status]")!.getAttribute("aria-label")).toBe("Cargando Ocupacion");
    expect(carga.querySelector("[data-testid=kpi-tile-valor]")!.textContent).not.toContain("5");
    const serie = montar(h(KpiTile, { icono: h(Icono), etiqueta: "Ocupacion", valor: 5, tendencia: 2, sparkline: [1, 2, 3] }));
    const spark = serie.querySelector(".ds3-kpi-spark")!;
    expect(spark).not.toBeNull();
    expect(spark.textContent).not.toContain("%");
    expect(spark.parentElement!.textContent).toContain("2%"); // la tendencia (informacion) no se oculta con la serie en movil
  });
});

describe("ds3 L1: campos, Checkbox, Switch y FormField", () => {
  it("Input / Textarea / NativeSelect llevan la marca de campo y siguen siendo controles nativos", () => {
    const el = montar(h("div", null, h(Input, { "aria-label": "a" }), h(Textarea, { "aria-label": "b" }), h(NativeSelect, { "aria-label": "c" }, h("option", { value: "1" }, "Uno"))));
    expect(el.querySelectorAll("input.ds3-campo, textarea.ds3-campo, select.ds3-campo").length).toBe(3);
    expect(el.querySelector("textarea")!.classList.contains("ds3-textarea")).toBe(true);
    expect(el.querySelector("select")!.classList.contains("ds3-native-select")).toBe(true);
    expect(el.querySelector(".ds3-native-chevron")!.getAttribute("aria-hidden")).toBe("true");
  });
  it("Checkbox: input real con marcas, mixto por propiedad `indeterminate` y etiqueta clicable", () => {
    const el = montar(h(Checkbox, { label: "Aceptar", indeterminate: true, readOnly: true, checked: false }));
    const i = el.querySelector("input")!;
    expect(i.type).toBe("checkbox");
    expect(i.indeterminate).toBe(true);
    expect(i.classList.contains("ds3-check-input")).toBe(true);
    expect(el.querySelector("label")!.textContent).toContain("Aceptar");
  });
  it("Switch: role=switch, aria-checked alterna con clic y emite onCheckedChange (API intacta)", () => {
    const cambios: boolean[] = [];
    const el = montar(h(Switch, { "aria-label": "Activo", onCheckedChange: (v: boolean) => cambios.push(v) }));
    const b = el.querySelector("[role=switch]") as HTMLButtonElement;
    expect(b.getAttribute("aria-checked")).toBe("false");
    act(() => b.click());
    expect(b.getAttribute("aria-checked")).toBe("true");
    expect(cambios).toEqual([true]);
    expect(b.classList.contains("ds3-switch")).toBe(true);
    expect(b.querySelector(".ds3-switch-perilla")!.getAttribute("data-state")).toBe("checked");
  });
  it("FormField: etiqueta visible enlazada, ayuda y error por aria-describedby, aria-invalid y error con role=alert", () => {
    const el = montar(h(FormField, { label: "Correo", hint: "nombre@dominio.mx", error: "Falta el arroba", required: true }, h(Input, null)));
    const input = el.querySelector("input")!;
    const label = el.querySelector("label")!;
    expect(label.htmlFor).toBe(input.id);
    expect(label.classList.contains("ds3-label")).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-required")).toBe("true");
    const ids = input.getAttribute("aria-describedby")!.split(" ");
    expect(ids.length).toBe(2);
    const error = el.querySelector("[role=alert]")!;
    expect(error.classList.contains("ds3-field-error")).toBe(true);
    expect(error.textContent).toBe("Falta el arroba");
    expect(ids).toContain(error.id);
    expect(el.querySelector(".ds3-field-hint")!.id).toBe(ids[0]);
    expect(label.textContent).toContain("(obligatorio)");
  });
  it("FormField sin error: ni role=alert ni aria-invalid", () => {
    const el = montar(h(FormField, { label: "Nombre" }, h(Input, null)));
    expect(el.querySelector("[role=alert]")).toBeNull();
    expect(el.querySelector("input")!.hasAttribute("aria-invalid")).toBe(false);
  });
});

describe("ds3 L1: Badge, StatusBadge y KindBadge", () => {
  it("cada variante de Badge lleva su marca de tono y el texto sigue ahi", () => {
    for (const v of ["default", "secondary", "destructive", "outline", "success", "warning", "info"] as const) {
      const el = montar(h(Badge, { variant: v }, `t-${v}`));
      expect(el.querySelector(`.ds3-badge.ds3-badge-v-${v}`)!.textContent).toBe(`t-${v}`);
    }
  });
  it("StatusBadge: los 5 tonos de STATUS_TONES tienen su clase ds3-status-<tono> (1:1), punto aria-hidden y data-tone", () => {
    expect(STATUS_TONES).toEqual(["neutral", "info", "success", "warning", "danger"]);
    for (const tono of STATUS_TONES) {
      const el = montar(h(StatusBadge, { tone: tono }, "Estado"));
      const b = el.querySelector("span")!;
      expect(b.getAttribute("data-tone")).toBe(tono);
      expect(b.classList.contains(`ds3-status-${tono}`)).toBe(true);
      expect(b.querySelector(".ds3-status-punto")!.getAttribute("aria-hidden")).toBe("true");
    }
    const sinPunto = montar(h(StatusBadge, { tone: "success", dot: false }, "Pagado"));
    expect(sinPunto.querySelector(".ds3-status-punto")).toBeNull();
  });
  it("KindBadge: texto + patron para los 4 tipos; el significado no depende del color", () => {
    const esperado = { real: "Real", estimado: "Estimado", inferido: "Inferido", "por-validar": "Por validar" } as const;
    for (const k of KIND_TIPOS) {
      const el = montar(h(KindBadge, { kind: k }));
      const b = el.querySelector("span")!;
      expect(b.textContent).toContain(esperado[k]);
      expect(b.getAttribute("data-kind")).toBe(k);
    }
    expect(montar(h(KindBadge, { kind: "real" })).querySelector("span > span")).not.toBeNull(); // punto solido
    expect(montar(h(KindBadge, { kind: "estimado" })).querySelector("span")!.className).toContain("border-dashed");
    expect(montar(h(KindBadge, { kind: "inferido" })).querySelector("span")!.className).toContain("border-dotted");
    expect(montar(h(KindBadge, { kind: "por-validar" })).querySelector("span")!.textContent).toContain("?");
  });
});

describe("ds3 L1: Tabs", () => {
  it("roles tablist / tab / tabpanel, aria-selected y marcas ds3; el cambio de vista funciona", () => {
    const el = montar(
      h(Tabs, { defaultValue: "a" }, h(TabsList, { "aria-label": "Vistas" }, h(TabsTrigger, { value: "a" }, "Uno"), h(TabsTrigger, { value: "b" }, "Dos")), h(TabsContent, { value: "a" }, "A"), h(TabsContent, { value: "b" }, "B")),
    );
    const lista = el.querySelector("[role=tablist]")!;
    expect(lista.classList.contains("ds3-tabs-list")).toBe(true);
    const tabs = [...el.querySelectorAll("[role=tab]")] as HTMLElement[];
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(tabs.every((t) => t.classList.contains("ds3-tabs-trigger"))).toBe(true);
    expect(el.querySelector("[role=tabpanel]")!.classList.contains("ds3-tabs-content")).toBe(true);
    act(() => {
      tabs[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
  });
});

describe("ds3 L1: CargandoLogo, tope de 20 s", () => {
  it("sin `alTope` no arma temporizador de tope", () => {
    vi.useFakeTimers();
    montar(h(CargandoLogo, { tamano: "panel" }));
    expect(vi.getTimerCount()).toBeLessThanOrEqual(2); // 120 ms de aparicion del coordinador, nada de tope
    vi.advanceTimersByTime(CARGA_TOPE_MS + 1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("con `alTope` llama exactamente una vez a los 20 s (no antes) y el logo sigue siendo role=status", () => {
    vi.useFakeTimers();
    const alTope = vi.fn();
    const el = montar(h(CargandoLogo, { tamano: "pantalla", alTope }));
    act(() => void vi.advanceTimersByTime(CARGA_TOPE_MS - 1));
    expect(alTope).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(2));
    expect(alTope).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(CARGA_TOPE_MS));
    expect(alTope).toHaveBeenCalledTimes(1);
    expect(el.querySelector("[role=status]")!.getAttribute("aria-busy")).toBe("true");
  });
  it("si se desmonta antes del tope no llama a `alTope`", () => {
    vi.useFakeTimers();
    const alTope = vi.fn();
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    act(() => root.render(h(CargandoLogo, { tamano: "panel", alTope })));
    act(() => void vi.advanceTimersByTime(5000));
    act(() => root.unmount());
    el.remove();
    act(() => void vi.advanceTimersByTime(CARGA_TOPE_MS));
    expect(alTope).not.toHaveBeenCalled();
  });
  it("`alTope` no se filtra al DOM como atributo", () => {
    const el = montar(h(CargandoLogo, { tamano: "linea", alTope: () => {} }));
    expect(el.innerHTML).not.toMatch(/altope/i);
  });
});
