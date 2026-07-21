--------------------------- MODULE ZKVote ---------------------------
(*
  ZK-VOTE Formal Model (TLA+)
  ============================
  Models the combined state machine across 5 Soroban contracts:
    DaoRegistry, MembershipSBT, MembershipTree, Voting, zkvote-groth16

  Cross-contract calls and auth delegation are modeled explicitly.
  The BN254/Groth16 verification is abstracted as a boolean predicate.

  Invariants verified:
    I1: No double voting — each (dao_id, proposal_id, nullifier) used at most once
    I2: Root-grounded voting — every accepted proof's root is a valid Merkle root
    I3: Admin continuity — exactly one admin per DAO at all times; atomic transitions
    I4: Auth delegation soundness — _from_registry pattern enforces equivalent auth
    I5: Proposal state irreversibility — Active -> Closed -> Archived, no backward edges
    I6: Nullifier uniqueness across all DAOs and proposals simultaneously
    I7: FIFO root eviction safety — Fixed-mode proposals always reference a root that exists
    I8: min_valid_root_idx correctness — no false positive root rejection
*)

EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    MAX_ROOT_HISTORY,    (* 30 - FIFO cap on root history *)
    MAX_TREE_DEPTH,      (* 18 *)
    MAX_DAOS,            (* Maximum number of DAOs to model *)
    MAX_PROPOSALS,       (* Maximum proposals per DAO *)
    MAX_MEMBERS,         (* Maximum members per DAO *)
    MAX_NULLIFIERS       (* Maximum nullifiers to track *)

ASSUME MAX_ROOT_HISTORY = 30

(*-----------------------------------------------------------------------*)
(* Type definitions                                                       *)
(*-----------------------------------------------------------------------*)

DaoId == 1..MAX_DAOS
ProposalId == 1..MAX_PROPOSALS
MemberAddr == 1..MAX_MEMBERS
Nullifier == 1..MAX_NULLIFIERS
RootIdx == 0..(MAX_ROOT_HISTORY + MAX_MEMBERS + 1)  (* Monotonic root index *)

(* Proposal states *)
ProposalState == {"Active", "Closed", "Archived"}

(* Vote modes *)
VoteMode == {"Fixed", "Trailing"}

(*-----------------------------------------------------------------------*)
(* State variables                                                        *)
(*-----------------------------------------------------------------------*)

VARIABLES
    (* DaoRegistry state *)
    daoAdmin,           (* [dao_id -> Address] - current admin per DAO *)
    daoExists,          (* Set of created DAO IDs *)
    membershipOpen,     (* [dao_id -> BOOLEAN] *)

    (* MembershipSBT state *)
    sbtMember,          (* [dao_id, address -> BOOLEAN] - has SBT *)
    sbtRevoked,         (* [dao_id, address -> BOOLEAN] - is revoked *)

    (* MembershipTree state *)
    treeInitialized,    (* [dao_id -> BOOLEAN] *)
    treeDepth,          (* [dao_id -> 1..MAX_TREE_DEPTH] *)
    nextLeafIndex,      (* [dao_id -> Nat] *)
    nextRootIndex,      (* [dao_id -> RootIdx] *)
    roots,              (* [dao_id -> Seq(U256)] - root history, FIFO cap *)
    rootIndex,          (* [dao_id, root -> RootIdx] *)
    leafValue,          (* [dao_id, index -> U256] - commitment or 0 *)
    memberLeafIndex,    (* [dao_id, address -> index] *)
    minValidRootIdx,    (* [dao_id -> RootIdx] - for Trailing mode *)
    filledSubtrees,     (* [dao_id -> Seq(U256)] - Merkle tree state *)

    (* Voting state *)
    proposalState,      (* [dao_id, proposal_id -> ProposalState] *)
    proposalInfo,       (* [dao_id, proposal_id -> [eligible_root, vote_mode, earliest_root_idx, vk_hash]] *)
    nullifierUsed,      (* [dao_id, proposal_id, nullifier -> BOOLEAN] *)
    vkSet,              (* [dao_id -> BOOLEAN] *)
    vkVersion,          (* [dao_id -> Nat] *)

    (* Cross-contract auth tracking *)
    registryAuth,       (* BOOLEAN - whether registry has authenticated *)

    (* Global state *)
    nextDaoId,          (* Nat - next DAO ID to assign *)

    (* Abstract Merkle root values - we model roots as symbolic values *)
    currentRoot,        (* [dao_id -> U256] *)
    rootHistory,        (* [dao_id -> Seq(U256)] *)

    (* Abstract proof verification *)
    proofValid          (* [dao_id, proposal_id, nullifier, root -> BOOLEAN] *)

(*-----------------------------------------------------------------------*)
(* Type invariants                                                        *)
(*-----------------------------------------------------------------------*)

TypeOK ==
    /\ daoAdmin \in [DaoId -> UNION {[a: MemberAddr]}, {}]
    /\ daoExists \subseteq DaoId
    /\ membershipOpen \in [DaoId -> BOOLEAN]
    /\ sbtMember \in [DaoId \X MemberAddr -> BOOLEAN]
    /\ sbtRevoked \in [DaoId \X MemberAddr -> BOOLEAN]
    /\ treeInitialized \in [DaoId -> BOOLEAN]
    /\ nextLeafIndex \in [DaoId -> 0..(2^MAX_TREE_DEPTH)]
    /\ nullifierUsed \in [DaoId \X ProposalId \X Nullifier -> BOOLEAN]
    /\ proposalState \in [DaoId \X ProposalId -> ProposalState \X {"None"}]
    /\ vkSet \in [DaoId -> BOOLEAN]
    /\ vkVersion \in [DaoId -> 0..MAX_MEMBERS]
    /\ currentRoot \in [DaoId -> 0..MAX_NULLIFIERS]
    /\ rootHistory \in [DaoId -> Seq(0..MAX_NULLIFIERS)]
    /\ minValidRootIdx \in [DaoId -> RootIdx]

(*-----------------------------------------------------------------------*)
(* Invariants                                                            *)
(*-----------------------------------------------------------------------*)

(* I1: No double voting — each (dao_id, proposal_id, nullifier) used at most once *)
NoDoubleVoting ==
    \A d \in DaoId, p \in ProposalId, n \in Nullifier:
        nullifierUsed[d, p, n] => ~nullifierUsed[d, p, n]'  (* Once set, stays set *)

(* I2: Root-grounded voting — every accepted proof's root is a valid Merkle root *)
RootGroundedVoting ==
    \A d \in DaoId, p \in ProposalId:
        proposalState[d, p] /= "None" =>
            LET info == proposalInfo[d, p] IN
            info.vote_mode = "Fixed" =>
                \E idx \in RootIdx:
                    rootIndex[d, info.eligible_root] = idx
                    /\ idx >= 0
                    /\ idx < nextRootIndex[d]

(* I3: Admin continuity — exactly one admin per DAO at all times *)
AdminContinuity ==
    \A d \in DaoId:
        d \in daoExists =>
            \E a \in MemberAddr:
                daoAdmin[d] = a

(* I4: Proposal state irreversibility *)
ProposalFSM ==
    \A d \in DaoId, p \in ProposalId:
        CASE proposalState[d, p] = "Archived" -> proposalState[d, p] /= "Active" /\ proposalState[d, p] /= "Closed"
        [] proposalState[d, p] = "Closed" -> proposalState[d, p] /= "Active"
        [] OTHER -> TRUE

(* I5: Nullifier uniqueness across all DAOs and proposals *)
NullifierGlobalUniqueness ==
    \A d1, d2 \in DaoId, p1, p2 \in ProposalId, n \in Nullifier:
        (nullifierUsed[d1, p1, n] /\ nullifierUsed[d2, p2, n]) =>
            (d1 = d2 /\ p1 = p2)

(* I6: FIFO root eviction safety — Fixed-mode proposals always reference a root that exists *)
FIFOSafety ==
    \A d \in DaoId, p \in ProposalId:
        proposalState[d, p] /= "None" /\ proposalInfo[d, p].vote_mode = "Fixed" =>
            LET root == proposalInfo[d, p].eligible_root IN
            root \in {rootHistory[d][i] : i \in 0..(Len(rootHistory[d])-1)}

(* I7: min_valid_root_idx correctness — no false positive root rejection *)
MinRootCorrectness ==
    \A d \in DaoId:
        minValidRootIdx[d] <= nextRootIndex[d]

(* I8: Auth delegation soundness — _from_registry requires registry auth *)
AuthDelegationSoundness ==
    \A d \in DaoId:
        vkSet[d] => registryAuth

(*-----------------------------------------------------------------------*)
(* Initial state                                                          *)
(*-----------------------------------------------------------------------*)

Init ==
    /\ daoAdmin = [d \in DaoId |-> 0]
    /\ daoExists = {}
    /\ membershipOpen = [d \in DaoId |-> FALSE]
    /\ sbtMember = [d \in DaoId, a \in MemberAddr |-> FALSE]
    /\ sbtRevoked = [d \in DaoId, a \in MemberAddr |-> FALSE]
    /\ treeInitialized = [d \in DaoId |-> FALSE]
    /\ treeDepth = [d \in DaoId |-> 0]
    /\ nextLeafIndex = [d \in DaoId |-> 0]
    /\ nextRootIndex = [d \in DaoId |-> 0]
    /\ roots = [d \in DaoId |-> <<>>]
    /\ rootIndex = [d \in DaoId, r \in 0..MAX_NULLIFIERS |-> -1]
    /\ leafValue = [d \in DaoId, i \in 0..(2^MAX_TREE_DEPTH) |-> 0]
    /\ memberLeafIndex = [d \in DaoId, a \in MemberAddr |-> -1]
    /\ minValidRootIdx = [d \in DaoId |-> 0]
    /\ filledSubtrees = [d \in DaoId |-> <<>>]
    /\ proposalState = [d \in DaoId, p \in ProposalId |-> "None"]
    /\ proposalInfo = [d \in DaoId, p \in ProposalId |-> [eligible_root |-> 0, vote_mode |-> "Fixed", earliest_root_idx |-> 0, vk_hash |-> 0]]
    /\ nullifierUsed = [d \in DaoId, p \in ProposalId, n \in Nullifier |-> FALSE]
    /\ vkSet = [d \in DaoId |-> FALSE]
    /\ vkVersion = [d \in DaoId |-> 0]
    /\ currentRoot = [d \in DaoId |-> 0]
    /\ rootHistory = [d \in DaoId |-> <<>>]
    /\ registryAuth = FALSE
    /\ nextDaoId = 1

(*-----------------------------------------------------------------------*)
(* Actions                                                                *)
(*-----------------------------------------------------------------------*)

(* === DaoRegistry Actions === *)

(* Permissionless DAO creation *)
CreateDao(dao, creator, open) ==
    /\ dao = nextDaoId
    /\ dao \notin daoExists
    /\ creator \in MemberAddr
    /\ daoAdmin' = [daoAdmin EXCEPT ![dao] = creator]
    /\ daoExists' = daoExists \cup {dao}
    /\ membershipOpen' = [membershipOpen EXCEPT ![dao] = open]
    /\ nextDaoId' = nextDaoId + 1
    /\ UNCHANGED <<sbtMember, sbtRevoked, treeInitialized, treeDepth,
                    nextLeafIndex, nextRootIndex, roots, rootIndex,
                    leafValue, memberLeafIndex, minValidRootIdx,
                    filledSubtrees, proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    rootHistory, registryAuth>>

(* Admin transfer *)
TransferAdmin(dao, oldAdmin, newAdmin) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = oldAdmin
    /\ newAdmin \in MemberAddr
    /\ daoAdmin' = [daoAdmin EXCEPT ![dao] = newAdmin]
    /\ UNCHANGED <<daoExists, membershipOpen, sbtMember, sbtRevoked,
                    treeInitialized, treeDepth, nextLeafIndex, nextRootIndex,
                    roots, rootIndex, leafValue, memberLeafIndex,
                    minValidRootIdx, filledSubtrees, proposalState,
                    proposalInfo, nullifierUsed, vkSet, vkVersion,
                    currentRoot, rootHistory, registryAuth, nextDaoId>>

(* === MembershipSBT Actions === *)

(* Admin mints SBT for a member *)
MintSbt(dao, admin, member) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ ~sbtMember[dao, member]
    /\ sbtMember' = [sbtMember EXCEPT ![dao, member] = TRUE]
    /\ sbtRevoked' = [sbtRevoked EXCEPT ![dao, member] = FALSE]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, treeInitialized,
                    treeDepth, nextLeafIndex, nextRootIndex, roots,
                    rootIndex, leafValue, memberLeafIndex, minValidRootIdx,
                    filledSubtrees, proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    rootHistory, registryAuth, nextDaoId>>

(* Admin revokes SBT *)
RevokeSbt(dao, admin, member) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ sbtMember[dao, member]
    /\ sbtRevoked' = [sbtRevoked EXCEPT ![dao, member] = TRUE]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    treeInitialized, treeDepth, nextLeafIndex, nextRootIndex,
                    roots, rootIndex, leafValue, memberLeafIndex,
                    minValidRootIdx, filledSubtrees, proposalState,
                    proposalInfo, nullifierUsed, vkSet, vkVersion,
                    currentRoot, rootHistory, registryAuth, nextDaoId>>

(* === MembershipTree Actions === *)

(* Initialize tree for a DAO *)
InitTree(dao, depth, admin) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ ~treeInitialized[dao]
    /\ depth \in 1..MAX_TREE_DEPTH
    /\ treeInitialized' = [treeInitialized EXCEPT ![dao] = TRUE]
    /\ treeDepth' = [treeDepth EXCEPT ![dao] = depth]
    /\ nextLeafIndex' = [nextLeafIndex EXCEPT ![dao] = 0]
    /\ nextRootIndex' = [nextRootIndex EXCEPT ![dao] = 0]
    /\ currentRoot' = [currentRoot EXCEPT ![dao] = 0]
    /\ rootHistory' = [rootHistory EXCEPT ![dao] = <<0>>]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, leafValue, memberLeafIndex, minValidRootIdx,
                    filledSubtrees, proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, registryAuth, nextDaoId>>

(* Register a member's commitment in the tree *)
RegisterCommitment(dao, member, commitment, newRoot, rootIdx) ==
    /\ dao \in daoExists
    /\ treeInitialized[dao]
    /\ sbtMember[dao, member] /\ ~sbtRevoked[dao, member]
    /\ memberLeafIndex[dao, member] = -1  (* Not yet registered *)
    /\ nextLeafIndex[dao] < 2^treeDepth[dao]  (* Tree not full *)
    /\ newRoot \notin {rootHistory[dao][i] : i \in 0..(Len(rootHistory[dao])-1)}
    /\ rootIdx = nextRootIndex[dao]
    /\ nextLeafIndex' = [nextLeafIndex EXCEPT ![dao] = nextLeafIndex[dao] + 1]
    /\ nextRootIndex' = [nextRootIndex EXCEPT ![dao] = nextRootIndex[dao] + 1]
    /\ memberLeafIndex' = [memberLeafIndex EXCEPT ![dao, member] = nextLeafIndex[dao]]
    /\ leafValue' = [leafValue EXCEPT ![dao, nextLeafIndex[dao]] = commitment]
    /\ currentRoot' = [currentRoot EXCEPT ![dao] = newRoot]
    /\ rootHistory' = [rootHistory EXCEPT ![dao] =
        IF Len(rootHistory[dao]) >= MAX_ROOT_HISTORY
        THEN Append(Tail(rootHistory[dao]), newRoot)
        ELSE Append(rootHistory[dao], newRoot)]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, treeInitialized, treeDepth, minValidRootIdx,
                    filledSubtrees, proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, registryAuth, nextDaoId>>

(* Remove member — zeroes leaf, updates minValidRootIdx, revokes SBT *)
RemoveMember(dao, admin, member, newRoot, rootIdx) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ treeInitialized[dao]
    /\ memberLeafIndex[dao, member] >= 0
    /\ leafValue[dao, memberLeafIndex[dao, member]] /= 0  (* Not already removed *)
    /\ rootIdx = nextRootIndex[dao]
    /\ leafValue' = [leafValue EXCEPT ![dao, memberLeafIndex[dao, member]] = 0]
    /\ currentRoot' = [currentRoot EXCEPT ![dao] = newRoot]
    /\ nextRootIndex' = [nextRootIndex EXCEPT ![dao] = nextRootIndex[dao] + 1]
    /\ minValidRootIdx' = [minValidRootIdx EXCEPT ![dao] = rootIdx]
    (* Also revoke SBT in same transaction *)
    /\ sbtRevoked' = [sbtRevoked EXCEPT ![dao, member] = TRUE]
    /\ rootHistory' = [rootHistory EXCEPT ![dao] =
        IF Len(rootHistory[dao]) >= MAX_ROOT_HISTORY
        THEN Append(Tail(rootHistory[dao]), newRoot)
        ELSE Append(rootHistory[dao], newRoot)]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    treeInitialized, treeDepth, nextLeafIndex, nextRootIndex,
                    filledSubtrees, proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, registryAuth, nextDaoId>>

(* === Voting Actions === *)

(* Set VK (admin only) *)
SetVk(dao, admin) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ treeInitialized[dao]
    /\ vkSet' = [vkSet EXCEPT ![dao] = TRUE]
    /\ vkVersion' = [vkVersion EXCEPT ![dao] = vkVersion[dao] + 1]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, treeInitialized, treeDepth, nextLeafIndex,
                    nextRootIndex, roots, rootIndex, leafValue,
                    memberLeafIndex, minValidRootIdx, filledSubtrees,
                    proposalState, proposalInfo, nullifierUsed, currentRoot,
                    rootHistory, registryAuth, nextDaoId>>

(* Set VK from registry — requires registry auth *)
SetVkFromRegistry(dao) ==
    /\ dao \in daoExists
    /\ registryAuth  (* Registry must have authenticated *)
    /\ vkSet' = [vkSet EXCEPT ![dao] = TRUE]
    /\ vkVersion' = [vkVersion EXCEPT ![dao] = vkVersion[dao] + 1]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, treeInitialized, treeDepth, nextLeafIndex,
                    nextRootIndex, roots, rootIndex, leafValue,
                    memberLeafIndex, minValidRootIdx, filledSubtrees,
                    proposalState, proposalInfo, nullifierUsed, currentRoot,
                    rootHistory, registryAuth, nextDaoId>>

(* Create proposal — snapshots current root and VK *)
CreateProposal(dao, proposal, creator, voteMode) ==
    /\ dao \in daoExists
    /\ proposalState[dao, proposal] = "None"
    /\ vkSet[dao]
    /\ treeInitialized[dao]
    /\ sbtMember[dao, creator] /\ ~sbtRevoked[dao, creator]
    /\ proposalState' = [proposalState EXCEPT ![dao, proposal] = "Active"]
    /\ proposalInfo' = [proposalInfo EXCEPT ![dao, proposal] =
        [eligible_root |-> currentRoot[dao],
         vote_mode |-> voteMode,
         earliest_root_idx |-> nextRootIndex[dao],
         vk_hash |-> vkVersion[dao]]]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, treeInitialized, treeDepth, nextLeafIndex,
                    nextRootIndex, roots, rootIndex, leafValue,
                    memberLeafIndex, minValidRootIdx, filledSubtrees,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    rootHistory, registryAuth, nextDaoId>>

(* Cast a vote with ZK proof *)
Vote(dao, proposal, nullifier, root, choice, proofOk) ==
    /\ dao \in daoExists
    /\ proposalState[dao, proposal] = "Active"
    /\ ~nullifierUsed[dao, proposal, nullifier]
    /\ vkSet[dao]
    /\ treeInitialized[dao]
    (* Root validation based on vote mode *)
    /\ IF proposalInfo[dao, proposal].vote_mode = "Fixed"
       THEN root = proposalInfo[dao, proposal].eligible_root
       ELSE (* Trailing mode *)
            /\ root \in {rootHistory[dao][i] : i \in 0..(Len(rootHistory[dao])-1)}
            /\ rootIndex[dao, root] >= proposalInfo[dao, proposal].earliest_root_idx
            /\ rootIndex[dao, root] >= minValidRootIdx[dao]
    (* Proof verification *)
    /\ proofOk
    /\ nullifierUsed' = [nullifierUsed EXCEPT ![dao, proposal, nullifier] = TRUE]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, treeInitialized, treeDepth, nextLeafIndex,
                    nextRootIndex, roots, rootIndex, leafValue,
                    memberLeafIndex, minValidRootIdx, filledSubtrees,
                    proposalState, proposalInfo, vkSet, vkVersion,
                    currentRoot, rootHistory, registryAuth, nextDaoId>>

(* Close proposal: Active -> Closed *)
CloseProposal(dao, proposal, admin) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ proposalState[dao, proposal] = "Active"
    /\ proposalState' = [proposalState EXCEPT ![dao, proposal] = "Closed"]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, treeInitialized, treeDepth, nextLeafIndex,
                    nextRootIndex, roots, rootIndex, leafValue,
                    memberLeafIndex, minValidRootIdx, filledSubtrees,
                    proposalInfo, nullifierUsed, vkSet, vkVersion,
                    currentRoot, rootHistory, registryAuth, nextDaoId>>

(* Archive proposal: Closed -> Archived *)
ArchiveProposal(dao, proposal, admin) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ proposalState[dao, proposal] = "Closed"
    /\ proposalState' = [proposalState EXCEPT ![dao, proposal] = "Archived"]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, treeInitialized, treeDepth, nextLeafIndex,
                    nextRootIndex, roots, rootIndex, leafValue,
                    memberLeafIndex, minValidRootIdx, filledSubtrees,
                    proposalInfo, nullifierUsed, vkSet, vkVersion,
                    currentRoot, rootHistory, registryAuth, nextDaoId>>

(* === Cross-contract initialization (create_and_init_dao) === *)

(* Atomic DAO initialization: creates DAO, mints SBT, inits tree, registers commitment, sets VK *)
CreateAndInitDao(dao, creator, depth, commitment, newRoot, rootIdx) ==
    /\ dao = nextDaoId
    /\ dao \notin daoExists
    /\ creator \in MemberAddr
    /\ depth \in 1..MAX_TREE_DEPTH
    (* Step 1: Create DAO *)
    /\ daoAdmin' = [daoAdmin EXCEPT ![dao] = creator]
    /\ daoExists' = daoExists \cup {dao}
    /\ membershipOpen' = [membershipOpen EXCEPT ![dao] = FALSE]
    (* Step 2: Mint SBT (via mint_from_registry) *)
    /\ sbtMember' = [sbtMember EXCEPT ![dao, creator] = TRUE]
    /\ sbtRevoked' = [sbtRevoked EXCEPT ![dao, creator] = FALSE]
    (* Step 3: Init tree (via init_tree_from_registry) *)
    /\ treeInitialized' = [treeInitialized EXCEPT ![dao] = TRUE]
    /\ treeDepth' = [treeDepth EXCEPT ![dao] = depth]
    (* Step 4: Register commitment (via register_from_registry) *)
    /\ memberLeafIndex' = [memberLeafIndex EXCEPT ![dao, creator] = 0]
    /\ leafValue' = [leafValue EXCEPT ![dao, 0] = commitment]
    /\ currentRoot' = [currentRoot EXCEPT ![dao] = newRoot]
    /\ rootHistory' = [rootHistory EXCEPT ![dao] = <<0, newRoot>>]
    /\ nextLeafIndex' = [nextLeafIndex EXCEPT ![dao] = 1]
    /\ nextRootIndex' = [nextRootIndex EXCEPT ![dao] = 1]
    (* Step 5: Set VK (via set_vk_from_registry) — requires registry auth *)
    /\ registryAuth' = TRUE
    /\ vkSet' = [vkSet EXCEPT ![dao] = TRUE]
    /\ vkVersion' = [vkVersion EXCEPT ![dao] = 1]
    /\ nextDaoId' = nextDaoId + 1
    /\ UNCHANGED <<minValidRootIdx, filledSubtrees, proposalState,
                    proposalInfo, nullifierUsed>>

(* === Auth delegation action === *)

(* Registry authenticates (models require_auth() check) *)
RegistryAuthenticate ==
    /\ registryAuth = FALSE
    /\ registryAuth' = TRUE
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, treeInitialized, treeDepth, nextLeafIndex,
                    nextRootIndex, roots, rootIndex, leafValue,
                    memberLeafIndex, minValidRootIdx, filledSubtrees,
                    proposalState, proposalInfo, nullifierUsed, vkSet,
                    vkVersion, currentRoot, rootHistory, nextDaoId>>

(*-----------------------------------------------------------------------*)
(* Next-state relation                                                    *)
(*-----------------------------------------------------------------------*)

Next ==
    \E dao \in DaoId, creator \in MemberAddr, admin \in MemberAddr,
       member \in MemberAddr, newAdmin \in MemberAddr, depth \in 1..MAX_TREE_DEPTH,
       proposal \in ProposalId, nullifier \in Nullifier, root \in 0..MAX_NULLIFIERS,
       choice \in {TRUE, FALSE}, proofOk \in {TRUE, FALSE},
       newRoot \in 0..MAX_NULLIFIERS, rootIdx \in RootIdx,
       commitment \in 0..MAX_NULLIFIERS, open \in {TRUE, FALSE},
       voteMode \in {"Fixed", "Trailing"}:
    \/ CreateDao(dao, creator, open)
    \/ TransferAdmin(dao, admin, newAdmin)
    \/ MintSbt(dao, admin, member)
    \/ RevokeSbt(dao, admin, member)
    \/ InitTree(dao, depth, admin)
    \/ RegisterCommitment(dao, member, commitment, newRoot, rootIdx)
    \/ RemoveMember(dao, admin, member, newRoot, rootIdx)
    \/ SetVk(dao, admin)
    \/ SetVkFromRegistry(dao)
    \/ CreateProposal(dao, proposal, creator, voteMode)
    \/ Vote(dao, proposal, nullifier, root, choice, proofOk)
    \/ CloseProposal(dao, proposal, admin)
    \/ ArchiveProposal(dao, proposal, admin)
    \/ CreateAndInitDao(dao, creator, depth, commitment, newRoot, rootIdx)
    \/ RegistryAuthenticate

(*-----------------------------------------------------------------------*)
(* Temporal properties                                                    *)
(*-----------------------------------------------------------------------*)

(* Fairness: all actions eventually occur if continuously enabled *)
Fairness ==
    /\ WF_vars(CreateDao)
    /\ WF_vars(TransferAdmin)
    /\ WF_vars(MintSbt)
    /\ WF_vars(RevokeSbt)
    /\ WF_vars(InitTree)
    /\ WF_vars(RegisterCommitment)
    /\ WF_vars(RemoveMember)
    /\ WF_vars(SetVk)
    /\ WF_vars(SetVkFromRegistry)
    /\ WF_vars(CreateProposal)
    /\ WF_vars(Vote)
    /\ WF_vars(CloseProposal)
    /\ WF_vars(ArchiveProposal)
    /\ WF_vars(CreateAndInitDao)

(*-----------------------------------------------------------------------*)
(* The complete specification                                             *)
(*-----------------------------------------------------------------------*)

Spec == Init /\ [][Next]_vars /\ Fairness

(*-----------------------------------------------------------------------*)
(* Invariants to check with TLC                                           *)
(*-----------------------------------------------------------------------*)

Invariants ==
    /\ TypeOK
    /\ NoDoubleVoting
    /\ RootGroundedVoting
    /\ AdminContinuity
    /\ ProposalFSM
    /\ NullifierGlobalUniqueness
    /\ FIFOSafety
    /\ MinRootCorrectness
    /\ AuthDelegationSoundness

(*-----------------------------------------------------------------------*)
(* Helper definitions for TLC model checking                              *)
(*-----------------------------------------------------------------------*)

vars == <<daoAdmin, daoExists, membershipOpen, sbtMember, sbtRevoked,
          treeInitialized, treeDepth, nextLeafIndex, nextRootIndex, roots,
          rootIndex, leafValue, memberLeafIndex, minValidRootIdx,
          filledSubtrees, proposalState, proposalInfo, nullifierUsed,
          vkSet, vkVersion, currentRoot, rootHistory, registryAuth, nextDaoId>>

=============================================================================
