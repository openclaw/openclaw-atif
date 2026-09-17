export default {
  buildCommand: "npm run build",
  checkers: ["typescript"],
  coverageAnalysis: "perTest",
  mutate: ["src/atif/identity.ts", "src/stable-json.ts"],
  reporters: ["clear-text", "progress"],
  tempDirName: ".stryker-tmp",
  testRunner: "vitest",
  thresholds: {
    break: 85,
    high: 90,
    low: 85,
  },
  tsconfigFile: "tsconfig.json",
  vitest: {
    configFile: "vitest.config.ts",
  },
};
