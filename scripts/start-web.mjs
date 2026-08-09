import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(projectRoot, "dist");
const distEntry = join(distRoot, "index.html");
const defaultHost = "127.0.0.1";
const defaultPort = 4173;
const maxPortAttempts = 20;
const minimumNodeMajor = 20;

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const buildInputs = [
  "src",
  "index.html",
  "package.json",
  "package-lock.json",
  "postcss.config.cjs",
  "tailwind.config.ts",
  "tsconfig.app.json",
  "tsconfig.json",
  "tsconfig.node.json",
  "vite.config.ts",
];

const readArguments = () => {
  const options = {
    host: defaultHost,
    port: defaultPort,
    open: true,
    forceBuild: false,
  };

  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === "--no-open") options.open = false;
    else if (argument === "--force-build") options.forceBuild = true;
    else if (argument === "--host" && process.argv[index + 1]) options.host = process.argv[++index];
    else if (argument === "--port" && process.argv[index + 1]) options.port = Number(process.argv[++index]);
  }

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("Invalid --port value");
  }
  return options;
};

const latestMtime = async (path) => {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return info.mtimeMs;
    const entries = await readdir(path, { withFileTypes: true });
    const times = await Promise.all(entries.map((entry) => latestMtime(join(path, entry.name))));
    return Math.max(info.mtimeMs, ...times);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
};

const runNpm = (arguments_) => {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, arguments_, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${arguments_.join(" ")} failed with exit code ${result.status}`);
};

const ensureBuild = async (forceBuild) => {
  const distMtime = await latestMtime(distEntry);
  const inputMtimes = await Promise.all(buildInputs.map((path) => latestMtime(join(projectRoot, path))));
  const sourceMtime = Math.max(...inputMtimes);
  if (!forceBuild && distMtime > 0 && distMtime >= sourceMtime) return;

  console.log("[MELY] Web build is missing or outdated.");
  try {
    if (!existsSync(join(projectRoot, "node_modules", "vite", "package.json"))) {
      console.log("[MELY] Installing dependencies for the first rebuild...");
      runNpm(["ci"]);
    }
    console.log("[MELY] Building the web application...");
    runNpm(["run", "build:web"]);
  } catch (error) {
    if (distMtime <= 0) throw error;
    console.warn("[MELY] The latest source did not build. Serving the last successful web build instead.");
  }
};

const safeFilePath = (requestPath) => {
  const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const filePath = resolve(distRoot, relativePath);
  const relation = relative(distRoot, filePath);
  if (relation === ".." || relation.startsWith(`..${sep}`)) return null;
  return filePath;
};

const serveFile = async (request, response, requestedPath) => {
  let filePath = safeFilePath(requestedPath);
  if (!filePath) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    let info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = join(filePath, "index.html");
      info = await stat(filePath);
    }
    if (!info.isFile()) throw Object.assign(new Error("Not a file"), { code: "ENOENT" });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (extname(requestedPath)) {
      response.writeHead(404).end("Not found");
      return;
    }
    filePath = distEntry;
  }

  const contentType = mimeTypes.get(extname(filePath).toLowerCase()) || "application/octet-stream";
  response.writeHead(200, {
    "Cache-Control": filePath === distEntry ? "no-cache" : "public, max-age=31536000, immutable",
    "Content-Type": contentType,
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(filePath).pipe(response);
};

const createRequestHandler = () => async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname === "/__mely_health") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ application: "MELY", status: "ready" }));
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
      return;
    }
    await serveFile(request, response, decodeURIComponent(url.pathname));
  } catch (error) {
    console.error("[MELY] Request failed:", error);
    if (!response.headersSent) response.writeHead(500);
    response.end("Internal server error");
  }
};

const isMelyServer = (host, port) => new Promise((resolve_) => {
  const request = fetch(`http://${host}:${port}/__mely_health`, { signal: AbortSignal.timeout(500) })
    .then((response) => response.ok ? response.json() : null)
    .then((health) => resolve_(health?.application === "MELY"))
    .catch(() => resolve_(false));
  void request;
});

const listen = (server, host, port) => new Promise((resolve_, reject) => {
  const onError = (error) => {
    server.off("listening", onListening);
    reject(error);
  };
  const onListening = () => {
    server.off("error", onError);
    resolve_();
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(port, host);
});

const startServer = async (host, preferredPort) => {
  for (let offset = 0; offset < maxPortAttempts; offset += 1) {
    const port = preferredPort + offset;
    if (await isMelyServer(host, port)) return { port, server: null };
    const server = createServer(createRequestHandler());
    try {
      await listen(server, host, port);
      return { port, server };
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`No available local port found from ${preferredPort}`);
};

const openBrowser = (url) => {
  const command = process.platform === "win32"
    ? ["cmd.exe", ["/d", "/s", "/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
};

const main = async () => {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < minimumNodeMajor) {
    throw new Error(`Node.js ${minimumNodeMajor} or newer is required. Current version: ${process.versions.node}`);
  }
  const options = readArguments();
  await ensureBuild(options.forceBuild);
  const { port, server } = await startServer(options.host, options.port);
  const url = `http://${options.host}:${port}/`;
  console.log(`[MELY] Ready: ${url}`);
  if (!server) console.log("[MELY] Reusing the existing local server.");
  if (options.open) openBrowser(url);
  if (!server) return;

  const close = () => server.close(() => process.exit(0));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
};

main().catch((error) => {
  console.error("[MELY] Startup failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
