import { ethers } from "ethers";

const COMPOSABLE_COW_POLLER_ABI = [
  "function COMPOSABLE_COW() external view returns (address)",
  "function nonces(address funder) external view returns (uint256 nonce)",
  "function scheduleId((address handler, address funder, address owner, bytes32 salt, bytes staticInput) schedule) external pure returns (bytes32)",
  "function register((address handler, address funder, address owner, bytes32 salt, bytes staticInput) schedule) external returns (bytes32 id)",
  "function registerWithSignature((address handler, address funder, address owner, bytes32 salt, bytes staticInput) schedule, uint256 deadline, bytes signature) external returns (bytes32 id)",
  "function revoke(bytes32 id) external",
  "function revokeWithSignature(bytes32 id, uint256 deadline, bytes signature) external",
  "function pollFunds(bytes32 id) external returns (bool)",
  "function schedules(bytes32 id) external view returns (address handler, address funder, address owner, bytes32 salt, bytes staticInput)",
  "function funded(bytes32 id, bytes32 digest) external view returns (bool)",
] as const;

export interface PollerSchedule {
  /** The conditional-order handler to poll (e.g. the TWAP type). */
  handler: string;
  /** Source of funds (the EOA in the TWAP-for-EOA flow). */
  funder: string;
  /** Order owner (cow-shed / Safe); the fixed pull destination. */
  owner: string;
  /** The conditional order's `salt`; lets the poller rebuild `ctx` on-chain. */
  salt: string;
  /** The order's `staticInput`, passed verbatim to `getTradeableOrder`. */
  staticInput: string;
}

export function getComposableCowPollerContract(
  pollerAddress: string,
  signer?: ethers.Signer | ethers.providers.Provider,
): ethers.Contract {
  return new ethers.Contract(pollerAddress, COMPOSABLE_COW_POLLER_ABI, signer);
}
