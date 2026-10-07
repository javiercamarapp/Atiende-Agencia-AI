// @vitest-environment jsdom
//
// PR-3 de diseno-ux (4.5/4.7): DataTable -- orden, paginacion, seleccion,
// estados loading/error/empty, fila clicable accesible y vista de tarjetas.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable, ordenarFilas, type DataTableColumna, type DataTableProps } from "@atiende/ui";
import { click, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

interface Reserva {
  id: string;
  huesped: string;
  noches: number | null;
  llegada: Date;
}

const DATOS: Reserva[] = [
  { id: "r1", huesped: "Zoe", noches: 3, llegada: new Date("2026-10-03") },
  { id: "r2", huesped: "ana", noches: null, llegada: new Date("2026-10-01") },
  { id: "r3", huesped: "Luis", noches: 10, llegada: new Date("2026-10-02") },
  { id: "r4", huesped: "Mario", noches: 2, llegada: new Date("2026-10-04") },
];

const COLUMNAS: DataTableColumna<Reserva>[] = [
  { id: "huesped", encabezado: "Huésped", celda: (r) => r.huesped, valorOrden: (r) => r.huesped, principal: true },
  { id: "noches", encabezado: "Noches", celda: (r) => r.noches ?? "—", valorOrden: (r) => r.noches, alinear: "right" },
  { id: "llegada", encabezado: "Llegada", celda: (r) => r.llegada.toISOString().slice(0, 10), valorOrden: (r) => r.llegada },
  { id: "notas", encabezado: "Notas", celda: () => "ok" },
];

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

function montar(props: Partial<DataTableProps<Reserva>> = {}) {
  rendered = renderComponent(<DataTable columnas={COLUMNAS} filas={DATOS} obtenerId={(r) => r.id} etiqueta="Reservas" {...props} />);
  return rendered.container;
}
const celdasDe = (c: HTMLElement, col: number) => [...c.querySelectorAll("tbody tr")].map((tr) => tr.children[col]!.textContent);
const th = (c: HTMLElement, texto: string) => [...c.querySelectorAll("th")].find((x) => x.textContent?.includes(texto))!;
const btn = (c: HTMLElement, texto: string) => [...c.querySelectorAll("button")].find((b) => b.textContent?.includes(texto))! as HTMLButtonElement;

describe("DataTable — estructura accesible", () => {
  it("es una tabla con nombre accesible, encabezados con scope y una fila por registro", () => {
    const c = montar();
    const tabla = c.querySelector("table")!;
    expect(tabla.getAttribute("aria-label")).toBe("Reservas");
    expect([...c.querySelectorAll("th")].every((x) => x.getAttribute("scope") === "col")).toBe(true);
    expect(c.querySelectorAll("tbody tr")).toHaveLength(4);
    expect(c.querySelector("[role=status]")!.textContent).toContain("Mostrando 1–4 de 4");
  });
});

describe("DataTable — orden", () => {
  it("ciclo asc -> desc -> sin orden, con aria-sort y vacios siempre al final", () => {
    const c = montar();
    expect(th(c, "Noches").getAttribute("aria-sort")).toBe("none");
    expect(th(c, "Notas").hasAttribute("aria-sort")).toBe(false); // no ordenable

    click(btn(c, "Noches"));
    expect(th(c, "Noches").getAttribute("aria-sort")).toBe("ascending");
    expect(celdasDe(c, 1)).toEqual(["2", "3", "10", "—"]);

    click(btn(c, "Noches"));
    expect(th(c, "Noches").getAttribute("aria-sort")).toBe("descending");
    expect(celdasDe(c, 1)).toEqual(["10", "3", "2", "—"]);

    click(btn(c, "Noches"));
    expect(th(c, "Noches").getAttribute("aria-sort")).toBe("none");
    expect(celdasDe(c, 0)).toEqual(["Zoe", "ana", "Luis", "Mario"]); // orden original
  });

  it("texto con locale es (ana antes que Zoe) y fechas por valor", () => {
    const c = montar();
    click(btn(c, "Huésped"));
    expect(celdasDe(c, 0)).toEqual(["ana", "Luis", "Mario", "Zoe"]);
    click(btn(c, "Llegada"));
    expect(celdasDe(c, 2)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
  });

  it("orden controlado: notifica y no ordena por su cuenta", () => {
    const onOrdenChange = vi.fn();
    const c = montar({ orden: null, onOrdenChange });
    click(btn(c, "Noches"));
    expect(onOrdenChange).toHaveBeenCalledWith({ columnaId: "noches", direccion: "asc" });
    expect(celdasDe(c, 0)).toEqual(["Zoe", "ana", "Luis", "Mario"]);
    rendered!.rerender(<DataTable columnas={COLUMNAS} filas={DATOS} obtenerId={(r) => r.id} etiqueta="Reservas" orden={{ columnaId: "noches", direccion: "desc" }} onOrdenChange={onOrdenChange} />);
    expect(celdasDe(c, 1)).toEqual(["10", "3", "2", "—"]);
  });

  it("ordenarFilas no muta la entrada y es estable en empates", () => {
    const entrada = [...DATOS];
    const col: DataTableColumna<Reserva> = { id: "x", encabezado: "x", celda: () => null, valorOrden: () => 1 };
    expect(ordenarFilas(entrada, col, "asc").map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(entrada).toEqual(DATOS);
    expect(ordenarFilas(entrada, undefined, "asc")).toEqual(DATOS);
  });
});

describe("DataTable — paginacion", () => {
  const MUCHAS: Reserva[] = Array.from({ length: 25 }, (_, i) => ({ id: `m${i + 1}`, huesped: `H${String(i + 1).padStart(2, "0")}`, noches: i, llegada: new Date(2026, 9, 1) }));

  it("pagina de 10 en 10, anuncia el rango y deshabilita Anterior/Siguiente en los extremos", () => {
    const c = montar({ filas: MUCHAS });
    expect(c.querySelectorAll("tbody tr")).toHaveLength(10);
    expect(c.querySelector("[role=status]")!.textContent).toContain("Mostrando 1–10 de 25");
    expect(c.querySelector("nav")!.getAttribute("aria-label")).toBe("Paginación");
    expect(btn(c, "Anterior").disabled).toBe(true);
    click(btn(c, "Siguiente"));
    click(btn(c, "Siguiente"));
    expect(c.querySelectorAll("tbody tr")).toHaveLength(5);
    expect(c.querySelector("[role=status]")!.textContent).toContain("Mostrando 21–25 de 25");
    expect(c.textContent).toContain("Página 3 de 3");
    expect(btn(c, "Siguiente").disabled).toBe(true);
  });

  it("ordenar conserva la pagina y la ordena globalmente (no solo la pagina visible)", () => {
    const c = montar({ filas: MUCHAS, paginacion: { tamano: 5 } });
    click(btn(c, "Noches"));
    click(btn(c, "Noches")); // desc
    expect(celdasDe(c, 1)).toEqual(["24", "23", "22", "21", "20"]);
  });

  it("si el conjunto se encoge y la pagina queda fuera de rango, vuelve a la ultima valida", () => {
    const c = montar({ filas: MUCHAS });
    click(btn(c, "Siguiente"));
    click(btn(c, "Siguiente"));
    rendered!.rerender(<DataTable columnas={COLUMNAS} filas={MUCHAS.slice(0, 12)} obtenerId={(r) => r.id} etiqueta="Reservas" />);
    expect(c.textContent).toContain("Página 2 de 2");
    expect(c.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("pagina controlada: notifica el cambio y respeta la pagina recibida", () => {
    const onPaginaChange = vi.fn();
    const c = montar({ filas: MUCHAS, paginacion: { tamano: 10, pagina: 2, onPaginaChange } });
    expect(celdasDe(c, 0)[0]).toBe("H11");
    click(btn(c, "Siguiente"));
    expect(onPaginaChange).toHaveBeenCalledWith(3);
    expect(celdasDe(c, 0)[0]).toBe("H11"); // no cambia sola
  });

  it("paginacion de servidor (total): no recorta filas, anuncia el rango real y pide la pagina al servidor", () => {
    const onPaginaChange = vi.fn();
    // `filas` es solo la pagina 2 (tamano 10) de un conjunto de 251: la tabla NO debe volver a cortarla ni decir "de 10".
    const c = montar({ filas: MUCHAS.slice(0, 10), paginacion: { tamano: 10, pagina: 2, total: 251, onPaginaChange } });
    expect(c.querySelectorAll("tbody tr")).toHaveLength(10);
    expect(c.querySelector("[role=status]")!.textContent).toContain("Mostrando 11–20 de 251");
    expect(c.textContent).toContain("Página 2 de 26");
    click(btn(c, "Siguiente"));
    expect(onPaginaChange).toHaveBeenCalledWith(3);
  });

  it("paginacion={false} muestra todo sin navegacion", () => {
    const c = montar({ filas: MUCHAS, paginacion: false });
    expect(c.querySelectorAll("tbody tr")).toHaveLength(25);
    expect(c.querySelector("nav")).toBeNull();
  });
});

describe("DataTable — seleccion", () => {
  it("casillas con etiqueta, seleccionar todas con estado mixto y conteo anunciado", () => {
    const onSeleccionChange = vi.fn();
    const c = montar({ seleccionable: true, onSeleccionChange });
    const casillas = [...c.querySelectorAll<HTMLInputElement>("tbody input[type=checkbox]")];
    expect(casillas).toHaveLength(4);
    expect(casillas[0]!.getAttribute("aria-label")).toBe("Seleccionar fila r1");
    const todas = c.querySelector<HTMLInputElement>("thead input[type=checkbox]")!;

    click(casillas[0]!);
    expect([...(onSeleccionChange.mock.lastCall![0] as Set<string>)]).toEqual(["r1"]);
    expect(todas.indeterminate).toBe(true);
    expect(c.querySelector("[role=status]")!.textContent).toContain("1 seleccionada");

    click(todas);
    expect((onSeleccionChange.mock.lastCall![0] as Set<string>).size).toBe(4);
    expect(todas.checked).toBe(true);
    expect(todas.indeterminate).toBe(false);
    click(todas);
    expect((onSeleccionChange.mock.lastCall![0] as Set<string>).size).toBe(0);
  });

  it("seleccion controlada: refleja el set recibido y marca la fila", () => {
    const c = montar({ seleccionable: true, seleccion: new Set(["r2"]), onSeleccionChange: () => {} });
    expect(c.querySelectorAll("tbody tr")[1]!.getAttribute("data-state")).toBe("selected");
    expect(c.querySelectorAll<HTMLInputElement>("tbody input[type=checkbox]")[1]!.checked).toBe(true);
  });
});

describe("DataTable — estados", () => {
  it("loading: esqueleto con role status y aria-busy, sin tabla", () => {
    const c = montar({ estado: "loading" });
    expect(c.querySelector("table")).toBeNull();
    const s = c.querySelector("[role=status]")!;
    expect(s.getAttribute("aria-busy")).toBe("true");
    expect(s.getAttribute("aria-label")).toBe("Cargando Reservas");
  });

  it("error: role alert con Reintentar", () => {
    const onReintentar = vi.fn();
    const c = montar({ estado: "error", error: { mensaje: "Sin conexión", onReintentar } });
    expect(c.querySelector("[role=alert]")!.textContent).toContain("Sin conexión");
    click(btn(c, "Reintentar"));
    expect(onReintentar).toHaveBeenCalledTimes(1);
  });

  it("empty explicito o implicito (sin filas) usa EstadoVacio con su accion", () => {
    const c = montar({ filas: [], vacio: { mensaje: "Aún no hay reservas.", accion: <button type="button">Crear reserva</button> } });
    expect(c.querySelector("table")).toBeNull();
    expect(c.textContent).toContain("Aún no hay reservas.");
    expect(btn(c, "Crear reserva")).toBeDefined();
  });

  it("un estado explicito gana a las filas (cargando con datos viejos no pinta la tabla)", () => {
    const c = montar({ estado: "empty", vacio: { mensaje: "Nada" } });
    expect(c.querySelector("table")).toBeNull();
  });
});

describe("DataTable — fila clicable accesible", () => {
  it("Tab la enfoca, Enter y Espacio la activan, y un clic en un control interno no cuenta", () => {
    const onFilaClick = vi.fn();
    const cols: DataTableColumna<Reserva>[] = [...COLUMNAS, { id: "acc", encabezado: "Acciones", celda: () => <button type="button">Editar</button> }];
    rendered = renderComponent(<DataTable columnas={cols} filas={DATOS} obtenerId={(r) => r.id} etiqueta="Reservas" onFilaClick={onFilaClick} />);
    const fila = rendered.container.querySelectorAll<HTMLElement>("tbody tr")[0]!;
    expect(fila.tabIndex).toBe(0);
    click(fila);
    expect(onFilaClick).toHaveBeenLastCalledWith(DATOS[0]);
    keydown(fila, "Enter");
    keydown(fila, " ");
    expect(onFilaClick).toHaveBeenCalledTimes(3);
    onFilaClick.mockClear();
    click(fila.querySelector("button")!);
    keydown(fila.querySelector("button")!, "Enter"); // Enter dentro del boton es del boton
    expect(onFilaClick).not.toHaveBeenCalled();
  });

  it("sin onFilaClick las filas no son enfocables", () => {
    const c = montar();
    expect((c.querySelector("tbody tr") as HTMLElement).hasAttribute("tabindex")).toBe(false);
  });
});

describe("DataTable — vista de tarjetas (movil)", () => {
  it("vista=tarjetas: lista accesible, columna principal como titulo y el resto como pares dt/dd", () => {
    const c = montar({ vista: "tarjetas" });
    expect(c.querySelector("table")).toBeNull();
    const lista = c.querySelector("ul")!;
    expect(lista.getAttribute("aria-label")).toBe("Reservas");
    const primera = lista.querySelectorAll("li")[0]!;
    expect(primera.textContent).toContain("Zoe");
    expect([...primera.querySelectorAll("dt")].map((x) => x.textContent)).toEqual(["Noches", "Llegada", "Notas"]);
  });

  it("ocultarEnTarjeta quita la columna; seleccion y fila clicable siguen funcionando", () => {
    const onFilaClick = vi.fn();
    const onSeleccionChange = vi.fn();
    const cols = COLUMNAS.map((x) => (x.id === "notas" ? { ...x, ocultarEnTarjeta: true } : x));
    rendered = renderComponent(
      <DataTable columnas={cols} filas={DATOS} obtenerId={(r) => r.id} etiqueta="Reservas" vista="tarjetas" seleccionable onSeleccionChange={onSeleccionChange} onFilaClick={onFilaClick} />,
    );
    const c = rendered.container;
    expect(c.querySelector("li dl")!.textContent).not.toContain("Notas");
    const tarjeta = c.querySelectorAll<HTMLElement>("ul > li")[1]!; // [0] es "Seleccionar todas"
    expect(tarjeta.tabIndex).toBe(0);
    click(tarjeta.querySelector("input")!);
    expect(onSeleccionChange).toHaveBeenCalled();
    expect(onFilaClick).not.toHaveBeenCalled(); // la casilla no activa la tarjeta
    keydown(tarjeta, "Enter");
    expect(onFilaClick).toHaveBeenCalledWith(DATOS[0]);
  });

  it("vista=auto cambia a tarjetas cuando matchMedia indica < 768 px", () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
    try {
      const c = montar();
      expect(c.querySelector("table")).toBeNull();
      expect(c.querySelector("ul")).not.toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("DataTable — atributosFila (ganchos data-* estables)", () => {
  it("pone los data-* de cada fila en la tabla y en la vista de tarjetas", () => {
    const c = montar({ atributosFila: (r) => ({ "data-reserva": r.id }) });
    expect([...c.querySelectorAll("tbody tr")].map((tr) => tr.getAttribute("data-reserva"))).toEqual(["r1", "r2", "r3", "r4"]);
    rendered!.unmount();
    const t = montar({ vista: "tarjetas", atributosFila: (r) => ({ "data-reserva": r.id }) });
    expect([...t.querySelectorAll("ul > li[data-reserva]")].map((li) => li.getAttribute("data-reserva"))).toEqual(["r1", "r2", "r3", "r4"]);
  });
});
