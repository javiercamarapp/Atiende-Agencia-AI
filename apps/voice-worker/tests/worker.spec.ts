// Ciclo de vida del worker: estado honesto en /salud (503 con motivos si no esta configurado, y NUNCA contesta a medias), recepcion de llamadas y apagado ordenado.
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crearEscaleraLlamada } from "@atiende/voice-core";
import { cargarConfig } from "../src/config.ts";
import { TelefoniaFalsa } from "../src/telefonia/falsa.ts";
import { Worker, crearServidorSalud } from "../src/worker.ts";
import { AgenteGuionado } from "./support/agente-guionado.ts";
import { escenario } from "./support/escenario.ts";
import { NUMERO_SUCURSAL, crearMundoApi } from "./support/mundo-api.ts";

const servidores: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const s of servidores.splice(0)) s.close();
});

async function pedirSalud(worker: Worker): Promise<{ status: number; cuerpo: Record<string, unknown> }> {
  const servidor = crearServidorSalud(worker);
  servidores.push(servidor);
  await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
  const { port } = servidor.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/salud`);
  return { status: res.status, cuerpo: (await res.json()) as Record<string, unknown> };
}

describe("worker NO configurado", () => {
  it("/salud responde 503 con los motivos (nombres de variables, nunca valores) y no escucha llamadas", async () => {
    const config = cargarConfig({ LIVEKIT_API_SECRET: "valor-secreto-que-no-debe-salir" });
    const telefonia = new TelefoniaFalsa();
    const escuchar = vi.spyOn(telefonia, "escuchar");
    const eventos: string[] = [];
    const worker = new Worker({ config, telefonia, deps: null, log: (e, c) => void eventos.push(`${e} ${JSON.stringify(c ?? {})}`) });

    expect(await worker.iniciar()).toBe(false);
    expect(escuchar).not.toHaveBeenCalled();
    const { status, cuerpo } = await pedirSalud(worker);
    expect(status).toBe(503);
    expect(cuerpo).toMatchObject({ estado: "no_configurado", escuchando: false, llamadasActivas: 0 });
    const motivos = (cuerpo.motivos as string[]).join(" ");
    expect(motivos).toContain("LIVEKIT_URL");
    expect(motivos).toContain("ATIENDE_API_URL");
    expect(JSON.stringify(cuerpo) + eventos.join("\n")).not.toContain("valor-secreto-que-no-debe-salir");
    // Registra el motivo (para el operador) sin valores.
    expect(eventos.some((e) => e.startsWith("worker_motivo") && e.includes("LIVEKIT_URL"))).toBe(true);
  });

  it("una llamada que llegara a un worker no configurado jamas se atiende (no hay deps ni telefonia que la reciban)", async () => {
    const worker = new Worker({ config: cargarConfig({}), telefonia: null, deps: null, log: () => undefined });
    expect(await worker.iniciar()).toBe(false);
    expect(worker.salud()).toMatchObject({ escuchando: false, llamadasActivas: 0, llamadasAtendidas: 0 });
  });

  it("una ruta desconocida da 404 y no expone nada", async () => {
    const worker = new Worker({ config: cargarConfig({}), telefonia: null, deps: null, log: () => undefined });
    const servidor = crearServidorSalud(worker);
    servidores.push(servidor);
    await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
    const { port } = servidor.address() as AddressInfo;
    expect((await fetch(`http://127.0.0.1:${port}/otra`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/salud`, { method: "POST" })).status).toBe(404);
  });
});

describe("worker configurado", () => {
  it("/salud responde 200, escucha y cuenta las llamadas atendidas", async () => {
    const api = await crearMundoApi();
    const t = await escenario(api, () => [new AgenteGuionado([]).escalon()]);
    expect((await pedirSalud(t.worker)).status).toBe(200);
    expect(t.worker.salud()).toMatchObject({ estado: "configurado", escuchando: true, llamadasActivas: 0, llamadasAtendidas: 0 });
    t.telefonia.llamar({ id: "llamada-desconocida", dnis: "+52 999 000 0000", desde: "+5219991234567" });
    await t.esperarFin();
    expect(t.worker.salud().llamadasAtendidas).toBe(1);
  });

  it("un fallo inesperado en UNA llamada no tumba al worker ni a las demas: se cuelga esa y se sigue", async () => {
    const api = await crearMundoApi();
    let n = 0;
    const t = await escenario(api, () => {
      n += 1;
      if (n === 1) throw new Error("falla al armar la escalera");
      return [new AgenteGuionado([]).escalon()];
    });
    const primera = t.telefonia.llamar({ id: "llamada-rota", dnis: NUMERO_SUCURSAL, desde: "+5219991234567" });
    await vi.waitFor(() => expect(primera.colgadaPorSistema).toBe(true), { timeout: 5_000, interval: 5 });
    expect(t.worker.salud().llamadasActivas).toBe(0);
    const segunda = t.telefonia.llamar({ id: "llamada-sana", dnis: NUMERO_SUCURSAL, desde: "+5219991234567" });
    await vi.waitFor(() => expect(api.peticiones.filter((p) => p.endsWith("/llamada/contexto")).length).toBe(2), { timeout: 5_000, interval: 5 });
    segunda.clienteCuelga();
    await vi.waitFor(() => expect(t.worker.salud().llamadasAtendidas).toBeGreaterThanOrEqual(1), { timeout: 5_000, interval: 5 });
  });
});

describe("apagado ordenado (SIGTERM)", () => {
  it("deja de escuchar, espera a las llamadas activas hasta el plazo y despues las ABORTA: cuelga y cierra la conversacion como abandonada", async () => {
    const api = await crearMundoApi();
    const agente = new AgenteGuionado([]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-viva", dnis: NUMERO_SUCURSAL, desde: "+5219991234567" });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    expect(t.worker.salud().llamadasActivas).toBe(1);

    await t.worker.detener(50); // plazo corto: la llamada sigue viva y se aborta
    expect(t.telefonia.detenida).toBe(true);
    expect(llamada.colgadaPorSistema).toBe(true);
    expect(t.worker.salud()).toMatchObject({ escuchando: false, llamadasActivas: 0, llamadasAtendidas: 1 });
    const conv = (await api.voz.listConversaciones(api.mundo.organizationId, api.mundo.propertyId, {})).valor.items;
    expect(conv).toHaveLength(1);
    expect(conv[0]).toMatchObject({ resultado: "abandonado" });
    expect(conv[0]?.endedAt).not.toBeNull();
  });

  it("sin llamadas activas el apagado es inmediato", async () => {
    const api = await crearMundoApi();
    const t = await escenario(api, () => [new AgenteGuionado([]).escalon()]);
    await t.worker.detener(10_000);
    expect(t.telefonia.detenida).toBe(true);
  });
});

describe("latido del sondeo de la telefonia (Fly solo informa con las health checks: el proceso se reinicia solo)", () => {
  class TelefoniaConLatido extends TelefoniaFalsa {
    latido: number | null = null;
    latidoMs(): number | null {
      return this.latido;
    }
  }
  async function armar(latido: number | null) {
    const api = await crearMundoApi();
    const telefonia = new TelefoniaConLatido();
    telefonia.latido = latido;
    const worker = new Worker({ config: api.config, telefonia, log: () => undefined, deps: api.depsAtencion({ crearEscalera: () => crearEscaleraLlamada([new AgenteGuionado([]).escalon()], { ahora: api.reloj.ahora }) }) });
    expect(await worker.iniciar()).toBe(true);
    return { worker, telefonia };
  }

  it("con latido reciente /salud es 200 y reporta cuanto hace del ultimo sondeo", async () => {
    const { worker } = await armar(Date.now() - 2_000);
    const r = await pedirSalud(worker);
    expect(r.status).toBe(200);
    expect(r.cuerpo).toMatchObject({ sano: true });
    expect(worker.salud().latidoHaceMs).toBeGreaterThanOrEqual(2_000);
  });

  it("con el sondeo sin responder mas de 60 s /salud es 503 aunque el proceso este vivo y configurado", async () => {
    const { worker } = await armar(Date.now() - 61_000);
    const r = await pedirSalud(worker);
    expect(r.status).toBe(503);
    expect(r.cuerpo).toMatchObject({ estado: "configurado", sano: false });
  });

  it("sin latido (telefonia que no sondea o primer sondeo pendiente) no se penaliza", async () => {
    const { worker } = await armar(null);
    expect(worker.salud()).toMatchObject({ sano: true, latidoHaceMs: null });
  });

  it("latidoVencido: solo con sondeo muerto mas de 2 min Y sin llamadas activas (nunca reinicia en medio de una llamada)", async () => {
    const { worker, telefonia } = await armar(Date.now() - 30_000);
    expect(worker.latidoVencido()).toBe(false);
    telefonia.latido = Date.now() - 121_000;
    expect(worker.latidoVencido()).toBe(true);
    telefonia.latido = null;
    expect(worker.latidoVencido()).toBe(false);
  });
});
