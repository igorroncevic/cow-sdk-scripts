import {
  SupportedChainId,
} from "@cowprotocol/cow-sdk";
import { ethers } from "ethers";
import { getWallet } from "../../utils";
import { orderHelperFactoryAbi } from "./abi/OrderHelperFactoryAbi";
import { orderHelperAbi } from "./abi/OrderHelperAbi";
import { MetadataApi } from '@cowprotocol/app-data';

const TOKENS = {
  oldUnderlying: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", // WXDAI
  oldCollateral: "0xd0Dd6cEF72143E22cCED4867eb0d5F2328715533", // aWXDAI
  debt: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb", // GNO
  newUnderlying: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83", // USDC
  newCollateral: "0xc6B7AcA6DE8a6044E0e32d0c841a89244A10D284", // aUSDC
} as const;

const AAVE_POOL_ADDRESS = "0xb50201558B00496A145fE76f7424749556E326D8"; // See https://search.onaave.com/?q=sepolia
const COW_AAVE_BORROWER = "0x7d9C4DeE56933151Bc5C909cfe09DEf0d315CB4A"; // See https://github.com/cowprotocol/flash-loan-router/blob/main/networks.json
const COW_AAVE_HELPER_FACTORY = "0xb1e836ae7fe26db465351998d0e8e6fc5a512c46"; // https://sepolia.etherscan.io/address/0xe7De9F737135AEE2d154D1b6b23414C1bf115109#code
const DEFAULT_GAS_LIMIT = "100000"; // FIXME: This should not be necessary, it should estimate correctly!
const VALID_FOR = 1752100000;
const CHAIN_ID = SupportedChainId.GNOSIS_CHAIN;

export async function run() {
  const wallet = await getWallet(CHAIN_ID);
  const trader = wallet.address;
  console.log(`Trader ${trader} needs to approve the collateral to ${COW_AAVE_HELPER_FACTORY}`);

  const orderHelperFactory = new ethers.Contract(
    COW_AAVE_HELPER_FACTORY,
    orderHelperFactoryAbi,
    wallet
  );

  const orderHelperParams = [
    trader, // owner
    COW_AAVE_BORROWER, // cow borrower
    TOKENS.oldUnderlying,
    "20000000000000000000",
    TOKENS.newUnderlying,
    "19500000",
    VALID_FOR,
  ];
  console.log("Get helper contract", orderHelperParams);
  const helperContract: string = await orderHelperFactory.getOrderHelperAddress(
    ...orderHelperParams
  );

  console.log("will use helperContract", helperContract);

  const appCode = 'aave-v3-flashloan'
  const flashLoanHint = {
    lender: AAVE_POOL_ADDRESS,
    borrower: helperContract,
    token: TOKENS.oldUnderlying,
    amount: "20000000000000000000",
  };
  console.log("flashLoanHint", flashLoanHint);

  // Prepare deployment of the helper contract
  const deployOrderHelperData = orderHelperFactory.interface.encodeFunctionData(
    "deployOrderHelper",
    orderHelperParams
  );

  const helperContractInstance = new ethers.Contract(
    helperContract,
    orderHelperAbi
  );
  const stringify = require('json-stringify-deterministic');
  const appDataDoc = {
    appCode: appCode,
    metadata: {
      flashloan: flashLoanHint,
      hooks: {
        // pre: [
        //   {
        //     target: COW_AAVE_HELPER_FACTORY,
        //     callData: deployOrderHelperData,
        //     gasLimit: DEFAULT_GAS_LIMIT,
        //   },
        // ],
        post: [
          {
            target: helperContract,
            callData: helperContractInstance.interface.encodeFunctionData("swapCollateral"),
            gasLimit: DEFAULT_GAS_LIMIT,
          }
        ],
      }

    }
  }
  const metadataApi = new MetadataApi();
  const fullAppData = stringify(appDataDoc);
  console.log("fullAppData", fullAppData);

  const module = await import('ethers/lib/utils')
  const { keccak256, toUtf8Bytes } = module.default || module

  const preAppDataHex = keccak256(toUtf8Bytes(fullAppData))
  console.log("preAppDataHex", preAppDataHex);
  const appDataHex = await metadataApi.appDataHexToCid(preAppDataHex);
  console.log("appDataHex", appDataHex)
  

  const data = {
    "sellToken": TOKENS.oldUnderlying,
    "buyToken": TOKENS.newUnderlying,
    "receiver": helperContract,
    "feeAmount": "0",
    "sellAmount": "20000000000000000000",
    "buyAmount": "19500000",
    "validTo": VALID_FOR,
    "kind": "sell",
    "partiallyFillable": false,
    "sellTokenBalance": "erc20",
    "buyTokenBalance": "erc20",
    "signingScheme": "eip1271",
    "signature": "0x000000000000000000000000e91d153e0b41518a2ce8dd3d7944fa863463a97d000000000000000000000000ddafbb505ad214d7b80b1f830fccc89b60fb7a83000000000000000000000000b4f89a000f964b50eb6d37e758d51884452d5396000000000000000000000000000000000000000000000001158e460913d000000000000000000000000000000000000000000000000000000000000001298be000000000000000000000000000000000000000000000000000000000686eeca0f6b7417024d42d8da3472b65bd63447f8d854c40a5eaabc9f79de9e55139a7bc0000000000000000000000000000000000000000000000000000000000000000f3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee34677500000000000000000000000000000000000000000000000000000000000000005a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc95a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9",
    "from": helperContract.toString(),
    "quoteId": 0,
    "appData": fullAppData,
    //"appDataHash": preAppDataHex
  }

  console.log("data", data);
  console.log("json", JSON.stringify(data));

  // Post the order
  const response = await fetch("https://api.cow.fi/xdai/api/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data)
  });

  if (!response.ok) {
    // Handle error response
    const errorText = await response.text();
    throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
  }

  console.log("response", response);   
}
