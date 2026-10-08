// Dialogos del panel de restaurantes: para CADA accion con confirmacion o formulario en dialogo, Cancelar y Escape NO hacen ninguna
// escritura (vigilante de red del mock) y confirmar hace EXACTAMENTE una, con el cuerpo esperado.
import type { Page } from "@playwright/test";
import { afirmarCancelarNoEscribe, dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { cuerpoDe, esperarEscrituras, ir } from "../../helpers/recorrido.ts";

const main = (page: Page) => page.locator("main#contenido-principal");

// El foco no vuelve al disparador al cerrar (BUG-E2E-001, ya documentado en humo-restaurantes.spec.ts): estos recorridos
// verifican la regla de negocio (cero escrituras) y dejan el foco a ese test marcado test.fail.
const SIN_FOCO = { verificarFoco: false } as const;

test.describe("restaurantes: dialogos, Cancelar y Escape nunca ejecutan @recorrido", () => {
  test.beforeEach(async ({ iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
  });

  test("Pedidos > Cancelar pedido: Volver y Escape no escriben; confirmar (con motivo) hace un PATCH cancelado", async ({ page, mock, vigilante }) => {
    await ir(page, "/pedidos");
    const cancelar = main(page).getByRole("button", { name: "Cancelar pedido" }).first();
    await afirmarCancelarNoEscribe(page, mock, cancelar, { nombre: "¿Cancelar este pedido?", botonCancelar: "Volver", ...SIN_FOCO });
    await cancelar.click();
    const dlg = dialogo(page, "¿Cancelar este pedido?");
    // Con el autopiloto el boton queda desactivado hasta elegir un motivo de la lista cerrada y el PATCH lo lleva.
    await expect(dlg.getByRole("button", { name: "Sí, cancelar pedido" })).toBeDisabled();
    await dlg.getByRole("combobox").selectOption("cliente_desistio");
    await dlg.getByRole("button", { name: "Sí, cancelar pedido" }).click();
    const [patch] = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/orders/ord-1001/status" });
    expect(cuerpoDe(patch)).toEqual({ status: "cancelado", motivo: "cliente_desistio" });
    vigilante.verificar();
  });

  test("Staff > Dar de baja a Ramon Uc: Cancelar y Escape no escriben; confirmar hace un DELETE", async ({ page, mock, vigilante }) => {
    await ir(page, "/staff");
    const fila = page.locator("xpath=//p[normalize-space()='Ramon Uc']/../..");
    const baja = fila.getByRole("button", { name: "Dar de baja" });
    await afirmarCancelarNoEscribe(page, mock, baja, { nombre: /Dar de baja a/, ...SIN_FOCO });
    await baja.click();
    await dialogo(page, /Dar de baja a/).getByRole("button", { name: "Dar de baja" }).click();
    await esperarEscrituras(mock, { metodo: "DELETE", ruta: "/staff/miembros/usr-2" });
    vigilante.verificar();
  });

  test("Staff > Revocar invitacion: Cancelar y Escape no escriben; confirmar hace un DELETE", async ({ page, mock, vigilante }) => {
    await ir(page, "/staff");
    await mock.agregarAEstado("rest.invitaciones", { id: "inv-seed", email: "pendiente@example.test", verticalRole: "staff", propertyIds: null, status: "pendiente", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), createdAt: new Date().toISOString() });
    await page.reload();
    const revocar = main(page).getByRole("button", { name: "Revocar" });
    await expect(revocar).toBeVisible();
    await afirmarCancelarNoEscribe(page, mock, revocar, { nombre: /Revocar la invitación/, ...SIN_FOCO });
    await revocar.click();
    await dialogo(page, /Revocar la invitación/).getByRole("button", { name: "Revocar" }).click();
    await esperarEscrituras(mock, { metodo: "DELETE", ruta: "/staff/invitaciones/inv-seed" });
    vigilante.verificar();
  });

  test("Configuracion > Quitar zona: Cancelar y Escape no escriben; confirmar hace un DELETE", async ({ page, mock, vigilante }) => {
    await ir(page, "/configuracion");
    const quitar = page.getByRole("button", { name: "Quitar zona Centro" });
    await expect(quitar).toBeVisible();
    await afirmarCancelarNoEscribe(page, mock, quitar, { nombre: /Quitar "Centro"/, ...SIN_FOCO });
    await quitar.click();
    await dialogo(page, /Quitar "Centro"/).getByRole("button", { name: "Quitar zona" }).click();
    await esperarEscrituras(mock, { metodo: "DELETE", ruta: "/config/zonas/zona-1" });
    vigilante.verificar();
  });

  test("Configuracion > Volver al perfil por defecto del agente: Cancelar y Escape no restablecen", async ({ page, mock, vigilante }) => {
    await ir(page, "/configuracion");
    const volver = page.getByRole("button", { name: "Volver al perfil por defecto" });
    await expect(volver).toBeVisible();
    await afirmarCancelarNoEscribe(page, mock, volver, SIN_FOCO);
    vigilante.verificar();
  });

  test("Configuracion > Volver al perfil por defecto del agente: confirmar hace exactamente un POST /restablecer", async ({ page, mock, vigilante }) => {
    await ir(page, "/configuracion");
    await page.getByRole("button", { name: "Volver al perfil por defecto" }).click();
    await mock.limpiarRegistro();
    await page.getByRole("alertdialog").getByRole("button", { name: "Volver al perfil por defecto" }).click();
    const posts = await esperarEscrituras(mock, { metodo: "POST", ruta: "/config/agente-whatsapp/restablecer" });
    expect(posts).toHaveLength(1);
    await expect(page.getByText("Se restableció el perfil por defecto.")).toBeVisible();
    expect(await mock.escrituras()).toHaveLength(1);
    vigilante.verificar();
  });

  test("Promociones > Editar vigencia: guardar hace exactamente un PATCH con las fechas", async ({ page, mock, vigilante }) => {
    await ir(page, "/promociones");
    await main(page).getByRole("button", { name: "Editar vigencia" }).click();
    const d = dialogo(page, "Editar vigencia");
    await d.getByLabel("Vigente hasta").fill("2028-01-31");
    await mock.limpiarRegistro();
    await d.getByRole("button", { name: "Guardar" }).click();
    const patches = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/promotions/promo-1" });
    expect(patches).toHaveLength(1);
    expect(cuerpoDe(patches[0])).toHaveProperty("endsAt");
    await expect(d).toBeHidden();
    vigilante.verificar();
  });

  test("Copiloto > Borrar chat: Cancelar y Escape no borran; confirmar hace un DELETE", async ({ page, mock, vigilante }) => {
    await ir(page, "/copiloto");
    await page.getByRole("button", { name: "¿Cuánto vendí esta semana?" }).click();
    await expect(page.getByText("En los últimos 7 días vendiste")).toBeVisible();
    await page.getByRole("button", { name: "Historial de chats" }).click();
    const panel = page.getByRole("dialog", { name: "Historial de chats" });
    const borrar = panel.getByRole("button", { name: /^Borrar / });
    await expect(borrar).toBeVisible();
    await mock.limpiarRegistro();
    const pedirBorrado = async (): Promise<void> => {
      // El panel puede seguir abierto o haberse cerrado tras el dialogo: el estado lo dice aria-expanded del disparador.
      const disparador = page.getByRole("button", { name: "Historial de chats", expanded: false });
      if (await disparador.count()) await disparador.click();
      await expect(panel).toBeVisible();
      await borrar.click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    };
    await pedirBorrado();
    await page.getByRole("alertdialog").getByRole("button", { name: /^(Cancelar|Volver)$/ }).click();
    expect(await mock.escrituras(), "Cancelar el borrado no debe escribir").toEqual([]);
    await pedirBorrado();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("alertdialog")).toBeHidden();
    expect(await mock.escrituras(), "Escape en el borrado no debe escribir").toEqual([]);
    await pedirBorrado();
    await page.getByRole("alertdialog").getByRole("button", { name: "Borrar", exact: true }).click();
    await esperarEscrituras(mock, { metodo: "DELETE", ruta: "/chat-datos/conversaciones/" });
    vigilante.verificar();
  });

  const FORMULARIOS = [
    { sub: "/productos", disparador: "Nueva categoría", nombre: "Nueva categoría" },
    { sub: "/productos", disparador: "Nuevo producto", nombre: "Nuevo producto" },
    { sub: "/promociones", disparador: "Crear un código nuevo", nombre: "Crear un código nuevo" },
    { sub: "/promociones", disparador: "Editar vigencia", nombre: "Editar vigencia" },
    { sub: "/staff", disparador: "Invitar a alguien", nombre: "Invitar a alguien nuevo" },
  ] as const;

  for (const f of FORMULARIOS) {
    test(`Formulario "${f.nombre}": Cerrar y Escape no escriben, ni siquiera con datos a medio llenar`, async ({ page, mock, vigilante }) => {
      await ir(page, f.sub);
      const disparador = main(page).getByRole("button", { name: f.disparador });
      await expect(disparador).toBeVisible();
      await mock.limpiarRegistro();
      for (const via of ["cancelar", "escape"] as const) {
        await disparador.click();
        const d = dialogo(page, f.nombre);
        await expect(d).toBeVisible();
        const primero = d.locator("input[type=text], input[type=email], input:not([type]), textarea").first();
        if (await primero.count()) await primero.fill("dato a medio llenar");
        // El FormDialog no tiene boton "Cancelar": se cierra con la X ("Cerrar") o con Escape.
        if (via === "cancelar") await d.getByRole("button", { name: "Cerrar" }).click();
        else await page.keyboard.press("Escape");
        await expect(d).toBeHidden();
        expect(await mock.escrituras(), `tras ${via} no debe haber escrituras`).toEqual([]);
      }
      vigilante.verificar();
    });
  }

  // BUG-E2E-001 tambien afecta a los FormDialog: documentado aqui con test.fail para que avise cuando se corrija packages/ui.
  test("el foco vuelve al boton que abrio un FormDialog (BUG-E2E-001, defecto conocido)", async ({ page, mock }) => {
    test.fail(true, "BUG-E2E-001: el foco cae en <body> al cerrar el dialogo; quitar test.fail al corregir packages/ui");
    await ir(page, "/productos");
    const disparador = main(page).getByRole("button", { name: "Nueva categoría" });
    await afirmarCancelarNoEscribe(page, mock, disparador, { nombre: "Nueva categoría", botonCancelar: "Cerrar" });
  });
});
