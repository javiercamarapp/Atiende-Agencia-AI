// Avisos de inicio/fin de cada herramienta (lo que sincroniza el tecleo en los dos motores), con ejecutores FALSOS.
import { describe, expect, it } from "vitest";
import { OrquestadorTecleo, conAvisosDeHerramienta } from "../src/index.ts";

const falso = (resultado: { ok: boolean } | Error, espera?: Promise<void>) => ({
  definiciones: () => [],
  async ejecutar(_nombre: string, _args: unknown): Promise<{ ok: boolean }> {
    await espera;
    if (resultado instanceof Error) throw resultado;
    return resultado;
  },
});

describe("conAvisosDeHerramienta", () => {
  it("avisa inicio antes de ejecutar y fin despues, con ok, y devuelve el resultado intacto", async () => {
    const eventos: string[] = [];
    let soltar!: () => void;
    const espera = new Promise<void>((r) => (soltar = r));
    const e = conAvisosDeHerramienta(falso({ ok: true }, espera), { inicia: (id, n) => eventos.push(`inicia ${id} ${n}`), termina: (id, ok) => eventos.push(`termina ${id} ${ok}`) });
    const p = e.ejecutar("cotizar_pedido", {} as never);
    expect(eventos).toEqual(["inicia herr-1 cotizar_pedido"]);
    soltar();
    expect(await p).toEqual({ ok: true });
    expect(eventos).toEqual(["inicia herr-1 cotizar_pedido", "termina herr-1 true"]);
    expect(e.definiciones()).toEqual([]);
  });

  it("si la herramienta lanza, igual avisa el fin con ok=false y repropaga el error", async () => {
    const eventos: string[] = [];
    const e = conAvisosDeHerramienta(falso(new Error("x")), { inicia: () => eventos.push("i"), termina: (_i, ok) => eventos.push(`t ${ok}`) });
    await expect(e.ejecutar("crear_pedido", {} as never)).rejects.toThrow("x");
    expect(eventos).toEqual(["i", "t false"]);
  });

  it("un resultado ok=false (timeout o error del servidor) termina con ok=false", async () => {
    const fin: boolean[] = [];
    const e = conAvisosDeHerramienta(falso({ ok: false }), { inicia: () => undefined, termina: (_i, ok) => void fin.push(ok) });
    await e.ejecutar("buscar_cliente", {} as never);
    expect(fin).toEqual([false]);
  });

  it("`incluir` deja fuera las herramientas que no son 'anotar' (por ejemplo, pasar con una persona)", async () => {
    const eventos: string[] = [];
    const e = conAvisosDeHerramienta(falso({ ok: true }), { inicia: (_i, n) => eventos.push(n), termina: () => undefined, incluir: (n) => n !== "escalar_a_persona" });
    await e.ejecutar("escalar_a_persona", {} as never);
    await e.ejecutar("cotizar_pedido", {} as never);
    expect(eventos).toEqual(["cotizar_pedido"]);
  });

  it("conectado al orquestador de tecleo: suena mientras la herramienta esta en vuelo y no despues", async () => {
    const o = new OrquestadorTecleo({ volumen: 12, semilla: 1 });
    let soltar!: () => void;
    const espera = new Promise<void>((r) => (soltar = r));
    const e = conAvisosDeHerramienta(falso({ ok: true }, espera), { inicia: (id) => o.herramientaInicia(id), termina: (id, ok) => o.herramientaTermina(id, ok) });
    const p = e.ejecutar("cotizar_pedido", {} as never);
    expect(o.herramientasEnVuelo).toBe(1);
    soltar();
    await p;
    expect(o.herramientasEnVuelo).toBe(0);
  });
});
