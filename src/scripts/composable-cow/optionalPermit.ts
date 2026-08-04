import { BigNumber, ethers } from "ethers";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_INTERFACE = new ethers.utils.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);
const PERMIT_TOKEN_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function decimals() external view returns (uint8)",
  "function name() external view returns (string)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function nonces(address owner) external view returns (uint256)",
  "function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
] as const;

export function getPermitTokenContract(
  token: string,
  signer?: ethers.Signer | ethers.providers.Provider,
) {
  return new ethers.Contract(token, PERMIT_TOKEN_ABI, signer);
}

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
