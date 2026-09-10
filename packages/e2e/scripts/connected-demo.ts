import { startFixture } from "../src/fixture.js";
import { runConnectedDemo } from "../src/connected-demo.js";

async function main() {
  if (!process.env.BASE_RPC_URL) throw new Error("Missing fork source");
  console.info(
    "BASE FORK ONLY: real deployed Nota/USDC dependencies, new contracts deployed locally. No public-chain transactions.",
  );
  console.info(
    "AUTHENTICATION: mock-wallet signatures, humanVerified=false. No World ID or AgentBook verification.",
  );
  console.info(
    "BUNDLE: freshly issued by the merchant and released through authenticated paid access; not buyer-generated.",
  );
  const fixture = await startFixture();
  try {
    await runConnectedDemo(fixture, (step) =>
      console.info(JSON.stringify(step)),
    );
    console.info(
      "PASS: one purchase, attacker rejected before redemption, buyer redeemed once, replay rejected. Buyer sent no transactions and held zero ETH.",
    );
    console.info(
      "All displayed transaction hashes belong to the disposable local fork, not Base mainnet.",
    );
  } finally {
    await fixture.stop();
  }
}

main().catch(() => {
  // An RPC or failed assertion may contain calldata/bundles. Never print the original error.
  console.error(
    "Connected demo failed. Check BASE_RPC_URL, Foundry/Anvil and fork availability. No sensitive diagnostic data was logged.",
  );
  process.exitCode = 1;
});
