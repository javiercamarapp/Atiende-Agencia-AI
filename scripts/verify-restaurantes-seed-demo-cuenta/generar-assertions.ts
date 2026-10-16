// Escribe assertions.sql (ver construir-assertions.ts). npx vite-node scripts/verify-restaurantes-seed-demo-cuenta/generar-assertions.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { construirAssertions } from "./construir-assertions.ts";

writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "assertions.sql"), construirAssertions());
console.log("assertions.sql regenerado");
