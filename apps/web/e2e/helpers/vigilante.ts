// Vigila consola y red de una pagina: errores de JS, console.error y respuestas 5xx fallan la prueba; los 4xx
// "sin fixture" del mock se anotan como pendientes de cobertura (no son un fallo del producto).
import type { Page, Response } from "@playwright/test";

export interface Hallazgo {
  readonly tipo: "pageerror" | "console.error" | "http-5xx";
  readonly detalle: string;
}

/** Mensajes de consola que el navegador emite por si solo ante un 4xx/5xx: el estado HTTP ya se vigila aparte. */
const RUIDO_DE_RED = /^Failed to load resource: the server responded with a status of \d{3}/;

export class VigilanteConsola {
  readonly hallazgos: Hallazgo[] = [];
  readonly sinFixture: string[] = [];
  readonly respuestas4xx: Array<{ status: number; url: string }> = [];
  /** Patrones de URL cuyo 5xx es esperado (p. ej. una falla inyectada a proposito). */
  private readonly permitir5xx: RegExp[] = [];

  constructor(private readonly page: Page, private readonly origenApi: string) {
    page.on("pageerror", (err) => this.hallazgos.push({ tipo: "pageerror", detalle: err.message }));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const texto = msg.text();
      if (RUIDO_DE_RED.test(texto)) return;
      this.hallazgos.push({ tipo: "console.error", detalle: `${texto} (${msg.location().url})` });
    });
    page.on("response", (res) => void this.alResponder(res));
  }

  /** Declara que un 5xx contra estas URLs es esperado (prueba de manejo de errores con falla inyectada). */
  permitirRespuesta5xx(patron: RegExp): void {
    this.permitir5xx.push(patron);
  }

  private async alResponder(res: Response): Promise<void> {
    const status = res.status();
    if (status < 400) return;
    const url = res.url();
    if (status >= 500) {
      if (!this.permitir5xx.some((p) => p.test(url))) this.hallazgos.push({ tipo: "http-5xx", detalle: `${status} ${res.request().method()} ${url}` });
      return;
    }
    this.respuestas4xx.push({ status, url });
    if (url.startsWith(this.origenApi) && status === 404) {
      const cuerpo = await res.json().catch(() => null);
      if ((cuerpo as { code?: string } | null)?.code === "mock_sin_fixture") this.sinFixture.push(`${res.request().method()} ${new URL(url).pathname}`);
    }
  }

  /** Texto legible de los hallazgos (vacio si no hay). Usar con `expect(vigilante.resumen()).toBe("")`. */
  resumen(): string {
    return this.hallazgos.map((h) => `[${h.tipo}] ${h.detalle}`).join("\n");
  }
}
