// SIMULADOR — desarrollo/pruebas: un servidor HTTP real (`node:http`, 127.0.0.1,
// puerto aleatorio) que implementa lo suficiente del protocolo CalDAV real
// (RFC 4791 PUT/GET/DELETE de recursos `.ics`, REPORT `calendar-query` con
// `time-range` RFC 4791 §7.8.9, REPORT `sync-collection` RFC 6578, autenticación
// HTTP Basic RFC 7617, ETags y `If-Match`/`If-None-Match` RFC 7232) para probar
// el adaptador REAL (RealCalDavPort) contra requests HTTP/XML reales — nunca
// representa una conexión productiva contra iCloud/Fastmail/Nextcloud. Port de
// citas-reservaciones/supabase/functions/_shared/caldav-sim.ts (Deno.serve) sobre
// `node:http` + la Fetch API global de Node.
//
// Alcance deliberadamente acotado a lo que RealCalDavPort de verdad usa: NO
// implementa PROPFIND/discovery, ni MKCALENDAR, ni recurrencia/VALARM.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { parseVEventIcs } from "../src/caldav-ics.ts";

export interface CalDavSimOptions {
  username: string;
  password: string;
  /** Path de la colección de calendario, con `/` inicial y final. */
  calendarPath: string;
}

interface StoredResource {
  uid: string;
  icsBody: string;
  etag: string;
  seq: number;
  deleted: boolean;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function xmlResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/xml; charset=utf-8" } });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function toWebRequest(req: IncomingMessage, bodyText: string): Request {
  const url = `http://127.0.0.1${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  const method = req.method ?? "GET";
  return new Request(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : bodyText });
}

function icsUtcToEpoch(value: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) return NaN;
  const [, yyyy, mm, dd, hh, mi, ss] = m;
  return Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
}

export class CalDavServerSimulator {
  #options: CalDavSimOptions;
  #resources = new Map<string, StoredResource>();
  #seq = 0;
  #server: Server | null = null;
  #requestsReceived: { method: string; path: string }[] = [];
  #forceSyncTokenInvalidOnce = false;

  constructor(options: CalDavSimOptions) {
    this.#options = options;
  }

  get requestsReceived(): readonly { method: string; path: string }[] {
    return this.#requestsReceived;
  }

  /** Estado interno expuesto solo para aserciones de prueba. */
  get resources(): ReadonlyMap<string, StoredResource> {
    return this.#resources;
  }

  async start(): Promise<{ baseUrl: string; calendarCollectionUrl: string }> {
    const server = createServer((req, res) => {
      void (async () => {
        const bodyText = await readBody(req);
        const webRequest = toWebRequest(req, bodyText);
        const webResponse = await this.#handle(webRequest);
        res.statusCode = webResponse.status;
        webResponse.headers.forEach((value, key) => res.setHeader(key, value));
        const responseBody = await webResponse.arrayBuffer();
        res.end(Buffer.from(responseBody));
      })();
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    return { baseUrl, calendarCollectionUrl: `${baseUrl}${this.#options.calendarPath}` };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server?.close((err) => (err ? reject(err) : resolve()));
    });
  }

  #checkAuth(req: Request): Response | null {
    const auth = req.headers.get("authorization");
    const expected = `Basic ${Buffer.from(`${this.#options.username}:${this.#options.password}`, "utf8").toString("base64")}`;
    if (auth !== expected) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="simulador-caldav"' } });
    return null;
  }

  #uidFromPath(pathname: string): string | null {
    const prefix = this.#options.calendarPath;
    if (!pathname.startsWith(prefix) || !pathname.endsWith(".ics")) return null;
    const encoded = pathname.slice(prefix.length, -".ics".length);
    return decodeURIComponent(encoded);
  }

  async #handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.#requestsReceived.push({ method: req.method, path: url.pathname });

    const authError = this.#checkAuth(req);
    if (authError) return authError;

    if (req.method === "PUT") return await this.#handlePut(req, url);
    if (req.method === "GET") return this.#handleGet(url);
    if (req.method === "DELETE") return this.#handleDelete(req, url);
    if (req.method === "REPORT") return await this.#handleReport(req, url);

    return new Response("Método no simulado", { status: 501 });
  }

  async #handlePut(req: Request, url: URL): Promise<Response> {
    const uid = this.#uidFromPath(url.pathname);
    if (!uid) return new Response("ruta no simulada", { status: 404 });

    const existing = this.#resources.get(uid);
    const ifNoneMatch = req.headers.get("if-none-match");
    const ifMatch = req.headers.get("if-match");

    if (ifNoneMatch === "*" && existing && !existing.deleted) return new Response("Ya existe (If-None-Match: *)", { status: 412 });
    if (ifMatch && (!existing || existing.deleted || existing.etag !== ifMatch)) return new Response("ETag no coincide (If-Match)", { status: 412 });

    const icsBody = await req.text();
    this.#seq += 1;
    const etag = `"sim-etag-${this.#seq}"`;
    const wasNew = !existing || existing.deleted;
    this.#resources.set(uid, { uid, icsBody, etag, seq: this.#seq, deleted: false });
    return new Response(null, { status: wasNew ? 201 : 204, headers: { ETag: etag } });
  }

  #handleGet(url: URL): Response {
    const uid = this.#uidFromPath(url.pathname);
    if (!uid) return new Response("ruta no simulada", { status: 404 });
    const resource = this.#resources.get(uid);
    if (!resource || resource.deleted) return new Response("No encontrado", { status: 404 });
    return new Response(resource.icsBody, { status: 200, headers: { "Content-Type": "text/calendar; charset=utf-8", ETag: resource.etag } });
  }

  #handleDelete(req: Request, url: URL): Response {
    const uid = this.#uidFromPath(url.pathname);
    if (!uid) return new Response("ruta no simulada", { status: 404 });
    const resource = this.#resources.get(uid);
    if (!resource || resource.deleted) return new Response("No encontrado", { status: 404 });
    const ifMatch = req.headers.get("if-match");
    if (ifMatch && resource.etag !== ifMatch) return new Response("ETag no coincide (If-Match)", { status: 412 });
    this.#seq += 1;
    resource.deleted = true;
    resource.seq = this.#seq;
    return new Response(null, { status: 204 });
  }

  async #handleReport(req: Request, url: URL): Promise<Response> {
    if (url.pathname !== this.#options.calendarPath) return new Response("REPORT solo simulado sobre la colección", { status: 404 });
    const body = await req.text();
    if (body.includes("sync-collection")) return this.#reportSyncCollection(body);
    if (body.includes("calendar-query")) return this.#reportCalendarQuery(body);
    return new Response("REPORT no reconocido", { status: 400 });
  }

  #reportCalendarQuery(requestBody: string): Response {
    const startMatch = /time-range[^>]*start="([^"]+)"/.exec(requestBody);
    const endMatch = /time-range[^>]*end="([^"]+)"/.exec(requestBody);
    const rangeStart = startMatch ? icsUtcToEpoch(startMatch[1]!) : -Infinity;
    const rangeEnd = endMatch ? icsUtcToEpoch(endMatch[1]!) : Infinity;

    const matches = [...this.#resources.values()].filter((r) => {
      if (r.deleted) return false;
      const parsed = parseVEventIcs(r.icsBody);
      const evStart = new Date(parsed.dtstartUtc).getTime();
      const evEnd = new Date(parsed.dtendUtc).getTime();
      return evStart < rangeEnd && rangeStart < evEnd; // solape semiabierto real
    });

    const responses = matches
      .map(
        (r) => `
  <D:response>
    <D:href>${xmlEscape(this.#options.calendarPath + encodeURIComponent(r.uid) + ".ics")}</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>${xmlEscape(r.etag)}</D:getetag>
        <C:calendar-data>${xmlEscape(r.icsBody)}</C:calendar-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`,
      )
      .join("");

    const xml = `<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses}
</D:multistatus>`;
    return xmlResponse(207, xml);
  }

  #reportSyncCollection(requestBody: string): Response {
    if (this.#forceSyncTokenInvalidOnce) {
      this.#forceSyncTokenInvalidOnce = false;
      return xmlResponse(507, "sync-token vencido (simulado)");
    }
    const tokenMatch = /<[\w-]*:?sync-token[^>]*>([\s\S]*?)<\/[\w-]*:?sync-token>/.exec(requestBody);
    const sinceSeq = tokenMatch && tokenMatch[1]!.trim() ? Number(tokenMatch[1]!.trim()) : 0;
    if (tokenMatch && tokenMatch[1]!.trim() && (!Number.isFinite(sinceSeq) || sinceSeq < 0)) return xmlResponse(400, "sync-token inválido");

    const changed = [...this.#resources.values()].filter((r) => r.seq > sinceSeq);
    const responses = changed
      .map((r) => {
        const href = xmlEscape(this.#options.calendarPath + encodeURIComponent(r.uid) + ".ics");
        if (r.deleted) {
          return `
  <D:response>
    <D:href>${href}</D:href>
    <D:status>HTTP/1.1 404 Not Found</D:status>
  </D:response>`;
        }
        return `
  <D:response>
    <D:href>${href}</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>${xmlEscape(r.etag)}</D:getetag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
      })
      .join("");

    const xml = `<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:">${responses}
  <D:sync-token>${this.#seq}</D:sync-token>
</D:multistatus>`;
    return xmlResponse(207, xml);
  }

  /** Fuerza que la próxima llamada a sync-collection responda 507 (token
   * vencido/inválido), para probar el camino de resincronización completa
   * (RFC 6578 §3.2) sin esperar a que un servidor real purgue su historial. */
  invalidateNextSyncToken(): void {
    this.#forceSyncTokenInvalidOnce = true;
  }
}
