// Sumidero local de correo con la forma de la API de Resend (POST /emails), banco de
// pruebas del e2e (R-35). El repo manda correo por Resend (fetch, sin SMTP), asi que el
// equivalente local de Mailpit es un receptor HTTP con la misma superficie: guarda cada
// correo para que la prueba lo lea, respeta `Idempotency-Key` (un reintento no duplica) y
// permite forzar fallos. No envia nada a ninguna parte.
import { serveFetchHandler } from "./http-serve.ts";
import type { RunningServer } from "./http-serve.ts";

export interface SinkEmail {
  readonly id: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly html: string;
  readonly text: string | null;
  readonly idempotencyKey: string | null;
}

export class ResendSink {
  readonly emails: SinkEmail[] = [];
  readonly rejectedCount = { value: 0 };
  private readonly byKey = new Map<string, SinkEmail>();
  private readonly failures: number[] = [];
  private server: RunningServer | null = null;

  constructor(private readonly apiKey: string) {}

  get baseUrl(): string {
    if (!this.server) throw new Error("ResendSink: llama start() antes de usar baseUrl");
    return this.server.baseUrl;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = await serveFetchHandler((request) => this.handle(request));
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await s.close();
  }

  /** El proximo envio responde con este status (p. ej. 500 para ejercitar el reintento). */
  failNext(status: number): void {
    this.failures.push(status);
  }

  emailsTo(address: string): SinkEmail[] {
    const wanted = address.toLowerCase();
    return this.emails.filter((e) => e.to.some((t) => t.toLowerCase() === wanted));
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/emails") return new Response("not found", { status: 404 });
    if (request.headers.get("authorization") !== `Bearer ${this.apiKey}`) {
      this.rejectedCount.value += 1;
      return new Response(JSON.stringify({ name: "validation_error", message: "API key is invalid", statusCode: 401 }), { status: 401 });
    }
    const forced = this.failures.shift();
    if (forced) {
      this.rejectedCount.value += 1;
      return new Response(JSON.stringify({ name: "application_error", message: "fallo forzado", statusCode: forced }), { status: forced });
    }
    const key = request.headers.get("idempotency-key");
    if (key && this.byKey.has(key)) return new Response(JSON.stringify({ id: this.byKey.get(key)!.id }), { status: 200 });
    const body = (await request.json()) as { from?: string; to?: string | string[]; subject?: string; html?: string; text?: string };
    if (!body.from || !body.to || !body.subject || !body.html) {
      this.rejectedCount.value += 1;
      return new Response(JSON.stringify({ name: "validation_error", message: "from, to, subject y html son obligatorios", statusCode: 422 }), { status: 422 });
    }
    const email: SinkEmail = {
      id: `sim-email-${this.emails.length + 1}`,
      from: body.from,
      to: Array.isArray(body.to) ? body.to : [body.to],
      subject: body.subject,
      html: body.html,
      text: body.text ?? null,
      idempotencyKey: key,
    };
    this.emails.push(email);
    if (key) this.byKey.set(key, email);
    return new Response(JSON.stringify({ id: email.id }), { status: 200 });
  }
}

/**
 * `fetch` que redirige a los simuladores locales las dos URLs de produccion que el
 * codigo tiene fijas (api.resend.com y graph.facebook.com). Cualquier otro host se
 * rechaza: un test del banco e2e nunca debe salir a internet.
 */
export function createSimulatorFetch(targets: { readonly resendBaseUrl?: string; readonly graphBaseUrl?: string }): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const url = new URL(raw);
    if (url.hostname === "api.resend.com" && targets.resendBaseUrl) return fetch(`${targets.resendBaseUrl}${url.pathname}${url.search}`, init);
    if (url.hostname === "graph.facebook.com" && targets.graphBaseUrl) return fetch(`${targets.graphBaseUrl}${url.pathname}${url.search}`, init);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return fetch(input, init);
    throw new Error(`createSimulatorFetch: salida bloqueada hacia ${url.hostname} (el banco e2e no sale a internet)`);
  }) as typeof fetch;
}
