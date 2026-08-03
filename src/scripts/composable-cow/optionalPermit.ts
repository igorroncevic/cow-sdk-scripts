import { BigNumber, ethers } from "ethers";

// Multicall3 is deployed at this canonical address on Gnosis Chain.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_INTERFACE = new ethers.utils.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

/**
 * Executes a bearer permit without making its replay fatal. If it was already
 * submitted, the token call may fail but the surrounding hook still succeeds;
 * settlement then relies on the allowance that the earlier permit installed.
 */
export function optionalPermitCall(token: string, permitCalldata: string) {
  return {
    target: MULTICALL3,
    callData: MULTICALL3_INTERFACE.encodeFunctionData("aggregate3", [
      [{ target: token, allowFailure: true, callData: permitCalldata }],
    ]),
  };
}

export function permitValueForDebit(
  currentAllowance: BigNumber,
  debit: BigNumber,
): BigNumber {
  return currentAllowance.gte(debit)
    ? currentAllowance
    : currentAllowance.add(debit);
}
