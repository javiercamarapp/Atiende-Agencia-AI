// @vitest-environment jsdom
//
// UNI-6: la pildora "Pregunta a tus datos" del pie del Sidebar (gemela de la de Likida) solo existe cuando el servidor
// confirma que el asistente esta activo, abre el MISMO panel real que el boton de la barra y respeta las pildoras que
// aporta cada shell (p. ej. "Costos de IA" en superadmin). Sin chat (o con el servidor diciendo no) no se pinta ninguna
// pildora de chat: nunca un control "Pronto" en el pie.
import { act } from "react";
import { LayoutDashboard } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { VerticalShellConectado } from "../src/components/VerticalShellConectado.tsx";
import type { ChatDatosConexion } from "../src/components/PanelChateaConTusDatos.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function conexion(disponible: boolean): ChatDatosConexion {
  return {
    clave: "prop-1",
    disponible: vi.fn(async () => disponible),
    enviar: vi.fn(async () => ({ status: "ok", text: "ok", blocks: [], sources: [], toolsUsed: [] })),
    sugerencias: ["¿Cuánto vendí hoy?"],
  } as unknown as ChatDatosConexion;
}

async function montar(chat: ChatDatosConexion | undefined, sidebarPie?: { label: string; to: string }[]): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage();
  const r = renderComponent(
    <MemoryRouter initialEntries={["/x"]}>
      <VerticalShellConectado
        apiBaseUrl="https://api.test"
        token="tok"
        chat={chat}
        vertical="prueba"
        sections={[{ title: "Panel", siempreAbierto: true, items: [{ to: "/x", label: "Resumen", icon: LayoutDashboard, end: true }] }]}
        mobileItems={[{ to: "/x", label: "Resumen", icon: LayoutDashboard, end: true }]}
        user={{ email: "a@b.mx", rol: "owner", nombre: "Ana Pérez", rolEtiqueta: "Propietario" }}
        onLogout={() => {}}
        header={{ icon: null, title: "Prueba", fecha: "1 oct" }}
        sidebarPie={sidebarPie}
      >
        <div>contenido</div>
      </VerticalShellConectado>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
  });
  return r;
}

const pildoraChat = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("aside button, aside a")].find((e) => e.getAttribute("aria-label") === "Pregunta a tus datos");

describe("VerticalShellConectado — pie del Sidebar", () => {
  it("con el asistente activo el pie trae 'Pregunta a tus datos' y al tocarla abre la conversacion real", async () => {
    rendered = await montar(conexion(true));
    const pildora = pildoraChat(rendered.container);
    expect(pildora).toBeDefined();
    expect(pildora!.textContent).toContain("→");
    click(pildora!);
    const dialogo = document.body.querySelector('[role="dialog"]');
    expect(dialogo).not.toBeNull();
    // Conversacion real (con sugerencias del servidor), no el aviso de "todavia no esta disponible".
    expect(dialogo!.textContent).not.toContain("todavía no está disponible");
    expect(dialogo!.textContent).toContain("¿Cuánto vendí hoy?");
  });

  it("si el servidor dice que el asistente no esta activo, NO hay pildora de chat en el pie", async () => {
    rendered = await montar(conexion(false));
    expect(pildoraChat(rendered.container)).toBeUndefined();
  });

  it("sin conexion de chat tampoco hay pildora, y las pildoras del shell se conservan", async () => {
    rendered = await montar(undefined, [{ label: "Costos de IA", to: "/costos" }]);
    expect(pildoraChat(rendered.container)).toBeUndefined();
    const costos = rendered.container.querySelector<HTMLAnchorElement>('aside a[aria-label="Costos de IA"]');
    expect(costos?.getAttribute("href")).toBe("/costos");
  });

  it("la tarjeta de usuario muestra el nombre y el rol legible", async () => {
    rendered = await montar(undefined);
    const aside = rendered.container.querySelector("aside")!;
    expect(aside.textContent).toContain("Ana Pérez");
    expect(aside.textContent).toContain("Propietario");
  });
});
