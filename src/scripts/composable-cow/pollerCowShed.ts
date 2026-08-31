import { SupportedChainId } from "@cowprotocol/cow-sdk";
import {
  CowShedHooks,
  CowShedSdk,
  ICoWShedOptions,
} from "@cowprotocol/sdk-cow-shed";
import { AbstractProviderAdapter } from "@cowprotocol/sdk-common";

import { COW_SHED_PROXY_CREATION_CODE } from "./cowShed";

// COWShedForComposableCoW deployment used by ComposableCowPoller on Gnosis Chain.
// See composable-cow/networks.json at d4e49601a1a8c130b2b28dd3a97fb187d3555ba6.
export const COW_SHED_VERSION = "2.1.0";
export const COW_SHED_FACTORY_ADDRESS =
  "0x5E284e80F3bd6A7D80A8500D9c49878028110848";
export const COW_SHED_IMPLEMENTATION_ADDRESS =
  "0xF0D400089d5b9fACA64E3422AD6614546587cfFB";

const COW_SHED_FACTORY_OPTIONS = {
  factoryAddress: COW_SHED_FACTORY_ADDRESS,
  implementationAddress: COW_SHED_IMPLEMENTATION_ADDRESS,
  proxyCreationCode: COW_SHED_PROXY_CREATION_CODE,
} as const;

// The SDK runtime supports custom versions, but its public type currently lists
// only the canonical 1.x deployments and does not propagate custom versions to
// the internal hook signer.
const CustomVersionCowShedHooks = CowShedHooks as unknown as new (
  chainId: SupportedChainId,
  customOptions: ICoWShedOptions,
  version: string,
) => CowShedHooks;

class PollerCowShedSdk extends CowShedSdk {
  constructor(adapter: AbstractProviderAdapter) {
    super(adapter, COW_SHED_FACTORY_OPTIONS, COW_SHED_VERSION as never);
  }

  protected override getCowShedHooks(
    chainId: SupportedChainId,
    customOptions: ICoWShedOptions = COW_SHED_FACTORY_OPTIONS,
  ): CowShedHooks {
    let hooks = this.hooksCache.get(chainId);
    if (!hooks) {
      hooks = new CustomVersionCowShedHooks(
        chainId,
        customOptions,
        COW_SHED_VERSION,
      );
      this.hooksCache.set(chainId, hooks);
    }
    return hooks;
  }
}

export function getPollerCowShedSdk(
  adapter: AbstractProviderAdapter,
): CowShedSdk {
  return new PollerCowShedSdk(adapter);
}
