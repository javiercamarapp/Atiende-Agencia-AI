// Trinquete i18n ES/EN. En las carpetas/archivos YA migrados (`alcance` de config.json), ningun archivo puede tener mas textos
// visibles en espanol escritos a mano que su baseline (por omision 0). El alcance crece PR a PR (shell -> comunes ->
// restaurantes -> superadmin -> ...) en vez de exigir todo el repo de golpe. Si un archivo baja, se pide bajar su baseline
// (el piso solo desciende). Detector: scripts/i18n-guard/detector.ts.
//
// Uso:   node --experimental-strip-types scripts/i18n-guard/guard.ts               -> comprueba (CI)
//        node --experimental-strip-types scripts/i18n-guard/guard.ts --actualizar  -> baja los baselines que ya bajaron
//        (nunca los sube ni agrega archivos: eso se decide a mano en config.json, a la vista en el PR)
// Para migrar un archivo: cambia sus textos por `t("clave")` (catalogo en packages/ui/src/i18n/mensajes) y agrega su ruta a `alcance`.
// Sin red, sin secretos; solo escribe config.json con --actualizar.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detectar, type Hallazgo } from "./detector.ts";

export interface ConfigGuard {
  /** Rutas (archivo o carpeta, relativas a la raiz) ya migradas. */
  readonly alcance: readonly string[];
  /** Rutas que nunca se revisan aunque esten dentro del alcance (catalogo, pruebas). */
  readonly excluir: readonly string[];
  /** Hallazgos tolerados por archivo mientras termina su migracion; todo lo que no aparece aqui vale 0. */
  readonly baseline: Readonly<Record<string, number>>;
}

export interface ResultadoArchivo {
  readonly ruta: string;
  readonly hallazgos: readonly Hallazgo[];
  readonly permitido: number;
}

const EXTENSIONES = /\.(ts|tsx)$/;
const NO_FUENTE = /(\.d\.ts|\.spec\.tsx?|\.test\.tsx?)$/;

function listar(raiz: string, ruta: string): string[] {
  const abs = join(raiz, ruta);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return EXTENSIONES.test(ruta) && !NO_FUENTE.test(ruta) ? [ruta] : [];
  return readdirSync(abs).flatMap((n) => (n === "node_modules" ? [] : listar(raiz, `${ruta.replace(/\/$/, "")}/${n}`)));
}

export function revisar(raiz: string, config: ConfigGuard): ResultadoArchivo[] {
  const excluido = (r: string) => config.excluir.some((e) => r === e || r.startsWith(e.endsWith("/") ? e : `${e}/`));
  const archivos = [...new Set(config.alcance.flatMap((a) => listar(raiz, a)))].filter((r) => !excluido(r)).sort();
  return archivos.map((ruta) => ({ ruta, hallazgos: detectar(readFileSync(join(raiz, ruta), "utf8"), ruta), permitido: config.baseline[ruta] ?? 0 }));
}

export interface Veredicto {
  readonly ok: boolean;
  readonly suben: readonly ResultadoArchivo[];
  readonly bajan: readonly ResultadoArchivo[];
  readonly total: number;
}

export function evaluar(resultados: readonly ResultadoArchivo[]): Veredicto {
  const suben = resultados.filter((r) => r.hallazgos.length > r.permitido);
  const bajan = resultados.filter((r) => r.hallazgos.length < r.permitido);
  return { ok: suben.length === 0 && bajan.length === 0, suben, bajan, total: resultados.reduce((a, r) => a + r.hallazgos.length, 0) };
}

function main(): void {
  const raiz = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
  const rutaConfig = join(raiz, "scripts/i18n-guard/config.json");
  const config = JSON.parse(readFileSync(rutaConfig, "utf8")) as ConfigGuard;
  const resultados = revisar(raiz, config);
  const v = evaluar(resultados);

  if (process.argv.includes("--actualizar")) {
    const baseline: Record<string, number> = { ...config.baseline };
    for (const r of v.bajan) {
      if (r.hallazgos.length === 0) delete baseline[r.ruta];
      else baseline[r.ruta] = r.hallazgos.length;
    }
    writeFileSync(rutaConfig, `${JSON.stringify({ ...config, baseline }, null, 2)}\n`);
    console.log(`i18n-guard: baseline actualizado (${v.bajan.length} archivo(s) bajaron).`);
    return;
  }

  console.log(`i18n-guard: ${resultados.length} archivo(s) migrados revisados, ${v.total} texto(s) visibles en espanol detectados (tope por archivo en config.json).`);
  for (const r of v.suben) {
    console.error(`\n✗ ${r.ruta}: ${r.hallazgos.length} texto(s) visibles escritos a mano (permitidos: ${r.permitido}). Usa t("clave") de @atiende/ui:`);
    for (const h of r.hallazgos) console.error(`    ${r.ruta}:${h.linea}  «${h.texto}»`);
  }
  for (const r of v.bajan) {
    console.error(`\n↓ ${r.ruta}: bajo a ${r.hallazgos.length} (baseline ${r.permitido}). Corre: node --experimental-strip-types scripts/i18n-guard/guard.ts --actualizar`);
  }
  if (!v.ok) process.exit(1);
  console.log("i18n-guard: OK");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

