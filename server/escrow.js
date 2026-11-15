/* Server-held escrow on Solana. Players send their stake to one wallet the server controls;
   the server checks each payment on-chain before seating the player, and pays winners and refunds from it.
   shortcut: holds nothing on disk, so stakes held when the process is killed stay in the escrow wallet
   and must be returned by hand; add a database of deposits before using real money. */
const crypto = require("crypto");
const web3 = require("@solana/web3.js");

const MEMO_PROGRAM = new web3.PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const FEE = 5000;                 // lamports the network charges per transaction
const INTENT_MS = 10 * 60 * 1000; // how long a payment request stays valid
const CONFIRM_MS = 60 * 1000;     // how long we look for a payment before giving up

/* An error whose message is safe and useful to show the player */
const playerError = message => Object.assign(new Error(message), { userMessage: message });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function createEscrow({ secret, rpcUrl = "https://api.devnet.solana.com" }) {
  const keypair = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
  const address = keypair.publicKey.toBase58();
  const conn = new web3.Connection(rpcUrl, "confirmed");
  const intents = new Map();      // ref -> { owner, lamports, expires, busy }
  let queue = Promise.resolve();  // payments go out one at a time

  return {
    address, rpcUrl, fee: FEE,

    /* A payment request for one player. The ref goes into the transaction's memo, which ties the
       payment to this player's session: nobody else can claim it, and it can only be used once. */
    intent(owner, lamports) {
      const now = Date.now();
      for (const [ref, i] of intents) if (i.expires < now || (i.owner === owner && !i.busy)) intents.delete(ref);
      const ref = "tiki-" + crypto.randomBytes(12).toString("hex");
      intents.set(ref, { owner, lamports, expires: now + INTENT_MS, busy: false });
      return { ref, to: address, lamports };
    },

    /* Resolves with { payer, lamports } once the payment is confirmed on-chain; rejects otherwise. */
    async verify(owner, ref, signature) {
      const intent = intents.get(ref);
      if (!intent || intent.owner !== owner || intent.expires < Date.now()) throw playerError("That payment request has expired. Try again.");
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) throw playerError("That doesn't look like a Solana transaction.");
      if (intent.busy) throw playerError("Still confirming your payment.");
      intent.busy = true;
      try {
        const deadline = Date.now() + CONFIRM_MS;
        let tx = null;
        while (!tx && Date.now() < deadline) {
          tx = await conn.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
          if (!tx) await sleep(2000);
        }
        if (!tx) throw playerError("We couldn't find your payment on Solana devnet. Check Phantom is set to devnet and try again.");
        if (tx.meta?.err) throw playerError("Your payment failed on-chain, so nothing was taken. Try again.");
        const steps = tx.transaction.message.instructions;
        const memo = steps.some(s => s.program === "spl-memo" && s.parsed === ref);
        const transfer = steps.find(s => s.program === "system" && s.parsed?.type === "transfer" &&
          s.parsed.info.destination === address && s.parsed.info.lamports >= intent.lamports);
        if (!memo || !transfer) throw playerError("That transaction isn't the stake payment we asked for.");
        intents.delete(ref);
        return { payer: transfer.parsed.info.source, lamports: transfer.parsed.info.lamports };
      } finally { intent.busy = false; }
    },

    /* Sends one transaction paying every { to, lamports }. Resolves with its signature. */
    pay(transfers) {
      const run = async () => {
        const tx = new web3.Transaction();
        transfers.forEach(t => tx.add(web3.SystemProgram.transfer({
          fromPubkey: keypair.publicKey, toPubkey: new web3.PublicKey(t.to), lamports: t.lamports
        })));
        // A unique memo, so two identical refunds in the same moment are never mistaken for one transaction
        tx.add(new web3.TransactionInstruction({
          keys: [], programId: MEMO_PROGRAM, data: Buffer.from("tiki-pay-" + crypto.randomBytes(8).toString("hex"))
        }));
        tx.feePayer = keypair.publicKey;
        let lastError;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            // Signed fresh each attempt. An attempt only repeats after its blockhash has expired,
            // so a payment can never go out twice.
            const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.sign(keypair);
            const signature = await conn.sendRawTransaction(tx.serialize());
            // Polled over plain HTTP: no long-lived socket to the RPC to drop
            for (;;) {
              const status = (await conn.getSignatureStatuses([signature])).value[0];
              if (status?.err) throw new Error("payment failed on-chain: " + JSON.stringify(status.err));
              if (status && status.confirmationStatus !== "processed") return signature;
              if (await conn.getBlockHeight() > lastValidBlockHeight) break;
              await sleep(1500);
            }
            lastError = new Error("payment was not confirmed before it expired");
          } catch (err) { lastError = err; await sleep(1500); }
        }
        throw lastError;
      };
      const result = queue.then(run);
      queue = result.catch(() => {});
      return result;
    },

    /* Resolves when every payment sent so far has finished */
    idle: () => queue
  };
}

module.exports = { createEscrow, FEE };
