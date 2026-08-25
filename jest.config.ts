/** @type {import('jest').Config} */
import type { Config } from "@jest/types";

const config: Config.InitialOptions = {
  preset: 'ts-jest',
  verbose: true,
  transform: {
    "^.+\\.ts?$": "ts-jest"
  },
  testEnvironment: 'jsdom',
  // Only *.test.ts are suites; helpers/ holds shared harness code.
  testMatch: ["<rootDir>/src/**/__tests__/**/*.test.ts"],
  setupFiles: ["<rootDir>/src/__tests__/helpers/setup.ts"],
  testPathIgnorePatterns: [
    "<rootDir>/dist/",
    "<rootDir>/public/",
  ]
};

export default config;