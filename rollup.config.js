import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from "@rollup/plugin-typescript";
import esbuild from 'rollup-plugin-esbuild';
import pkg from './package.json';

export default [
  {
    input: 'src/socket-io-proxy.ts',
    external: ['socket.io-client'],
    output: [
      { file: pkg.module, format: 'es', exports: "default" },
      // Browser <script> build. Keeps the .js extension the README documents.
      { file: pkg.browser, format: 'umd', exports: "default", name: "SocketIOProxy", globals: { 'socket.io-client': 'io' } },
      // require() build. The package is "type": "module", so Node parses a .js
      // file as ESM and the UMD wrapper's CommonJS branch never runs — the
      // extension has to be .cjs for require() to return the class.
      { file: pkg.main, format: 'umd', exports: "default", name: "SocketIOProxy", globals: { 'socket.io-client': 'io' } }
    ],
    plugins: [
      nodeResolve(),
      typescript(),
      esbuild({ minify: true })
    ]
  },
]