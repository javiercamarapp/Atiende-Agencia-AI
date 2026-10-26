// @vitest-environment jsdom
//
// ds3 / 2.2: delegacion de la carga en CargandoLogo. Con la bandera APAGADA el DOM es el de siempre (esqueletos, Loader2 girando);
// con `html[data-diseno="ds3"]` (que la bandera lee al cargar el modulo) TODO lo que carga pinta solo el logo, sin texto visible,
// conservando nombre, props y ARIA.
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

type Modulos = {
  EstadoCargando: typeof import("../src/components/EstadoCargando").EstadoCargando;
  Button: typeof import("../src/components/ui/button").Button;
  Skeleton: typeof import("../src/components/ui/skeleton").Skeleton;
  RegionCargando: typeof import("../src/components/CargandoDelegado").RegionCargando;
  reiniciar: typeof import("../src/lib/carga-coordinador").reiniciarCoordinadorCarga;
};

async function cargar(ds3: boolean): Promise<Modulos> {
  vi.resetModules();
  if (ds3) document.documentElement.dataset.diseno = "ds3";
  else delete document.documentElement.dataset.diseno;
  const [e, b, s, r, c] = await Promise.all([
    import("../src/components/EstadoCargando"),
    import("../src/components/ui/button"),
    import("../src/components/ui/skeleton"),
    import("../src/components/CargandoDelegado"),
    import("../src/lib/carga-coordinador"),
  ]);
  return { EstadoCargando: e.EstadoCargando, Button: b.Button, Skeleton: s.Skeleton, RegionCargando: r.RegionCargando, reiniciar: c.reiniciarCoordinadorCarga };
}

let raices: Array<{ root: Root; el: HTMLElement }> = [];
function montar(ui: ReactElement) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(ui));
  raices.push({ root, el });
  return { root, el };
}
const avanzar = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
/** Texto que veria una persona: sin sr-only y sin lo aria-hidden. */
function textoVisible(el: HTMLElement): string {
  const clon = el.cloneNode(true) as HTMLElement;
  clon.querySelectorAll(".sr-only, [aria-hidden='true']").forEach((n) => n.remove());
  return clon.textContent?.trim() ?? "";
}

let m: Modulos | null = null;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  act(() => raices.forEach((r) => r.root.unmount()));
  raices.forEach((r) => r.el.remove());
  raices = [];
  m?.reiniciar();
  m = null;
  delete document.documentElement.dataset.diseno;
  vi.useRealTimers();
});

describe("bandera APAGADA: el DOM de produccion no cambia", () => {
  it("EstadoCargando conserva esqueletos, role/aria y sr-only", async () => {
    m = await cargar(false);
    const { el } = montar(createElement(m.EstadoCargando, { etiqueta: "Cargando pedidos", lineas: 3 }));
    const nodo = el.querySelector('[role="status"]')!;
    expect(nodo.getAttribute("aria-busy")).toBe("true");
    expect(nodo.getAttribute("aria-label")).toBe("Cargando pedidos");
    expect(nodo.querySelectorAll(".ds-skeleton")).toHaveLength(3);
    expect(nodo.querySelector(".sr-only")!.textContent).toBe("Cargando pedidos");
    expect(el.querySelector("[data-carga-tamano]")).toBeNull();
  });

  it("EstadoCargando pantalla conserva el glifo y el texto visible", async () => {
    m = await cargar(false);
    const { el } = montar(createElement(m.EstadoCargando, { variante: "pantalla", etiqueta: "Cargando…" }));
    expect(el.querySelector(".atiende-respira")).not.toBeNull();
    expect(textoVisible(el)).toBe("Cargando…");
  });

  it("Button loading muestra el Loader2 girando, aria-busy y disabled", async () => {
    m = await cargar(false);
    const { el } = montar(createElement(m.Button, { loading: true }, "Guardar"));
    const b = el.querySelector("button")!;
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.disabled).toBe(true);
    expect(b.querySelector("svg.animate-spin")).not.toBeNull();
    expect(el.querySelector("[data-carga-tamano]")).toBeNull();
  });

  it("Skeleton conserva .ds-skeleton y RegionCargando el contenedor con su aria-label", async () => {
    m = await cargar(false);
    const { el } = montar(
      createElement(m.RegionCargando, { etiqueta: "Cargando notificaciones", className: "grid" }, createElement(m.Skeleton, { className: "h-3" })),
    );
    expect(el.querySelector(".ds-skeleton")).not.toBeNull();
    expect(el.querySelector('[role="status"]')!.getAttribute("aria-label")).toBe("Cargando notificaciones");
  });
});

describe("bandera ENCENDIDA (?diseno=ds3): solo el logo", () => {
  it.each(["bloque", "tabla", "tarjeta", "pantalla"] as const)("EstadoCargando %s: logo, misma etiqueta ARIA, sin esqueleto ni texto visible", async (variante) => {
    m = await cargar(true);
    const { el } = montar(createElement(m.EstadoCargando, { variante, etiqueta: "Cargando pedidos" }));
    const nodo = el.querySelector('[role="status"]')!;
    expect(nodo.getAttribute("aria-label")).toBe("Cargando pedidos");
    expect(nodo.getAttribute("aria-busy")).toBe("true");
    expect(nodo.querySelector(".sr-only")!.textContent).toBe("Cargando pedidos");
    expect(el.querySelector(".ds-skeleton")).toBeNull();
    expect(el.querySelector(".animate-pulse, .animate-spin, .atiende-respira")).toBeNull();
    expect(textoVisible(el)).toBe("");
    expect(nodo.getAttribute("data-carga-tamano")).toBe(variante === "pantalla" ? "pantalla" : "panel");
  });

  it("la region conserva su altura minima (sin salto de layout)", async () => {
    m = await cargar(true);
    const { el } = montar(createElement(m.EstadoCargando, { variante: "tabla" }));
    expect(el.querySelector('[role="status"]')!.className).toContain("min-h-60");
  });

  it("RegionCargando conserva el aria-label contextual («Cargando notificaciones») y no pinta los hijos", async () => {
    m = await cargar(true);
    const { el } = montar(
      createElement(m.RegionCargando, { etiqueta: "Cargando notificaciones", className: "grid", claseDs3: "min-h-24" }, createElement("p", null, "hijo")),
    );
    const nodo = el.querySelector('[role="status"]')!;
    expect(nodo.getAttribute("aria-label")).toBe("Cargando notificaciones");
    expect(nodo.className).toContain("min-h-24");
    expect(nodo.className).not.toContain("grid");
    expect(el.textContent).not.toContain("hijo");
  });

  it("RegionCargando sin aria-label usa etiquetaDs3 como nombre", async () => {
    m = await cargar(true);
    const { el } = montar(createElement(m.RegionCargando, { etiquetaDs3: "Cargando pedidos…" }));
    expect(el.querySelector('[role="status"]')!.getAttribute("aria-label")).toBe("Cargando pedidos…");
  });

  it("Button loading: logo de linea decorativo, sin cambiar el nombre accesible, aria-busy y disabled", async () => {
    m = await cargar(true);
    const { el } = montar(createElement(m.Button, { loading: true }, "Guardar"));
    const b = el.querySelector("button")!;
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.disabled).toBe(true);
    expect(b.querySelector("svg.animate-spin")).toBeNull();
    const logo = b.querySelector('[data-carga-tamano="linea"]')!;
    expect(logo).not.toBeNull();
    expect(logo.getAttribute("aria-hidden")).toBe("true");
    expect(logo.tagName).toBe("SPAN");
    expect(b.querySelector('[role="status"]')).toBeNull();
    expect(b.textContent).toBe("Guardar");
  });

  it("Button: al terminar mantiene el logo la permanencia minima (400 ms) y luego vuelve el icono", async () => {
    m = await cargar(true);
    const M = m;
    const icono = createElement("i", { "data-icono": "" });
    const ui = (loading: boolean) => createElement(M.Button, { loading, iconLeft: icono }, "Guardar");
    const { root, el } = montar(ui(true));
    avanzar(120); // el logo aparece a los 120 ms
    expect(el.querySelector('[data-carga-visible="true"]')).not.toBeNull();
    act(() => root.render(ui(false)));
    const b = el.querySelector("button")!;
    expect(b.disabled).toBe(false);
    expect(b.hasAttribute("aria-busy")).toBe(false);
    expect(b.querySelector("[data-carga-tamano]")).not.toBeNull(); // retenido
    expect(b.querySelector("[data-icono]")).toBeNull();
    avanzar(400);
    expect(b.querySelector("[data-carga-tamano]")).toBeNull();
    expect(b.querySelector("[data-icono]")).not.toBeNull();
  });

  it("una carga que termina antes de 120 ms nunca muestra el logo", async () => {
    m = await cargar(true);
    const M = m;
    const { root, el } = montar(createElement(M.Button, { loading: true }, "Guardar"));
    avanzar(50);
    act(() => root.render(createElement(M.Button, { loading: false }, "Guardar")));
    expect(el.querySelector("[data-carga-tamano]")).toBeNull();
    avanzar(500);
    expect(el.querySelector('[data-carga-visible="true"]')).toBeNull();
  });

  it("Skeleton ya no dibuja el barrido: hueco transparente que conserva medidas y esta oculto a lectores", async () => {
    m = await cargar(true);
    const { el } = montar(createElement(m.Skeleton, { className: "h-4 w-1/2" }));
    const s = el.firstElementChild!;
    expect(s.className).not.toContain("ds-skeleton");
    expect(s.className).not.toContain("bg-canvas");
    expect(s.className).toContain("h-4");
    expect(s.getAttribute("aria-hidden")).toBe("true");
  });

  it("E23: varias cargas a la vez (region + boton) dibujan UN solo logo", async () => {
    m = await cargar(true);
    const M = m;
    montar(
      createElement(
        "div",
        null,
        createElement(M.EstadoCargando, { variante: "tabla" }),
        createElement(M.EstadoCargando, { variante: "bloque" }),
        createElement(M.Button, { loading: true }, "Guardar"),
      ),
    );
    avanzar(120);
    expect(document.querySelectorAll('[data-carga-visible="true"]')).toHaveLength(1);
  });

  it("pantalla: wordmark de 120 px y simbolo de respaldo cuando la ventana mide menos de 420 px de alto", async () => {
    m = await cargar(true);
    const { el } = montar(createElement(m.EstadoCargando, { variante: "pantalla" }));
    const dibujo = el.querySelector(".carga-logo")!;
    const envoltura = dibujo.children[0] as HTMLElement;
    expect(envoltura.className).toContain("w-[120px]");
    expect(envoltura.className).toContain("max-height:419px");
    expect(envoltura.textContent).toBe("atiende");
    const simbolo = dibujo.children[1]!;
    expect(simbolo.tagName.toLowerCase()).toBe("svg");
    expect(simbolo.getAttribute("class")).toContain("hidden");
    expect(simbolo.getAttribute("class")).toContain("max-height:419px");
  });
});
