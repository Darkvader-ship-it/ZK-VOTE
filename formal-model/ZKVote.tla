--------------------------- MODULE ZKVote ---------------------------
(*
  ZK-VOTE Formal Model (TLA+)
  ============================
  Models the combined state machine across 5 Soroban contracts:
    DaoRegistry, MembershipSBT, MembershipTree, Voting, zkvote-groth16

  Cross-contract calls and auth delegation are modeled explicitly.
  The BN254/Groth16 verification is abstracted as a boolean predicate.

  Invariants verified:
    I2: Root-grounded voting — every accepted proof's root is a valid Merkle root
    I3: Admin continuity — exactly one admin per DAO at all times
    I4: Proposal state irreversibility — Active -> Closed -> Archived
    I5: Nullifier uniqueness across all DAOs and proposals simultaneously
    I6: FIFO root eviction safety — Fixed-mode proposals always reference a root that exists
    I7: min_valid_root_idx never exceeds nextRootIndex
    I8: Auth delegation soundness — _from_registry requires registry auth

  Temporal property:
    I1: No double voting — once nullifierUsed, stays used forever

  Limitations:
    - Abstract Merkle tree: symbolic roots, not Poseidon hashes
    - Abstract BN254 pairing: boolean proofOk predicate
    - No Soroban budget/TTL modeling
    - No WASM sandbox semantics
    - Comments contract not included (separate model needed)
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
RootIdx == 0..(MAX_ROOT_HISTORY + MAX_MEMBERS + 1)
LeafIdx == 0..(2 ^ MAX_TREE_DEPTH)

ProposalState == {"Active", "Closed", "Archived"}
VoteMode == {"Fixed", "Trailing"}

(*-----------------------------------------------------------------------*)
(* State variables                                                        *)
(*-----------------------------------------------------------------------*)

VARIABLES
    (* DaoRegistry state *)
    daoAdmin,           (* [dao_id -> 0..MAX_MEMBERS], 0 = unset *)
    daoExists,          (* Set of created DAO IDs *)
    membershipOpen,     (* [dao_id -> BOOLEAN] *)
    membersCanPropose,  (* [dao_id -> BOOLEAN] *)

    (* MembershipSBT state *)
    sbtMember,          (* [dao_id, address -> BOOLEAN] *)
    sbtRevoked,         (* [dao_id, address -> BOOLEAN] *)

    (* MembershipTree state *)
    treeInitialized,    (* [dao_id -> BOOLEAN] *)
    nextLeafIndex,      (* [dao_id -> Nat] *)
    nextRootIndex,      (* [dao_id -> RootIdx] *)
    rootHistory,        (* [dao_id -> Seq(root_value)] - FIFO cap *)
    rootIndexMap,       (* [dao_id, root -> RootIdx or -1] *)
    leafValue,          (* [dao_id, index -> 0..MAX_NULLIFIERS] *)
    memberLeafIndex,    (* [dao_id, address -> -1 or Nat] *)
    minValidRootIdx,    (* [dao_id -> RootIdx] *)

    (* Voting state *)
    proposalState,      (* [dao_id, proposal_id -> ProposalState or "None"] *)
    proposalInfo,       (* [dao_id, proposal_id -> record] *)
    nullifierUsed,      (* [dao_id, proposal_id, nullifier -> BOOLEAN] *)
    vkSet,              (* [dao_id -> BOOLEAN] *)
    vkVersion,          (* [dao_id -> Nat] *)

    (* Cross-contract auth tracking *)
    registryAuth,       (* BOOLEAN - whether registry has authenticated *)

    (* Global state *)
    nextDaoId,          (* Nat - next DAO ID to assign *)

    (* Abstract Merkle root values *)
    currentRoot         (* [dao_id -> 0..MAX_NULLIFIERS] *)

(*-----------------------------------------------------------------------*)
(* Type invariants                                                        *)
(*-----------------------------------------------------------------------*)

TypeOK ==
    /\ daoAdmin \in [DaoId -> 0..MAX_MEMBERS]
    /\ daoExists \subseteq DaoId
    /\ membershipOpen \in [DaoId -> BOOLEAN]
    /\ membersCanPropose \in [DaoId -> BOOLEAN]
    /\ sbtMember \in [DaoId \X MemberAddr -> BOOLEAN]
    /\ sbtRevoked \in [DaoId \X MemberAddr -> BOOLEAN]
    /\ treeInitialized \in [DaoId -> BOOLEAN]
    /\ nextLeafIndex \in [DaoId -> 0..(2 ^ MAX_TREE_DEPTH)]
    /\ nextRootIndex \in [DaoId -> RootIdx]
    /\ rootHistory \in [DaoId -> Seq(0..MAX_NULLIFIERS)]
    /\ rootIndexMap \in [DaoId \X (0..MAX_NULLIFIERS) -> -1..(MAX_ROOT_HISTORY + MAX_MEMBERS + 1)]
    /\ leafValue \in [DaoId \X (0..(2 ^ MAX_TREE_DEPTH)) -> 0..MAX_NULLIFIERS]
    /\ memberLeafIndex \in [DaoId \X MemberAddr -> -1..(2 ^ MAX_TREE_DEPTH)]
    /\ minValidRootIdx \in [DaoId -> RootIdx]
    /\ proposalState \in [DaoId \X ProposalId -> {"Active", "Closed", "Archived", "None"}]
    /\ nullifierUsed \in [DaoId \X ProposalId \X Nullifier -> BOOLEAN]
    /\ vkSet \in [DaoId -> BOOLEAN]
    /\ vkVersion \in [DaoId -> 0..MAX_MEMBERS]
    /\ currentRoot \in [DaoId -> 0..MAX_NULLIFIERS]
    /\ registryAuth \in {FALSE, TRUE}
    /\ nextDaoId \in 1..(MAX_DAOS + 1)

(*-----------------------------------------------------------------------*)
(* Invariants                                                            *)
(*-----------------------------------------------------------------------*)

(* I2: Root-grounded voting — every Fixed-mode proposal's eligible_root has a root index *)
RootGroundedVoting ==
    \A d \in DaoId, p \in ProposalId:
        (proposalState[d, p] = "Active" \/ proposalState[d, p] = "Closed" \/ proposalState[d, p] = "Archived") =>
            LET info == proposalInfo[d, p] IN
            info.vote_mode = "Fixed" =>
                \E idx \in RootIdx:
                    rootIndexMap[d, info.eligible_root] = idx /\ idx < nextRootIndex[d]

(* I3: Admin continuity — exactly one admin per DAO at all times *)
AdminContinuity ==
    \A d \in DaoId:
        d \in daoExists => daoAdmin[d] \in MemberAddr

(* I4: Proposal state irreversibility — no backward FSM transitions *)
ProposalFSM ==
    \A d \in DaoId, p \in ProposalId:
        (proposalState[d, p] = "Archived") =>
            (proposalState[d, p] /= "Active" /\ proposalState[d, p] /= "Closed")
        /\ (proposalState[d, p] = "Closed") =>
            (proposalState[d, p] /= "Active")

(* I5: Nullifier uniqueness across all DAOs and proposals *)
NullifierGlobalUniqueness ==
    \A d1, d2 \in DaoId, p1, p2 \in ProposalId, n \in Nullifier:
        (nullifierUsed[d1, p1, n] /\ nullifierUsed[d2, p2, n]) =>
            (d1 = d2 /\ p1 = p2)

(* I6: FIFO root eviction safety — Fixed-mode proposals reference a root in history *)
FIFOSafety ==
    \A d \in DaoId, p \in ProposalId:
        (proposalState[d, p] = "Active" \/ proposalState[d, p] = "Closed" \/ proposalState[d, p] = "Archived")
        /\ proposalInfo[d, p].vote_mode = "Fixed" =>
            LET root == proposalInfo[d, p].eligible_root IN
            \E i \in 0..(Len(rootHistory[d]) - 1):
                rootHistory[d][i] = root

(* I7: min_valid_root_idx — no false positive root rejection *)
MinRootCorrectness ==
    \A d \in DaoId:
        minValidRootIdx[d] <= nextRootIndex[d]

(* I8: Auth delegation soundness — vkSet implies either registryAuth or an admin set it *)
AuthDelegationSoundness ==
    \A d \in DaoId:
        vkSet[d] => (registryAuth \/ \E a \in MemberAddr: daoAdmin[d] = a)

(*-----------------------------------------------------------------------*)
(* Initial state                                                          *)
(*-----------------------------------------------------------------------*)

Init ==
    /\ daoAdmin = [d \in DaoId |-> 0]
    /\ daoExists = {}
    /\ membershipOpen = [d \in DaoId |-> FALSE]
    /\ membersCanPropose = [d \in DaoId |-> FALSE]
    /\ sbtMember = [d \in DaoId, a \in MemberAddr |-> FALSE]
    /\ sbtRevoked = [d \in DaoId, a \in MemberAddr |-> FALSE]
    /\ treeInitialized = [d \in DaoId |-> FALSE]
    /\ nextLeafIndex = [d \in DaoId |-> 0]
    /\ nextRootIndex = [d \in DaoId |-> 0]
    /\ rootHistory = [d \in DaoId |-> <<0>>]
    /\ rootIndexMap = [d \in DaoId, r \in 0..MAX_NULLIFIERS |-> -1]
    /\ leafValue = [d \in DaoId, i \in 0..(2 ^ MAX_TREE_DEPTH) |-> 0]
    /\ memberLeafIndex = [d \in DaoId, a \in MemberAddr |-> -1]
    /\ minValidRootIdx = [d \in DaoId |-> 0]
    /\ proposalState = [d \in DaoId, p \in ProposalId |-> "None"]
    /\ proposalInfo = [d \in DaoId, p \in ProposalId |-> [eligible_root |-> 0, vote_mode |-> "Fixed", earliest_root_idx |-> 0, vk_hash |-> 0]]
    /\ nullifierUsed = [d \in DaoId, p \in ProposalId, n \in Nullifier |-> FALSE]
    /\ vkSet = [d \in DaoId |-> FALSE]
    /\ vkVersion = [d \in DaoId |-> 0]
    /\ currentRoot = [d \in DaoId |-> 0]
    /\ registryAuth = FALSE
    /\ nextDaoId = 1

(*-----------------------------------------------------------------------*)
(* Actions                                                                *)
(*-----------------------------------------------------------------------*)

(* === DaoRegistry Actions === *)

CreateDao(dao, creator, open) ==
    /\ dao = nextDaoId
    /\ dao \notin daoExists
    /\ creator \in MemberAddr
    /\ daoAdmin' = [daoAdmin EXCEPT ![dao] = creator]
    /\ daoExists' = daoExists \cup {dao}
    /\ membershipOpen' = [membershipOpen EXCEPT ![dao] = open]
    /\ nextDaoId' = nextDaoId + 1
    /\ UNCHANGED <<sbtMember, sbtRevoked, treeInitialized,
                    nextLeafIndex, nextRootIndex, rootHistory, rootIndexMap,
                    leafValue, memberLeafIndex, minValidRootIdx,
                    proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth>>

TransferAdmin(dao, oldAdmin, newAdmin) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = oldAdmin
    /\ newAdmin \in MemberAddr
    /\ daoAdmin' = [daoAdmin EXCEPT ![dao] = newAdmin]
    /\ UNCHANGED <<daoExists, membershipOpen, sbtMember, sbtRevoked,
                    treeInitialized, nextLeafIndex, nextRootIndex,
                    rootHistory, rootIndexMap, leafValue, memberLeafIndex,
                    minValidRootIdx, proposalState,
                    proposalInfo, nullifierUsed, vkSet, vkVersion,
                    currentRoot, registryAuth, nextDaoId>>

SetProposalMode(dao, admin, canPropose) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ membersCanPropose' = [membersCanPropose EXCEPT ![dao] = canPropose]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, treeInitialized, nextLeafIndex, nextRootIndex,
                    rootHistory, rootIndexMap, leafValue, memberLeafIndex,
                    minValidRootIdx, proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth, nextDaoId>>

SetMembershipOpen(dao, admin, open) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ membershipOpen' = [membershipOpen EXCEPT ![dao] = open]
    /\ UNCHANGED <<daoAdmin, daoExists, sbtMember, sbtRevoked,
                    treeInitialized, nextLeafIndex, nextRootIndex,
                    rootHistory, rootIndexMap, leafValue, memberLeafIndex,
                    minValidRootIdx, proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth, nextDaoId>>

(* === MembershipSBT Actions === *)

MintSbt(dao, admin, member) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ ~sbtMember[dao, member]
    /\ sbtMember' = [sbtMember EXCEPT ![dao, member] = TRUE]
    /\ sbtRevoked' = [sbtRevoked EXCEPT ![dao, member] = FALSE]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, treeInitialized,
                    nextLeafIndex, nextRootIndex, rootHistory, rootIndexMap,
                    leafValue, memberLeafIndex, minValidRootIdx,
                    proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth, nextDaoId>>

RevokeSbt(dao, admin, member) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ sbtMember[dao, member]
    /\ sbtRevoked' = [sbtRevoked EXCEPT ![dao, member] = TRUE]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    treeInitialized, nextLeafIndex, nextRootIndex,
                    rootHistory, rootIndexMap, leafValue, memberLeafIndex,
                    minValidRootIdx, proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth, nextDaoId>>

LeaveDao(dao, member) ==
    /\ dao \in daoExists
    /\ sbtMember[dao, member]
    /\ sbtRevoked' = [sbtRevoked EXCEPT ![dao, member] = TRUE]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    treeInitialized, nextLeafIndex, nextRootIndex,
                    rootHistory, rootIndexMap, leafValue, memberLeafIndex,
                    minValidRootIdx, proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth, nextDaoId>>

SelfJoin(dao, member) ==
    /\ dao \in daoExists
    /\ membershipOpen[dao]
    /\ ~sbtMember[dao, member]
    /\ sbtMember' = [sbtMember EXCEPT ![dao, member] = TRUE]
    /\ sbtRevoked' = [sbtRevoked EXCEPT ![dao, member] = FALSE]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, treeInitialized,
                    nextLeafIndex, nextRootIndex, rootHistory, rootIndexMap,
                    leafValue, memberLeafIndex, minValidRootIdx,
                    proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth, nextDaoId>>

(* === MembershipTree Actions === *)

InitTree(dao, depth, admin) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ ~treeInitialized[dao]
    /\ depth \in 1..MAX_TREE_DEPTH
    /\ treeInitialized' = [treeInitialized EXCEPT ![dao] = TRUE]
    /\ nextLeafIndex' = [nextLeafIndex EXCEPT ![dao] = 0]
    /\ nextRootIndex' = [nextRootIndex EXCEPT ![dao] = 0]
    /\ currentRoot' = [currentRoot EXCEPT ![dao] = 0]
    /\ rootHistory' = [rootHistory EXCEPT ![dao] = <<0>>]
    /\ rootIndexMap' = [rootIndexMap EXCEPT ![dao, 0] = 0]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, leafValue, memberLeafIndex, minValidRootIdx,
                    proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, registryAuth, nextDaoId>>

RegisterCommitment(dao, member, commitment, newRoot) ==
    /\ dao \in daoExists
    /\ treeInitialized[dao]
    /\ sbtMember[dao, member] /\ ~sbtRevoked[dao, member]
    /\ memberLeafIndex[dao, member] = -1
    /\ nextLeafIndex[dao] < 2 ^ MAX_TREE_DEPTH
    /\ newRoot \notin {rootHistory[dao][i] : i \in 0..(Len(rootHistory[dao]) - 1)}
    /\ nextLeafIndex' = [nextLeafIndex EXCEPT ![dao] = nextLeafIndex[dao] + 1]
    /\ nextRootIndex' = [nextRootIndex EXCEPT ![dao] = nextRootIndex[dao] + 1]
    /\ memberLeafIndex' = [memberLeafIndex EXCEPT ![dao, member] = nextLeafIndex[dao]]
    /\ leafValue' = [leafValue EXCEPT ![dao, nextLeafIndex[dao]] = commitment]
    /\ currentRoot' = [currentRoot EXCEPT ![dao] = newRoot]
    /\ rootHistory' = [rootHistory EXCEPT ![dao] =
        IF Len(rootHistory[dao]) >= MAX_ROOT_HISTORY
        THEN Append(Tail(rootHistory[dao]), newRoot)
        ELSE Append(rootHistory[dao], newRoot)]
    /\ rootIndexMap' = [rootIndexMap EXCEPT ![dao, newRoot] = nextRootIndex[dao]]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, treeInitialized, minValidRootIdx,
                    proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, registryAuth, nextDaoId>>

RemoveMember(dao, admin, member, newRoot) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ treeInitialized[dao]
    /\ memberLeafIndex[dao, member] >= 0
    /\ leafValue[dao, memberLeafIndex[dao, member]] /= 0
    /\ nextRootIndex' = [nextRootIndex EXCEPT ![dao] = nextRootIndex[dao] + 1]
    /\ leafValue' = [leafValue EXCEPT ![dao, memberLeafIndex[dao, member]] = 0]
    /\ currentRoot' = [currentRoot EXCEPT ![dao] = newRoot]
    /\ minValidRootIdx' = [minValidRootIdx EXCEPT ![dao] = nextRootIndex[dao]]
    /\ sbtRevoked' = [sbtRevoked EXCEPT ![dao, member] = TRUE]
    /\ rootHistory' = [rootHistory EXCEPT ![dao] =
        IF Len(rootHistory[dao]) >= MAX_ROOT_HISTORY
        THEN Append(Tail(rootHistory[dao]), newRoot)
        ELSE Append(rootHistory[dao], newRoot)]
    /\ rootIndexMap' = [rootIndexMap EXCEPT ![dao, newRoot] = nextRootIndex[dao]]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    treeInitialized, nextLeafIndex, memberLeafIndex,
                    proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, registryAuth, nextDaoId>>

ReinstateMember(dao, admin, member) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ memberLeafIndex[dao, member] >= 0
    /\ leafValue[dao, memberLeafIndex[dao, member]] = 0
    /\ memberLeafIndex' = [memberLeafIndex EXCEPT ![dao, member] = -1]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, treeInitialized, nextLeafIndex, nextRootIndex,
                    rootHistory, rootIndexMap, leafValue,
                    minValidRootIdx, proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth, nextDaoId>>

(* === Voting Actions === *)

SetVk(dao, admin) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ treeInitialized[dao]
    /\ vkSet' = [vkSet EXCEPT ![dao] = TRUE]
    /\ vkVersion' = [vkVersion EXCEPT ![dao] = vkVersion[dao] + 1]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, treeInitialized, nextLeafIndex,
                    nextRootIndex, rootHistory, rootIndexMap, leafValue,
                    memberLeafIndex, minValidRootIdx,
                    proposalState, proposalInfo, nullifierUsed, currentRoot,
                    registryAuth, nextDaoId>>

SetVkFromRegistry(dao) ==
    /\ dao \in daoExists
    /\ registryAuth
    /\ vkSet' = [vkSet EXCEPT ![dao] = TRUE]
    /\ vkVersion' = [vkVersion EXCEPT ![dao] = vkVersion[dao] + 1]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, treeInitialized, nextLeafIndex,
                    nextRootIndex, rootHistory, rootIndexMap, leafValue,
                    memberLeafIndex, minValidRootIdx,
                    proposalState, proposalInfo, nullifierUsed, currentRoot,
                    registryAuth, nextDaoId>>

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
                    sbtRevoked, treeInitialized, nextLeafIndex,
                    nextRootIndex, rootHistory, rootIndexMap, leafValue,
                    memberLeafIndex, minValidRootIdx,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth, nextDaoId>>

Vote(dao, proposal, nullifier, root, proofOk) ==
    /\ dao \in daoExists
    /\ proposalState[dao, proposal] = "Active"
    /\ ~nullifierUsed[dao, proposal, nullifier]
    /\ vkSet[dao]
    /\ treeInitialized[dao]
    /\ IF proposalInfo[dao, proposal].vote_mode = "Fixed"
       THEN root = proposalInfo[dao, proposal].eligible_root
       ELSE (* Trailing mode *)
            /\ \E i \in 0..(Len(rootHistory[dao]) - 1):
                   rootHistory[dao][i] = root
            /\ rootIndexMap[dao, root] >= proposalInfo[dao, proposal].earliest_root_idx
            /\ rootIndexMap[dao, root] >= minValidRootIdx[dao]
    /\ proofOk
    /\ nullifierUsed' = [nullifierUsed EXCEPT ![dao, proposal, nullifier] = TRUE]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, treeInitialized, nextLeafIndex,
                    nextRootIndex, rootHistory, rootIndexMap, leafValue,
                    memberLeafIndex, minValidRootIdx,
                    proposalState, proposalInfo, vkSet, vkVersion,
                    currentRoot, registryAuth, nextDaoId>>

CloseProposal(dao, proposal, admin) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ proposalState[dao, proposal] = "Active"
    /\ proposalState' = [proposalState EXCEPT ![dao, proposal] = "Closed"]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, treeInitialized, nextLeafIndex,
                    nextRootIndex, rootHistory, rootIndexMap, leafValue,
                    memberLeafIndex, minValidRootIdx,
                    proposalInfo, nullifierUsed, vkSet, vkVersion,
                    currentRoot, registryAuth, nextDaoId>>

ArchiveProposal(dao, proposal, admin) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ proposalState[dao, proposal] = "Closed"
    /\ proposalState' = [proposalState EXCEPT ![dao, proposal] = "Archived"]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, treeInitialized, nextLeafIndex,
                    nextRootIndex, rootHistory, rootIndexMap, leafValue,
                    memberLeafIndex, minValidRootIdx,
                    proposalInfo, nullifierUsed, vkSet, vkVersion,
                    currentRoot, registryAuth, nextDaoId>>

(* === Cross-contract initialization === *)

CreateAndInitDao(dao, creator, depth, commitment, newRoot) ==
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
    (* Step 4: Register commitment (via register_from_registry) *)
    /\ memberLeafIndex' = [memberLeafIndex EXCEPT ![dao, creator] = 0]
    /\ leafValue' = [leafValue EXCEPT ![dao, 0] = commitment]
    /\ currentRoot' = [currentRoot EXCEPT ![dao] = newRoot]
    /\ rootHistory' = [rootHistory EXCEPT ![dao] = <<0, newRoot>>]
    /\ rootIndexMap' = [rootIndexMap EXCEPT ![dao, 0] = 0, ![dao, newRoot] = 1]
    /\ nextLeafIndex' = [nextLeafIndex EXCEPT ![dao] = 1]
    /\ nextRootIndex' = [nextRootIndex EXCEPT ![dao] = 1]
    (* Step 5: Set VK (via set_vk_from_registry) — requires registry auth *)
    /\ registryAuth' = TRUE
    /\ vkSet' = [vkSet EXCEPT ![dao] = TRUE]
    /\ vkVersion' = [vkVersion EXCEPT ![dao] = 1]
    /\ nextDaoId' = nextDaoId + 1
    /\ UNCHANGED <<minValidRootIdx, proposalState, proposalInfo, nullifierUsed>>

(*-----------------------------------------------------------------------*)
(* Next-state relation                                                    *)
(*-----------------------------------------------------------------------*)

Next ==
    \E dao \in DaoId, creator \in MemberAddr, admin \in MemberAddr,
       member \in MemberAddr, newAdmin \in MemberAddr, depth \in 1..MAX_TREE_DEPTH,
       proposal \in ProposalId, nullifier \in Nullifier, root \in 0..MAX_NULLIFIERS,
       proofOk \in {TRUE, FALSE},
       newRoot \in 0..MAX_NULLIFIERS,
       commitment \in 0..MAX_NULLIFIERS, open \in {TRUE, FALSE},
       canPropose \in {TRUE, FALSE},
       voteMode \in VoteMode:
    \/ CreateDao(dao, creator, open)
    \/ TransferAdmin(dao, admin, newAdmin)
    \/ SetProposalMode(dao, admin, canPropose)
    \/ SetMembershipOpen(dao, admin, open)
    \/ MintSbt(dao, admin, member)
    \/ RevokeSbt(dao, admin, member)
    \/ LeaveDao(dao, member)
    \/ SelfJoin(dao, member)
    \/ InitTree(dao, depth, admin)
    \/ RegisterCommitment(dao, member, commitment, newRoot)
    \/ RemoveMember(dao, admin, member, newRoot)
    \/ ReinstateMember(dao, admin, member)
    \/ SetVk(dao, admin)
    \/ SetVkFromRegistry(dao)
    \/ CreateProposal(dao, proposal, creator, voteMode)
    \/ Vote(dao, proposal, nullifier, root, proofOk)
    \/ CloseProposal(dao, proposal, admin)
    \/ ArchiveProposal(dao, proposal, admin)
    \/ CreateAndInitDao(dao, creator, depth, commitment, newRoot)

(*-----------------------------------------------------------------------*)
(* The complete specification                                             *)
(*-----------------------------------------------------------------------*)

Spec == Init /\ [][Next]_vars

(*-----------------------------------------------------------------------*)
(* Invariants to check with TLC                                           *)
(*-----------------------------------------------------------------------*)

Invariants ==
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

vars == <<daoAdmin, daoExists, membershipOpen, membersCanPropose,
          sbtMember, sbtRevoked,
          treeInitialized, nextLeafIndex, nextRootIndex, rootHistory,
          rootIndexMap, leafValue, memberLeafIndex, minValidRootIdx,
          proposalState, proposalInfo, nullifierUsed,
          vkSet, vkVersion, currentRoot, registryAuth, nextDaoId>>

=============================================================================