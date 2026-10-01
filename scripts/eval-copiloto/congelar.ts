// COMANDO del congelador (funciones en congelado.ts). Siempre contra la base efimera ya sembrada:
//   scripts/eval-copiloto/run.sh npx vite-node scripts/eval-copiloto/congelar.ts            # reescribe datos/*.congelado.json
//   scripts/eval-copiloto/run.sh npx vite-node scripts/eval-copiloto/congelar.ts -- --check # falla si algo cambio (drift)
//   ... -- --vertical=citas                                                                  # solo una vertical
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { abrirMotor, VERTICALES_EVAL } from "./mundos.ts";
import { DIR_DATOS, congelarVertical, rutaCongelado } from "./congelado.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const check = args.includes("--check");
  const solo = args.find((a) => a.startsWith("--vertical="))?.split("=")[1];
  const url = process.env["COPILOTO_EVAL_DATABASE_URL"];
  if (!url) throw new Error("falta COPILOTO_EVAL_DATABASE_URL: corre esto con scripts/eval-copiloto/run.sh");
  const engine = abrirMotor(url);
  let drift = 0;
  let errores = 0;
  try {
    mkdirSync(DIR_DATOS, { recursive: true });
    for (const v of VERTICALES_EVAL) {
      if (solo && solo !== v) continue;
      let nuevo: string;
      try {
        nuevo = JSON.stringify(await congelarVertical(v, engine), null, 1) + "\n";
      } catch (err) {
        errores += 1;
        console.error(err instanceof Error ? err.message : String(err));
        continue;
      }
      const ruta = rutaCongelado(v);
      if (check) {
        const previo = existsSync(ruta) ? readFileSync(ruta, "utf8") : "";
        if (previo !== nuevo) {
          drift += 1;
          console.error(`DRIFT en ${v}: ${path.relative(process.cwd(), ruta)} no coincide con lo que producen los datos sembrados. Corre congelar sin --check y revisa el diff.`);
        } else console.log(`ok ${v}`);
      } else {
        writeFileSync(ruta, nuevo);
        console.log(`congelado ${v}`);
      }
    }
  } finally {
    await engine.stop();
  }
  if (drift > 0 || errores > 0) process.exit(1);
}

await main();
