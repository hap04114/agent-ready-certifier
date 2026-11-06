import { ConfigError, describeConfig, loadConfig, type Config } from "./env.js";

/**
 * Load config for a service entry point. On any sandbox or validation problem, print the
 * problems (variable names only, never values) and exit with code 1.
 */
export function bootConfig(service: string): Config {
  try {
    const config = loadConfig();
    console.log(`[${service}] config ok: PAYPAL_ENV=${config.PAYPAL_ENV}, PAYPAL_API_BASE=${config.PAYPAL_API_BASE}`);
    return config;
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[${service}] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

export { describeConfig };
