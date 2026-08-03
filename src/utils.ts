import {
  QuoteResults,
  SupportedChainId,
  TargetChainId,
} from "@cowprotocol/cow-sdk";
import { ethers } from "ethers";
import inquirer from "inquirer";

const PROVIDERS_CACHE: Partial<
  Record<TargetChainId, ethers.providers.JsonRpcProvider>
> = {};

export async function getRpcProvider(chainId: TargetChainId) {
  if (PROVIDERS_CACHE[chainId]) {
    return PROVIDERS_CACHE[chainId];
  }

  const envName = `RPC_URL_${chainId}`;
  const rpcUrl = process.env[envName];
  if (!rpcUrl) {
    throw new Error(
      `No RPC URL found for chain ${chainId}. Please define env ${envName}`
    );
  }

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

  // Make sure the specified provider is for the correct chain
  const { chainId: providerChainId, name: providerName } =
    await provider.getNetwork();

  if (providerChainId !== chainId) {
    throw new Error(
      `Provider is not connected to chain ${chainId}. Provider is connected to chain ${providerChainId} (${providerName})`
    );
  }

  PROVIDERS_CACHE[chainId] = provider;
  return provider;
}

export async function getWallet(chainId: SupportedChainId) {
  return new ethers.Wallet(getPk(), await getRpcProvider(chainId));
}

export function getPk() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    throw new Error("PRIVATE_KEY is not set");
  }

  return pk;
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function confirm(message: string): Promise<boolean> {
  const { confirmed } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirmed",
      message,
      default: false,
    },
  ]);

  return confirmed;
}

export const jsonReplacer = (key: string, value: any) => {
  // Handle BigInt
  if (typeof value === "bigint") {
    return value.toString();
  }
  // Handle BigNumber (if you're using ethers.BigNumber)
  if (value?._isBigNumber) {
    return value.toString();
  }
  return value;
};

/**
 * Recursively converts BigNumber instances to strings for debugging purposes
 * @param obj - The object to process
 * @returns A new object with BigNumbers converted to strings
 */
export function debugStringify(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle BigNumber instances
  if (obj?._isBigNumber) {
    return obj.toString();
  }

  // Handle BigInt
  if (typeof obj === "bigint") {
    return obj.toString();
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(debugStringify);
  }

  // Handle objects (but not functions, dates, etc.)
  if (typeof obj === "object" && obj.constructor === Object) {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = debugStringify(value);
    }
    return result;
  }

  // Handle other object types (like class instances)
  if (typeof obj === "object" && obj.constructor !== Object) {
    try {
      // Try to convert to plain object first
      const plainObj = JSON.parse(JSON.stringify(obj, jsonReplacer));
      return debugStringify(plainObj);
    } catch {
      // If that fails, return the string representation
      return obj.toString();
    }
  }

  // Return primitive values as-is
  return obj;
}

export function printQuote(quoteResults: QuoteResults) {
  console.log(`\n📉 Suggested slippage: ${quoteResults.suggestedSlippageBps}`);

  console.log(
    "\n🤝 Quote: ",
    JSON.stringify(quoteResults.quoteResponse, jsonReplacer, 2)
  );
  console.log(
    "\n💰 Amounts and costs: ",
    JSON.stringify(quoteResults.amountsAndCosts, jsonReplacer, 2)
  );
  console.log(
    "\n💿 App Data: ",
    JSON.stringify(quoteResults.appDataInfo, jsonReplacer, 2)
  );

  console.log(
    "\n✍️ Order to sign: ",
    JSON.stringify(quoteResults.orderToSign, jsonReplacer, 2)
  );

  console.log(
    "\n📝 Order Typed Data: ",
    JSON.stringify(quoteResults.orderTypedData, jsonReplacer, 2)
  );
}

export function getExplorerUrl(chainId: SupportedChainId, txHash: string) {
  if (chainId === SupportedChainId.MAINNET) {
    return `https://etherscan.io/tx/${txHash}`;
  }
  if (chainId === SupportedChainId.SEPOLIA) {
    return `https://sepolia.etherscan.io/tx/${txHash}`;
  }
  if (chainId === SupportedChainId.GNOSIS_CHAIN) {
    return `https://gnosisscan.io/tx/${txHash}`;
  }

  if (chainId === SupportedChainId.ARBITRUM_ONE) {
    return `https://arbiscan.io/tx/${txHash}`;
  }

  if (chainId === SupportedChainId.BASE) {
    return `https://basescan.org/tx/${txHash}`;
  }

  throw new Error(`Unsupported Explorer for chainId ${chainId}`);
}
