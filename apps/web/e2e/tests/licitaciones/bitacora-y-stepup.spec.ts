// L-P3-12/17 -- de punta a punta contra la API simulada: (1) el step-up es de UN SOLO USO, asi que aprobar dos cosas seguidas pide DOS
// confirmaciones (cada aprobacion abre su dialogo y pide un token nuevo; el servidor simulado rechaza el reuso); (2) la bitacora de
// escrituras de la organizacion: solo owner/admin, filtros (entidad, persona, correlacion), paginacion por llave y la traza de una
// convocatoria de punta a punta. Cancelar y Escape nunca escriben. Las reglas reales viven en pruebas de API y en el verify contra Postgres.
import { afirmarCancelarNoEscribe, dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { licitaciones } from "../../mock-api/fixtures/licitaciones.ts";
import { personaDe } from "../../mock-api/personas.ts";

const BASE = `/licitaciones/${licitaciones.orgSlug}`;

test.describe("licitaciones: step-up de un solo uso @humo", () => {
  test("aprobar dos tarifas seguidas pide dos confirmaciones: dos dialogos, dos tokens y dos POST", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    // Una segunda tarifa pendiente propuesta por otra persona (el owner no puede decidir lo que propuso).
    await mock.agregarAEstado("licitaciones.tarifasExtra", {
      id: "rate-3", concept: "supervision_noche", unitPrice: "950.00", currency: "MXN", approvalStatus: "pendiente_aprobacion", validFrom: "2026-01-01T00:00:00Z", validUntil: null,
      proposedBy: personaDe("licitaciones", "staff").id, approvedBy: null, approvedAt: null,
    });
    await page.goto(`${BASE}/datos-empresa?tab=tarifas`);
    await expect(page.getByText("consultoria_hora")).toBeVisible();
    await expect(page.getByText("supervision_noche")).toBeVisible();
    await mock.limpiarRegistro();

    const aprobar = page.getByRole("button", { name: "Aprobar", exact: true });
    await expect(aprobar).toHaveCount(2);

    // Cancelar y Escape no piden step-up ni escriben.
    await afirmarCancelarNoEscribe(page, mock, aprobar.first(), { nombre: /Confirma tu identidad/, verificarFoco: false });

    // Primera aprobacion: su propio dialogo y su propio token.
    await aprobar.first().click();
    await dialogo(page, /Confirma tu identidad/).getByLabel("Código de verificación en dos pasos").fill("123456");
    await dialogo(page, /Confirma tu identidad/).getByRole("button", { name: "Aprobar" }).click();
    await expect(aprobar).toHaveCount(1);
    expect(await mock.buscar({ metodo: "POST", ruta: "/auth/step-up" })).toHaveLength(1);

    // La segunda NO reutiliza el token de la primera: vuelve a pedir la confirmacion.
    await aprobar.first().click();
    await expect(dialogo(page, /Confirma tu identidad/)).toBeVisible();
    await dialogo(page, /Confirma tu identidad/).getByLabel("Código de verificación en dos pasos").fill("123456");
    await dialogo(page, /Confirma tu identidad/).getByRole("button", { name: "Aprobar" }).click();
    await expect(aprobar).toHaveCount(0);

    expect(await mock.buscar({ metodo: "POST", ruta: "/auth/step-up" })).toHaveLength(2);
    const posts = await mock.buscar({ metodo: "POST", ruta: /\/company\/rates\/rate-[13]\/approve/ });
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((x) => x.ruta)).size).toBe(2);
    vigilante.verificar();
  });
});

test.describe("licitaciones: bitacora de escrituras @humo", () => {
  test("owner: filtra por entidad, pagina por llave y sigue una correlacion hasta la traza de punta a punta", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    await page.goto(`${BASE}/bitacora`);
    await expect(page.getByRole("heading", { name: "Bitácora de cambios" }).or(page.getByText("Bitácora de cambios").first())).toBeVisible();
    await expect(page.getByText("Tarifa · editado").first()).toBeVisible();
    // La primera pagina trae 25 y ofrece cargar mas (30 renglones en total).
    await expect(page.getByRole("button", { name: "Cargar más" })).toBeVisible();
    await page.getByRole("button", { name: "Cargar más" }).click();
    await expect(page.getByRole("button", { name: "Cargar más" })).toHaveCount(0);
    await expect(page.getByText("Convocatoria · ingerida por la ingesta automática")).toBeVisible();

    // Filtro por entidad.
    await page.getByLabel("Entidad").selectOption("configuracion");
    await expect(page.getByText("Configuración · editada")).toBeVisible();
    await expect(page.getByText("Tarifa · editado")).toHaveCount(0);
    await expect(page.getByText("timezone").first()).toBeVisible();
    await expect(page.getByText("America/Cancun").first()).toBeVisible();
    await page.getByRole("button", { name: "Limpiar filtros" }).click();

    // Filtro por correlacion: reconstruye ingesta, version, las dos aprobaciones y el manifiesto.
    await page.getByLabel("Correlación").fill("ingesta-A1");
    await expect(page.getByText("Convocatoria · ingerida por la ingesta automática")).toBeVisible();
    await expect(page.getByText("Convocatoria · nueva versión registrada")).toBeVisible();
    await expect(page.getByText("Expediente · etapa aprobada")).toHaveCount(2);
    await expect(page.getByText("Paquete · manifiesto generado")).toBeVisible();
    await expect(page.getByText("Sistema (ingesta automática)")).toBeVisible();
    await expect(page.getByText("Tarifa · editado")).toHaveCount(0);

    // Traza por convocatoria (enlace de la ficha): cronologica y completa.
    await page.goto(`${BASE}/bitacora?convocatoria=tnd-1`);
    await expect(page.getByText("Traza de la convocatoria").first()).toBeVisible();
    await expect(page.getByText("Paquete · manifiesto generado")).toBeVisible();
    await expect(page.getByText("Convocatoria · ingerida por la ingesta automática")).toBeVisible();
    // Orden cronologico (la tabla en escritorio, las tarjetas en movil): ingesta -> version -> aprobaciones -> manifiesto.
    const cuerpo = (await page.locator("main#contenido-principal").innerText()).replace(/\s+/g, " ");
    const pos = ["Convocatoria · ingerida", "Convocatoria · nueva versión", "Expediente · etapa aprobada", "Paquete · manifiesto generado"].map((t) => cuerpo.indexOf(t));
    expect(pos.every((n) => n >= 0), `faltan eventos de la traza: ${pos.join(",")}`).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    vigilante.verificar();
  });

  test("un rol que no es owner/admin no ve la entrada de menu y por URL directa ve el aviso sin pedir la bitacora", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("licitaciones", "staff");
    await page.goto(`${BASE}/bitacora`);
    await expect(page.getByText("Solo el owner o un admin de la organización puede ver la bitácora de cambios.")).toBeVisible();
    expect(await mock.buscar({ ruta: "/audit-trail" })).toHaveLength(0);
    await page.goto(`${BASE}/panel`);
    await expect(page.getByRole("link", { name: "Bitácora" })).toHaveCount(0);
  });
});
