// Cliente de control del mock para las pruebas (corre en el proceso de Playwright, no en el navegador).
import type { Falla, RegistroPeticion } from "./tipos.ts";

export class ClienteMock {
  readonly escenario: string;
  readonly baseUrl: string;

  constructor(baseUrl: string, escenario: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.escenario = escenario;
  }

  private ruta(sufijo: string): string {
    return `${this.baseUrl}/__mock/escenarios/${encodeURIComponent(this.escenario)}/${sufijo}`;
  }

  /** Codigo de login para `/:vertical/auth/google/callback?code=…` (ver fixtures/auth.ts). */
  codigoLogin(personaId: string): string {
    return `${this.escenario}~${personaId}`;
  }

  async configurar(config: { latenciaMs?: number; fallas?: readonly Falla[]; agregarFallas?: readonly Falla[] }): Promise<void> {
    const res = await fetch(this.ruta("config"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(config) });
    if (!res.ok) throw new Error(`mock-api: configurar fallo (${res.status})`);
  }

  /** Atajo: la siguiente(s) `veces` peticiones que coincidan con `ruta` responden `status`. */
  inyectarFalla(falla: Falla): Promise<void> {
    return this.configurar({ agregarFallas: [falla] });
  }

  limpiarFallas(): Promise<void> {
    return this.configurar({ fallas: [] });
  }

  async peticiones(): Promise<RegistroPeticion[]> {
    const res = await fetch(this.ruta("peticiones"));
    if (!res.ok) throw new Error(`mock-api: leer peticiones fallo (${res.status})`);
    return ((await res.json()) as { peticiones: RegistroPeticion[] }).peticiones;
  }

  /** Peticiones que coinciden: `metodo` exacto y `ruta` como subcadena o regex. */
  async buscar(filtro: { metodo?: string; ruta?: string | RegExp }): Promise<RegistroPeticion[]> {
    const todas = await this.peticiones();
    return todas.filter((p) => {
      if (filtro.metodo && p.metodo !== filtro.metodo.toUpperCase()) return false;
      if (filtro.ruta === undefined) return true;
      return typeof filtro.ruta === "string" ? p.ruta.includes(filtro.ruta) : filtro.ruta.test(p.ruta);
    });
  }

  /** Peticiones que escriben (todo salvo GET): para aserciones del tipo "Cancelar no hizo DELETE". */
  async escrituras(): Promise<RegistroPeticion[]> {
    return (await this.peticiones()).filter((p) => p.metodo !== "GET" && !p.ruta.startsWith("/auth/"));
  }

  async sinFixture(): Promise<RegistroPeticion[]> {
    return (await this.peticiones()).filter((p) => p.sinFixture);
  }

  async limpiarRegistro(): Promise<void> {
    await fetch(this.ruta("peticiones"), { method: "DELETE" });
  }

  /** Simula que un evento del ciclo emitio una notificacion nueva (sin leer) para la sesion de esta prueba. */
  async emitirNotificacion(n: { titulo: string; severidad?: "info" | "atencion" | "critica"; categoria?: string; enlace?: string }): Promise<void> {
    const res = await fetch(this.ruta("notificaciones"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(n) });
    if (!res.ok) throw new Error(`mock-api: emitir notificacion fallo (${res.status})`);
  }

  /** Agrega un elemento a una lista del estado del escenario (p. ej. `rest.ordenes`): simula un evento externo, como un pedido nuevo. */
  async agregarAEstado(clave: string, agregar: unknown): Promise<void> {
    // 409 = la lista aun no existe porque la pantalla (chunk perezoso + su fetch) todavia no la carga: se reintenta hasta 10 s.
    const limite = Date.now() + 10_000;
    for (;;) {
      const res = await fetch(this.ruta("estado"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clave, agregar }) });
      if (res.ok) return;
      if (res.status !== 409 || Date.now() > limite) throw new Error(`mock-api: agregar al estado fallo (${res.status})`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async reiniciar(): Promise<void> {
    await fetch(this.ruta("reiniciar"), { method: "POST" });
  }
}
