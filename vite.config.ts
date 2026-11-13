import { defineConfig, type Plugin } from "vite";
import pkg from "./package.json" with { type: "json" };

const OUT_DIR = "dist";

/** A package.json bundle path, relative to dist/. */
const inDist = (file: string): string => file.replace(/^(\.\/)?dist\//, "");

// The bundle paths come from package.json, which consumers resolve them through.
const BUNDLES: Record<string, string> = {
  es: inDist(pkg.module),
  // Browser <script> build. Keeps the .js extension the README documents.
  umd: inDist(pkg.browser),
};

/**
 * Writes the UMD bundle a second time as the require() build. The package is
 * "type": "module", so Node parses a .js file as ESM and the UMD wrapper's
 * CommonJS branch never runs; the extension has to be .cjs for require() to
 * return the class. Library mode builds one file per format, hence the copy.
 */
function requireBuild(): Plugin {
  return {
    name: "require-build",
    apply: "build",
    generateBundle(options, bundle) {
      if (options.format !== "umd") {
        return;
      }
      const chunk = bundle[BUNDLES.umd];
      if (!chunk || chunk.type !== "chunk") {
        this.error(`UMD bundle ${BUNDLES.umd} was not generated`);
      }
      this.emitFile({ type: "asset", fileName: inDist(pkg.main), source: chunk.code });
    },
  };
}

export default defineConfig({
  publicDir: false,
  plugins: [requireBuild()],
  build: {
    outDir: OUT_DIR,
    // dist/ holds only build output. The declarations are written by tsc after
    // this step (see the "build" script), so emptying it here is safe.
    emptyOutDir: true,
    // Matches tsconfig.json; Vite's own default would change the output syntax.
    target: "es2020",
    lib: {
      entry: "src/socket-io-proxy.ts",
      name: "SocketIOProxy",
      formats: ["es", "umd"],
      fileName: (format) => BUNDLES[format],
    },
    rolldownOptions: {
      // Consumers bring socket.io-client; @mdaemon/validate is bundled.
      external: ["socket.io-client"],
      output: {
        exports: "default",
        // The <script> build reads socket.io-client from the page's global `io`.
        globals: { "socket.io-client": "io" },
        // Library mode leaves ES output unminified; minify it like the UMD bundle.
        minify: true,
        // Keep the UMD bundle strict, as the TypeScript module and the Rollup
        // build before it were.
        strict: true,
      },
    },
  },
});
