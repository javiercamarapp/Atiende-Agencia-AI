// Junta lo que midio `AXE_MEDIR=1 npm run e2e:ds3 -- axe` (un JSON por pantalla y proyecto en test-results-ds3/axe-medicion/) en
// e2e-ds3/axe-baseline.json, ordenado por ruta y regla, y lo valida con el mismo lector que usa el spec. Sin dependencias:
//   node --experimental-strip-types e2e-ds3/axe-unir-baseline.ts        (desde apps/web)
// Solo para LLENAR o REMEDIR la baseline completa; para bajar una entrada basta editar el JSON a mano.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { leerBaseline, ordenarEntradas, type EntradaAxe } from "./axe-trinquete.ts";

const carpeta = new URL("../test-results-ds3/axe-medicion/", import.meta.url);
const destino = new URL("./axe-baseline.json", import.meta.url);

const archivos = readdirSync(carpeta).filter((f) => f.endsWith(".json"));
if (archivos.length === 0) throw new Error("no hay mediciones en test-results-ds3/axe-medicion/: corre antes AXE_MEDIR=1 npm run e2e:ds3 -- axe");
const todas: EntradaAxe[] = archivos.flatMap((f) => JSON.parse(readFileSync(new URL(f, carpeta), "utf8")) as EntradaAxe[]);
const texto = `${JSON.stringify(ordenarEntradas(todas), null, 2)}\n`;
leerBaseline(texto); // mismo formato que exige el spec: [{ruta, regla, nodos}] sin duplicados
writeFileSync(destino, texto);
console.log(`axe-baseline.json: ${todas.length} entrada(s) de ${archivos.length} pantalla(s) medida(s)`);
