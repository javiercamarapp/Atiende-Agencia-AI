// Verificacion SOLO LECTURA de la cuenta demo cargada (DEMO-PM): imprime un checklist con veredicto por punto y sale con codigo 1 si
// algun requisito falla. No escribe nada: abre una transaccion de solo lectura. Opcional `--api-url` consulta el estado del widget.
//
//   SEED_DATABASE_URL=postgresql://... node --experimental-strip-types scripts/seed-pm-demo/verificar-demo.ts [--org-slug=<slug>] [--api-url=https://api.ejemplo.com]
//
// Runbook: docs/demo-pm/runbook.md
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoLista, evaluarVerificacionDemo, renderDemoVerificationSql, type DemoFacts } from "../../packages/domain-restaurantes/src/seed/demo-verification.ts";
import { DEMO_ORG_SLUG_POR_OMISION, describirObjetivo, SeedTargetError } from "../../packages/domain-restaurantes/src/seed/target-safety.ts";

const USO = `Uso: node --experimental-strip-types scripts/seed-pm-demo/verificar-demo.ts [--org-slug=<slug>] [--api-url=<url de la API>]
  Solo lectura. SEED_DATABASE_URL obligatoria. Con --api-url tambien consulta GET /v1/restaurantes/demo/<slug>/estado (agente disponible o no).`;

export function parseVerificarArgs(argv: readonly string[]): { help: boolean; orgSlug: string; apiUrl: string | null } {
  let help = false;
  let orgSlug = DEMO_ORG_SLUG_POR_OMISION;
  let apiUrl: string | null = null;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg.startsWith("--org-slug=")) orgSlug = arg.slice("--org-slug=".length);
    else if (arg.startsWith("--api-url=")) apiUrl = arg.slice("--api-url=".length).replace(/\/+$/, "");
    else throw new SeedTargetError(`Argumento desconocido: ${arg}`);
  }
  if (!/^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$/.test(orgSlug)) throw new SeedTargetError("--org-slug invalido.");
  if (apiUrl !== null && !/^https?:\/\//.test(apiUrl)) throw new SeedTargetError("--api-url debe empezar con http:// o https://");
  return { help, orgSlug, apiUrl };
}

async function main(): Promise<number> {
  const args = parseVerificarArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USO);
    return 0;
  }
  const target = describirObjetivo(process.env.SEED_DATABASE_URL);
  console.log(`Base objetivo: ${target.label} (solo lectura)`);
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.SEED_DATABASE_URL });
  await client.connect();
  let facts: DemoFacts;
  try {
    await client.query("begin read only");
    const r = await client.query<{ hechos: DemoFacts }>(renderDemoVerificationSql(), [args.orgSlug]);
    await client.query("rollback");
    facts = r.rows[0]!.hechos;
  } finally {
    await client.end();
  }
  const checks = evaluarVerificacionDemo(facts);
  for (const c of checks) console.log(`${c.ok ? "OK    " : c.nivel === "requisito" ? "FALLA " : "AVISO "} ${c.id}: ${c.detalle}`);

  if (args.apiUrl) {
    const url = `${args.apiUrl}/v1/restaurantes/demo/${encodeURIComponent(args.orgSlug)}/estado`;
    try {
      const res = await fetch(url);
      const body = (await res.json()) as { disponible?: boolean; motivo?: string | null; mensaje?: string | null; sucursal_predeterminada?: string | null };
      console.log(`${body.disponible ? "OK    " : "AVISO "} widget (${url}): ${body.disponible ? `disponible, sucursal predeterminada ${body.sucursal_predeterminada ?? "(general)"}` : `NO disponible: ${body.mensaje ?? body.motivo ?? res.status}`}`);
    } catch (err) {
      console.log(`AVISO  widget (${url}): no se pudo consultar (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const lista = demoLista(checks);
  console.log(lista ? "\nDemo LISTA en la base: todos los requisitos pasan." : "\nDemo NO lista: corrija los puntos FALLA (runbook: docs/demo-pm/runbook.md).");
  return lista ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof SeedTargetError) {
        console.error(`verificar-demo: ${err.message}`);
        process.exit(2);
      }
      console.error(err);
      process.exit(1);
    },
  );
}
