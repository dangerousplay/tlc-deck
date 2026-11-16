import type { Driver, DriverFactory } from "../driver.js";
import { CliDriver, type DriverConfig, SPECS } from "./harness.js";

export * from "./exec.js";
export * from "./harness.js";

export const KNOWN_HARNESSES = Object.keys(SPECS);

/** Build a DriverFactory for the real harness CLIs; `config` is `driver.<h>` from config. */
export function createDriverFactory(config: DriverConfig = {}): DriverFactory {
  return (harness: string): Driver => {
    const spec = SPECS[harness];
    if (!spec) {
      return {
        name: harness,
        run: async () => {
          throw new Error(
            `no driver for harness "${harness}" (known: ${KNOWN_HARNESSES.join(", ")})`,
          );
        },
      };
    }
    return new CliDriver(spec, config[harness] ?? {});
  };
}
