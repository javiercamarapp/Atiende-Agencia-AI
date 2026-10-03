// UN comando para armar la cuenta demo «Los Taquitos de PM» (DEMO-PM): seed del negocio (menu, sucursales, agente taqueria_pm, voz)
// marcado como demo + volumen con el ritmo REAL de T7 + limpieza de ensayos del widget + verificacion de solo lectura.
//
//   node scripts/seed-pm-demo/demo-pm.mjs                      DRY-RUN (por omision): valida y muestra el plan; no abre ninguna conexion
//   SEED_DATABASE_URL=postgresql://... node scripts/seed-pm-demo/demo-pm.mjs --apply [--confirm-host=<host>] [--owner-email=<correo>]
//   SEED_DATABASE_URL=postgresql://... node scripts/seed-pm-demo/demo-pm.mjs --verificar [--api-url=https://api...]   (solo lectura)
//
// Es IDEMPOTENTE y RE-EJECUTABLE: el seed del negocio hace upsert y no pisa lo que el dueño edite; el volumen se borra (solo el rango
// ficticio 0001) y se vuelve a generar con la fecha de hoy, asi que repetirlo otro dia no duplica ni desfasa nada. Cada paso aplica
// sus propias salvaguardas (SEED_DATABASE_URL, --apply, --confirm-host si la base no es local): si uno falla, los siguientes NO corren
// y repetir el comando es seguro. NUNCA lo corra contra la base real sin el OK del dueño del proyecto. Runbook: docs/demo-pm/runbook.md
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const STRIP = "--experimental-strip-types";

export const USO = `Uso: node scripts/seed-pm-demo/demo-pm.mjs [--apply] [--confirm-host=<host>] [--owner-email=<correo>] [--dias=N] [--conservar-sesiones]
       node scripts/seed-pm-demo/demo-pm.mjs --verificar [--api-url=<url de la API>]
  (sin --apply: dry-run, no abre ninguna conexion; SEED_DATABASE_URL obligatoria con --apply y con --verificar)
  --confirm-host      obligatorio si la base NO es local: el host exacto de SEED_DATABASE_URL
  --owner-email       enlaza como owner a un usuario de staff que YA existe (el seed no crea usuarios)
  --dias=N            ventana del volumen (56 por omision = las 8 semanas de la muestra real; escala los pedidos)
  --conservar-sesiones  no borra las conversaciones de ensayo del widget (0009) antes de verificar
  --verificar         solo lectura: checklist de la demo ya cargada (con --api-url tambien consulta el widget)`;

export class DemoPmArgsError extends Error {}

export function parseDemoPmArgs(argv) {
  const a = { apply: false, confirmHost: null, ownerEmail: null, dias: null, conservarSesiones: false, verificar: false, apiUrl: null, help: false };
  for (const arg of argv) {
    if (arg === "--apply") a.apply = true;
    else if (arg === "--help" || arg === "-h") a.help = true;
    else if (arg === "--verificar") a.verificar = true;
    else if (arg === "--conservar-sesiones") a.conservarSesiones = true;
    else if (arg.startsWith("--confirm-host=")) a.confirmHost = arg.slice("--confirm-host=".length);
    else if (arg.startsWith("--owner-email=")) a.ownerEmail = arg.slice("--owner-email=".length);
    else if (arg.startsWith("--api-url=")) a.apiUrl = arg.slice("--api-url=".length);
    else if (arg.startsWith("--dias=")) {
      const v = arg.slice("--dias=".length);
      if (!/^\d{1,3}$/.test(v) || Number(v) < 1) throw new DemoPmArgsError("--dias debe ser un entero de 1 a 365.");
      a.dias = Number(v);
    } else throw new DemoPmArgsError(`Argumento desconocido: ${arg}`);
  }
  if (a.verificar && (a.apply || a.ownerEmail || a.dias !== null)) throw new DemoPmArgsError("--verificar es de solo lectura: no se combina con --apply, --owner-email ni --dias.");
  if (!a.verificar && a.apiUrl) throw new DemoPmArgsError("--api-url solo aplica con --verificar.");
  return a;
}

/** Plan puro: la lista ordenada de pasos y los argumentos de cada uno. `conexion` = el paso abre la base (no corre en dry-run). */
export function planDemoPm(a) {
  const confirm = a.confirmHost ? [`--confirm-host=${a.confirmHost}`] : [];
  const apply = a.apply ? ["--apply", ...confirm] : [];
  const verificar = {
    id: "verificar",
    titulo: "Verificar la demo cargada (solo lectura)",
    argv: [STRIP, path.join("scripts", "seed-pm-demo", "verificar-demo.ts"), ...(a.apiUrl ? [`--api-url=${a.apiUrl}`] : [])],
    conexion: true,
  };
  if (a.verificar) return [verificar];
  const dias = a.dias !== null ? [`--dias=${a.dias}`] : [];
  return [
    {
      id: "seed",
      titulo: "Sembrar Los Taquitos de PM (menu, 7 sucursales con T7 activa, agente taqueria_pm, voz) marcado como demo",
      argv: [STRIP, path.join("scripts", "seed-pm-demo", "seed-pm-demo.ts"), "--demo", ...apply, ...(a.apply && a.ownerEmail ? [`--owner-email=${a.ownerEmail}`] : [])],
      conexion: false,
    },
    {
      id: "limpiar-volumen",
      titulo: "Borrar el volumen anterior (solo telefonos ficticios 0001) para regenerarlo con la fecha de hoy",
      argv: [STRIP, path.join("scripts", "seed-pm-demo", "limpiar-demo.ts"), "--modo=volumen", "--apply", ...confirm],
      conexion: true,
    },
    {
      id: "volumen",
      titulo: "Cargar el volumen con el ritmo real de T7 (perfil t7: 139 pedidos en 56 dias, 73 % recurrentes)",
      argv: [path.join("scripts", "seed-pm-demo", "ejecutar.mjs"), "seed-volumen", "--perfil=t7", ...dias, ...apply],
      conexion: false,
    },
    ...(a.conservarSesiones
      ? []
      : [
          {
            id: "limpiar-sesiones",
            titulo: "Borrar las conversaciones de ensayo del widget (telefonos ficticios 0009)",
            argv: [STRIP, path.join("scripts", "seed-pm-demo", "limpiar-demo.ts"), "--modo=sesiones_widget", "--apply", ...confirm],
            conexion: true,
          },
        ]),
    verificar,
  ];
}

function correr(paso) {
  const r = spawnSync(process.execPath, paso.argv, { cwd: REPO_ROOT, stdio: "inherit", env: process.env });
  return r.status ?? 1;
}

export function main(argv) {
  let a;
  try {
    a = parseDemoPmArgs(argv);
  } catch (err) {
    if (err instanceof DemoPmArgsError) {
      console.error(`demo-pm: ${err.message}\n${USO}`);
      return 2;
    }
    throw err;
  }
  if (a.help) {
    console.log(USO);
    return 0;
  }
  const pasos = planDemoPm(a);
  const dry = !a.apply && !a.verificar;
  console.log(a.verificar ? "== demo-pm: VERIFICACION de solo lectura ==" : dry ? "== demo-pm: DRY-RUN (no se escribe ni se conecta a ninguna base) ==" : "== demo-pm: CARGA REAL (--apply) ==");
  for (let i = 0; i < pasos.length; i += 1) {
    const paso = pasos[i];
    console.log(`\n[${i + 1}/${pasos.length}] ${paso.titulo}`);
    if (dry && paso.conexion) {
      console.log("   (se ejecutaria con --apply; abre la base, por eso no corre en dry-run)");
      continue;
    }
    const code = correr(paso);
    if (code !== 0) {
      console.error(`\ndemo-pm: el paso «${paso.id}» termino con codigo ${code}. Los pasos siguientes NO se ejecutaron. Corrija y repita el comando completo: es idempotente.`);
      return code;
    }
  }
  if (dry) console.log("\nDRY-RUN completo. Para cargar de verdad: SEED_DATABASE_URL=... node scripts/seed-pm-demo/demo-pm.mjs --apply [--confirm-host=<host>] (ver docs/demo-pm/runbook.md).");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
