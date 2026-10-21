/** The shared port contract against the Rust host, through `Remote*` adapters over the stdio harness. */
import { beforeAll } from "vitest";
import { sourceHostContract, sqlDriverContract, vaultFsContract } from "./contract.ts";
import { buildHarness, rustRuntime } from "./harness.ts";

beforeAll(() => buildHarness(), 600_000);

vaultFsContract(rustRuntime);
sqlDriverContract(rustRuntime);
sourceHostContract(rustRuntime);
