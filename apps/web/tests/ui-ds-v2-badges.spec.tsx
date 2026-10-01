// @vitest-environment jsdom
//
// PR-2 de diseno-ux: Badge con tonos semanticos y StatusBadge (reemplaza los
// ~20 mapas *_BADGE con pares de colores crudos bg-green-100 text-green-800...).
import { afterEach, describe, expect, it } from "vitest";
import { Badge, STATUS_TONES, StatusBadge, statusTone, type StatusTone } from "@atiende/ui";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

describe("Badge", () => {
  it("success / warning / info usan tokens semanticos, nunca paleta cruda", () => {
    for (const variant of ["success", "warning", "info"] as const) {
      rendered = renderComponent(<Badge variant={variant}>x</Badge>);
      const cls = rendered.container.firstElementChild!.className;
      expect(cls).toContain(`text-${variant}`);
      expect(cls).toContain(`bg-${variant}-tint`);
      expect(cls).not.toMatch(/-(green|amber|red|yellow|blue|emerald|sky)-\d{2,3}/);
      rendered.unmount();
    }
    rendered = undefined;
  });

  it("las variantes anteriores no cambian", () => {
    rendered = renderComponent(<Badge>a</Badge>);
    expect(rendered.container.firstElementChild!.className).toContain("bg-primary");
    rendered.rerender(<Badge variant="destructive">a</Badge>);
    expect(rendered.container.firstElementChild!.className).toContain("bg-destructive");
    rendered.rerender(<Badge variant="outline">a</Badge>);
    expect(rendered.container.firstElementChild!.className).toContain("text-foreground");
  });
});

describe("StatusBadge", () => {
  const ESPERADO: Record<StatusTone, [string, string]> = {
    neutral: ["bg-muted", "text-muted-foreground"],
    info: ["bg-info-tint", "text-info"],
    success: ["bg-success-tint", "text-success"],
    warning: ["bg-warning-tint", "text-warning"],
    danger: ["bg-destructive-tint", "text-destructive"],
  };

  it.each(STATUS_TONES)("tono %s: fondo y texto semanticos, sin paleta cruda", (tone) => {
    rendered = renderComponent(<StatusBadge tone={tone}>Estado</StatusBadge>);
    const el = rendered.container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe("SPAN");
    expect(el.dataset.tone).toBe(tone);
    expect(el.className).toContain(ESPERADO[tone][0]);
    expect(el.className).toContain(ESPERADO[tone][1]);
    expect(el.className).not.toMatch(/-(green|amber|red|yellow|blue|emerald|sky)-\d{2,3}/);
  });

  it("el tono por defecto es neutral", () => {
    rendered = renderComponent(<StatusBadge>Borrador</StatusBadge>);
    expect((rendered.container.firstElementChild as HTMLElement).dataset.tone).toBe("neutral");
  });

  it("el texto es la senal accesible: el punto es decorativo (aria-hidden) y se puede quitar", () => {
    rendered = renderComponent(<StatusBadge tone="success">Pagado</StatusBadge>);
    const el = rendered.container.firstElementChild as HTMLElement;
    expect(el.textContent).toBe("Pagado");
    expect(el.querySelector("[aria-hidden='true']")).not.toBeNull();
    rendered.rerender(
      <StatusBadge tone="success" dot={false}>
        Pagado
      </StatusBadge>,
    );
    expect(rendered.container.querySelector("[aria-hidden='true']")).toBeNull();
  });

  it("acepta className y atributos del span", () => {
    rendered = renderComponent(
      <StatusBadge tone="warning" className="ml-2" title="Vence en 3 dias">
        Por vencer
      </StatusBadge>,
    );
    const el = rendered.container.firstElementChild as HTMLElement;
    expect(el.className).toContain("ml-2");
    expect(el.getAttribute("title")).toBe("Vence en 3 dias");
  });
});

describe("statusTone", () => {
  const TABLA = { pagado: "success", vencido: "danger", pendiente: "warning" } as const;
  it("devuelve el tono de la tabla de la vertical", () => {
    expect(statusTone(TABLA, "pagado")).toBe("success");
    expect(statusTone(TABLA, "vencido")).toBe("danger");
  });
  it("un estado desconocido, nulo o indefinido cae a neutral (o al fallback) sin lanzar", () => {
    expect(statusTone(TABLA, "inventado" as never)).toBe("neutral");
    expect(statusTone(TABLA, null)).toBe("neutral");
    expect(statusTone(TABLA, undefined, "info")).toBe("info");
  });
});
