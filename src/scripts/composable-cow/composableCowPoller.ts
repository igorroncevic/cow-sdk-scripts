import { BigNumber, BigNumberish, ethers } from "ethers";

// Exact interface used by composable-cow/src/types/ComposableCowPoller.sol at
// 194cf5059bd891abf8a53d9936675b84325e5f5b. Remove this adapter once the
// matching @cowprotocol/sdk-composable release is available.
const POLLER_ABI = [
  "function COMPOSABLE_COW() view returns (address)",
  "function COW_SHED_FACTORY() view returns (address)",
  "function schedules(bytes32) view returns (address handler,uint96 authEpoch,address funder,address owner,bytes32 salt,bytes staticInput)",
  "function pollFunds(bytes32 id) returns (bool)",
  "function registerFromShed((address handler,uint96 authEpoch,address funder,address owner,bytes32 salt,bytes staticInput) schedule) returns (bytes32 id)",
  "function revokeFromShed(address handler,address funder,address owner,bytes32 salt,uint96 authEpoch) returns (bytes32 id)",
] as const;

export type PollerSchedule = {
  handler: string;
  authEpoch: BigNumberish;
  funder: string;
  owner: string;
  salt: string;
  staticInput: string;
};

export class ComposableCowPoller {
  readonly contractInterface = new ethers.utils.Interface(POLLER_ABI);
  private readonly contract: ethers.Contract;

  constructor(
    readonly address: string,
    provider: ethers.providers.Provider,
  ) {
    this.contract = new ethers.Contract(address, POLLER_ABI, provider);
  }

  getComposableCowAddress(): Promise<string> {
    return this.contract.COMPOSABLE_COW();
  }

  getCowShedFactoryAddress(): Promise<string> {
    return this.contract.COW_SHED_FACTORY();
  }

  async getSchedule(id: string): Promise<PollerSchedule> {
    const [handler, authEpoch, funder, owner, salt, staticInput] =
      await this.contract.schedules(id);
    return {
      handler,
      authEpoch: BigNumber.from(authEpoch),
      funder,
      owner,
      salt,
      staticInput,
    };
  }

  getScheduleId(
    schedule: Pick<PollerSchedule, "handler" | "funder" | "owner" | "salt">,
  ): string {
    return ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "address", "bytes32"],
        [schedule.funder, schedule.handler, schedule.owner, schedule.salt],
      ),
    );
  }

  encodePollFunds(id: string): string {
    return this.contractInterface.encodeFunctionData("pollFunds", [id]);
  }

  encodeRegisterFromShed(schedule: PollerSchedule): string {
    return this.contractInterface.encodeFunctionData("registerFromShed", [
      schedule,
    ]);
  }

  encodeRevokeFromShed(schedule: PollerSchedule): string {
    return this.contractInterface.encodeFunctionData("revokeFromShed", [
      schedule.handler,
      schedule.funder,
      schedule.owner,
      schedule.salt,
      schedule.authEpoch,
    ]);
  }
}
