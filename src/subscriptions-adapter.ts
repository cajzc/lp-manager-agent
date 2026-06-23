import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import {
  address,
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  signTransactionMessageWithSigners,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  findRecurringDelegationPda,
  findSubscriptionAuthorityPda,
  getRecurringDelegationDecoder,
  getCreateRecurringDelegationOverlayInstructionAsync,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getRevokeDelegationOverlayInstruction,
  getSubscriptionAuthorityDecoder,
  getTransferRecurringOverlayInstructionAsync,
} from "@solana/subscriptions";
import {
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { RuntimeConfig } from "./runtime-config.js";
import type { Mandate, MandateRequest, MandateRequestType } from "./production-database.js";

export interface PrepareMandateRequestInput {
  type: "create" | "replace" | "revoke";
  userWallet: string;
  mint: string;
  capTokens?: string;
  periodSeconds?: number;
  expirySeconds?: number;
  currentMandate?: Mandate;
}

export interface MandateActionTransaction {
  transaction: string;
  message: string;
}

export class SubscriptionsAdapter {
  private readonly connection: Connection;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly agent: Keypair,
  ) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
  }

  async prepareRequest(input: PrepareMandateRequestInput): Promise<MandateRequest> {
    const user = new PublicKey(input.userWallet);
    const mint = new PublicKey(input.mint);
    const mintAccount = await this.connection.getAccountInfo(mint, "confirmed");
    if (!mintAccount) throw new Error(`Mint ${mint.toBase58()} does not exist`);
    const tokenProgram = mintAccount.owner;
    if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new Error(`Mint ${mint.toBase58()} is not owned by an SPL token program`);
    }
    const mintInfo = await getMint(this.connection, mint, "confirmed", tokenProgram);

    const userAta = getAssociatedTokenAddressSync(mint, user, false, tokenProgram);
    const userAtaInfo = await this.connection.getAccountInfo(userAta, "confirmed");
    if (!userAtaInfo) {
      throw new Error(`User token account ${userAta.toBase58()} does not exist for mint ${mint.toBase58()}`);
    }

    const agentAta = (
      await getOrCreateAssociatedTokenAccount(
        this.connection,
        this.agent,
        mint,
        this.agent.publicKey,
        false,
        "confirmed",
        undefined,
        tokenProgram,
      )
    ).address;

    const now = Math.floor(Date.now() / 1000);
    const requestId = randomUUID();
    const requestExpiresAt = new Date((now + 15 * 60) * 1000).toISOString();
    const actionUrl = `${this.config.publicBaseUrl}/plugins/lp-manager/actions/mandates/${requestId}`;

    if (input.type === "revoke") {
      if (!input.currentMandate) throw new Error("An active mandate is required to revoke");
      return {
        id: requestId,
        type: "revoke",
        status: "pending",
        userWallet: user.toBase58(),
        agentWallet: this.agent.publicKey.toBase58(),
        mint: mint.toBase58(),
        tokenProgram: tokenProgram.toBase58(),
        userAta: userAta.toBase58(),
        agentAta: agentAta.toBase58(),
        currentDelegationPda: input.currentMandate.id,
        actionUrl,
        createdAt: new Date(now * 1000).toISOString(),
        expiresAt: requestExpiresAt,
      };
    }

    if (!input.capTokens || new Decimal(input.capTokens).lte(0)) {
      throw new Error("capTokens must be greater than zero");
    }
    const periodSeconds = input.periodSeconds ?? 604800;
    const expirySeconds = input.expirySeconds ?? 30 * 24 * 60 * 60;
    const capBaseUnits = tokenAmountToBaseUnits(input.capTokens, mintInfo.decimals);
    const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
    const subscriptionAuthority = await deriveSubscriptionAuthority(user.toBase58(), mint.toBase58());
    const authorityAccount = await this.fetchSubscriptionAuthority(subscriptionAuthority);

    if (!authorityAccount) {
      return {
        id: requestId,
        type: "initialize",
        status: "pending",
        userWallet: user.toBase58(),
        agentWallet: this.agent.publicKey.toBase58(),
        mint: mint.toBase58(),
        tokenProgram: tokenProgram.toBase58(),
        userAta: userAta.toBase58(),
        agentAta: agentAta.toBase58(),
        capBaseUnits: capBaseUnits.toString(),
        periodSeconds,
        expiryTs: now + expirySeconds,
        nonce: nonce.toString(),
        actionUrl,
        createdAt: new Date(now * 1000).toISOString(),
        expiresAt: requestExpiresAt,
      };
    }

    const delegationPda = await deriveRecurringDelegation({
      subscriptionAuthority,
      delegator: user.toBase58(),
      delegatee: this.agent.publicKey.toBase58(),
      nonce,
    });
    return {
      id: requestId,
      type: input.type,
      status: "pending",
      userWallet: user.toBase58(),
      agentWallet: this.agent.publicKey.toBase58(),
      mint: mint.toBase58(),
      tokenProgram: tokenProgram.toBase58(),
      userAta: userAta.toBase58(),
      agentAta: agentAta.toBase58(),
      currentDelegationPda: input.currentMandate?.id,
      expectedDelegationPda: delegationPda,
      capBaseUnits: capBaseUnits.toString(),
      periodSeconds,
      expiryTs: now + expirySeconds,
      nonce: nonce.toString(),
      actionUrl,
      createdAt: new Date(now * 1000).toISOString(),
      expiresAt: requestExpiresAt,
    };
  }

  async buildActionTransaction(request: MandateRequest, account: string): Promise<MandateActionTransaction> {
    if (request.status !== "pending") throw new Error(`Mandate request is ${request.status}`);
    if (Date.parse(request.expiresAt) <= Date.now()) throw new Error("Mandate request expired");
    if (new PublicKey(account).toBase58() !== request.userWallet) {
      throw new Error(`This Action must be signed by ${request.userWallet}`);
    }

    const user = createNoopSigner(address(request.userWallet));
    const latestBlockhash = await this.connection.getLatestBlockhash("confirmed");
    const message = setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: latestBlockhash.blockhash as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0]["blockhash"],
        lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight),
      },
      setTransactionMessageFeePayerSigner(user, createTransactionMessage({ version: 0 })),
    );
    const instructions = [];

    if (request.type === "initialize") {
      instructions.push(
        await getInitSubscriptionAuthorityOverlayInstructionAsync({
          owner: user,
          tokenMint: address(request.mint),
          tokenProgram: address(request.tokenProgram),
          userAta: address(request.userAta),
        }),
      );
    } else {
      if ((request.type === "replace" || request.type === "revoke") && request.currentDelegationPda) {
        instructions.push(
          getRevokeDelegationOverlayInstruction({
            authority: user,
            delegationAccount: address(request.currentDelegationPda),
          } as never),
        );
      }
      if (request.type !== "revoke") {
        const authority = await this.fetchSubscriptionAuthority(await deriveSubscriptionAuthority(
          request.userWallet,
          request.mint,
        ));
        if (!authority) throw new Error("Subscription authority must be initialized first");
        instructions.push(
          await getCreateRecurringDelegationOverlayInstructionAsync({
            amountPerPeriod: BigInt(required(request.capBaseUnits, "capBaseUnits")),
            delegatee: address(request.agentWallet),
            delegator: user,
            expectedSubscriptionAuthorityInitId: authority.initId,
            expiryTs: BigInt(required(request.expiryTs, "expiryTs")),
            nonce: BigInt(required(request.nonce, "nonce")),
            periodLengthS: BigInt(required(request.periodSeconds, "periodSeconds")),
            startTs: BigInt(Math.floor(Date.now() / 1000) + 2),
            tokenMint: address(request.mint),
          }),
        );
      }
    }

    const transactionMessage =
      instructions.length === 1
        ? appendTransactionMessageInstruction(instructions[0], message)
        : appendTransactionMessageInstructions(instructions, message);
    return {
      transaction: getBase64EncodedWireTransaction(compileTransaction(transactionMessage)),
      message:
        request.type === "initialize"
          ? "Initialize the wallet's Solana recurring-allowance authority. A second signature will create the mandate."
          : request.type === "revoke"
            ? "Revoke the LP manager recurring allowance."
            : `${request.type === "replace" ? "Replace" : "Create"} the LP manager recurring allowance.`,
    };
  }

  async verifyCompletedRequest(request: MandateRequest, signature: string): Promise<Mandate | "initialized" | "revoked"> {
    if (request.status === "confirmed") {
      if (request.transactionSignature !== signature) {
        throw new Error("Mandate request was already completed with a different transaction");
      }
    } else if (request.status !== "pending") {
      throw new Error(`Mandate request is ${request.status}`);
    }
    const status = await this.connection.getSignatureStatus(signature, { searchTransactionHistory: true });
    if (!status.value || status.value.err || !["confirmed", "finalized"].includes(status.value.confirmationStatus ?? "")) {
      throw new Error("Transaction is not confirmed successfully on chain");
    }
    const transaction = await this.connection.getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!transaction) throw new Error("Confirmed transaction could not be fetched");
    if (transaction.blockTime && transaction.blockTime * 1000 > Date.parse(request.expiresAt)) {
      throw new Error("Transaction was confirmed after the mandate request expired");
    }
    const signedByUser = transaction.transaction.message.accountKeys.some(
      (key) => key.signer && key.pubkey.toBase58() === request.userWallet,
    );
    if (!signedByUser) throw new Error("Confirmed transaction was not signed by the mandate owner");

    if (request.type === "initialize") {
      const authority = await this.fetchSubscriptionAuthority(
        await deriveSubscriptionAuthority(request.userWallet, request.mint),
      );
      if (!authority) throw new Error("Subscription authority was not initialized on chain");
      return "initialized";
    }
    if (request.type === "revoke") {
      if (!request.currentDelegationPda) throw new Error("Revoke request has no delegation PDA");
      const info = await this.connection.getAccountInfo(new PublicKey(request.currentDelegationPda), "confirmed");
      if (info) throw new Error("Delegation account still exists after revoke transaction");
      return "revoked";
    }

    const delegationPda = required(request.expectedDelegationPda, "expectedDelegationPda");
    const delegation = await this.fetchRecurringDelegation(delegationPda);
    if (
      delegation.header.delegator !== request.userWallet ||
      delegation.header.delegatee !== request.agentWallet ||
      delegation.amountPerPeriod !== BigInt(required(request.capBaseUnits, "capBaseUnits"))
    ) {
      throw new Error("On-chain delegation does not match the signed request");
    }
    return {
      id: delegationPda,
      userWallet: request.userWallet,
      agentWallet: request.agentWallet,
      mint: request.mint,
      tokenProgram: request.tokenProgram,
      userAta: request.userAta,
      agentAta: request.agentAta,
      capBaseUnits: delegation.amountPerPeriod.toString(),
      amountPulledBaseUnits: delegation.amountPulledInPeriod.toString(),
      periodSeconds: Number(delegation.periodLengthS),
      startTs: Number(delegation.currentPeriodStartTs),
      expiryTs: Number(delegation.expiryTs),
      status: "active",
      updatedAt: new Date().toISOString(),
    };
  }

  async pull(mandate: Mandate, amountBaseUnits: bigint): Promise<{ signature: string; remainingBaseUnits: bigint }> {
    if (amountBaseUnits <= 0n) throw new Error("Pull amount must be positive");
    const signer = await createKeyPairSignerFromBytes(this.agent.secretKey);
    const instruction = await getTransferRecurringOverlayInstructionAsync({
      amount: amountBaseUnits,
      delegatee: signer,
      delegationPda: address(mandate.id),
      delegator: address(mandate.userWallet),
      delegatorAta: address(mandate.userAta),
      receiverAta: address(mandate.agentAta),
      tokenMint: address(mandate.mint),
      tokenProgram: address(mandate.tokenProgram),
    });
    const latestBlockhash = await this.connection.getLatestBlockhash("confirmed");
    const message = appendTransactionMessageInstruction(
      instruction,
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: latestBlockhash.blockhash as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0]["blockhash"],
          lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight),
        },
        setTransactionMessageFeePayerSigner(signer, createTransactionMessage({ version: 0 })),
      ),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const signature = await this.connection.sendRawTransaction(
      Buffer.from(getBase64EncodedWireTransaction(signed), "base64"),
      { preflightCommitment: "confirmed" },
    );
    await this.connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");
    const delegation = await this.fetchRecurringDelegation(mandate.id);
    return {
      signature,
      remainingBaseUnits: delegation.amountPerPeriod - delegation.amountPulledInPeriod,
    };
  }

  async reconcileMandate(mandate: Mandate): Promise<Mandate> {
    try {
      const delegation = await this.fetchRecurringDelegation(mandate.id);
      const now = Math.floor(Date.now() / 1000);
      return {
        ...mandate,
        capBaseUnits: delegation.amountPerPeriod.toString(),
        amountPulledBaseUnits: delegation.amountPulledInPeriod.toString(),
        periodSeconds: Number(delegation.periodLengthS),
        startTs: Number(delegation.currentPeriodStartTs),
        expiryTs: Number(delegation.expiryTs),
        status: Number(delegation.expiryTs) <= now ? "expired" : "active",
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof Error && /not found|does not exist|AccountNotFound/i.test(error.message)) {
        return { ...mandate, status: "revoked", updatedAt: new Date().toISOString() };
      }
      throw error;
    }
  }

  private async fetchSubscriptionAuthority(pda: string) {
    const account = await this.connection.getAccountInfo(new PublicKey(pda), "confirmed");
    return account ? getSubscriptionAuthorityDecoder().decode(account.data) : undefined;
  }

  private async fetchRecurringDelegation(pda: string) {
    const account = await this.connection.getAccountInfo(new PublicKey(pda), "confirmed");
    if (!account) throw new Error(`Recurring delegation ${pda} does not exist`);
    return getRecurringDelegationDecoder().decode(account.data);
  }
}

export function tokenAmountToBaseUnits(amount: string, decimals: number): bigint {
  const value = new Decimal(amount);
  if (!value.isFinite() || value.lte(0)) throw new Error("Token amount must be positive");
  const scaled = value.mul(new Decimal(10).pow(decimals));
  if (!scaled.isInteger()) throw new Error(`Token amount has more than ${decimals} decimal places`);
  return BigInt(scaled.toFixed(0));
}

export function baseUnitsToTokenAmount(amount: string | bigint, decimals: number): string {
  return new Decimal(amount.toString()).div(new Decimal(10).pow(decimals)).toFixed();
}

async function deriveSubscriptionAuthority(owner: string, mint: string): Promise<string> {
  const [pda] = await findSubscriptionAuthorityPda({ user: address(owner), tokenMint: address(mint) });
  return pda;
}

async function deriveRecurringDelegation(input: {
  subscriptionAuthority: string;
  delegator: string;
  delegatee: string;
  nonce: bigint;
}): Promise<string> {
  const [pda] = await findRecurringDelegationPda({
    subscriptionAuthority: address(input.subscriptionAuthority),
    delegator: address(input.delegator),
    delegatee: address(input.delegatee),
    nonce: input.nonce,
  });
  return pda;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Mandate request is missing ${name}`);
  return value;
}
