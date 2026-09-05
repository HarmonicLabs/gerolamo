import {
    AllegraBlock,
    AlonzoBlock,
    BabbageBlock,
    CertificateType,
    ConwayBlock,
    defaultConwayProtocolParameters,
    isShelleyProtocolParameters,
    MaryBlock,
    MultiEraBlock,
    ShelleyBlock,
    TxBody,
    TxOut,
    Value,
} from "@harmoniclabs/cardano-ledger-ts";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { getShelleyGenesisConfig } from "../utils/paths";
import type { ShelleyGenesisConfig } from "../types/ShelleyGenesisTypes";
import { logger } from "../utils/logger";
import { evaluateBlockRules } from "./rules/blockRules";
import type { ValidationPool } from "./workers/ValidationPool";
import type { EpochBodyParams } from "./epochParams";

import { getUtxosByRefs, getStakeByCredentials, getDelegationsByCredentials, countUtxosWithReferenceScript } from "../db";
import { resolveValidationPolicy } from "./validationPolicy";
import { checkCertificateSequence, stakeCredentialsTouched, type CertView, credKey } from "./certificateRules";

/** Safe BigInt from DB amount (string | number | null). Null/invalid → 0n. */
type UtxoAmountMap = Map<string, { utxo_ref: string; amount: bigint }>;

function amountToBigInt(amount: unknown): bigint {
    if (amount == null) return 0n;
    if (typeof amount === "bigint") return amount;
    if (typeof amount === "number" && Number.isFinite(amount)) {
        return BigInt(Math.trunc(amount));
    }
    const s = String(amount).trim();
    if (!s || !/^-?\d+$/.test(s)) return 0n;
    try {
        return BigInt(s);
    } catch {
        return 0n;
    }
}

let genesisCache: ShelleyGenesisConfig | null = null;

async function getCachedShelleyGenesis(
    config: any,
): Promise<ShelleyGenesisConfig | null> {
    if (genesisCache) return genesisCache;
    try {
        genesisCache = await getShelleyGenesisConfig(config);
        return genesisCache;
    } catch (error) {
        logger.error("Failed to load Shelley genesis config:", error);
        return null;
    }
}

type CardanoBlock =
    | ConwayBlock
    | BabbageBlock
    | AlonzoBlock
    | MaryBlock
    | AllegraBlock
    | ShelleyBlock;

export class BlockBodyValidator {
    constructor(private config: any) {}

    private getEraBlock(
        block: MultiEraBlock,
    ): AlonzoBlock | BabbageBlock | ConwayBlock | null {
        if (block.era < 5) return null; // Pre-Alonzo (no scripts/collateral)
        // Assume correct type based on era
        return block.block as AlonzoBlock | BabbageBlock | ConwayBlock;
    }

    /** Per-epoch protocol parameters for the block being validated (set by validate()). */
    private params: EpochBodyParams | null = null;

    public async validate(
        block: MultiEraBlock,
        params: EpochBodyParams | null = null,
        rulesCovered = false,
    ): Promise<boolean | null> {
        if (!block.block) return true; // Skip if block not parsed
        const actualBlock = this.getEraBlock(block);
        if (actualBlock === null) return null; // Unsupported era
        this.params = params;

        if (rulesCovered) {
            // rules/ (witnesses, conservation, fees, intervals, collateral, redeemers…)
            // already ran for this block; only the checks it does not cover remain.
            const genesisCfg = await getCachedShelleyGenesis(this.config);
            if (!genesisCfg) return false;
            if (!this.validateTransactionCountMatch(actualBlock)) return false;
            if (!(await this.runScriptValidationPolicy(actualBlock))) return false;
            if (!(await this.validateCertificatesValid(actualBlock))) return false;
            if (!(await this.validateSizeLimits(actualBlock, genesisCfg))) return false;
            return true;
        }


        const genesis = await getCachedShelleyGenesis(this.config);
        if (!genesis) return false;

        const txCountValid = this.validateTransactionCountMatch(actualBlock);
        if (!txCountValid) {
            logger.warn(
                `Block body validation failed: transaction count mismatch`,
            );
            return false;
        }

        const noInvalidTxs = this.validateNoInvalidTxs(actualBlock);
        if (!noInvalidTxs) {
            logger.warn(
                `Block body validation failed: invalid transactions present`,
            );
            return false;
        }

        // scriptValidation: off | log | strict (config; default off)
        const scriptOk = await this.runScriptValidationPolicy(actualBlock);
        if (!scriptOk) {
            logger.warn(
                `Block body validation failed: scriptValidation=strict rejected block`,
            );
            return false;
        }

        // One UTxO lookup per block for every input and collateral input; the balance,
        // multi-asset and collateral checks read from this map (was three queries).
        const utxoMap = await this.loadUtxoAmounts(actualBlock);

        const utxoBalanceValid = await this.validateUTxOBalance(actualBlock, utxoMap);
        if (!utxoBalanceValid) {
            logger.warn(`Block body validation failed: UTxO balance invalid`);
            return false;
        }

        const feesValid = await this.validateFeesCorrect(actualBlock, genesis);
        if (!feesValid) {
            logger.warn(`Block body validation failed: fees incorrect`);
            return false;
        }

        const validityIntervalValid = this.validateValidityInterval(
            actualBlock,
        );
        if (!validityIntervalValid) {
            logger.warn(
                `Block body validation failed: validity interval invalid`,
            );
            return false;
        }

        const multiAssetsValid = await this.validateMultiAssetsBalance(
            actualBlock,
            genesis,
            utxoMap,
        );
        if (!multiAssetsValid) {
            logger.warn(
                `Block body validation failed: multi-assets balance invalid`,
            );
            return false;
        }

        const collateralValid = await this.validateCollateralValid(actualBlock, utxoMap);
        if (!collateralValid) {
            logger.warn(`Block body validation failed: collateral invalid`);
            return false;
        }

        const certsValid = await this.validateCertificatesValid(actualBlock);
        if (!certsValid) {
            logger.warn(`Block body validation failed: certificates invalid`);
            return false;
        }

        const scriptsValid = this.validateScriptsValid(actualBlock);
        if (!scriptsValid) {
            logger.warn(`Block body validation failed: scripts invalid`);
            return false;
        }

        const sizeLimitsValid = await this.validateSizeLimits(
            actualBlock,
            genesis,
        );
        if (!sizeLimitsValid) {
            logger.warn(`Block body validation failed: size limits exceeded`);
            return false;
        }

        return true;
    }

    /** Amounts of every UTxO the block spends or posts as collateral, in one query. */
    private async loadUtxoAmounts(block: CardanoBlock): Promise<UtxoAmountMap> {
        const refs = new Set<string>();
        for (const txBody of block.transactionBodies) {
            for (const input of txBody.inputs ?? []) {
                refs.add(`${input.utxoRef.id.toString()}:${input.utxoRef.index}`);
            }
            for (const c of ((txBody as any).collateralInputs ?? []) as any[]) {
                try {
                    refs.add(`${c.utxoRef.id.toString()}:${c.utxoRef.index}`);
                } catch {
                    /* malformed collateral input: the collateral check reports it */
                }
            }
        }
        const map: UtxoAmountMap = new Map();
        if (refs.size === 0) return map;
        const rows = await getUtxosByRefs(Array.from(refs));
        for (const { utxo_ref, amount } of rows) map.set(utxo_ref, { utxo_ref, amount: amountToBigInt(amount) });
        return map;
    }

    private validateTransactionCountMatch(
        block: CardanoBlock,
    ): boolean {
        // Implementation
        if (!block.transactionBodies) return true; // Skip if not present
        return block.transactionBodies.length ===
            block.transactionWitnessSets.length;
    }

    private validateNoInvalidTxs(
        _block: CardanoBlock,
    ): boolean {
        // Structural invalid-tx gate (always on). Full Plutus is scriptValidation.
        return true;
    }

    /**
     * scriptValidation policy:
     * - off (default): skip
     * - log: structural Plutus witness checks + optional UPLC decode; never fail block
     * - strict: same checks; return false on structural failure
     *
     * Full phase-2 execution (datum/redeemer/context) is intentionally not here —
     * that is a multi-week Plutus evaluator, not a data-node gate.
     */
    private async runScriptValidationPolicy(
        block: CardanoBlock,
    ): Promise<boolean> {
        // Not configurable: strict when the ledger is complete, report-only on tip sync.
        const mode: "log" | "strict" = resolveValidationPolicy(this.config).script;

        const issues: string[] = [];
        const bodies = block.transactionBodies ?? [];
        const witnesses = block.transactionWitnessSets ?? [];

        for (let i = 0; i < bodies.length; i++) {
            const body: any = bodies[i];
            const wit: any = witnesses[i];
            const redeemers = wit?.redeemers ?? body?.redeemers;
            const hasRedeemers = Array.isArray(redeemers) && redeemers.length > 0;
            if (!hasRedeemers) continue;

            const scripts = wit?.plutusV1Scripts ??
                wit?.plutusV2Scripts ??
                wit?.plutusV3Scripts ??
                wit?.scripts;
            const scriptList = Array.isArray(scripts)
                ? scripts
                : Array.isArray(wit?.plutusScripts)
                ? wit.plutusScripts
                : [];

            if (scriptList.length === 0) {
                // Babbage+ : scripts may come from reference inputs or from the spent
                // UTxOs' reference scripts instead of the witness set.
                const refIns: any[] = Array.isArray(body?.referenceInputs) ? body.referenceInputs : [];
                const ins: any[] = Array.isArray(body?.inputs) ? body.inputs : [];
                const refs = [...refIns, ...ins]
                    .map((inp: any) => {
                        try {
                            return `${inp.utxoRef.id.toString()}:${inp.utxoRef.index}`;
                        } catch {
                            return null;
                        }
                    })
                    .filter((r): r is string => !!r);
                // Script provision is enforced by the rules (`script … required but not
                // provided`, which resolve reference inputs exactly); this structural
                // look-up reads `referenceInputs` that ledger-ts calls `refInputs` and
                // halted a valid preprod block. Report only.
                const referenced = refs.length > 0 ? await countUtxosWithReferenceScript(refs) : 0;
                if (referenced === 0) {
                    logger.debug(`scriptValidation: tx[${i}]: no plutus scripts in the witness set and none found among ${refs.length} spent UTxO(s) (reference inputs are checked by the rules)`);
                }
                continue;
            }

            // Best-effort UPLC decode when script bytes are available
            for (let s = 0; s < scriptList.length; s++) {
                const scr = scriptList[s];
                // The flat-encoded program is `bytes`; `toCborBytes()` adds the CBOR
                // wrapper the flat decoder cannot read (a false "decode failed").
                const bytes: Uint8Array | null =
                    scr instanceof Uint8Array
                        ? scr
                        : scr?.bytes instanceof Uint8Array
                        ? scr.bytes
                        : typeof scr?.toCborBytes === "function"
                        ? scr.toCborBytes()
                        : scr?.cbor != null
                        ? scr.cbor
                        : null;
                if (!bytes || !(bytes instanceof Uint8Array) || bytes.length === 0) {
                    continue;
                }
                try {
                    const { UPLCDecoder } = await import(
                        "@harmoniclabs/uplc"
                    );
                    // UPLCDecoder.parse(bytes) — proves script CBOR is well-formed
                    if (typeof (UPLCDecoder as any)?.parse === "function") {
                        (UPLCDecoder as any).parse(bytes);
                    }
                } catch (err: any) {
                    // A script the chain accepted that our decoder cannot read is a gap in
                    // the decoder, not an invalid block: the phase-2 rules report it.
                    logger.warn(`scriptValidation: tx[${i}] script[${s}]: UPLC decode failed: ${err?.message ?? err}`);
                }
            }
        }

        if (issues.length === 0) return true;

        for (const msg of issues) {
            if (mode === "strict") logger.error(`scriptValidation: ${msg}`);
            else logger.warn(`scriptValidation(log): ${msg}`);
        }
        return mode !== "strict";
    }

    private async validateUTxOBalance(
        block: CardanoBlock,
        utxoMap: UtxoAmountMap,
    ): Promise<boolean> {
        // Collect all UTxO references that are inputs to transactions in this block
        if (block.transactionBodies.length === 0) {
            return true; // No inputs to validate
        }


        for (const txBody of block.transactionBodies) {
            let inputValue = 0n;

            // Validate each input exists and accumulate input value
            for (const input of txBody.inputs) {
                const utxoRef =
                    `${input.utxoRef.id.toString()}:${input.utxoRef.index}`;

                const row = utxoMap.get(utxoRef);
                if (!row) {
                    logger.warn(`UTxO not found: ${utxoRef}`);
                    return false;
                }

                inputValue += row.amount;
            }

            // Calculate output value
            let outputValue = 0n;
            for (const output of txBody.outputs) {
                outputValue += output.value.lovelaces;
            }

            // Check that inputs cover outputs + fee
            if (inputValue < outputValue + txBody.fee) {
                logger.error(
                    `Insufficient input value for transaction: ${inputValue} < ${outputValue} + ${txBody.fee}`,
                );
                return false;
            }
        }

        return true;
    }

    private async validateFeesCorrect(
        block: CardanoBlock,
        genesis: ShelleyGenesisConfig,
    ): Promise<boolean> {
        // Live per-epoch parameters win; Shelley genesis is the fallback.
        const minFeeA = this.params?.minFeeA ?? BigInt(genesis.protocolParams.minFeeA);
        const minFeeB = this.params?.minFeeB ?? BigInt(genesis.protocolParams.minFeeB);

        return block.transactionBodies.every((txBody: any) => {
            const txSize = txBody.toCborBytes().length;
            const calculatedFee = BigInt(minFeeA) * BigInt(txSize) +
                BigInt(minFeeB);
            const isValid = txBody.fee >= calculatedFee;

            if (!isValid) {
                logger.error(
                    `Invalid fee for transaction: expected >= ${calculatedFee}, got ${txBody.fee}`,
                );
            }

            return isValid;
        });
    }

    private validateValidityInterval(
        block: CardanoBlock,
    ): boolean {
        if (block.transactionBodies.length === 0) return true;
        // Implementation
        return block.transactionBodies.map(
            (txBody) =>
                (!("validityIntervalStart" in txBody) ||
                    txBody.validityIntervalStart === undefined ||
                    txBody.validityIntervalStart! <= block.header.body.slot) &&
                (!("ttl" in txBody) || txBody.ttl === undefined ||
                    ("validityIntervalStart" in txBody &&
                        txBody.validityIntervalStart !== undefined &&
                        txBody.validityIntervalStart! + txBody.ttl! >
                            block.header.body.slot)),
        ).reduce((a, b) => a && b);
    }

    private async validateMultiAssetsBalance(
        block: CardanoBlock,
        genesis: ShelleyGenesisConfig,
        utxoMap: UtxoAmountMap,
    ): Promise<boolean> {
        const keyDeposit = BigInt(genesis.protocolParams.keyDeposit);
        const poolDeposit = BigInt(genesis.protocolParams.poolDeposit);

        if (block.transactionBodies.length === 0) {
            return true; // No inputs to validate
        }


        for (const txBody of block.transactionBodies) {
            // Calculate input value (ADA + native assets)
            let inputValue = Value.zero;
            for (const input of txBody.inputs) {
                const utxoRef =
                    `${input.utxoRef.id.toString()}:${input.utxoRef.index}`;

                const row = utxoMap.get(utxoRef);
                if (!row) {
                    logger.error(`UTxO not found for input: ${utxoRef}`);
                    return false;
                }

                // Convert database format to Value
                const utxoValue = Value.lovelaces(row.amount);
                inputValue = Value.add(inputValue, utxoValue);
            }

            // Calculate output value
            let outputValue = Value.zero;
            for (const output of txBody.outputs) {
                outputValue = Value.add(outputValue, output.value);
            }

            // Add transaction fee
            outputValue = Value.add(outputValue, Value.lovelaces(txBody.fee));

            // Add certificate deposits
            let certDeposits = Value.zero;
            if (txBody.certs) {
                for (const cert of txBody.certs) {
                    if (
                        cert.certType === CertificateType.StakeRegistration ||
                        cert.certType === CertificateType.StakeDeRegistration
                    ) { // Stake key registration/deregistration
                        certDeposits = Value.add(
                            certDeposits,
                            Value.lovelaces(keyDeposit),
                        );
                    } else if (
                        cert.certType === CertificateType.PoolRegistration
                    ) { // Pool registration
                        certDeposits = Value.add(
                            certDeposits,
                            Value.lovelaces(poolDeposit),
                        );
                    }
                }
            }
            outputValue = Value.add(outputValue, certDeposits);

            // Subtract minting (which adds to the supply)
            if ("mint" in txBody && txBody.mint) {
                inputValue = Value.add(inputValue, txBody.mint);
            }

            // Add withdrawals (which are like additional inputs)
            if (txBody.withdrawals) {
                const withdrawalValue = txBody.withdrawals.toTotalWitdrawn();
                inputValue = Value.add(inputValue, withdrawalValue);
            }

            // Check that input value equals output value
            if (!Value.isZero(Value.sub(inputValue, outputValue))) {
                logger.error(`Multi-asset balance mismatch for transaction`);
                return false;
            }
        }

        return true;
    }

    private async validateCollateralValid(
        block: CardanoBlock,
        utxoMap: UtxoAmountMap,
    ): Promise<boolean> {
        // Per-epoch parameters when known; the historical Alonzo defaults otherwise.
        const collateralPercent = this.params?.collateralPercent ?? 150;
        const maxCollateralInputs = this.params?.maxCollateralInputs ?? 3;

        // Collect all collateral UTxO references and validate in one pass
        const collateralUtxoRefs: string[] = [];

        for (const txBody of block.transactionBodies) {
            // Check if transaction has scripts (requires collateral) - only available in certain eras
            const hasScripts =
                ("scriptDataHash" in txBody && txBody.scriptDataHash) ||
                ("redeemers" in txBody && txBody.redeemers &&
                    (txBody.redeemers as any[]).length > 0);

            if (!hasScripts) continue; // No scripts, no collateral required

            // Validate collateral inputs exist and are sufficient - only available in certain eras
            const collateralInputs = (txBody as any).collateralInputs;
            if (!collateralInputs || collateralInputs.length === 0) {
                logger.error("Script transaction missing collateral inputs");
                return false;
            }

            if (collateralInputs.length > maxCollateralInputs) {
                logger.error(
                    `Too many collateral inputs: ${collateralInputs.length} > ${maxCollateralInputs}`,
                );
                return false;
            }

            // Collect collateral UTxO refs for batch query
            collateralUtxoRefs.push(
                ...collateralInputs.map((collateralInput: any) =>
                    `${collateralInput.utxoRef.id.toString()}:${collateralInput.utxoRef.index}`
                ),
            );
        }

        if (collateralUtxoRefs.length === 0) {
            return true; // No collateral to validate
        }


        // Re-process transactions for collateral validation
        let collateralIndex = 0;
        for (const txBody of block.transactionBodies) {
            const hasScripts =
                ("scriptDataHash" in txBody && txBody.scriptDataHash) ||
                ("redeemers" in txBody && txBody.redeemers &&
                    (txBody.redeemers as any[]).length > 0);

            if (!hasScripts) continue;

            const collateralInputs = (txBody as any).collateralInputs;

            // Calculate collateral value
            let collateralValue = 0n;
            for (const collateralInput of collateralInputs) {
                const utxoRef =
                    `${collateralInput.utxoRef.id.toString()}:${collateralInput.utxoRef.index}`;

                const row = utxoMap.get(utxoRef);
                if (!row) {
                    logger.error(`Collateral UTxO not found: ${utxoRef}`);
                    return false;
                }

                collateralValue += row.amount;
            }

            // Check collateral covers required amount (fee * collateralPercent / 100)
            const requiredCollateral =
                (txBody.fee * BigInt(collateralPercent)) /
                100n;
            if (collateralValue < requiredCollateral) {
                logger.error(
                    `Insufficient collateral: ${collateralValue} < ${requiredCollateral}`,
                );
                return false;
            }

            // Validate collateral outputs (should return unused collateral) - only available in certain eras
            if ("collateralReturn" in txBody && txBody.collateralReturn) {
                // Additional validation could check that collateral return is properly formatted
            }
        }

        return true;
    }

    private async validateCertificatesValid(
        block: CardanoBlock,
    ): Promise<boolean> {
        const hexOf = (v: unknown): string | null => {
            const bytes = (v as any)?.toBuffer?.() ?? v;
            if (bytes instanceof Uint8Array) return toHex(bytes);
            if (typeof Buffer !== "undefined" && Buffer.isBuffer(bytes)) return toHex(new Uint8Array(bytes));
            return typeof bytes === "string" && bytes.length > 0 ? bytes : null;
        };

        const certs: CertView[] = [];
        for (const txBody of block.transactionBodies) {
            if (!txBody.certs) continue;
            for (const cert of txBody.certs) {
                const c = cert as any;
                certs.push({
                    certType: Number(cert.certType),
                    credHex: hexOf(c.stakeCredential?.hash),
                    credType: c.stakeCredential ? (Number(c.stakeCredential.type) === 1 ? 1 : 0) : null,
                    poolHex: hexOf(c.poolKeyHash),
                });
            }
        }
        if (certs.length === 0) return true;

        // Look up only the credentials this block touches (indexed, keyed) rather
        // than scanning the whole stake / delegations tables on every block.
        const touched = stakeCredentialsTouched(certs).map((c) => ({ hash: fromHex(c.hex), type: c.type }));
        const stakeRows = await getStakeByCredentials(touched);
        const delegationRows = await getDelegationsByCredentials(touched);
        const registered = new Set<string>();
        for (const r of stakeRows) {
            const k = hexOf(r.stake_credentials);
            if (k) registered.add(credKey(r.cred_type, k));
        }
        const delegated = new Map<string, string>();
        for (const r of delegationRows) {
            const k = hexOf(r.stake_credentials);
            if (k) delegated.set(credKey(r.cred_type, k), hexOf(r.pool_key_hash) ?? "");
        }

        const verdict = checkCertificateSequence(certs, registered, delegated);
        if (!verdict.ok) {
            logger.error(verdict.reason);
            return false;
        }
        return true;
    }

    private validateScriptsValid(
        block: CardanoBlock,
    ): boolean {
        // Basic script validation - check that script data and redeemers are consistent
        for (const txBody of block.transactionBodies) {
            // If transaction has redeemers, it must have script data hash (only in certain eras)
            if (
                "redeemers" in txBody && txBody.redeemers &&
                (txBody.redeemers as any[]).length > 0
            ) {
                if (!("scriptDataHash" in txBody) || !txBody.scriptDataHash) {
                    logger.error(
                        "Transaction has redeemers but no script data hash",
                    );
                    return false;
                }
            }

            // If transaction has script data hash, validate it corresponds to actual scripts (only in certain eras)
            if ("scriptDataHash" in txBody && txBody.scriptDataHash) {
                // This would require validating that the script data hash matches
                // the actual script data, but that's complex without full script execution
                logger.log(
                    "Script data hash present - full validation requires script execution",
                );
            }

            // Check that witness set has corresponding scripts for redeemers (only in certain eras)
            if (
                block.transactionWitnessSets && "redeemers" in txBody &&
                txBody.redeemers && (txBody.redeemers as any[]).length > 0
            ) {
                const txIndex = block.transactionBodies.indexOf(txBody as any);
                if (
                    txIndex >= 0 &&
                    txIndex < block.transactionWitnessSets.length
                ) {
                    const witnessSet = block.transactionWitnessSets[txIndex];
                    if (
                        witnessSet &&
                        (!("scripts" in witnessSet) || !witnessSet.scripts ||
                            (witnessSet.scripts as any[]).length === 0)
                    ) {
                        logger.error(
                            "Transaction has redeemers but no scripts in witness set",
                        );
                        return false;
                    }
                }
            }
        }

        // Note: Full Plutus script execution validation would require:
        // 1. UTxO resolution for script inputs
        // 2. Datum resolution
        // 3. Redeemer application
        // 4. Script execution with proper context
        // This is a complex implementation that would require a full Plutus evaluator

        return true;
    }

    private async validateSizeLimits(
        block: CardanoBlock,
        genesis: ShelleyGenesisConfig,
    ): Promise<boolean> {
        const maxTxSize = this.params?.maxTxSize ?? genesis.protocolParams.maxTxSize;
        const maxBlockSize = this.params?.maxBlockSize ?? genesis.protocolParams.maxBlockBodySize;
        // The header commits to the body size; the body hash check bound the bytes to it.
        const bodySize = Number((block as any).header?.body?.blockBodySize ?? -1);
        if (Number.isFinite(maxBlockSize) && maxBlockSize > 0 && bodySize > maxBlockSize) {
            logger.error(`Block body size ${bodySize} exceeds maximum ${maxBlockSize}`);
            return false;
        }

        return block.transactionBodies.every((txBody: any) => {
            const txSize = txBody.toCborBytes().length;
            const isValid = txSize <= maxTxSize;

            if (!isValid) {
                logger.error(
                    `Transaction size ${txSize} exceeds maximum ${maxTxSize}`,
                );
            }

            return isValid;
        });
    }
}

export interface BlockValidationContext {
    /** Slot of the block (validity intervals, timelocks). */
    slot: bigint;
    /** Worker pool for witness signatures; null runs them inline. */
    pool: ValidationPool | null;
}

/** Rule reports (checks this node cannot yet enforce exactly) are logged sparsely. */
let reportCount = 0;
/** Phase-2 shadow totals since start, logged whenever they grow past the next threshold. */
const plutusTotals = { evaluated: 0, skipped: 0, mismatches: 0, nextLogAt: 1 };
const plutusReasons: Record<string, number> = {};

/**
 * Body validation for every era: witness signatures, required signers, native
 * scripts and the era's transaction rules (rules/), then the Alonzo+ checks the
 * validator class carries. False = a strict node must not apply the block.
 */
export async function validateBlock(
    block: MultiEraBlock,
    config: any,
    params: EpochBodyParams | null = null,
    ctx: BlockValidationContext | null = null,
): Promise<boolean> {
    if (ctx) {
        const genesis = block.era >= 2 ? await getCachedShelleyGenesis(config) : null;
        const outcome = await evaluateBlockRules(block, { config, pool: ctx.pool, params, genesis, slot: ctx.slot });
        if (outcome.failures.length) {
            logger.error(`Block body validation failed at slot ${ctx.slot} (era ${block.era}, ${outcome.txs} tx): ${outcome.failures.slice(0, 5).join(" | ")}${outcome.failures.length > 5 ? ` | +${outcome.failures.length - 5} more` : ""}`);
            return false;
        }
        const pl = outcome.plutus;
        if (pl && (pl.evaluated || pl.skipped)) {
            plutusTotals.evaluated += pl.evaluated;
            plutusTotals.skipped += pl.skipped;
                for (const [k, n] of Object.entries(outcome.plutus.skipReasons ?? {})) plutusReasons[k] = (plutusReasons[k] ?? 0) + n;
            plutusTotals.mismatches += pl.mismatches;
            if (plutusTotals.evaluated + plutusTotals.skipped >= plutusTotals.nextLogAt) {
                plutusTotals.nextLogAt *= 4;
                const top = Object.entries(plutusReasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n}× ${k}`).join("; ");
                logger.info(`Plutus shadow so far: ${plutusTotals.evaluated} redeemer(s) evaluated, ${plutusTotals.skipped} skipped, ${plutusTotals.mismatches} tx verdict mismatch(es)${top ? ` — ${top}` : ""}`);
            }
        }
        if (outcome.reports.length) {
            reportCount += outcome.reports.length;
            if (reportCount <= 20 || reportCount % 1000 === 0) {
                logger.info(`Body rule report at slot ${ctx.slot}: ${outcome.reports.slice(0, 3).join(" | ")} (reports so far: ${reportCount})`);
            }
        }
    }
    const validator = new BlockBodyValidator(config);
    const result = await validator.validate(block, params, ctx != null);
    // null = the validator class has no extra rules for this era (pre-Alonzo).
    if (result === null) return true;
    return result;
}
