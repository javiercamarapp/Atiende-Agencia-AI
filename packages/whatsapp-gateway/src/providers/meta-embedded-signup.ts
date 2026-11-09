// WhatsApp Embedded Signup (Meta): el restaurante conecta SU numero desde el panel. El navegador corre el flujo de Meta (SDK de
// Facebook, `config_id`) y devuelve un `code` de un solo uso + `waba_id` + `phone_number_id`; este cliente hace, del lado del
// servidor, los pasos documentados por Meta para un Tech Provider:
//   1) canjear el `code` por el token de integracion del negocio (`/oauth/access_token`, con el App Secret);
//   2) comprobar que el `phone_number_id` pertenece a ese WABA (`/{waba}/phone_numbers`);
//   3) dar acceso al usuario de sistema de la PLATAFORMA sobre el WABA (`/{waba}/assigned_users`, tarea MANAGE): asi la plataforma
//      envia con su token de siempre (`WHATSAPP_ACCESS_TOKEN`) y NO guarda tokens de clientes;
//   4) suscribir la app a los webhooks del WABA (`/{waba}/subscribed_apps`);
//   5) registrar el numero en la Cloud API con un PIN de verificacion en dos pasos (`/{phone}/register`).
// El token del negocio vive SOLO en memoria durante esta llamada: nunca se devuelve, se guarda ni se registra. Todo mensaje de error
// pasa por `redactarSecretos` (token exacto, `Bearer`, `access_token=`, `client_secret=`, cadenas `EA...`).
import { redactarSecretos } from "./meta-graph-reader.ts";

export type PasoEmbeddedSignup = "canje" | "numeros" | "asignar_usuario" | "suscribir" | "registrar";

export class EmbeddedSignupError extends Error {
  readonly paso: PasoEmbeddedSignup;
  readonly httpStatus: number | undefined;
  readonly graphCode: number | undefined;
  constructor(paso: PasoEmbeddedSignup, message: string, info: { readonly httpStatus?: number; readonly graphCode?: number } = {}) {
    super(message);
    this.name = "EmbeddedSignupError";
    this.paso = paso;
    this.httpStatus = info.httpStatus;
    this.graphCode = info.graphCode;
  }
}

export interface MetaEmbeddedSignupClientOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly apiVersion?: string;
  readonly fetchImpl?: typeof fetch;
  /** Solo pruebas. Default `https://graph.facebook.com`. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export interface NumeroWaba {
  readonly id: string;
  readonly displayPhoneNumber: string | null;
  readonly verifiedName: string | null;
}

export interface ConexionEmbeddedSignup {
  readonly phoneNumberId: string;
  readonly wabaId: string;
  readonly displayPhoneNumber: string | null;
  readonly verifiedName: string | null;
}

const ID_RE = /^\d{5,32}$/;

export class MetaEmbeddedSignupClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: MetaEmbeddedSignupClientOptions) {
    if (!opts.appId || !opts.appSecret) throw new Error("MetaEmbeddedSignupClient: falta appId o appSecret.");
    this.base = `${opts.baseUrl ?? "https://graph.facebook.com"}/${opts.apiVersion ?? "v21.0"}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async pedir<T>(paso: PasoEmbeddedSignup, url: string, init: RequestInit, token?: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000) });
    } catch (err) {
      throw new EmbeddedSignupError(paso, redactarSecretos(`error de red con Meta: ${err instanceof Error ? err.message : String(err)}`, token));
    }
    const texto = await res.text().catch(() => "");
    let cuerpo: unknown = null;
    try {
      cuerpo = texto ? JSON.parse(texto) : null;
    } catch {
      cuerpo = null;
    }
    if (!res.ok) {
      const e = (cuerpo as { error?: { message?: string; code?: number } } | null)?.error;
      const mensaje = redactarSecretos(e?.message ?? `HTTP ${res.status}`, token).slice(0, 300);
      throw new EmbeddedSignupError(paso, mensaje, { httpStatus: res.status, ...(typeof e?.code === "number" ? { graphCode: e.code } : {}) });
    }
    return cuerpo as T;
  }

  /** Paso 1: `code` (un solo uso, minutos de vida) -> token de integracion del negocio. */
  async canjearCodigo(code: string): Promise<string> {
    const url = new URL(`${this.base}/oauth/access_token`);
    url.searchParams.set("client_id", this.opts.appId);
    url.searchParams.set("client_secret", this.opts.appSecret);
    url.searchParams.set("code", code);
    const r = await this.pedir<{ access_token?: unknown }>("canje", url.toString(), { method: "GET" }, this.opts.appSecret);
    if (typeof r?.access_token !== "string" || r.access_token.length < 10) throw new EmbeddedSignupError("canje", "Meta no devolvio un token de integracion.");
    return r.access_token;
  }

  async numerosDelWaba(tokenNegocio: string, wabaId: string): Promise<NumeroWaba[]> {
    const url = `${this.base}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`;
    const r = await this.pedir<{ data?: Array<{ id?: unknown; display_phone_number?: unknown; verified_name?: unknown }> }>("numeros", url, { method: "GET", headers: { Authorization: `Bearer ${tokenNegocio}` } }, tokenNegocio);
    return (r?.data ?? [])
      .filter((n) => typeof n.id === "string")
      .map((n) => ({ id: n.id as string, displayPhoneNumber: typeof n.display_phone_number === "string" ? n.display_phone_number : null, verifiedName: typeof n.verified_name === "string" ? n.verified_name : null }));
  }

  async asignarUsuarioDeSistema(tokenNegocio: string, wabaId: string, systemUserId: string): Promise<void> {
    const url = new URL(`${this.base}/${wabaId}/assigned_users`);
    url.searchParams.set("user", systemUserId);
    url.searchParams.set("tasks", JSON.stringify(["MANAGE"]));
    await this.pedir("asignar_usuario", url.toString(), { method: "POST", headers: { Authorization: `Bearer ${tokenNegocio}` } }, tokenNegocio);
  }

  async suscribirApp(tokenNegocio: string, wabaId: string): Promise<void> {
    await this.pedir("suscribir", `${this.base}/${wabaId}/subscribed_apps`, { method: "POST", headers: { Authorization: `Bearer ${tokenNegocio}` } }, tokenNegocio);
  }

  async registrarNumero(tokenNegocio: string, phoneNumberId: string, pin: string): Promise<void> {
    await this.pedir(
      "registrar",
      `${this.base}/${phoneNumberId}/register`,
      { method: "POST", headers: { Authorization: `Bearer ${tokenNegocio}`, "Content-Type": "application/json" }, body: JSON.stringify({ messaging_product: "whatsapp", pin }) },
      tokenNegocio,
    );
  }

  /** Corre los 5 pasos en orden. Lanza EmbeddedSignupError con el paso que fallo (mensaje ya redactado). */
  async conectar(input: { readonly code: string; readonly wabaId: string; readonly phoneNumberId: string; readonly systemUserId: string; readonly pin: string }): Promise<ConexionEmbeddedSignup> {
    if (!ID_RE.test(input.wabaId) || !ID_RE.test(input.phoneNumberId)) throw new EmbeddedSignupError("numeros", "waba_id o phone_number_id con formato invalido.");
    const token = await this.canjearCodigo(input.code);
    const numero = (await this.numerosDelWaba(token, input.wabaId)).find((n) => n.id === input.phoneNumberId);
    if (!numero) throw new EmbeddedSignupError("numeros", "El numero elegido no pertenece a la cuenta de WhatsApp Business autorizada.");
    await this.asignarUsuarioDeSistema(token, input.wabaId, input.systemUserId);
    await this.suscribirApp(token, input.wabaId);
    await this.registrarNumero(token, input.phoneNumberId, input.pin);
    return { phoneNumberId: input.phoneNumberId, wabaId: input.wabaId, displayPhoneNumber: numero.displayPhoneNumber, verifiedName: numero.verifiedName };
  }
}
