// @vitest-environment jsdom
//
// SA-L-02: variante `neutra` del StatCard (chip de la consola de Likida en el acento de Atiende).
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Activity } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { StatCard, TrendStatCard } from "../src/index";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let raices: Array<{ root: Root; el: HTMLElement }> = [];
function montar(ui: ReactElement) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(createElement("div", null, ui)));
  raices.push({ root, el });
  return el;
}
afterEach(() => {
  for (const r of raices) {
    act(() => r.root.unmount());
    r.el.remove();
  }
  raices = [];
});

describe("StatCard variante neutra (SA-L-02)", () => {
  it("neutra = chip de Likida (rounded-lg) en el acento de Atiende; la de marca conserva el circulo", () => {
    const neutra = montar(<StatCard variante="neutra" icon={Activity} label="Orgs" value="12" />);
    const chipN = neutra.querySelector('[data-testid="stat-card-chip"]')!;
    expect(chipN.className).toContain("rounded-lg");
    expect(chipN.className).not.toContain("rounded-full");
    expect(chipN.className).toContain("bg-primary");
    const marca = montar(<StatCard icon={Activity} label="Orgs" value="12" />);
    expect(marca.querySelector('[data-testid="stat-card-chip"]')!.className).toContain("rounded-full");
  });
  it("conserva la regla de no inventar cifras: sinDato pinta guion y el motivo tras el divisor punteado", () => {
    const el = montar(<StatCard variante="neutra" icon={Activity} label="Margen" value="0%" sinDato="Falta tipo de cambio" />);
    expect(el.textContent).toContain("—");
    expect(el.textContent).toContain("Falta tipo de cambio");
    expect(el.textContent).not.toContain("0%");
    expect(el.innerHTML).toContain("border-dashed");
  });
  it("TrendStatCard propaga la variante", () => {
    const el = montar(<TrendStatCard variante="neutra" icon={Activity} label="MRR" value="$1" deltaPct={3} />);
    expect(el.querySelector('[data-testid="stat-card-chip"]')!.className).toContain("rounded-lg");
    expect(el.textContent).toContain("↑ 3%");
  });
});
