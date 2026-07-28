import { ethers } from "ethers";

const ERC20_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function decimals() external view returns (uint8)",
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function nonces(address owner) external view returns (uint256)",
  "function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
] as const;

export function getErc20Contract(
  tokenAddress: string,
  signer?: ethers.Signer | ethers.providers.Provider
): ethers.Contract {
  return new ethers.Contract(tokenAddress, ERC20_ABI, signer);
}
