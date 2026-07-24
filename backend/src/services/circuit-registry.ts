import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { logger } from "./logger.js";

export interface CircuitInfo {
  circuitId: string;
  circuitType: "Vote" | "Comment";
  registeredAt: number;
  expiration: number;
  numPublicSignals: number;
}

export interface CircuitVKResult {
  vk: {
    alpha: string;
    beta: string;
    gamma: string;
    delta: string;
    ic: string[];
  };
  numPublicSignals: number;
}

export interface CircuitStatus {
  daoId: number;
  circuitType: "Vote" | "Comment";
  currentCircuit: string;
  availableCircuits: CircuitInfo[];
  migration?: {
    fromCircuitId: string;
    toCircuitId: string;
    deadline: number;
    inOverlapWindow: boolean;
  };
}

class CircuitRegistryCache {
  private circuits: Map<string, CircuitInfo> = new Map();
  private lastFetch: number = 0;
  private ttl: number = 60_000;

  private key(circuitId: string, circuitType: string): string {
    return `${circuitType}:${circuitId}`;
  }

  get(circuitId: string, circuitType: string): CircuitInfo | undefined {
    const entry = this.circuits.get(this.key(circuitId, circuitType));
    if (!entry) return undefined;
    if (Date.now() - this.lastFetch > this.ttl) return undefined;
    return entry;
  }

  set(circuitId: string, circuitType: string, info: CircuitInfo): void {
    this.circuits.set(this.key(circuitId, circuitType), info);
    this.lastFetch = Date.now();
  }

  getAll(circuitType: string): CircuitInfo[] {
    const result: CircuitInfo[] = [];
    for (const [key, info] of this.circuits) {
      if (key.startsWith(`${circuitType}:`)) {
        result.push(info);
      }
    }
    return result;
  }
}

const cache = new CircuitRegistryCache();

export function getCache(): CircuitRegistryCache {
  return cache;
}

export async function getVK(
  circuitId: string,
  circuitType: "Vote" | "Comment",
): Promise<CircuitVKResult | null> {
  try {
    const server = new StellarSdk.rpc.Server(config.sorobanRpcUrl);
    const contract = new StellarSdk.Contract(config.circuitRegistryContractId!);

    const args = [
      StellarSdk.nativeToScVal(circuitId, { type: "string" }),
      StellarSdk.nativeToScVal(circuitType, { type: "symbol" }),
    ];

    const result = await server.simulateContract(
      contract.call("get_vk", ...args),
    );

    if (!result.result) {
      logger.error("circuit_vk_simulate_failed", { circuitId, circuitType });
      return null;
    }

    const scVal = result.result.retval;
    const mapEntries = scVal.map()?.entries() ?? [];
    const parsed: Record<string, unknown> = {};

    for (const entry of mapEntries) {
      const key = entry.key.sym()?.toString() ?? "";
      const val = entry.val;
      if (key === "num_public_signals") {
        parsed[key] = Number(val.u32() ?? val.i32() ?? 0);
      } else if (key === "vk") {
        const vkMap = val.map()?.entries() ?? [];
        const vk: Record<string, unknown> = {};
        for (const vkEntry of vkMap) {
          const vkKey = vkEntry.key.sym()?.toString() ?? "";
          const vkVal = vkEntry.val;
          if (vkKey === "ic") {
            const points: string[] = [];
            for (const elem of vkVal.vec() ?? []) {
              points.push(Buffer.from(elem.bytes() ?? []).toString("hex"));
            }
            vk[vkKey] = points;
          } else {
            vk[vkKey] = Buffer.from(vkVal.bytes() ?? []).toString("hex");
          }
        }
        parsed[key] = vk;
      }
    }

    return {
      vk: parsed.vk as CircuitVKResult["vk"],
      numPublicSignals: parsed.num_public_signals as number,
    };
  } catch (error) {
    logger.error("circuit_vk_fetch_error", {
      circuitId,
      circuitType,
      error: (error as Error).message,
    });
    return null;
  }
}

export async function getCircuitInfo(
  circuitId: string,
  circuitType: "Vote" | "Comment",
): Promise<CircuitInfo | null> {
  const cached = cache.get(circuitId, circuitType);
  if (cached) return cached;

  try {
    const server = new StellarSdk.rpc.Server(config.sorobanRpcUrl);
    const contract = new StellarSdk.Contract(config.circuitRegistryContractId!);

    const args = [
      StellarSdk.nativeToScVal(circuitId, { type: "string" }),
      StellarSdk.nativeToScVal(circuitType, { type: "symbol" }),
    ];

    const result = await server.simulateContract(
      contract.call("get_circuit", ...args),
    );

    if (!result.result) return null;

    const scVal = result.result.retval;
    const mapEntries = scVal.map()?.entries() ?? [];
    const parsed: Record<string, unknown> = {};

    for (const entry of mapEntries) {
      const key = entry.key.sym()?.toString() ?? "";
      const val = entry.val;
      if (key === "num_public_signals") {
        parsed[key] = Number(val.u32() ?? 0);
      } else if (key === "registered_at" || key === "expiration") {
        parsed[key] = Number(val.u64()?.toString() ?? val.i64()?.toString() ?? 0);
      } else if (key === "circuit_id") {
        parsed[key] = val.string()?.toString() ?? val.sym()?.toString() ?? "";
      } else if (key === "circuit_type") {
        parsed[key] = val.sym()?.toString() ?? "";
      } else if (key === "wasm_hash") {
        parsed[key] = Buffer.from(val.bytes() ?? []).toString("hex");
      }
    }

    const info: CircuitInfo = {
      circuitId: parsed.circuit_id as string,
      circuitType: parsed.circuit_type as "Vote" | "Comment",
      registeredAt: parsed.registered_at as number,
      expiration: parsed.expiration as number,
      numPublicSignals: parsed.num_public_signals as number,
    };

    cache.set(circuitId, circuitType, info);
    return info;
  } catch (error) {
    logger.error("circuit_info_fetch_error", {
      circuitId,
      circuitType,
      error: (error as Error).message,
    });
    return null;
  }
}

export async function getDaoMigration(
  daoId: number,
): Promise<CircuitStatus["migration"] | null> {
  try {
    const server = new StellarSdk.rpc.Server(config.sorobanRpcUrl);
    const contract = new StellarSdk.Contract(config.circuitRegistryContractId!);

    const args = [StellarSdk.nativeToScVal(daoId, { type: "u64" })];

    const isOverlap = await server.simulateContract(
      contract.call("is_in_overlap_window", ...args),
    );

    const migrationResult = await server.simulateContract(
      contract.call("get_migration", ...args),
    );

    if (!migrationResult.result) return null;

    const scVal = migrationResult.result.retval;
    const mapEntries = scVal.map()?.entries() ?? [];
    const parsed: Record<string, unknown> = {};

    for (const entry of mapEntries) {
      const key = entry.key.sym()?.toString() ?? "";
      const val = entry.val;
      if (key === "dao_id") {
        parsed[key] = Number(val.u64()?.toString() ?? 0);
      } else if (key === "from_circuit_id" || key === "to_circuit_id") {
        parsed[key] = val.string()?.toString() ?? val.sym()?.toString() ?? "";
      } else if (key === "migration_start" || key === "deadline") {
        parsed[key] = Number(val.u64()?.toString() ?? 0);
      } else if (key === "active") {
        parsed[key] = val.bool() ?? false;
      }
    }

    return {
      fromCircuitId: parsed.from_circuit_id as string,
      toCircuitId: parsed.to_circuit_id as string,
      deadline: parsed.deadline as number,
      inOverlapWindow: isOverlap.result?.retval?.bool() ?? false,
    };
  } catch (error) {
    logger.error("migration_fetch_error", {
      daoId,
      error: (error as Error).message,
    });
    return null;
  }
}

export async function getDaoCurrentCircuit(
  daoId: number,
  circuitType: "Vote" | "Comment",
): Promise<string | null> {
  try {
    const server = new StellarSdk.rpc.Server(config.sorobanRpcUrl);
    const contract = new StellarSdk.Contract(config.circuitRegistryContractId!);

    const args = [
      StellarSdk.nativeToScVal(daoId, { type: "u64" }),
      StellarSdk.nativeToScVal(circuitType, { type: "symbol" }),
    ];

    const result = await server.simulateContract(
      contract.call("get_dao_current_circuit", ...args),
    );

    if (!result.result) return null;
    return result.result.retval.string()?.toString() ?? null;
  } catch (error) {
    logger.error("current_circuit_fetch_error", {
      daoId,
      circuitType,
      error: (error as Error).message,
    });
    return null;
  }
}
