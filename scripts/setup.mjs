// One-shot setup from a fresh clone: install the three packages, create .env, build the web app.
import { execSync } from "node:child_process";
import fs from "node:fs";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
for (const dir of ["contracts", "server", "web"]) run(`npm --prefix ${dir} install --no-audit --no-fund`);
if (!fs.existsSync(".env")) {
  fs.copyFileSync(".env.example", ".env");
  console.log("Created .env (demo mode, no keys needed).");
}
run("npm --prefix web run build");
console.log("\nReady. Start the demo with:  npm run demo   → http://localhost:8787");
