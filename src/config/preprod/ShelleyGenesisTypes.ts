// Interface for Cardano Shelley genesis configuration, used for initializing Gerolamo's ledger state and consensus parameters.
// Based on Shelley genesis JSON (Ledger Spec §5.2, Protocol Parameters) and used in PeerManager.ts for syncFromGenesis.

export interface ShelleyProtocolVersion {
    minor: number; // Minor protocol version (Ledger Spec §10)
    major: number; // Major protocol version
}

export interface ShelleyExtraEntropy {
    tag: string; // e.g., "NeutralNonce" (Ledger Spec §5.2, Randomness)
}

export interface ShelleyProtocolParams {
    protocolVersion: ShelleyProtocolVersion; // Current protocol version (Ledger Spec §10)
    decentralisationParam: number; // Decentralization parameter, 0 to 1 (Shelley-specific, phased out in Babbage)
    eMax: number; // Maximum number of epochs for protocol updates (Ledger Spec §17.4.1)
    extraEntropy: ShelleyExtraEntropy; // Additional entropy for VRF (Ouroboros Praos §5.2.1)
    maxTxSize: number; // Maximum transaction size in bytes (Ledger Spec §8)
    maxBlockBodySize: number; // Maximum block body size in bytes (Ledger Spec §8)
    maxBlockHeaderSize: number; // Maximum block header size in bytes (Ledger Spec §8)
    minFeeA: number; // Linear fee coefficient (Ledger Spec §5.5)
    minFeeB: number; // Constant fee component (Ledger Spec §5.5)
    minUTxOValue: number; // Minimum UTxO value in lovelace (Ledger Spec §5.5)
    poolDeposit: number; // Deposit for stake pool registration (Ledger Spec §4.6)
    minPoolCost: number; // Minimum pool cost per epoch (Ledger Spec §4.6)
    keyDeposit: number; // Deposit for stake key registration (Ledger Spec §4.6)
    nOpt: number; // Target number of stake pools (Ledger Spec §5.2)
    rho: number; // Monetary expansion rate (Ledger Spec §5.6)
    tau: number; // Treasury growth rate (Ledger Spec §5.6)
    a0: number; // Pool influence factor (Ledger Spec §5.2)
}

export interface ShelleyGenesisConfig {
    activeSlotsCoeff: number; // Active slot coefficient (f), typically 0.05 (Ouroboros Praos §5.2.1)
    protocolParams: ShelleyProtocolParams; // Protocol parameters for ledger and consensus
    genDelegs: Record<string, unknown>; // Genesis delegation mapping (empty for testnet)
    updateQuorum: number; // Quorum for protocol updates (Ledger Spec §17.4.1)
    networkId: string; // Network identifier, e.g., "Testnet" or "Mainnet" (Network Spec §3.1)
    initialFunds: Record<string, unknown>; // Initial UTxO distribution (empty for testnet)
    maxLovelaceSupply: number; // Maximum ADA supply in lovelace (Ledger Spec §5.6)
    networkMagic: number; // Network magic number, e.g., 42 for testnet (Network Spec §3.1)
    epochLength: number; // Slots per epoch, e.g., 432000 (~5 days) (Ledger Spec §5.2)
    systemStart: string; // ISO 8601 timestamp of network start (Ledger Spec §5.2)
    slotsPerKESPeriod: number; // Slots per KES period, e.g., 129600 (~36 hours) (Ouroboros Praos §4.8.2)
    slotLength: number; // Slot duration in seconds, e.g., 1 for Babbage+ (Ledger Spec §5.2)
    maxKESEvolutions: number; // Maximum KES key evolutions, e.g., 62 (~90 days) (Ouroboros Praos §4.8.2)
    securityParam: number; // Security parameter (k), e.g., 108 for rollback protection (Ouroboros Praos §5.4)
}
