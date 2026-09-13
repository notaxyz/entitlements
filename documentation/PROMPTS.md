# Available builder prompts

[Attribution and archive limitations](./AI_USAGE.md)

These are supplied instructions, preserved as artifacts—not a replacement for current
source or evidence. Historical story requirements below include overclaims that the
implementation/docs explicitly corrected: buyer-generated bundles, endpoint replay
rejection, measured live ETH, and lock retention for uncertain submissions.

## Story-mode prompt supplied before commit 14864c8

```text
Turn the connected demo into a story mode I can narrate live while
recording. Everything already works — the problem is it runs end to end
in one burst, so there is nowhere to speak.

=== ADD A --story FLAG ===
Works with both fork and live mode:
  npm run demo:connected -- --story
  npm run demo:connected -- --live --story

Default behaviour unchanged — CI and tests keep running it unattended.

=== MAKE THE STEP CALLBACK AWAITABLE ===
onStep is currently sync. Make it (step) => void | Promise<void> and
await it in runConnectedDemo. That is the only change to the demo logic
itself — do not restructure the flow.

=== SIX PAUSE POINTS, NOT EVERY STEP ===
Group the existing steps into six acts. Print a title card, run the
steps in that act, print a short summary, then wait for Enter.

  ACT 1 — THE OFFER
    402 returned, extension parsed, commitment recomputed and matched,
    line items verified to sum to the total.
    Summary line: what is being bought, the amount, and that the
    metadata hash matched before anything was signed.

  ACT 2 — THE PAYMENT
    Buyer ETH balance before (zero), EIP-3009 authorization signed,
    facilitator relays, adapter settles.
    Summary must show: buyer ETH before and after, buyer transaction
    count unchanged, and the settlement tx hash.
    This is the beat where the point lands — the buyer paid and never
    sent a transaction.

  ACT 3 — THE ENTITLEMENT
    Buyer receives the preimage bundle in the paid response.
    Summary: the entitlement exists, is unredeemed, and only the holder
    of the bundle can spend it.

  ACT 4 — THE ATTACKER
    Agent B presents agent A's bundle. Rejected at the policy check.
    Summary must state the rejection code, that no transaction was
    submitted, and why: possession of the preimage is not authorization.

  ACT 5 — THE REDEMPTION
    Agent A presents the bundle. Policy passes, seller submits,
    EntitlementRedeemed emitted. Then agent A retries and the contract
    rejects it.
    Summary: redeemed once, replay rejected on-chain.

  ACT 6 — THE RECORD
    Print the subgraph query URL and the query to paste, plus the
    purchaseRef to filter on. Do not run the query — I will do that in
    the browser on camera.

=== OUTPUT FORMAT IN STORY MODE ===
Human-readable, not JSON. Aligned labels, generous blank lines, and a
clear rule between acts so a viewer can see where one ends.

In live mode, print every transaction hash as a full basescan.org URL on
its own line so it is clickable and legible in a recording.

Keep the existing JSON transcript intact for the non-story path.

=== PROMPT BEHAVIOUR ===
Enter advances. Ctrl-C aborts cleanly and, in live mode, releases the run
lock. Never require typing anything but Enter mid-demo — the live
confirmation prompt stays where it is, before act 1.

=== CONSTRAINTS ===
No contract changes. No changes to what the demo actually does or
asserts — only when it pauses and how it prints. All existing tests must
still pass.
```
