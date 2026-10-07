// @vitest-environment jsdom
//
// Datos de la empresa -- perfil completo (L-P3-03/04): General + MIPyME pendiente de verificacion legal, Socios, Restricciones y firmantes
// con vigencia y semaforo. Contra un fetch simulado: todo control hace una peticion real a la API; lo que el servidor rechazaria igual se
// muestra con su mensaje. La base sin la migracion 040 se declara "no disponible aun" y no ofrece captura.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { DatosEmpresaPage } from "../src/verticals/licitaciones/pages/DatosEmpresa.tsx";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const USER = "00000000-0000-0000-0000-0000000000a1";
const OTRA = "00000000-0000-0000-0000-0000000000b2";
const jwt = (sub: string) => `h.${btoa(JSON.stringify({ sub })).replace(/=+$/u, "")}.s`;
const ctx = (role: string, sub = USER): LicitacionesShellContext => ({ apiBaseUrl: "https://api.test", token: jwt(sub), propertyId: "prop-1", orgSlug: "demo", role, staffFullName: "Ana", staffEmail: "ana@example.com" });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
const PEOPLE = { [USER]: "Ana", [OTRA]: "Beto" };
const procedencia = (by = OTRA) => ({ by, source: "manual", at: "2026-03-01T10:00:00.000Z" });
const dato = (over: Record<string, unknown>) => ({ approvalStatus: "pendiente_aprobacion", proposedBy: OTRA, approvedBy: null, approvedAt: null, ...over });

interface Stub {
  disponible?: boolean;
  profile?: unknown;
  mipyme?: unknown;
  stakeholders?: unknown[];
  stakeholderProvenance?: Record<string, unknown>;
  restrictions?: unknown[];
  signers?: unknown[];
  vigenciaDisponible?: boolean;
  documents?: unknown[];
  writeResponse?: () => Response;
}

const NORMA = { id: "ldcmipyme-estratificacion", titulo: "Estratificación", estadoVerificacion: "sin_verificar", validarConAbogado: true, nota: "Confirmar con abogado." };

function stub(o: Stub = {}) {
  const disponible = o.disponible ?? true;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.endsWith("/auth/2fa/status")) return json({ available: true, enabled: false, pending: false, lockedUntil: null, backupCodesRemaining: 0 });
    if (method === "GET") {
      if (u.endsWith("/company/profile")) return json({ disponible, profile: o.profile ?? null, mipyme: o.mipyme ?? null, norma: NORMA, people: PEOPLE, provenance: o.profile ? { "p1": procedencia() } : {} });
      if (u.endsWith("/company/stakeholders")) return json({ disponible, stakeholders: o.stakeholders ?? [], people: PEOPLE, provenance: o.stakeholderProvenance ?? {} });
      if (u.endsWith("/company/restrictions")) return json({ disponible, restrictions: o.restrictions ?? [], people: PEOPLE, provenance: {} });
      if (u.endsWith("/company/documents")) return json({ documents: o.documents ?? [], people: PEOPLE });
      if (u.endsWith("/company/rates")) return json({ rates: [], people: {} });
      if (u.endsWith("/company/capabilities")) return json({ capabilities: [], people: {} });
      if (u.endsWith("/company/experience")) return json({ experience: [], people: {} });
      if (u.endsWith("/company/signers")) return json({ signers: o.signers ?? [], vigenciaDisponible: o.vigenciaDisponible ?? true, people: PEOPLE, provenance: {} });
    }
    if (o.writeResponse) return o.writeResponse();
    return json({ id: "nuevo" }, method === "POST" ? 201 : 200);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function montar(c: LicitacionesShellContext, tab: string) {
  rendered = renderComponent(
    <MemoryRouter initialEntries={[`/x?tab=${tab}`]}>
      <DatosEmpresaPage {...c} />
    </MemoryRouter>,
  );
  await settle();
  return rendered;
}
const texto = () => rendered!.container.textContent ?? "";
const boton = (t: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === t) as HTMLButtonElement | undefined;
const campo = (id: string) => rendered!.container.querySelector(`#${id}`) as HTMLInputElement | HTMLSelectElement;
const escrituras = (method: string) => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method);
const cuerpo = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;

const PERFIL = { id: "p1", legalName: "Acme SA de CV", taxId: "ACM010101AB1", tradeName: null, sector: "servicios", foundedYear: 2010, employeeCount: 12, annualSalesCents: 150_000_050, website: null, ...dato({}) };

describe("General: perfil y estratificacion MIPyME", () => {
  it("muestra el perfil con quien lo capturo y cuando, el estrato calculado y que esta PENDIENTE DE VERIFICACION LEGAL", async () => {
    stub({ profile: PERFIL, mipyme: { status: "calculado", estrato: "pequena", puntajeCombinado: "136.2", verificacion: "sin_verificar", validarConAbogado: true } });
    await montar(ctx("owner"), "general");
    expect(texto()).toContain("Acme SA de CV");
    expect(texto()).toContain("ACM010101AB1");
    expect(texto()).toContain("$1,500,000.50");
    expect(texto()).toContain("Capturó: Beto · 2026-03-01 10:00 UTC (captura manual)");
    expect(rendered!.container.querySelector('[data-testid="mipyme-resultado"]')!.textContent).toContain("Pequeña empresa");
    expect(texto()).toContain("Pendiente de verificación legal");
    expect(texto()).toContain("sin_verificar");
  });

  it("sin datos suficientes dice cuales faltan y no inventa un estrato", async () => {
    stub({ profile: { ...PERFIL, employeeCount: null }, mipyme: { status: "no_evaluable", motivo: "x", faltan: ["numero de trabajadores"], verificacion: "sin_verificar", validarConAbogado: true } });
    await montar(ctx("owner"), "general");
    const r = rendered!.container.querySelector('[data-testid="mipyme-resultado"]')!.textContent!;
    expect(r).toContain("No evaluable: falta numero de trabajadores");
    expect(r).not.toMatch(/Microempresa|Pequeña|Mediana|grande/);
  });

  it("guardar manda PUT con las ventas en CENTAVOS y los vacios como null; un error del servidor se muestra y no borra el formulario", async () => {
    stub({ writeResponse: () => json({ message: "taxId: formato invalido." }, 400) });
    await montar(ctx("writer"), "general");
    expect(texto()).toContain("Aún no capturas el perfil de la empresa");
    changeValue(campo("perfil-razon") as HTMLInputElement, "Acme");
    changeValue(campo("perfil-rfc") as HTMLInputElement, "mal");
    changeValue(campo("perfil-sector") as HTMLSelectElement, "servicios");
    changeValue(campo("perfil-trabajadores") as HTMLInputElement, "12");
    changeValue(campo("perfil-ventas") as HTMLInputElement, "1500000.5");
    await submitForm(rendered!.container.querySelector("form")!);
    await settle();
    const put = escrituras("PUT");
    expect(put).toHaveLength(1);
    expect(cuerpo(put[0]!)).toMatchObject({ legalName: "Acme", taxId: "mal", sector: "servicios", employeeCount: 12, annualSalesCents: 150_000_050, tradeName: null, foundedYear: null, website: null });
    expect(texto()).toContain("taxId: formato invalido.");
    expect((campo("perfil-razon") as HTMLInputElement).value).toBe("Acme");
  });

  it("ventas o trabajadores mal escritos se rechazan en pantalla SIN llamar al servidor", async () => {
    stub();
    await montar(ctx("writer"), "general");
    changeValue(campo("perfil-razon") as HTMLInputElement, "Acme");
    changeValue(campo("perfil-rfc") as HTMLInputElement, "ACM010101AB1");
    changeValue(campo("perfil-ventas") as HTMLInputElement, "mucho");
    await submitForm(rendered!.container.querySelector("form")!);
    await settle();
    expect(escrituras("PUT")).toHaveLength(0);
    expect(texto()).toContain("Ventas anuales: escribe un monto en pesos");
  });

  it("el viewer ve el perfil sin formulario; el analyst (otra persona) ve Aprobar", async () => {
    stub({ profile: PERFIL, mipyme: null });
    await montar(ctx("viewer"), "general");
    expect(rendered!.container.querySelector("form")).toBeNull();
    expect(boton("Aprobar")).toBeUndefined();
    rendered!.unmount();
    stub({ profile: PERFIL, mipyme: null });
    await montar(ctx("analyst"), "general");
    expect(boton("Aprobar")).toBeDefined();
  });

  it("sin la migracion 040: 'No disponible aún', sin formulario y sin estratificacion", async () => {
    stub({ disponible: false });
    await montar(ctx("owner"), "general");
    expect(texto()).toContain("No disponible aún");
    expect(rendered!.container.querySelector("form")).toBeNull();
    expect(texto()).not.toContain("Estratificación MIPyME");
  });
});

describe("Socios y restricciones", () => {
  const SOCIO = (over: Record<string, unknown> = {}) => dato({ id: "k1", kind: "socio", fullName: "Ana Pérez", rfc: "PEPA800101AB1", participationPct: "60.00", ...over });

  it("lista socios con procedencia; uno SIN procedencia se declara bloqueado ('Sin procedencia')", async () => {
    stub({ stakeholders: [SOCIO(), SOCIO({ id: "k2", fullName: "Socio por SQL" })], stakeholderProvenance: { k1: procedencia() } });
    await montar(ctx("owner"), "socios");
    expect(texto()).toContain("Ana Pérez");
    expect(texto()).toContain("60.00%");
    expect(texto()).toContain("Capturó: Beto");
    expect(texto()).toContain("Sin procedencia");
    expect(texto()).toContain("No se usa en propuestas ni en el matching");
  });

  it("alta de socio: POST con el porcentaje; un representante NO ve el campo de porcentaje", async () => {
    stub();
    await montar(ctx("writer"), "socios");
    expect(campo("stakeholders-participationPct")).not.toBeNull();
    changeValue(campo("stakeholders-fullName") as HTMLInputElement, "Beto Ruiz");
    changeValue(campo("stakeholders-participationPct") as HTMLInputElement, "40");
    await submitForm(rendered!.container.querySelector("form")!);
    await settle();
    expect(cuerpo(escrituras("POST")[0]!)).toEqual({ kind: "socio", fullName: "Beto Ruiz", participationPct: "40" });

    changeValue(campo("stakeholders-kind") as HTMLSelectElement, "representante");
    await settle();
    expect(campo("stakeholders-participationPct")).toBeNull();
  });

  it("un 400 del servidor (la suma pasa de 100) se muestra tal cual", async () => {
    stub({ writeResponse: () => json({ message: "participationPct: la suma de las participaciones de los socios no puede pasar de 100.00." }, 400) });
    await montar(ctx("writer"), "socios");
    changeValue(campo("stakeholders-fullName") as HTMLInputElement, "Beto");
    changeValue(campo("stakeholders-participationPct") as HTMLInputElement, "80");
    await submitForm(rendered!.container.querySelector("form")!);
    await settle();
    expect(texto()).toContain("no puede pasar de 100.00");
  });

  it("editar precarga el formulario y manda PATCH sin el tipo; vaciar un opcional lo borra (null)", async () => {
    stub({ stakeholders: [SOCIO()], stakeholderProvenance: { k1: procedencia() } });
    await montar(ctx("writer"), "socios");
    click(boton("Editar")!);
    await settle();
    expect((campo("stakeholders-fullName") as HTMLInputElement).value).toBe("Ana Pérez");
    changeValue(campo("stakeholders-rfc") as HTMLInputElement, "");
    await submitForm(rendered!.container.querySelector("form")!);
    await settle();
    const patch = escrituras("PATCH");
    expect(patch).toHaveLength(1);
    expect(String(patch[0]![0])).toContain("/company/stakeholders/k1");
    expect(cuerpo(patch[0]!)).toEqual({ fullName: "Ana Pérez", rfc: null, participationPct: "60.00" });
  });

  it("eliminar un socio exige rol de decision (el writer no ve el boton) y confirmar; Cancelar no borra", async () => {
    stub({ stakeholders: [SOCIO()], stakeholderProvenance: { k1: procedencia() } });
    await montar(ctx("writer"), "socios");
    expect(boton("Eliminar")).toBeUndefined();
    rendered!.unmount();
    stub({ stakeholders: [SOCIO()], stakeholderProvenance: { k1: procedencia() } });
    await montar(ctx("analyst"), "socios");
    click(boton("Eliminar")!);
    await settle();
    const dialogo = () => document.body.querySelector('[role="alertdialog"]')!;
    const dlg = (t: string) => [...dialogo().querySelectorAll("button")].find((b) => b.textContent?.includes(t)) as HTMLButtonElement;
    await act(async () => {
      click(dlg("Cancelar"));
      await flushMicrotasks();
    });
    await settle();
    expect(escrituras("DELETE")).toHaveLength(0);
    click(boton("Eliminar")!);
    await settle();
    await act(async () => {
      click(dlg("Eliminar"));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    await settle();
    expect(escrituras("DELETE")).toHaveLength(1);
    expect(String(escrituras("DELETE")[0]![0])).toContain("/company/stakeholders/k1");
  });

  it("restricciones: estado vacio con siguiente accion; alta con fechas", async () => {
    stub();
    await montar(ctx("writer"), "restricciones");
    expect(texto()).toContain("No hay restricciones capturadas");
    changeValue(campo("restrictions-description") as HTMLInputElement, "Sanción de prueba");
    changeValue(campo("restrictions-validFrom") as HTMLInputElement, "2026-01-01");
    await submitForm(rendered!.container.querySelector("form")!);
    await settle();
    expect(cuerpo(escrituras("POST")[0]!)).toEqual({ kind: "sancion", description: "Sanción de prueba", validFrom: "2026-01-01" });
  });
});

describe("Firmantes con vigencia del poder", () => {
  const HOY = new Date(2026, 5, 15, 12, 0, 0); // 15-jun-2026 hora local
  const firmante = (over: Record<string, unknown>) => ({ ...dato({ approvalStatus: "aprobado" }), role: "representante_legal", authorized: true, validFrom: "2026-01-01", validUntil: null, identityDocId: null, actionLimits: null, ...over });

  it("semaforo: vigente / por vencer / vencido / aun no vigente / sin vigencia, con varios del mismo cargo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(HOY);
    stub({
      signers: [
        firmante({ id: "s1", name: "Vigente", validUntil: "2027-12-31" }),
        firmante({ id: "s2", name: "PorVencer", validUntil: "2026-07-01" }),
        firmante({ id: "s3", name: "Vencido", validUntil: "2026-06-01" }),
        firmante({ id: "s4", name: "Futuro", validFrom: "2026-09-01" }),
        firmante({ id: "s5", name: "Legado", validFrom: null, validUntil: null }),
      ],
    });
    await montar(ctx("owner"), "firmantes");
    const t = texto();
    for (const etiqueta of ["Poder vigente", "Poder por vencer", "Poder vencido", "Poder aún no vigente", "Sin vigencia capturada"]) expect(t, etiqueta).toContain(etiqueta);
    expect((t.match(/representante_legal/g) ?? []).length).toBe(5);
  });

  it("alta: vigencia, documento de identidad y limites viajan al servidor; 'Vigente desde' es obligatorio", async () => {
    stub({ documents: [{ id: "doc-1", type: "poder", label: "Poder notarial 123", expiresAt: null, approvalStatus: "aprobado" }] });
    await montar(ctx("writer"), "firmantes");
    expect((campo("firmante-desde") as HTMLInputElement).required).toBe(true);
    changeValue(campo("firmante-nombre") as HTMLInputElement, "Ana López");
    changeValue(campo("firmante-rol") as HTMLInputElement, "representante_legal");
    changeValue(campo("firmante-desde") as HTMLInputElement, "2026-01-01");
    changeValue(campo("firmante-hasta") as HTMLInputElement, "2026-12-31");
    changeValue(campo("firmante-documento") as HTMLSelectElement, "doc-1");
    changeValue(campo("firmante-limites") as HTMLInputElement, "hasta 5 mdp");
    await submitForm(rendered!.container.querySelector("form")!);
    await settle();
    expect(cuerpo(escrituras("POST")[0]!)).toEqual({ name: "Ana López", role: "representante_legal", authorized: true, validFrom: "2026-01-01", validUntil: "2026-12-31", identityDocId: "doc-1", actionLimits: "hasta 5 mdp" });
  });

  it("sin la migracion 040 el formulario no ofrece vigencia y el alta viaja como antes", async () => {
    stub({ vigenciaDisponible: false, signers: [firmante({ id: "s1", name: "Legado", validFrom: undefined })] });
    await montar(ctx("writer"), "firmantes");
    expect(campo("firmante-desde")).toBeNull();
    expect(texto()).toContain("No disponible aún: la vigencia del poder requiere la migración 040");
    changeValue(campo("firmante-nombre") as HTMLInputElement, "Ana");
    changeValue(campo("firmante-rol") as HTMLInputElement, "rep");
    await submitForm(rendered!.container.querySelector("form")!);
    await settle();
    expect(cuerpo(escrituras("POST")[0]!)).toEqual({ name: "Ana", role: "rep", authorized: true });
  });

  it("Renovar poder pide la nueva fecha y manda PATCH validUntil; una fecha mal escrita no se manda", async () => {
    stub({ signers: [firmante({ id: "s1", name: "Ana", validUntil: "2026-06-30" })] });
    await montar(ctx("writer"), "firmantes");
    click(boton("Renovar poder")!);
    await settle();
    const dlg = document.body.querySelector('[role="alertdialog"]')!;
    const input = dlg.querySelector("input") as HTMLInputElement;
    const confirmar = [...dlg.querySelectorAll("button")].find((b) => b.textContent?.includes("Renovar poder")) as HTMLButtonElement;
    changeValue(input, "31/12/2027");
    await act(async () => {
      click(confirmar);
      await flushMicrotasks();
    });
    await settle();
    expect(escrituras("PATCH")).toHaveLength(0);
    changeValue(input, "2027-12-31");
    await act(async () => {
      click(confirmar);
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    await settle();
    expect(escrituras("PATCH")).toHaveLength(1);
    expect(cuerpo(escrituras("PATCH")[0]!)).toEqual({ validUntil: "2027-12-31" });
  });
});
