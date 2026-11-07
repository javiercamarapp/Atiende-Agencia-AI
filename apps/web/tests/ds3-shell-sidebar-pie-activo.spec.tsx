// @vitest-environment jsdom
//
// ds3 / lote 5.2: la fila del pie que lleva a la pagina actual (Notificaciones, Seguridad de la cuenta...) queda marcada como activa
// (aria-current="page"), igual que un item del nav; la hoja ds3 le pone el tinte y el filete. Solo AÑADE.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Bell, CalendarCheck, ShieldCheck } from "lucide-react";
import { Sidebar } from "@atiende/ui";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

let rendered: RenderedComponent | undefined;
beforeEach(() => {
  installMatchMediaStub();
  installMemoryLocalStorage();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

const render = (ruta: string) =>
  renderComponent(
    <MemoryRouter initialEntries={[ruta]}>
      <Sidebar
        sections={[{ title: "Resumen", siempreAbierto: true, items: [{ to: "/v/demo", label: "Resumen", icon: CalendarCheck, end: true }] }]}
        user={{ email: "a@b.mx" }}
        onLogout={() => {}}
        pie={[
          { label: "Notificaciones", to: "/v/demo/notificaciones", icon: Bell },
          { label: "Seguridad de la cuenta", to: "/v/demo/seguridad", icon: ShieldCheck },
        ]}
      />
    </MemoryRouter>,
  );

describe("ds3 — filas del pie activas", () => {
  it("en /notificaciones solo esa fila lleva aria-current=page", () => {
    rendered = render("/v/demo/notificaciones");
    const filas = [...rendered.container.querySelectorAll<HTMLAnchorElement>(".ds3-pie-fila")];
    expect(filas.map((a) => a.getAttribute("aria-current"))).toEqual(["page", null]);
  });

  it("en una pagina del nav ninguna fila del pie esta activa", () => {
    rendered = render("/v/demo");
    expect(rendered.container.querySelectorAll('.ds3-pie-fila[aria-current="page"]')).toHaveLength(0);
  });
});
