// Servidor HTTP real (node:http) para un handler con forma `fetch(Request) => Response`
// (una app de Hono, o el handler de un simulador). Solo para pruebas y bancos locales:
// abre un puerto efimero en 127.0.0.1, nunca en una interfaz publica. Evita agregar
// una dependencia (@hono/node-server) solo para el banco e2e.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface RunningServer {
  readonly baseUrl: string;
  readonly port: number;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function respond(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

export async function serveFetchHandler(handler: FetchHandler): Promise<RunningServer> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const body = await readBody(req);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (Array.isArray(v)) for (const item of v) headers.append(k, item);
          else if (typeof v === "string") headers.set(k, v);
        }
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        const request = new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`, {
          method: req.method,
          headers,
          ...(hasBody ? { body: new Uint8Array(body) } : {}),
        });
        await respond(res, await handler(request));
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(err instanceof Error ? err.message : "error interno del servidor de prueba");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
