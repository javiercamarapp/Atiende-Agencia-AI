// @vitest-environment jsdom
//
// PR-2 de diseno-ux: EstadoCargando (variantes), EstadoVacio/EstadoError
// (compactos), Callout y Skeleton. Regla de feedback 4.7: aviso persistente de
// negocio -> Callout; error que bloquea la pagina -> EstadoError; carga ->
// skeleton, nunca un texto suelto "Cargando...".
import { afterEach, describe, expect, it, vi } from "vitest";
import { Callout, CALLOUT_TONES, EstadoCargando, EstadoError, EstadoVacio, Skeleton } from "@atiende/ui";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

function raiz(): HTMLElement {
  return rendered!.container.firstElementChild as HTMLElement;
}

describe("EstadoCargando", () => {
  it("la variante por defecto: status, aria-busy, etiqueta y 3 filas de skeleton (la ultima al 60 %)", () => {
    rendered = renderComponent(<EstadoCargando />);
    expect(raiz().getAttribute("role")).toBe("status");
    expect(raiz().getAttribute("aria-busy")).toBe("true");
    expect(raiz().getAttribute("aria-label")).toBe("Cargando…");
    expect(raiz().querySelectorAll(".ds-skeleton")).toHaveLength(3);
    expect(raiz().textContent).toBe("Cargando…");
  });

  it("acepta etiqueta y numero de lineas", () => {
    rendered = renderComponent(<EstadoCargando etiqueta="Cargando citas" lineas={5} />);
    expect(raiz().getAttribute("aria-label")).toBe("Cargando citas");
    expect(raiz().querySelectorAll(".ds-skeleton")).toHaveLength(5);
  });

  it("tabla: cabecera + `filas` filas de esqueleto, anunciada una sola vez", () => {
    rendered = renderComponent(<EstadoCargando variante="tabla" filas={4} etiqueta="Cargando pagos" />);
    expect(raiz().getAttribute("role")).toBe("status");
    // 1 cabecera + 4 filas x 4 celdas
    expect(raiz().querySelectorAll(".ds-skeleton")).toHaveLength(1 + 4 * 4);
    expect(rendered.container.querySelectorAll("[role=status]")).toHaveLength(1);
    expect(raiz().textContent).toBe("Cargando pagos");
  });

  it("tarjeta: contenedor card con relleno p-4", () => {
    rendered = renderComponent(<EstadoCargando variante="tarjeta" lineas={2} />);
    expect(raiz().className).toContain("card");
    expect(raiz().className).toContain("p-4");
    expect(raiz().querySelectorAll(".ds-skeleton")).toHaveLength(3);
  });

  it("pantalla: glifo que respira (decorativo, oculto a AT) con el texto de carga visible", () => {
    rendered = renderComponent(<EstadoCargando variante="pantalla" etiqueta="Abriendo tu panel" />);
    expect(raiz().getAttribute("role")).toBe("status");
    expect(raiz().getAttribute("aria-busy")).toBe("true");
    expect(raiz().textContent).toContain("Abriendo tu panel");
    const decorativo = raiz().querySelector("[aria-hidden='true']")!;
    expect(decorativo.className).toContain("atiende-respira");
    expect(decorativo.querySelector("svg")?.getAttribute("class")).toContain("atiende-glifo-animado");
  });
});

describe("Skeleton", () => {
  it("lleva la clase ds-skeleton (barrido de brillo de Likida) y ya no el pulso de Tailwind", () => {
    rendered = renderComponent(<Skeleton className="h-4 w-10" />);
    expect(raiz().className).toContain("ds-skeleton");
    expect(raiz().className).not.toContain("animate-pulse");
    expect(raiz().className).toContain("h-4");
  });
});

describe("EstadoVacio y EstadoError", () => {
  it("EstadoVacio: role=status, titulo, mensaje, accion; compacto reduce el relleno a p-3", () => {
    const onClick = vi.fn();
    rendered = renderComponent(<EstadoVacio titulo="Sin citas" mensaje="Crea la primera" accion={<button onClick={onClick}>Nueva</button>} />);
    expect(raiz().getAttribute("role")).toBe("status");
    // por defecto (fuera de restaurantes) es la variante "fila" de Likida
    expect(raiz().className).toContain("p-4");
    click(rendered.container.querySelector("button")!);
    expect(onClick).toHaveBeenCalled();
    rendered.rerender(<EstadoVacio mensaje="Nada" compacto className="mt-2" />);
    expect(raiz().className).toContain("p-3");
    expect(raiz().className).not.toContain("p-4");
    // variante centrada (el default dentro de restaurantes)
    rendered.rerender(<EstadoVacio variante="centrado" mensaje="Nada" />);
    expect(raiz().className).toContain("py-10");
    rendered.rerender(<EstadoVacio variante="centrado" mensaje="Nada" compacto />);
    expect(raiz().className).toContain("py-6");
    expect(raiz().className).toContain("mt-2");
    expect(raiz().textContent).toContain("Sin datos aún");
  });

  it("EstadoError: role=alert, Reintentar llama al handler; sin handler no hay boton; compacto", () => {
    const onReintentar = vi.fn();
    rendered = renderComponent(<EstadoError onReintentar={onReintentar} />);
    expect(raiz().getAttribute("role")).toBe("alert");
    click(rendered.container.querySelector("button")!);
    expect(onReintentar).toHaveBeenCalledTimes(1);
    rendered.rerender(<EstadoError compacto integracion="PMS" pendienteCredenciales />);
    expect(rendered.container.querySelector("button")).toBeNull();
    expect(raiz().className).toContain("p-3");
    expect(raiz().textContent).toContain("pendiente de credenciales");
  });
});

describe("Callout", () => {
  it.each(CALLOUT_TONES)("tono %s: fondo tintado semantico, icono decorativo y sin paleta cruda", (tone) => {
    rendered = renderComponent(<Callout tone={tone}>Mensaje</Callout>);
    expect(raiz().dataset.tone).toBe(tone);
    expect(raiz().className).toContain("rounded-card");
    expect(raiz().className).not.toMatch(/-(green|amber|red|yellow|blue|emerald|sky)-\d{2,3}/);
    expect(raiz().querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("danger se anuncia como alert; los demas como status (no interrumpen)", () => {
    rendered = renderComponent(<Callout tone="danger">Fallo</Callout>);
    expect(raiz().getAttribute("role")).toBe("alert");
    for (const tone of ["info", "success", "warning", "neutral"] as const) {
      rendered.rerender(<Callout tone={tone}>x</Callout>);
      expect(raiz().getAttribute("role")).toBe("status");
    }
  });

  it("un role explicito del llamador gana", () => {
    rendered = renderComponent(
      <Callout tone="warning" role="alert">
        x
      </Callout>,
    );
    expect(raiz().getAttribute("role")).toBe("alert");
  });

  it("titulo, texto y accion se dibujan; la accion es clicable", () => {
    const onClick = vi.fn();
    rendered = renderComponent(
      <Callout tone="warning" titulo="Falta la constancia" accion={<button onClick={onClick}>Subir</button>}>
        Sin ella no se emite el CFDI.
      </Callout>,
    );
    expect(raiz().textContent).toContain("Falta la constancia");
    expect(raiz().textContent).toContain("Sin ella no se emite el CFDI.");
    click(rendered.container.querySelector("button")!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("onDismiss muestra un boton con nombre accesible que cierra; sin handler no hay boton", () => {
    const onDismiss = vi.fn();
    rendered = renderComponent(<Callout onDismiss={onDismiss}>x</Callout>);
    const cerrar = rendered.container.querySelector<HTMLButtonElement>("button")!;
    expect(cerrar.getAttribute("aria-label")).toBe("Cerrar aviso");
    expect(cerrar.type).toBe("button");
    expect(cerrar.className).toContain("focus-visible:ring-2");
    click(cerrar);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    rendered.rerender(<Callout>x</Callout>);
    expect(rendered.container.querySelector("button")).toBeNull();
  });

  it("un icono propio reemplaza al del tono", () => {
    rendered = renderComponent(
      <Callout icon={<span data-testid="mi-icono">!</span>}>x</Callout>,
    );
    expect(rendered.container.querySelector('[data-testid="mi-icono"]')).not.toBeNull();
    expect(raiz().querySelector("svg")).toBeNull();
  });
});
