import { build } from "esbuild";
import { mkdir, copyFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const out = "dist/aws-worker";
await rm(out, { recursive: true, force: true });
await rm("dist/rockwood-worker.zip", { force: true });
await mkdir(`${out}/server/assets`, { recursive: true });
await mkdir(`${out}/public/brand`, { recursive: true });
await build({entryPoints:["server/aws-worker-entry.ts"],bundle:true,platform:"node",target:"node22",format:"cjs",outfile:`${out}/index.cjs`,logLevel:"warning"});
for (const file of ["NotoSans-Regular.ttf","NotoSans-Bold.ttf","OFL.txt"])
  await copyFile(`server/assets/${file}`,`${out}/server/assets/${file}`);
await copyFile("public/brand/rockwood-logo.png",`${out}/public/brand/rockwood-logo.png`);
await writeFile(`${out}/package.json`,JSON.stringify({type:"commonjs"}));
execFileSync("zip",["-qr","../rockwood-worker.zip","."],{cwd:out});
console.log("Built dist/rockwood-worker.zip (no environment files included).");
