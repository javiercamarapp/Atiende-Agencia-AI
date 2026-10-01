// @vitest-environment jsdom
//
// "Chatea con tus datos": dialogo presentacional de @atiende/ui + conexion en BotonChatDatos. Cubre que las
// cifras salen de los bloques del servidor con formato MXN, que cada respuesta cita fuente/periodo/alcance,
// que el texto de los datos NO se interpreta como HTML (inyeccion), accesibilidad basica y que el boton sigue
// diciendo "Pronto" salvo que el servidor confirme que el asistente esta activo.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ChatDatosDialog, formatChatCell } from "@atiende/ui";
import type { ChatDatosMensaje } from "@atiende/ui";
import { BotonChatDatos } from "../src/components/BotonChatDatos.tsx";
import type { ChatDatosConexion } from "../src/components/PanelChateaConTusDatos.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
});

const MENSAJES: ChatDatosMensaje[] = [
  { id: "u1", role: "user", text: "¿Cuánto vendí esta semana?" },
  {
    id: "a1",
    role: "assistant",
    text: "Vendiste $2,480.75 MXN.",
    status: "ok",
    blocks: [
      {
        tool: "ventas_por_dia",
        title: "Ventas por día",
        columns: [
          { key: "periodo", label: "Día", kind: "text" },
          { key: "ventas", label: "Ventas", kind: "mxn" },
          { key: "pedidos", label: "Pedidos", kind: "integer" },
        ],
        rows: [
          { periodo: "2026-09-28", ventas: 1500.5, pedidos: 12 },
          { periodo: "2026-09-29", ventas: 980.25, pedidos: 8 },
        ],
        chart: { kind: "line", x: "periodo", y: "ventas" },
        truncated: false,
      },
    ],
    sources: [{ source: "Pedidos de restaurantes (sin cancelados)", periodLabel: "esta semana (28 sep al 29 sep 2026)", scopeLabel: "todas tus sucursales" }],
  },
];

function dialogo(): Element {
  const d = document.body.querySelector('[role="dialog"]');
  if (!d) throw new Error("no hay dialogo");
  return d;
}

describe("ChatDatosDialog", () => {
  it("pinta la tabla con montos en MXN, la grafica accesible y la fuente/periodo/alcance", () => {
    rendered = renderComponent(<ChatDatosDialog open onOpenChange={() => {}} mensajes={MENSAJES} enviando={false} onEnviar={() => {}} sugerencias={[]} nombreNegocio="Los Taquitos" />);
    const d = dialogo();
    expect(d.textContent).toContain("Chatea con tus datos");
    expect(d.textContent).toContain("Los Taquitos");
    expect(d.textContent).toContain("$1,500.50 MXN");
    expect(d.textContent).toContain("$980.25 MXN");
    expect(d.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toContain("Ventas");
    const fuente = d.querySelector('[aria-label="Fuente de los datos"]')!;
    expect(fuente.textContent).toContain("Fuente: Pedidos de restaurantes (sin cancelados)");
    expect(fuente.textContent).toContain("Periodo: esta semana (28 sep al 29 sep 2026)");
    expect(fuente.textContent).toContain("Alcance: todas tus sucursales");
    expect(d.querySelector('[role="log"]')?.getAttribute("aria-live")).toBe("polite");
  });

  it("el texto de los datos jamas se interpreta como HTML (inyeccion): se muestra inerte", () => {
    const malicioso: ChatDatosMensaje[] = [
      {
        id: "a1",
        role: "assistant",
        text: "<img src=x onerror=alert(1)> respuesta",
        blocks: [{ tool: "t", title: "<script>alert(1)</script>", columns: [{ key: "p", label: "Producto", kind: "text" }], rows: [{ p: "<img src=x onerror=alert(2)>" }], truncated: false }],
      },
    ];
    rendered = renderComponent(<ChatDatosDialog open onOpenChange={() => {}} mensajes={malicioso} enviando={false} onEnviar={() => {}} />);
    const d = dialogo();
    expect(d.querySelector("img")).toBeNull();
    expect(d.querySelector("script")).toBeNull();
    expect(d.textContent).toContain("<img src=x onerror=alert(2)>");
  });

  it("estado sin datos / fuera de catalogo se rotula, y 'truncado' avisa que hay mas filas", () => {
    const m: ChatDatosMensaje[] = [
      { id: "a1", role: "assistant", text: "No encontré datos.", status: "no_data" },
      { id: "a2", role: "assistant", text: "Fuera.", status: "out_of_catalog", blocks: [{ tool: "t", title: "T", columns: [{ key: "a", label: "A", kind: "text" }], rows: [{ a: "x" }], truncated: true }] },
    ];
    rendered = renderComponent(<ChatDatosDialog open onOpenChange={() => {}} mensajes={m} enviando={false} onEnviar={() => {}} />);
    const t = dialogo().textContent!;
    expect(t).toContain("Sin datos para ese periodo");
    expect(t).toContain("Fuera de lo que puedo consultar");
    expect(t).toContain("hay más datos que no caben aquí");
  });

  it("enviar: el form manda la pregunta recortada, limpia el input y se bloquea mientras 'enviando'", async () => {
    const onEnviar = vi.fn();
    rendered = renderComponent(<ChatDatosDialog open onOpenChange={() => {}} mensajes={[]} enviando={false} onEnviar={onEnviar} sugerencias={[]} />);
    const input = dialogo().querySelector("input") as HTMLInputElement;
    expect(document.body.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
    changeValue(input, "  ¿Ventas de hoy?  ");
    await submitForm(dialogo().querySelector("form") as HTMLFormElement);
    expect(onEnviar).toHaveBeenCalledWith("¿Ventas de hoy?");
    expect((dialogo().querySelector("input") as HTMLInputElement).value).toBe("");

    rendered.rerender(<ChatDatosDialog open onOpenChange={() => {}} mensajes={[]} enviando onEnviar={onEnviar} sugerencias={[]} />);
    expect((dialogo().querySelector("input") as HTMLInputElement).disabled).toBe(true);
    expect(dialogo().textContent).toContain("Consultando tus datos");
  });

  it("las sugerencias envian su texto; formatChatCell no inventa ceros para null", () => {
    const onEnviar = vi.fn();
    rendered = renderComponent(<ChatDatosDialog open onOpenChange={() => {}} mensajes={[]} enviando={false} onEnviar={onEnviar} sugerencias={["¿Cuánto vendí esta semana?"]} />);
    const boton = [...dialogo().querySelectorAll("button")].find((b) => b.textContent === "¿Cuánto vendí esta semana?")!;
    click(boton);
    expect(onEnviar).toHaveBeenCalledWith("¿Cuánto vendí esta semana?");
    expect(formatChatCell("mxn", null)).toBe("—");
    expect(formatChatCell("percent", 12.5)).toBe("12.5%");
  });
});

function conexion(over: Partial<ChatDatosConexion> = {}): ChatDatosConexion {
  return {
    clave: "prop-1",
    disponible: async () => true,
    enviar: async () => ({ status: "ok", text: "Vendiste $2,480.75 MXN.", blocks: [], sources: [{ source: "Pedidos", scopeLabel: "todas tus sucursales" }] }),
    sugerencias: ["¿Cuánto vendí esta semana?"],
    ...over,
  };
}

function boton(): HTMLButtonElement {
  return [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Chatea con tus datos")) as HTMLButtonElement;
}

describe("BotonChatDatos con chat conectado", () => {
  it("asistente activo: sin 'Pronto', abre la conversacion real y una pregunta recibe respuesta con su fuente", async () => {
    const enviar = vi.fn(conexion().enviar);
    rendered = renderComponent(<BotonChatDatos nombreNegocio="Los Taquitos" chat={conexion({ enviar })} />);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(boton().textContent).not.toContain("Pronto");
    click(boton());
    const d = dialogo();
    expect(d.querySelector("input")).not.toBeNull();
    changeValue(d.querySelector("input") as HTMLInputElement, "¿Ventas?");
    await submitForm(d.querySelector("form") as HTMLFormElement);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(enviar).toHaveBeenCalledWith("¿Ventas?", []);
    expect(dialogo().textContent).toContain("Vendiste $2,480.75 MXN.");
    expect(dialogo().textContent).toContain("Alcance: todas tus sucursales");
  });

  it("asistente NO activo (el servidor no lo confirma): conserva 'Pronto' y el aviso honesto, sin caja de pregunta", async () => {
    rendered = renderComponent(<BotonChatDatos chat={conexion({ disponible: async () => false })} />);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(boton().textContent).toContain("Pronto");
    click(boton());
    expect(dialogo().textContent).toContain("todavía no está disponible");
    expect(dialogo().querySelector("input")).toBeNull();
  });
});

describe("modo sin IA: botones de noAi.options", () => {
  const SIN_IA = {
    reason: "provider_down" as const,
    options: [
      { tool: "ventas_por_dia", label: "Ventas por día", description: "Ventas y pedidos por día." },
      { tool: "productos_top", label: "Productos más vendidos", description: "Ranking de productos." },
    ],
  };
  const sinIa = (): ChatDatosConexion["enviar"] => async () => ({ status: "unavailable", text: "La asistencia con IA no está disponible en este momento.", blocks: [], sources: [], noAi: SIN_IA });
  const OK_DIRECTO = { status: "ok", text: "Ventas del periodo: $2,480.50 MXN en 20 pedidos.", blocks: [], sources: [{ source: "Pedidos", periodLabel: "últimos 30 días", scopeLabel: "todas tus sucursales" }] };

  it("ChatDatosDialog pinta un boton por opcion y llama onEjecutarOpcion con la opcion elegida", () => {
    const onEjecutarOpcion = vi.fn();
    const mensajes: ChatDatosMensaje[] = [{ id: "a1", role: "assistant", text: "IA no disponible", status: "unavailable", noAi: SIN_IA }];
    rendered = renderComponent(<ChatDatosDialog open onOpenChange={() => {}} mensajes={mensajes} enviando={false} onEnviar={() => {}} onEjecutarOpcion={onEjecutarOpcion} />);
    const botones = [...dialogo().querySelectorAll('[role="group"] button')];
    expect(botones.map((b) => b.textContent)).toEqual(["Ventas por día", "Productos más vendidos"]);
    expect((botones[0] as HTMLButtonElement).title).toBe("Ventas y pedidos por día.");
    click(botones[1] as HTMLButtonElement);
    expect(onEjecutarOpcion).toHaveBeenCalledWith(SIN_IA.options[1]);
  });

  it("sin onEjecutarOpcion (conexion sin consulta directa) NO se muestran botones sin accion; con 'enviando' quedan deshabilitados", () => {
    const mensajes: ChatDatosMensaje[] = [{ id: "a1", role: "assistant", text: "IA no disponible", status: "unavailable", noAi: SIN_IA }];
    rendered = renderComponent(<ChatDatosDialog open onOpenChange={() => {}} mensajes={mensajes} enviando={false} onEnviar={() => {}} />);
    expect(dialogo().querySelector('[role="group"]')).toBeNull();
    rendered.rerender(<ChatDatosDialog open onOpenChange={() => {}} mensajes={mensajes} enviando onEnviar={() => {}} onEjecutarOpcion={() => {}} />);
    expect([...dialogo().querySelectorAll('[role="group"] button')].every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("flujo completo: la IA cae, aparecen los botones y al tocar uno se llama al endpoint real (ejecutarOpcion) y se pinta su respuesta con fuente", async () => {
    const ejecutarOpcion = vi.fn(async (_tool: string) => OK_DIRECTO);
    rendered = renderComponent(<BotonChatDatos chat={conexion({ enviar: sinIa(), ejecutarOpcion })} />);
    await act(async () => {
      await flushMicrotasks();
    });
    click(boton());
    changeValue(dialogo().querySelector("input") as HTMLInputElement, "¿Ventas?");
    await submitForm(dialogo().querySelector("form") as HTMLFormElement);
    await act(async () => {
      await flushMicrotasks();
    });
    const opcion = [...dialogo().querySelectorAll('[role="group"] button')].find((b) => b.textContent === "Ventas por día") as HTMLButtonElement;
    click(opcion);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(ejecutarOpcion).toHaveBeenCalledWith("ventas_por_dia");
    expect(dialogo().textContent).toContain("Ventas del periodo: $2,480.50 MXN en 20 pedidos.");
    expect(dialogo().textContent).toContain("Periodo: últimos 30 días");
  });

  it("si la consulta directa falla, el panel muestra el aviso honesto del servidor (no inventa datos)", async () => {
    const ejecutarOpcion = vi.fn(async (_tool: string) => ({ status: "unavailable", text: "No pude consultar tus datos en este momento.", blocks: [], sources: [] }));
    rendered = renderComponent(<BotonChatDatos chat={conexion({ enviar: sinIa(), ejecutarOpcion })} />);
    await act(async () => {
      await flushMicrotasks();
    });
    click(boton());
    changeValue(dialogo().querySelector("input") as HTMLInputElement, "¿Ventas?");
    await submitForm(dialogo().querySelector("form") as HTMLFormElement);
    await act(async () => {
      await flushMicrotasks();
    });
    click([...dialogo().querySelectorAll('[role="group"] button')][0] as HTMLButtonElement);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(dialogo().textContent).toContain("No pude consultar tus datos en este momento.");
    expect(dialogo().textContent).toContain("No disponible por ahora");
  });
});
