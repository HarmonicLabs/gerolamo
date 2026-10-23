# Dingo 0.81.0 as the LocalStateQuery reference (preview, 2026-10-10)

Server relay (Gerolamo, 64/64 byte-identical with cardano-node) against Dingo 0.81.0 on the same host, `scripts/n2c-compare.ts` with the reopen-on-close handling added the same day. Dingo closes the N2C connection on a query it does not support.

```
SAME  GetSystemStart                               ours 8 B, ref 8 B
SAME  GetChainBlockNo                              ours 7 B, ref 7 B
SAME  GetChainPoint                                ours 40 B, ref 40 B
SAME  GetCurrentEra                                ours 1 B, ref 1 B
DIFF  GetInterpreter                               ours 268 B, ref 146 B first difference at byte 7: ours …9f83830000008
ERR   GetEraStart(Conway)                          not supported by the reference (it closed the connection)
ERR   GetEraStart(Babbage)                         not supported by the reference (it closed the connection)
SAME  [0] GetLedgerTip                             ours 41 B, ref 41 B
SAME  [1] GetEpochNo                               ours 4 B, ref 4 B
ERR   [2] GetNonMyopicMemberRewards({})            not supported by the reference (it closed the connection)
DIFF  [3] GetCurrentPParams                        ours 2994 B, ref 2997 B first difference at byte 65: ours …868c01910d
SAME  [4] GetProposedPParamsUpdates                ours 2 B, ref 2 B
ERR   [5] GetStakeDistribution                     not supported by the reference (it closed the connection)
ERR   [6] GetUTxOByAddress(owner)                  not supported by the reference (it closed the connection)
SAME  [9] GetCBOR(GetEpochNo)                      ours 7 B, ref 7 B
SAME  [9] GetCBOR(DebugChainDepState)              ours 15833 B, ref 15833 B
SAME  [10] GetFilteredDelegationsAndRewardAccounts ours 103 B, ref 103 B
DIFF  [11] GetGenesisConfig                        ours 784 B, ref 785 B first difference at byte 1: ours …818f831907e61
SAME  [13] DebugChainDepState                      ours 15828 B, ref 15828 B
ERR   [14] GetRewardProvenance                     not supported by the reference (it closed the connection)
SAME  [16] GetStakePools                           ours 21817 B, ref 21817 B
SAME  [17] GetStakePoolParams(pools)               ours 292 B, ref 292 B
ERR   [19] GetPoolState(all)                       not supported by the reference (it closed the connection)
ERR   [19] GetPoolState(pools)                     not supported by the reference (it closed the connection)
DIFF  [20] GetStakeSnapshots(all)                  ours 36743 B, ref 36744 B first difference at byte 2: ours …8184bf581
SAME  [20] GetStakeSnapshots(pools)                ours 88 B, ref 88 B
ERR   [21] GetPoolDistr(all)                       not supported by the reference (it closed the connection)
ERR   [21] GetPoolDistr(pools)                     not supported by the reference (it closed the connection)
SAME  [22] GetStakeDelegDeposits                   ours 39 B, ref 39 B
ERR   [23] GetConstitution                         not supported by the reference (it closed the connection)
ERR   [24] GetGovState                             not supported by the reference (it closed the connection)
DIFF  [25] GetDRepState(all)                       ours 1273179 B, ref 1273180 B first difference at byte 1: ours …81bf8
SAME  [25] GetDRepState(some)                      ours 469 B, ref 469 B
ERR   [26] GetDRepStakeDistr(all)                  not supported by the reference (it closed the connection)
ERR   [26] GetDRepStakeDistr(some)                 not supported by the reference (it closed the connection)
ERR   [27] GetCommitteeMembersState(all)           not supported by the reference (it closed the connection)
ERR   [27] GetCommitteeMembersState(cold)          not supported by the reference (it closed the connection)
ERR   [27] GetCommitteeMembersState(hot)           not supported by the reference (it closed the connection)
ERR   [27] GetCommitteeMembersState(active)        not supported by the reference (it closed the connection)
ERR   [27] GetCommitteeMembersState(expired)       not supported by the reference (it closed the connection)
DIFF  [28] GetFilteredVoteDelegatees(all)          ours 2779691 B, ref 2 B first difference at byte 1: ours …81bf8201581
SAME  [28] GetFilteredVoteDelegatees(some)         ours 2 B, ref 2 B
SAME  [29] GetAccountState                         ours 20 B, ref 20 B
ERR   [30] GetSPOStakeDistr(all)                   not supported by the reference (it closed the connection)
ERR   [30] GetSPOStakeDistr(pools)                 not supported by the reference (it closed the connection)
DIFF  [31] GetProposals(all)                       ours 8938 B, ref 7641 B first difference at byte 1: ours …819f8782582
DIFF  [31] GetProposals(some)                      ours 2 B, ref 520 B first difference at byte 1: ours …8180 ref …81828
ERR   [32] GetRatifyState                          not supported by the reference (it closed the connection)
ERR   [33] GetFuturePParams                        not supported by the reference (it closed the connection)
ERR   [34] GetLedgerPeerSnapshot(all)              not supported by the reference (it closed the connection)
ERR   [34] GetLedgerPeerSnapshot(big)              not supported by the reference (it closed the connection)
DIFF  [34] GetLedgerPeerSnapshot(legacy)           ours 5267 B, ref 5390 B first difference at byte 0: ours …81820182820
ERR   [35] QueryStakePoolDefaultVote               not supported by the reference (it closed the connection)
DIFF  [36] GetPoolDistr2(all)                      ours 62760 B, ref 60275 B first difference at byte 0: ours …8182bf581
DIFF  [36] GetPoolDistr2(pools)                    ours 107 B, ref 106 B first difference at byte 0: ours …8182a1581c8df
ERR   [37] GetStakeDistribution2                   not supported by the reference (it closed the connection)
ERR   [38] GetMaxMajorProtocolVersion              not supported by the reference (it closed the connection)
ERR   [39] GetDRepDelegations(all)                 not supported by the reference (it closed the connection)
ERR   [39] GetDRepDelegations(some)                not supported by the reference (it closed the connection)
DIFF  wrong era: GetEpochNo(Babbage)               ours 20 B, ref 4 B first difference at byte 0: ours …8282056742616262
DIFF  wrong era: GetStakePools(Babbage)            ours 20 B, ref 21817 B first difference at byte 0: ours …828205674261
ERR   DebugLedgerConfig                            not supported by the reference (it closed the connection)
ERR   [2] GetNonMyopicMemberRewards(stakes, credentials) not supported by the reference (it closed the connection)
ERR   [18] GetRewardInfoPools                      not supported by the reference (it closed the connection)
18 of 64 byte-identical; different: GetInterpreter, [3] GetCurrentPParams, [11] GetGenesisConfig, [20] GetStakeSnapshots
DIFF  acquire an unknown block below the immutable tip ours: PointTooOld; ref: PointNotOnChain
SAME  acquire an unknown block in the volatile window ours: PointNotOnChain; ref: PointNotOnChain
SAME  acquire origin                               ours: PointTooOld; ref: PointTooOld
SAME  unknown BlockQuery tag 40                    ours: connection closed; ref: connection closed
SAME  GetConstitution in Babbage (Conway-only)     ours: connection closed; ref: connection closed
SAME  GetStakePools with an argument               ours: connection closed; ref: connection closed
SAME  acquire the immutable tip                    ours: acquired; ref: acquired
```
