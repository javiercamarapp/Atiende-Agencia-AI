// Vercel detecta funciones serverless bajo `/api` en la raíz del repo (Root Directory
// del proyecto de Vercel = raíz del monorepo, ver vercel.json). Este archivo es
// deliberadamente un re-export delgado — toda la lógica real (buildApp + deps de
// producción + adaptador hono/vercel) vive en apps/api/src/vercel.ts, donde también la
// alcanzan los tests (apps/api/tests/vercel.spec.ts) sin depender de la carpeta /api.
export { default, config } from "../apps/api/src/vercel.ts";
