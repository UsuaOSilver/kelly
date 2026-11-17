require("@nomicfoundation/hardhat-viem");
require("dotenv").config({ path: "../.env" });

const accounts = process.env.OWNER_PRIVATE_KEY ? [process.env.OWNER_PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" },
  },
  networks: {
    localhost: { url: "http://127.0.0.1:8545" },
    arcTestnet: {
      url: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.io",
      chainId: 5042002,
      accounts,
    },
  },
};
