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
      { file: pkg.browser, format: 'umd', exports: "default", name: "SocketIOProxy", globals: { 'socket.io-client': 'io' } }
    ],
    plugins: [
      nodeResolve(),
      typescript(),
      esbuild({ minify: true })
    ]
  },
]