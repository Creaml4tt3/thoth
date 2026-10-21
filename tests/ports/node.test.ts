/** The shared port contract against the Node reference implementations. */
import { sourceHostContract, sqlDriverContract, vaultFsContract } from "./contract.ts";
import { nodeRuntime } from "./harness.ts";

vaultFsContract(nodeRuntime);
sqlDriverContract(nodeRuntime);
sourceHostContract(nodeRuntime);
